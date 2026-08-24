const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  applySessionDefaults,
  main: sessionCommand,
  parseArgs,
  preflightSessionHost,
  runtimeOwnership,
  runtimeReadinessTimeoutMs,
  spawnRuntime,
  startSession,
  waitForRuntime,
} = require("../slack-api-session.cjs");
const { CmuxSessionHost } = require("../slack-api-session-host.cjs");
const { SessionStore } = require("../slack-api-session-store.cjs");

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "slack-session-command-"));
}

function scriptedSpawn(steps, calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const step = steps.shift();
    assert.ok(step, `Unexpected command: ${command} ${args.join(" ")}`);
    if (step.args) assert.deepEqual(args, step.args);
    return {
      status: step.status ?? 0,
      stdout: step.stdout || "",
      stderr: step.stderr || "",
      error: step.error,
    };
  };
}

function fakeSlack(calls = []) {
  return {
    async identity() {
      calls.push("identity");
      return { user_id: "U_OWNER", user: "Owner", team_id: "T1" };
    },
    async resolveDestination(channel) {
      calls.push(`destination:${channel}`);
      return { channelId: "D_SELF", requested: channel, kind: "self_dm" };
    },
    async createThread({ destination, text }) {
      calls.push("root");
      return {
        ownerUserId: "U_OWNER",
        ownerName: "Owner",
        teamId: "T1",
        workspace: "https://example.slack.com",
        channelId: destination.channelId,
        threadTs: "100.000001",
        latestTs: "100.000001",
        messages: [{ ts: "100.000001", user: "U_OWNER", username: "Owner", text }],
        permalink: "https://example.slack.com/archives/D_SELF/p100000001",
      };
    },
  };
}

function fakeHostedSession(calls = []) {
  const host = {
    lastCreateOptions: null,
    lastLaunchCommand: null,
    async preflight() {
      calls.push("host:preflight");
      return { ok: true };
    },
    async create(options) {
      calls.push("host:create");
      host.lastCreateOptions = options;
      return {
        kind: "cmux",
        target: "surface-host",
        managed: true,
        workspaceId: "workspace-host",
        paneId: "pane-host",
        surfaceId: "surface-host",
        executable: "/tools/cmux",
        cwd: options.cwd,
        createdAt: "2026-07-27T12:00:00.000Z",
      };
    },
    async launch(descriptor, { command }) {
      calls.push("host:launch");
      host.lastLaunchCommand = command;
      assert.equal(command.includes("\n"), false);
      assert.match(command, /slack-api-session\.cjs.*run.*--id/);
      return {
        ok: true,
        descriptor: {
          ...descriptor,
          launchedAt: "2026-07-27T12:00:01.000Z",
        },
      };
    },
    async inspect(descriptor) {
      calls.push("host:inspect");
      return { ok: true, exists: true, descriptor };
    },
    async close(descriptor) {
      calls.push("host:close");
      return {
        ok: true,
        closed: true,
        descriptor: {
          ...descriptor,
          closedAt: "2026-07-27T12:00:02.000Z",
        },
      };
    },
  };
  return host;
}

function storedSession(store, host, overrides = {}) {
  return store.create({
    runtimeInstanceId: overrides.runtimeInstanceId || null,
    slack: {
      workspace: "https://example.slack.com",
      channelId: "D_SELF",
      threadTs: overrides.threadTs || "100.000001",
      permalink: "https://example.slack.com/archives/D_SELF/p100000001",
      bindingMode: "created_thread",
    },
    provider: overrides.provider || { name: "stdio", target: "stdout" },
    host,
    attachment: overrides.attachment || {
      agentSessionId: "thread_123",
      agentProvider: "codex",
      worktree: process.cwd(),
      provider: "stdio",
      target: "stdout",
    },
    ownerUserId: "U_OWNER",
    allowedUserIds: [],
    pollIntervalMs: 3000,
    cursorTs: "100.000001",
  });
}

function reportRuntimeReady(currentStore, id, pid = 99) {
  currentStore.update(id, (session) => {
    session.pid = pid;
    session.host.pid = pid;
    session.bridge = {
      host: "127.0.0.1",
      port: 9_000 + (pid % 1_000),
      url: `http://127.0.0.1:${9_000 + (pid % 1_000)}`,
    };
    session.timings.runtimeReadyAt = "2026-07-27T12:00:02.500Z";
    session.timings.firstPollAt = "2026-07-27T12:00:03.000Z";
    return session;
  });
  return currentStore.get(id);
}

function expireActiveStartIntentLease(store) {
  const intent = store.readState().startIntents.find((candidate) => (
    ["posting", "ambiguous", "root_posted", "starting"].includes(candidate.state)
  ));
  assert.ok(intent);
  const updated = store.updateStartIntent(
    intent.id,
    intent.activeAttemptId,
    (current) => ({
      ...current,
      leaseUntil: "2000-01-01T00:00:00.000Z",
    }),
  );
  assert.equal(updated.updated, true);
  return updated.intent;
}

test("defaults CLI persists the configured profile and explicit inverse flags win", async () => {
  const stateDir = temporaryDirectory();
  const configured = await sessionCommand([
    "defaults", "set",
    "--channel", "me",
    "--send-responses",
    "--provider", "auto",
    "--poll-seconds", "3",
    "--headless",
    "--host", "auto",
    "--state-dir", stateDir,
  ], { env: {} });

  assert.deepEqual(configured.defaults.saved, {
    channel: "me",
    sendResponses: true,
    provider: "auto",
    pollSeconds: 3,
    headless: true,
    host: "auto",
  });

  const bare = parseArgs(["start", "--state-dir", stateDir]);
  applySessionDefaults(bare, {});
  assert.equal(bare.channel, "me");
  assert.equal(bare.sendResponses, true);
  assert.equal(bare.host, "auto");
  assert.equal(bare.effective.sendResponses.source.kind, "saved");

  const optedOut = parseArgs(["start", "--no-send-responses", "--state-dir", stateDir]);
  applySessionDefaults(optedOut, {});
  assert.equal(optedOut.sendResponses, false);
  assert.equal(optedOut.effective.sendResponses.source.kind, "explicit");
});

test("defaults accepts implicit show options, reset, and scoped help", async () => {
  const stateDir = temporaryDirectory();
  const implicitShow = parseArgs(["defaults", "--state-dir", stateDir]);
  assert.equal(implicitShow.action, "defaults");
  assert.equal(implicitShow.defaultsAction, "show");
  assert.equal(implicitShow.stateDir, stateDir);

  await sessionCommand([
    "defaults", "set", "--channel", "me", "--state-dir", stateDir,
  ], { env: {} });
  const shown = await sessionCommand([
    "defaults", "--state-dir", stateDir,
  ], { env: {} });
  assert.equal(shown.defaults.saved.channel, "me");
  const reset = await sessionCommand([
    "defaults", "reset", "--state-dir", stateDir,
  ], { env: {} });
  assert.deepEqual(reset.defaults.saved, {});

  const help = parseArgs(["defaults", "--help"]);
  assert.equal(help.action, "help");
  assert.equal(help.helpFor, "defaults");
});

test("conflicting destination flags fail before Slack authentication or mutation", async () => {
  const stateDir = temporaryDirectory();
  const args = parseArgs([
    "start",
    "--link", "https://example.slack.com/archives/C1/p100000001",
    "--self",
    "--provider", "stdio",
    "--foreground",
    "--state-dir", stateDir,
  ]);
  const calls = [];
  await assert.rejects(
    startSession(args, {
      store: new SessionStore(stateDir),
      provider: { verify() { calls.push("provider"); } },
      slack: fakeSlack(calls),
      env: {},
    }),
    /--link conflicts with --self and --channel/,
  );
  assert.deepEqual(calls, ["provider"]);
});

test("start rejects message and message-file together before provider or Slack mutation", async () => {
  const stateDir = temporaryDirectory();
  const messageFile = path.join(stateDir, "root.txt");
  fs.writeFileSync(messageFile, "file root", { mode: 0o600 });
  const args = parseArgs([
    "start",
    "--channel", "me",
    "--message", "literal root",
    "--message-file", messageFile,
    "--provider", "stdio",
    "--foreground",
    "--state-dir", stateDir,
  ]);
  const calls = [];

  await assert.rejects(
    startSession(args, {
      store: new SessionStore(stateDir),
      provider: { verify() { calls.push("provider"); } },
      slack: fakeSlack(calls),
      env: {},
    }),
    /--message and --message-file are mutually exclusive/,
  );
  assert.deepEqual(calls, []);
});

test("an ambiguous root post retry reuses its durable session and client message ids", async () => {
  const stateDir = temporaryDirectory();
  const store = new SessionStore(stateDir);
  const args = parseArgs([
    "start",
    "--channel", "me",
    "--provider", "stdio",
    "--host", "auto",
    "--state-dir", stateDir,
  ]);
  const host = fakeHostedSession();
  const rootAttempts = [];
  const slack = fakeSlack();
  slack.createThread = async (options) => {
    rootAttempts.push(options);
    if (rootAttempts.length === 1) {
      const error = new Error("connection reset after Slack accepted the root");
      error.rootPostAmbiguous = true;
      throw error;
    }
    return {
      ownerUserId: "U_OWNER",
      ownerName: "Owner",
      teamId: "T1",
      workspace: "https://example.slack.com",
      channelId: options.destination.channelId,
      threadTs: "100.000001",
      latestTs: "100.000001",
      messages: [{
        ts: "100.000001",
        user: "U_OWNER",
        username: "Owner",
        text: options.text,
        client_msg_id: options.clientMessageId,
      }],
      permalink: "https://example.slack.com/archives/D_SELF/p100000001",
      reconciled: true,
    };
  };
  const dependencies = {
    store,
    provider: {
      target: "stdout",
      verify() { return { ok: true, target: "stdout" }; },
    },
    slack,
    sessionHost: host,
    hostConfig: { kind: "cmux", executable: "/tools/cmux", source: "explicit" },
    env: {},
    waitForRuntime(currentStore, id) {
      return reportRuntimeReady(currentStore, id, 71);
    },
  };

  await assert.rejects(
    startSession(args, dependencies),
    /connection reset after Slack accepted the root/,
  );
  const [ambiguous] = store.readState().startIntents;
  assert.equal(ambiguous.state, "ambiguous");

  const result = await startSession(args, dependencies);
  assert.equal(result.ok, true);
  assert.equal(rootAttempts.length, 2);
  assert.equal(
    rootAttempts[0].clientMessageId,
    rootAttempts[1].clientMessageId,
  );
  assert.match(rootAttempts[0].clientMessageId, /^[0-9a-f-]{36}$/);
  assert.equal(rootAttempts[0].text, rootAttempts[1].text);
  assert.equal(result.session.id, ambiguous.sessionId);
  assert.equal(store.readState().startIntents[0].state, "completed");
  assert.equal(store.list().length, 1);
});

