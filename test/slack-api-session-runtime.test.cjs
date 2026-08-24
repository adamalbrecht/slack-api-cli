const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { Readable } = require("node:stream");
const { StdioProvider } = require("../slack-api-session-provider.cjs");
const {
  main: sessionCommand,
  parseArgs,
  respond: respondCommand,
} = require("../slack-api-session.cjs");
const {
  BRIDGE_HEALTH_PROTOCOL,
  EVENT_SENTINEL,
  SessionRuntime,
  formatAgentPrompt,
  parseControl,
  postBridgeResponse,
  retainOutboundDeliveries,
  sessionEventId,
} = require("../slack-api-session-runtime.cjs");
const {
  SessionStore,
  textFingerprint,
} = require("../slack-api-session-store.cjs");

function setup(messages, overrides = {}, runtimeOptions = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "slack-session-runtime-"));
  const store = new SessionStore(directory);
  const session = store.create({
    slack: {
      workspace: "https://example.slack.com",
      channelId: "C1",
      threadTs: "100.000001",
      permalink: "https://example.slack.com/archives/C1/p100000001",
    },
    provider: { name: "stdio", target: "stdout" },
    ownerUserId: "U_OWNER",
    allowedUserIds: ["U_COLLAB"],
    allowAnyUser: false,
    autoApproveCollaborators: false,
    sendResponses: true,
    pollIntervalMs: 1000,
    cursorTs: "100.000001",
    ...overrides,
  });
  const replies = [];
  const reactions = [];
  const reactionState = new Set();
  const slack = {
    async poll() { return { messages, pages: [{ ok: true }] }; },
    async reply(current, text, { send }) {
      const result = {
        ok: true,
        mode: send ? "sent" : "dry-run",
        sent: Boolean(send),
        ts: send ? "999.000001" : null,
        text,
      };
      replies.push(result);
      return result;
    },
    async react(current, messageTs, emoji, { add, send }) {
      const key = `${messageTs}:${emoji}`;
      const present = reactionState.has(key);
      let mode = "dry-run";
      if (send && add && !present) {
        reactionState.add(key);
        mode = "added";
      } else if (send && add) {
        mode = "already-present";
      } else if (send && !add && present) {
        reactionState.delete(key);
        mode = "removed";
      } else if (send && !add) {
        mode = "not-present";
      }
      const result = { ok: true, mode, messageTs, emoji, add, send };
      reactions.push(result);
      return result;
    },
  };
  const provider = new StdioProvider({ writer() {} });
  const runtime = new SessionRuntime({
    store,
    slack,
    provider,
    sessionId: session.id,
    logger: { error() {} },
    ...runtimeOptions,
  });
  return { store, session, slack, provider, runtime, replies, reactions, reactionState };
}

function message(ts, user, text) {
  return { ts, thread_ts: "100.000001", user, username: user, text };
}

function attachRuntimeIdentity(fixture, runtimeInstanceId = "runtime_bridge_test") {
  fixture.runtime.runtimeInstanceId = runtimeInstanceId;
  fixture.store.update(fixture.session.id, (session) => {
    session.runtimeInstanceId = runtimeInstanceId;
    session.pid = process.pid;
    session.host.pid = process.pid;
    return session;
  });
}

async function within(milliseconds, promise) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Promise did not settle within ${milliseconds}ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function runResponseWorker(stateDir, sessionId, eventId, callLog) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(__dirname, "..", "test-support", "slack-session-response-worker.cjs"),
      stateDir,
      sessionId,
      eventId,
      callLog,
    ], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== 0 || signal) {
        reject(new Error(
          `response worker failed (${signal || code}): ${stderr || stdout}`,
        ));
        return;
      }
      resolve(JSON.parse(stdout.trim()));
    });
  });
}

test("agent prompt is one physical sentinel line with escaped multiline text and response correlation", () => {
  const fixture = setup([]);
  const inbound = message(
    "101.000001",
    "U_OWNER",
    "  line one\r\nline two 👩‍💻\u2028next\u0085  ",
  );
  const eventId = sessionEventId(fixture.store.get(fixture.session.id), inbound);
  const prompt = formatAgentPrompt(fixture.store.get(fixture.session.id), inbound, eventId);

  assert.equal(prompt.startsWith(`${EVENT_SENTINEL} `), true);
  assert.doesNotMatch(prompt, /[\r\n\u0085\u2028\u2029]/);
  const envelope = JSON.parse(prompt.slice(EVENT_SENTINEL.length + 1));
  assert.equal(envelope.eventId, eventId);
  assert.equal(envelope.sessionId, fixture.session.id);
  assert.equal(envelope.text, "  line one\nline two 👩‍💻\u2028next\u0085  ");
  assert.equal(envelope.response.sendEnabled, true);
  assert.match(envelope.response.completeCommand, new RegExp(`--event ${eventId}`));
  assert.match(envelope.response.completeCommand, /--send$/);
});

