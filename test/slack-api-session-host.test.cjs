const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  CMUX_APP_CLI_PATHS,
  CmuxSessionHost,
  HerdrSessionHost,
  ProcessSessionHost,
  createSessionHost,
  normalizeCreateOptions,
  resolveHostConfig,
} = require("../slack-api-session-host.cjs");

function fakeSpawn(steps, calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const step = steps.shift();
    assert.ok(step, `Unexpected command: ${command} ${args.join(" ")}`);
    if (step.command) assert.equal(command, step.command);
    if (step.args) assert.deepEqual(args, step.args);
    return {
      status: Object.hasOwn(step, "status") ? step.status : 0,
      stdout: step.stdout || "",
      stderr: step.stderr || "",
      error: step.error,
    };
  };
}

const fixedNow = () => Date.parse("2026-07-27T12:00:00.000Z");

test("default host labels retain the full collision-resistant session id", () => {
  const sessionId = "sess_mabc1234_Qx9yZ7wV";
  assert.equal(
    normalizeCreateOptions({ sessionId }).label,
    `Slack agent ${sessionId}`,
  );
});

test("auto host follows the cmux target provider when its CLI is available", () => {
  const config = resolveHostConfig({
    provider: { name: "cmux" },
    env: { PATH: "/tools" },
  }, {
    accessSync(candidate) {
      if (candidate === "/tools/cmux") return;
      const error = new Error("missing");
      error.code = "ENOENT";
      throw error;
    },
  });
  assert.deepEqual(config, {
    kind: "cmux",
    executable: "/tools/cmux",
    source: "target_provider",
    connection: { environment: {} },
  });
});

test("auto host detects Herdr context and falls back to process without a host context", () => {
  const herdr = resolveHostConfig({
    env: {
      PATH: "/tools",
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p1",
    },
  }, {
    accessSync(candidate) {
      if (candidate === "/tools/herdr") return;
      throw new Error("missing");
    },
  });
  assert.equal(herdr.kind, "herdr");
  assert.equal(herdr.executable, "/tools/herdr");
  assert.equal(herdr.source, "terminal_context");

  const processHost = resolveHostConfig({
    env: { PATH: "" },
  }, {
    accessSync() {
      throw new Error("missing");
    },
  });
  assert.deepEqual(processHost, {
    kind: "process",
    executable: null,
    source: "fallback",
  });
});

test("auto host prefers an available standalone CLI without terminal context", () => {
  const config = resolveHostConfig({
    env: { PATH: "/tools" },
  }, {
    accessSync(candidate) {
      if (candidate === "/tools/cmux" || candidate === "/tools/herdr") return;
      throw new Error("missing");
    },
  });
  assert.deepEqual(config, {
    kind: "cmux",
    executable: "/tools/cmux",
    source: "available_cli",
    connection: { environment: {} },
  });
});

test("cmux executable resolution includes the app-bundled CLI", () => {
  const config = resolveHostConfig({
    kind: "cmux",
    env: { PATH: "" },
  }, {
    accessSync(candidate) {
      if (candidate === CMUX_APP_CLI_PATHS[0]) return;
      throw new Error("missing");
    },
  });
  assert.equal(config.executable, CMUX_APP_CLI_PATHS[0]);
});

test("unsupported and unavailable explicit hosts fail before mutation", () => {
  assert.throws(
    () => resolveHostConfig({ kind: "screen", env: { PATH: "" } }),
    /Unknown session host screen/,
  );
  assert.throws(
    () => resolveHostConfig({ kind: "herdr", env: { PATH: "" } }, {
      accessSync() {
        throw new Error("missing");
      },
    }),
    /Herdr|herdr.*executable was not found/i,
  );
});

test("process host returns a delegated descriptor without spawning", async () => {
  const calls = [];
  const host = new ProcessSessionHost({ source: "fallback" }, {
    spawnSync: fakeSpawn([], calls),
    now: fixedNow,
  });
  assert.equal((await host.preflight()).delegated, true);
  const descriptor = await host.create({
    sessionId: "sess_12345678",
    cwd: ".",
    environment: { SLACK_AGENT_SESSION_ID: "sess_12345678" },
  });
  assert.equal(descriptor.kind, "process");
  assert.equal(descriptor.managed, false);
  assert.equal(descriptor.scope, "process");
  assert.equal(descriptor.createdAt, "2026-07-27T12:00:00.000Z");
  const launched = await host.launch(descriptor, { command: "node listener.cjs" });
  assert.equal(launched.delegated, true);
  assert.equal(calls.length, 0);
});

