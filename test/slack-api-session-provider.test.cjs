const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  detectAgentAttachment,
  main: sessionCommand,
  parseArgs: parseSessionArgs,
  startSession,
} = require("../slack-api-session.cjs");
const { SessionStore } = require("../slack-api-session-store.cjs");
const {
  CmuxProvider,
  HerdrProvider,
  TmuxProvider,
  createProvider,
  escapeCmuxSendText,
  findExecutable,
  inspectProviders,
  resolveProviderConfig,
} = require("../slack-api-session-provider.cjs");

const IDENTITY_SEPARATOR = "\u001f";

function tmuxIdentityOutput(paneId) {
  return [
    paneId,
    "1780000000",
    "4242",
    "$1",
    "1780000001",
    "4343",
    "/private/tmp/tmux.sock",
  ].join(IDENTITY_SEPARATOR) + "\n";
}

function herdrPaneOutput(paneId, {
  workspaceId = "w1",
  tabId = "w1:t1",
  terminalId = "term-1",
  agentSession = null,
} = {}) {
  return JSON.stringify({
    result: {
      pane: {
        pane_id: paneId,
        workspace_id: workspaceId,
        tab_id: tabId,
        terminal_id: terminalId,
        ...(agentSession ? { agent_session: agentSession } : {}),
      },
    },
  }) + "\n";
}

function successfulSpawn(calls) {
  return (command, args, options) => {
    calls.push({ command, args, input: options.input, env: options.env });
    const executable = path.basename(command);
    if (executable === "tmux" && args[0] === "display-message") {
      return {
        status: 0,
        stdout: tmuxIdentityOutput(args[3]),
        stderr: "",
      };
    }
    if (executable === "herdr" && args[0] === "pane" && args[1] === "get") {
      return {
        status: 0,
        stdout: herdrPaneOutput(args[2]),
        stderr: "",
      };
    }
    return {
      status: 0,
      stdout: "{}\n",
      stderr: "",
    };
  };
}

test("Pi attachment prefers the session file path over the bare session id", () => {
  const attachment = detectAgentAttachment({}, {
    PI_SESSION_ID: "01a02c0a-aed4-7a4e-8a1e-ac49873fe1c2",
    PI_SESSION_FILE: "/home/owner/.pi/agent/sessions/--home-owner--/2026-08-23T00-34-52-756Z_01a02c0a-aed4-7a4e-8a1e-ac49873fe1c2.jsonl",
  });
  assert.equal(attachment.agentProvider, "pi");
  assert.equal(
    attachment.agentSessionId,
    "/home/owner/.pi/agent/sessions/--home-owner--/2026-08-23T00-34-52-756Z_01a02c0a-aed4-7a4e-8a1e-ac49873fe1c2.jsonl",
  );
});

test("Pi attachment falls back to the bare session id without a session file", () => {
  const attachment = detectAgentAttachment({}, {
    PI_SESSION_ID: "01a02c0a-aed4-7a4e-8a1e-ac49873fe1c2",
  });
  assert.equal(attachment.agentProvider, "pi");
  assert.equal(attachment.agentSessionId, "01a02c0a-aed4-7a4e-8a1e-ac49873fe1c2");
});

test("provider detection prioritizes cmux over fake tmux context", () => {
  const env = {
    PATH: "/tools",
    CMUX_WORKSPACE_ID: "workspace:1",
    CMUX_SURFACE_ID: "surface:2",
    TMUX: "fake",
    TMUX_PANE: "%1",
  };
  const original = require("node:fs").accessSync;
  require("node:fs").accessSync = (candidate) => {
    if (!candidate.endsWith("/cmux") && !candidate.endsWith("/tmux")) {
      const error = new Error("missing");
      error.code = "ENOENT";
      throw error;
    }
  };
  try {
    const inspection = inspectProviders(env);
    assert.equal(inspection.detected, "cmux");
    assert.equal(inspection.detachedListener.ready, false);
    assert.match(inspection.detachedListener.remediation, /CMUX_SOCKET_MODE=allowAll/);
    assert.deepEqual(resolveProviderConfig({ env }), {
      name: "cmux",
      target: "surface:2",
      executable: "/tools/cmux",
      connection: { environment: {} },
      inspection,
    });
  } finally {
    require("node:fs").accessSync = original;
  }
});

