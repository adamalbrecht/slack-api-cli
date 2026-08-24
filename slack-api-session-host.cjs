const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const HOST_KINDS = ["auto", "process", "cmux", "herdr"];
const HOST_CONNECTION_ENV_KEYS = Object.freeze({
  cmux: Object.freeze([
    "CMUX_SOCKET_PATH",
    "CMUX_SOCKET_MODE",
  ]),
  herdr: Object.freeze([
    "HERDR_SOCKET_PATH",
    "HERDR_SESSION",
    "HERDR_CONTEXT",
    "HERDR_CONTEXT_NAME",
  ]),
  process: Object.freeze([]),
});
const HOST_DYNAMIC_CONTEXT_ENV_KEYS = Object.freeze({
  cmux: Object.freeze([
    "CMUX_WORKSPACE_ID",
    "CMUX_SURFACE_ID",
    "CMUX_TAB_ID",
  ]),
  herdr: Object.freeze([
    "HERDR_ENV",
    "HERDR_PANE_ID",
    "HERDR_WORKSPACE_ID",
  ]),
  process: Object.freeze([]),
});
const CMUX_APP_CLI_PATHS = [
  "/Applications/cmux.app/Contents/Resources/bin/cmux",
  path.join(os.homedir(), "Applications", "cmux.app", "Contents", "Resources", "bin", "cmux"),
];