test("cmux host descriptors retain socket A while socket B management clears caller IDs", async () => {
  const executable = "/tools/cmux";
  const socketA = "/private/tmp/cmux-a.sock";
  const config = resolveHostConfig({
    kind: "cmux",
    executable,
    env: {
      CMUX_SOCKET_PATH: socketA,
      CMUX_SOCKET_MODE: "allowAll",
      CMUX_WORKSPACE_ID: "workspace:caller-a",
      CMUX_SURFACE_ID: "surface:caller-a",
    },
  }, {
    accessSync(candidate) {
      if (candidate === executable) return;
      throw new Error("missing");
    },
  });
  assert.deepEqual(config.connection, {
    environment: {
      CMUX_SOCKET_PATH: socketA,
      CMUX_SOCKET_MODE: "allowAll",
    },
  });

  const createCalls = [];
  const creator = new CmuxSessionHost(config, {
    env: {
      CMUX_SOCKET_PATH: socketA,
      CMUX_SOCKET_MODE: "allowAll",
      CMUX_WORKSPACE_ID: "workspace:caller-a",
      CMUX_SURFACE_ID: "surface:caller-a",
    },
    spawnSync: fakeSpawn([
      {
        stdout: JSON.stringify({
          workspace_id: "workspace:managed",
          pane_id: "pane:managed",
          surface_id: "surface:managed",
        }),
      },
      {
        stdout: JSON.stringify({
          workspace_id: "workspace:managed",
          pane_id: "pane:managed",
          surface_id: "surface:managed",
        }),
      },
    ], createCalls),
  });
  const descriptor = await creator.create({ cwd: "/tmp/project" });
  assert.deepEqual(descriptor.connection, config.connection);

  const managementCalls = [];
  const manager = new CmuxSessionHost({
    ...config,
    connection: descriptor.connection,
  }, {
    env: {
      CMUX_SOCKET_PATH: "/private/tmp/cmux-b.sock",
      CMUX_SOCKET_MODE: "allowLocal",
      CMUX_WORKSPACE_ID: "workspace:caller-b",
      CMUX_SURFACE_ID: "surface:caller-b",
      CMUX_TAB_ID: "tab:caller-b",
    },
    spawnSync: fakeSpawn([
      { stdout: "pong\n" },
      {
        stdout: JSON.stringify({
          workspace_id: "workspace:managed",
          pane_id: "pane:managed",
          surface_id: "surface:managed",
        }),
      },
      {
        stdout: JSON.stringify({
          workspace_id: "workspace:managed",
          pane_id: "pane:managed",
          surface_id: "surface:managed",
        }),
      },
      { stdout: "{}" },
    ], managementCalls),
  });
  await manager.preflight();
  assert.equal((await manager.inspect(descriptor)).exists, true);
  assert.equal((await manager.close(descriptor)).closed, true);

  for (const call of [...createCalls, ...managementCalls]) {
    assert.equal(call.options.env.CMUX_SOCKET_PATH, socketA);
    assert.equal(call.options.env.CMUX_SOCKET_MODE, "allowAll");
    assert.equal(call.options.env.CMUX_WORKSPACE_ID, undefined);
    assert.equal(call.options.env.CMUX_SURFACE_ID, undefined);
    assert.equal(call.options.env.CMUX_TAB_ID, undefined);
  }
});

test("Herdr host descriptors retain named context A while context B is active", async () => {
  const executable = "/tools/herdr";
  const config = resolveHostConfig({
    kind: "herdr",
    executable,
    env: {
      HERDR_SOCKET_PATH: "/private/tmp/herdr-a.sock",
      HERDR_SESSION: "context-a",
      HERDR_ENV: "1",
      HERDR_PANE_ID: "pane:caller-a",
    },
  }, {
    accessSync(candidate) {
      if (candidate === executable) return;
      throw new Error("missing");
    },
  });
  assert.deepEqual(config.connection, {
    environment: {
      HERDR_SOCKET_PATH: "/private/tmp/herdr-a.sock",
      HERDR_SESSION: "context-a",
    },
  });

  const createCalls = [];
  const creator = new HerdrSessionHost(config, {
    env: {
      HERDR_SOCKET_PATH: "/private/tmp/herdr-a.sock",
      HERDR_SESSION: "context-a",
      HERDR_ENV: "1",
      HERDR_PANE_ID: "pane:caller-a",
    },
    spawnSync: fakeSpawn([{
      stdout: JSON.stringify({
        result: {
          workspace: { workspace_id: "workspace:managed" },
          root_pane: { pane_id: "pane:managed" },
        },
      }),
    }], createCalls),
  });
  const descriptor = await creator.create({ cwd: "/tmp/project" });

  const managementCalls = [];
  const manager = new HerdrSessionHost({
    ...config,
    connection: descriptor.connection,
  }, {
    env: {
      HERDR_SOCKET_PATH: "/private/tmp/herdr-b.sock",
      HERDR_SESSION: "context-b",
      HERDR_ENV: "1",
      HERDR_PANE_ID: "pane:caller-b",
      HERDR_WORKSPACE_ID: "workspace:caller-b",
    },
    spawnSync: fakeSpawn([
      { stdout: "{\"ok\":true}" },
      {
        stdout: JSON.stringify({
          result: {
            workspace: {
              workspace_id: "workspace:managed",
              label: "Slack agent listener",
            },
          },
        }),
      },
      {
        stdout: JSON.stringify({
          result: {
            pane: {
              pane_id: "pane:managed",
              workspace_id: "workspace:managed",
            },
          },
        }),
      },
      {
        stdout: JSON.stringify({
          result: {
            workspace: {
              workspace_id: "workspace:managed",
              label: "Slack agent listener",
            },
          },
        }),
      },
      {
        stdout: JSON.stringify({
          result: {
            pane: {
              pane_id: "pane:managed",
              workspace_id: "workspace:managed",
            },
          },
        }),
      },
      { stdout: "{\"ok\":true}" },
    ], managementCalls),
  });
  await manager.preflight();
  assert.equal((await manager.inspect(descriptor)).exists, true);
  assert.equal((await manager.close(descriptor)).closed, true);

  for (const call of [...createCalls, ...managementCalls]) {
    assert.equal(call.options.env.HERDR_SOCKET_PATH, "/private/tmp/herdr-a.sock");
    assert.equal(call.options.env.HERDR_SESSION, "context-a");
    assert.equal(call.options.env.HERDR_ENV, undefined);
    assert.equal(call.options.env.HERDR_PANE_ID, undefined);
    assert.equal(call.options.env.HERDR_WORKSPACE_ID, undefined);
  }
});

