const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  START_INTENT_RETRY_WINDOW_MS,
  SessionStore,
} = require("../slack-api-session-store.cjs");

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "slack-session-store-"));
}

function input() {
  return {
    slack: {
      workspace: "https://example.slack.com",
      channelId: "C1",
      threadTs: "100.000001",
      permalink: "https://example.slack.com/archives/C1/p100000001",
    },
    provider: { name: "stdio", target: "stdout" },
    ownerUserId: "U_OWNER",
    allowedUserIds: [],
    pollIntervalMs: 3000,
    cursorTs: "100.000001",
  };
}

test("session state is private, atomic, and redacts the bridge token", () => {
  const directory = temporaryDirectory();
  const store = new SessionStore(directory);
  const session = store.create(input());
  assert.match(session.id, /^sess_/);
  assert.equal(session.bridgeToken, undefined);
  assert.equal(session.bridge.tokenConfigured, true);
  assert.ok(session.listenerCursorAt);
  assert.equal(session.lastInjectedAt, null);
  assert.equal(session.lastInjectedTs, null);
  assert.deepEqual(session.recentInjectedTs, []);
  assert.deepEqual(session.awaitingAcknowledgementTs, []);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(directory, "state.json")).mode & 0o777, 0o600);
  const secret = store.get(session.id, { includeSecret: true });
  assert.ok(secret.bridgeToken);
});

test("public session views redact the runtime launch identity", () => {
  const store = new SessionStore(temporaryDirectory());
  const privateInput = input();
  privateInput.runtimeInstanceId = "runtime_private_identity";
  const created = store.create(privateInput);

  assert.equal(created.runtimeInstanceId, undefined);
  assert.equal(store.get(created.id).runtimeInstanceId, undefined);
  assert.equal(store.list()[0].runtimeInstanceId, undefined);
  assert.equal(
    store.get(created.id, { includeSecret: true }).runtimeInstanceId,
    "runtime_private_identity",
  );
});

test("only one active session can bind a Slack thread", () => {
  const store = new SessionStore(temporaryDirectory());
  const first = store.create(input());
  assert.throws(() => store.create(input()), new RegExp(first.id));
  store.update(first.id, (session) => {
    session.status = "stopped";
    return session;
  });
  assert.doesNotThrow(() => store.create(input()));
});

test("active session lists exclude stopped and failed lifecycle states", () => {
  const store = new SessionStore(temporaryDirectory());
  const active = store.create(input());
  const stoppedInput = input();
  stoppedInput.slack = { ...stoppedInput.slack, threadTs: "200.000001" };
  const stopped = store.create(stoppedInput);
  const failedInput = input();
  failedInput.slack = { ...failedInput.slack, threadTs: "300.000001" };
  const failed = store.create(failedInput);
  store.update(stopped.id, (session) => {
    session.status = "stopped";
    return session;
  });
  store.update(failed.id, (session) => {
    session.status = "startup_failed";
    return session;
  });
  assert.deepEqual(store.list({ includeStopped: false }).map((session) => session.id), [active.id]);
});

test("audit logs fingerprint text instead of storing its contents", () => {
  const store = new SessionStore(temporaryDirectory());
  const session = store.create(input());
  store.auditMessage(session.id, "message_seen", {
    ts: "101.000001",
    user: "U_OWNER",
    text: "private Slack content",
  });
  const serialized = JSON.stringify(store.readEvents(session.id));
  assert.doesNotMatch(serialized, /private Slack content/);
  assert.match(serialized, /textSha256/);
});

test("public session views redact queued Slack message bodies", () => {
  const store = new SessionStore(temporaryDirectory());
  const session = store.create(input());
  store.update(session.id, (current) => {
    current.pending.push({
      id: "evt_private",
      receivedAt: "2026-07-27T12:00:00.000Z",
      message: {
        ts: "101.000001",
        user: "U_COLLAB",
        username: "collaborator",
        text: "private queued request",
      },
    });
    return current;
  });

  const serialized = JSON.stringify(store.list());
  assert.doesNotMatch(serialized, /private queued request/);
  const [pending] = store.get(session.id).pending;
  assert.equal(pending.message.text, undefined);
  assert.equal(pending.message.textLength, "private queued request".length);
  assert.match(pending.message.textSha256, /^[a-f0-9]{64}$/);
  assert.equal(
    store.get(session.id, { includeSecret: true }).pending[0].message.text,
    "private queued request",
  );
});

test("public list and show views redact provider connection environment values", () => {
  const store = new SessionStore(temporaryDirectory());
  const privateInput = input();
  privateInput.provider = {
    name: "tmux",
    target: "%42",
    connection: {
      environment: {
        TMUX: "/private/tmp/custom-tmux/session.sock,4242,0",
        TMUX_TMPDIR: "/private/tmp/custom-tmux",
      },
    },
  };
  const created = store.create(privateInput);

  for (const publicView of [created, store.get(created.id), store.list()[0]]) {
    const serialized = JSON.stringify(publicView);
    assert.doesNotMatch(serialized, /custom-tmux|session\.sock/);
    assert.deepEqual(publicView.provider.connection, {
      environmentKeys: ["TMUX", "TMUX_TMPDIR"],
    });
  }

  assert.deepEqual(
    store.get(created.id, { includeSecret: true }).provider.connection.environment,
    privateInput.provider.connection.environment,
  );
});