test("concurrent identical starts post once while a later completed start remains intentional", async () => {
  const stateDir = temporaryDirectory();
  const store = new SessionStore(stateDir);
  const args = parseArgs([
    "start",
    "--channel", "me",
    "--provider", "stdio",
    "--host", "auto",
    "--state-dir", stateDir,
  ]);
  const host = fakeHostedSession();
  let releaseFirstRoot;
  let markFirstRootEntered;
  const firstRootEntered = new Promise((resolve) => {
    markFirstRootEntered = resolve;
  });
  const firstRootRelease = new Promise((resolve) => {
    releaseFirstRoot = resolve;
  });
  const rootAttempts = [];
  const slack = fakeSlack();
  slack.createThread = async (options) => {
    rootAttempts.push(options);
    const sequence = rootAttempts.length;
    if (sequence === 1) {
      markFirstRootEntered();
      await firstRootRelease;
    }
    const threadTs = `${sequence}00.000001`;
    return {
      ownerUserId: "U_OWNER",
      ownerName: "Owner",
      teamId: "T1",
      workspace: "https://example.slack.com",
      channelId: options.destination.channelId,
      threadTs,
      latestTs: threadTs,
      messages: [{
        ts: threadTs,
        user: "U_OWNER",
        username: "Owner",
        text: options.text,
        client_msg_id: options.clientMessageId,
      }],
      permalink: `https://example.slack.com/archives/D_SELF/p${threadTs.replace(".", "")}`,
    };
  };
  let readyPid = 80;
  const dependencies = {
    store,
    provider: {
      target: "stdout",
      verify() { return { ok: true, target: "stdout" }; },
    },
    slack,
    sessionHost: host,
    hostConfig: { kind: "cmux", executable: "/tools/cmux", source: "explicit" },
    env: {},
    waitForRuntime(currentStore, id) {
      readyPid += 1;
      return reportRuntimeReady(currentStore, id, readyPid);
    },
  };

  const first = startSession(args, dependencies);
  await firstRootEntered;
  const concurrent = startSession(args, dependencies);
  await assert.rejects(
    concurrent,
    (error) => error.code === "SESSION_START_IN_PROGRESS",
  );
  assert.equal(rootAttempts.length, 1);
  releaseFirstRoot();
  const firstResult = await first;

  const laterResult = await startSession(args, dependencies);
  assert.equal(rootAttempts.length, 2);
  assert.notEqual(firstResult.session.id, laterResult.session.id);
  assert.notEqual(
    rootAttempts[0].clientMessageId,
    rootAttempts[1].clientMessageId,
  );
  assert.equal(
    store.readState().startIntents.filter((intent) => intent.state === "completed").length,
    2,
  );
});

test("a retry after process loss reuses the exact persisted session and managed host", async () => {
  const stateDir = temporaryDirectory();
  const store = new SessionStore(stateDir);
  const args = parseArgs([
    "start",
    "--channel", "me",
    "--provider", "stdio",
    "--host", "auto",
    "--state-dir", stateDir,
  ]);
  const hostCalls = [];
  const host = fakeHostedSession(hostCalls);
  let rootPosts = 0;
  let createThreadCalls = 0;
  const slack = fakeSlack();
  slack.createThread = async (options) => {
    createThreadCalls += 1;
    if (!options.reconcile) rootPosts += 1;
    return {
      ownerUserId: "U_OWNER",
      ownerName: "Owner",
      teamId: "T1",
      workspace: "https://example.slack.com",
      channelId: options.destination.channelId,
      threadTs: "100.000001",
      latestTs: "100.000001",
      messages: [{
        ts: "100.000001",
        user: "U_OWNER",
        username: "Owner",
        text: options.text,
        client_msg_id: options.clientMessageId,
      }],
      permalink: "https://example.slack.com/archives/D_SELF/p100000001",
      reconciled: options.reconcile,
    };
  };
  let readinessAttempts = 0;
  const dependencies = {
    store,
    provider: {
      target: "stdout",
      verify() { return { ok: true, target: "stdout" }; },
    },
    slack,
    sessionHost: host,
    hostConfig: { kind: "cmux", executable: "/tools/cmux", source: "explicit" },
    env: {},
    processIsAlive(pid) { return pid === 91; },
    runtimeOwnershipVerifier() { return true; },
    waitForRuntime(currentStore, id) {
      readinessAttempts += 1;
      if (readinessAttempts === 1) {
        throw new Error("simulated initiating process loss after host launch");
      }
      return reportRuntimeReady(currentStore, id, 91);
    },
  };

  await assert.rejects(
    startSession(args, dependencies),
    /simulated initiating process loss/,
  );
  const [persisted] = store.readState().sessions;
  const [intent] = store.readState().startIntents;
  assert.equal(intent.state, "starting");
  assert.equal(persisted.id, intent.sessionId);
  assert.equal(persisted.slack.rootStartIntentId, intent.id);
  assert.equal(persisted.slack.rootClientMessageId, intent.clientMessageId);
  assert.equal(hostCalls.filter((call) => call === "host:create").length, 1);
  assert.equal(hostCalls.filter((call) => call === "host:launch").length, 1);

  expireActiveStartIntentLease(store);
  const releaseStaleRunLock = store.acquireRunLock(persisted.id);
  let result;
  try {
    result = await startSession(args, dependencies);
  } finally {
    releaseStaleRunLock();
  }

  assert.equal(result.ok, true);
  assert.equal(result.mode, "standalone");
  assert.equal(result.session.id, persisted.id);
  assert.equal(rootPosts, 1);
  assert.equal(createThreadCalls, 2);
  assert.equal(hostCalls.filter((call) => call === "host:create").length, 1);
  assert.equal(hostCalls.filter((call) => call === "host:launch").length, 1);
  assert.equal(store.list().length, 1);
  assert.equal(store.readState().startIntents[0].state, "completed");
});

test("a retry returns an already-ready reconciled session without relaunching", async () => {
  const stateDir = temporaryDirectory();
  const store = new SessionStore(stateDir);
  const args = parseArgs([
    "start",
    "--channel", "me",
    "--provider", "stdio",
    "--host", "auto",
    "--state-dir", stateDir,
  ]);
  const hostCalls = [];
  const host = fakeHostedSession(hostCalls);
  let rootPosts = 0;
  const slack = fakeSlack();
  slack.createThread = async (options) => {
    if (!options.reconcile) rootPosts += 1;
    return {
      ownerUserId: "U_OWNER",
      ownerName: "Owner",
      teamId: "T1",
      workspace: "https://example.slack.com",
      channelId: options.destination.channelId,
      threadTs: "100.000001",
      latestTs: "100.000001",
      messages: [{
        ts: "100.000001",
        user: "U_OWNER",
        text: options.text,
        client_msg_id: options.clientMessageId,
      }],
      permalink: "https://example.slack.com/archives/D_SELF/p100000001",
      reconciled: options.reconcile,
    };
  };
  let readinessCalls = 0;
  const dependencies = {
    store,
    provider: {
      target: "stdout",
      verify() { return { ok: true, target: "stdout" }; },
    },
    slack,
    sessionHost: host,
    hostConfig: { kind: "cmux", executable: "/tools/cmux", source: "explicit" },
    env: {},
    processIsAlive(pid) { return pid === 92; },
    runtimeOwnershipVerifier() { return true; },
    waitForRuntime(currentStore, id) {
      readinessCalls += 1;
      reportRuntimeReady(currentStore, id, 92);
      throw new Error("simulated caller loss after runtime readiness");
    },
  };

  await assert.rejects(
    startSession(args, dependencies),
    /simulated caller loss after runtime readiness/,
  );
  const [readySession] = store.list();
  const releaseRunLock = store.acquireRunLock(readySession.id);
  let result;
  try {
    result = await startSession(args, dependencies);
  } finally {
    releaseRunLock();
  }

  assert.equal(result.mode, "reconciled");
  assert.equal(result.ok, true);
  assert.equal(rootPosts, 1);
  assert.equal(readinessCalls, 1);
  assert.equal(hostCalls.filter((call) => call === "host:create").length, 1);
  assert.equal(hostCalls.filter((call) => call === "host:launch").length, 1);
  assert.equal(store.list().length, 1);
});

test("a retry rejects dead or unowned stale ready markers without signalling the pid", async () => {
  for (const scenario of [
    { alive: false, reason: "process_not_alive" },
    { alive: true, reason: "identity_mismatch" },
  ]) {
    const stateDir = temporaryDirectory();
    const store = new SessionStore(stateDir);
    const args = parseArgs([
      "start",
      "--channel", "me",
      "--provider", "stdio",
      "--host", "auto",
      "--state-dir", stateDir,
    ]);
    const hostCalls = [];
    const host = fakeHostedSession(hostCalls);
    let rootPosts = 0;
    const slack = fakeSlack();
    slack.createThread = async (options) => {
      if (!options.reconcile) rootPosts += 1;
      return {
        ownerUserId: "U_OWNER",
        ownerName: "Owner",
        teamId: "T1",
        workspace: "https://example.slack.com",
        channelId: options.destination.channelId,
        threadTs: "100.000001",
        latestTs: "100.000001",
        messages: [{
          ts: "100.000001",
          user: "U_OWNER",
          text: options.text,
          client_msg_id: options.clientMessageId,
        }],
        permalink: "https://example.slack.com/archives/D_SELF/p100000001",
        reconciled: options.reconcile,
      };
    };
    const killCalls = [];
    let readinessCalls = 0;
    const dependencies = {
      store,
      provider: {
        target: "stdout",
        verify() { return { ok: true, target: "stdout" }; },
      },
      slack,
      sessionHost: host,
      hostConfig: { kind: "cmux", executable: "/tools/cmux", source: "explicit" },
      env: {},
      processIsAlive(pid) { return scenario.alive && pid === 93; },
      runtimeOwnershipVerifier() {
        return {
          verified: true,
          owned: false,
          reason: scenario.reason,
        };
      },
      killProcess(pid, signal) {
        killCalls.push({ pid, signal });
      },
      waitForRuntime(currentStore, id) {
        readinessCalls += 1;
        if (readinessCalls === 1) {
          reportRuntimeReady(currentStore, id, 93);
          throw new Error("simulated caller loss after stale readiness");
        }
        return currentStore.get(id);
      },
    };

    await assert.rejects(
      startSession(args, dependencies),
      /simulated caller loss after stale readiness/,
    );
    await assert.rejects(
      startSession(args, dependencies),
      new RegExp(`ownership was not verified \\(${scenario.reason}\\)`),
    );

    const [failed] = store.list();
    assert.equal(failed.status, "startup_failed");
    assert.equal(failed.pid, null);
    assert.equal(failed.bridge.port, null);
    assert.equal(rootPosts, 1);
    assert.equal(hostCalls.filter((call) => call === "host:create").length, 1);
    assert.equal(hostCalls.filter((call) => call === "host:launch").length, 1);
    assert.equal(hostCalls.filter((call) => call === "host:close").length, 1);
    assert.deepEqual(killCalls, []);
    assert.equal(
      store.readEvents(failed.id).some((event) => (
        event.type === "start_reconcile_runtime_ownership_rejected"
        && event.reason === scenario.reason
      )),
      true,
    );
  }
});