test("cmux host preflights, creates a canonical workspace, and submits launch literally", async () => {
  const calls = [];
  const executable = "/tools/cmux";
  const steps = [
    {
      command: executable,
      args: ["ping"],
      stdout: "pong\n",
    },
    {
      command: executable,
      args: [
        "--json",
        "--id-format", "uuids",
        "workspace", "create",
        "--name", "Slack listener",
        "--cwd", path.resolve("/tmp/project"),
        "--focus", "false",
      ],
      stdout: JSON.stringify({
        workspace_id: "ws-uuid",
        pane_id: "pane-uuid",
        surface_id: "surface-uuid",
        window_id: "window-uuid",
      }),
    },
    {
      command: executable,
      args: [
        "--json",
        "--id-format", "uuids",
        "tree",
        "--workspace", "ws-uuid",
      ],
      stdout: JSON.stringify({
        workspace_id: "ws-uuid",
        pane_id: "pane-uuid",
        surface_id: "surface-uuid",
        window_id: "window-uuid",
      }),
    },
    {
      command: executable,
      args: [
        "send",
        "--surface", "surface-uuid",
        "--",
        "node '/tmp/slack api.cjs' run --id 'sess_12345678' --literal '$() ;'",
      ],
    },
    {
      command: executable,
      args: ["send-key", "--surface", "surface-uuid", "enter"],
    },
  ];
  const host = new CmuxSessionHost({
    kind: "cmux",
    executable,
    source: "explicit",
  }, {
    spawnSync: fakeSpawn(steps, calls),
    now: fixedNow,
    env: {},
  });

  await host.preflight();
  const descriptor = await host.create({
    sessionId: "sess_12345678",
    label: "Slack listener",
    cwd: "/tmp/project",
    environment: { SLACK_AGENT_SESSION_ID: "sess_12345678" },
  });
  assert.equal(descriptor.managed, true);
  assert.equal(descriptor.workspaceId, "ws-uuid");
  assert.equal(descriptor.paneId, "pane-uuid");
  assert.equal(descriptor.surfaceId, "surface-uuid");
  assert.equal(descriptor.target, "surface-uuid");

  const command = "node '/tmp/slack api.cjs' run --id 'sess_12345678' --literal '$() ;'";
  const launched = await host.launch(descriptor, { command });
  assert.equal(launched.descriptor.launchedAt, "2026-07-27T12:00:00.000Z");
  assert.equal(steps.length, 0);
  for (const call of calls) assert.equal(call.options.shell, false);
  assert.equal(calls[3].args.at(-1), command);
});

test("cmux host resolves IDs from the requested non-focused workspace, not global active", async () => {
  const calls = [];
  const executable = "/tools/cmux";
  const host = new CmuxSessionHost({
    kind: "cmux",
    executable,
  }, {
    spawnSync: fakeSpawn([
      {
        args: [
          "--json",
          "--id-format", "uuids",
          "workspace", "create",
          "--name", "Slack agent listener",
          "--cwd", path.resolve("/tmp/project"),
          "--focus", "false",
        ],
        stdout: JSON.stringify({ workspace_id: "ws-uuid" }),
      },
      {
        args: [
          "--json",
          "--id-format", "uuids",
          "tree",
          "--workspace", "ws-uuid",
        ],
        stdout: JSON.stringify({
          active: {
            workspace_id: "active-ws",
            pane_id: "active-pane",
            surface_id: "active-surface",
            window_id: "window-uuid",
          },
          windows: [{
            id: "window-uuid",
            workspaces: [
              {
                id: "active-ws",
                panes: [{
                  id: "active-pane",
                  selected_surface_id: "active-surface",
                  surfaces: [{ id: "active-surface" }],
                }],
              },
              {
                id: "ws-uuid",
                panes: [{
                  id: "pane-uuid",
                  selected_surface_id: "surface-uuid",
                  surfaces: [{ id: "surface-uuid" }],
                }],
              },
            ],
          }],
        }),
      },
    ], calls),
    now: fixedNow,
  });
  const descriptor = await host.create({ cwd: "/tmp/project" });
  assert.equal(descriptor.paneId, "pane-uuid");
  assert.equal(descriptor.surfaceId, "surface-uuid");
  assert.equal(descriptor.windowId, "window-uuid");
  assert.equal(descriptor.workspaceId, "ws-uuid");
  assert.equal(descriptor.target, "surface-uuid");
});

test("cmux create never trusts mixed global active pane IDs from create output", async () => {
  const calls = [];
  const host = new CmuxSessionHost({
    kind: "cmux",
    executable: "/tools/cmux",
  }, {
    spawnSync: fakeSpawn([
      {
        stdout: JSON.stringify({
          workspace_id: "ws-new",
          active: {
            workspace_id: "ws-other",
            pane_id: "pane-other",
            surface_id: "surface-other",
          },
        }),
      },
      {
        args: [
          "--json",
          "--id-format", "uuids",
          "tree",
          "--workspace", "ws-new",
        ],
        stdout: JSON.stringify({
          windows: [{
            id: "window-new",
            workspaces: [{
              id: "ws-new",
              panes: [{
                id: "pane-new",
                selected_surface_id: "surface-new",
                surfaces: [{ id: "surface-new" }],
              }],
            }],
          }],
        }),
      },
    ], calls),
  });

  const descriptor = await host.create({ cwd: "/tmp/project" });
  assert.equal(descriptor.workspaceId, "ws-new");
  assert.equal(descriptor.paneId, "pane-new");
  assert.equal(descriptor.surfaceId, "surface-new");
  assert.equal(descriptor.target, "surface-new");
  assert.equal(calls.length, 2);
});

test("cmux create closes a workspace when descriptor JSON cannot be parsed", async () => {
  const calls = [];
  const host = new CmuxSessionHost({
    kind: "cmux",
    executable: "/tools/cmux",
  }, {
    spawnSync: fakeSpawn([
      {
        stdout: "{\"workspace_id\":\"ws-partial\"} trailing garbage",
      },
      {
        args: [
          "--json",
          "--id-format", "uuids",
          "workspace", "close", "ws-partial",
        ],
        stdout: "{}",
      },
    ], calls),
  });

  await assert.rejects(
    host.create({ cwd: "/tmp/project" }),
    /cmux workspace create returned invalid JSON/,
  );
  assert.equal(calls.length, 2);
});