test("agent prompt is inert when an abandoned target is an interactive shell", (t) => {
  const fixture = setup([]);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "slack-shell-inert-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dollarPath = path.join(directory, "dollar-expanded");
  const backtickPath = path.join(directory, "backtick-expanded");
  const historyPath = path.join(directory, "history-expanded");
  const separatorPath = path.join(directory, "separator-expanded");
  const inbound = message(
    "101.000002",
    "U_OWNER",
    `$(touch ${dollarPath}) \`touch ${backtickPath}\` !touch ${historyPath} \"; touch ${separatorPath}; echo \"`,
  );
  const prompt = formatAgentPrompt(fixture.store.get(fixture.session.id), inbound);
  assert.match(prompt, /^# \[SLACK_AGENT_SESSION_EVENT v1\] /);
  assert.doesNotMatch(prompt, /\$|`|!/);

  const shell = fs.existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/sh";
  const args = shell.endsWith("/zsh") ? ["-f", "-i"] : [];
  const executed = spawnSync(shell, args, {
    input: `${shell.endsWith("/zsh") ? "unsetopt interactivecomments\n" : ""}${prompt}\nexit\n`,
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(executed.signal, null);
  assert.equal(fs.existsSync(dollarPath), false);
  assert.equal(fs.existsSync(backtickPath), false);
  assert.equal(fs.existsSync(historyPath), false);
  assert.equal(fs.existsSync(separatorPath), false);
  const envelope = JSON.parse(prompt.slice(EVENT_SENTINEL.length + 1));
  assert.equal(envelope.text, inbound.text);
});

test("lifecycle cancellation releases a runtime whose Slack poll never resolves", async () => {
  const fixture = setup([]);
  const lifecycle = new AbortController();
  let receivedPollSignal = null;
  let markPollStarted;
  const pollStarted = new Promise((resolve) => {
    markPollStarted = resolve;
  });
  fixture.slack.poll = async (session, { signal } = {}) => {
    receivedPollSignal = signal;
    markPollStarted();
    return new Promise(() => {});
  };
  fixture.runtime.startBridge = async () => {
    fixture.store.update(fixture.session.id, (session) => {
      session.bridge = { host: "127.0.0.1", port: 1234, url: "http://127.0.0.1:1234" };
      return session;
    });
  };
  fixture.runtime.stopBridge = async () => {
    fixture.store.update(fixture.session.id, (session) => {
      session.bridge = { host: "127.0.0.1", port: null, url: null };
      return session;
    });
  };

  const running = fixture.runtime.run({ signal: lifecycle.signal });
  await within(250, pollStarted);
  fixture.store.update(fixture.session.id, (session) => {
    session.status = "stopped";
    session.stoppedAt = new Date().toISOString();
    return session;
  });
  lifecycle.abort();

  const completed = await within(250, running);
  assert.equal(receivedPollSignal.aborted, true);
  assert.equal(completed.status, "stopped");
  assert.equal(completed.pid, null);
  assert.equal(completed.bridge.port, null);
  assert.equal(
    fixture.store.readEvents(fixture.session.id)
      .some((event) => event.type === "poll_failed"),
    false,
  );
  const release = fixture.store.acquireRunLock(fixture.session.id);
  release();
});

test("SIGHUP gracefully cancels polling and releases the runtime lock", async () => {
  const fixture = setup([]);
  let receivedPollSignal = null;
  let markPollStarted;
  const pollStarted = new Promise((resolve) => {
    markPollStarted = resolve;
  });
  fixture.slack.poll = async (session, { signal } = {}) => {
    receivedPollSignal = signal;
    markPollStarted();
    return new Promise(() => {});
  };
  fixture.runtime.startBridge = async () => {
    fixture.store.update(fixture.session.id, (session) => {
      session.bridge = { host: "127.0.0.1", port: 1234, url: "http://127.0.0.1:1234" };
      return session;
    });
  };
  fixture.runtime.stopBridge = async () => {
    fixture.store.update(fixture.session.id, (session) => {
      session.bridge = { host: "127.0.0.1", port: null, url: null };
      return session;
    });
  };

  const running = fixture.runtime.run();
  await within(250, pollStarted);
  process.emit("SIGHUP");

  const completed = await within(250, running);
  assert.equal(receivedPollSignal.aborted, true);
  assert.equal(completed.status, "runtime_exited");
  assert.equal(completed.pid, null);
  assert.equal(completed.bridge.port, null);
  const release = fixture.store.acquireRunLock(fixture.session.id);
  release();
});

test("a superseded runtime cannot overwrite or clear the newer launch state", async () => {
  const fixture = setup([]);
  fixture.store.update(fixture.session.id, (session) => {
    session.runtimeInstanceId = "runtime_old";
    return session;
  });
  fixture.runtime.runtimeInstanceId = "runtime_old";
  fixture.runtime.provider.verify = () => {
    fixture.store.update(fixture.session.id, (session) => {
      session.runtimeInstanceId = "runtime_new";
      session.pid = 7777;
      session.host.pid = 7777;
      session.bridge = {
        host: "127.0.0.1",
        port: 9777,
        url: "http://127.0.0.1:9777",
      };
      return session;
    });
  };

  await assert.rejects(
    fixture.runtime.run(),
    /was superseded/,
  );

  const current = fixture.store.get(fixture.session.id, { includeSecret: true });
  assert.equal(current.runtimeInstanceId, "runtime_new");
  assert.equal(current.status, "active");
  assert.equal(current.pid, 7777);
  assert.equal(current.host.pid, 7777);
  assert.equal(current.bridge.port, 9777);
  assert.equal(
    fixture.store.readEvents(fixture.session.id)
      .some((event) => event.type === "runtime_stopped" && event.superseded === true),
    true,
  );
});

test("unexpected runtime failure leaves no dead listener in active session lists", async () => {
  const fixture = setup([]);
  fixture.runtime.provider.verify = () => {
    throw new Error("provider disappeared");
  };

  await assert.rejects(
    fixture.runtime.run({ once: true }),
    /provider disappeared/,
  );

  const failed = fixture.store.get(fixture.session.id);
  assert.equal(failed.status, "runtime_failed");
  assert.equal(failed.pid, null);
  assert.deepEqual(fixture.store.list({ includeStopped: false }), []);
});

test("lifecycle cancellation interrupts a post-poll reaction that never resolves", async () => {
  const fixture = setup([message("101.000001", "U_OWNER", "react then stop")]);
  const lifecycle = new AbortController();
  let reactionSignal = null;
  let markReactionStarted;
  const reactionStarted = new Promise((resolve) => {
    markReactionStarted = resolve;
  });
  fixture.slack.react = async (session, messageTs, emoji, { signal } = {}) => {
    reactionSignal = signal;
    markReactionStarted();
    return new Promise(() => {});
  };

  const running = fixture.runtime.run({ once: true, signal: lifecycle.signal });
  await within(250, reactionStarted);
  fixture.store.update(fixture.session.id, (session) => {
    session.status = "stopped";
    session.stoppedAt = new Date().toISOString();
    return session;
  });
  lifecycle.abort();

  const completed = await within(250, running);
  assert.equal(reactionSignal.aborted, true);
  assert.equal(completed.status, "stopped");
  assert.equal(completed.pid, null);
});

test("a never-resolving Slack poll is bounded by the poll deadline", async () => {
  const fixture = setup([], {}, { pollTimeoutMs: 25 });
  let receivedPollSignal = null;
  fixture.slack.poll = async (session, { signal } = {}) => {
    receivedPollSignal = signal;
    return new Promise(() => {});
  };

  await assert.rejects(
    within(250, fixture.runtime.runOnce()),
    /Slack poll .* timed out after 25ms/,
  );
  assert.equal(receivedPollSignal.aborted, true);
});

test("owner input injects, collaborators queue, and unknown users are rejected", async () => {
  const fixture = setup([
    message("100.000001", "U_OWNER", "root"),
    message("101.000001", "U_OWNER", "do the work"),
    message("102.000001", "U_COLLAB", "  also check tests 👩‍💻  "),
    message("103.000001", "U_UNKNOWN", "delete everything"),
  ]);
  const result = await fixture.runtime.runOnce();
  const session = fixture.store.get(fixture.session.id);
  assert.equal(result.processed, 3);
  assert.equal(session.injectedCount, 1);
  assert.equal(session.pending.length, 1);
  assert.equal(session.rejectedCount, 1);
  assert.equal(session.cursorTs, "103.000001");
  assert.equal(session.lastReceived.messageTs, "103.000001");
  assert.equal(session.lastReceived.disposition, "observed");
  assert.equal(fixture.provider.injections.length, 1);
  assert.match(fixture.provider.injections[0], /do the work/);

  await fixture.runtime.approve(session.pending[0].id);
  const approved = fixture.store.get(session.id);
  assert.equal(approved.pending.length, 0);
  assert.equal(approved.cursorTs, "103.000001");
  assert.equal(fixture.provider.injections.length, 2);
  const approvedPrompt = fixture.provider.injections[1];
  const approvedEnvelope = JSON.parse(
    approvedPrompt.slice(EVENT_SENTINEL.length + 1),
  );
  assert.equal(approvedEnvelope.text, "  also check tests 👩‍💻  ");
  assert.equal(fixture.reactions.filter((reaction) => reaction.emoji === "eyes").length, 2);
});

test("injection is durably claimed before provider mutation and confirmed afterward", async () => {
  const fixture = setup([message("101.000001", "U_OWNER", "claim then inject")]);

  await fixture.runtime.runOnce();

  const session = fixture.store.get(fixture.session.id);
  const event = session.inboundEvents[0];
  assert.equal(event.injectionState, "injected");
  assert.match(event.injectionAttemptId, /^[0-9a-f-]{36}$/);
  assert.ok(event.injectionClaimedAt);
  assert.ok(event.injectionConfirmedAt);
  const audits = fixture.store.readEvents(fixture.session.id);
  const claimedIndex = audits.findIndex((audit) => audit.type === "message_injection_claimed");
  const injectedIndex = audits.findIndex((audit) => audit.type === "message_injected");
  assert.ok(claimedIndex >= 0);
  assert.ok(injectedIndex > claimedIndex);
  assert.equal(audits[claimedIndex].injectionAttemptId, event.injectionAttemptId);
  assert.equal(Object.hasOwn(audits[claimedIndex], "text"), false);
});

test("ambiguous provider mutation is quarantined and never injected again", async () => {
  const inbound = message("101.000001", "U_OWNER", "do this only once");
  const fixture = setup([inbound]);
  let providerCalls = 0;
  fixture.runtime.provider.inject = () => {
    providerCalls += 1;
    throw new Error(`terminal may have accepted sensitive text: ${inbound.text}`);
  };

  await assert.rejects(
    fixture.runtime.runOnce(),
    (error) => {
      assert.match(error.message, /Injection outcome .* is uncertain.*automatic retry refused/);
      assert.doesNotMatch(error.message, /do this only once/);
      return true;
    },
  );

  let session = fixture.store.get(fixture.session.id);
  const event = session.inboundEvents[0];
  assert.equal(providerCalls, 1);
  assert.equal(event.injectionState, "uncertain");
  assert.equal(event.state, "injection_uncertain");
  assert.ok(event.injectionUncertainAt);
  assert.equal(session.cursorTs, inbound.ts);
  assert.equal(session.injectedCount, 0);
  assert.equal(session.lastInjectedAt, null);
  assert.deepEqual(session.awaitingAcknowledgementTs, []);
  assert.deepEqual(fixture.reactions, []);

  await fixture.runtime.runOnce();
  assert.equal(providerCalls, 1);

  fixture.store.update(fixture.session.id, (latest) => {
    latest.cursorTs = latest.slack.threadTs;
    return latest;
  });
  await fixture.runtime.runOnce();
  session = fixture.store.get(fixture.session.id);
  assert.equal(providerCalls, 1);
  assert.equal(session.inboundEvents[0].injectionState, "uncertain");
  const audits = fixture.store.readEvents(fixture.session.id);
  assert.equal(
    audits.filter((audit) => audit.type === "message_injection_claimed").length,
    1,
  );
  assert.equal(
    audits.filter((audit) => audit.type === "message_injection_uncertain").length,
    1,
  );
  assert.equal(
    audits.filter((audit) => (
      audit.type === "message_injection_quarantined"
      && audit.reason === "existing_injection_attempt"
    )).length,
    1,
  );
  assert.equal(
    audits.some((audit) => Object.hasOwn(audit, "text")),
    false,
  );
  assert.doesNotMatch(JSON.stringify(audits), /do this only once/);

  await assert.rejects(
    fixture.runtime.respond("unsafe completion", {
      send: true,
      eventId: event.id,
      status: "complete",
    }),
    /was not safely injected.*uncertain.*response refused/,
  );
  assert.deepEqual(fixture.replies, []);
});

test("a response cannot invent an event that was never safely injected", async () => {
  const fixture = setup([]);

  await assert.rejects(
    fixture.runtime.respond("must not post", {
      send: true,
      eventId: "evt_not_injected",
      status: "complete",
    }),
    /Inbound event not found: evt_not_injected.*not safely confirmed as injected/,
  );

  assert.deepEqual(fixture.replies, []);
  assert.deepEqual(
    fixture.store.get(fixture.session.id).outboundDeliveries,
    [],
  );
});

test("a runtime start reconciles a crash-left injection claim to uncertain before polling", async () => {
  const inbound = message("101.000001", "U_OWNER", "crash boundary");
  const fixture = setup(
    [],
    { runtimeInstanceId: "runtime_before_crash" },
    { runtimeInstanceId: "runtime_before_crash" },
  );
  const session = fixture.store.get(fixture.session.id, { includeSecret: true });
  const eventId = sessionEventId(session, inbound);
  fixture.runtime.claimInboundInjection(session, inbound, eventId);

  fixture.runtime.runtimeInstanceId = "runtime_after_crash";
  fixture.store.update(fixture.session.id, (latest) => {
    latest.runtimeInstanceId = "runtime_after_crash";
    return latest;
  });
  fixture.slack.poll = async () => {
    const current = fixture.store.get(fixture.session.id);
    assert.equal(current.inboundEvents[0].injectionState, "uncertain");
    return { messages: [], pages: [{ ok: true }] };
  };

  await fixture.runtime.run({ once: true });

  const reconciled = fixture.store.get(fixture.session.id);
  assert.equal(reconciled.inboundEvents[0].injectionState, "uncertain");
  assert.equal(reconciled.inboundEvents[0].state, "injection_uncertain");
  assert.equal(reconciled.injectedCount, 0);
  assert.deepEqual(fixture.provider.injections, []);
  const audit = fixture.store.readEvents(fixture.session.id)
    .find((candidate) => (
      candidate.type === "message_injection_uncertain"
      && candidate.reason === "runtime_started_with_unresolved_injection_claim"
    ));
  assert.equal(audit.eventId, eventId);
  assert.equal(Object.hasOwn(audit, "text"), false);
});

test("an ambiguous approved injection is removed from pending and cannot be approved twice", async () => {
  const fixture = setup([message("101.000001", "U_COLLAB", "collaborator work")]);
  await fixture.runtime.runOnce();
  const pendingId = fixture.store.get(fixture.session.id).pending[0].id;
  let providerCalls = 0;
  fixture.runtime.provider.inject = () => {
    providerCalls += 1;
    throw new Error("approval injection outcome unknown");
  };

  await assert.rejects(
    fixture.runtime.approve(pendingId),
    /Injection outcome .* is uncertain.*automatic retry refused/,
  );
  let session = fixture.store.get(fixture.session.id);
  assert.equal(session.pending.length, 0);
  assert.equal(session.inboundEvents[0].injectionState, "uncertain");
  await assert.rejects(fixture.runtime.approve(pendingId), /Pending message not found/);
  session = fixture.store.get(fixture.session.id);
  assert.equal(providerCalls, 1);
  assert.equal(session.inboundEvents[0].injectionState, "uncertain");
});

test("paused sessions keep polling controls and queue normal input", async () => {
  const fixture = setup([
    message("101.000001", "U_OWNER", "hold this"),
    message("102.000001", "U_OWNER", "!session resume"),
    message("103.000001", "U_OWNER", "continue"),
  ]);
  fixture.store.update(fixture.session.id, (session) => {
    session.status = "paused";
    return session;
  });
  await fixture.runtime.runOnce();
  const session = fixture.store.get(fixture.session.id);
  assert.equal(session.status, "active");
  assert.equal(session.pending.length, 1);
  assert.equal(session.injectedCount, 1);
  assert.match(fixture.provider.injections[0], /continue/);
});

test("outbound response timestamps are ignored on the next poll", async () => {
  const fixture = setup([message("999.000001", "U_OWNER", "agent response")]);
  await fixture.runtime.respond("agent response", { send: true });
  await fixture.runtime.runOnce();
  assert.equal(fixture.provider.injections.length, 0);
  assert.equal(fixture.store.get(fixture.session.id).cursorTs, "999.000001");
  const observed = fixture.store.readEvents(fixture.session.id)
    .find((event) => event.type === "outbound_delivery_observed");
  assert.equal(observed.direction, "outbound");
  assert.equal(observed.reason, "self_authored");
  assert.equal(observed.fingerprintsMatch, false);
  assert.equal(observed.normalizationResult, "different");
  assert.match(observed.responseId, /^resp_/);
});

test("Slack-normalized outbound text remains quarantined and reports normalized matching", async () => {
  const fixture = setup([message("999.000001", "U_OWNER", ":robot_face: Done.  ")]);
  await fixture.runtime.respond("Done.", { send: true });
  await fixture.runtime.runOnce();

  assert.equal(fixture.provider.injections.length, 0);
  const observed = fixture.store.readEvents(fixture.session.id)
    .find((event) => event.type === "outbound_delivery_observed");
  assert.equal(observed.fingerprintsMatch, false);
  assert.equal(observed.normalizationResult, "normalized_match");
  assert.equal(
    fixture.store.get(fixture.session.id).lastOutboundObserved.responseId,
    observed.responseId,
  );
});

test("exact outbound text is quarantined with an exact fingerprint match", async () => {
  const fixture = setup([message("999.000001", "U_OWNER", ":robot_face: Done.")]);
  await fixture.runtime.respond("Done.", { send: true });
  await fixture.runtime.runOnce();

  assert.equal(fixture.provider.injections.length, 0);
  const observed = fixture.store.readEvents(fixture.session.id)
    .find((event) => event.type === "outbound_delivery_observed");
  assert.equal(observed.fingerprintsMatch, true);
  assert.equal(observed.normalizationResult, "exact");
});

test("outbound quarantine tracks Slack's canonical message timestamp", async () => {
  const fixture = setup([]);
  fixture.slack.reply = async () => ({
    ok: true,
    mode: "sent",
    sent: true,
    ts: "998.000001",
    messageTs: "999.000001",
  });
  await fixture.runtime.respond("Canonical timestamp.", { send: true });
  const session = fixture.store.get(fixture.session.id);
  assert.deepEqual(session.outboundTs, ["999.000001"]);
  assert.equal(session.outboundDeliveries[0].messageTs, "999.000001");
});

test("empty, bot, and system events are audited and cursor-advanced without injection", async () => {
  const fixture = setup([
    message("101.000001", "U_OWNER", ""),
    message("102.000001", "U_OWNER", " \n\t "),
    { ...message("103.000001", "U_OWNER", "!session stop"), subtype: "bot_message", bot_id: "B1" },
    { ...message("104.000001", "U_OWNER", "edited"), subtype: "message_changed" },
    { ...message("105.000001", "", "system output"), user: undefined },
    { ...message("106.000001", "U_OWNER", "real text"), subtype: "thread_broadcast" },
    message("107.000001", "U_OWNER", "!session pause"),
  ]);

  const result = await fixture.runtime.runOnce();
  const session = fixture.store.get(fixture.session.id);
  const skipped = fixture.store.readEvents(session.id).filter((event) => event.type === "message_skipped");

  assert.equal(result.processed, 7);
  assert.equal(session.injectedCount, 1);
  assert.equal(session.cursorTs, "107.000001");
  assert.equal(session.lastInjectedTs, "106.000001");
  assert.equal(session.lastReceived.messageTs, "107.000001");
  assert.equal(session.lastReceived.disposition, "observed");
  assert.ok(session.lastInjectedAt);
  assert.ok(session.listenerCursorAt);
  assert.deepEqual(session.recentInjectedTs, ["106.000001"]);
  assert.equal(session.status, "paused");
  assert.equal(fixture.provider.injections.length, 1);
  assert.match(fixture.provider.injections[0], /real text/);
  assert.equal(skipped.length, 5);
  assert.deepEqual(
    [...new Set(skipped.map((event) => event.reason))].sort(),
    ["empty_message", "missing_user", "non_user_authored"],
  );
  assert.deepEqual(
    fixture.reactions.map((reaction) => [reaction.messageTs, reaction.emoji]),
    [["106.000001", "eyes"]],
  );
});

test("Slack-sized input is preserved while oversized input is skipped without truncation", async () => {
  const acceptedText = ` ${"😀".repeat(39_998)} `;
  const oversizedText = "😀".repeat(40_001);
  const fixture = setup([
    message("101.000001", "U_OWNER", acceptedText),
    message("102.000001", "U_OWNER", oversizedText),
  ]);

  await fixture.runtime.runOnce();

  const session = fixture.store.get(fixture.session.id);
  assert.equal(session.injectedCount, 1);
  assert.equal(session.cursorTs, "102.000001");
  assert.equal(session.lastInjectedTs, "101.000001");
  assert.equal(session.lastReceived.messageTs, "102.000001");
  assert.equal(session.lastReceived.disposition, "skipped");
  assert.equal(session.lastReceived.skipReason, "message_too_large");
  assert.equal(fixture.provider.injections.length, 1);
  const envelope = JSON.parse(
    fixture.provider.injections[0].slice(EVENT_SENTINEL.length + 1),
  );
  assert.equal(envelope.text, acceptedText);
  assert.equal([...envelope.text].length, 40_000);
  const skipped = fixture.store.readEvents(session.id)
    .find((event) => (
      event.type === "message_skipped"
      && event.messageTs === "102.000001"
    ));
  assert.equal(skipped.reason, "message_too_large");
  assert.equal(fixture.reactions.length, 1);
});

test("four replies across polls expose cursor progress separately from successful injection", async () => {
  const messages = [
    message("100.000001", "U_OWNER", "root"),
    message("101.000001", "U_OWNER", "one"),
    message("102.000001", "U_OWNER", "two"),
  ];
  const fixture = setup(messages);

  await fixture.runtime.runOnce();
  const midPoll = await sessionCommand(
    ["show", "--id", fixture.session.id, "--state-dir", fixture.store.baseDir],
    { store: fixture.store },
  );
  assert.equal(midPoll.session.cursorTs, "102.000001");
  assert.equal(midPoll.session.lastInjectedTs, "102.000001");
  assert.equal(midPoll.session.injectedCount, 2);

  messages.push(
    message("103.000001", "U_OWNER", "three"),
    message("104.000001", "U_OWNER", "four"),
  );
  await fixture.runtime.runOnce();
  const completed = fixture.store.get(fixture.session.id);
  assert.equal(completed.cursorTs, "104.000001");
  assert.equal(completed.lastInjectedTs, "104.000001");
  assert.equal(completed.injectedCount, 4);
  assert.deepEqual(completed.recentInjectedTs, [
    "101.000001",
    "102.000001",
    "103.000001",
    "104.000001",
  ]);
});

test("outstanding acknowledgement events are retained beyond the completed-history cap", async () => {
  const messages = Array.from({ length: 101 }, (_, index) => (
    message(`${101 + index}.000001`, "U_OWNER", `work ${index}`)
  ));
  const fixture = setup(messages);
  await fixture.runtime.runOnce();
  const session = fixture.store.get(fixture.session.id);
  assert.equal(session.inboundEvents.length, 101);
  assert.equal(session.awaitingAcknowledgementTs.length, 101);
  assert.equal(session.inboundEvents.every((event) => !event.completedAt), true);
});

test("injection-to-acknowledgement timing includes synchronous provider delivery delay", async () => {
  let now = Date.parse("2026-07-27T12:00:00.000Z");
  const fixture = setup(
    [message("101.000001", "U_OWNER", "measure injection")],
    {},
    { now: () => now },
  );
  fixture.runtime.provider.inject = () => {
    now += 5_000;
    return { ok: true };
  };
  await fixture.runtime.runOnce();
  const event = fixture.store.get(fixture.session.id).inboundEvents[0];
  assert.equal(event.injectedToAcknowledgedMs, 5_000);
});

test("accepted work gets eyes and a sent robot-prefixed reply transitions it to complete", async () => {
  const fixture = setup([message("101.000001", "U_OWNER", "do the work")]);

  await fixture.runtime.runOnce();
  assert.deepEqual(
    fixture.reactions.map((reaction) => [reaction.messageTs, reaction.emoji, reaction.add, reaction.mode]),
    [["101.000001", "eyes", true, "added"]],
  );

  await fixture.runtime.respond("Done.", { send: true });
  assert.equal(fixture.replies[0].text, ":robot_face: Done.");
  assert.deepEqual(
    fixture.reactions.map((reaction) => [reaction.emoji, reaction.add, reaction.mode]),
    [
      ["eyes", true, "added"],
      ["eyes", false, "removed"],
      ["white_check_mark", true, "added"],
    ],
  );
  assert.deepEqual(fixture.store.get(fixture.session.id).awaitingAcknowledgementTs, []);
  assert.equal(fixture.reactionState.has("101.000001:eyes"), false);
  assert.equal(fixture.reactionState.has("101.000001:white_check_mark"), true);
});

test("fake clock drives one idempotent eyes to hourglass to complete progression", async () => {
  let currentTime = Date.parse("2026-07-27T12:00:00.000Z");
  const fixture = setup(
    [message("101.000001", "U_OWNER", "long-running work")],
    {},
    { now: () => currentTime },
  );

  await fixture.runtime.runOnce();
  const eventId = fixture.store.get(fixture.session.id).inboundEvents[0].id;
  currentTime += 31_000;
  await fixture.runtime.runOnce();
  await fixture.runtime.runOnce();

  assert.deepEqual(
    fixture.reactions.map((reaction) => [reaction.emoji, reaction.add]),
    [
      ["eyes", true],
      ["eyes", false],
      ["hourglass_flowing_sand", true],
    ],
  );
  const warning = fixture.store.readEvents(fixture.session.id)
    .filter((event) => event.type === "slow_first_response_warning");
  assert.equal(warning.length, 1);
  assert.equal(warning[0].injectedToFirstResponseMs, 31_000);
  assert.equal("text" in warning[0], false);

  await fixture.runtime.respond("Finished.", { send: true, eventId, status: "complete" });
  assert.deepEqual(
    fixture.reactions.slice(-3).map((reaction) => [reaction.emoji, reaction.add]),
    [
      ["eyes", false],
      ["hourglass_flowing_sand", false],
      ["white_check_mark", true],
    ],
  );
  const completed = fixture.store.get(fixture.session.id);
  assert.equal(completed.timings.injectedToFirstResponseMs, 31_000);
  assert.equal(completed.inboundEvents[0].state, "complete");
});

test("slow-response warnings are audited once when the progress reaction fails", async () => {
  let now = Date.parse("2026-07-27T12:00:00.000Z");
  const fixture = setup(
    [message("101.000001", "U_OWNER", "slow failure")],
    {},
    { now: () => now },
  );
  await fixture.runtime.runOnce();
  const originalReact = fixture.slack.react;
  fixture.slack.react = async (...args) => {
    if (args[2] === "hourglass_flowing_sand") throw new Error("reaction unavailable");
    return originalReact(...args);
  };
  now += 31_000;
  await fixture.runtime.markSlowAcknowledgements();
  await fixture.runtime.markSlowAcknowledgements();
  const warnings = fixture.store.readEvents(fixture.session.id)
    .filter((event) => event.type === "slow_first_response_warning");
  assert.equal(warnings.length, 1);
});

test("correlated response completes only the selected inbound event", async () => {
  const fixture = setup([
    message("101.000001", "U_OWNER", "first"),
    message("102.000001", "U_OWNER", "second"),
  ]);
  await fixture.runtime.runOnce();
  const [first, second] = fixture.store.get(fixture.session.id).inboundEvents;

  await assert.rejects(
    fixture.runtime.respond("Ambiguous completion.", { send: true }),
    /pass --event/,
  );
  assert.equal(fixture.replies.length, 0);

  await fixture.runtime.respond("First done.", {
    send: true,
    eventId: first.id,
    status: "complete",
  });
  const current = fixture.store.get(fixture.session.id);
  assert.equal(current.inboundEvents.find((event) => event.id === first.id).state, "complete");
  assert.equal(current.inboundEvents.find((event) => event.id === second.id).completedAt, null);
  assert.deepEqual(current.awaitingAcknowledgementTs, [second.messageTs]);
});

test("status controls do not complete unrelated outstanding work", async () => {
  const fixture = setup([
    message("101.000001", "U_OWNER", "keep working"),
    message("102.000001", "U_OWNER", "!session status"),
  ]);
  await fixture.runtime.runOnce();
  const session = fixture.store.get(fixture.session.id);
  assert.equal(fixture.replies.length, 1);
  assert.equal(session.inboundEvents[0].completedAt, null);
  assert.deepEqual(session.awaitingAcknowledgementTs, ["101.000001"]);
});

test("dry-run progress does not block a later live progress transition", async () => {
  const fixture = setup([message("101.000001", "U_OWNER", "long work")]);
  await fixture.runtime.runOnce();
  const eventId = fixture.store.get(fixture.session.id).inboundEvents[0].id;

  await fixture.runtime.respond("", { send: false, eventId, status: "progress" });
  assert.equal(fixture.store.get(fixture.session.id).inboundEvents[0].progressAt, null);

  await fixture.runtime.respond("", { send: true, eventId, status: "progress" });
  const progressed = fixture.store.get(fixture.session.id).inboundEvents[0];
  assert.ok(progressed.progressAt);
  assert.equal(progressed.state, "in_progress");
  assert.equal(fixture.reactions.filter((reaction) => (
    reaction.emoji === "hourglass_flowing_sand" && reaction.mode === "added"
  )).length, 1);
});

test("a sent reply completes state even when its completion reaction fails", async () => {
  const fixture = setup([message("101.000001", "U_OWNER", "finish once")]);
  let now = Date.parse("2026-07-27T12:00:00.000Z");
  fixture.runtime.now = () => now;
  await fixture.runtime.runOnce();
  const eventId = fixture.store.get(fixture.session.id).inboundEvents[0].id;
  const originalReact = fixture.slack.react;
  fixture.slack.react = async (...args) => {
    if (args[2] === "white_check_mark" && args[3]?.add) {
      throw new Error("reaction network failure");
    }
    return originalReact(...args);
  };

  await fixture.runtime.respond("Done once.", { send: true, eventId });
  const completed = fixture.store.get(fixture.session.id);
  const originalSentAt = completed.lastSent.sentAt;
  assert.equal(completed.inboundEvents[0].state, "complete");
  assert.deepEqual(completed.awaitingAcknowledgementTs, []);
  now += 60_000;
  const idempotent = await fixture.runtime.respond("Done once.", {
    send: true,
    eventId,
  });
  assert.equal(idempotent.mode, "already-delivered");
  assert.equal(fixture.replies.length, 1);
  assert.equal(fixture.store.get(fixture.session.id).lastSent.sentAt, originalSentAt);
  await assert.rejects(
    fixture.runtime.respond("Do not duplicate.", { send: true, eventId }),
    /already has a final response/,
  );
  await assert.rejects(
    fixture.runtime.respond("Done once.", {
      send: true,
      eventId,
      status: "error",
    }),
    /status and response text cannot be changed/,
  );
  assert.equal(fixture.replies.length, 1);
});

test("ambiguous delivery retries reuse a persisted Slack client message id", async () => {
  const fixture = setup([message("101.000001", "U_OWNER", "retry safely")]);
  await fixture.runtime.runOnce();
  const eventId = fixture.store.get(fixture.session.id).inboundEvents[0].id;
  const originalReply = fixture.slack.reply;
  const clientMessageIds = [];
  let attempt = 0;
  fixture.slack.reply = async (...args) => {
    attempt += 1;
    clientMessageIds.push(args[2].clientMessageId);
    if (attempt === 1) throw new Error("ambiguous timeout");
    return originalReply(...args);
  };

  await assert.rejects(
    fixture.runtime.respond("Idempotent.", { send: true, eventId }),
    /ambiguous timeout/,
  );
  await fixture.runtime.respond("Idempotent.", { send: true, eventId });
  assert.equal(clientMessageIds.length, 2);
  assert.equal(clientMessageIds[0], clientMessageIds[1]);
  assert.match(clientMessageIds[0], /^[a-f0-9-]{36}$/);
  const [delivery] = fixture.store.get(fixture.session.id).outboundDeliveries;
  assert.equal(delivery.attempts, 2);
  assert.equal(delivery.deliveryState, "sent");
});

test("outbound delivery retention caps only safely observed terminal history", () => {
  const observed = Array.from({ length: 205 }, (_, index) => ({
    responseId: `resp_observed_${index}`,
    deliveryState: "observed",
    messageTs: `${200 + index}.000001`,
    observedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  }));
  const outstanding = Array.from({ length: 205 }, (_, index) => ({
    responseId: `resp_outstanding_${index}`,
    deliveryState: ["posting", "ambiguous", "sent", "delivered"][index % 4],
    messageTs: index % 2 === 0 ? `${500 + index}.000001` : null,
    observedAt: null,
  }));

  const retained = retainOutboundDeliveries([...observed, ...outstanding]);

  assert.equal(retained.length, 405);
  assert.deepEqual(
    retained.filter((delivery) => delivery.deliveryState === "observed")
      .map((delivery) => delivery.responseId),
    observed.slice(-200).map((delivery) => delivery.responseId),
  );
  assert.deepEqual(
    retained.filter((delivery) => delivery.deliveryState !== "observed")
      .map((delivery) => delivery.responseId),
    outstanding.map((delivery) => delivery.responseId),
  );
});

test("a sent delivery beyond the outbound timestamp cap remains quarantined", async () => {
  const fixture = setup([]);
  const oldestTs = "101.000001";
  const oldestText = ":robot_face: Old retained response.";
  const sentAt = "2026-07-27T12:00:00.000Z";
  const deliveries = Array.from({ length: 201 }, (_, index) => {
    const messageTs = `${101 + index}.000001`;
    const text = index === 0 ? oldestText : `:robot_face: Seed response ${index}.`;
    const fingerprint = textFingerprint(text);
    return {
      responseId: `resp_seed_${index}`,
      clientMessageId: `client_seed_${index}`,
      correlationId: null,
      status: "complete",
      deliveryState: "sent",
      attempts: 1,
      messageTs,
      preparedAt: sentAt,
      sentAt,
      preparedFingerprint: fingerprint,
      preparedNormalizedFingerprint: fingerprint,
      observedAt: null,
      observedFingerprint: null,
      fingerprintsMatch: null,
      normalizationResult: null,
    };
  });
  fixture.store.update(fixture.session.id, (session) => {
    session.outboundDeliveries = deliveries;
    session.outboundTs = deliveries.map((delivery) => delivery.messageTs).slice(-200);
    return session;
  });

  await fixture.runtime.respond("Newest response.", {
    send: true,
    correlate: false,
  });
  let current = fixture.store.get(fixture.session.id);
  assert.equal(current.outboundTs.includes(oldestTs), false);
  assert.ok(current.outboundDeliveries.some((delivery) => (
    delivery.messageTs === oldestTs
  )));

  fixture.slack.poll = async () => ({
    messages: [message(oldestTs, "U_OWNER", oldestText)],
    pages: [{ ok: true }],
  });
  await fixture.runtime.runOnce();

  current = fixture.store.get(fixture.session.id);
  const oldest = current.outboundDeliveries.find((delivery) => (
    delivery.messageTs === oldestTs
  ));
  assert.equal(fixture.provider.injections.length, 0);
  assert.equal(oldest.deliveryState, "observed");
  assert.ok(oldest.observedAt);
  assert.equal(current.outboundTs.includes(oldestTs), true);
  assert.equal(current.cursorTs, oldestTs);
});

test("concurrent processes atomically claim one final Slack delivery", async () => {
  const fixture = setup([message("101.000001", "U_OWNER", "finish concurrently")]);
  await fixture.runtime.runOnce();
  const eventId = fixture.store.get(fixture.session.id).inboundEvents[0].id;
  const callLog = path.join(fixture.store.baseDir, "response-calls.log");

  const results = await Promise.all([
    runResponseWorker(
      fixture.store.baseDir,
      fixture.session.id,
      eventId,
      callLog,
    ),
    runResponseWorker(
      fixture.store.baseDir,
      fixture.session.id,
      eventId,
      callLog,
    ),
  ]);

  assert.equal(fs.readFileSync(callLog, "utf8").trim().split("\n").length, 1);
  assert.equal(results.filter((result) => result.mode === "sent").length, 1);
  assert.equal(
    results.filter((result) => ["in-flight", "already-delivered"].includes(result.mode)).length,
    1,
  );
  const current = fixture.store.get(fixture.session.id);
  assert.equal(current.outboundDeliveries.length, 1);
  assert.equal(current.inboundEvents[0].state, "complete");
});

test("an ambiguous post observed by client_msg_id is quarantined and completes the event", async () => {
  const fixture = setup([message("101.000001", "U_OWNER", "recover the response")]);
  await fixture.runtime.runOnce();
  const eventId = fixture.store.get(fixture.session.id).inboundEvents[0].id;
  let clientMessageId = null;
  let postCalls = 0;
  fixture.slack.reply = async (session, text, options) => {
    postCalls += 1;
    clientMessageId = options.clientMessageId;
    throw new Error("response timed out after Slack accepted it");
  };

  await assert.rejects(
    fixture.runtime.respond("Recovered.", { send: true, eventId }),
    /timed out/,
  );
  fixture.slack.poll = async () => ({
    messages: [{
      ts: "102.000001",
      thread_ts: "100.000001",
      user: "U_OWNER",
      username: "U_OWNER",
      text: ":robot_face: Recovered.",
      client_msg_id: clientMessageId,
    }],
    pages: [{ ok: true }],
  });
  await fixture.runtime.runOnce();

  const recovered = fixture.store.get(fixture.session.id);
  assert.equal(postCalls, 1);
  assert.equal(fixture.provider.injections.length, 1);
  assert.deepEqual(recovered.outboundTs, ["102.000001"]);
  assert.equal(recovered.outboundDeliveries[0].deliveryState, "observed");
  assert.equal(recovered.outboundDeliveries[0].messageTs, "102.000001");
  assert.equal(recovered.lastSent.clientMessageId, clientMessageId);
  assert.equal(recovered.lastSent.messageTs, "102.000001");
  assert.equal(recovered.inboundEvents[0].state, "complete");
  assert.deepEqual(recovered.awaitingAcknowledgementTs, []);
  const observed = fixture.store.readEvents(fixture.session.id)
    .find((event) => event.type === "outbound_delivery_observed");
  assert.equal(observed.recoveredByClientMessageId, true);

  const retry = await fixture.runtime.respond("Recovered.", { send: true, eventId });
  assert.equal(retry.mode, "already-delivered");
  assert.equal(postCalls, 1);
});

test("response-disabled sessions remain dry-run even when a caller passes --send", async () => {
  const fixture = setup(
    [message("101.000001", "U_OWNER", "plan this")],
    { sendResponses: false },
  );

  await fixture.runtime.runOnce();
  const event = fixture.store.get(fixture.session.id).inboundEvents[0];
  const prompt = formatAgentPrompt(
    fixture.store.get(fixture.session.id),
    message("101.000001", "U_OWNER", "plan this"),
    event.id,
  );
  const envelope = JSON.parse(prompt.slice(EVENT_SENTINEL.length + 1));
  assert.equal(envelope.response.sendEnabled, false);
  assert.doesNotMatch(envelope.response.completeCommand, /--send$/);

  await fixture.runtime.respond("Planned.");
  assert.deepEqual(
    fixture.reactions.map((reaction) => [reaction.emoji, reaction.mode]),
    [["eyes", "dry-run"]],
  );
  assert.equal(fixture.replies[0].text, ":robot_face: Planned.");
  assert.deepEqual(fixture.store.get(fixture.session.id).awaitingAcknowledgementTs, ["101.000001"]);

  await fixture.runtime.respond("Sending now.", { send: true });
  assert.equal(fixture.replies[1].mode, "dry-run");
  assert.deepEqual(
    fixture.reactions.map((reaction) => [reaction.emoji, reaction.mode]),
    [["eyes", "dry-run"]],
  );
  assert.deepEqual(
    fixture.store.get(fixture.session.id).awaitingAcknowledgementTs,
    ["101.000001"],
  );
});

test("localhost bridge authenticates and sends a response", async (t) => {
  const fixture = setup([message("101.000001", "U_OWNER", "bridge this")]);
  await fixture.runtime.runOnce();
  attachRuntimeIdentity(fixture);
  try {
    await fixture.runtime.startBridge();
  } catch (error) {
    if (error.code === "EPERM") {
      t.skip("loopback listeners are unavailable in this sandbox");
      return;
    }
    throw error;
  }
  try {
    const session = fixture.store.get(fixture.session.id, { includeSecret: true });
    const result = await postBridgeResponse(session, "finished", { send: true });
    assert.equal(result.mode, "sent");
    assert.equal(fixture.replies.length, 1);
    assert.equal(fixture.replies[0].text, ":robot_face: finished");
    assert.deepEqual(
      fixture.reactions.map((reaction) => [reaction.emoji, reaction.add]),
      [["eyes", true], ["eyes", false], ["white_check_mark", true]],
    );
  } finally {
    await fixture.runtime.stopBridge();
  }
});

test("bridge shutdown aborts a never-resolving Slack response and closes its connection", async (t) => {
  const fixture = setup([]);
  attachRuntimeIdentity(fixture);
  const lifecycle = new AbortController();
  let responseSignal = null;
  let markResponseStarted;
  const responseStarted = new Promise((resolve) => {
    markResponseStarted = resolve;
  });
  fixture.slack.reply = async (session, text, { signal } = {}) => {
    responseSignal = signal;
    markResponseStarted();
    return new Promise(() => {});
  };

  try {
    await fixture.runtime.startBridge({ signal: lifecycle.signal });
  } catch (error) {
    if (error.code === "EPERM") {
      t.skip("loopback listeners are unavailable in this sandbox");
      return;
    }
    throw error;
  }

  const session = fixture.store.get(fixture.session.id, { includeSecret: true });
  const responseOutcome = postBridgeResponse(session, "never finishes", { send: true })
    .then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    );
  await within(250, responseStarted);
  lifecycle.abort();
  await within(250, fixture.runtime.stopBridge());
  const outcome = await within(250, responseOutcome);

  assert.equal(responseSignal.aborted, true);
  assert.ok(outcome.error);
  assert.equal(fixture.store.get(fixture.session.id).bridge.port, null);
});

test("a reused loopback port receives no bridge token or response body without a valid proof", async (t) => {
  const fixture = setup([]);
  attachRuntimeIdentity(fixture, "runtime_expected_by_client");
  const requests = [];
  const staleServer = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization || null,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        protocol: BRIDGE_HEALTH_PROTOCOL,
        sessionId: fixture.session.id,
        proof: "forged-by-unrelated-listener",
      }));
    });
  });
  try {
    await new Promise((resolve, reject) => {
      staleServer.once("error", reject);
      staleServer.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    if (error.code === "EPERM") {
      t.skip("loopback listeners are unavailable in this sandbox");
      return;
    }
    throw error;
  }
  t.after(() => new Promise((resolve) => staleServer.close(resolve)));
  const address = staleServer.address();
  fixture.store.update(fixture.session.id, (session) => {
    session.bridge = {
      host: "127.0.0.1",
      port: address.port,
      url: `http://127.0.0.1:${address.port}`,
    };
    return session;
  });
  const session = fixture.store.get(fixture.session.id, { includeSecret: true });

  await assert.rejects(
    postBridgeResponse(session, "message body must remain private", {
      send: true,
      eventId: "evt_private",
      status: "complete",
    }),
    /could not authenticate.*runtime/,
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "GET");
  assert.match(requests[0].url, /^\/health\?nonce=/);
  assert.equal(requests[0].authorization, null);
  assert.equal(requests[0].body, "");
  assert.doesNotMatch(JSON.stringify(requests), /message body must remain private/);
  assert.doesNotMatch(JSON.stringify(requests), new RegExp(session.bridgeToken));
});