test("provider configs retain only allowlisted connection context for detached runtimes", () => {
  const tmuxSocket = "/private/tmp/custom-tmux/session.sock,4242,0";
  const config = resolveProviderConfig({
    name: "tmux",
    target: "%42",
    env: {
      PATH: "",
      TMUX: tmuxSocket,
      TMUX_TMPDIR: "/private/tmp/custom-tmux",
      TMUX_PANE: "%42",
      SLACK_TOKEN: "must-not-be-persisted",
      SECRET: "must-not-be-persisted",
    },
  });
  assert.deepEqual(config.connection, {
    environment: {
      TMUX: tmuxSocket,
      TMUX_TMPDIR: "/private/tmp/custom-tmux",
    },
  });

  const calls = [];
  const provider = createProvider(config, {
    env: { BASE_ENV: "retained", TMUX: "wrong-socket" },
    spawnSync: successfulSpawn(calls),
  });
  provider.verify();
  assert.equal(calls[0].env.TMUX, tmuxSocket);
  assert.equal(calls[0].env.TMUX_TMPDIR, "/private/tmp/custom-tmux");
  assert.equal(calls[0].env.BASE_ENV, "retained");
  assert.equal(calls[0].env.SLACK_TOKEN, undefined);
  assert.equal(calls[0].env.SECRET, undefined);
});

test("cmux provider configs retain socket path and mode without terminal target IDs", () => {
  const config = resolveProviderConfig({
    name: "cmux",
    target: "surface:original",
    env: {
      PATH: "",
      CMUX_SOCKET_PATH: "/private/tmp/cmux-custom.sock",
      CMUX_SOCKET_MODE: "allowAll",
      CMUX_WORKSPACE_ID: "workspace:original",
      CMUX_SURFACE_ID: "surface:original",
    },
  });
  assert.deepEqual(config.connection, {
    environment: {
      CMUX_SOCKET_PATH: "/private/tmp/cmux-custom.sock",
      CMUX_SOCKET_MODE: "allowAll",
    },
  });
  assert.equal(config.connection.environment.CMUX_WORKSPACE_ID, undefined);
  assert.equal(config.connection.environment.CMUX_SURFACE_ID, undefined);
});

test("empty provider endpoint bindings clear a later shell context while legacy sessions inherit it", () => {
  const cases = [
    {
      name: "tmux",
      target: "%42",
      env: {
        BASE_ENV: "retained",
        TMUX: "/private/tmp/tmux-b.sock,4242,0",
        TMUX_TMPDIR: "/private/tmp/tmux-b",
        TMUX_PANE: "%99",
      },
      cleared: ["TMUX", "TMUX_TMPDIR", "TMUX_PANE"],
    },
    {
      name: "cmux",
      target: "surface:original",
      env: {
        BASE_ENV: "retained",
        CMUX_SOCKET_PATH: "/private/tmp/cmux-b.sock",
        CMUX_SOCKET_MODE: "allowAll",
        CMUX_WORKSPACE_ID: "workspace:b",
        CMUX_SURFACE_ID: "surface:b",
        CMUX_TAB_ID: "tab:b",
      },
      cleared: [
        "CMUX_SOCKET_PATH",
        "CMUX_SOCKET_MODE",
        "CMUX_WORKSPACE_ID",
        "CMUX_SURFACE_ID",
        "CMUX_TAB_ID",
      ],
    },
    {
      name: "herdr",
      target: "pane:original",
      env: {
        BASE_ENV: "retained",
        HERDR_SOCKET_PATH: "/private/tmp/herdr-b.sock",
        HERDR_SESSION: "context-b",
        HERDR_CONTEXT: "context-b",
        HERDR_CONTEXT_NAME: "context-b",
        HERDR_ENV: "1",
        HERDR_PANE_ID: "pane:b",
        HERDR_WORKSPACE_ID: "workspace:b",
      },
      cleared: [
        "HERDR_SOCKET_PATH",
        "HERDR_SESSION",
        "HERDR_CONTEXT",
        "HERDR_CONTEXT_NAME",
        "HERDR_ENV",
        "HERDR_PANE_ID",
        "HERDR_WORKSPACE_ID",
      ],
    },
  ];

  for (const scenario of cases) {
    const provider = createProvider({
      name: scenario.name,
      target: scenario.target,
      executable: scenario.name,
      connection: { environment: {} },
    }, {
      env: scenario.env,
    });
    assert.equal(provider.env.BASE_ENV, "retained");
    for (const key of scenario.cleared) assert.equal(provider.env[key], undefined);
  }

  const legacy = createProvider({
    name: "cmux",
    target: "surface:legacy",
    executable: "cmux",
  }, {
    env: cases[1].env,
  });
  assert.equal(legacy.env.CMUX_SOCKET_PATH, "/private/tmp/cmux-b.sock");
  assert.equal(legacy.env.CMUX_SURFACE_ID, "surface:b");
});