test("cmux create closes a recoverable workspace after a nonzero result", async () => {
  const calls = [];
  const host = new CmuxSessionHost({
    kind: "cmux",
    executable: "/tools/cmux",
  }, {
    spawnSync: fakeSpawn([
      {
        status: 1,
        stdout: JSON.stringify({ workspace_id: "ws-ambiguous" }),
        stderr: "request failed after workspace creation",
      },
      {
        args: [
          "--json",
          "--id-format", "uuids",
          "workspace", "close", "ws-ambiguous",
        ],
        stdout: "{}",
      },
    ], calls),
  });

  await assert.rejects(
    host.create({ cwd: "/tmp/project" }),
    /request failed after workspace creation/,
  );
  assert.equal(calls.length, 2);
});

test("cmux create does not clean up an unrelated active workspace from ambiguous output", async () => {
  const calls = [];
  const host = new CmuxSessionHost({
    kind: "cmux",
    executable: "/tools/cmux",
  }, {
    spawnSync: fakeSpawn([{
      status: 1,
      stdout: JSON.stringify({
        active: {
          workspace_id: "ws-unrelated",
          pane_id: "pane-unrelated",
          surface_id: "surface-unrelated",
        },
      }),
      stderr: "request failed before create acknowledgement",
    }], calls),
  });

  await assert.rejects(
    host.create({ cwd: "/tmp/project" }),
    /request failed before create acknowledgement/,
  );
  assert.equal(calls.length, 1);
});

test("cmux create recovers a workspace id from a synchronously thrown command", async () => {
  const calls = [];
  let invocation = 0;
  const host = new CmuxSessionHost({
    kind: "cmux",
    executable: "/tools/cmux",
  }, {
    spawnSync(command, args, options) {
      calls.push({ command, args, options });
      invocation += 1;
      if (invocation === 1) {
        const error = new Error("cmux transport disconnected");
        error.stdout = JSON.stringify({ workspace_id: "ws-thrown" });
        throw error;
      }
      assert.deepEqual(args, [
        "--json",
        "--id-format", "uuids",
        "workspace", "close", "ws-thrown",
      ]);
      return { status: 0, stdout: "{}", stderr: "" };
    },
  });

  await assert.rejects(
    host.create({ cwd: "/tmp/project" }),
    /cmux transport disconnected/,
  );
  assert.equal(calls.length, 2);
});

test("cmux create closes a workspace when root pane recovery fails", async () => {
  const calls = [];
  const host = new CmuxSessionHost({
    kind: "cmux",
    executable: "/tools/cmux",
  }, {
    spawnSync: fakeSpawn([
      {
        stdout: JSON.stringify({ workspace_id: "ws-partial" }),
      },
      {
        args: [
          "--json",
          "--id-format", "uuids",
          "tree",
          "--workspace", "ws-partial",
        ],
        stdout: JSON.stringify({ workspace_id: "ws-partial" }),
      },
      {
        args: [
          "--json",
          "--id-format", "uuids",
          "workspace", "close", "ws-partial",
        ],
        stdout: "{}",
      },
    ], calls),
  });

  await assert.rejects(
    host.create({ cwd: "/tmp/project" }),
    /could not recover root pane and surface ids/,
  );
  assert.equal(calls.length, 3);
});

test("cmux host inspect and close use the managed workspace UUID", async () => {
  const calls = [];
  const executable = "/tools/cmux";
  const host = new CmuxSessionHost({
    kind: "cmux",
    executable,
  }, {
    spawnSync: fakeSpawn([
      {
        args: [
          "--json",
          "--id-format", "uuids",
          "tree",
          "--workspace", "ws-uuid",
        ],
        stdout: JSON.stringify({
          workspace_id: "ws-uuid",
          pane_id: "pane-uuid",
          surface_id: "surface-uuid",
        }),
      },
      {
        args: [
          "--json",
          "--id-format", "uuids",
          "tree",
          "--workspace", "ws-uuid",
        ],
        stdout: JSON.stringify({
          workspace_id: "ws-uuid",
          pane_id: "pane-uuid",
          surface_id: "surface-uuid",
        }),
      },
      {
        args: [
          "--json",
          "--id-format", "uuids",
          "workspace", "close", "ws-uuid",
        ],
        stdout: "{}",
      },
    ], calls),
    now: fixedNow,
  });
  const descriptor = {
    kind: "cmux",
    managed: true,
    workspaceId: "ws-uuid",
    paneId: "pane-uuid",
    surfaceId: "surface-uuid",
  };
  const inspected = await host.inspect(descriptor);
  assert.equal(inspected.exists, true);
  assert.equal(inspected.owned, true);
  assert.deepEqual(inspected.ownership, {
    verified: true,
    workspace: true,
    paneRelationship: true,
    surfaceRelationship: true,
  });
  assert.equal(inspected.descriptor.surfaceId, "surface-uuid");
  const closed = await host.close(inspected.descriptor);
  assert.equal(closed.closed, true);
  assert.equal(closed.descriptor.closedAt, "2026-07-27T12:00:00.000Z");
  assert.equal(calls.length, 3);
});

test("cmux ownership finds the exact saved pane and surface instead of the active replacement", async () => {
  const calls = [];
  const host = new CmuxSessionHost({
    kind: "cmux",
    executable: "/tools/cmux",
  }, {
    spawnSync: fakeSpawn([{
      stdout: JSON.stringify({
        active: {
          workspace_id: "ws-uuid",
          pane_id: "pane-replacement",
          surface_id: "surface-replacement",
        },
        windows: [{
          id: "window-uuid",
          workspaces: [{
            id: "ws-uuid",
            panes: [
              {
                id: "pane-replacement",
                selected: true,
                selected_surface_id: "surface-replacement",
                surfaces: [{ id: "surface-replacement" }],
              },
              {
                id: "pane-saved",
                selected_surface_id: "surface-saved",
                surfaces: [{ id: "surface-saved" }],
              },
            ],
          }],
        }],
      }),
    }], calls),
  });
  const descriptor = {
    kind: "cmux",
    managed: true,
    workspaceId: "ws-uuid",
    paneId: "pane-saved",
    surfaceId: "surface-saved",
    target: "surface-saved",
  };

  const inspected = await host.inspect(descriptor);

  assert.equal(inspected.ok, true);
  assert.equal(inspected.exists, true);
  assert.equal(inspected.owned, true);
  assert.deepEqual(inspected.descriptor, descriptor);
  assert.equal(calls.length, 1);
});