test("control parser accepts only the dedicated command shape", () => {
  assert.deepEqual(parseControl("!session approve msg_123"), { action: "approve", argument: "msg_123" });
  assert.equal(parseControl("please !session stop"), null);
});

test("a failed owner control advances the cursor and does not wedge later input", async () => {
  const fixture = setup([
    message("101.000001", "U_OWNER", "!session approve evt_missing"),
    message("102.000001", "U_OWNER", "continue after the bad control"),
  ]);

  await fixture.runtime.runOnce();
  let current = fixture.store.get(fixture.session.id);
  assert.equal(current.cursorTs, "102.000001");
  assert.equal(current.injectedCount, 1);
  assert.equal(fixture.provider.injections.length, 1);
  let failures = fixture.store.readEvents(fixture.session.id)
    .filter((event) => event.type === "control_failed");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].action, "approve");
  assert.match(failures[0].error, /Pending message not found/);
  assert.equal(Object.hasOwn(failures[0], "text"), false);

  await fixture.runtime.runOnce();
  current = fixture.store.get(fixture.session.id);
  failures = fixture.store.readEvents(fixture.session.id)
    .filter((event) => event.type === "control_failed");
  assert.equal(current.injectedCount, 1);
  assert.equal(fixture.provider.injections.length, 1);
  assert.equal(failures.length, 1);
});

