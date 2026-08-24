const http = require("node:http");
const crypto = require("node:crypto");
const { timestampKey } = require("./slack-api-session-slack.cjs");
const {
  SLOW_RESPONSE_THRESHOLD_MS,
  textFingerprint,
} = require("./slack-api-session-store.cjs");

const MAX_INBOUND_TEXT = 40_000;
const MAX_RESPONSE_BYTES = 128 * 1024;
const DEFAULT_RESPONSE_PREFIX = ":robot_face: ";
const DEFAULT_POLL_TIMEOUT_MS = 30_000;
const EVENT_SENTINEL = "# [SLACK_AGENT_SESSION_EVENT v1]";
const BRIDGE_HEALTH_PROTOCOL = "slack-agent-session-bridge-health-v1";
const POLL_CANCELLED_CODE = "SLACK_POLL_CANCELLED";
const POLL_TIMEOUT_CODE = "SLACK_POLL_TIMEOUT";
const SLACK_OPERATION_CANCELLED_CODE = "SLACK_OPERATION_CANCELLED";
const SLACK_OPERATION_TIMEOUT_CODE = "SLACK_OPERATION_TIMEOUT";
const NON_USER_MESSAGE_SUBTYPES = new Set([
  "bot_message",
  "channel_archive",
  "channel_join",
  "channel_leave",
  "channel_name",
  "channel_purpose",
  "channel_topic",
  "channel_unarchive",
  "ekm_access_denied",
  "message_changed",
  "message_deleted",
  "pinned_item",
  "slackbot_response",
  "tombstone",
  "unpinned_item",
]);

function sanitizeInboundText(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n");
}

function inboundTextLength(value) {
  return [...String(value || "")].length;
}

function sessionEventId(session, message) {
  const fingerprint = crypto.createHash("sha256")
    .update(`${session.id}\0${message.ts || ""}\0${message.user || ""}`, "utf8")
    .digest("base64url")
    .slice(0, 16);
  return `evt_${fingerprint}`;
}

function responseId() {
  return `resp_${crypto.randomBytes(9).toString("base64url")}`;
}

function inboundSkipReason(message) {
  if (
    (message?.type && message.type !== "message")
    || message?.hidden === true
    || NON_USER_MESSAGE_SUBTYPES.has(message?.subtype)
    || message?.bot_id
    || message?.bot_profile
    || message?.user === "USLACKBOT"
  ) {
    return "non_user_authored";
  }
  if (!String(message?.user || "").trim()) return "missing_user";
  const text = sanitizeInboundText(message?.text);
  if (!text.trim()) return "empty_message";
  if (inboundTextLength(text) > MAX_INBOUND_TEXT) return "message_too_large";
  return null;
}

function prefixResponse(text, prefix = DEFAULT_RESPONSE_PREFIX) {
  const message = String(text || "").trim();
  const normalizedPrefix = String(prefix || "");
  if (!normalizedPrefix || message.startsWith(normalizedPrefix.trim())) return message;
  return `${normalizedPrefix}${message}`;
}

function shellInertJson(value) {
  return JSON.stringify(value)
    .replaceAll("\u0085", "\\u0085")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029")
    .replaceAll("$", "\\u0024")
    .replaceAll("`", "\\u0060")
    .replaceAll("!", "\\u0021");
}

function formatAgentPrompt(session, message, eventId = sessionEventId(session, message)) {
  const text = sanitizeInboundText(message.text);
  const sendFlag = session.sendResponses ? " --send" : "";
  const envelope = {
    eventId,
    sessionId: session.id,
    messageTs: message.ts,
    thread: session.slack.permalink,
    from: {
      id: message.user || null,
      name: message.username || message.user || "unknown",
    },
    text,
    response: {
      sessionId: session.id,
      eventId,
      sendEnabled: Boolean(session.sendResponses),
      progressCommand: `slack-api session respond --id ${session.id} --event ${eventId} --status progress${sendFlag}`,
      completeCommand: `slack-api session respond --id ${session.id} --event ${eventId} --status complete --message-file /absolute/path/to/response.txt${sendFlag}`,
      format: "Slack mrkdwn; concise summary; no raw terminal output",
    },
  };
  return `${EVENT_SENTINEL} ${shellInertJson(envelope)}`;
}

function normalizeSlackText(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function parseControl(text) {
  const match = String(text || "").trim().match(/^!session(?:\s+(\S+))?(?:\s+(\S+))?\s*$/i);
  if (!match) return null;
  return { action: (match[1] || "status").toLowerCase(), argument: match[2] || null };
}

function retainInboundEvents(events, completedLimit = 100) {
  const all = [...events];
  const incompleteIds = new Set(
    all.filter((event) => !event.completedAt).map((event) => event.id),
  );
  const completedBudget = Math.max(0, completedLimit - incompleteIds.size);
  const completedIds = completedBudget > 0
    ? all
      .filter((event) => event.completedAt)
      .slice(-completedBudget)
      .map((event) => event.id)
    : [];
  const keepIds = new Set([...incompleteIds, ...completedIds]);
  return all.filter((event) => keepIds.has(event.id));
}

function outboundDeliveryIsSafelyObserved(delivery) {
  return (
    delivery?.deliveryState === "observed"
    && Boolean(String(delivery.messageTs || "").trim())
    && Boolean(String(delivery.observedAt || "").trim())
  );
}

function retainOutboundDeliveries(deliveries, observedLimit = 200) {
  const all = [...(deliveries || [])];
  let remainingObserved = Math.max(0, Number.isFinite(observedLimit)
    ? Math.floor(observedLimit)
    : 200);
  const retained = [];
  for (let index = all.length - 1; index >= 0; index -= 1) {
    const delivery = all[index];
    if (!outboundDeliveryIsSafelyObserved(delivery)) {
      retained.push(delivery);
      continue;
    }
    if (remainingObserved > 0) {
      retained.push(delivery);
      remainingObserved -= 1;
    }
  }
  return retained.reverse();
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function pollError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function pollWithCancellation(slack, session, {
  signal = null,
  timeoutMs = DEFAULT_POLL_TIMEOUT_MS,
} = {}) {
  const controller = new AbortController();
  let timeout = null;
  let rejectCancellation;
  const cancelled = new Promise((resolve, reject) => {
    rejectCancellation = reject;
  });
  const abort = (error) => {
    if (controller.signal.aborted) return;
    controller.abort(error);
    rejectCancellation(error);
  };
  const onLifecycleAbort = () => abort(pollError(
    `Slack poll for session ${session.id} was cancelled`,
    POLL_CANCELLED_CODE,
  ));

  if (signal?.aborted) {
    onLifecycleAbort();
  } else if (signal) {
    signal.addEventListener("abort", onLifecycleAbort, { once: true });
  }

  const boundedTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_POLL_TIMEOUT_MS;
  timeout = setTimeout(() => abort(pollError(
    `Slack poll for session ${session.id} timed out after ${boundedTimeoutMs}ms`,
    POLL_TIMEOUT_CODE,
  )), boundedTimeoutMs);

  try {
    const polling = Promise.resolve().then(() => slack.poll(session, {
      signal: controller.signal,
    }));
    const snapshot = await Promise.race([polling, cancelled]);
    if (controller.signal.aborted) throw controller.signal.reason;
    return snapshot;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onLifecycleAbort);
  }
}

async function slackOperationWithCancellation(operation, {
  signal = null,
  timeoutMs = DEFAULT_POLL_TIMEOUT_MS,
  description = "Slack operation",
} = {}) {
  const controller = new AbortController();
  let timeout = null;
  let rejectCancellation;
  const cancelled = new Promise((resolve, reject) => {
    rejectCancellation = reject;
  });
  const abort = (error) => {
    if (controller.signal.aborted) return;
    controller.abort(error);
    rejectCancellation(error);
  };
  const onLifecycleAbort = () => abort(pollError(
    `${description} was cancelled`,
    SLACK_OPERATION_CANCELLED_CODE,
  ));

  if (signal?.aborted) {
    onLifecycleAbort();
  } else if (signal) {
    signal.addEventListener("abort", onLifecycleAbort, { once: true });
  }

  const boundedTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_POLL_TIMEOUT_MS;
  timeout = setTimeout(() => abort(pollError(
    `${description} timed out after ${boundedTimeoutMs}ms`,
    SLACK_OPERATION_TIMEOUT_CODE,
  )), boundedTimeoutMs);

  try {
    const pending = Promise.resolve().then(() => operation(controller.signal));
    const result = await Promise.race([pending, cancelled]);
    if (controller.signal.aborted) throw controller.signal.reason;
    return result;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onLifecycleAbort);
  }
}