test("provider command failures redact saved connection values, including thrown errors", () => {
  const cases = [
    {
      Provider: TmuxProvider,
      target: "%1",
      env: {
        TMUX: "/private/tmp/private-tmux.sock,4242,0",
        TMUX_TMPDIR: "/private/tmp/private-tmux",
      },
      leakedValue: "/private/tmp/private-tmux.sock",
    },
    {
      Provider: CmuxProvider,
      target: "surface:1",
      env: {
        CMUX_SOCKET_PATH: "/private/tmp/private-cmux.sock",
        CMUX_SOCKET_MODE: "allowAll",
      },
      leakedValue: "/private/tmp/private-cmux.sock",
    },
    {
      Provider: HerdrProvider,
      target: "w1:p1",
      env: {
        HERDR_SOCKET_PATH: "/private/tmp/private-herdr.sock",
        HERDR_SESSION: "private-context",
      },
      leakedValue: "/private/tmp/private-herdr.sock",
    },
  ];

  for (const scenario of cases) {
    const returnedFailure = new scenario.Provider({
      target: scenario.target,
      env: scenario.env,
      spawnSync() {
        return {
          status: 1,
          stdout: "",
          stderr: `connection failed at ${scenario.leakedValue}`,
        };
      },
    });
    assert.throws(() => returnedFailure.verify(), (error) => {
      assert.match(error.message, /redacted provider connection/);
      assert.doesNotMatch(error.message, new RegExp(path.basename(scenario.leakedValue)));
      return true;
    });

    const thrownFailure = new scenario.Provider({
      target: scenario.target,
      env: scenario.env,
      spawnSync() {
        throw new Error(`transport failed at ${scenario.leakedValue}`);
      },
    });
    assert.throws(() => thrownFailure.verify(), (error) => {
      assert.match(error.message, /redacted provider connection/);
      assert.doesNotMatch(error.message, new RegExp(path.basename(scenario.leakedValue)));
      return true;
    });
  }
});

test("session show and events cannot expose a provider connection from an audited failure", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "slack-session-redaction-"));
  const store = new SessionStore(stateDir);
  const socketPath = "/private/tmp/audited-private-cmux.sock";
  const providerConfig = {
    name: "cmux",
    target: "surface:private",
    executable: "cmux",
    connection: {
      environment: {
        CMUX_SOCKET_PATH: socketPath,
        CMUX_SOCKET_MODE: "allowAll",
      },
    },
  };
  const provider = createProvider(providerConfig, {
    env: {},
    spawnSync() {
      return {
        status: 1,
        stdout: "",
        stderr: `provider unavailable at ${socketPath}`,
      };
    },
  });
  let providerError;
  try {
    provider.verify();
  } catch (error) {
    providerError = error;
  }
  assert.ok(providerError);
  assert.doesNotMatch(providerError.message, /audited-private-cmux\.sock/);

  const session = store.create({
    slack: {
      workspace: "https://example.slack.com",
      channelId: "D_SELF",
      threadTs: "100.000001",
      permalink: "https://example.slack.com/archives/D_SELF/p100000001",
    },
    provider: providerConfig,
    host: {
      kind: "process",
      target: null,
      managed: false,
      createdAt: null,
      closedAt: null,
    },
    attachment: {
      agentSessionId: "thread_123",
      agentProvider: "codex",
      worktree: process.cwd(),
      provider: "cmux",
      target: "surface:private",
    },
    ownerUserId: "U_OWNER",
    allowedUserIds: [],
    pollIntervalMs: 3000,
    cursorTs: "100.000001",
  });
  store.audit(session.id, "poll_failed", { error: providerError.message });

  const shown = await sessionCommand([
    "show", "--id", session.id, "--state-dir", stateDir,
  ], { store });
  const events = await sessionCommand([
    "events", "--id", session.id, "--state-dir", stateDir,
  ], { store });
  for (const output of [shown, events]) {
    const serialized = JSON.stringify(output);
    assert.match(serialized, /redacted provider connection/);
    assert.doesNotMatch(serialized, /audited-private-cmux\.sock/);
  }
  assert.equal(
    store.get(session.id, { includeSecret: true })
      .provider.connection.environment.CMUX_SOCKET_PATH,
    socketPath,
  );
});