test("an ambiguous bridge failure never falls back to a duplicate direct post", async () => {
  const fixture = setup([]);
  fixture.store.update(fixture.session.id, (session) => {
    session.bridge = { host: "127.0.0.1", port: 1, url: "http://127.0.0.1:1" };
    return session;
  });
  let directCalls = 0;
  await assert.rejects(
    respondCommand({
      id: fixture.session.id,
      stateDir: fixture.store.baseDir,
      eventId: "evt_bridge_failure",
      message: "only once",
      messageFile: "",
      send: true,
    }, {
      store: fixture.store,
      slack: { async reply() { directCalls += 1; } },
    }),
    /no direct fallback/,
  );
  assert.equal(directCalls, 0);
  const refused = fixture.store.readEvents(fixture.session.id)
    .find((event) => event.type === "bridge_authentication_refused");
  assert.equal(refused.reason, "pid_missing");
  assert.equal(refused.runtimeAlive, false);
});

test("respond accepts mrkdwn from stdin without shell argument interpolation", async () => {
  const fixture = setup([message("101.000001", "U_OWNER", "send the stdin response")]);
  await fixture.runtime.runOnce();
  const eventId = fixture.store.get(fixture.session.id).inboundEvents[0].id;
  const mrkdwn = "*done* <https://example.com|details> _checked_ ~obsolete~ `npm test`";
  const parsed = parseArgs([
    "respond", "--id", fixture.session.id, "--event", eventId, "--stdin", "--send",
  ]);
  const result = await respondCommand(parsed, {
    store: fixture.store,
    slack: fixture.slack,
    stdin: Readable.from([mrkdwn]),
  });

  assert.equal(result.result.mode, "sent");
  assert.equal(fixture.replies.length, 1);
  assert.equal(fixture.replies[0].text, `:robot_face: ${mrkdwn}`);
});

