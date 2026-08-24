const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DEFAULT_SESSION_DIR } = require("./slack-api-common.cjs");

const STATE_VERSION = 1;
const SLOW_RESPONSE_THRESHOLD_MS = 30_000;
const START_INTENT_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
const START_INTENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const START_INTENT_LIMIT = 200;

function nowIso() {
  return new Date().toISOString();
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function processIsAlive(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric < 1) return false;
  try {
    process.kill(numeric, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function removeDeadLock(lockPath) {
  try {
    const pid = fs.readFileSync(lockPath, "utf8").trim();
    if (!pid) return false;
    if (processIsAlive(pid)) return false;
    fs.unlinkSync(lockPath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    return false;
  }
}

function safeSessionId(value) {
  const id = String(value || "").trim();
  if (!/^sess_[a-zA-Z0-9_-]{8,80}$/.test(id)) {
    throw new Error(`Invalid session id: ${value}`);
  }
  return id;
}

function newSessionId() {
  const time = Date.now().toString(36);
  const random = crypto.randomBytes(6).toString("base64url");
  return `sess_${time}_${random}`;
}

function newStartIntentId() {
  const time = Date.now().toString(36);
  const random = crypto.randomBytes(6).toString("base64url");
  return `start_${time}_${random}`;
}

function newStartAttemptId() {
  return `attempt_${crypto.randomBytes(12).toString("base64url")}`;
}

function textFingerprint(text) {
  return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function normalizeStartIntent(intent) {
  return {
    ...intent,
    attempts: Math.max(1, Number(intent.attempts) || 1),
    activeAttemptId: intent.activeAttemptId || null,
    leaseUntil: intent.leaseUntil || null,
    root: intent.root || null,
    completedAt: intent.completedAt || null,
    failedAt: intent.failedAt || null,
    expiredAt: intent.expiredAt || null,
  };
}

function startIntentTimestamp(intent) {
  const timestamp = Date.parse(
    String(intent.updatedAt || intent.createdAt || ""),
  );
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function startIntentIsRecoverable(intent) {
  return ["posting", "ambiguous", "root_posted", "starting"].includes(intent.state);
}

function pruneStartIntents(intents, nowMs) {
  const normalized = (intents || []).map(normalizeStartIntent);
  for (const intent of normalized) {
    if (
      startIntentIsRecoverable(intent)
      && nowMs - Date.parse(String(intent.createdAt || "")) > START_INTENT_RETRY_WINDOW_MS
    ) {
      intent.state = "expired";
      intent.expiredAt = new Date(nowMs).toISOString();
      intent.updatedAt = intent.expiredAt;
      intent.activeAttemptId = null;
      intent.leaseUntil = null;
    }
  }
  const retained = normalized.filter((intent) => (
    startIntentIsRecoverable(intent)
    || nowMs - startIntentTimestamp(intent) <= START_INTENT_RETENTION_MS
  ));
  if (retained.length <= START_INTENT_LIMIT) return retained;
  const recoverable = retained.filter(startIntentIsRecoverable);
  const terminal = retained
    .filter((intent) => !startIntentIsRecoverable(intent))
    .sort((left, right) => startIntentTimestamp(right) - startIntentTimestamp(left))
    .slice(0, Math.max(0, START_INTENT_LIMIT - recoverable.length));
  return [...recoverable, ...terminal]
    .sort((left, right) => startIntentTimestamp(left) - startIntentTimestamp(right));
}

function normalizeSession(session) {
  return {
    ...session,
    runtimeInstanceId: session.runtimeInstanceId || null,
    host: session.host || {
      kind: session.pid ? "process" : "unknown",
      target: null,
      managed: false,
      createdAt: session.startedAt || session.createdAt || null,
      closedAt: null,
    },
    attachment: session.attachment || {
      agentSessionId: null,
      agentProvider: "unknown",
      worktree: null,
      provider: session.provider?.name || null,
      target: session.provider?.target || null,
    },
    timings: {
      slowResponseThresholdMs: SLOW_RESPONSE_THRESHOLD_MS,
      commandStartedAt: null,
      providerPreflightMs: null,
      authenticationMs: null,
      destinationResolutionMs: null,
      rootCreationMs: null,
      runtimeReadinessMs: null,
      runtimeReadyAt: null,
      firstPollAt: null,
      firstPollDurationMs: null,
      runtimeReadyToFirstPollMs: null,
      firstAcknowledgementAt: null,
      injectedToAcknowledgedMs: null,
      firstResponseAt: null,
      injectedToFirstResponseMs: null,
      ...(session.timings || {}),
    },
    inboundEvents: session.inboundEvents || [],
    outboundDeliveries: session.outboundDeliveries || [],
    lastReceived: session.lastReceived || null,
    lastSent: session.lastSent || null,
    lastOutboundObserved: session.lastOutboundObserved || null,
  };
}

function publicSession(session) {
  if (!session) return null;
  const { bridgeToken, runtimeInstanceId, ...safe } = normalizeSession(session);
  const provider = safe.provider?.connection
    ? {
      ...safe.provider,
      connection: {
        environmentKeys: Object.keys(safe.provider.connection.environment || {}).sort(),
      },
    }
    : safe.provider;
  const host = safe.host?.connection
    ? {
      ...safe.host,
      ...(safe.host.cleanup?.error
        ? {
          cleanup: {
            ...safe.host.cleanup,
            error: Object.values(safe.host.connection.environment || {}).reduce(
              (diagnostic, endpoint) => (
                endpoint
                  ? diagnostic.replaceAll(endpoint, "[redacted host connection]")
                  : diagnostic
              ),
              String(safe.host.cleanup.error),
            ),
          },
        }
        : {}),
      connection: {
        environmentKeys: Object.keys(safe.host.connection.environment || {}).sort(),
      },
    }
    : safe.host;
  const pending = (safe.pending || []).map((entry) => {
    const { text, ...message } = entry.message || {};
    return {
      ...entry,
      message: {
        ...message,
        textLength: String(text || "").length,
        textSha256: textFingerprint(text),
      },
    };
  });
  return {
    ...safe,
    provider,
    host,
    pending,
    bridge: safe.bridge
      ? { ...safe.bridge, tokenConfigured: Boolean(bridgeToken) }
      : safe.bridge,
  };
}

function createSessionRecord(input, timestamp = nowIso()) {
  return {
    id: input.id || newSessionId(),
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: null,
    stoppedAt: null,
    pid: null,
    runtimeInstanceId: input.runtimeInstanceId || null,
    slack: input.slack,
    provider: input.provider,
    host: input.host || {
      kind: "pending",
      target: null,
      managed: false,
      createdAt: null,
      closedAt: null,
    },
    attachment: input.attachment || {
      agentSessionId: null,
      agentProvider: "unknown",
      worktree: null,
      provider: input.provider?.name || null,
      target: input.provider?.target || null,
    },
    ownerUserId: input.ownerUserId,
    ownerName: input.ownerName || null,
    allowedUserIds: [...new Set(input.allowedUserIds || [])],
    allowAnyUser: Boolean(input.allowAnyUser),
    autoApproveCollaborators: Boolean(input.autoApproveCollaborators),
    sendResponses: Boolean(input.sendResponses),
    pollIntervalMs: input.pollIntervalMs,
    cursorTs: input.cursorTs,
    listenerCursorAt: timestamp,
    lastInjectedAt: null,
    lastInjectedTs: null,
    recentInjectedTs: [],
    awaitingAcknowledgementTs: [],
    pending: [],
    outboundTs: [],
    inboundEvents: [],
    outboundDeliveries: [],
    lastReceived: null,
    lastSent: null,
    lastOutboundObserved: null,
    injectedCount: 0,
    rejectedCount: 0,
    bridgeToken: crypto.randomBytes(24).toString("base64url"),
    bridge: { host: "127.0.0.1", port: null, url: null },
    simulation: input.simulation || null,
    slackConfig: input.slackConfig || null,
    timings: {
      slowResponseThresholdMs: SLOW_RESPONSE_THRESHOLD_MS,
      commandStartedAt: null,
      providerPreflightMs: null,
      authenticationMs: null,
      destinationResolutionMs: null,
      rootCreationMs: null,
      runtimeReadinessMs: null,
      runtimeReadyAt: null,
      firstPollAt: null,
      firstPollDurationMs: null,
      runtimeReadyToFirstPollMs: null,
      firstAcknowledgementAt: null,
      injectedToAcknowledgedMs: null,
      firstResponseAt: null,
      injectedToFirstResponseMs: null,
      ...(input.timings || {}),
    },
  };
}

function activeSlackBinding(state, input) {
  return state.sessions.find((session) => (
    ["active", "paused"].includes(session.status)
    && session.slack.workspace === input.slack.workspace
    && session.slack.channelId === input.slack.channelId
    && session.slack.threadTs === input.slack.threadTs
  ));
}

function exactStartSessionBinding(session, input, intent) {
  return (
    session.id === intent.sessionId
    && session.slack?.bindingMode === "created_thread"
    && session.slack?.rootStartIntentId === intent.id
    && session.slack?.rootClientMessageId === intent.clientMessageId
    && session.slack?.workspace === input.slack.workspace
    && session.slack?.channelId === input.slack.channelId
    && session.slack?.threadTs === input.slack.threadTs
  );
}

function sessionRuntimeReady(session) {
  return Boolean(
    ["active", "paused"].includes(session?.status)
    && session.pid
    && session.bridge?.port
    && session.timings?.runtimeReadyAt
    && session.timings?.firstPollAt,
  );
}

class SessionStore {
  constructor(baseDir = DEFAULT_SESSION_DIR) {
    this.baseDir = path.resolve(baseDir);
    this.statePath = path.join(this.baseDir, "state.json");
    this.eventDir = path.join(this.baseDir, "events");
    this.lockDir = path.join(this.baseDir, "locks");
    this.mutationLockPath = path.join(this.lockDir, "state.lock");
    fs.mkdirSync(this.eventDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.lockDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.baseDir, 0o700);
  }

  readState() {
    try {
      const state = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
      if (state.version !== STATE_VERSION || !Array.isArray(state.sessions)) {
        throw new Error(`Unsupported session state schema at ${this.statePath}`);
      }
      if (state.startIntents !== undefined && !Array.isArray(state.startIntents)) {
        throw new Error(`Unsupported start-intent state at ${this.statePath}`);
      }
      return {
        ...state,
        sessions: state.sessions.map(normalizeSession),
        startIntents: (state.startIntents || []).map(normalizeStartIntent),
      };
    } catch (error) {
      if (error.code === "ENOENT") {
        return { version: STATE_VERSION, sessions: [], startIntents: [] };
      }
      if (error instanceof SyntaxError) {
        throw new Error(`Session state at ${this.statePath} is not valid JSON`);
      }
      throw error;
    }
  }

  writeState(state) {
    const temporary = `${this.statePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.statePath);
    fs.chmodSync(this.statePath, 0o600);
  }

  withMutationLock(callback) {
    let descriptor;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        descriptor = fs.openSync(this.mutationLockPath, "wx", 0o600);
        fs.writeFileSync(descriptor, `${process.pid}\n`);
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (removeDeadLock(this.mutationLockPath)) continue;
        if (attempt === 99) throw new Error("Timed out waiting for the session state lock");
        sleepSync(10);
      }
    }
    try {
      return callback();
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try {
        fs.unlinkSync(this.mutationLockPath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }

  list({ includeStopped = true } = {}) {
    const sessions = this.readState().sessions;
    return sessions
      .filter((session) => includeStopped || ["active", "paused"].includes(session.status))
      .map(publicSession)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  get(id, { includeSecret = false } = {}) {
    const sessionId = safeSessionId(id);
    const session = this.readState().sessions.find((candidate) => candidate.id === sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return includeSecret ? structuredClone(session) : publicSession(session);
  }

  create(input) {
    return this.withMutationLock(() => {
      const state = this.readState();
      const duplicate = activeSlackBinding(state, input);
      if (duplicate) {
        throw new Error(`Slack thread is already bound to active session ${duplicate.id}`);
      }
      const timestamp = nowIso();
      const session = createSessionRecord(input, timestamp);
      state.sessions.push(session);
      this.writeState(state);
      this.audit(session.id, "session_created", {
        channelId: session.slack.channelId,
        threadTs: session.slack.threadTs,
        bindingMode: session.slack.bindingMode || "existing_thread",
        provider: session.provider.name,
      });
      return publicSession(session);
    });
  }

  createStartSession(input, claim, {
    leaseUntil = null,
  } = {}) {
    const intentId = String(claim?.intent?.id || "").trim();
    const attemptId = String(claim?.intent?.activeAttemptId || "").trim();
    if (!intentId || !attemptId) {
      throw new Error("An active start-intent claim is required");
    }
    return this.withMutationLock(() => {
      const state = this.readState();
      const intentIndex = state.startIntents
        .findIndex((candidate) => candidate.id === intentId);
      if (intentIndex < 0) throw new Error(`Start intent not found: ${intentId}`);
      const intent = normalizeStartIntent(state.startIntents[intentIndex]);
      if (intent.activeAttemptId !== attemptId) {
        throw new Error(`Slack session start ${intentId} was superseded by another retry`);
      }

      let session = state.sessions.find((candidate) => candidate.id === input.id);
      let reused = false;
      if (session) {
        if (!exactStartSessionBinding(session, input, intent)) {
          throw new Error(
            `Session ${input.id} exists but does not match Slack start intent ${intentId}`,
          );
        }
        if (!["active", "paused"].includes(session.status)) {
          throw new Error(
            `Session ${input.id} was already reconciled but is ${session.status}`,
          );
        }
        reused = true;
      } else {
        const duplicate = activeSlackBinding(state, input);
        if (duplicate) {
          throw new Error(`Slack thread is already bound to active session ${duplicate.id}`);
        }
        session = createSessionRecord(input);
        state.sessions.push(session);
      }

      const timestamp = nowIso();
      intent.state = "starting";
      intent.updatedAt = timestamp;
      intent.sessionCreatedAt ||= session.createdAt || timestamp;
      intent.leaseUntil = leaseUntil || intent.leaseUntil;
      state.startIntents[intentIndex] = intent;
      this.writeState(state);
      if (!reused) {
        this.audit(session.id, "session_created", {
          channelId: session.slack.channelId,
          threadTs: session.slack.threadTs,
          bindingMode: session.slack.bindingMode || "existing_thread",
          provider: session.provider.name,
        });
      }
      return {
        reused,
        session: publicSession(session),
      };
    });
  }

  claimStartIntent(input, {
    now = Date.now(),
    leaseMs = 35_000,
  } = {}) {
    const fingerprint = String(input?.requestFingerprint || "").trim();
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
      throw new Error("A valid start request fingerprint is required");
    }
    const boundedLeaseMs = Number.isFinite(Number(leaseMs)) && Number(leaseMs) > 0
      ? Math.floor(Number(leaseMs))
      : 35_000;
    return this.withMutationLock(() => {
      const state = this.readState();
      state.startIntents = pruneStartIntents(state.startIntents, now);
      const existing = [...state.startIntents].reverse().find((intent) => (
        intent.requestFingerprint === fingerprint
        && startIntentIsRecoverable(intent)
      ));
      if (existing) {
        const leaseActive = Date.parse(String(existing.leaseUntil || "")) > now;
        const persistedSession = state.sessions
          .find((session) => session.id === existing.sessionId);
        const runtimeReady = sessionRuntimeReady(persistedSession);
        if (!runtimeReady && leaseActive) {
          this.writeState(state);
          return {
            kind: "in-flight",
            intent: structuredClone(existing),
          };
        }
        existing.state = "posting";
        existing.updatedAt = new Date(now).toISOString();
        existing.lastAttemptAt = existing.updatedAt;
        existing.leaseUntil = new Date(now + boundedLeaseMs).toISOString();
        existing.activeAttemptId = newStartAttemptId();
        existing.attempts = (existing.attempts || 1) + 1;
        existing.lastError = null;
        this.writeState(state);
        return {
          kind: "owner",
          resumedFrom: existing.root ? "root_posted" : "ambiguous",
          intent: structuredClone(existing),
        };
      }

      const timestamp = new Date(now).toISOString();
      const created = normalizeStartIntent({
        id: newStartIntentId(),
        requestFingerprint: fingerprint,
        sessionId: input.sessionId || newSessionId(),
        clientMessageId: input.clientMessageId || crypto.randomUUID(),
        state: "posting",
        createdAt: timestamp,
        updatedAt: timestamp,
        lastAttemptAt: timestamp,
        leaseUntil: new Date(now + boundedLeaseMs).toISOString(),
        activeAttemptId: newStartAttemptId(),
        attempts: 1,
        slack: structuredClone(input.slack || {}),
        root: null,
      });
      state.startIntents.push(created);
      state.startIntents = pruneStartIntents(state.startIntents, now);
      this.writeState(state);
      return {
        kind: "owner",
        resumedFrom: null,
        intent: structuredClone(created),
      };
    });
  }

  getStartIntent(id) {
    const intentId = String(id || "").trim();
    const intent = this.readState().startIntents
      .find((candidate) => candidate.id === intentId);
    if (!intent) throw new Error(`Start intent not found: ${intentId}`);
    return structuredClone(intent);
  }

  updateStartIntent(id, attemptId, updater) {
    const intentId = String(id || "").trim();
    return this.withMutationLock(() => {
      const state = this.readState();
      const index = state.startIntents
        .findIndex((candidate) => candidate.id === intentId);
      if (index < 0) throw new Error(`Start intent not found: ${intentId}`);
      const current = structuredClone(state.startIntents[index]);
      if (
        attemptId
        && current.activeAttemptId !== attemptId
      ) {
        return {
          updated: false,
          intent: current,
        };
      }
      const next = normalizeStartIntent(updater(current) || current);
      next.updatedAt = nowIso();
      state.startIntents[index] = next;
      state.startIntents = pruneStartIntents(state.startIntents, Date.now());
      this.writeState(state);
      return {
        updated: true,
        intent: structuredClone(next),
      };
    });
  }

  update(id, updater) {
    const sessionId = safeSessionId(id);
    return this.withMutationLock(() => {
      const state = this.readState();
      const index = state.sessions.findIndex((session) => session.id === sessionId);
      if (index < 0) throw new Error(`Session not found: ${sessionId}`);
      const current = structuredClone(state.sessions[index]);
      const next = updater(current) || current;
      next.updatedAt = nowIso();
      state.sessions[index] = next;
      this.writeState(state);
      return publicSession(next);
    });
  }

  audit(id, type, detail = {}) {
    const sessionId = safeSessionId(id);
    const record = {
      at: nowIso(),
      sessionId,
      type,
      ...detail,
    };
    const eventPath = path.join(this.eventDir, `${sessionId}.ndjson`);
    fs.appendFileSync(eventPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    fs.chmodSync(eventPath, 0o600);
    return record;
  }

  auditMessage(id, type, message, extra = {}) {
    return this.audit(id, type, {
      messageTs: message.ts || null,
      userId: message.user || null,
      textLength: String(message.text || "").length,
      textSha256: textFingerprint(message.text),
      ...extra,
    });
  }

  readEvents(id, limit = 100) {
    const sessionId = safeSessionId(id);
    const eventPath = path.join(this.eventDir, `${sessionId}.ndjson`);
    try {
      return fs.readFileSync(eventPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .slice(-Math.max(1, Math.min(1000, limit)));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  acquireRunLock(id) {
    const sessionId = safeSessionId(id);
    const lockPath = path.join(this.lockDir, `${sessionId}.run`);
    let descriptor;
    try {
      descriptor = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(descriptor, `${process.pid}\n`);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (removeDeadLock(lockPath)) return this.acquireRunLock(sessionId);
      let owner = "unknown";
      try {
        owner = fs.readFileSync(lockPath, "utf8").trim() || owner;
      } catch {}
      throw new Error(`Session ${sessionId} is already running (pid ${owner})`);
    }
    return () => {
      fs.closeSync(descriptor);
      try {
        fs.unlinkSync(lockPath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    };
  }
}

module.exports = {
  STATE_VERSION,
  SLOW_RESPONSE_THRESHOLD_MS,
  START_INTENT_LIMIT,
  START_INTENT_RETENTION_MS,
  START_INTENT_RETRY_WINDOW_MS,
  SessionStore,
  newSessionId,
  newStartIntentId,
  normalizeSession,
  normalizeStartIntent,
  publicSession,
  processIsAlive,
  safeSessionId,
  textFingerprint,
};