test("session doctor fails loudly with detached cmux remediation", async () => {
  const env = {
    PATH: "/tools",
    CMUX_WORKSPACE_ID: "workspace:1",
    CMUX_SURFACE_ID: "surface:2",
  };
  const original = fs.accessSync;
  fs.accessSync = (candidate) => {
    if (!candidate.endsWith("/cmux")) {
      const error = new Error("missing");
      error.code = "ENOENT";
      throw error;
    }
  };
  try {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "slack-session-doctor-"));
    const result = await sessionCommand(["doctor", "--state-dir", stateDir], {
      env,
      provider: {
        target: "surface:2",
        verify() {
          return { ok: true, name: "cmux", target: "surface:2" };
        },
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.diagnosis, /hosted outside cmux/);
    assert.match(result.guidance, /CMUX_SOCKET_MODE=allowAll/);
    assert.match(result.guidance, /--foreground/);
  } finally {
    fs.accessSync = original;
  }
});

test("session start rejects detached cmux before creating a Slack thread", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "slack-session-start-cmux-"));
  const args = parseSessionArgs([
    "start",
    "--channel", "C123",
    "--provider", "cmux",
    "--target", "surface:2",
    "--state-dir", stateDir,
  ]);
  let created = false;
  await assert.rejects(
    startSession(args, {
      store: new SessionStore(stateDir),
      env: {},
      provider: { verify() { return { ok: true }; } },
      slack: { async createThread() { created = true; } },
    }),
    /CMUX_SOCKET_MODE=allowAll.*--host cmux.*--foreground/,
  );
  assert.equal(created, false);
});

test("tmux fingerprints reject a reused pane id before paste mutation", () => {
  const calls = [];
  let verificationCount = 0;
  const provider = new TmuxProvider({
    target: "%7",
    env: {},
    spawnSync(command, args, options) {
      calls.push({ command, args, options });
      verificationCount += 1;
      const output = [
        "%7",
        verificationCount === 1 ? "1780000000" : "1780009999",
        verificationCount === 1 ? "4242" : "9999",
        "$1",
        "1780000001",
        "4343",
        "/private/tmp/tmux.sock",
      ].join(IDENTITY_SEPARATOR) + "\n";
      return { status: 0, stdout: output, stderr: "" };
    },
  });
  const established = provider.verify();
  assert.equal(established.identity.provider, "tmux");
  assert.equal(established.identity.paneId, "%7");
  assert.doesNotMatch(JSON.stringify(established.identity), /private|4242/);

  assert.throws(
    () => provider.inject("must not be pasted"),
    /target ownership changed.*refusing Slack injection/i,
  );
  assert.equal(calls.length, 2);
  assert.equal(calls.some((call) => call.args[0] === "load-buffer"), false);
});

test("legacy tmux sessions without a fingerprint fail with restart guidance", () => {
  const provider = new TmuxProvider({
    target: "%7",
    identityMode: "require",
    env: {},
    spawnSync() {
      return {
        status: 0,
        stdout: tmuxIdentityOutput("%7"),
        stderr: "",
      };
    },
  });
  assert.throws(
    () => provider.verify(),
    /identity is missing.*start a new Slack agent session/i,
  );
});