test("respond rejects multiple response sources", async () => {
  const fixture = setup([]);
  const parsed = parseArgs([
    "respond",
    "--id", fixture.session.id,
    "--event", "evt_multiple_sources",
    "--message", "literal",
    "--stdin",
  ]);

  await assert.rejects(
    respondCommand(parsed, {
      store: fixture.store,
      slack: fixture.slack,
      stdin: Readable.from(["standard input"]),
    }),
    /mutually exclusive/,
  );
});

test("progress responses reject text sources before reading stdin or session state", async () => {
  const fixture = setup([]);
  const beforeState = fs.readFileSync(fixture.store.statePath, "utf8");
  let stdinReads = 0;
  const parsed = parseArgs([
    "respond",
    "--id", fixture.session.id,
    "--event", "evt_progress",
    "--status", "progress",
    "--stdin",
    "--state-dir", fixture.store.baseDir,
  ]);
  const stdin = {
    setEncoding() {},
    async *[Symbol.asyncIterator]() {
      stdinReads += 1;
      yield "must not be read";
    },
  };

  await assert.rejects(
    respondCommand(parsed, { store: fixture.store, stdin }),
    /--status progress does not accept/,
  );
  assert.equal(stdinReads, 0);
  assert.equal(fs.readFileSync(fixture.store.statePath, "utf8"), beforeState);
});