test("cmux managed ownership fails closed for replaced or incomplete pane topology", async () => {
  const descriptor = {
    kind: "cmux",
    managed: true,
    workspaceId: "ws-saved",
    paneId: "pane-saved",
    surfaceId: "surface-saved",
    target: "surface-saved",
  };
  const scenarios = [
    {
      name: "replaced pane",
      payload: {
        workspace_id: "ws-saved",
        pane_id: "pane-replaced",
        surface_id: "surface-saved",
      },
      pattern: /saved pane no longer belongs/,
    },
    {
      name: "replaced surface",
      payload: {
        workspace_id: "ws-saved",
        pane_id: "pane-saved",
        surface_id: "surface-replaced",
      },
      pattern: /saved surface no longer belongs/,
    },
    {
      name: "missing pane and surface",
      payload: { workspace_id: "ws-saved" },
      pattern: /saved pane no longer belongs/,
    },
    {
      name: "mixed unrelated active topology",
      payload: {
        workspace_id: "ws-saved",
        active: {
          workspace_id: "ws-other",
          pane_id: "pane-saved",
          surface_id: "surface-saved",
        },
      },
      pattern: /saved pane no longer belongs/,
    },
  ];

  for (const scenario of scenarios) {
    const inspectCalls = [];
    const inspecting = new CmuxSessionHost({
      kind: "cmux",
      executable: "/tools/cmux",
    }, {
      spawnSync: fakeSpawn([{
        stdout: JSON.stringify(scenario.payload),
      }], inspectCalls),
    });
    const inspection = await inspecting.inspect(descriptor);
    assert.equal(inspection.ok, false, scenario.name);
    assert.equal(inspection.exists, null, scenario.name);
    assert.equal(inspection.owned, false, scenario.name);
    assert.match(inspection.error, scenario.pattern, scenario.name);
    assert.deepEqual(inspection.descriptor, descriptor, scenario.name);
    assert.equal(inspectCalls.length, 1, scenario.name);

    const closeCalls = [];
    const closing = new CmuxSessionHost({
      kind: "cmux",
      executable: "/tools/cmux",
    }, {
      spawnSync: fakeSpawn([{
        stdout: JSON.stringify(scenario.payload),
      }], closeCalls),
    });
    await assert.rejects(
      closing.close(descriptor),
      scenario.pattern,
      scenario.name,
    );
    assert.equal(closeCalls.length, 1, scenario.name);
    assert.equal(
      closeCalls.some((call) => call.args.includes("close")),
      false,
      scenario.name,
    );
  }
});

test("cmux partial-create cleanup is explicit and cannot become keep-host ownership", async () => {
  const calls = [];
  const host = new CmuxSessionHost({
    kind: "cmux",
    executable: "/tools/cmux",
  }, {
    spawnSync: fakeSpawn([{
      args: [
        "--json",
        "--id-format", "uuids",
        "workspace", "close", "ws-partial",
      ],
      stdout: "{}",
    }], calls),
    now: fixedNow,
  });
  const partial = {
    kind: "cmux",
    managed: true,
    workspaceId: "ws-partial",
    paneId: null,
    surfaceId: null,
    target: "ws-partial",
    launchedAt: null,
    status: "cleanup_pending",
    cleanup: {
      attempted: true,
      ok: false,
      pending: true,
    },
  };

  const inspection = await host.inspect(partial);
  assert.equal(inspection.ok, false);
  assert.equal(inspection.exists, null);
  assert.equal(inspection.owned, false);
  assert.equal(inspection.reason, "partial_create_cleanup_only");
  assert.equal(inspection.ownership.partialCreateCleanupOnly, true);
  assert.deepEqual(inspection.descriptor, partial);
  assert.equal(calls.length, 0);

  const closed = await host.close(partial);
  assert.equal(closed.closed, true);
  assert.equal(closed.partialCreateCleanup, true);
  assert.equal(closed.descriptor.cleanup.pending, false);
  assert.equal(closed.descriptor.closedAt, "2026-07-27T12:00:00.000Z");
  assert.equal(calls.length, 1);
});

test("cmux incomplete managed descriptors outside partial-create cleanup never mutate", async () => {
  const calls = [];
  const host = new CmuxSessionHost({
    kind: "cmux",
    executable: "/tools/cmux",
  }, {
    spawnSync: fakeSpawn([], calls),
  });
  const incomplete = {
    kind: "cmux",
    managed: true,
    workspaceId: "ws-legacy",
    paneId: null,
    surfaceId: null,
    target: "ws-legacy",
    status: "running",
  };

  const inspection = await host.inspect(incomplete);
  assert.equal(inspection.ok, false);
  assert.equal(inspection.owned, false);
  assert.match(inspection.error, /saved pane id is missing/);
  assert.deepEqual(inspection.descriptor, incomplete);
  await assert.rejects(
    host.close(incomplete),
    /saved pane id is missing/,
  );
  assert.equal(calls.length, 0);
});