function nonEmpty(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function executableExists(candidate, accessSync = fs.accessSync) {
  if (!candidate) return false;
  try {
    accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findExecutable(command, env = process.env, accessSync = fs.accessSync) {
  const candidate = nonEmpty(command);
  if (!candidate) return null;
  if (candidate.includes(path.sep)) {
    const resolved = path.resolve(candidate);
    return executableExists(resolved, accessSync) ? resolved : null;
  }
  for (const directory of String(env.PATH || "").split(path.delimiter).filter(Boolean)) {
    const resolved = path.join(directory, candidate);
    if (executableExists(resolved, accessSync)) return resolved;
  }
  return null;
}

function resolveCandidate(candidate, env, accessSync) {
  if (!candidate) return null;
  return findExecutable(candidate, env, accessSync);
}

function resolveCmuxExecutable({
  executable = "",
  env = process.env,
  accessSync = fs.accessSync,
} = {}) {
  const candidates = [
    executable,
    env.CMUX_BIN_PATH,
    env.CMUX_BUNDLED_CLI_PATH,
    "cmux",
    ...CMUX_APP_CLI_PATHS,
  ];
  for (const candidate of candidates) {
    const resolved = resolveCandidate(candidate, env, accessSync);
    if (resolved) return resolved;
  }
  return null;
}

function resolveHerdrExecutable({
  executable = "",
  env = process.env,
  accessSync = fs.accessSync,
} = {}) {
  const candidates = [
    executable,
    env.HERDR_BIN_PATH,
    "herdr",
  ];
  for (const candidate of candidates) {
    const resolved = resolveCandidate(candidate, env, accessSync);
    if (resolved) return resolved;
  }
  return null;
}

function providerName(provider) {
  if (typeof provider === "string") return provider.toLowerCase();
  return String(provider?.name || "").toLowerCase();
}

function hostConnectionEnvironment(kind, env = {}) {
  const selected = {};
  for (const key of HOST_CONNECTION_ENV_KEYS[kind] || []) {
    if (!Object.hasOwn(env, key) || env[key] === undefined || env[key] === null) continue;
    const value = String(env[key]);
    if (!value) continue;
    if (/[\0\r\n]/.test(value)) {
      throw new Error(`Host connection environment ${key} contains a control character`);
    }
    selected[key] = value;
  }
  return selected;
}

function captureHostConnection(kind, env = process.env) {
  if (!(kind in HOST_CONNECTION_ENV_KEYS) || kind === "process") return null;
  return { environment: hostConnectionEnvironment(kind, env) };
}

function applyHostConnection(kind, env, connection) {
  const applied = { ...(env || {}) };
  if (!connection) return applied;
  for (const key of [
    ...(HOST_CONNECTION_ENV_KEYS[kind] || []),
    ...(HOST_DYNAMIC_CONTEXT_ENV_KEYS[kind] || []),
  ]) {
    delete applied[key];
  }
  Object.assign(
    applied,
    hostConnectionEnvironment(kind, connection.environment || {}),
  );
  return applied;
}

function hasCmuxContext(env) {
  return Boolean(env.CMUX_SURFACE_ID || env.CMUX_WORKSPACE_ID);
}

function hasHerdrContext(env) {
  return Boolean(
    env.HERDR_PANE_ID
    || env.HERDR_WORKSPACE_ID
    || env.HERDR_SOCKET_PATH
    || env.HERDR_ENV === "1",
  );
}

function resolveHostCandidates({
  kind = "auto",
  provider = null,
  executable = "",
  env = process.env,
  connection = null,
} = {}, dependencies = {}) {
  const requested = String(kind || "auto").toLowerCase();
  if (!HOST_KINDS.includes(requested)) {
    throw new Error(`Unknown session host ${kind}. Expected one of: ${HOST_KINDS.join(", ")}`);
  }
  const accessSync = dependencies.accessSync || fs.accessSync;
  const resolveKind = (candidate, source) => {
    if (candidate === "process") {
      return { kind: "process", executable: null, source };
    }
    const resolved = candidate === "cmux"
      ? resolveCmuxExecutable({ executable, env, accessSync })
      : resolveHerdrExecutable({ executable, env, accessSync });
    if (!resolved) return null;
    return {
      kind: candidate,
      executable: resolved,
      source,
      connection: connection
        ? {
          environment: hostConnectionEnvironment(
            candidate,
            connection.environment || {},
          ),
        }
        : captureHostConnection(candidate, env),
    };
  };

  if (requested !== "auto") {
    const explicit = resolveKind(requested, "explicit");
    if (!explicit) {
      throw new Error(
        `${requested} was selected as the session host, but its CLI executable was not found`,
      );
    }
    return [explicit];
  }

  const candidates = [];
  const add = (candidate, source) => {
    const resolved = resolveKind(candidate, source);
    if (resolved && !candidates.some((current) => current.kind === resolved.kind)) {
      candidates.push(resolved);
    }
  };
  const targetProvider = providerName(provider);
  if (targetProvider === "cmux" || targetProvider === "herdr") {
    add(targetProvider, "target_provider");
  }
  if (hasCmuxContext(env)) add("cmux", "terminal_context");
  if (hasHerdrContext(env)) add("herdr", "terminal_context");
  add("cmux", "available_cli");
  add("herdr", "available_cli");
  add("process", "fallback");
  return candidates;
}

function resolveHostConfig(options = {}, dependencies = {}) {
  return resolveHostCandidates(options, dependencies)[0];
}

function normalizeEnvironment(environment = {}) {
  const entries = Array.isArray(environment)
    ? environment.map((entry) => {
      if (Array.isArray(entry)) return [entry[0], entry[1]];
      const separator = String(entry).indexOf("=");
      if (separator < 1) throw new Error(`Invalid host environment entry: ${entry}`);
      return [String(entry).slice(0, separator), String(entry).slice(separator + 1)];
    })
    : Object.entries(environment).sort(([left], [right]) => left.localeCompare(right));
  return entries.map(([rawKey, rawValue]) => {
    const key = String(rawKey || "");
    const value = String(rawValue ?? "");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid host environment variable name: ${key}`);
    }
    if (value.includes("\0")) {
      throw new Error(`Host environment variable ${key} contains a NUL byte`);
    }
    return [key, value];
  });
}

function normalizeCreateOptions(options = {}) {
  const sessionId = nonEmpty(options.sessionId);
  const cwd = path.resolve(options.cwd || process.cwd());
  const defaultLabel = sessionId
    ? `Slack agent ${sessionId}`
    : "Slack agent listener";
  const label = String(options.label || defaultLabel)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, 80) || defaultLabel;
  return {
    sessionId,
    cwd,
    label,
    environment: normalizeEnvironment(options.environment || options.env || {}),
    windowId: nonEmpty(options.windowId),
  };
}

function validateLaunchCommand(value) {
  const command = String(value || "");
  if (!command.trim()) throw new Error("A non-empty host launch command is required");
  if (/[\0\r\n]/.test(command)) {
    throw new Error("Host launch command must be one physical line");
  }
  return command;
}

function targetMissing(result, targetId = "") {
  const diagnostic = String(result?.stderr || result?.stdout || "");
  if (
    /\b(?:workspace|pane|surface)(?:[_ -]not[_ -]found|\s+(?:not found|does not exist))\b/i
      .test(diagnostic)
    || /\b(?:no such|unknown)\s+(?:workspace|pane|surface)\b/i.test(diagnostic)
  ) {
    return true;
  }
  const identifier = String(targetId || "").trim();
  if (!identifier) return false;
  const escapedIdentifier = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `\\b(?:workspace|pane|surface)\\s+(?:id\\s+)?["']?${escapedIdentifier}["']?\\s+(?:not found|does not exist)\\b`,
    "i",
  ).test(diagnostic);
}

function parseJsonOutput(output, context) {
  const text = String(output || "").trim();
  if (!text) throw new Error(`${context} returned no JSON output`);
  const attempts = [text];
  const objectStart = text.indexOf("{");
  const arrayStart = text.indexOf("[");
  const starts = [objectStart, arrayStart].filter((index) => index >= 0).sort((a, b) => a - b);
  if (starts.length && starts[0] > 0) attempts.push(text.slice(starts[0]));
  for (const line of text.split("\n").reverse()) {
    if (/^\s*[\[{]/.test(line)) attempts.push(line.trim());
  }
  for (const attempt of [...new Set(attempts)]) {
    try {
      return JSON.parse(attempt);
    } catch {}
  }
  throw new Error(`${context} returned invalid JSON`);
}

function lookupPath(value, segments) {
  let current = value;
  for (const segment of segments) {
    if (!current || typeof current !== "object") return null;
    current = current[segment];
  }
  return nonEmpty(current);
}

function findKey(value, keys, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  for (const key of keys) {
    const direct = nonEmpty(value[key]);
    if (direct) return direct;
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = findKey(child, keys, seen);
    if (found) return found;
  }
  return null;
}

function idsFromPayload(payload) {
  return {
    windowId: findKey(payload, ["window_id", "windowId", "window_uuid", "windowUuid"]),
    workspaceId: findKey(payload, [
      "workspace_id",
      "workspaceId",
      "workspace_uuid",
      "workspaceUuid",
      "workspace_ref",
    ]),
    tabId: findKey(payload, ["tab_id", "tabId", "tab_uuid", "tabUuid"]),
    paneId: findKey(payload, ["pane_id", "paneId", "pane_uuid", "paneUuid"]),
    surfaceId: findKey(payload, [
      "surface_id",
      "surfaceId",
      "surface_uuid",
      "surfaceUuid",
      "surface_ref",
    ]),
  };
}

function workspaceIdFromOutput(output) {
  const text = String(output || "");
  const match = text.match(
    /"(?:workspace_id|workspaceId|workspace_uuid|workspaceUuid|workspace_ref)"\s*:\s*"([^"\r\n]+)"/,
  );
  return nonEmpty(match?.[1]);
}

function cmuxCreatedWorkspaceId(payload) {
  const roots = [payload, payload?.result, payload?.data]
    .filter((value) => value && typeof value === "object");
  for (const root of roots) {
    const direct = firstId(root, [
      "workspace_id",
      "workspaceId",
      "workspace_uuid",
      "workspaceUuid",
      "workspace_ref",
    ]);
    if (direct) return direct;
    const workspace = root.workspace;
    const nested = firstId(workspace, [
      "id",
      "workspace_id",
      "workspaceId",
      "workspace_uuid",
      "workspaceUuid",
      "workspace_ref",
    ]);
    if (nested) return nested;
  }
  return null;
}

function cmuxCreatedWorkspaceIdFromOutput(output) {
  try {
    return cmuxCreatedWorkspaceId(
      parseJsonOutput(output, "cmux workspace create recovery"),
    );
  } catch {}
  const match = String(output || "").match(
    /^\s*\{\s*"(?:workspace_id|workspaceId|workspace_uuid|workspaceUuid|workspace_ref)"\s*:\s*"([^"\r\n]+)"/,
  );
  return nonEmpty(match?.[1]);
}

function firstId(value, keys) {
  if (!value || typeof value !== "object") return null;
  for (const key of keys) {
    const candidate = nonEmpty(value[key]);
    if (candidate) return candidate;
  }
  return null;
}

function cmuxFlatTopologyIds(payload, requestedWorkspaceId) {
  const workspaceId = nonEmpty(requestedWorkspaceId);
  const roots = [payload, payload?.result, payload?.data]
    .filter((value) => value && typeof value === "object");
  const workspaceKeys = [
    "workspace_id",
    "workspaceId",
    "workspace_uuid",
    "workspaceUuid",
    "workspace_ref",
  ];
  for (const root of roots) {
    const workspace = root.workspace && typeof root.workspace === "object"
      ? root.workspace
      : null;
    const candidateWorkspaceId = firstId(root, workspaceKeys)
      || firstId(workspace, ["id", ...workspaceKeys]);
    if (candidateWorkspaceId !== workspaceId) continue;
    return {
      windowId: firstId(root, [
        "window_id",
        "windowId",
        "window_uuid",
        "windowUuid",
      ]) || firstId(root.window, ["id", "window_id", "windowId"]),
      workspaceId,
      tabId: firstId(root, ["tab_id", "tabId", "tab_uuid", "tabUuid"])
        || firstId(root.tab, ["id", "tab_id", "tabId"]),
      paneId: firstId(root, ["pane_id", "paneId", "pane_uuid", "paneUuid"])
        || firstId(root.pane, ["id", "pane_id", "paneId", "pane_uuid", "paneUuid"]),
      surfaceId: firstId(root, [
        "surface_id",
        "surfaceId",
        "surface_uuid",
        "surfaceUuid",
        "surface_ref",
      ]) || firstId(root.surface, [
        "id",
        "surface_id",
        "surfaceId",
        "surface_uuid",
        "surfaceUuid",
      ]),
    };
  }
  return null;
}

function cmuxTopologyIds(payload, requestedWorkspaceId, {
  expectedPaneId = null,
  expectedSurfaceId = null,
} = {}) {
  const workspaceId = nonEmpty(requestedWorkspaceId);
  if (!workspaceId) throw new Error("A cmux workspace id is required to parse topology");
  const savedPaneId = nonEmpty(expectedPaneId);
  const savedSurfaceId = nonEmpty(expectedSurfaceId);

  const roots = [payload, payload?.result, payload?.data]
    .filter((value) => value && typeof value === "object");
  for (const root of roots) {
    for (const window of Array.isArray(root.windows) ? root.windows : []) {
      for (const workspace of Array.isArray(window.workspaces) ? window.workspaces : []) {
        const candidateWorkspaceId = firstId(workspace, [
          "id",
          "workspace_id",
          "workspaceId",
          "workspace_uuid",
          "workspaceUuid",
        ]);
        if (candidateWorkspaceId !== workspaceId) continue;
        const panes = Array.isArray(workspace.panes) ? workspace.panes : [];
        const pane = savedPaneId
          ? panes.find((candidate) => (
            firstId(candidate, ["id", "pane_id", "paneId", "pane_uuid", "paneUuid"])
              === savedPaneId
          )) || null
          : panes.find((candidate) => (
            candidate?.selected === true
            || candidate?.focused === true
            || candidate?.active === true
          )) || panes[0] || null;
        const paneId = firstId(pane, ["id", "pane_id", "paneId", "pane_uuid", "paneUuid"]);
        const surfaces = Array.isArray(pane?.surfaces) ? pane.surfaces : [];
        const selectedSurfaceId = firstId(pane, [
          "selected_surface_id",
          "selectedSurfaceId",
          "surface_id",
          "surfaceId",
        ]);
        const surface = savedSurfaceId
          ? surfaces.find((candidate) => (
            firstId(candidate, [
              "id",
              "surface_id",
              "surfaceId",
              "surface_uuid",
              "surfaceUuid",
            ]) === savedSurfaceId
          )) || null
          : surfaces.find((candidate) => (
            firstId(candidate, ["id", "surface_id", "surfaceId"]) === selectedSurfaceId
          )) || surfaces.find((candidate) => (
            candidate?.selected === true
            || candidate?.selected_in_pane === true
            || candidate?.focused === true
            || candidate?.active === true
          )) || surfaces[0] || null;
        const surfaceId = savedSurfaceId
          ? (
            firstId(surface, [
              "id",
              "surface_id",
              "surfaceId",
              "surface_uuid",
              "surfaceUuid",
            ])
            || (selectedSurfaceId === savedSurfaceId ? selectedSurfaceId : null)
          )
          : selectedSurfaceId
            || firstId(surface, [
              "id",
              "surface_id",
              "surfaceId",
              "surface_uuid",
              "surfaceUuid",
            ]);
        return {
          windowId: firstId(window, ["id", "window_id", "windowId", "window_uuid", "windowUuid"]),
          workspaceId,
          tabId: firstId(surface, ["tab_id", "tabId", "tab_uuid", "tabUuid"]),
          paneId,
          surfaceId,
        };
      }
    }
  }

  const active = roots
    .map((root) => root.active)
    .find((candidate) => firstId(candidate, ["workspace_id", "workspaceId"]) === workspaceId);
  if (active) {
    return {
      windowId: firstId(active, ["window_id", "windowId", "window_uuid", "windowUuid"]),
      workspaceId,
      tabId: firstId(active, ["tab_id", "tabId", "tab_uuid", "tabUuid"]),
      paneId: firstId(active, ["pane_id", "paneId", "pane_uuid", "paneUuid"]),
      surfaceId: firstId(active, [
        "surface_id",
        "surfaceId",
        "surface_uuid",
        "surfaceUuid",
      ]),
    };
  }

  if (!roots.some((root) => Array.isArray(root.windows))) {
    const fallback = cmuxFlatTopologyIds(payload, workspaceId);
    if (fallback) return fallback;
  }
  return {
    windowId: null,
    workspaceId,
    tabId: null,
    paneId: null,
    surfaceId: null,
  };
}

function cmuxTopologyObservedWorkspace(payload, requestedWorkspaceId) {
  const workspaceId = nonEmpty(requestedWorkspaceId);
  if (!workspaceId) return false;
  const roots = [payload, payload?.result, payload?.data]
    .filter((value) => value && typeof value === "object");
  let hasWindows = false;
  for (const root of roots) {
    if (Array.isArray(root.windows)) {
      hasWindows = true;
      for (const window of root.windows) {
        for (const workspace of Array.isArray(window?.workspaces) ? window.workspaces : []) {
          if (firstId(workspace, [
            "id",
            "workspace_id",
            "workspaceId",
            "workspace_uuid",
            "workspaceUuid",
          ]) === workspaceId) {
            return true;
          }
        }
      }
    }
    if (
      firstId(root.active, ["workspace_id", "workspaceId", "workspace_uuid", "workspaceUuid"])
        === workspaceId
    ) {
      return true;
    }
  }
  if (hasWindows) return false;
  return Boolean(cmuxFlatTopologyIds(payload, workspaceId));
}

function herdrIdsFromPayload(payload) {
  return {
    workspaceId:
      lookupPath(payload, ["result", "workspace", "workspace_id"])
      || findKey(payload, ["workspace_id", "workspaceId"]),
    tabId:
      lookupPath(payload, ["result", "tab", "tab_id"])
      || findKey(payload, ["tab_id", "tabId"]),
    paneId:
      lookupPath(payload, ["result", "root_pane", "pane_id"])
      || lookupPath(payload, ["result", "pane", "pane_id"])
      || findKey(payload, ["pane_id", "paneId"]),
  };
}

function herdrWorkspaceIdentity(payload) {
  const workspace = payload?.result?.workspace;
  return {
    workspaceId: firstId(workspace, ["workspace_id", "workspaceId"]),
    label: firstId(workspace, ["label"]),
  };
}

function herdrPaneIdentity(payload) {
  const pane = payload?.result?.pane;
  return {
    workspaceId: firstId(pane, ["workspace_id", "workspaceId"]),
    paneId: firstId(pane, ["pane_id", "paneId"]),
  };
}

function isoNow(now) {
  const value = now();
  return new Date(value instanceof Date ? value.getTime() : value).toISOString();
}

class SessionHost {
  constructor(config, dependencies = {}) {
    this.kind = config.kind;
    this.executable = config.executable || null;
    this.source = config.source || "explicit";
    this.spawnSync = dependencies.spawnSync || spawnSync;
    this.connection = config.connection
      ? {
        environment: hostConnectionEnvironment(
          this.kind,
          config.connection.environment || {},
        ),
      }
      : captureHostConnection(this.kind, dependencies.env || process.env);
    this.processEnv = applyHostConnection(
      this.kind,
      dependencies.env || process.env,
      this.connection,
    );
    this.now = dependencies.now || (() => Date.now());
    this.timeoutMs = dependencies.timeoutMs || 10_000;
  }

  invoke(args, {
    allowFailure = false,
    recoverExecutionError = false,
    redactValues = [],
    sensitive = false,
  } = {}) {
    const diagnosticFor = (value) => {
      const raw = String(value || "");
      if (sensitive && raw.trim()) {
        return "[redacted sensitive host diagnostic]";
      }
      return this.connectionDiagnostic(raw, redactValues);
    };
    let result;
    try {
      result = this.spawnSync(this.executable, args, {
        encoding: "utf8",
        env: this.processEnv,
        timeout: this.timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
        shell: false,
      });
    } catch (error) {
      if (!recoverExecutionError) {
        throw new Error(
          `${this.kind} host CLI failed to start: ${diagnosticFor(error.message || error)}`,
        );
      }
      result = {
        status: null,
        stdout: error.stdout || "",
        stderr: error.stderr || "",
        error,
      };
    }
    if (result.error && !recoverExecutionError) {
      throw new Error(
        `${this.kind} host CLI failed to start: ${diagnosticFor(result.error.message || result.error)}`,
      );
    }
    const status = result.status === null ? 1 : result.status;
    if (status !== 0 && !allowFailure) {
      const diagnostic = diagnosticFor(
        String(result.stderr || result.stdout || "").trim(),
      );
      throw new Error(
        `${this.kind} host command failed${diagnostic ? `: ${diagnostic}` : ` with status ${status}`}`,
      );
    }
    return {
      status,
      stdout: String(result.stdout || ""),
      stderr: String(result.stderr || ""),
      error: result.error || null,
    };
  }

  connectionDiagnostic(value, redactValues = []) {
    let diagnostic = String(value || "");
    for (const endpoint of [
      ...Object.values(this.connection?.environment || {}),
      ...redactValues,
    ]) {
      if (endpoint) diagnostic = diagnostic.replaceAll(endpoint, "[redacted host connection]");
    }
    return diagnostic.slice(-2000);
  }

  descriptor(options, fields = {}) {
    const normalized = normalizeCreateOptions(options);
    return {
      kind: this.kind,
      target: null,
      managed: false,
      scope: this.kind === "process" ? "process" : "workspace",
      workspaceId: null,
      tabId: null,
      paneId: null,
      surfaceId: null,
      windowId: null,
      cwd: normalized.cwd,
      label: normalized.label,
      environmentKeys: normalized.environment.map(([key]) => key),
      ...(this.connection ? { connection: this.connection } : {}),
      executable: this.executable,
      createdAt: isoNow(this.now),
      launchedAt: null,
      closedAt: null,
      ...fields,
    };
  }
}

class ProcessSessionHost extends SessionHost {
  constructor(config = {}, dependencies = {}) {
    super({ ...config, kind: "process", executable: null }, dependencies);
  }

  async preflight() {
    return {
      ok: true,
      kind: this.kind,
      source: this.source,
      delegated: true,
    };
  }

  async create(options = {}) {
    return this.descriptor(options, {
      managed: false,
      target: null,
    });
  }

  async launch(descriptor, { command } = {}) {
    validateLaunchCommand(command);
    return {
      ok: true,
      delegated: true,
      descriptor: {
        ...descriptor,
        launchedAt: isoNow(this.now),
      },
    };
  }

  async inspect(descriptor) {
    return { ok: true, exists: null, delegated: true, descriptor };
  }

  async close(descriptor) {
    return {
      ok: true,
      closed: false,
      delegated: true,
      descriptor,
    };
  }
}

class CmuxSessionHost extends SessionHost {
  constructor(config, dependencies = {}) {
    super({ ...config, kind: "cmux" }, dependencies);
    if (!this.executable) throw new Error("cmux host requires an executable");
  }

  async preflight() {
    this.invoke(["ping"]);
    return {
      ok: true,
      kind: this.kind,
      source: this.source,
      executable: this.executable,
    };
  }

  topology(workspaceId, {
    allowFailure = false,
    expectedPaneId = null,
    expectedSurfaceId = null,
  } = {}) {
    const result = this.invoke([
      "--json",
      "--id-format", "uuids",
      "tree",
      "--workspace", workspaceId,
    ], { allowFailure });
    if (result.status !== 0) return { result, payload: null, ids: {} };
    const payload = parseJsonOutput(result.stdout, "cmux tree");
    return {
      result,
      payload,
      ids: cmuxTopologyIds(payload, workspaceId, {
        expectedPaneId,
        expectedSurfaceId,
      }),
      workspaceObserved: cmuxTopologyObservedWorkspace(payload, workspaceId),
    };
  }

  ownershipMismatch(reason) {
    throw new Error(
      `cmux managed host ownership mismatch (${reason}); `
      + "refusing to act on the managed workspace",
    );
  }

  isPartialCreateCleanupDescriptor(descriptor) {
    return Boolean(
      descriptor?.managed
      && nonEmpty(descriptor.workspaceId)
      && descriptor.status === "cleanup_pending"
      && descriptor.cleanup?.pending === true
      && !descriptor.launchedAt
      && (!nonEmpty(descriptor.paneId) || !nonEmpty(descriptor.surfaceId)),
    );
  }

  verifyManagedWorkspaceOwnership(descriptor) {
    const workspaceId = nonEmpty(descriptor?.workspaceId);
    const expectedPaneId = nonEmpty(descriptor?.paneId);
    const expectedSurfaceId = nonEmpty(descriptor?.surfaceId);
    if (!workspaceId) this.ownershipMismatch("saved workspace id is missing");
    if (!expectedPaneId) this.ownershipMismatch("saved pane id is missing");
    if (!expectedSurfaceId) this.ownershipMismatch("saved surface id is missing");

    const topology = this.topology(workspaceId, {
      allowFailure: true,
      expectedPaneId,
      expectedSurfaceId,
    });
    if (topology.result.status !== 0) {
      if (targetMissing(topology.result, workspaceId)) {
        return {
          exists: false,
          owned: false,
          topology,
        };
      }
      const diagnostic = this.connectionDiagnostic(
        String(topology.result.stderr || topology.result.stdout || "").trim(),
      );
      throw new Error(
        `cmux managed host ownership verification failed: `
        + `${diagnostic || `status ${topology.result.status}`}`,
      );
    }
    if (!topology.workspaceObserved || topology.ids.workspaceId !== workspaceId) {
      this.ownershipMismatch("live workspace id does not match the saved descriptor");
    }
    if (topology.ids.paneId !== expectedPaneId) {
      this.ownershipMismatch("saved pane no longer belongs to the managed workspace");
    }
    if (topology.ids.surfaceId !== expectedSurfaceId) {
      this.ownershipMismatch("saved surface no longer belongs to the managed pane");
    }
    return {
      exists: true,
      owned: true,
      topology,
    };
  }

  cleanupCreatedWorkspace(workspaceId) {
    try {
      const result = this.invoke([
        "--json",
        "--id-format", "uuids",
        "workspace", "close", workspaceId,
      ], { allowFailure: true });
      if (result.status === 0 || targetMissing(result, workspaceId)) {
        return {
          attempted: true,
          ok: true,
          alreadyMissing: result.status !== 0,
        };
      }
      const diagnostic = this.connectionDiagnostic(
        String(result.stderr || result.stdout || "").trim(),
      );
      return {
        attempted: true,
        ok: false,
        status: result.status,
        error: diagnostic || `status ${result.status}`,
      };
    } catch (error) {
      return {
        attempted: true,
        ok: false,
        status: null,
        error: this.connectionDiagnostic(error.message || error),
      };
    }
  }

  async create(options = {}) {
    const normalized = normalizeCreateOptions(options);
    const args = [
      "--json",
      "--id-format", "uuids",
      "workspace", "create",
      "--name", normalized.label,
      "--cwd", normalized.cwd,
      "--focus", "false",
    ];
    if (normalized.windowId) args.push("--window", normalized.windowId);
    const created = this.invoke(args, {
      allowFailure: true,
      recoverExecutionError: true,
    });
    let workspaceId = cmuxCreatedWorkspaceIdFromOutput(created.stdout);
    let ids = {
      windowId: null,
      workspaceId,
      tabId: null,
      paneId: null,
      surfaceId: null,
    };
    try {
      if (created.error) {
        throw new Error(
          `cmux host CLI failed to start: ${this.connectionDiagnostic(created.error.message || created.error)}`,
        );
      }
      if (created.status !== 0) {
        const diagnostic = this.connectionDiagnostic(
          String(created.stderr || created.stdout || "").trim(),
        );
        throw new Error(
          `cmux host command failed${diagnostic ? `: ${diagnostic}` : ` with status ${created.status}`}`,
        );
      }
      const payload = parseJsonOutput(created.stdout, "cmux workspace create");
      workspaceId = cmuxCreatedWorkspaceId(payload) || workspaceId;
      if (!workspaceId) {
        throw new Error("cmux workspace create did not return a workspace id");
      }
      const topology = this.topology(workspaceId);
      ids = {
        ...topology.ids,
        workspaceId,
      };
      if (!ids.surfaceId || !ids.paneId) {
        throw new Error("cmux workspace create could not recover root pane and surface ids");
      }
      return this.descriptor(options, {
        managed: true,
        target: ids.surfaceId,
        ...ids,
      });
    } catch (error) {
      if (workspaceId) {
        const cleanup = this.cleanupCreatedWorkspace(workspaceId);
        if (!cleanup.ok) {
          error.hostCleanup = { ...cleanup, pending: true };
          error.hostDescriptor = this.descriptor(options, {
            managed: true,
            target: ids.surfaceId || workspaceId,
            ...ids,
            workspaceId,
            status: "cleanup_pending",
            cleanup: error.hostCleanup,
          });
        }
      }
      throw error;
    }
  }

  async launch(descriptor, { command } = {}) {
    const launchCommand = validateLaunchCommand(command);
    const targetArgs = descriptor.surfaceId
      ? ["--surface", descriptor.surfaceId]
      : descriptor.workspaceId
        ? ["--workspace", descriptor.workspaceId]
        : [];
    if (!targetArgs.length) throw new Error("cmux host descriptor has no launch target");
    this.invoke(["send", ...targetArgs, "--", launchCommand], {
      sensitive: true,
    });
    this.invoke(["send-key", ...targetArgs, "enter"], {
      sensitive: true,
    });
    return {
      ok: true,
      delegated: false,
      descriptor: {
        ...descriptor,
        launchedAt: isoNow(this.now),
      },
    };
  }

  async inspect(descriptor) {
    if (!descriptor.workspaceId) {
      return {
        ok: false,
        exists: false,
        error: "cmux host descriptor has no workspace id",
        descriptor,
      };
    }
    if (descriptor.managed) {
      if (this.isPartialCreateCleanupDescriptor(descriptor)) {
        return {
          ok: false,
          exists: null,
          owned: false,
          reason: "partial_create_cleanup_only",
          error: "cmux partial-create cleanup descriptor cannot prove pane and surface ownership",
          ownership: {
            verified: false,
            partialCreateCleanupOnly: true,
          },
          descriptor,
        };
      }
      let ownership;
      try {
        ownership = this.verifyManagedWorkspaceOwnership(descriptor);
      } catch (error) {
        return {
          ok: false,
          exists: null,
          owned: false,
          error: this.connectionDiagnostic(error.message || error),
          ownership: {
            verified: false,
            workspace: false,
            paneRelationship: false,
            surfaceRelationship: false,
          },
          descriptor,
        };
      }
      if (!ownership.exists) {
        return {
          ok: false,
          exists: false,
          owned: false,
          error: "cmux managed workspace no longer exists",
          ownership: {
            verified: true,
            workspace: false,
            paneRelationship: false,
            surfaceRelationship: false,
          },
          descriptor,
        };
      }
      return {
        ok: true,
        exists: true,
        owned: true,
        ownership: {
          verified: true,
          workspace: true,
          paneRelationship: true,
          surfaceRelationship: true,
        },
        payload: ownership.topology.payload,
        descriptor,
      };
    }
    const topology = this.topology(descriptor.workspaceId, { allowFailure: true });
    if (topology.result.status !== 0) {
      return {
        ok: false,
        exists: false,
        error: this.connectionDiagnostic(
          String(topology.result.stderr || topology.result.stdout || "").trim(),
        ),
        descriptor,
      };
    }
    const ids = topology.ids;
    const updated = {
      ...descriptor,
      windowId: ids.windowId || descriptor.windowId,
      workspaceId: ids.workspaceId || descriptor.workspaceId,
      paneId: ids.paneId || descriptor.paneId,
      surfaceId: ids.surfaceId || descriptor.surfaceId,
    };
    updated.target = updated.surfaceId || updated.workspaceId;
    return {
      ok: true,
      exists: true,
      payload: topology.payload,
      descriptor: updated,
    };
  }

  async close(descriptor) {
    if (!descriptor.managed) {
      return { ok: true, closed: false, reason: "host_not_managed", descriptor };
    }
    if (!descriptor.workspaceId) throw new Error("cmux host descriptor has no workspace id");
    if (this.isPartialCreateCleanupDescriptor(descriptor)) {
      const cleanup = this.cleanupCreatedWorkspace(descriptor.workspaceId);
      if (!cleanup.ok) {
        const error = new Error(
          `cmux partial-create cleanup failed: ${cleanup.error || `status ${cleanup.status}`}`,
        );
        error.status = cleanup.status;
        throw error;
      }
      return {
        ok: true,
        closed: true,
        alreadyMissing: Boolean(cleanup.alreadyMissing),
        partialCreateCleanup: true,
        descriptor: {
          ...descriptor,
          closedAt: isoNow(this.now),
          cleanup: {
            ...descriptor.cleanup,
            pending: false,
            recoveredAt: isoNow(this.now),
          },
        },
      };
    }
    const ownership = this.verifyManagedWorkspaceOwnership(descriptor);
    if (!ownership.exists) {
      return {
        ok: true,
        closed: true,
        alreadyMissing: true,
        descriptor: {
          ...descriptor,
          closedAt: isoNow(this.now),
          ...(descriptor.cleanup
            ? {
              cleanup: {
                ...descriptor.cleanup,
                pending: false,
                recoveredAt: isoNow(this.now),
              },
            }
            : {}),
        },
      };
    }
    const result = this.invoke([
      "--json",
      "--id-format", "uuids",
      "workspace", "close", descriptor.workspaceId,
    ], { allowFailure: true });
    if (result.status !== 0 && !targetMissing(result, descriptor.workspaceId)) {
      const diagnostic = this.connectionDiagnostic(
        String(result.stderr || result.stdout || "").trim(),
      );
      throw new Error(`cmux host command failed: ${diagnostic || `status ${result.status}`}`);
    }
    return {
      ok: true,
      closed: true,
      alreadyMissing: result.status !== 0,
      descriptor: {
        ...descriptor,
        closedAt: isoNow(this.now),
        ...(descriptor.cleanup
          ? {
            cleanup: {
              ...descriptor.cleanup,
              pending: false,
              recoveredAt: isoNow(this.now),
            },
          }
          : {}),
      },
    };
  }
}

class HerdrSessionHost extends SessionHost {
  constructor(config, dependencies = {}) {
    super({ ...config, kind: "herdr" }, dependencies);
    if (!this.executable) throw new Error("Herdr host requires an executable");
  }

  async preflight() {
    this.invoke(["status", "server"]);
    return {
      ok: true,
      kind: this.kind,
      source: this.source,
      executable: this.executable,
    };
  }

  ownershipMismatch(reason) {
    throw new Error(
      `Herdr workspace ownership mismatch (${reason}); refusing to act on the managed workspace`,
    );
  }

  verifyManagedWorkspaceOwnership(descriptor, {
    requirePane = true,
  } = {}) {
    const workspaceId = nonEmpty(descriptor?.workspaceId);
    const expectedLabel = nonEmpty(descriptor?.label);
    const expectedPaneId = nonEmpty(descriptor?.paneId);
    if (!workspaceId) {
      this.ownershipMismatch("saved workspace id is missing");
    }
    if (!expectedLabel) {
      this.ownershipMismatch("saved workspace label is missing");
    }
    if (requirePane && !expectedPaneId) {
      this.ownershipMismatch("saved pane id is missing");
    }

    const workspaceResult = this.invoke(
      ["workspace", "get", workspaceId],
      { allowFailure: true },
    );
    if (workspaceResult.status !== 0) {
      if (targetMissing(workspaceResult, workspaceId)) {
        return {
          exists: false,
          owned: false,
          workspacePayload: null,
          panePayload: null,
        };
      }
      const diagnostic = this.connectionDiagnostic(
        String(workspaceResult.stderr || workspaceResult.stdout || "").trim(),
      );
      throw new Error(
        `Herdr workspace ownership verification failed: ${diagnostic || `status ${workspaceResult.status}`}`,
      );
    }

    const workspacePayload = parseJsonOutput(
      workspaceResult.stdout,
      "Herdr workspace get",
    );
    const workspace = herdrWorkspaceIdentity(workspacePayload);
    if (workspace.workspaceId !== workspaceId) {
      this.ownershipMismatch("live workspace id does not match the saved descriptor");
    }
    if (workspace.label !== expectedLabel) {
      this.ownershipMismatch("live workspace label does not match the saved descriptor");
    }

    if (!requirePane) {
      return {
        exists: true,
        owned: true,
        workspacePayload,
        panePayload: null,
      };
    }

    const paneResult = this.invoke(
      ["pane", "get", expectedPaneId],
      { allowFailure: true },
    );
    if (paneResult.status !== 0) {
      if (targetMissing(paneResult, expectedPaneId)) {
        this.ownershipMismatch("saved pane no longer belongs to the managed workspace");
      }
      const diagnostic = this.connectionDiagnostic(
        String(paneResult.stderr || paneResult.stdout || "").trim(),
      );
      throw new Error(
        `Herdr pane ownership verification failed: ${diagnostic || `status ${paneResult.status}`}`,
      );
    }
    const panePayload = parseJsonOutput(paneResult.stdout, "Herdr pane get");
    const pane = herdrPaneIdentity(panePayload);
    if (pane.paneId !== expectedPaneId || pane.workspaceId !== workspaceId) {
      this.ownershipMismatch("live pane/workspace relationship does not match the saved descriptor");
    }
    return {
      exists: true,
      owned: true,
      workspacePayload,
      panePayload,
    };
  }

  cleanupCreatedWorkspace(descriptor) {
    try {
      const ownership = this.verifyManagedWorkspaceOwnership(descriptor, {
        requirePane: Boolean(descriptor?.paneId),
      });
      if (!ownership.exists) {
        return {
          attempted: true,
          ok: true,
          alreadyMissing: true,
        };
      }
      const result = this.invoke(
        ["workspace", "close", descriptor.workspaceId],
        { allowFailure: true },
      );
      if (result.status === 0 || targetMissing(result, descriptor.workspaceId)) {
        return {
          attempted: true,
          ok: true,
          alreadyMissing: result.status !== 0,
        };
      }
      const diagnostic = this.connectionDiagnostic(
        String(result.stderr || result.stdout || "").trim(),
      );
      return {
        attempted: true,
        ok: false,
        status: result.status,
        error: diagnostic || `status ${result.status}`,
      };
    } catch (error) {
      return {
        attempted: true,
        ok: false,
        status: null,
        error: this.connectionDiagnostic(error.message || error),
      };
    }
  }

  async create(options = {}) {
    const normalized = normalizeCreateOptions(options);
    const args = [
      "workspace", "create",
      "--cwd", normalized.cwd,
      "--label", normalized.label,
      "--no-focus",
    ];
    for (const [key, value] of normalized.environment) {
      args.push("--env", `${key}=${value}`);
    }
    const environmentValues = normalized.environment.map(([, value]) => value);
    const created = this.invoke(args, {
      allowFailure: true,
      recoverExecutionError: true,
      redactValues: environmentValues,
    });
    let workspaceId = workspaceIdFromOutput(created.stdout);
    let ids = {
      workspaceId,
      tabId: null,
      paneId: null,
    };
    try {
      if (created.error) {
        throw new Error(
          `herdr host CLI failed to start: ${this.connectionDiagnostic(
            created.error.message || created.error,
            environmentValues,
          )}`,
        );
      }
      if (created.status !== 0) {
        const diagnostic = this.connectionDiagnostic(
          String(created.stderr || created.stdout || "").trim(),
          environmentValues,
        );
        throw new Error(
          `herdr host command failed${diagnostic ? `: ${diagnostic}` : ` with status ${created.status}`}`,
        );
      }
      const payload = parseJsonOutput(created.stdout, "Herdr workspace create");
      ids = herdrIdsFromPayload(payload);
      workspaceId = ids.workspaceId || workspaceId;
      if (!ids.workspaceId || !ids.paneId) {
        throw new Error("Herdr workspace create did not return workspace and root pane ids");
      }
      return this.descriptor(options, {
        managed: true,
        target: ids.paneId,
        ...ids,
      });
    } catch (error) {
      if (workspaceId) {
        const cleanup = this.cleanupCreatedWorkspace({
          workspaceId,
          paneId: ids.paneId,
          label: normalized.label,
        });
        if (!cleanup.ok) {
          error.hostCleanup = { ...cleanup, pending: true };
          error.hostDescriptor = this.descriptor(options, {
            managed: true,
            target: ids.paneId || workspaceId,
            ...ids,
            workspaceId,
            status: "cleanup_pending",
            cleanup: error.hostCleanup,
          });
        }
      }
      throw error;
    }
  }

  async launch(descriptor, { command } = {}) {
    const launchCommand = validateLaunchCommand(command);
    if (!descriptor.paneId) throw new Error("Herdr host descriptor has no pane id");
    this.invoke(["pane", "run", descriptor.paneId, launchCommand], {
      sensitive: true,
    });
    return {
      ok: true,
      delegated: false,
      descriptor: {
        ...descriptor,
        launchedAt: isoNow(this.now),
      },
    };
  }

  async inspect(descriptor) {
    if (descriptor.managed) {
      const ownership = this.verifyManagedWorkspaceOwnership(descriptor);
      if (!ownership.exists) {
        return {
          ok: false,
          exists: false,
          owned: false,
          error: "Herdr managed workspace no longer exists",
          descriptor,
        };
      }
      return {
        ok: true,
        exists: true,
        owned: true,
        ownership: {
          verified: true,
          label: true,
          paneRelationship: true,
        },
        payload: {
          workspace: ownership.workspacePayload,
          pane: ownership.panePayload,
        },
        descriptor,
      };
    }
    if (!descriptor.paneId) {
      return {
        ok: false,
        exists: false,
        error: "Herdr host descriptor has no pane id",
        descriptor,
      };
    }
    const result = this.invoke(["pane", "get", descriptor.paneId], { allowFailure: true });
    if (result.status !== 0) {
      return {
        ok: false,
        exists: false,
        error: this.connectionDiagnostic(
          String(result.stderr || result.stdout || "").trim(),
        ),
        descriptor,
      };
    }
    const payload = parseJsonOutput(result.stdout, "Herdr pane get");
    const ids = herdrIdsFromPayload(payload);
    const updated = {
      ...descriptor,
      workspaceId: ids.workspaceId || descriptor.workspaceId,
      tabId: ids.tabId || descriptor.tabId,
      paneId: ids.paneId || descriptor.paneId,
    };
    updated.target = updated.paneId;
    return {
      ok: true,
      exists: true,
      owned: null,
      payload,
      descriptor: updated,
    };
  }

  async close(descriptor) {
    if (!descriptor.managed) {
      return { ok: true, closed: false, reason: "host_not_managed", descriptor };
    }
    if (!descriptor.workspaceId) throw new Error("Herdr host descriptor has no workspace id");
    const ownership = this.verifyManagedWorkspaceOwnership(descriptor);
    if (!ownership.exists) {
      return {
        ok: true,
        closed: true,
        alreadyMissing: true,
        descriptor: {
          ...descriptor,
          closedAt: isoNow(this.now),
          ...(descriptor.cleanup
            ? {
              cleanup: {
                ...descriptor.cleanup,
                pending: false,
                recoveredAt: isoNow(this.now),
              },
            }
            : {}),
        },
      };
    }
    const result = this.invoke(
      ["workspace", "close", descriptor.workspaceId],
      { allowFailure: true },
    );
    if (result.status !== 0 && !targetMissing(result, descriptor.workspaceId)) {
      const diagnostic = this.connectionDiagnostic(
        String(result.stderr || result.stdout || "").trim(),
      );
      throw new Error(`Herdr host command failed: ${diagnostic || `status ${result.status}`}`);
    }
    return {
      ok: true,
      closed: true,
      alreadyMissing: result.status !== 0,
      descriptor: {
        ...descriptor,
        closedAt: isoNow(this.now),
        ...(descriptor.cleanup
          ? {
            cleanup: {
              ...descriptor.cleanup,
              pending: false,
              recoveredAt: isoNow(this.now),
            },
          }
          : {}),
      },
    };
  }
}

function createSessionHost(config, dependencies = {}) {
  if (!config || !config.kind) throw new Error("A resolved session host config is required");
  if (config.kind === "process") return new ProcessSessionHost(config, dependencies);
  if (config.kind === "cmux") return new CmuxSessionHost(config, dependencies);
  if (config.kind === "herdr") return new HerdrSessionHost(config, dependencies);
  throw new Error(`Cannot create session host: ${config.kind}`);
}

module.exports = {
  CMUX_APP_CLI_PATHS,
  HOST_CONNECTION_ENV_KEYS,
  HOST_DYNAMIC_CONTEXT_ENV_KEYS,
  HOST_KINDS,
  CmuxSessionHost,
  HerdrSessionHost,
  ProcessSessionHost,
  applyHostConnection,
  captureHostConnection,
  createSessionHost,
  cmuxTopologyIds,
  cmuxCreatedWorkspaceId,
  cmuxCreatedWorkspaceIdFromOutput,
  findExecutable,
  herdrIdsFromPayload,
  hostConnectionEnvironment,
  idsFromPayload,
  normalizeCreateOptions,
  normalizeEnvironment,
  parseJsonOutput,
  resolveCmuxExecutable,
  resolveHerdrExecutable,
  resolveHostCandidates,
  resolveHostConfig,
  targetMissing,
  validateLaunchCommand,
};