test("Herdr fingerprints bind terminal topology and the reported agent session", () => {
  const calls = [];
  const agentSession = {
    source: "herdr:codex",
    agent: "codex",
    kind: "id",
    value: "thread_123",
  };
  const provider = new HerdrProvider({
    target: "w1:p1",
    expectedAgentSessionId: "thread_123",
    env: {},
    spawnSync(command, args) {
      calls.push({ command, args });
      if (args[0] === "pane") {
        return {
          status: 0,
          stdout: herdrPaneOutput("w1:p1", { agentSession }),
          stderr: "",
        };
      }
      return { status: 0, stdout: "{}", stderr: "" };
    },
  });
  const established = provider.verify();
  assert.deepEqual(established.identity.agentSession, agentSession);
  provider.inject("hello");
  assert.deepEqual(calls.map((call) => call.args), [
    ["pane", "get", "w1:p1"],
    ["pane", "get", "w1:p1"],
    ["agent", "prompt", "w1:p1", "hello"],
  ]);
});

test("Herdr rejects agent-session and terminal replacement before prompting", () => {
  const originalSession = {
    source: "herdr:codex",
    agent: "codex",
    kind: "id",
    value: "thread_original",
  };
  const establishing = new HerdrProvider({
    target: "w1:p1",
    expectedAgentSessionId: "thread_original",
    env: {},
    spawnSync() {
      return {
        status: 0,
        stdout: herdrPaneOutput("w1:p1", { agentSession: originalSession }),
        stderr: "",
      };
    },
  });
  const identity = establishing.verify().identity;

  const wrongSessionCalls = [];
  const wrongSession = new HerdrProvider({
    target: "w1:p1",
    identity,
    identityMode: "require",
    expectedAgentSessionId: "thread_original",
    env: {},
    spawnSync(command, args) {
      wrongSessionCalls.push({ command, args });
      return {
        status: 0,
        stdout: herdrPaneOutput("w1:p1", {
          agentSession: {
            ...originalSession,
            value: "thread_replacement",
          },
        }),
        stderr: "",
      };
    },
  });
  assert.throws(
    () => wrongSession.inject("must not be prompted"),
    /different agent session.*refusing Slack injection/i,
  );
  assert.equal(wrongSessionCalls.length, 1);

  const wrongTerminalCalls = [];
  const wrongTerminal = new HerdrProvider({
    target: "w1:p1",
    identity,
    identityMode: "require",
    expectedAgentSessionId: "thread_original",
    env: {},
    spawnSync(command, args) {
      wrongTerminalCalls.push({ command, args });
      return {
        status: 0,
        stdout: herdrPaneOutput("w1:p1", {
          terminalId: "term-reused",
          agentSession: originalSession,
        }),
        stderr: "",
      };
    },
  });
  assert.throws(
    () => wrongTerminal.inject("must not be prompted"),
    /target ownership changed.*refusing Slack injection/i,
  );
  assert.equal(wrongTerminalCalls.length, 1);
});

test("Herdr start rejects a pane already attached to a different agent session", () => {
  const provider = new HerdrProvider({
    target: "w1:p1",
    expectedAgentSessionId: "thread_expected",
    env: {},
    spawnSync() {
      return {
        status: 0,
        stdout: herdrPaneOutput("w1:p1", {
          agentSession: {
            source: "herdr:codex",
            agent: "codex",
            kind: "id",
            value: "thread_other",
          },
        }),
        stderr: "",
      };
    },
  });
  assert.throws(
    () => provider.verify(),
    /different agent session.*intended agent/i,
  );
});

test("Herdr accepts an exact Pi agent session file path match", () => {
  const sessionFile = "/home/owner/.pi/agent/sessions/--home-owner--/2026-08-23T00-34-52-756Z_01a02c0a-aed4-7a4e-8a1e-ac49873fe1c2.jsonl";
  const agentSession = {
    source: "herdr:pi",
    agent: "pi",
    kind: "path",
    value: sessionFile,
  };
  const provider = new HerdrProvider({
    target: "w1:p1",
    expectedAgentSessionId: sessionFile,
    env: {},
    spawnSync() {
      return {
        status: 0,
        stdout: herdrPaneOutput("w1:p1", { agentSession }),
        stderr: "",
      };
    },
  });
  assert.deepEqual(provider.verify().identity.agentSession, agentSession);
});