test("host inspect diagnostics redact saved connection endpoints", async () => {
  const cmuxSocket = "/private/tmp/private-cmux.sock";
  const cmux = new CmuxSessionHost({
    kind: "cmux",
    executable: "/tools/cmux",
    connection: {
      environment: { CMUX_SOCKET_PATH: cmuxSocket },
    },
  }, {
    spawnSync: fakeSpawn([{
      status: 1,
      stderr: `cannot inspect through ${cmuxSocket}`,
    }], []),
  });
  const cmuxInspection = await cmux.inspect({
    kind: "cmux",
    managed: true,
    workspaceId: "ws-private",
    paneId: "pane-private",
    surfaceId: "surface-private",
  });
  assert.match(cmuxInspection.error, /redacted host connection/);
  assert.doesNotMatch(cmuxInspection.error, /private-cmux\.sock/);

  const herdrSocket = "/private/tmp/private-herdr.sock";
  const unmanagedHerdr = new HerdrSessionHost({
    kind: "herdr",
    executable: "/tools/herdr",
    connection: {
      environment: { HERDR_SOCKET_PATH: herdrSocket },
    },
  }, {
    spawnSync: fakeSpawn([{
      status: 1,
      stderr: `cannot inspect through ${herdrSocket}`,
    }], []),
  });
  const herdrInspection = await unmanagedHerdr.inspect({
    kind: "herdr",
    managed: false,
    paneId: "w1:p1",
  });
  assert.match(herdrInspection.error, /redacted host connection/);
  assert.doesNotMatch(herdrInspection.error, /private-herdr\.sock/);

  const managedHerdr = new HerdrSessionHost({
    kind: "herdr",
    executable: "/tools/herdr",
    connection: {
      environment: { HERDR_SOCKET_PATH: herdrSocket },
    },
  }, {
    spawnSync: fakeSpawn([{
      status: 1,
      stderr: `cannot verify through ${herdrSocket}`,
    }], []),
  });
  await assert.rejects(managedHerdr.inspect({
    kind: "herdr",
    managed: true,
    workspaceId: "w1",
    paneId: "w1:p1",
    label: "Slack session sess_mabc1234_Qx9yZ7wV",
  }), (error) => {
    assert.match(error.message, /redacted host connection/);
    assert.doesNotMatch(error.message, /private-herdr\.sock/);
    return true;
  });
});

test("host close treats only a confirmed missing workspace as idempotent", async () => {
  const descriptor = {
    kind: "cmux",
    managed: true,
    workspaceId: "ws-missing",
    paneId: "pane-missing",
    surfaceId: "surface-missing",
  };
  const missing = new CmuxSessionHost({
    kind: "cmux",
    executable: "/tools/cmux",
  }, {
    spawnSync: fakeSpawn([{
      status: 1,
      stderr: "workspace not found: ws-missing",
    }], []),
    now: fixedNow,
  });
  const closed = await missing.close(descriptor);
  assert.equal(closed.closed, true);
  assert.equal(closed.alreadyMissing, true);
  assert.equal(closed.descriptor.closedAt, "2026-07-27T12:00:00.000Z");

  const denied = new CmuxSessionHost({
    kind: "cmux",
    executable: "/tools/cmux",
  }, {
    spawnSync: fakeSpawn([{
      status: 1,
      stderr: "permission denied",
    }], []),
  });
  await assert.rejects(denied.close(descriptor), /permission denied/);

  const missingSocket = new CmuxSessionHost({
    kind: "cmux",
    executable: "/tools/cmux",
  }, {
    spawnSync: fakeSpawn([{
      status: 1,
      stderr: "workspace close failed: server socket does not exist",
    }], []),
  });
  await assert.rejects(missingSocket.close(descriptor), /server socket does not exist/);

  const identifiedMissing = new CmuxSessionHost({
    kind: "cmux",
    executable: "/tools/cmux",
  }, {
    spawnSync: fakeSpawn([{
      status: 1,
      stderr: "workspace ws-missing does not exist",
    }], []),
    now: fixedNow,
  });
  assert.equal((await identifiedMissing.close(descriptor)).alreadyMissing, true);
});

test("Herdr host uses workspace root IDs and atomic pane run", async () => {
  const calls = [];
  const executable = "/tools/herdr";
  const steps = [
    {
      args: ["status", "server"],
      stdout: "{\"ok\":true}\n",
    },
    {
      args: [
        "workspace", "create",
        "--cwd", path.resolve("/tmp/project"),
        "--label", "Slack listener",
        "--no-focus",
        "--env", "SLACK_AGENT_SESSION_ID=sess_12345678",
      ],
      stdout: JSON.stringify({
        result: {
          workspace: { workspace_id: "w1" },
          tab: { tab_id: "w1:t1" },
          root_pane: { pane_id: "w1:p1" },
        },
      }),
    },
    {
      args: ["pane", "run", "w1:p1", "node listener.cjs --id sess_12345678"],
      stdout: "{\"ok\":true}\n",
    },
    {
      args: ["workspace", "get", "w1"],
      stdout: JSON.stringify({
        result: {
          workspace: {
            workspace_id: "w1",
            label: "Slack listener",
          },
        },
      }),
    },
    {
      args: ["pane", "get", "w1:p1"],
      stdout: JSON.stringify({
        result: {
          pane: {
            pane_id: "w1:p1",
            workspace_id: "w1",
            tab_id: "w1:t1",
          },
        },
      }),
    },
    {
      args: ["workspace", "get", "w1"],
      stdout: JSON.stringify({
        result: {
          workspace: {
            workspace_id: "w1",
            label: "Slack listener",
          },
        },
      }),
    },
    {
      args: ["pane", "get", "w1:p1"],
      stdout: JSON.stringify({
        result: {
          pane: {
            pane_id: "w1:p1",
            workspace_id: "w1",
            tab_id: "w1:t1",
          },
        },
      }),
    },
    {
      args: ["workspace", "close", "w1"],
      stdout: "{\"ok\":true}\n",
    },
  ];
  const host = new HerdrSessionHost({
    kind: "herdr",
    executable,
    source: "explicit",
  }, {
    spawnSync: fakeSpawn(steps, calls),
    now: fixedNow,
    env: { HERDR_SESSION: "default" },
  });
  await host.preflight();
  const descriptor = await host.create({
    sessionId: "sess_12345678",
    label: "Slack listener",
    cwd: "/tmp/project",
    environment: { SLACK_AGENT_SESSION_ID: "sess_12345678" },
  });
  assert.equal(descriptor.workspaceId, "w1");
  assert.equal(descriptor.tabId, "w1:t1");
  assert.equal(descriptor.paneId, "w1:p1");
  assert.equal(descriptor.target, "w1:p1");
  await host.launch(descriptor, { command: "node listener.cjs --id sess_12345678" });
  const inspected = await host.inspect(descriptor);
  assert.equal(inspected.exists, true);
  assert.equal(inspected.owned, true);
  assert.deepEqual(inspected.ownership, {
    verified: true,
    label: true,
    paneRelationship: true,
  });
  assert.equal((await host.close(descriptor)).closed, true);
  assert.equal(steps.length, 0);
  for (const call of calls) assert.equal(call.options.shell, false);
});