test("foreground second provider verification failure becomes startup_failed", async () => {
  const stateDir = temporaryDirectory();
  const store = new SessionStore(stateDir);
  const args = parseArgs([
    "start",
    "--channel", "me",
    "--provider", "stdio",
    "--foreground",
    "--once",
    "--state-dir", stateDir,
  ]);
  let verifications = 0;
  const provider = {
    verify() {
      verifications += 1;
      if (verifications === 2) throw new Error("provider disappeared");
    },
    inject() {},
  };

  await assert.rejects(
    startSession(args, {
      store,
      provider,
      slack: fakeSlack(),
      env: {},
    }),
    /provider disappeared/,
  );

  const [failed] = store.list();
  assert.equal(verifications, 2);
  assert.equal(failed.status, "startup_failed");
  assert.ok(failed.stoppedAt);
  assert.deepEqual(store.list({ includeStopped: false }), []);
  assert.equal(
    store.readEvents(failed.id)
      .some((event) => event.type === "foreground_runtime_start_failed"),
    true,
  );
});

test("throwing process spawn leaves start and restart as non-active failures", async () => {
  const stateDir = temporaryDirectory();
  const store = new SessionStore(stateDir);
  const args = parseArgs([
    "start",
    "--channel", "me",
    "--provider", "stdio",
    "--host", "process",
    "--state-dir", stateDir,
  ]);
  const spawnFailure = () => {
    throw new Error("spawn unavailable");
  };

  await assert.rejects(
    startSession(args, {
      store,
      provider: { verify() {} },
      slack: fakeSlack(),
      spawn: spawnFailure,
      env: {},
    }),
    /spawn unavailable/,
  );
  let [failed] = store.list();
  assert.equal(failed.status, "startup_failed");
  assert.ok(failed.stoppedAt);
  assert.deepEqual(store.list({ includeStopped: false }), []);
  assert.equal(
    store.readEvents(failed.id).some((event) => event.type === "runtime_launch_failed"),
    true,
  );

  await assert.rejects(
    sessionCommand([
      "restart", "--id", failed.id, "--state-dir", stateDir,
    ], {
      store,
      spawn: spawnFailure,
      env: {},
    }),
    /spawn unavailable/,
  );
  failed = store.get(failed.id);
  assert.equal(failed.status, "restart_failed");
  assert.ok(failed.stoppedAt);
  assert.deepEqual(store.list({ includeStopped: false }), []);
  assert.equal(
    store.readEvents(failed.id)
      .some((event) => event.type === "session_restart_launch_failed"),
    true,
  );
});

test("auto host preflight falls through an unavailable cmux server to Herdr", async () => {
  const calls = [];
  const result = await preflightSessionHost(
    { host: "auto", hostExecutable: "" },
    { name: "tmux", target: "%1" },
    {
      env: { PATH: "/tools" },
      hostResolutionDependencies: {
        accessSync(candidate) {
          if (candidate === "/tools/cmux" || candidate === "/tools/herdr") return;
          throw new Error("missing");
        },
      },
      hostDependencies: {
        spawnSync(command, args) {
          calls.push({ command, args });
          if (command === "/tools/cmux") {
            return { status: 1, stdout: "", stderr: "connection refused" };
          }
          return { status: 0, stdout: "{\"ok\":true}", stderr: "" };
        },
      },
    },
  );
  assert.equal(result.config.kind, "herdr");
  assert.deepEqual(result.failures, [{
    kind: "cmux",
    error: "cmux host command failed: connection refused",
  }]);
  assert.deepEqual(calls.map((call) => path.basename(call.command)), ["cmux", "herdr"]);
});