test("Herdr accepts a Pi agent session file path for the expected session id", () => {
  const agentSession = {
    source: "herdr:pi",
    agent: "pi",
    kind: "path",
    value: "/home/owner/.pi/agent/sessions/--home-owner--/2026-08-23T00-34-52-756Z_01a02c0a-aed4-7a4e-8a1e-ac49873fe1c2.jsonl",
  };
  const provider = new HerdrProvider({
    target: "w1:p1",
    expectedAgentSessionId: "01a02c0a-aed4-7a4e-8a1e-ac49873fe1c2",
    env: {},
    spawnSync() {
      return {
        status: 0,
        stdout: herdrPaneOutput("w1:p1", { agentSession }),
        stderr: "",
      };
    },
  });
  const established = provider.verify();
  assert.deepEqual(established.identity.agentSession, agentSession);
});

test("Herdr still rejects a path that does not embed the expected session id", () => {
  const provider = new HerdrProvider({
    target: "w1:p1",
    expectedAgentSessionId: "01a02c0a-aed4-7a4e-8a1e-ac49873fe1c2",
    env: {},
    spawnSync() {
      return {
        status: 0,
        stdout: herdrPaneOutput("w1:p1", {
          agentSession: {
            source: "herdr:pi",
            agent: "pi",
            kind: "path",
            value: "/home/owner/.pi/agent/sessions/--home-owner--/2026-08-23T00-34-52-756Z_other-session-id.jsonl",
          },
        }),
        stderr: "",
      };
    },
  });
  assert.throws(
    () => provider.verify(),
    /different agent session.*intended agent/i,
  );
});

test("Herdr start requires a reported agent session when an attachment is expected", () => {
  const provider = new HerdrProvider({
    target: "w1:p1",
    expectedAgentSessionId: "thread_expected",
    env: {},
    spawnSync() {
      return {
        status: 0,
        stdout: herdrPaneOutput("w1:p1"),
        stderr: "",
      };
    },
  });
  assert.throws(
    () => provider.verify(),
    /does not report the expected agent session.*intended agent/i,
  );
});

test("tmux injection uses a paste buffer and submits Enter separately", () => {
  const calls = [];
  const provider = new TmuxProvider({
    target: "%7",
    env: {},
    spawnSync: successfulSpawn(calls),
  });
  provider.verify();
  provider.inject("multiline\nmessage with 'quotes' and $(shell)");
  assert.deepEqual(calls.map((call) => call.args[0]), [
    "display-message",
    "display-message",
    "load-buffer",
    "paste-buffer",
    "send-keys",
    "delete-buffer",
  ]);
  assert.equal(calls[2].input, "multiline\nmessage with 'quotes' and $(shell)");
  assert.equal(calls[4].args.at(-1), "Enter");
});

test("cmux injection targets a surface and submits a key", () => {
  const calls = [];
  const provider = new CmuxProvider({
    target: "surface:9",
    env: {},
    spawnSync: successfulSpawn(calls),
  });
  provider.verify();
  provider.inject("hello");
  assert.deepEqual(calls.map((call) => call.args), [
    ["ping"],
    ["read-screen", "--surface", "surface:9", "--lines", "1"],
    ["ping"],
    ["read-screen", "--surface", "surface:9", "--lines", "1"],
    ["send", "--surface", "surface:9", "hello"],
    ["send-key", "--surface", "surface:9", "enter"],
  ]);
});

test("provider mutation failures never expose injected Slack text", () => {
  const sensitiveText = "private Slack text $(do-not-log)";
  let callCount = 0;
  const provider = new CmuxProvider({
    target: "surface:9",
    env: {},
    spawnSync(command, args) {
      callCount += 1;
      if (callCount === 5) {
        return {
          status: 1,
          stdout: "",
          stderr: `send rejected while handling ${sensitiveText}`,
        };
      }
      return { status: 0, stdout: "{}", stderr: "" };
    },
  });
  provider.verify();
  assert.throws(() => provider.inject(sensitiveText), (error) => {
    assert.match(error.message, /redacted sensitive provider diagnostic/);
    assert.doesNotMatch(error.message, /private Slack text|do-not-log/);
    return true;
  });
});