test("public sessions preserve an explicit empty provider endpoint binding", () => {
  const store = new SessionStore(temporaryDirectory());
  const defaultEndpointInput = input();
  defaultEndpointInput.provider = {
    name: "cmux",
    target: "surface:original",
    connection: { environment: {} },
  };
  const created = store.create(defaultEndpointInput);
  assert.deepEqual(created.provider.connection, { environmentKeys: [] });
  assert.deepEqual(store.get(created.id).provider.connection, { environmentKeys: [] });
  assert.deepEqual(store.list()[0].provider.connection, { environmentKeys: [] });
  assert.deepEqual(
    store.get(created.id, { includeSecret: true }).provider.connection,
    { environment: {} },
  );
});

test("public session views redact managed host connection values", () => {
  const store = new SessionStore(temporaryDirectory());
  const hostInput = input();
  hostInput.host = {
    kind: "cmux",
    target: "surface:managed",
    managed: true,
    workspaceId: "workspace:managed",
    surfaceId: "surface:managed",
    executable: "/tools/cmux",
    connection: {
      environment: {
        CMUX_SOCKET_PATH: "/private/tmp/cmux-a.sock",
        CMUX_SOCKET_MODE: "allowAll",
      },
    },
  };
  const created = store.create(hostInput);

  for (const publicView of [created, store.get(created.id), store.list()[0]]) {
    const serialized = JSON.stringify(publicView);
    assert.doesNotMatch(serialized, /cmux-a\.sock|allowAll/);
    assert.deepEqual(publicView.host.connection, {
      environmentKeys: ["CMUX_SOCKET_MODE", "CMUX_SOCKET_PATH"],
    });
  }
  assert.deepEqual(
    store.get(created.id, { includeSecret: true }).host.connection.environment,
    hostInput.host.connection.environment,
  );
});

test("a lock left by a dead process is recovered", () => {
  const store = new SessionStore(temporaryDirectory());
  const session = store.create(input());
  fs.writeFileSync(store.mutationLockPath, "999999999\n", { mode: 0o600 });
  const updated = store.update(session.id, (current) => {
    current.status = "paused";
    return current;
  });
  assert.equal(updated.status, "paused");
});

test("start intents atomically reuse ambiguous client ids and release completed requests", () => {
  const store = new SessionStore(temporaryDirectory());
  const requestFingerprint = "a".repeat(64);
  const base = Date.now();
  const first = store.claimStartIntent({ requestFingerprint }, {
    now: base,
    leaseMs: 10_000,
  });
  const concurrent = store.claimStartIntent({ requestFingerprint }, {
    now: base + 1,
    leaseMs: 10_000,
  });
  assert.equal(first.kind, "owner");
  assert.equal(concurrent.kind, "in-flight");
  assert.equal(concurrent.intent.id, first.intent.id);
  assert.equal(concurrent.intent.clientMessageId, first.intent.clientMessageId);

  const ambiguous = store.updateStartIntent(
    first.intent.id,
    first.intent.activeAttemptId,
    (intent) => ({
      ...intent,
      state: "ambiguous",
      activeAttemptId: null,
      leaseUntil: null,
    }),
  );
  assert.equal(ambiguous.updated, true);
  const retried = store.claimStartIntent({ requestFingerprint }, {
    now: base + 2,
    leaseMs: 10_000,
  });
  assert.equal(retried.kind, "owner");
  assert.equal(retried.intent.sessionId, first.intent.sessionId);
  assert.equal(retried.intent.clientMessageId, first.intent.clientMessageId);

  store.updateStartIntent(
    retried.intent.id,
    retried.intent.activeAttemptId,
    (intent) => ({
      ...intent,
      state: "completed",
      activeAttemptId: null,
      leaseUntil: null,
      completedAt: new Date(base + 3).toISOString(),
    }),
  );
  const laterIntentionalStart = store.claimStartIntent({ requestFingerprint }, {
    now: base + 4,
    leaseMs: 10_000,
  });
  assert.equal(laterIntentionalStart.kind, "owner");
  assert.notEqual(laterIntentionalStart.intent.id, first.intent.id);
  assert.notEqual(
    laterIntentionalStart.intent.clientMessageId,
    first.intent.clientMessageId,
  );
});

test("abandoned ambiguous start intents expire after the retry window", () => {
  const store = new SessionStore(temporaryDirectory());
  const requestFingerprint = "b".repeat(64);
  const base = Date.now();
  const first = store.claimStartIntent({ requestFingerprint }, {
    now: base,
    leaseMs: 1,
  });
  store.updateStartIntent(
    first.intent.id,
    first.intent.activeAttemptId,
    (intent) => ({
      ...intent,
      state: "ambiguous",
      activeAttemptId: null,
      leaseUntil: null,
    }),
  );

  const afterExpiry = store.claimStartIntent({ requestFingerprint }, {
    now: base + START_INTENT_RETRY_WINDOW_MS + 1,
    leaseMs: 1,
  });
  assert.notEqual(afterExpiry.intent.id, first.intent.id);
  assert.equal(store.getStartIntent(first.intent.id).state, "expired");
});