test("doctor redacts the selected host connection endpoint", async () => {
  const stateDir = temporaryDirectory();
  const result = await sessionCommand([
    "doctor", "--provider", "stdio", "--state-dir", stateDir,
  ], {
    env: {
      CMUX_SOCKET_PATH: "/private/tmp/cmux-private.sock",
      CMUX_SOCKET_MODE: "allowAll",
    },
    sessionHost: {
      async preflight() {
        return { ok: true };
      },
    },
    hostConfig: {
      kind: "cmux",
      executable: "/tools/cmux",
      source: "explicit",
      connection: {
        environment: {
          CMUX_SOCKET_PATH: "/private/tmp/cmux-private.sock",
          CMUX_SOCKET_MODE: "allowAll",
        },
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.providerVerification.target, "stdout");
  assert.deepEqual(result.host.connection, {
    environmentKeys: ["CMUX_SOCKET_MODE", "CMUX_SOCKET_PATH"],
  });
  assert.doesNotMatch(JSON.stringify(result), /cmux-private\.sock|allowAll/);
});

test("doctor fails when the effective explicit provider target cannot be verified", async () => {
  const stateDir = temporaryDirectory();
  let hostPreflights = 0;
  const result = await sessionCommand([
    "doctor",
    "--provider", "tmux",
    "--target", "%999",
    "--host", "process",
    "--state-dir", stateDir,
  ], {
    env: {},
    providerDependencies: {
      spawnSync() {
        return {
          status: 1,
          stdout: "",
          stderr: "can't find pane: %999",
        };
      },
    },
    sessionHost: {
      async preflight() {
        hostPreflights += 1;
        return { ok: true };
      },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(hostPreflights, 0);
  assert.match(result.providerError, /can't find pane: %999/);
  assert.equal(result.host, null);
  assert.match(result.diagnosis, /can't find pane: %999/);
});

test("runtime readiness budgets include poll, provider verification, and launch scheduling", () => {
  const session = {
    provider: { name: "cmux" },
    slackConfig: { timeoutMs: 1_500 },
  };
  assert.equal(runtimeReadinessTimeoutMs(session, "process"), 24_000);
  assert.equal(runtimeReadinessTimeoutMs(session, "standalone"), 31_500);
  assert.equal(
    runtimeReadinessTimeoutMs(
      { ...session, provider: { name: "tmux" } },
      "standalone",
    ),
    21_500,
  );
  assert.equal(
    runtimeReadinessTimeoutMs(
      { ...session, provider: { name: "stdio" } },
      "standalone",
    ),
    11_500,
  );
  assert.equal(
    runtimeReadinessTimeoutMs(session, "standalone", { runtimeReadyTimeoutMs: 750 }),
    750,
  );
});

test("readiness wait returns immediately when the runtime reports a non-active failure", async () => {
  const store = new SessionStore(temporaryDirectory());
  const created = store.create({
    slack: {
      workspace: "https://example.slack.com",
      channelId: "D_SELF",
      threadTs: "100.000001",
      permalink: "https://example.slack.com/archives/D_SELF/p100000001",
    },
    provider: { name: "stdio", target: "stdout" },
    ownerUserId: "U_OWNER",
    allowedUserIds: [],
    pollIntervalMs: 3000,
    cursorTs: "100.000001",
  });
  store.update(created.id, (session) => {
    session.status = "runtime_failed";
    return session;
  });

  const startedAt = Date.now();
  const failed = await waitForRuntime(store, created.id, 1_000);
  assert.equal(failed.status, "runtime_failed");
  assert.ok(Date.now() - startedAt < 100);
});

test("standalone start preflights the host before Slack and persists attachment metadata", async () => {
  const stateDir = temporaryDirectory();
  const store = new SessionStore(stateDir);
  const args = parseArgs([
    "start",
    "--channel", "me",
    "--provider", "stdio",
    "--host", "auto",
    "--state-dir", stateDir,
  ]);
  args.effective = {};
  const calls = [];
  const host = fakeHostedSession(calls);
  const providerIdentity = {
    version: 1,
    provider: "test",
    fingerprint: "verified-target",
  };
  const result = await startSession(args, {
    store,
    provider: {
      target: "stdout",
      verify() {
        calls.push("provider");
        return {
          ok: true,
          target: "stdout",
          identity: providerIdentity,
        };
      },
    },
    slack: fakeSlack(calls),
    sessionHost: host,
    hostConfig: { kind: "cmux", executable: "/tools/cmux", source: "explicit" },
    env: {
      CODEX_THREAD_ID: "thread_123",
    },
    waitForRuntime(currentStore, id, milliseconds) {
      assert.equal(milliseconds, 40_000);
      currentStore.update(id, (session) => {
        session.pid = 42;
        session.bridge = { host: "127.0.0.1", port: 1234, url: "http://127.0.0.1:1234" };
        session.timings.runtimeReadyAt = "2026-07-27T12:00:00.500Z";
        session.timings.firstPollAt = "2026-07-27T12:00:01.000Z";
        session.timings.firstPollDurationMs = 29_500;
        return session;
      });
      return currentStore.get(id);
    },
  });

  assert.equal(result.mode, "standalone");
  assert.deepEqual(calls, [
    "provider",
    "host:preflight",
    "identity",
    "destination:me",
    "root",
    "host:create",
    "host:launch",
  ]);
  assert.equal(result.session.host.kind, "cmux");
  assert.equal(result.session.host.requestedKind, "auto");
  assert.equal(result.session.host.workspaceId, "workspace-host");
  assert.equal(result.session.attachment.agentSessionId, "thread_123");
  assert.equal(result.session.attachment.agentProvider, "codex");
  assert.deepEqual(
    store.get(result.session.id, { includeSecret: true }).provider.identity,
    providerIdentity,
  );
  assert.equal(result.session.slack.channelId, "D_SELF");
  assert.equal(result.start.host.workspaceId, "workspace-host");
  assert.equal(result.start.attachment.agentSessionId, "thread_123");
  assert.equal(result.start.timings.firstPollAt, "2026-07-27T12:00:01.000Z");
  assert.equal(result.start.timings.firstPollDurationMs, 29_500);
  assert.equal(result.start.timings.runtimeReadinessBudgetMs, 40_000);
  assert.equal(result.start.effective.host.resolved, "cmux");
  assert.equal(result.session.runtimeInstanceId, undefined);
  assert.match(
    store.get(result.session.id, { includeSecret: true }).runtimeInstanceId,
    /^runtime_[A-Za-z0-9_-]+$/,
  );
  assert.match(host.lastLaunchCommand, /--runtime-instance 'runtime_[A-Za-z0-9_-]+'/);
  assert.equal(
    host.lastCreateOptions.label,
    `Slack session ${result.session.id}`,
  );
  assert.equal(result.warning, null);
});

test("Herdr start persists the verified terminal and native agent-session identity", async () => {
  const stateDir = temporaryDirectory();
  const store = new SessionStore(stateDir);
  const args = parseArgs([
    "start",
    "--channel", "me",
    "--provider", "herdr",
    "--target", "w1:p1",
    "--host", "auto",
    "--state-dir", stateDir,
  ]);
  args.effective = {};
  const host = fakeHostedSession();
  const providerCalls = [];
  const originalAccessSync = fs.accessSync;
  fs.accessSync = (candidate) => {
    if (candidate === "/tools/herdr") return;
    const error = new Error("missing");
    error.code = "ENOENT";
    throw error;
  };
  try {
    const result = await startSession(args, {
      store,
      slack: fakeSlack(),
      sessionHost: host,
      hostConfig: { kind: "cmux", executable: "/tools/cmux", source: "explicit" },
      env: {
        PATH: "/tools",
        HERDR_SOCKET_PATH: "/private/tmp/herdr.sock",
        CODEX_THREAD_ID: "thread_123",
      },
      providerDependencies: {
        spawnSync(command, commandArgs) {
          providerCalls.push({ command, args: commandArgs });
          return {
            status: 0,
            stdout: JSON.stringify({
              result: {
                pane: {
                  workspace_id: "w1",
                  tab_id: "w1:t1",
                  pane_id: "w1:p1",
                  terminal_id: "term_123",
                  agent_session: {
                    source: "herdr:codex",
                    agent: "codex",
                    kind: "id",
                    value: "thread_123",
                  },
                },
              },
            }),
            stderr: "",
          };
        },
      },
      waitForRuntime(currentStore, id) {
        currentStore.update(id, (session) => {
          session.pid = 42;
          session.bridge = { host: "127.0.0.1", port: 1234, url: "http://127.0.0.1:1234" };
          session.timings.runtimeReadyAt = "2026-07-27T12:00:00.500Z";
          session.timings.firstPollAt = "2026-07-27T12:00:01.000Z";
          return session;
        });
        return currentStore.get(id);
      },
    });

    assert.deepEqual(providerCalls.map((call) => call.args), [
      ["pane", "get", "w1:p1"],
    ]);
    assert.deepEqual(
      store.get(result.session.id, { includeSecret: true }).provider.identity,
      {
        version: 1,
        provider: "herdr",
        workspaceId: "w1",
        tabId: "w1:t1",
        paneId: "w1:p1",
        terminalId: "term_123",
        agentSession: {
          source: "herdr:codex",
          agent: "codex",
          kind: "id",
          value: "thread_123",
        },
      },
    );
    assert.equal(result.session.attachment.agentSessionId, "thread_123");
  } finally {
    fs.accessSync = originalAccessSync;
  }
});

test("standalone hosts receive the persisted tmux and cmux connection context", async () => {
  const cases = [
    {
      provider: "tmux",
      target: "%42",
      env: {
        TMUX: "/private/tmp/custom-tmux/session.sock,4242,0",
        TMUX_TMPDIR: "/private/tmp/custom-tmux",
        TMUX_PANE: "%42",
        SECRET: "not-persisted",
      },
      expected: {
        TMUX: "/private/tmp/custom-tmux/session.sock,4242,0",
        TMUX_TMPDIR: "/private/tmp/custom-tmux",
      },
      excluded: ["TMUX_PANE", "SECRET"],
    },
    {
      provider: "cmux",
      target: "surface:original",
      env: {
        CMUX_SOCKET_PATH: "/private/tmp/cmux-custom.sock",
        CMUX_SOCKET_MODE: "allowAll",
        CMUX_WORKSPACE_ID: "workspace:original",
        CMUX_SURFACE_ID: "surface:original",
        SECRET: "not-persisted",
      },
      expected: {
        CMUX_SOCKET_PATH: "/private/tmp/cmux-custom.sock",
        CMUX_SOCKET_MODE: "allowAll",
      },
      excluded: ["CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID", "SECRET"],
    },
  ];

  for (const scenario of cases) {
    const stateDir = temporaryDirectory();
    const store = new SessionStore(stateDir);
    const args = parseArgs([
      "start",
      "--channel", "me",
      "--provider", scenario.provider,
      "--target", scenario.target,
      "--agent-session", "agent-native-123",
      "--host", "cmux",
      "--state-dir", stateDir,
    ]);
    const calls = [];
    const host = fakeHostedSession(calls);
    const result = await startSession(args, {
      store,
      provider: { verify() {} },
      slack: fakeSlack(calls),
      sessionHost: host,
      hostConfig: { kind: "cmux", executable: "/tools/cmux", source: "explicit" },
      env: scenario.env,
      waitForRuntime(currentStore, id) {
        currentStore.update(id, (session) => {
          session.pid = 42;
          session.bridge = { host: "127.0.0.1", port: 1234, url: "http://127.0.0.1:1234" };
          session.timings.runtimeReadyAt = "2026-07-27T12:00:00.500Z";
          session.timings.firstPollAt = "2026-07-27T12:00:01.000Z";
          return session;
        });
        return currentStore.get(id);
      },
    });

    assert.deepEqual(
      store.get(result.session.id, { includeSecret: true }).provider.connection.environment,
      scenario.expected,
    );
    assert.deepEqual(result.session.provider.connection, {
      environmentKeys: Object.keys(scenario.expected).sort(),
    });
    for (const [key, value] of Object.entries(scenario.expected)) {
      assert.equal(host.lastCreateOptions.environment[key], value);
      assert.match(host.lastLaunchCommand, new RegExp(`${key}='${value.replaceAll(".", "\\.")}'`));
    }
    for (const key of scenario.excluded) {
      assert.equal(host.lastCreateOptions.environment[key], undefined);
      assert.equal(host.lastLaunchCommand.includes(`${key}=`), false);
    }
    assert.equal(
      host.lastCreateOptions.environment.SLACK_AGENT_TARGET_SESSION_ID,
      "agent-native-123",
    );
    assert.match(host.lastLaunchCommand, /SLACK_AGENT_TARGET_SESSION_ID='agent-native-123'/);
  }
});

test("process-host spawn applies the stored provider endpoint environment", () => {
  const store = new SessionStore(temporaryDirectory());
  const created = store.create({
    runtimeInstanceId: "runtime_test_process_spawn",
    slack: {
      workspace: "https://example.slack.com",
      channelId: "D_SELF",
      threadTs: "100.000001",
      permalink: "https://example.slack.com/archives/D_SELF/p100000001",
    },
    provider: {
      name: "tmux",
      target: "%42",
      connection: {
        environment: {
          TMUX: "/private/tmp/custom-tmux/session.sock,4242,0",
          TMUX_TMPDIR: "/private/tmp/custom-tmux",
        },
      },
    },
    attachment: {
      agentSessionId: "agent-native-123",
      agentProvider: "codex",
      worktree: process.cwd(),
      provider: "tmux",
      target: "%42",
    },
    ownerUserId: "U_OWNER",
    allowedUserIds: [],
    pollIntervalMs: 3000,
    cursorTs: "100.000001",
  });
  let spawned = null;
  let unrefCalled = false;
  const result = spawnRuntime(
    {},
    store.get(created.id, { includeSecret: true }),
    store,
    {
      env: { BASE_ENV: "retained", TMUX: "wrong-socket" },
      spawn(command, args, options) {
        spawned = { command, args, options };
        return {
          pid: 4242,
          unref() {
            unrefCalled = true;
          },
        };
      },
    },
  );

  assert.equal(result.pid, 4242);
  assert.equal(unrefCalled, true);
  assert.deepEqual(
    spawned.args.slice(0, 6),
    [
      path.resolve(__dirname, "../slack-api-session.cjs"),
      "run",
      "--id", created.id,
      "--runtime-instance", "runtime_test_process_spawn",
    ],
  );
  assert.equal(spawned.options.env.BASE_ENV, "retained");
  assert.equal(
    spawned.options.env.TMUX,
    "/private/tmp/custom-tmux/session.sock,4242,0",
  );
  assert.equal(spawned.options.env.TMUX_TMPDIR, "/private/tmp/custom-tmux");
  assert.equal(spawned.options.env.SLACK_AGENT_SESSION_ID, created.id);
  assert.equal(spawned.options.env.SLACK_AGENT_TARGET_SESSION_ID, "agent-native-123");
});

test("standalone host create and readiness failures leave a stopped, auditable session", async () => {
  for (const failure of ["create", "readiness"]) {
    const stateDir = temporaryDirectory();
    const store = new SessionStore(stateDir);
    const args = parseArgs([
      "start",
      "--channel", "me",
      "--provider", "stdio",
      "--host", "cmux",
      "--state-dir", stateDir,
    ]);
    const calls = [];
    const host = fakeHostedSession(calls);
    if (failure === "create") {
      host.create = async () => {
        calls.push("host:create");
        throw new Error("workspace create failed");
      };
    }

    await assert.rejects(
      startSession(args, {
        store,
        provider: { verify() { calls.push("provider"); } },
        slack: fakeSlack(calls),
        sessionHost: host,
        hostConfig: { kind: "cmux", executable: "/tools/cmux", source: "explicit" },
        env: {},
        waitForRuntime(currentStore, id) {
          return currentStore.get(id);
        },
      }),
      failure === "create" ? /workspace create failed/ : /did not report runtime.*readiness/,
    );

    const [failed] = store.list();
    assert.equal(failed.status, "startup_failed");
    assert.equal(failed.pid, null);
    if (failure === "create") {
      assert.equal(failed.host.status, "create_failed");
      assert.equal(failed.host.managed, false);
    } else {
      assert.equal(calls.includes("host:close"), true);
    }
  }
});

test("readiness cleanup signals the listener when standalone host close fails", async () => {
  const stateDir = temporaryDirectory();
  const store = new SessionStore(stateDir);
  const args = parseArgs([
    "start",
    "--channel", "me",
    "--provider", "stdio",
    "--host", "cmux",
    "--state-dir", stateDir,
  ]);
  const calls = [];
  const host = fakeHostedSession(calls);
  host.close = async () => {
    calls.push("host:close");
    throw new Error("host server unavailable");
  };
  let alive = true;
  const signals = [];

  await assert.rejects(
    startSession(args, {
      store,
      provider: { verify() { calls.push("provider"); } },
      slack: fakeSlack(calls),
      sessionHost: host,
      hostConfig: { kind: "cmux", executable: "/tools/cmux", source: "explicit" },
      env: {},
      waitForRuntime(currentStore, id) {
        currentStore.update(id, (session) => {
          session.pid = 4242;
          session.host.pid = 4242;
          return session;
        });
        return currentStore.get(id);
      },
      processIsAlive() { return alive; },
      runtimeOwnershipVerifier() { return true; },
      killProcess(pid, signal) {
        signals.push({ pid, signal });
        alive = false;
      },
      runtimeStopTimeoutMs: 100,
    }),
    /did not report runtime.*readiness/,
  );

  assert.deepEqual(signals, [{ pid: 4242, signal: "SIGTERM" }]);
  assert.equal(store.list()[0].status, "startup_failed");
  assert.equal(
    store.readEvents(store.list()[0].id)
      .some((event) => event.type === "runtime_signalled_after_host_cleanup_failure"),
    true,
  );
});

test("ambiguous standalone start launch signals a surviving runtime after host close", async () => {
  const stateDir = temporaryDirectory();
  const store = new SessionStore(stateDir);
  const args = parseArgs([
    "start",
    "--channel", "me",
    "--provider", "stdio",
    "--host", "cmux",
    "--state-dir", stateDir,
  ]);
  const calls = [];
  const host = fakeHostedSession(calls);
  host.launch = async () => {
    calls.push("host:launch");
    const [created] = store.list();
    store.update(created.id, (session) => {
      session.pid = 4242;
      session.host.pid = 4242;
      session.bridge = { host: "127.0.0.1", port: 9999, url: "http://127.0.0.1:9999" };
      return session;
    });
    throw new Error("launch acknowledgement lost");
  };
  let alive = true;
  const signals = [];

  await assert.rejects(
    startSession(args, {
      store,
      provider: { verify() {} },
      slack: fakeSlack(),
      sessionHost: host,
      hostConfig: { kind: "cmux", executable: "/tools/cmux", source: "explicit" },
      processIsAlive() { return alive; },
      runtimeOwnershipVerifier() { return true; },
      killProcess(pid, signal) {
        signals.push({ pid, signal });
        alive = false;
      },
      runtimeStopTimeoutMs: 100,
      env: {},
    }),
    /launch acknowledgement lost/,
  );

  const [failed] = store.list();
  assert.deepEqual(signals, [{ pid: 4242, signal: "SIGTERM" }]);
  assert.equal(failed.status, "startup_failed");
  assert.equal(failed.pid, null);
  assert.equal(failed.bridge.port, null);
  assert.equal(failed.host.status, "launch_failed");
  assert.ok(failed.host.closedAt);
  const events = store.readEvents(failed.id);
  assert.equal(events.some((event) => event.type === "runtime_host_launch_failed"), true);
  assert.equal(events.some((event) => event.type === "runtime_launch_failed"), true);
});

test("ambiguous standalone restart launch preserves cleanup diagnostics and stops its runtime", async () => {
  const stateDir = temporaryDirectory();
  const store = new SessionStore(stateDir);
  const created = store.create({
    slack: {
      workspace: "https://example.slack.com",
      channelId: "D_SELF",
      threadTs: "100.000001",
      permalink: "https://example.slack.com/archives/D_SELF/p100000001",
    },
    provider: { name: "stdio", target: "stdout" },
    host: {
      kind: "cmux",
      target: "surface-old",
      managed: true,
      workspaceId: "workspace-old",
      executable: "/tools/cmux",
      status: "closed",
      closedAt: "2026-07-27T12:00:00.000Z",
    },
    ownerUserId: "U_OWNER",
    allowedUserIds: [],
    pollIntervalMs: 3000,
    cursorTs: "100.000001",
  });
  const host = fakeHostedSession();
  host.launch = async () => {
    store.update(created.id, (session) => {
      session.pid = 5252;
      session.host.pid = 5252;
      session.bridge = { host: "127.0.0.1", port: 9998, url: "http://127.0.0.1:9998" };
      return session;
    });
    throw new Error("restart launch acknowledgement lost");
  };
  host.close = async () => {
    throw new Error("host close unavailable");
  };
  let alive = true;
  const signals = [];

  await assert.rejects(
    sessionCommand([
      "restart", "--id", created.id, "--state-dir", stateDir,
    ], {
      store,
      sessionHost: host,
      hostConfig: { kind: "cmux", executable: "/tools/cmux", source: "saved_session" },
      processIsAlive() { return alive; },
      runtimeOwnershipVerifier() { return true; },
      killProcess(pid, signal) {
        signals.push({ pid, signal });
        alive = false;
      },
      runtimeStopTimeoutMs: 100,
      env: {},
    }),
    /restart launch acknowledgement lost/,
  );

  const failed = store.get(created.id, { includeSecret: true });
  assert.deepEqual(signals, [{ pid: 5252, signal: "SIGTERM" }]);
  assert.equal(failed.status, "restart_failed");
  assert.equal(failed.pid, null);
  assert.equal(failed.bridge.port, null);
  assert.equal(failed.host.status, "cleanup_pending");
  assert.equal(failed.host.cleanup.pending, true);
  assert.match(failed.host.cleanup.error, /host close unavailable/);
});

test("partial cmux creation remains recoverable across socket changes and restart", async () => {
  const stateDir = temporaryDirectory();
  const store = new SessionStore(stateDir);
  const executable = "/tools/cmux";
  const socketA = "/private/tmp/cmux-a.sock";
  const socketB = "/private/tmp/cmux-b.sock";
  const hostConfig = {
    kind: "cmux",
    executable,
    source: "explicit",
    connection: {
      environment: {
        CMUX_SOCKET_PATH: socketA,
        CMUX_SOCKET_MODE: "allowAll",
      },
    },
  };
  const createCalls = [];
  const host = new CmuxSessionHost(hostConfig, {
    env: {
      CMUX_SOCKET_PATH: socketA,
      CMUX_SOCKET_MODE: "allowAll",
      CMUX_WORKSPACE_ID: "workspace:caller-a",
      CMUX_SURFACE_ID: "surface:caller-a",
    },
    spawnSync: scriptedSpawn([
      { stdout: "pong\n" },
      { stdout: JSON.stringify({ workspace_id: "workspace:partial" }) },
      { stdout: JSON.stringify({ workspace_id: "workspace:partial" }) },
      { status: 1, stderr: `temporarily unavailable at ${socketA}` },
    ], createCalls),
  });
  const args = parseArgs([
    "start",
    "--channel", "me",
    "--provider", "stdio",
    "--host", "cmux",
    "--state-dir", stateDir,
  ]);

  await assert.rejects(
    startSession(args, {
      store,
      provider: { verify() {} },
      slack: fakeSlack(),
      sessionHost: host,
      hostConfig,
      env: {
        CMUX_SOCKET_PATH: socketA,
        CMUX_SOCKET_MODE: "allowAll",
      },
    }),
    /could not recover root pane and surface ids/,
  );

  const [failedPublic] = store.list();
  const failedPrivate = store.get(failedPublic.id, { includeSecret: true });
  assert.equal(failedPrivate.status, "startup_failed");
  assert.equal(failedPrivate.host.status, "cleanup_pending");
  assert.equal(failedPrivate.host.managed, true);
  assert.equal(failedPrivate.host.workspaceId, "workspace:partial");
  assert.equal(failedPrivate.host.cleanup.pending, true);
  assert.match(failedPrivate.host.cleanup.error, /temporarily unavailable/);
  assert.doesNotMatch(failedPrivate.host.cleanup.error, /cmux-a\.sock/);
  assert.deepEqual(failedPrivate.host.connection, hostConfig.connection);
  assert.deepEqual(failedPublic.host.connection, {
    environmentKeys: ["CMUX_SOCKET_MODE", "CMUX_SOCKET_PATH"],
  });
  assert.doesNotMatch(JSON.stringify(failedPublic), /cmux-a\.sock|allowAll/);

  const environmentB = {
    PATH: "/tools",
    CMUX_SOCKET_PATH: socketB,
    CMUX_SOCKET_MODE: "allowLocal",
    CMUX_WORKSPACE_ID: "workspace:caller-b",
    CMUX_SURFACE_ID: "surface:caller-b",
    CMUX_TAB_ID: "tab:caller-b",
  };
  const accessSync = (candidate) => {
    if (candidate === executable) return;
    throw new Error("missing");
  };
  const inspectCalls = [];
  const shown = await sessionCommand([
    "show", "--verbose", "--id", failedPublic.id, "--state-dir", stateDir,
  ], {
    store,
    env: environmentB,
    hostResolutionDependencies: { accessSync },
    hostDependencies: {
      spawnSync: scriptedSpawn([{
        stdout: JSON.stringify({
          workspace_id: "workspace:partial",
          pane_id: "pane:partial",
          surface_id: "surface:partial",
        }),
      }], inspectCalls),
    },
    processIsAlive() {
      return false;
    },
  });
  assert.equal(shown.hostStatus.exists, null);
  assert.equal(shown.hostStatus.owned, false);
  assert.equal(shown.hostStatus.reason, "partial_create_cleanup_only");
  assert.equal(shown.hostStatus.ownership.partialCreateCleanupOnly, true);
  assert.equal(shown.hostStatus.descriptor.workspaceId, "workspace:partial");
  assert.equal(shown.hostStatus.descriptor.paneId, null);
  assert.equal(shown.hostStatus.descriptor.surfaceId, null);
  assert.deepEqual(shown.hostStatus.descriptor.connection, {
    environmentKeys: ["CMUX_SOCKET_MODE", "CMUX_SOCKET_PATH"],
  });
  assert.doesNotMatch(JSON.stringify(shown), /cmux-a\.sock|allowAll/);
  assert.equal(inspectCalls.length, 0);

  const closeCalls = [];
  const stopped = await sessionCommand([
    "stop", "--id", failedPublic.id, "--state-dir", stateDir,
  ], {
    store,
    env: environmentB,
    hostResolutionDependencies: { accessSync },
    hostDependencies: {
      spawnSync: scriptedSpawn([{ stdout: "{}" }], closeCalls),
    },
    processIsAlive() {
      return false;
    },
  });
  assert.equal(stopped.host.closed, true);
  assert.equal(stopped.session.host.status, "closed");
  assert.equal(stopped.session.host.cleanup.pending, false);
  assert.deepEqual(closeCalls[0].args, [
    "--json",
    "--id-format",
    "uuids",
    "workspace",
    "close",
    "workspace:partial",
  ]);
  assert.equal(closeCalls[0].options.env.CMUX_SOCKET_PATH, socketA);
  assert.equal(closeCalls[0].options.env.CMUX_SOCKET_MODE, "allowAll");
  assert.equal(closeCalls[0].options.env.CMUX_WORKSPACE_ID, undefined);
  assert.equal(closeCalls[0].options.env.CMUX_SURFACE_ID, undefined);
  assert.equal(closeCalls[0].options.env.CMUX_TAB_ID, undefined);

  const restartCalls = [];
  const restarted = await sessionCommand([
    "restart", "--id", failedPublic.id, "--state-dir", stateDir,
  ], {
    store,
    env: environmentB,
    hostResolutionDependencies: { accessSync },
    hostDependencies: {
      spawnSync: scriptedSpawn([
        { stdout: "pong\n" },
        {
          stdout: JSON.stringify({
            workspace_id: "workspace:restarted",
            pane_id: "pane:restarted",
            surface_id: "surface:restarted",
          }),
        },
        {
          stdout: JSON.stringify({
            workspace_id: "workspace:restarted",
            pane_id: "pane:restarted",
            surface_id: "surface:restarted",
          }),
        },
        { stdout: "" },
        { stdout: "" },
      ], restartCalls),
    },
    processIsAlive() {
      return false;
    },
    waitForRuntime(currentStore, id) {
      currentStore.update(id, (session) => {
        session.pid = 99;
        session.bridge = { host: "127.0.0.1", port: 9999, url: "http://127.0.0.1:9999" };
        session.timings.runtimeReadyAt = "2026-07-27T12:00:02.500Z";
        session.timings.firstPollAt = "2026-07-27T12:00:03.000Z";
        return session;
      });
      return currentStore.get(id);
    },
  });
  assert.equal(restarted.session.host.workspaceId, "workspace:restarted");
  for (const call of restartCalls) {
    assert.equal(call.options.env.CMUX_SOCKET_PATH, socketA);
    assert.equal(call.options.env.CMUX_SOCKET_MODE, "allowAll");
    assert.equal(call.options.env.CMUX_WORKSPACE_ID, undefined);
    assert.equal(call.options.env.CMUX_SURFACE_ID, undefined);
    assert.equal(call.options.env.CMUX_TAB_ID, undefined);
  }
});

test("stop closes only the managed host and restart preserves the Slack binding", async () => {
  const stateDir = temporaryDirectory();
  const store = new SessionStore(stateDir);
  const created = store.create({
    slack: {
      workspace: "https://example.slack.com",
      channelId: "D_SELF",
      threadTs: "100.000001",
      permalink: "https://example.slack.com/archives/D_SELF/p100000001",
      bindingMode: "created_thread",
    },
    provider: { name: "stdio", target: "stdout" },
    host: {
      kind: "cmux",
      target: "surface-host",
      managed: true,
      workspaceId: "workspace-host",
      paneId: "pane-host",
      surfaceId: "surface-host",
      executable: "/tools/cmux",
    },
    attachment: {
      agentSessionId: "thread_123",
      agentProvider: "codex",
      worktree: process.cwd(),
      provider: "stdio",
      target: "stdout",
    },
    ownerUserId: "U_OWNER",
    allowedUserIds: [],
    pollIntervalMs: 3000,
    cursorTs: "100.000001",
  });
  const calls = [];
  const host = fakeHostedSession(calls);
  store.update(created.id, (session) => {
    session.timings.runtimeReadinessMs = 123_456;
    return session;
  });

  const stopped = await sessionCommand([
    "stop", "--id", created.id, "--state-dir", stateDir,
  ], { store, sessionHost: host, env: {} });
  assert.equal(stopped.session.status, "stopped");
  assert.equal(stopped.host.closed, true);
  assert.equal(calls.filter((call) => call === "host:close").length, 1);

  const restarted = await sessionCommand([
    "restart", "--id", created.id, "--state-dir", stateDir,
  ], {
    store,
    sessionHost: host,
    hostConfig: { kind: "cmux", executable: "/tools/cmux", source: "saved_session" },
    env: {},
    waitForRuntime(currentStore, id, milliseconds) {
      assert.equal(milliseconds, 40_000);
      assert.equal(currentStore.get(id).timings.runtimeReadinessMs, null);
      currentStore.update(id, (session) => {
        session.pid = 99;
        session.bridge = { host: "127.0.0.1", port: 9999, url: "http://127.0.0.1:9999" };
        session.timings.runtimeReadyAt = "2026-07-27T12:00:02.500Z";
        session.timings.firstPollAt = "2026-07-27T12:00:03.000Z";
        return session;
      });
      return currentStore.get(id);
    },
  });

  assert.equal(restarted.mode, "standalone");
  assert.equal(restarted.session.status, "active");
  assert.equal(restarted.session.slack.channelId, "D_SELF");
  assert.equal(restarted.session.slack.threadTs, "100.000001");
  assert.equal(restarted.session.host.workspaceId, "workspace-host");
  assert.equal(restarted.session.host.status, "running");
  assert.ok(Number.isFinite(restarted.session.timings.runtimeReadinessMs));
  assert.equal(calls.filter((call) => call === "host:close").length, 1);
  assert.equal(calls.filter((call) => call === "host:create").length, 1);
  assert.equal(calls.filter((call) => call === "host:launch").length, 1);

  const reused = await sessionCommand([
    "restart", "--id", created.id, "--keep-host", "--state-dir", stateDir,
  ], {
    store,
    sessionHost: host,
    hostConfig: { kind: "cmux", executable: "/tools/cmux", source: "saved_session" },
    env: {},
    processIsAlive() { return false; },
    waitForRuntime(currentStore, id, milliseconds) {
      assert.equal(milliseconds, 40_000);
      assert.equal(currentStore.get(id).timings.runtimeReadinessMs, null);
      currentStore.update(id, (session) => {
        session.pid = 100;
        session.bridge = { host: "127.0.0.1", port: 10000, url: "http://127.0.0.1:10000" };
        session.timings.runtimeReadyAt = "2026-07-27T12:00:04.000Z";
        session.timings.firstPollAt = "2026-07-27T12:00:04.500Z";
        return session;
      });
      return currentStore.get(id);
    },
  });
  assert.equal(reused.session.host.keepOpenOnStop, false);
  assert.equal(reused.session.host.status, "running");
  assert.ok(Number.isFinite(reused.session.timings.runtimeReadinessMs));
  assert.equal(calls.filter((call) => call === "host:close").length, 1);
  assert.equal(calls.filter((call) => call === "host:create").length, 1);
  assert.equal(calls.filter((call) => call === "host:launch").length, 2);

  store.update(created.id, (session) => {
    session.host.connection = {
      environment: { CMUX_SOCKET_PATH: "/private/socket-a" },
    };
    return session;
  });
  const kept = await sessionCommand([
    "stop", "--id", created.id, "--keep-host", "--state-dir", stateDir,
  ], {
    store,
    sessionHost: host,
    processIsAlive() { return false; },
    env: {},
  });
  assert.deepEqual(kept.host.descriptor.connection.environmentKeys, ["CMUX_SOCKET_PATH"]);
  assert.doesNotMatch(JSON.stringify(kept), /private\/socket-a/);
});

test("auto restart re-resolves its host and can migrate a process fallback to cmux", async () => {
  const stateDir = temporaryDirectory();
  const store = new SessionStore(stateDir);
  const created = storedSession(store, {
    kind: "process",
    requestedKind: "auto",
    target: null,
    managed: true,
    status: "running",
  });
  const before = store.get(created.id, { includeSecret: true });
  const calls = [];
  const host = fakeHostedSession(calls);

  const restarted = await sessionCommand([
    "restart", "--id", created.id, "--state-dir", stateDir,
  ], {
    store,
    sessionHost: host,
    hostConfig: {
      kind: "cmux",
      executable: "/tools/cmux-current",
      source: "available_cli",
      connection: { environment: { CMUX_SOCKET_PATH: "/current/cmux.sock" } },
    },
    waitForRuntime: reportRuntimeReady,
    env: {},
  });

  const privateSession = store.get(created.id, { includeSecret: true });
  assert.equal(restarted.session.host.kind, "cmux");
  assert.equal(restarted.session.host.requestedKind, "auto");
  assert.equal(host.lastCreateOptions.windowId, null);
  assert.equal(calls.includes("host:close"), false);
  assert.deepEqual(privateSession.slack, before.slack);
  assert.deepEqual(privateSession.provider, before.provider);
  assert.deepEqual(privateSession.attachment, before.attachment);
});

test("an explicit restart host uses the current endpoint and commits policy after readiness", async () => {
  const stateDir = temporaryDirectory();
  const store = new SessionStore(stateDir);
  const created = storedSession(store, {
    kind: "cmux",
    requestedKind: "auto",
    target: "surface-old",
    workspaceId: "workspace-old",
    surfaceId: "surface-old",
    windowId: "window-old",
    managed: true,
    executable: "/tools/cmux-old",
    connection: { environment: { CMUX_SOCKET_PATH: "/old/cmux.sock" } },
    status: "closed",
    closedAt: "2026-07-27T12:00:00.000Z",
  });
  const calls = [];
  const host = fakeHostedSession(calls);

  const restarted = await sessionCommand([
    "restart", "--id", created.id,
    "--host", "cmux",
    "--state-dir", stateDir,
  ], {
    store,
    sessionHost: host,
    env: {
      CMUX_BIN_PATH: "/tools/cmux-current",
      CMUX_SOCKET_PATH: "/current/cmux.sock",
    },
    hostResolutionDependencies: {
      accessSync(candidate) {
        if (candidate !== "/tools/cmux-current") throw new Error(`unexpected ${candidate}`);
      },
    },
    waitForRuntime: reportRuntimeReady,
  });

  const privateSession = store.get(created.id, { includeSecret: true });
  assert.equal(restarted.session.host.kind, "cmux");
  assert.equal(restarted.session.host.requestedKind, "cmux");
  assert.equal(privateSession.host.connection.environment.CMUX_SOCKET_PATH, "/current/cmux.sock");
  assert.equal(host.lastCreateOptions.windowId, null);
});

test("a stored fixed host policy preserves its original endpoint and window", async () => {
  const stateDir = temporaryDirectory();
  const store = new SessionStore(stateDir);
  const created = storedSession(store, {
    kind: "cmux",
    requestedKind: "cmux",
    target: "surface-old",
    workspaceId: "workspace-old",
    surfaceId: "surface-old",
    windowId: "window-old",
    managed: true,
    executable: "/tools/cmux-old",
    connection: { environment: { CMUX_SOCKET_PATH: "/old/cmux.sock" } },
    status: "closed",
    closedAt: "2026-07-27T12:00:00.000Z",
  });
  const host = fakeHostedSession();

  const restarted = await sessionCommand([
    "restart", "--id", created.id, "--state-dir", stateDir,
  ], {
    store,
    sessionHost: host,
    env: {
      CMUX_BIN_PATH: "/tools/cmux-current",
      CMUX_SOCKET_PATH: "/current/cmux.sock",
    },
    hostResolutionDependencies: {
      accessSync(candidate) {
        if (candidate !== "/tools/cmux-old") throw new Error(`unexpected ${candidate}`);
      },
    },
    waitForRuntime: reportRuntimeReady,
  });

  const privateSession = store.get(created.id, { includeSecret: true });
  assert.equal(restarted.session.host.requestedKind, "cmux");
  assert.equal(privateSession.host.connection.environment.CMUX_SOCKET_PATH, "/old/cmux.sock");
  assert.equal(host.lastCreateOptions.windowId, "window-old");
});

test("legacy sessions without requestedKind use their resolved host as fixed policy", async () => {
  const stateDir = temporaryDirectory();
  const store = new SessionStore(stateDir);
  const created = storedSession(store, {
    kind: "process",
    target: null,
    managed: true,
    status: "stopped",
  });
  let spawnedArgs = null;
  const host = fakeHostedSession();

  const restarted = await sessionCommand([
    "restart", "--id", created.id, "--state-dir", stateDir,
  ], {
    store,
    sessionHost: host,
    hostConfig: { kind: "process", executable: null, source: "explicit" },
    spawn(command, args) {
      spawnedArgs = args;
      return { pid: 8080, unref() {} };
    },
    waitForRuntime: reportRuntimeReady,
    env: {},
  });

  assert.equal(restarted.mode, "detached");
  assert.equal(restarted.session.host.requestedKind, "process");
  assert.equal(spawnedArgs.includes("--runtime-instance"), true);
});

test("restart keep-host conflicts with explicit host selection before mutation", async () => {
  const stateDir = temporaryDirectory();
  const store = new SessionStore(stateDir);
  const created = storedSession(store, {
    kind: "cmux",
    requestedKind: "auto",
    target: "surface-old",
    workspaceId: "workspace-old",
    surfaceId: "surface-old",
    managed: true,
    status: "running",
  });

  await assert.rejects(
    sessionCommand([
      "restart", "--id", created.id,
      "--keep-host", "--host", "cmux",
      "--state-dir", stateDir,
    ], { store, env: {} }),
    /--keep-host and --host are mutually exclusive/,
  );
  assert.equal(store.get(created.id).status, "active");
  assert.equal(store.get(created.id).host.keepOpenOnStop, undefined);
});

test("restart keep-host rejects a missing exact managed host without stopping the runtime", async () => {
  const stateDir = temporaryDirectory();
  const store = new SessionStore(stateDir);
  const created = storedSession(store, {
    kind: "cmux",
    requestedKind: "auto",
    target: "surface-old",
    workspaceId: "workspace-old",
    surfaceId: "surface-old",
    managed: true,
    executable: "/tools/cmux",
    status: "running",
  });
  const calls = [];
  const host = fakeHostedSession(calls);
  host.inspect = async (descriptor) => {
    calls.push("host:inspect");
    return { ok: true, exists: false, descriptor };
  };

  await assert.rejects(
    sessionCommand([
      "restart", "--id", created.id,
      "--keep-host",
      "--state-dir", stateDir,
    ], {
      store,
      sessionHost: host,
      hostConfig: { kind: "cmux", executable: "/tools/cmux", source: "saved_session" },
      env: {},
    }),
    /exact managed host is missing|ownership could not be verified/,
  );
  assert.equal(store.get(created.id).status, "active");
  assert.equal(calls.includes("host:launch"), false);
  assert.equal(calls.includes("host:close"), false);
});

test("restart preflight failure leaves the old runtime and host untouched", async () => {
  const stateDir = temporaryDirectory();
  const store = new SessionStore(stateDir);
  const created = storedSession(store, {
    kind: "cmux",
    requestedKind: "cmux",
    target: "surface-old",
    workspaceId: "workspace-old",
    surfaceId: "surface-old",
    managed: true,
    executable: "/tools/cmux",
    status: "running",
  }, { runtimeInstanceId: "runtime_old_healthy" });
  store.update(created.id, (session) => {
    session.pid = 31337;
    session.host.pid = 31337;
    return session;
  });
  const calls = [];
  const host = fakeHostedSession(calls);
  host.preflight = async () => {
    calls.push("host:preflight");
    throw new Error("new Herdr server unavailable");
  };
  let killed = false;

  await assert.rejects(
    sessionCommand([
      "restart", "--id", created.id,
      "--host", "herdr",
      "--state-dir", stateDir,
    ], {
      store,
      sessionHost: host,
      hostConfig: { kind: "herdr", executable: "/tools/herdr", source: "explicit" },
      processIsAlive() { return true; },
      runtimeOwnershipVerifier() { return true; },
      killProcess() { killed = true; },
      env: {},
    }),
    /new Herdr server unavailable/,
  );

  const unchanged = store.get(created.id, { includeSecret: true });
  assert.equal(unchanged.status, "active");
  assert.equal(unchanged.pid, 31337);
  assert.equal(unchanged.host.kind, "cmux");
  assert.equal(unchanged.host.closedAt, undefined);
  assert.equal(killed, false);
  assert.equal(calls.includes("host:close"), false);
});

test("restart provider verification failure is non-destructive", async () => {
  const stateDir = temporaryDirectory();
  const store = new SessionStore(stateDir);
  const created = storedSession(store, {
    kind: "process",
    requestedKind: "auto",
    managed: true,
    status: "running",
  });
  const calls = [];
  const host = fakeHostedSession(calls);

  await assert.rejects(
    sessionCommand([
      "restart", "--id", created.id, "--state-dir", stateDir,
    ], {
      store,
      restartProvider: {
        verify() {
          throw new Error("persisted provider target is gone");
        },
      },
      sessionHost: host,
      hostConfig: { kind: "cmux", executable: "/tools/cmux", source: "available_cli" },
      env: {},
    }),
    /persisted provider target is gone/,
  );
  assert.equal(store.get(created.id).status, "active");
  assert.deepEqual(calls, []);
});

test("failed explicit restart does not replace the stored host policy", async () => {
  const stateDir = temporaryDirectory();
  const store = new SessionStore(stateDir);
  const created = storedSession(store, {
    kind: "process",
    requestedKind: "auto",
    managed: true,
    status: "stopped",
  });
  const host = fakeHostedSession();

  await assert.rejects(
    sessionCommand([
      "restart", "--id", created.id,
      "--host", "cmux",
      "--state-dir", stateDir,
    ], {
      store,
      sessionHost: host,
      hostConfig: { kind: "cmux", executable: "/tools/cmux", source: "explicit" },
      waitForRuntime(currentStore, id) {
        return currentStore.get(id);
      },
      env: {},
    }),
    /did not report runtime.*readiness/,
  );

  const failed = store.get(created.id);
  assert.equal(failed.status, "restart_failed");
  assert.equal(failed.host.kind, "cmux");
  assert.equal(failed.host.requestedKind, "auto");
});

test("host migration closes only the old managed host", async () => {
  const stateDir = temporaryDirectory();
  const store = new SessionStore(stateDir);
  const created = storedSession(store, {
    kind: "cmux",
    requestedKind: "auto",
    target: "surface-old",
    workspaceId: "workspace-old",
    surfaceId: "surface-old",
    managed: true,
    executable: "/tools/cmux-old",
    status: "running",
  });
  const oldCalls = [];
  const newCalls = [];
  const oldHost = fakeHostedSession(oldCalls);
  const newHost = fakeHostedSession(newCalls);
  newHost.create = async (options) => {
    newCalls.push("host:create");
    newHost.lastCreateOptions = options;
    return {
      kind: "herdr",
      target: "pane-new",
      managed: true,
      workspaceId: "workspace-new",
      paneId: "pane-new",
      executable: "/tools/herdr",
      createdAt: "2026-07-27T12:00:00.000Z",
    };
  };

  const restarted = await sessionCommand([
    "restart", "--id", created.id, "--state-dir", stateDir,
  ], {
    store,
    oldSessionHost: oldHost,
    sessionHost: newHost,
    hostConfig: { kind: "herdr", executable: "/tools/herdr", source: "available_cli" },
    waitForRuntime: reportRuntimeReady,
    env: {},
  });

  assert.equal(restarted.session.host.kind, "herdr");
  assert.equal(restarted.session.host.requestedKind, "auto");
  assert.equal(oldCalls.filter((call) => call === "host:close").length, 1);
  assert.equal(newCalls.filter((call) => call === "host:close").length, 0);
  assert.equal(newCalls.filter((call) => call === "host:create").length, 1);
});

test("restart close failure persists sanitized cleanup debt for a later retry", async () => {
  const stateDir = temporaryDirectory();
  const store = new SessionStore(stateDir);
  const socketPath = "/private/tmp/private-restart-close.sock";
  const created = storedSession(store, {
    kind: "cmux",
    requestedKind: "auto",
    target: "surface-old",
    workspaceId: "workspace-old",
    surfaceId: "surface-old",
    managed: true,
    executable: "/tools/cmux-old",
    status: "running",
    connection: {
      environment: { CMUX_SOCKET_PATH: socketPath },
    },
  });
  const oldHost = fakeHostedSession();
  oldHost.close = async () => {
    throw new Error(`old host close failed through ${socketPath}`);
  };
  const newHost = fakeHostedSession();

  await assert.rejects(
    sessionCommand([
      "restart", "--id", created.id, "--state-dir", stateDir,
    ], {
      store,
      oldSessionHost: oldHost,
      sessionHost: newHost,
      hostConfig: { kind: "herdr", executable: "/tools/herdr", source: "available_cli" },
      processIsAlive() { return false; },
      env: {},
    }),
    /old host close failed.*redacted host connection/i,
  );
  const failed = store.get(created.id, { includeSecret: true });
  assert.equal(failed.status, "restart_failed");
  assert.equal(failed.host.kind, "cmux");
  assert.equal(failed.host.status, "cleanup_pending");
  assert.equal(failed.host.cleanup.pending, true);
  assert.match(failed.host.cleanup.error, /redacted host connection/);
  assert.doesNotMatch(failed.host.cleanup.error, /private-restart-close\.sock/);
  assert.doesNotMatch(JSON.stringify(store.get(created.id)), /private-restart-close\.sock/);

  oldHost.close = async (descriptor) => ({
    ok: true,
    closed: true,
    descriptor: {
      ...descriptor,
      closedAt: "2026-07-27T12:00:04.000Z",
      cleanup: {
        ...descriptor.cleanup,
        pending: false,
        recoveredAt: "2026-07-27T12:00:04.000Z",
      },
    },
  });
  const recovered = await sessionCommand([
    "stop", "--id", created.id, "--state-dir", stateDir,
  ], {
    store,
    sessionHost: oldHost,
    processIsAlive() { return false; },
    env: {},
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.session.host.status, "closed");
  assert.equal(recovered.session.host.cleanup.pending, false);
});

test("runtime ownership requires exact session and launch-instance markers", () => {
  const session = {
    id: "sess_ownership_12345678",
    status: "active",
    pid: 4242,
    runtimeInstanceId: "runtime_instance_123",
  };
  const matching = runtimeOwnership(session, {
    processIsAlive() { return true; },
    inspectProcessCommand() {
      return "node slack-api-session.cjs run --id 'sess_ownership_12345678' "
        + "--runtime-instance 'runtime_instance_123' --state-dir '/tmp/state'";
    },
  });
  assert.equal(matching.owned, true);

  const reused = runtimeOwnership(session, {
    processIsAlive() { return true; },
    inspectProcessCommand() {
      return "node unrelated.cjs --id sess_ownership_12345678 "
        + "--runtime-instance runtime_different";
    },
  });
  assert.equal(reused.owned, false);
  assert.equal(reused.verified, true);

  const indeterminate = runtimeOwnership(session, {
    processIsAlive() { return true; },
    inspectProcessCommand() {
      throw new Error("ps denied");
    },
  });
  assert.equal(indeterminate.owned, null);
  assert.equal(indeterminate.verified, false);
});

test("normal list audits dead and reused PIDs while active list requires verified ownership", async () => {
  const stateDir = temporaryDirectory();
  const store = new SessionStore(stateDir);
  const reused = storedSession(store, {
    kind: "process",
    requestedKind: "auto",
    managed: true,
    status: "running",
  }, {
    runtimeInstanceId: "runtime_reused",
    threadTs: "100.000001",
  });
  const dead = storedSession(store, {
    kind: "process",
    requestedKind: "auto",
    managed: true,
    status: "running",
  }, {
    runtimeInstanceId: "runtime_dead",
    threadTs: "200.000001",
  });
  store.update(reused.id, (session) => {
    session.pid = 4242;
    session.host.pid = 4242;
    return session;
  });
  store.update(dead.id, (session) => {
    session.pid = 5252;
    session.host.pid = 5252;
    return session;
  });
  const dependencies = {
    store,
    processIsAlive(pid) { return pid === 4242; },
    runtimeOwnershipVerifier() { return false; },
    env: {},
  };

  const listed = await sessionCommand(["list", "--state-dir", stateDir], dependencies);
  const reusedView = listed.sessions.find((session) => session.id === reused.id);
  const deadView = listed.sessions.find((session) => session.id === dead.id);
  assert.equal(listed.sessions.length, 2);
  assert.equal(reusedView.configuredActive, true);
  assert.equal(reusedView.runtimeAlive, true);
  assert.equal(reusedView.runtimeOwned, false);
  assert.equal(reusedView.health, "runtime_unowned");
  assert.equal(reusedView.runtimeInstanceId, undefined);
  assert.equal(deadView.runtimeAlive, false);
  assert.equal(deadView.runtimeOwned, false);
  assert.equal(deadView.health, "runtime_dead");

  const active = await sessionCommand([
    "list", "--active", "--state-dir", stateDir,
  ], dependencies);
  assert.deepEqual(active.sessions, []);
});

test("stop never signals a proven reused PID and safely clears the stale record", async () => {
  const stateDir = temporaryDirectory();
  const store = new SessionStore(stateDir);
  const created = storedSession(store, {
    kind: "process",
    requestedKind: "auto",
    managed: true,
    status: "running",
  }, { runtimeInstanceId: "runtime_original" });
  store.update(created.id, (session) => {
    session.pid = 4242;
    session.host.pid = 4242;
    return session;
  });
  let killed = false;

  const stopped = await sessionCommand([
    "stop", "--id", created.id, "--state-dir", stateDir,
  ], {
    store,
    processIsAlive() { return true; },
    runtimeOwnershipVerifier() { return false; },
    killProcess() { killed = true; },
    env: {},
  });

  assert.equal(killed, false);
  assert.equal(stopped.ok, true);
  assert.equal(stopped.stopPending, false);
  assert.equal(stopped.session.pid, null);
  assert.equal(
    store.readEvents(created.id).some((event) => event.type === "stale_runtime_pid_ignored"),
    true,
  );
});

test("legacy live PID ownership is indeterminate and is never signalled", async () => {
  const stateDir = temporaryDirectory();
  const store = new SessionStore(stateDir);
  const created = storedSession(store, {
    kind: "process",
    requestedKind: "process",
    managed: true,
    status: "running",
  });
  store.update(created.id, (session) => {
    session.pid = 4242;
    session.host.pid = 4242;
    return session;
  });
  let killed = false;

  const stopped = await sessionCommand([
    "stop", "--id", created.id, "--state-dir", stateDir,
  ], {
    store,
    processIsAlive() { return true; },
    killProcess() { killed = true; },
    env: {},
  });

  assert.equal(killed, false);
  assert.equal(stopped.ok, false);
  assert.equal(stopped.stopPending, true);
  assert.equal(stopped.runtimeOwnership.after, null);
  assert.equal(stopped.session.pid, 4242);
  assert.match(stopped.error, /ownership could not be verified/);
});

test("internal run rejects a missing or stale runtime instance identity", async () => {
  const stateDir = temporaryDirectory();
  const store = new SessionStore(stateDir);
  const created = storedSession(store, {
    kind: "process",
    requestedKind: "process",
    managed: true,
    status: "launching",
  }, { runtimeInstanceId: "runtime_expected" });

  await assert.rejects(
    sessionCommand([
      "run", "--id", created.id, "--state-dir", stateDir,
    ], { store, env: {} }),
    /Runtime instance identity did not match/,
  );
  await assert.rejects(
    sessionCommand([
      "run", "--id", created.id,
      "--runtime-instance", "runtime_stale",
      "--state-dir", stateDir,
    ], { store, env: {} }),
    /Runtime instance identity did not match/,
  );
  assert.equal(store.get(created.id).status, "active");
  assert.equal(
    store.readEvents(created.id)
      .filter((event) => event.type === "runtime_instance_rejected").length,
    2,
  );
});

test("an owner Slack stop lets the runtime close its exact managed host", async (t) => {
  const stateDir = temporaryDirectory();
  const store = new SessionStore(stateDir);
  const runtimeInstanceId = "runtime_owner_stop";
  const created = storedSession(store, {
    kind: "cmux",
    requestedKind: "auto",
    target: "surface-owner-stop",
    managed: true,
    workspaceId: "workspace-owner-stop",
    paneId: "pane-owner-stop",
    surfaceId: "surface-owner-stop",
    executable: "/tools/cmux",
    status: "running",
  }, { runtimeInstanceId });
  const calls = [];
  const host = fakeHostedSession(calls);
  let closedDescriptor = null;
  host.close = async (descriptor) => {
    calls.push("host:close");
    closedDescriptor = descriptor;
    return {
      ok: true,
      closed: true,
      descriptor: {
        ...descriptor,
        status: "closed",
        closedAt: "2026-07-27T12:00:02.000Z",
      },
    };
  };
  const slack = {
    async poll() {
      return {
        messages: [{
          ts: "101.000001",
          thread_ts: "100.000001",
          user: "U_OWNER",
          username: "Owner",
          text: "!session stop",
        }],
        pages: [{ ok: true }],
      };
    },
  };

  let result;
  try {
    result = await sessionCommand([
      "run",
      "--id", created.id,
      "--runtime-instance", runtimeInstanceId,
      "--once",
      "--state-dir", stateDir,
    ], {
      store,
      slack,
      provider: { verify() {}, inject() {} },
      sessionHost: host,
      env: {},
    });
  } catch (error) {
    if (error.code === "EPERM") {
      t.skip("loopback listeners are unavailable in this sandbox");
      return;
    }
    throw error;
  }

  assert.equal(result.session.status, "stopped");
  assert.equal(result.hostCleanup.closed, true);
  assert.equal(calls.filter((call) => call === "host:close").length, 1);
  assert.equal(closedDescriptor.workspaceId, "workspace-owner-stop");
  assert.equal(closedDescriptor.surfaceId, "surface-owner-stop");
  assert.equal(store.get(created.id).host.status, "closed");
  assert.equal(
    store.readEvents(created.id)
      .some((event) => event.type === "control_processed" && event.action === "stop"),
    true,
  );
});

test("stop signals the listener and reports failure when managed host close throws", async () => {
  const stateDir = temporaryDirectory();
  const store = new SessionStore(stateDir);
  const created = store.create({
    slack: {
      workspace: "https://example.slack.com",
      channelId: "D_SELF",
      threadTs: "100.000001",
      permalink: "https://example.slack.com/archives/D_SELF/p100000001",
    },
    provider: { name: "stdio", target: "stdout" },
    host: {
      kind: "cmux",
      target: "surface-host",
      managed: true,
      workspaceId: "workspace-host",
      paneId: "pane-host",
      surfaceId: "surface-host",
      executable: "/tools/cmux",
      connection: {
        environment: {
          CMUX_SOCKET_PATH: "/private/tmp/private-close.sock",
        },
      },
    },
    ownerUserId: "U_OWNER",
    allowedUserIds: [],
    pollIntervalMs: 3000,
    cursorTs: "100.000001",
  });
  store.update(created.id, (session) => {
    session.pid = 4242;
    session.host.pid = 4242;
    return session;
  });
  const host = fakeHostedSession();
  host.close = async () => {
    throw new Error("host server unavailable at /private/tmp/private-close.sock");
  };
  let alive = true;
  const signals = [];

  const stopped = await sessionCommand([
    "stop", "--id", created.id, "--state-dir", stateDir,
  ], {
    store,
    sessionHost: host,
    processIsAlive() { return alive; },
    runtimeOwnershipVerifier() { return true; },
    killProcess(pid, signal) {
      signals.push({ pid, signal });
      alive = false;
    },
    runtimeStopTimeoutMs: 100,
    env: {},
  });

  assert.deepEqual(signals, [{ pid: 4242, signal: "SIGTERM" }]);
  assert.equal(stopped.ok, false);
  assert.equal(stopped.stopPending, false);
  assert.equal(stopped.host.reason, "host_close_failed");
  assert.match(stopped.error, /host server unavailable/);
  assert.match(stopped.error, /redacted host connection/);
  assert.doesNotMatch(stopped.error, /private-close\.sock/);
  assert.equal(stopped.session.status, "stopped");
  assert.equal(stopped.session.host.status, "cleanup_pending");
  assert.equal(stopped.session.host.cleanup.pending, true);
  assert.match(stopped.session.host.cleanup.error, /redacted host connection/);
  assert.doesNotMatch(JSON.stringify(stopped.session), /private-close\.sock/);

  host.close = async (descriptor) => ({
    ok: true,
    closed: true,
    descriptor: {
      ...descriptor,
      closedAt: "2026-07-27T12:00:03.000Z",
      cleanup: {
        ...descriptor.cleanup,
        pending: false,
        recoveredAt: "2026-07-27T12:00:03.000Z",
      },
    },
  });
  const recovered = await sessionCommand([
    "stop", "--id", created.id, "--state-dir", stateDir,
  ], {
    store,
    sessionHost: host,
    processIsAlive() { return false; },
    env: {},
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.host.closed, true);
  assert.equal(recovered.session.host.status, "closed");
  assert.equal(recovered.session.host.cleanup.pending, false);
});

test("successful host close preserves and signals a listener until exit is confirmed", async () => {
  const stateDir = temporaryDirectory();
  const store = new SessionStore(stateDir);
  const created = store.create({
    slack: {
      workspace: "https://example.slack.com",
      channelId: "D_SELF",
      threadTs: "100.000001",
      permalink: "https://example.slack.com/archives/D_SELF/p100000001",
    },
    provider: { name: "stdio", target: "stdout" },
    host: {
      kind: "cmux",
      target: "surface-host",
      managed: true,
      workspaceId: "workspace-host",
      paneId: "pane-host",
      surfaceId: "surface-host",
      executable: "/tools/cmux",
    },
    ownerUserId: "U_OWNER",
    allowedUserIds: [],
    pollIntervalMs: 3000,
    cursorTs: "100.000001",
  });
  store.update(created.id, (session) => {
    session.pid = 4242;
    session.host.pid = 4242;
    session.bridge = { host: "127.0.0.1", port: 9999, url: "http://127.0.0.1:9999" };
    return session;
  });
  const host = fakeHostedSession();
  let alive = true;
  const signals = [];

  const stopped = await sessionCommand([
    "stop", "--id", created.id, "--state-dir", stateDir,
  ], {
    store,
    sessionHost: host,
    processIsAlive() { return alive; },
    runtimeOwnershipVerifier() { return true; },
    killProcess(pid, signal) {
      signals.push({ pid, signal });
      alive = false;
    },
    runtimeStopTimeoutMs: 100,
    env: {},
  });

  assert.deepEqual(signals, [{ pid: 4242, signal: "SIGTERM" }]);
  assert.equal(stopped.ok, true);
  assert.equal(stopped.host.closed, true);
  assert.equal(stopped.session.pid, null);
  assert.equal(stopped.session.host.pid, null);
  assert.equal(stopped.host.descriptor.pid, null);
  assert.equal(stopped.host.descriptor.status, stopped.session.host.status);
  assert.equal(stopped.session.bridge.port, null);
});

test("verbose inspection exposes an orphan runtime after its standalone host disappears", async () => {
  const stateDir = temporaryDirectory();
  const store = new SessionStore(stateDir);
  const created = store.create({
    slack: {
      workspace: "https://example.slack.com",
      channelId: "D_SELF",
      threadTs: "100.000001",
      permalink: "https://example.slack.com/archives/D_SELF/p100000001",
    },
    provider: { name: "stdio", target: "stdout" },
    host: {
      kind: "cmux",
      target: "surface-host",
      managed: true,
      workspaceId: "workspace-host",
      executable: "/tools/cmux",
    },
    ownerUserId: "U_OWNER",
    allowedUserIds: [],
    pollIntervalMs: 3000,
    cursorTs: "100.000001",
  });
  store.update(created.id, (session) => {
    session.pid = 4242;
    session.host.pid = 4242;
    return session;
  });
  const host = fakeHostedSession();
  host.inspect = async (descriptor) => ({
    ok: true,
    exists: false,
    payload: {
      unrelatedWorkspaceId: "workspace-private-unrelated",
      surfaceId: "surface-private-unrelated",
      tty: "/dev/ttys999",
      title: "Unrelated private terminal title",
    },
    descriptor,
  });

  const shown = await sessionCommand([
    "show", "--id", created.id, "--verbose", "--state-dir", stateDir,
  ], {
    store,
    sessionHost: host,
    processIsAlive() { return true; },
    runtimeOwnershipVerifier() { return true; },
    env: {},
  });

  assert.equal(shown.hostStatus.exists, false);
  assert.equal(shown.hostStatus.hostExists, false);
  assert.equal(shown.hostStatus.runtimeAlive, true);
  assert.equal(shown.hostStatus.orphanedRuntime, true);
  assert.equal(shown.hostStatus.running, true);
  assert.equal(shown.hostStatus.payload, undefined);
  assert.doesNotMatch(
    JSON.stringify(shown),
    /workspace-private-unrelated|surface-private-unrelated|ttys999|private terminal title/,
  );
});