test("Herdr close fails closed when a reused workspace id has a different label", async () => {
  const calls = [];
  const host = new HerdrSessionHost({
    kind: "herdr",
    executable: "/tools/herdr",
  }, {
    spawnSync: fakeSpawn([{
      args: ["workspace", "get", "w1"],
      stdout: JSON.stringify({
        result: {
          workspace: {
            workspace_id: "w1",
            label: "Unrelated workspace",
          },
        },
      }),
    }], calls),
  });
  const descriptor = {
    kind: "herdr",
    managed: true,
    workspaceId: "w1",
    paneId: "w1:p1",
    label: "Slack session sess_mabc1234_Qx9yZ7wV",
  };

  await assert.rejects(host.close(descriptor), (error) => {
    assert.match(error.message, /ownership mismatch.*label/i);
    assert.doesNotMatch(error.message, /Unrelated workspace|sess_mabc/);
    return true;
  });
  assert.equal(calls.length, 1);
});

test("Herdr close requires the saved pane to belong to the saved workspace", async () => {
  const calls = [];
  const label = "Slack session sess_mabc1234_Qx9yZ7wV";
  const host = new HerdrSessionHost({
    kind: "herdr",
    executable: "/tools/herdr",
  }, {
    spawnSync: fakeSpawn([
      {
        args: ["workspace", "get", "w1"],
        stdout: JSON.stringify({
          result: {
            workspace: { workspace_id: "w1", label },
          },
        }),
      },
      {
        args: ["pane", "get", "w1:p1"],
        stdout: JSON.stringify({
          result: {
            pane: {
              pane_id: "w1:p1",
              workspace_id: "w2",
            },
          },
        }),
      },
    ], calls),
  });

  await assert.rejects(host.close({
    kind: "herdr",
    managed: true,
    workspaceId: "w1",
    paneId: "w1:p1",
    label,
  }), /ownership mismatch.*pane\/workspace relationship/i);
  assert.equal(calls.length, 2);
});

test("Herdr close treats a verified missing workspace as already closed", async () => {
  const calls = [];
  const host = new HerdrSessionHost({
    kind: "herdr",
    executable: "/tools/herdr",
  }, {
    spawnSync: fakeSpawn([{
      args: ["workspace", "get", "w1"],
      status: 1,
      stderr: "workspace not found: w1",
    }], calls),
    now: fixedNow,
  });

  const closed = await host.close({
    kind: "herdr",
    managed: true,
    workspaceId: "w1",
    paneId: "w1:p1",
    label: "Slack session sess_mabc1234_Qx9yZ7wV",
  });
  assert.equal(closed.closed, true);
  assert.equal(closed.alreadyMissing, true);
  assert.equal(closed.descriptor.closedAt, "2026-07-27T12:00:00.000Z");
  assert.equal(calls.length, 1);
});

test("Herdr create-error cleanup verifies the requested label before closing", async () => {
  const calls = [];
  const host = new HerdrSessionHost({
    kind: "herdr",
    executable: "/tools/herdr",
  }, {
    spawnSync: fakeSpawn([
      {
        stdout: JSON.stringify({
          result: {
            workspace: { workspace_id: "w-partial" },
          },
        }),
      },
      {
        args: ["workspace", "get", "w-partial"],
        stdout: JSON.stringify({
          result: {
            workspace: {
              workspace_id: "w-partial",
              label: "Slack agent listener",
            },
          },
        }),
      },
      {
        args: ["workspace", "close", "w-partial"],
        stdout: "{\"ok\":true}",
      },
    ], calls),
  });

  await assert.rejects(
    host.create({ cwd: "/tmp/project" }),
    /did not return workspace and root pane ids/,
  );
  assert.equal(calls.length, 3);
});