test("respond reads a caller-owned message file without deleting it", async () => {
  const fixture = setup([message("101.000001", "U_OWNER", "send the file response")]);
  await fixture.runtime.runOnce();
  const eventId = fixture.store.get(fixture.session.id).inboundEvents[0].id;
  const messageFile = path.join(fixture.store.baseDir, "slack-response-unique.txt");
  const mrkdwn = "*file response*";
  fs.writeFileSync(messageFile, mrkdwn, { mode: 0o600 });

  const result = await respondCommand({
    id: fixture.session.id,
    stateDir: fixture.store.baseDir,
    eventId,
    message: "",
    messageFile,
    stdin: false,
    send: true,
  }, {
    store: fixture.store,
    slack: fixture.slack,
  });

  assert.equal(result.result.mode, "sent");
  assert.equal(fixture.replies[0].text, `:robot_face: ${mrkdwn}`);
  assert.equal(fs.readFileSync(messageFile, "utf8"), mrkdwn);
});

test("public respond requires an event before reading or mutating session state", async () => {
  const fixture = setup([]);
  const beforeState = fs.readFileSync(fixture.store.statePath, "utf8");
  const beforeEvents = fixture.store.readEvents(fixture.session.id);
  let slackCalls = 0;

  await assert.rejects(
    respondCommand({
      id: fixture.session.id,
      stateDir: fixture.store.baseDir,
      eventId: "",
      message: "must stay unsent",
      messageFile: "",
      stdin: false,
      send: true,
      responseStatus: "complete",
    }, {
      store: fixture.store,
      slack: { async reply() { slackCalls += 1; } },
    }),
    /--event is required/,
  );

  assert.equal(slackCalls, 0);
  assert.equal(fs.readFileSync(fixture.store.statePath, "utf8"), beforeState);
  assert.deepEqual(fixture.store.readEvents(fixture.session.id), beforeEvents);
});