test("cmux send escaping preserves one-line JSON semantics without control escapes", () => {
  const envelope = JSON.stringify({
    text: "line one\nline two\twith a literal \\n and \"quote\"",
    path: "C:\\temp\\response.txt",
  });
  const escaped = escapeCmuxSendText(envelope);
  assert.doesNotMatch(escaped, /\\[nrt]/);
  assert.deepEqual(JSON.parse(escaped), JSON.parse(envelope));

  const calls = [];
  const provider = new CmuxProvider({
    target: "surface:9",
    executable: "cmux",
    env: {},
    spawnSync: successfulSpawn(calls),
  });
  provider.inject(envelope);
  assert.equal(calls[2].args.at(-1), escaped);
  assert.equal(calls[3].args.at(-1), "enter");
});

test("cmux provider persists and invokes an app-bundled executable outside PATH", () => {
  const env = {
    PATH: "",
    CMUX_WORKSPACE_ID: "workspace:1",
    CMUX_SURFACE_ID: "surface:2",
  };
  const bundled = "/Applications/cmux.app/Contents/Resources/bin/cmux";
  const original = fs.accessSync;
  fs.accessSync = (candidate) => {
    if (candidate === bundled) return;
    const error = new Error("missing");
    error.code = "ENOENT";
    throw error;
  };
  try {
    const config = resolveProviderConfig({ env });
    assert.equal(config.name, "cmux");
    assert.equal(config.executable, bundled);
    const calls = [];
    const provider = new CmuxProvider({
      ...config,
      env,
      spawnSync: successfulSpawn(calls),
    });
    provider.verify();
    provider.inject("hello");
    assert.deepEqual(calls.map((call) => call.command), [
      bundled,
      bundled,
      bundled,
      bundled,
      bundled,
      bundled,
    ]);
  } finally {
    fs.accessSync = original;
  }
});

test("Herdr uses its atomic agent prompt command", () => {
  const calls = [];
  const provider = new HerdrProvider({
    target: "w1:p1",
    env: {},
    spawnSync: successfulSpawn(calls),
  });
  provider.verify();
  provider.inject("hello");
  assert.deepEqual(calls.map((call) => call.args), [
    ["pane", "get", "w1:p1"],
    ["pane", "get", "w1:p1"],
    ["agent", "prompt", "w1:p1", "hello"],
  ]);
});

test("Herdr fails closed when its target pane has no attached agent", () => {
  const calls = [];
  const spawnImpl = (command, args) => {
    calls.push({ command, args });
    if (args[0] === "agent") return { status: 1, stdout: "", stderr: "agent_not_found" };
    return {
      status: 0,
      stdout: herdrPaneOutput(args[2]),
      stderr: "",
    };
  };
  const provider = new HerdrProvider({ target: "w1:p1", env: {}, spawnSync: spawnImpl });
  provider.verify();
  assert.throws(() => provider.inject("hello"), /agent_not_found/);
  assert.deepEqual(calls.map((call) => call.args), [
    ["pane", "get", "w1:p1"],
    ["pane", "get", "w1:p1"],
    ["agent", "prompt", "w1:p1", "hello"],
  ]);
});

test("tmux provider injects multiline input into an isolated real pane", {
  skip: !findExecutable("tmux"),
}, async (t) => {
  const name = `slack-agent-test-${process.pid}-${Date.now()}`;
  const created = spawnSync("tmux", ["new-session", "-d", "-s", name, "cat"], { encoding: "utf8" });
  if (created.status !== 0 && /operation not permitted|permission denied/i.test(created.stderr)) {
    t.skip(`tmux socket is unavailable in this sandbox: ${created.stderr.trim()}`);
    return;
  }
  assert.equal(created.status, 0, created.stderr);
  try {
    const listed = spawnSync("tmux", ["list-panes", "-t", name, "-F", "#{pane_id}"], { encoding: "utf8" });
    assert.equal(listed.status, 0, listed.stderr);
    const provider = new TmuxProvider({ target: listed.stdout.trim() });
    provider.verify();
    provider.inject("safe first line\nsafe second line");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const snapshot = provider.snapshot();
    assert.match(snapshot, /safe first line/);
    assert.match(snapshot, /safe second line/);
  } finally {
    spawnSync("tmux", ["kill-session", "-t", name], { encoding: "utf8" });
  }
});