function safeTokenEqual(actual, expected) {
  const left = Buffer.from(String(actual || ""));
  const right = Buffer.from(String(expected || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function bridgeHealthProof(session, nonce) {
  return crypto.createHmac("sha256", String(session.bridgeToken || ""))
    .update([
      BRIDGE_HEALTH_PROTOCOL,
      session.id,
      session.runtimeInstanceId,
      nonce,
    ].join("\0"), "utf8")
    .digest("base64url");
}

function bridgeBaseUrl(session) {
  if (
    !session.bridge?.url
    || !session.bridgeToken
    || !session.runtimeInstanceId
    || !session.pid
  ) {
    throw new Error("Bridge identity is incomplete; exact runtime authentication is unavailable");
  }
  let base;
  try {
    base = new URL(session.bridge.url);
  } catch {
    throw new Error("Bridge URL is invalid");
  }
  const expectedPort = Number(session.bridge.port);
  if (
    base.protocol !== "http:"
    || base.hostname !== "127.0.0.1"
    || session.bridge.host !== "127.0.0.1"
    || base.username
    || base.password
    || base.pathname !== "/"
    || base.search
    || base.hash
    || !Number.isInteger(expectedPort)
    || expectedPort < 1
    || Number(base.port) !== expectedPort
  ) {
    throw new Error("Bridge must be the exact stored 127.0.0.1 listener");
  }
  return base.origin;
}

function assertSafelyInjected(event, eventId) {
  if (!event) {
    throw new Error(
      `Inbound event not found: ${eventId}; response refused because it was not `
      + "safely confirmed as injected",
    );
  }
  const injectionState = event.injectionState
    || (event.injectedAt ? "injected" : event.state);
  if (injectionState !== "injected") {
    throw new Error(
      `Inbound event ${eventId} was not safely injected `
      + `(injection state ${injectionState || "unknown"}); response refused`,
    );
  }
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_RESPONSE_BYTES) {
        reject(new Error("request_too_large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    request.on("error", reject);
  });
}

class SessionRuntime {
  constructor({
    store,
    slack,
    provider,
    sessionId,
    logger = console,
    now = () => Date.now(),
    pollTimeoutMs = null,
    runtimeInstanceId = null,
  }) {
    this.store = store;
    this.slack = slack;
    this.provider = provider;
    this.sessionId = sessionId;
    this.logger = logger;
    this.now = now;
    this.pollTimeoutMs = pollTimeoutMs;
    this.runtimeInstanceId = runtimeInstanceId;
    this.server = null;
    this.lifecycleSignal = null;
  }

  isoNow() {
    return new Date(this.now()).toISOString();
  }

  elapsedSince(isoTimestamp) {
    const started = Date.parse(String(isoTimestamp || ""));
    return Number.isFinite(started) ? Math.max(0, this.now() - started) : null;
  }

  current({ secret = false } = {}) {
    return this.store.get(this.sessionId, { includeSecret: secret });
  }

  validateRuntimeInstance() {
    if (!this.runtimeInstanceId) return;
    const current = this.current({ secret: true });
    if (current.runtimeInstanceId !== this.runtimeInstanceId) {
      const error = new Error(`Runtime instance for session ${this.sessionId} was superseded`);
      error.code = "RUNTIME_INSTANCE_SUPERSEDED";
      throw error;
    }
  }

  slackRequestTimeoutMs(session) {
    const configured = Number(this.pollTimeoutMs || session.slackConfig?.timeoutMs);
    return Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_POLL_TIMEOUT_MS;
  }

  async runSlackOperation(session, description, operation, { signal = null } = {}) {
    return slackOperationWithCancellation(operation, {
      signal: signal || this.lifecycleSignal,
      timeoutMs: this.slackRequestTimeoutMs(session),
      description,
    });
  }

  updateInboundEvent(eventId, updater) {
    return this.store.update(this.sessionId, (session) => {
      const index = (session.inboundEvents || []).findIndex((event) => event.id === eventId);
      if (index < 0) return session;
      const current = structuredClone(session.inboundEvents[index]);
      session.inboundEvents[index] = updater(current, session) || current;
      return session;
    });
  }

  advanceCursor(message, extra = {}) {
    this.store.update(this.sessionId, (session) => {
      if (timestampKey(message.ts) > timestampKey(session.cursorTs)) {
        session.cursorTs = message.ts;
        session.listenerCursorAt = this.isoNow();
      }
      Object.assign(session, extra);
      return session;
    });
  }

  async acknowledgeAcceptedMessage(session, message, eventId) {
    if (typeof this.slack.react !== "function") return;
    try {
      const result = await this.runSlackOperation(
        session,
        `Slack acknowledgement reaction for session ${session.id}`,
        (signal) => this.slack.react(session, message.ts, "eyes", {
          add: true,
          send: session.sendResponses,
          signal,
        }),
      );
      const acknowledgedAt = this.isoNow();
      const injectedToAcknowledgedMs = this.updateInboundEvent(eventId, (event, latest) => {
        event.acknowledgedAt = result.mode === "dry-run" ? null : acknowledgedAt;
        event.injectedToAcknowledgedMs = result.mode === "dry-run"
          ? null
          : this.elapsedSince(event.injectedAt);
        if (event.acknowledgedAt) event.state = "acknowledged";
        if (event.acknowledgedAt && !latest.timings.firstAcknowledgementAt) {
          latest.timings.firstAcknowledgementAt = event.acknowledgedAt;
          latest.timings.injectedToAcknowledgedMs = event.injectedToAcknowledgedMs;
        }
        return event;
      }).inboundEvents?.find((event) => event.id === eventId)?.injectedToAcknowledgedMs;
      this.store.auditMessage(session.id, "acknowledgement_reaction_prepared", message, {
        eventId,
        correlationId: eventId,
        emoji: "eyes",
        mode: result.mode,
        injectedToAcknowledgedMs: injectedToAcknowledgedMs ?? null,
      });
    } catch (error) {
      this.store.auditMessage(session.id, "acknowledgement_reaction_failed", message, {
        eventId,
        correlationId: eventId,
        emoji: "eyes",
        error: String(error.message || error).slice(0, 1000),
      });
      this.logger.error?.(`Slack session ${session.id} acknowledgement failed: ${error.message || error}`);
    }
  }

  acknowledgementEvents(session, eventId = "") {
    const selected = eventId
      ? (session.inboundEvents || []).find((event) => event.id === eventId)
      : null;
    if (eventId) assertSafelyInjected(selected, eventId);
    const events = (session.inboundEvents || []).filter((event) => (
      !event.completedAt
      && (!eventId || event.id === eventId)
      && (session.awaitingAcknowledgementTs || []).includes(event.messageTs)
    ));
    if (eventId && events.length === 0) {
      throw new Error(`Inbound event not found or already completed: ${eventId}`);
    }
    if (!eventId && events.length > 1) {
      throw new Error("Multiple inbound events are awaiting completion; pass --event to correlate the response");
    }
    return events;
  }

  async markAcknowledgementsInProgress(
    session,
    events,
    { send = session.sendResponses, reason = "explicit", signal = null } = {},
  ) {
    if (!events.length) return [];
    const progressed = [];
    for (const event of events) {
      if (event.progressAt) continue;
      try {
        if (typeof this.slack.react === "function") {
          await this.runSlackOperation(
            session,
            `Slack progress reaction for session ${session.id}`,
            (operationSignal) => this.slack.react(
              session,
              event.messageTs,
              "eyes",
              { add: false, send, signal: operationSignal },
            ),
            { signal },
          );
          await this.runSlackOperation(
            session,
            `Slack progress reaction for session ${session.id}`,
            (operationSignal) => this.slack.react(
              session,
              event.messageTs,
              "hourglass_flowing_sand",
              { add: true, send, signal: operationSignal },
            ),
            { signal },
          );
        }
        const progressAt = this.isoNow();
        this.updateInboundEvent(event.id, (current) => {
          if (send) {
            current.progressAt = progressAt;
            current.state = "in_progress";
          }
          return current;
        });
        this.store.audit(session.id, "acknowledgement_in_progress", {
          eventId: event.id,
          correlationId: event.id,
          messageTs: event.messageTs,
          emoji: "hourglass_flowing_sand",
          mode: send ? "sent" : "dry-run",
          reason,
        });
        progressed.push(event.id);
      } catch (error) {
        this.store.audit(session.id, "acknowledgement_progress_failed", {
          eventId: event.id,
          correlationId: event.id,
          messageTs: event.messageTs,
          error: String(error.message || error).slice(0, 1000),
        });
        this.logger.error?.(`Slack session ${session.id} progress reaction failed: ${error.message || error}`);
      }
    }
    return progressed;
  }

  async completeAcknowledgements(
    session,
    events,
    { send = true, status = "complete", signal = null } = {},
  ) {
    if (!events.length) return;
    if (typeof this.slack.react !== "function") {
      this.store.update(session.id, (latest) => {
        latest.awaitingAcknowledgementTs = (latest.awaitingAcknowledgementTs || [])
          .filter((timestamp) => !events.some((event) => event.messageTs === timestamp));
        if (send) {
          const completedAt = this.isoNow();
          for (const event of events) {
            const inbound = (latest.inboundEvents || [])
              .find((candidate) => candidate.id === event.id);
            if (inbound) {
              inbound.completedAt = completedAt;
              inbound.state = status;
            }
          }
        }
        return latest;
      });
      return;
    }
    for (const event of events) {
      const completedAt = this.isoNow();
      const emoji = status === "error" ? "x" : "white_check_mark";
      try {
        await this.runSlackOperation(
          session,
          `Slack completion reaction for session ${session.id}`,
          (operationSignal) => this.slack.react(
            session,
            event.messageTs,
            "eyes",
            { add: false, send, signal: operationSignal },
          ),
          { signal },
        );
        if (event.progressAt) {
          await this.runSlackOperation(
            session,
            `Slack completion reaction for session ${session.id}`,
            (operationSignal) => this.slack.react(
              session,
              event.messageTs,
              "hourglass_flowing_sand",
              { add: false, send, signal: operationSignal },
            ),
            { signal },
          );
        }
        const completed = await this.runSlackOperation(
          session,
          `Slack completion reaction for session ${session.id}`,
          (operationSignal) => this.slack.react(
            session,
            event.messageTs,
            emoji,
            { add: true, send, signal: operationSignal },
          ),
          { signal },
        );
        this.store.audit(session.id, "acknowledgement_completed", {
          eventId: event.id,
          correlationId: event.id,
          messageTs: event.messageTs,
          emoji,
          mode: completed.mode,
          status,
        });
      } catch (error) {
        this.store.audit(session.id, "acknowledgement_completion_failed", {
          eventId: event.id,
          correlationId: event.id,
          messageTs: event.messageTs,
          error: String(error.message || error).slice(0, 1000),
        });
        this.logger.error?.(`Slack session ${session.id} acknowledgement completion failed: ${error.message || error}`);
      } finally {
        if (send) {
          this.store.update(session.id, (latest) => {
            latest.awaitingAcknowledgementTs = (latest.awaitingAcknowledgementTs || [])
              .filter((timestamp) => timestamp !== event.messageTs);
            const inbound = (latest.inboundEvents || [])
              .find((candidate) => candidate.id === event.id);
            if (inbound) {
              inbound.completedAt = completedAt;
              inbound.state = status;
            }
            return latest;
          });
        }
      }
    }
  }

  claimInboundInjection(session, message, eventId, { approvedEventId = null } = {}) {
    const claimedAt = this.isoNow();
    const injectionAttemptId = crypto.randomUUID();
    this.store.update(session.id, (latest) => {
      const existing = (latest.inboundEvents || [])
        .find((event) => event.id === eventId);
      if (existing) {
        const error = new Error(
          `Inbound event ${eventId} already has injection state `
          + `${existing.injectionState || existing.state || "unknown"}; automatic retry refused`,
        );
        error.code = "INJECTION_ALREADY_CLAIMED";
        throw error;
      }
      if (timestampKey(message.ts) > timestampKey(latest.cursorTs)) {
        latest.cursorTs = message.ts;
        latest.listenerCursorAt = claimedAt;
      }
      latest.inboundEvents = retainInboundEvents([
        ...(latest.inboundEvents || []),
        {
          id: eventId,
          correlationId: eventId,
          messageTs: message.ts,
          userId: message.user || null,
          username: message.username || null,
          receivedAt: claimedAt,
          injectionClaimedAt: claimedAt,
          injectionAttemptId,
          injectionState: "claimed",
          injectedAt: null,
          acknowledgedAt: null,
          injectedToAcknowledgedMs: null,
          progressAt: null,
          firstResponseAt: null,
          injectedToFirstResponseMs: null,
          completedAt: null,
          slowWarningAt: null,
          textLength: String(message.text || "").length,
          textSha256: textFingerprint(message.text),
          state: "injection_claimed",
        },
      ]);
      latest.lastReceived = {
        direction: "inbound",
        eventId,
        messageTs: message.ts,
        userId: message.user || null,
        username: message.username || null,
        receivedAt: claimedAt,
        disposition: "injection_claimed",
        skipReason: null,
        injectionState: "claimed",
        textLength: String(message.text || "").length,
        textSha256: textFingerprint(message.text),
      };
      if (approvedEventId) {
        latest.pending = latest.pending.filter((item) => item.id !== approvedEventId);
      }
      return latest;
    });
    this.store.auditMessage(session.id, "message_injection_claimed", message, {
      eventId,
      correlationId: eventId,
      injectionAttemptId,
      provider: session.provider.name,
      target: session.provider.target,
      approvedEventId,
    });
    return { injectionAttemptId, claimedAt };
  }

  reconcileClaimedInjections() {
    const uncertainAt = this.isoNow();
    const reconciled = [];
    this.store.update(this.sessionId, (session) => {
      for (const inbound of session.inboundEvents || []) {
        if (inbound.injectionState !== "claimed") continue;
        inbound.injectionState = "uncertain";
        inbound.injectionUncertainAt ||= uncertainAt;
        inbound.state = "injection_uncertain";
        reconciled.push({
          eventId: inbound.id,
          messageTs: inbound.messageTs,
          injectionAttemptId: inbound.injectionAttemptId || null,
          injectionClaimedAt: inbound.injectionClaimedAt || null,
        });
        if (session.lastReceived?.eventId === inbound.id) {
          session.lastReceived.injectionState = "uncertain";
        }
      }
      return session;
    });
    for (const inbound of reconciled) {
      this.store.audit(this.sessionId, "message_injection_uncertain", {
        eventId: inbound.eventId,
        correlationId: inbound.eventId,
        messageTs: inbound.messageTs,
        injectionAttemptId: inbound.injectionAttemptId,
        injectionClaimedAt: inbound.injectionClaimedAt,
        injectionUncertainAt: uncertainAt,
        reason: "runtime_started_with_unresolved_injection_claim",
      });
    }
    return reconciled;
  }

  quarantineInboundInjection(session, message, eventId, injectionAttemptId, error) {
    const uncertainAt = this.isoNow();
    let outcomeKnownInjected = false;
    try {
      this.store.update(session.id, (latest) => {
        const inbound = (latest.inboundEvents || []).find((event) => (
          event.id === eventId
          && event.injectionAttemptId === injectionAttemptId
        ));
        outcomeKnownInjected = inbound?.injectionState === "injected";
        if (inbound && !outcomeKnownInjected) {
          inbound.injectionState = "uncertain";
          inbound.injectionUncertainAt = uncertainAt;
          inbound.state = "injection_uncertain";
          if (latest.lastReceived?.eventId === eventId) {
            latest.lastReceived.injectionState = "uncertain";
          }
        }
        return latest;
      });
    } catch {}
    if (outcomeKnownInjected) return;
    try {
      const errorCode = String(error?.code || "");
      const errorName = String(error?.name || "");
      this.store.auditMessage(session.id, "message_injection_uncertain", message, {
        eventId,
        correlationId: eventId,
        injectionAttemptId,
        reason: "provider_or_persistence_outcome_uncertain",
        errorCode: /^[A-Z0-9_.:-]{1,80}$/.test(errorCode) ? errorCode : null,
        errorName: /^[a-zA-Z][a-zA-Z0-9]{0,79}$/.test(errorName) ? errorName : null,
      });
    } catch {}
  }

  async inject(session, message, { approvedEventId = null } = {}) {
    const eventId = approvedEventId || sessionEventId(session, message);
    const prompt = formatAgentPrompt(session, message, eventId);
    if (/[\r\n]/.test(prompt)) {
      throw new Error("Slack agent event envelope must be exactly one physical line");
    }
    const claim = this.claimInboundInjection(
      session,
      message,
      eventId,
      { approvedEventId },
    );
    let result;
    try {
      result = await Promise.resolve(this.provider.inject(prompt));
      const injectionConfirmedAt = this.isoNow();
      const injectedAt = claim.claimedAt;
      this.store.update(session.id, (latest) => {
        const inbound = (latest.inboundEvents || []).find((event) => (
          event.id === eventId
          && event.injectionAttemptId === claim.injectionAttemptId
        ));
        if (!inbound || inbound.injectionState !== "claimed") {
          throw new Error(
            `Inbound event ${eventId} lost its active injection claim; outcome is uncertain`,
          );
        }
        inbound.injectionState = "injected";
        inbound.injectedAt = injectedAt;
        inbound.injectionConfirmedAt = injectionConfirmedAt;
        inbound.state = "injected";
        latest.lastInjectedAt = injectedAt;
        latest.lastInjectedTs = message.ts;
        latest.recentInjectedTs = [...(latest.recentInjectedTs || []), message.ts].slice(-20);
        latest.awaitingAcknowledgementTs = [
          ...new Set([...(latest.awaitingAcknowledgementTs || []), message.ts]),
        ];
        latest.injectedCount = (latest.injectedCount || 0) + 1;
        if (latest.lastReceived?.eventId === eventId) {
          latest.lastReceived.injectionState = "injected";
        }
        return latest;
      });
    } catch (error) {
      this.quarantineInboundInjection(
        session,
        message,
        eventId,
        claim.injectionAttemptId,
        error,
      );
      const uncertain = new Error(
        `Injection outcome for inbound event ${eventId} is uncertain; `
        + "automatic retry refused",
      );
      uncertain.code = "INJECTION_OUTCOME_UNCERTAIN";
      throw uncertain;
    }
    this.store.auditMessage(session.id, "message_injected", message, {
      eventId,
      correlationId: eventId,
      injectionAttemptId: claim.injectionAttemptId,
      provider: session.provider.name,
      target: session.provider.target,
      approvedEventId,
    });
    await this.acknowledgeAcceptedMessage(this.current({ secret: true }), message, eventId);
    return result;
  }

  async approve(eventId) {
    const session = this.current({ secret: true });
    const pending = session.pending.find((item) => item.id === eventId);
    if (!pending) throw new Error(`Pending message not found: ${eventId}`);
    return this.inject(session, pending.message, { approvedEventId: eventId });
  }

  reject(eventId, reason = "rejected_by_owner") {
    let rejected;
    this.store.update(this.sessionId, (session) => {
      rejected = session.pending.find((item) => item.id === eventId);
      if (!rejected) throw new Error(`Pending message not found: ${eventId}`);
      session.pending = session.pending.filter((item) => item.id !== eventId);
      session.rejectedCount += 1;
      return session;
    });
    this.store.auditMessage(this.sessionId, "pending_message_rejected", rejected.message, {
      eventId,
      reason,
    });
    return { ok: true, eventId, reason };
  }

  claimFinalResponseDelivery(session, {
    eventId = "",
    correlate = true,
    status,
    preparedFingerprint,
    preparedNormalizedFingerprint,
  }) {
    const claimedAt = this.isoNow();
    const claimLeaseMs = Math.max(this.slackRequestTimeoutMs(session) + 5_000, 35_000);
    const leaseUntil = new Date(this.now() + claimLeaseMs).toISOString();
    const proposedResponseId = responseId();
    const proposedClientMessageId = crypto.randomUUID();
    const activeAttemptId = crypto.randomUUID();
    let claim = null;

    this.store.update(session.id, (latest) => {
      const awaitingTimestamps = new Set(latest.awaitingAcknowledgementTs || []);
      const incomplete = (latest.inboundEvents || []).filter((event) => (
        !event.completedAt && awaitingTimestamps.has(event.messageTs)
      ));
      let inbound = null;
      let correlationId = eventId || null;
      if (!correlate) {
        correlationId = null;
      } else if (eventId) {
        inbound = (latest.inboundEvents || []).find((event) => event.id === eventId) || null;
        assertSafelyInjected(inbound, eventId);
      } else if (incomplete.length > 1) {
        throw new Error(
          "Multiple inbound events are awaiting completion; pass --event to correlate the response",
        );
      } else if (incomplete.length === 1) {
        [inbound] = incomplete;
        correlationId = inbound.id;
      }

      const delivery = correlationId
        ? (latest.outboundDeliveries || []).find((candidate) => (
          candidate.correlationId === correlationId
        ))
        : null;
      if (eventId && !inbound && !delivery) {
        throw new Error(`Inbound event not found: ${eventId}`);
      }
      if (!delivery && eventId && (
        inbound.completedAt || !awaitingTimestamps.has(inbound.messageTs)
      )) {
        throw new Error(`Inbound event already completed: ${eventId}`);
      }

      const acknowledgements = inbound
        && !inbound.completedAt
        && awaitingTimestamps.has(inbound.messageTs)
        ? [structuredClone(inbound)]
        : [];
      if (delivery) {
        if (
          delivery.status !== status
          || delivery.preparedFingerprint !== preparedFingerprint
        ) {
          throw new Error(
            `Inbound event ${correlationId} already has a final response; `
            + "status and response text cannot be changed",
          );
        }
        if (
          delivery.messageTs
          || ["sent", "observed", "delivered"].includes(delivery.deliveryState)
        ) {
          claim = {
            kind: "already-delivered",
            delivery: structuredClone(delivery),
            correlationId,
            acknowledgements,
          };
          return latest;
        }
        const activeLease = delivery.deliveryState === "posting"
          && Date.parse(String(delivery.leaseUntil || "")) > this.now();
        if (activeLease) {
          claim = {
            kind: "in-flight",
            delivery: structuredClone(delivery),
            correlationId,
            acknowledgements: [],
          };
          return latest;
        }
        delivery.deliveryState = "posting";
        delivery.attempts = (delivery.attempts || 1) + 1;
        delivery.lastAttemptAt = claimedAt;
        delivery.leaseUntil = leaseUntil;
        delivery.activeAttemptId = activeAttemptId;
        claim = {
          kind: "owner",
          delivery: structuredClone(delivery),
          correlationId,
          acknowledgements,
          activeAttemptId,
        };
        return latest;
      }

      const created = {
        responseId: proposedResponseId,
        clientMessageId: proposedClientMessageId,
        correlationId,
        status,
        deliveryState: "posting",
        attempts: 1,
        messageTs: null,
        preparedAt: claimedAt,
        lastAttemptAt: claimedAt,
        leaseUntil,
        activeAttemptId,
        preparedFingerprint,
        preparedNormalizedFingerprint,
        observedAt: null,
        observedFingerprint: null,
        fingerprintsMatch: null,
        normalizationResult: null,
      };
      latest.outboundDeliveries = retainOutboundDeliveries([
        ...(latest.outboundDeliveries || []),
        created,
      ]);
      claim = {
        kind: "owner",
        delivery: structuredClone(created),
        correlationId,
        acknowledgements,
        activeAttemptId,
      };
      return latest;
    });
    return claim;
  }

  async respond(text, {
    send,
    eventId = "",
    status = "complete",
    correlate = true,
    signal = null,
  } = {}) {
    const session = this.current({ secret: true });
    const shouldSend = Boolean(session.sendResponses && send !== false);
    if (status === "progress") {
      const acknowledgements = correlate
        ? this.acknowledgementEvents(session, eventId)
        : [];
      const progressed = await this.markAcknowledgementsInProgress(session, acknowledgements, {
        send: shouldSend,
        reason: "explicit",
        signal,
      });
      return {
        ok: true,
        mode: shouldSend ? "progress" : "dry-run",
        sent: false,
        status,
        eventIds: progressed,
      };
    }
    if (!["complete", "error"].includes(status)) {
      throw new Error("--status must be progress, complete, or error");
    }
    const outboundText = prefixResponse(text);
    if (!outboundText) throw new Error("Response message is empty");
    const preparedFingerprint = textFingerprint(outboundText);
    const preparedNormalizedFingerprint = textFingerprint(normalizeSlackText(outboundText));
    let acknowledgements = !shouldSend && correlate
      ? this.acknowledgementEvents(session, eventId)
      : [];
    let correlationId = eventId || acknowledgements[0]?.id || null;
    let originatingResponseId = responseId();
    let clientMessageId = crypto.randomUUID();
    let activeAttemptId = null;
    let claimKind = "dry-run";
    if (shouldSend) {
      const claim = this.claimFinalResponseDelivery(session, {
        eventId: correlate ? eventId : "",
        correlate,
        status,
        preparedFingerprint,
        preparedNormalizedFingerprint,
      });
      claimKind = claim.kind;
      acknowledgements = claim.acknowledgements;
      correlationId = claim.correlationId;
      originatingResponseId = claim.delivery.responseId;
      clientMessageId = claim.delivery.clientMessageId;
      activeAttemptId = claim.activeAttemptId || null;
      if (claim.kind === "in-flight") {
        this.store.audit(session.id, "response_delivery_in_flight", {
          responseId: originatingResponseId,
          clientMessageId,
          correlationId,
          status,
          attempts: claim.delivery.attempts || 1,
        });
        return {
          ok: true,
          mode: "in-flight",
          sent: false,
          responseId: originatingResponseId,
          correlationId,
          clientMessageId,
          status,
        };
      }
    }

    let result;
    let deliveredRecord = null;
    if (claimKind === "already-delivered") {
      deliveredRecord = this.current({ secret: true }).outboundDeliveries
        .find((candidate) => candidate.responseId === originatingResponseId);
      result = {
        ok: true,
        mode: "already-delivered",
        sent: true,
        ts: deliveredRecord.messageTs,
        messageTs: deliveredRecord.messageTs,
        clientMessageId,
      };
    } else {
      try {
        result = await this.runSlackOperation(
          session,
          `Slack response for session ${session.id}`,
          (operationSignal) => this.slack.reply(session, outboundText, {
            send: shouldSend,
            clientMessageId: shouldSend ? clientMessageId : null,
            signal: operationSignal,
          }),
          { signal },
        );
      } catch (error) {
        if (shouldSend) {
          this.store.update(session.id, (latest) => {
            const delivery = (latest.outboundDeliveries || [])
              .find((candidate) => candidate.responseId === originatingResponseId);
            if (
              delivery
              && !delivery.messageTs
              && delivery.activeAttemptId === activeAttemptId
            ) {
              delivery.deliveryState = "ambiguous";
              delivery.lastErrorAt = this.isoNow();
              delivery.lastError = String(error.message || error).slice(0, 1000);
              delivery.leaseUntil = null;
              delivery.activeAttemptId = null;
            }
            return latest;
          });
          this.store.audit(session.id, "response_delivery_ambiguous", {
            responseId: originatingResponseId,
            clientMessageId,
            correlationId,
            status,
            preparedFingerprint,
            error: String(error.message || error).slice(0, 1000),
          });
        }
        throw error;
      }
    }
    const respondedAt = this.isoNow();
    const effectiveSentAt = deliveredRecord?.sentAt || respondedAt;
    const deliveredTs = result.messageTs || result.ts || null;
    if (deliveredTs) {
      this.store.update(session.id, (latest) => {
        latest.outboundTs = [...new Set([...latest.outboundTs, deliveredTs])].slice(-200);
        let delivery = (latest.outboundDeliveries || [])
          .find((candidate) => candidate.responseId === originatingResponseId);
        if (!delivery) {
          delivery = {
            responseId: originatingResponseId,
            clientMessageId,
            correlationId,
            status,
            attempts: 1,
            preparedAt: respondedAt,
            preparedFingerprint,
            preparedNormalizedFingerprint,
            observedAt: null,
            observedFingerprint: null,
            fingerprintsMatch: null,
            normalizationResult: null,
          };
          latest.outboundDeliveries = retainOutboundDeliveries([
            ...(latest.outboundDeliveries || []),
            delivery,
          ]);
        }
        if (delivery.deliveryState !== "observed") delivery.deliveryState = "sent";
        delivery.messageTs ||= deliveredTs;
        delivery.sentAt ||= respondedAt;
        delivery.lastError = null;
        delivery.leaseUntil = null;
        delivery.activeAttemptId = null;
        return latest;
      });
    }
    this.store.audit(session.id, "response_prepared", {
      responseId: originatingResponseId,
      correlationId,
      clientMessageId: shouldSend ? clientMessageId : null,
      direction: "outbound",
      status,
      mode: result.mode,
      messageTs: deliveredTs,
      textLength: outboundText.length,
      preparedFingerprint,
    });
    if (result.sent) {
      const threshold = session.timings?.slowResponseThresholdMs || SLOW_RESPONSE_THRESHOLD_MS;
      this.store.update(session.id, (latest) => {
        for (const acknowledgement of acknowledgements) {
          const inbound = (latest.inboundEvents || [])
            .find((candidate) => candidate.id === acknowledgement.id);
          if (!inbound || inbound.firstResponseAt) continue;
          inbound.firstResponseAt = effectiveSentAt;
          const injectedAt = Date.parse(String(inbound.injectedAt || ""));
          const sentAt = Date.parse(String(effectiveSentAt || ""));
          inbound.injectedToFirstResponseMs = Number.isFinite(injectedAt)
            && Number.isFinite(sentAt)
            ? Math.max(0, sentAt - injectedAt)
            : this.elapsedSince(inbound.injectedAt);
          if (!latest.timings.firstResponseAt) {
            latest.timings.firstResponseAt = respondedAt;
            latest.timings.injectedToFirstResponseMs = inbound.injectedToFirstResponseMs;
          }
        }
        latest.lastSent = {
          direction: "outbound",
          responseId: originatingResponseId,
          clientMessageId,
          correlationId,
          messageTs: deliveredTs,
          sentAt: effectiveSentAt,
          textLength: outboundText.length,
          textSha256: preparedFingerprint,
          status,
        };
        return latest;
      });
      for (const acknowledgement of acknowledgements) {
        const updated = this.current().inboundEvents
          .find((candidate) => candidate.id === acknowledgement.id);
        if ((updated?.injectedToFirstResponseMs || 0) > threshold && !updated?.slowWarningAt) {
          const warningAt = this.isoNow();
          this.updateInboundEvent(acknowledgement.id, (current) => {
            current.slowWarningAt = warningAt;
            return current;
          });
          this.store.audit(session.id, "slow_first_response_warning", {
            eventId: acknowledgement.id,
            correlationId: acknowledgement.id,
            messageTs: acknowledgement.messageTs,
            injectedToFirstResponseMs: updated.injectedToFirstResponseMs,
            thresholdMs: threshold,
          });
        }
      }
      const latest = this.current({ secret: true });
      const outstandingAcknowledgements = acknowledgements.filter((acknowledgement) => {
        const inbound = (latest.inboundEvents || [])
          .find((candidate) => candidate.id === acknowledgement.id);
        return inbound
          && !inbound.completedAt
          && (latest.awaitingAcknowledgementTs || []).includes(inbound.messageTs);
      });
      await this.completeAcknowledgements(latest, outstandingAcknowledgements, {
        send: true,
        status,
        signal,
      });
    }
    return {
      ...result,
      responseId: originatingResponseId,
      correlationId,
      clientMessageId: shouldSend ? clientMessageId : null,
      status,
    };
  }

  async handleControl(session, message, control) {
    if (message.user !== session.ownerUserId) {
      this.store.auditMessage(session.id, "control_rejected", message, {
        action: control.action,
        reason: "owner_required",
      });
      this.advanceCursor(message, { rejectedCount: session.rejectedCount + 1 });
      return;
    }
    try {
      if (control.action === "pause") {
        this.store.update(session.id, (latest) => {
          latest.status = "paused";
          if (timestampKey(message.ts) > timestampKey(latest.cursorTs)) {
            latest.cursorTs = message.ts;
            latest.listenerCursorAt = this.isoNow();
          }
          return latest;
        });
      } else if (control.action === "resume") {
        this.store.update(session.id, (latest) => {
          latest.status = "active";
          if (timestampKey(message.ts) > timestampKey(latest.cursorTs)) {
            latest.cursorTs = message.ts;
            latest.listenerCursorAt = this.isoNow();
          }
          return latest;
        });
      } else if (control.action === "stop") {
        this.store.update(session.id, (latest) => {
          latest.status = "stopped";
          latest.stoppedAt = this.isoNow();
          if (timestampKey(message.ts) > timestampKey(latest.cursorTs)) {
            latest.cursorTs = message.ts;
            latest.listenerCursorAt = this.isoNow();
          }
          return latest;
        });
      } else if (control.action === "approve" && control.argument) {
        await this.approve(control.argument);
        this.advanceCursor(message);
      } else if (control.action === "reject" && control.argument) {
        this.reject(control.argument, "rejected_from_slack");
        this.advanceCursor(message);
      } else if (control.action === "status") {
        this.advanceCursor(message);
        await this.respond(
          `Session ${session.id}: ${session.status}; provider ${session.provider.name}:${session.provider.target}; `
          + `${session.pending.length} pending; ${session.injectedCount} injected.`,
          { correlate: false },
        );
      } else {
        this.store.auditMessage(session.id, "control_rejected", message, {
          action: control.action,
          reason: "unsupported_control",
        });
        this.advanceCursor(message);
      }
    } catch (error) {
      this.store.auditMessage(session.id, "control_failed", message, {
        action: control.action,
        error: String(error.message || error).slice(0, 1000),
      });
      this.advanceCursor(message);
      return;
    }
    this.store.auditMessage(session.id, "control_processed", message, { action: control.action });
  }

  async handleMessage(session, message) {
    if (!message.ts || message.ts === session.slack.threadTs) return;
    const observedClientMessageId = String(message.client_msg_id || "").trim();
    const delivery = (session.outboundDeliveries || []).find((candidate) => (
      candidate.messageTs === message.ts
      || (
        observedClientMessageId
        && candidate.clientMessageId === observedClientMessageId
      )
    ));
    if (session.outboundTs.includes(message.ts) || delivery) {
      const recoveredByClientMessageId = Boolean(
        delivery
        && observedClientMessageId
        && delivery.clientMessageId === observedClientMessageId
        && delivery.messageTs !== message.ts,
      );
      const observedFingerprint = textFingerprint(message.text);
      const observedNormalizedFingerprint = textFingerprint(normalizeSlackText(message.text));
      const fingerprintsMatch = delivery
        ? delivery.preparedFingerprint === observedFingerprint
        : null;
      const normalizationResult = !delivery
        ? "prepared_fingerprint_unavailable"
        : fingerprintsMatch
          ? "exact"
          : delivery.preparedNormalizedFingerprint === observedNormalizedFingerprint
            ? "normalized_match"
          : "different";
      const observedAt = this.isoNow();
      this.store.update(session.id, (latest) => {
        const current = delivery
          ? (latest.outboundDeliveries || [])
            .find((candidate) => candidate.responseId === delivery.responseId)
          : null;
        if (current) {
          current.messageTs ||= message.ts;
          current.deliveryState = "observed";
          current.sentAt ||= observedAt;
          current.observedAt = observedAt;
          current.observedFingerprint = observedFingerprint;
          current.fingerprintsMatch = fingerprintsMatch;
          current.normalizationResult = normalizationResult;
          current.lastError = null;
          current.leaseUntil = null;
          current.activeAttemptId = null;
          latest.outboundTs = [
            ...new Set([...(latest.outboundTs || []), current.messageTs]),
          ].slice(-200);
          latest.lastSent = {
            direction: "outbound",
            responseId: current.responseId,
            clientMessageId: current.clientMessageId,
            correlationId: current.correlationId,
            messageTs: current.messageTs,
            sentAt: current.sentAt,
            textLength: String(message.text || "").length,
            textSha256: current.preparedFingerprint,
            status: current.status,
          };
          const inbound = (latest.inboundEvents || [])
            .find((candidate) => candidate.id === current.correlationId);
          if (inbound && !inbound.firstResponseAt) {
            inbound.firstResponseAt = observedAt;
            inbound.injectedToFirstResponseMs = this.elapsedSince(inbound.injectedAt);
            if (!latest.timings.firstResponseAt) {
              latest.timings.firstResponseAt = observedAt;
              latest.timings.injectedToFirstResponseMs = inbound.injectedToFirstResponseMs;
            }
          }
          latest.outboundDeliveries = retainOutboundDeliveries(
            latest.outboundDeliveries,
          );
        }
        latest.lastOutboundObserved = {
          direction: "outbound",
          reason: "self_authored",
          responseId: current?.responseId || null,
          correlationId: current?.correlationId || null,
          messageTs: message.ts,
          observedAt,
          fingerprintsMatch,
          normalizationResult,
        };
        if (timestampKey(message.ts) > timestampKey(latest.cursorTs)) {
          latest.cursorTs = message.ts;
          latest.listenerCursorAt = observedAt;
        }
        return latest;
      });
      this.store.auditMessage(session.id, "outbound_delivery_observed", message, {
        direction: "outbound",
        reason: "self_authored",
        responseId: delivery?.responseId || null,
        correlationId: delivery?.correlationId || null,
        preparedFingerprint: delivery?.preparedFingerprint || null,
        observedFingerprint,
        fingerprintsMatch,
        normalizationResult,
        recoveredByClientMessageId,
      });
      const latest = this.current({ secret: true });
      const inbound = delivery?.correlationId
        ? (latest.inboundEvents || [])
          .find((candidate) => candidate.id === delivery.correlationId)
        : null;
      const threshold = latest.timings?.slowResponseThresholdMs
        || SLOW_RESPONSE_THRESHOLD_MS;
      if (
        inbound
        && (inbound.injectedToFirstResponseMs || 0) > threshold
        && !inbound.slowWarningAt
      ) {
        const warningAt = this.isoNow();
        this.updateInboundEvent(inbound.id, (current) => {
          current.slowWarningAt = warningAt;
          return current;
        });
        this.store.audit(session.id, "slow_first_response_warning", {
          eventId: inbound.id,
          correlationId: inbound.id,
          messageTs: inbound.messageTs,
          injectedToFirstResponseMs: inbound.injectedToFirstResponseMs,
          thresholdMs: threshold,
        });
      }
      if (
        inbound
        && !inbound.completedAt
        && (latest.awaitingAcknowledgementTs || []).includes(inbound.messageTs)
      ) {
        await this.completeAcknowledgements(latest, [inbound], {
          send: true,
          status: delivery.status || "complete",
        });
      }
      return;
    }
    const skipReason = inboundSkipReason(message);
    const receivedAt = this.isoNow();
    this.store.update(session.id, (latest) => {
      latest.lastReceived = {
        direction: "inbound",
        eventId: null,
        messageTs: message.ts,
        userId: message.user || null,
        username: message.username || null,
        receivedAt,
        disposition: skipReason ? "skipped" : "observed",
        skipReason,
        textLength: String(message.text || "").length,
        textSha256: textFingerprint(message.text),
      };
      return latest;
    });
    if (skipReason) {
      this.store.auditMessage(session.id, "message_skipped", message, {
        reason: skipReason,
        subtype: message.subtype || null,
      });
      this.advanceCursor(message);
      return;
    }
    const control = parseControl(message.text);
    if (control) {
      await this.handleControl(session, message, control);
      return;
    }
    const isOwner = message.user === session.ownerUserId;
    const isAllowed = isOwner
      || session.allowAnyUser
      || session.allowedUserIds.includes(message.user);
    if (!isAllowed) {
      this.store.auditMessage(session.id, "message_rejected", message, { reason: "user_not_allowed" });
      this.advanceCursor(message, { rejectedCount: session.rejectedCount + 1 });
      return;
    }
    const eventId = sessionEventId(session, message);
    const latest = this.current({ secret: true });
    const existingInjection = (latest.inboundEvents || [])
      .find((event) => event.id === eventId);
    const existingPending = (latest.pending || [])
      .find((pending) => pending.id === eventId);
    if (existingInjection || existingPending) {
      this.store.auditMessage(session.id, "message_injection_quarantined", message, {
        eventId,
        correlationId: eventId,
        reason: existingInjection
          ? "existing_injection_attempt"
          : "already_pending",
        injectionAttemptId: existingInjection?.injectionAttemptId || null,
        injectionState: existingInjection?.injectionState
          || existingInjection?.state
          || null,
      });
      this.advanceCursor(message);
      return;
    }
    if (session.status === "paused" || (!isOwner && !session.autoApproveCollaborators)) {
      this.store.update(session.id, (latest) => {
        latest.pending.push({
          id: eventId,
          receivedAt: this.isoNow(),
          message: {
            ts: message.ts,
            user: message.user || null,
            username: message.username || null,
            text: sanitizeInboundText(message.text),
          },
        });
        latest.cursorTs = message.ts;
        latest.listenerCursorAt = this.isoNow();
        return latest;
      });
      this.store.auditMessage(session.id, "message_queued_for_approval", message, {
        eventId,
        reason: session.status === "paused" ? "session_paused" : "collaborator_approval_required",
      });
      return;
    }
    await this.inject(session, message);
  }

  async markSlowAcknowledgements() {
    const session = this.current({ secret: true });
    const threshold = session.timings?.slowResponseThresholdMs || SLOW_RESPONSE_THRESHOLD_MS;
    const slowEvents = (session.inboundEvents || []).filter((event) => (
      !event.completedAt
      && !event.progressAt
      && !event.slowWarningAt
      && this.elapsedSince(event.injectedAt) >= threshold
    ));
    for (const event of slowEvents) {
      const warningAt = this.isoNow();
      this.updateInboundEvent(event.id, (current) => {
        current.slowWarningAt ||= warningAt;
        return current;
      });
      this.store.audit(session.id, "slow_first_response_warning", {
        eventId: event.id,
        correlationId: event.id,
        messageTs: event.messageTs,
        injectedToFirstResponseMs: this.elapsedSince(event.injectedAt),
        thresholdMs: threshold,
      });
    }
    await this.markAcknowledgementsInProgress(session, slowEvents, {
      send: session.sendResponses,
      reason: "slow_response_threshold",
    });
  }

  async runOnce({ signal = null } = {}) {
    let session = this.current({ secret: true });
    if (!["active", "paused"].includes(session.status)) {
      return { ok: true, status: session.status, processed: 0 };
    }
    await this.markSlowAcknowledgements();
    const pollStarted = this.now();
    const snapshot = await pollWithCancellation(this.slack, session, {
      signal,
      timeoutMs: this.pollTimeoutMs || session.slackConfig?.timeoutMs || DEFAULT_POLL_TIMEOUT_MS,
    });
    if (signal?.aborted) {
      throw pollError(
        `Slack poll for session ${session.id} was cancelled`,
        POLL_CANCELLED_CODE,
      );
    }
    const firstPollAt = this.isoNow();
    const messages = snapshot.messages.filter((message) => (
      timestampKey(message.ts) > timestampKey(session.cursorTs)
    ));
    let processed = 0;
    for (const message of messages) {
      session = this.current({ secret: true });
      if (session.status === "stopped") break;
      await this.handleMessage(session, message);
      processed += 1;
    }
    if (processed > 0) {
      this.store.audit(session.id, "poll_completed", {
        pages: snapshot.pages?.length || 0,
        observed: snapshot.messages.length,
        processed,
      });
    }
    this.store.update(session.id, (latest) => {
      if (!latest.timings.firstPollAt) {
        latest.timings.firstPollAt = firstPollAt;
        latest.timings.firstPollDurationMs = Math.max(0, this.now() - pollStarted);
        const runtimeReady = Date.parse(String(latest.timings.runtimeReadyAt || ""));
        latest.timings.runtimeReadyToFirstPollMs = Number.isFinite(runtimeReady)
          ? Math.max(0, Date.parse(firstPollAt) - runtimeReady)
          : null;
      }
      return latest;
    });
    return { ok: true, status: this.current().status, processed };
  }

  async startBridge({ signal = null } = {}) {
    this.validateRuntimeInstance();
    const runtimeSession = this.current({ secret: true });
    if (
      !this.runtimeInstanceId
      || runtimeSession.runtimeInstanceId !== this.runtimeInstanceId
      || runtimeSession.pid !== process.pid
    ) {
      const error = new Error(
        `Bridge for session ${this.sessionId} requires the exact current runtime identity`,
      );
      error.code = "BRIDGE_RUNTIME_IDENTITY_REQUIRED";
      throw error;
    }
    this.server = http.createServer(async (request, response) => {
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.setHeader("cache-control", "no-store");
      try {
        const url = new URL(request.url || "/", "http://127.0.0.1");
        if (request.method === "GET" && url.pathname === "/health") {
          const nonce = String(url.searchParams.get("nonce") || "");
          if (!/^[a-zA-Z0-9_-]{32,128}$/.test(nonce)) {
            response.writeHead(400);
            response.end(JSON.stringify({ ok: false, error: "invalid_health_nonce" }));
            return;
          }
          this.validateRuntimeInstance();
          const current = this.current({ secret: true });
          if (
            !this.runtimeInstanceId
            || current.runtimeInstanceId !== this.runtimeInstanceId
            || current.pid !== process.pid
          ) {
            response.writeHead(409);
            response.end(JSON.stringify({ ok: false, error: "runtime_identity_mismatch" }));
            return;
          }
          response.writeHead(200);
          response.end(JSON.stringify({
            ok: true,
            protocol: BRIDGE_HEALTH_PROTOCOL,
            sessionId: this.sessionId,
            proof: bridgeHealthProof(current, nonce),
          }));
          return;
        }
        if (
          request.method !== "POST"
          || url.pathname !== `/v1/sessions/${encodeURIComponent(this.sessionId)}/responses`
        ) {
          response.writeHead(404);
          response.end(JSON.stringify({ ok: false, error: "not_found" }));
          return;
        }
        this.validateRuntimeInstance();
        const current = this.current({ secret: true });
        if (
          !this.runtimeInstanceId
          || current.runtimeInstanceId !== this.runtimeInstanceId
          || current.pid !== process.pid
        ) {
          response.writeHead(409);
          response.end(JSON.stringify({ ok: false, error: "runtime_identity_mismatch" }));
          return;
        }
        const authorization = String(request.headers.authorization || "");
        const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
        if (!safeTokenEqual(token, current.bridgeToken)) {
          response.writeHead(401);
          response.end(JSON.stringify({ ok: false, error: "unauthorized" }));
          return;
        }
        const body = await readJson(request);
        const result = await this.respond(body.message, {
          send: body.send,
          eventId: body.eventId,
          status: body.status,
          signal,
        });
        response.writeHead(200);
        response.end(JSON.stringify({ ok: true, result }));
      } catch (error) {
        if (!response.destroyed) {
          response.writeHead(error.message === "request_too_large" ? 413 : 400);
          response.end(JSON.stringify({ ok: false, error: error.message }));
        }
      }
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    const address = this.server.address();
    this.store.update(this.sessionId, (latest) => {
      if (
        this.runtimeInstanceId
        && latest.runtimeInstanceId !== this.runtimeInstanceId
      ) {
        throw new Error(`Runtime instance for session ${this.sessionId} was superseded`);
      }
      latest.bridge = {
        host: "127.0.0.1",
        port: address.port,
        url: `http://127.0.0.1:${address.port}`,
      };
      return latest;
    });
    return this.current().bridge;
  }

  async stopBridge() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise((resolve) => {
      try {
        server.close(resolve);
        server.closeAllConnections?.();
      } catch {
        resolve();
      }
    });
    this.store.update(this.sessionId, (session) => {
      if (
        this.runtimeInstanceId
        && session.runtimeInstanceId !== this.runtimeInstanceId
      ) {
        return session;
      }
      session.bridge = { host: "127.0.0.1", port: null, url: null };
      return session;
    });
  }

  async run({ once = false, signal = null } = {}) {
    this.validateRuntimeInstance();
    if (!["active", "paused"].includes(this.current().status)) {
      throw new Error(
        `Session ${this.sessionId} is ${this.current().status} and cannot be run`,
      );
    }
    const release = this.store.acquireRunLock(this.sessionId);
    let stopping = false;
    let wakeForStop;
    const lifecycleController = new AbortController();
    this.lifecycleSignal = lifecycleController.signal;
    const stopRequested = new Promise((resolve) => { wakeForStop = resolve; });
    const stop = () => {
      if (stopping) return;
      stopping = true;
      lifecycleController.abort();
      wakeForStop();
    };
    let consecutiveFailures = 0;
    let runtimeError = null;
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    process.once("SIGHUP", stop);
    if (signal?.aborted) stop();
    else signal?.addEventListener("abort", stop, { once: true });
    try {
      this.reconcileClaimedInjections();
      this.provider.verify();
      this.validateRuntimeInstance();
      if (!["active", "paused"].includes(this.current().status)) {
        throw new Error(`Session ${this.sessionId} stopped during provider preflight`);
      }
      this.store.update(this.sessionId, (session) => {
        if (
          this.runtimeInstanceId
          && session.runtimeInstanceId !== this.runtimeInstanceId
        ) {
          throw new Error(`Runtime instance for session ${this.sessionId} was superseded`);
        }
        session.pid = process.pid;
        const startedAt = this.isoNow();
        session.startedAt ||= startedAt;
        session.lastRuntimeStartedAt = startedAt;
        session.host ||= {};
        session.host.pid = process.pid;
        session.host.status = "running";
        return session;
      });
      if (!once) await this.startBridge({ signal: lifecycleController.signal });
      const runtimeReadyAt = this.isoNow();
      this.store.update(this.sessionId, (session) => {
        session.timings.runtimeReadyAt = runtimeReadyAt;
        return session;
      });
      this.store.audit(this.sessionId, "runtime_started", { pid: process.pid, runtimeReadyAt });
      do {
        const session = this.current({ secret: true });
        if (session.status === "stopped" || stopping) break;
        if (session.status === "active" || session.status === "paused") {
          try {
            await this.runOnce({ signal: lifecycleController.signal });
            consecutiveFailures = 0;
          } catch (error) {
            if (error.code === POLL_CANCELLED_CODE && stopping) break;
            consecutiveFailures += 1;
            this.store.audit(this.sessionId, "poll_failed", { error: String(error.message || error).slice(0, 2000) });
            this.logger.error?.(`Slack session ${this.sessionId} poll failed: ${error.message || error}`);
            if (once) throw error;
          }
        }
        if (once) break;
        const baseDelay = Math.max(1000, session.pollIntervalMs);
        const backoffDelay = Math.min(60_000, baseDelay * (2 ** consecutiveFailures));
        const jitter = consecutiveFailures ? Math.floor(Math.random() * Math.min(1000, baseDelay)) : 0;
        await Promise.race([sleep(backoffDelay + jitter), stopRequested]);
      } while (!stopping);
      if (once) {
        this.store.update(this.sessionId, (session) => {
          session.status = "stopped";
          session.stoppedAt = this.isoNow();
          return session;
        });
      }
    } catch (error) {
      runtimeError = error;
      throw error;
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      process.removeListener("SIGHUP", stop);
      signal?.removeEventListener("abort", stop);
      await this.stopBridge();
      this.lifecycleSignal = null;
      let superseded = false;
      const finalSession = this.store.update(this.sessionId, (session) => {
        if (
          this.runtimeInstanceId
          && session.runtimeInstanceId !== this.runtimeInstanceId
        ) {
          superseded = true;
          return session;
        }
        if (["active", "paused"].includes(session.status)) {
          session.status = runtimeError ? "runtime_failed" : "runtime_exited";
          session.stoppedAt = this.isoNow();
        }
        session.pid = null;
        session.host ||= {};
        session.host.pid = null;
        session.host.status = session.status === "stopped" ? "stopped" : "exited";
        return session;
      });
      this.store.audit(this.sessionId, "runtime_stopped", {
        pid: process.pid,
        status: finalSession.status,
        error: runtimeError
          ? String(runtimeError.message || runtimeError).slice(0, 2000)
          : null,
        superseded,
      });
      release();
    }
    return this.current();
  }
}

async function postBridgeResponse(session, message, { send, eventId, status } = {}) {
  const baseUrl = bridgeBaseUrl(session);
  const nonce = crypto.randomBytes(24).toString("base64url");
  const healthResponse = await fetch(
    `${baseUrl}/health?nonce=${encodeURIComponent(nonce)}`,
    {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(3000),
    },
  );
  let health;
  try {
    health = await healthResponse.json();
  } catch {
    throw new Error(`Bridge health preflight returned HTTP ${healthResponse.status} without JSON`);
  }
  const expectedProof = bridgeHealthProof(session, nonce);
  if (
    !healthResponse.ok
    || !health?.ok
    || health.protocol !== BRIDGE_HEALTH_PROTOCOL
    || health.sessionId !== session.id
    || !safeTokenEqual(health.proof, expectedProof)
  ) {
    throw new Error(
      health?.error
      || "Bridge health preflight could not authenticate the stored runtime",
    );
  }
  const response = await fetch(
    `${baseUrl}/v1/sessions/${encodeURIComponent(session.id)}/responses`,
    {
      method: "POST",
      redirect: "error",
      headers: {
        "authorization": `Bearer ${session.bridgeToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ message, send, eventId, status }),
      signal: AbortSignal.timeout(3000),
    },
  );
  const json = await response.json();
  if (!response.ok || !json.ok) throw new Error(json.error || `Bridge returned HTTP ${response.status}`);
  return json.result;
}

module.exports = {
  BRIDGE_HEALTH_PROTOCOL,
  DEFAULT_POLL_TIMEOUT_MS,
  DEFAULT_RESPONSE_PREFIX,
  EVENT_SENTINEL,
  MAX_INBOUND_TEXT,
  SessionRuntime,
  formatAgentPrompt,
  inboundSkipReason,
  normalizeSlackText,
  parseControl,
  postBridgeResponse,
  prefixResponse,
  retainOutboundDeliveries,
  sanitizeInboundText,
  shellInertJson,
  sessionEventId,
};