test("Herdr create-error cleanup preserves a collision instead of closing it", async () => {
  const calls = [];
  const host = new HerdrSessionHost({
    kind: "herdr",
    executable: "/tools/herdr",
  }, {
    spawnSync: fakeSpawn([
      {
        status: 1,
        stdout: JSON.stringify({
          result: {
            workspace: { workspace_id: "w-reused" },
          },
        }),
        stderr: "request failed after workspace creation",
      },
      {
        args: ["workspace", "get", "w-reused"],
        stdout: JSON.stringify({
          result: {
            workspace: {
              workspace_id: "w-reused",
              label: "Someone else's workspace",
            },
          },
        }),
      },
    ], calls),
  });

  await assert.rejects(host.create({ cwd: "/tmp/project" }), (error) => {
    assert.match(error.message, /request failed after workspace creation/);
    assert.equal(error.hostDescriptor.status, "cleanup_pending");
    assert.match(error.hostDescriptor.cleanup.error, /ownership mismatch.*label/i);
    assert.doesNotMatch(error.hostDescriptor.cleanup.error, /Someone else's/);
    return true;
  });
  assert.equal(calls.length, 2);
});

test("Herdr create best-effort closes a workspace when its root pane is missing", async () => {
  const calls = [];
  const host = new HerdrSessionHost({
    kind: "herdr",
    executable: "/tools/herdr",
  }, {
    spawnSync: fakeSpawn([
      {
        stdout: JSON.stringify({
          result: {
            workspace: { workspace_id: "w-partial" },
          },
        }),
      },
      {
        args: ["workspace", "get", "w-partial"],
        stdout: JSON.stringify({
          result: {
            workspace: {
              workspace_id: "w-partial",
              label: "Slack agent listener",
            },
          },
        }),
      },
      {
        args: ["workspace", "close", "w-partial"],
        error: new Error("socket closed during cleanup"),
      },
    ], calls),
  });

  await assert.rejects(host.create({ cwd: "/tmp/project" }), (error) => {
    assert.match(error.message, /did not return workspace and root pane ids/);
    assert.equal(error.hostDescriptor.managed, true);
    assert.equal(error.hostDescriptor.workspaceId, "w-partial");
    assert.equal(error.hostDescriptor.status, "cleanup_pending");
    assert.equal(error.hostDescriptor.cleanup.pending, true);
    assert.match(error.hostDescriptor.cleanup.error, /socket closed during cleanup/);
    return true;
  });
  assert.equal(calls.length, 3);
});

test("Herdr create preserves a redacted cleanup-pending descriptor after a recoverable timeout", async () => {
  const calls = [];
  const socketPath = "/private/tmp/herdr-private.sock";
  const timeout = new Error(`spawnSync herdr ETIMEDOUT at ${socketPath}`);
  timeout.code = "ETIMEDOUT";
  const host = new HerdrSessionHost({
    kind: "herdr",
    executable: "/tools/herdr",
    connection: {
      environment: {
        HERDR_SOCKET_PATH: socketPath,
      },
    },
  }, {
    spawnSync: fakeSpawn([
      {
        status: null,
        stdout: JSON.stringify({
          result: {
            workspace: { workspace_id: "w-timeout" },
          },
        }),
        error: timeout,
      },
      {
        args: ["workspace", "get", "w-timeout"],
        status: 1,
        stderr: `cleanup unavailable at ${socketPath}`,
      },
    ], calls),
  });

  await assert.rejects(host.create({ cwd: "/tmp/project" }), (error) => {
    assert.match(error.message, /ETIMEDOUT/);
    assert.doesNotMatch(error.message, /herdr-private\.sock/);
    assert.equal(error.hostDescriptor.managed, true);
    assert.equal(error.hostDescriptor.workspaceId, "w-timeout");
    assert.equal(error.hostDescriptor.status, "cleanup_pending");
    assert.equal(error.hostDescriptor.cleanup.pending, true);
    assert.match(error.hostDescriptor.cleanup.error, /redacted host connection/);
    assert.doesNotMatch(error.hostDescriptor.cleanup.error, /herdr-private\.sock/);
    assert.deepEqual(error.hostDescriptor.connection, {
      environment: {
        HERDR_SOCKET_PATH: socketPath,
      },
    });
    return true;
  });
  assert.equal(calls.length, 2);
});

test("launch commands are one physical line and unmanaged hosts are never closed", async () => {
  const calls = [];
  const host = createSessionHost({
    kind: "cmux",
    executable: "/tools/cmux",
  }, {
    spawnSync: fakeSpawn([], calls),
    now: fixedNow,
  });
  await assert.rejects(
    host.launch({
      kind: "cmux",
      managed: true,
      surfaceId: "surface-uuid",
    }, {
      command: "node listener.cjs\nrm -rf nope",
    }),
    /one physical line/,
  );
  const closed = await host.close({
    kind: "cmux",
    managed: false,
    workspaceId: "somebody-elses-workspace",
  });
  assert.equal(closed.closed, false);
  assert.equal(closed.reason, "host_not_managed");
  assert.equal(calls.length, 0);
});

test("standalone launch failures never expose the private runtime command", async () => {
  const calls = [];
  const privateCommand = "env CMUX_SOCKET_PATH='/private/provider.sock' node listener.cjs --runtime-instance runtime_private";
  const host = createSessionHost({
    kind: "cmux",
    executable: "/tools/cmux",
  }, {
    spawnSync: fakeSpawn([{
      status: 1,
      stderr: `send failed for ${privateCommand}`,
    }], calls),
  });

  await assert.rejects(
    host.launch({
      kind: "cmux",
      managed: true,
      workspaceId: "workspace-uuid",
      surfaceId: "surface-uuid",
    }, { command: privateCommand }),
    (error) => {
      assert.match(error.message, /redacted sensitive host diagnostic/);
      assert.doesNotMatch(error.message, /runtime_private|provider\.sock|listener\.cjs/);
      return true;
    },
  );
});

test("Herdr create failures redact listener environment values", async () => {
  const calls = [];
  const privateTargetSession = "codex-thread-private-123";
  const host = createSessionHost({
    kind: "herdr",
    executable: "/tools/herdr",
  }, {
    spawnSync: fakeSpawn([{
      status: 1,
      stderr: `invalid --env SLACK_AGENT_TARGET_SESSION_ID=${privateTargetSession}`,
    }], calls),
  });

  await assert.rejects(
    host.create({
      cwd: "/tmp/project",
      environment: {
        SLACK_AGENT_TARGET_SESSION_ID: privateTargetSession,
      },
    }),
    (error) => {
      assert.match(error.message, /redacted host connection/);
      assert.doesNotMatch(error.message, /codex-thread-private-123/);
      return true;
    },
  );
});
