const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const {
  resolveCmuxExecutable,
  resolveHerdrExecutable,
} = require("./slack-api-session-host.cjs");

const PROVIDER_NAMES = ["auto", "tmux", "cmux", "herdr", "stdio"];
const PROVIDER_IDENTITY_VERSION = 1;
const TMUX_IDENTITY_SEPARATOR = "\u001f";
const TMUX_IDENTITY_FORMAT = [
  "#{pane_id}",
  "#{start_time}",
  "#{pid}",
  "#{session_id}",
  "#{session_created}",
  "#{pane_pid}",
  "#{socket_path}",
].join(TMUX_IDENTITY_SEPARATOR);
const PROVIDER_CONNECTION_ENV_KEYS = Object.freeze({
  tmux: Object.freeze(["TMUX", "TMUX_TMPDIR"]),
  cmux: Object.freeze(["CMUX_SOCKET_PATH", "CMUX_SOCKET_MODE"]),
  herdr: Object.freeze([
    "HERDR_SOCKET_PATH",
    "HERDR_SESSION",
    "HERDR_CONTEXT",
    "HERDR_CONTEXT_NAME",
  ]),
  stdio: Object.freeze([]),
});
const PROVIDER_DYNAMIC_CONTEXT_ENV_KEYS = Object.freeze({
  tmux: Object.freeze(["TMUX_PANE"]),
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
  stdio: Object.freeze([]),
});

function providerConnectionEnvironment(name, env = {}) {
  const keys = PROVIDER_CONNECTION_ENV_KEYS[name] || [];
  const selected = {};
  for (const key of keys) {
    if (!Object.hasOwn(env, key) || env[key] === undefined || env[key] === null) continue;
    const value = String(env[key]);
    if (!value) continue;
    if (/[\0\r\n]/.test(value)) {
      throw new Error(`Provider connection environment ${key} contains a control character`);
    }
    selected[key] = value;
  }
  return selected;
}

function captureProviderConnection(name, env = process.env) {
  if (!(name in PROVIDER_CONNECTION_ENV_KEYS) || name === "stdio") return null;
  const environment = providerConnectionEnvironment(name, env);
  return { environment };
}

function applyProviderConnection(config, env = {}) {
  const applied = { ...(env || {}) };
  if (!Object.hasOwn(config || {}, "connection")) return applied;
  for (const key of [
    ...(PROVIDER_CONNECTION_ENV_KEYS[config.name] || []),
    ...(PROVIDER_DYNAMIC_CONTEXT_ENV_KEYS[config.name] || []),
  ]) {
    delete applied[key];
  }
  Object.assign(
    applied,
    providerConnectionEnvironment(
      config.name,
      config.connection?.environment || {},
    ),
  );
  return applied;
}

function providerDiagnosticValues(name, env = {}) {
  const values = Object.values(providerConnectionEnvironment(name, env));
  if (name === "tmux" && env.TMUX) {
    const socketPath = String(env.TMUX).split(",", 1)[0];
    if (socketPath) values.push(socketPath);
  }
  return [...new Set(values.filter(Boolean))]
    .sort((left, right) => right.length - left.length);
}

function sanitizeProviderDiagnostic(value, redactValues = []) {
  let diagnostic = String(value || "");
  for (const endpoint of redactValues) {
    if (endpoint) {
      diagnostic = diagnostic.replaceAll(
        endpoint,
        "[redacted provider connection]",
      );
    }
  }
  return diagnostic.slice(-2000);
}

function findExecutable(command, env = process.env) {
  if (command.includes(path.sep)) {
    return fs.existsSync(command) ? path.resolve(command) : null;
  }
  for (const directory of String(env.PATH || "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

function run(command, args, options = {}) {
  const diagnosticFor = (value) => {
    const raw = String(value || "");
    if (options.sensitive && raw.trim()) {
      const safeCode = raw.match(
        /\b(agent_not_found|pane_not_found|surface_not_found|workspace_not_found|permission_denied)\b/i,
      );
      if (safeCode) return safeCode[1].toLowerCase();
      return "[redacted sensitive provider diagnostic]";
    }
    return sanitizeProviderDiagnostic(raw, options.redactValues);
  };
  let result;
  try {
    result = (options.spawnSync || spawnSync)(command, args, {
      encoding: "utf8",
      input: options.input,
      env: options.env || process.env,
      timeout: options.timeoutMs || 10_000,
      maxBuffer: 2 * 1024 * 1024,
      shell: false,
    });
  } catch (error) {
    const diagnostic = diagnosticFor(error.message || error);
    throw new Error(`${command} failed to start: ${diagnostic}`);
  }
  if (result.error) {
    const diagnostic = diagnosticFor(result.error.message || result.error);
    throw new Error(`${command} failed to start: ${diagnostic}`);
  }
  if (result.status !== 0) {
    const diagnostic = diagnosticFor(
      String(result.stderr || result.stdout || "").trim(),
    );
    throw new Error(`${command} ${args[0] || ""} failed${diagnostic ? `: ${diagnostic}` : ` with status ${result.status}`}`);
  }
  return String(result.stdout || "");
}

function providerCommand(provider, args, options = {}) {
  return run(provider.executable, args, {
    ...options,
    env: provider.env,
    spawnSync: provider.spawnSync,
    redactValues: [
      ...(provider.diagnosticValues || []),
      ...(options.redactValues || []),
    ],
  });
}

function parseProviderJson(output, context) {
  const text = String(output || "").trim();
  if (!text) throw new Error(`${context} returned no JSON output`);
  const candidates = [text, ...text.split("\n").reverse()];
  for (const candidate of [...new Set(candidates)]) {
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  throw new Error(`${context} returned invalid JSON`);
}

function nonEmptyString(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function fingerprint(parts) {
  return crypto
    .createHash("sha256")
    .update(parts.map((part) => String(part)).join("\0"), "utf8")
    .digest("hex");
}

function normalizeTmuxIdentity(identity) {
  if (!identity || typeof identity !== "object") return null;
  const normalized = {
    version: Number(identity.version),
    provider: String(identity.provider || ""),
    paneId: nonEmptyString(identity.paneId),
    serverInstance: nonEmptyString(identity.serverInstance),
    sessionInstance: nonEmptyString(identity.sessionInstance),
    paneInstance: nonEmptyString(identity.paneInstance),
  };
  if (
    normalized.version !== PROVIDER_IDENTITY_VERSION
    || normalized.provider !== "tmux"
    || !normalized.paneId
    || !/^[a-f0-9]{64}$/.test(normalized.serverInstance || "")
    || !/^[a-f0-9]{64}$/.test(normalized.sessionInstance || "")
    || !/^[a-f0-9]{64}$/.test(normalized.paneInstance || "")
  ) {
    return null;
  }
  return normalized;
}

function tmuxIdentityFromOutput(output) {
  const fields = String(output || "")
    .replace(/\r?\n$/, "")
    .split(TMUX_IDENTITY_SEPARATOR);
  if (fields.length !== 7 || fields.some((field) => !field)) {
    throw new Error(
      "tmux did not return the target identity fields required for safe Slack injection",
    );
  }
  const [
    paneId,
    serverStartTime,
    serverPid,
    sessionId,
    sessionCreated,
    panePid,
    socketPath,
  ] = fields;
  return {
    version: PROVIDER_IDENTITY_VERSION,
    provider: "tmux",
    paneId,
    serverInstance: fingerprint([socketPath, serverStartTime, serverPid]),
    sessionInstance: fingerprint([
      socketPath,
      serverStartTime,
      serverPid,
      sessionId,
      sessionCreated,
    ]),
    paneInstance: fingerprint([
      socketPath,
      serverStartTime,
      serverPid,
      sessionId,
      sessionCreated,
      paneId,
      panePid,
    ]),
  };
}

function normalizeAgentSession(value) {
  if (!value || typeof value !== "object") return null;
  const normalized = {
    source: nonEmptyString(value.source),
    agent: nonEmptyString(value.agent),
    kind: nonEmptyString(value.kind),
    value: nonEmptyString(value.value),
  };
  return normalized.value ? normalized : null;
}

// Herdr identifies a Pi agent by the session file path it launched (kind "path",
// basename `<timestamp>_<sessionId>.jsonl`). Accept the expected id when it is the
// exact value or that path-token suffix.
function herdrAgentSessionMatches(live, expectedId) {
  if (!live || !expectedId) return false;
  if (live.value === expectedId) return true;
  if (live.kind !== "path") return false;
  return path.basename(live.value).endsWith(`_${expectedId}.jsonl`);
}

function normalizeHerdrIdentity(identity) {
  if (!identity || typeof identity !== "object") return null;
  const normalized = {
    version: Number(identity.version),
    provider: String(identity.provider || ""),
    workspaceId: nonEmptyString(identity.workspaceId),
    tabId: nonEmptyString(identity.tabId),
    paneId: nonEmptyString(identity.paneId),
    terminalId: nonEmptyString(identity.terminalId),
    agentSession: normalizeAgentSession(identity.agentSession),
  };
  if (
    normalized.version !== PROVIDER_IDENTITY_VERSION
    || normalized.provider !== "herdr"
    || !normalized.workspaceId
    || !normalized.tabId
    || !normalized.paneId
    || !normalized.terminalId
  ) {
    return null;
  }
  return normalized;
}

function herdrIdentityFromOutput(output) {
  const payload = parseProviderJson(output, "Herdr pane get");
  const pane = payload?.result?.pane;
  const identity = normalizeHerdrIdentity({
    version: PROVIDER_IDENTITY_VERSION,
    provider: "herdr",
    workspaceId: pane?.workspace_id,
    tabId: pane?.tab_id,
    paneId: pane?.pane_id,
    terminalId: pane?.terminal_id,
    agentSession: pane?.agent_session,
  });
  if (!identity) {
    throw new Error(
      "Herdr did not return workspace, tab, pane, and terminal identity required for safe Slack injection",
    );
  }
  return identity;
}

function identitiesMatch(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function acceptProviderIdentity(provider, liveIdentity, normalizeIdentity) {
  const expected = normalizeIdentity(provider.identity);
  if (!provider.identity) {
    if (provider.identityMode === "require") {
      throw new Error(
        `${provider.name} target identity is missing; stop this legacy session and start a new Slack agent session to bind a fresh target fingerprint`,
      );
    }
    provider.identity = liveIdentity;
    return liveIdentity;
  }
  if (!expected) {
    throw new Error(
      `${provider.name} target identity is invalid; stop this session and start a new Slack agent session to bind a fresh target fingerprint`,
    );
  }
  if (!identitiesMatch(expected, liveIdentity)) {
    throw new Error(
      `${provider.name} target ownership changed; refusing Slack injection. Stop this session and start a new Slack agent session from the intended target`,
    );
  }
  provider.identity = expected;
  return expected;
}

function escapeCmuxSendText(text) {
  const escapes = {
    "\\\"": "\\u0022",
    "\\\\": "\\u005c",
    "\\b": "\\u0008",
    "\\f": "\\u000c",
    "\\n": "\\u000a",
    "\\r": "\\u000d",
    "\\t": "\\u0009",
  };
  return String(text).replace(/\\(?:["\\bfnrt])/g, (match) => escapes[match]);
}

function inspectProviders(env = process.env) {
  const executables = {
    tmux: findExecutable("tmux", env),
    cmux: resolveCmuxExecutable({ env }),
    herdr: resolveHerdrExecutable({ env }),
  };
  const installed = {
    tmux: Boolean(executables.tmux),
    cmux: Boolean(executables.cmux),
    herdr: Boolean(executables.herdr),
  };
  const contexts = {
    cmux: Boolean(env.CMUX_SURFACE_ID && env.CMUX_WORKSPACE_ID),
    herdr: Boolean(env.HERDR_PANE_ID && (env.HERDR_ENV === "1" || env.HERDR_SOCKET_PATH)),
    tmux: Boolean(env.TMUX && env.TMUX_PANE),
  };
  let detected = null;
  if (installed.cmux && contexts.cmux) detected = "cmux";
  else if (installed.herdr && contexts.herdr) detected = "herdr";
  else if (installed.tmux && contexts.tmux) detected = "tmux";
  const cmuxSocketMode = String(env.CMUX_SOCKET_MODE || "")
    .toLowerCase()
    .replaceAll(/[-_]/g, "");
  const detachedCmuxReady = detected !== "cmux" || cmuxSocketMode === "allowall";
  return {
    detected,
    installed,
    executables,
    contexts,
    targets: {
      cmux: env.CMUX_SURFACE_ID || null,
      herdr: env.HERDR_PANE_ID || null,
      tmux: env.TMUX_PANE || null,
    },
    detachedListener: {
      ready: detachedCmuxReady,
      issue: detachedCmuxReady
        ? null
        : "Listeners hosted outside cmux cannot reconnect with the current socket mode.",
      remediation: detachedCmuxReady
        ? null
        : "Set CMUX_SOCKET_MODE=allowAll before `slack-api session start`, use --host cmux, or use --foreground from a separate cmux surface.",
    },
  };
}

class TmuxProvider {
  constructor({
    target,
    executable,
    env = process.env,
    spawnSync: spawnImpl,
    identity = null,
    identityMode = "establish",
  } = {}) {
    this.name = "tmux";
    this.target = target || env.TMUX_PANE || "";
    this.executable = executable || findExecutable("tmux", env) || "tmux";
    this.env = env;
    this.spawnSync = spawnImpl;
    this.diagnosticValues = providerDiagnosticValues(this.name, env);
    this.identity = identity;
    this.identityMode = identityMode;
    if (!this.target) throw new Error("tmux provider requires --target or TMUX_PANE");
  }

  verify() {
    if (!["establish", "require"].includes(this.identityMode)) {
      throw new Error(`Unknown tmux identity mode: ${this.identityMode}`);
    }
    const output = providerCommand(
      this,
      ["display-message", "-p", "-t", this.target, TMUX_IDENTITY_FORMAT],
    );
    const liveIdentity = tmuxIdentityFromOutput(output);
    const identity = acceptProviderIdentity(
      this,
      liveIdentity,
      normalizeTmuxIdentity,
    );
    this.target = identity.paneId;
    return { ok: true, name: this.name, target: this.target, identity };
  }

  inject(text) {
    this.verify();
    const buffer = `slack-agent-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    providerCommand(this, ["load-buffer", "-b", buffer, "-"], {
      input: text,
      sensitive: true,
    });
    try {
      providerCommand(this, ["paste-buffer", "-b", buffer, "-t", this.target], {
        sensitive: true,
      });
      providerCommand(this, ["send-keys", "-t", this.target, "Enter"], {
        sensitive: true,
      });
    } finally {
      try {
        providerCommand(this, ["delete-buffer", "-b", buffer], {
          sensitive: true,
        });
      } catch {}
    }
    return { ok: true, provider: this.name, target: this.target };
  }

  snapshot() {
    return providerCommand(
      this,
      ["capture-pane", "-p", "-J", "-t", this.target, "-S", "-200"],
    );
  }
}

class CmuxProvider {
  constructor({ target, executable, env = process.env, spawnSync: spawnImpl } = {}) {
    this.name = "cmux";
    this.target = target || env.CMUX_SURFACE_ID || "";
    this.executable = executable || resolveCmuxExecutable({ env }) || "cmux";
    this.env = env;
    this.spawnSync = spawnImpl;
    this.diagnosticValues = providerDiagnosticValues(this.name, env);
    if (!this.target) throw new Error("cmux provider requires --target or CMUX_SURFACE_ID");
  }

  verify() {
    providerCommand(this, ["ping"]);
    providerCommand(this, ["read-screen", "--surface", this.target, "--lines", "1"]);
    return { ok: true, name: this.name, target: this.target };
  }

  inject(text) {
    this.verify();
    providerCommand(
      this,
      ["send", "--surface", this.target, escapeCmuxSendText(text)],
      { sensitive: true },
    );
    providerCommand(
      this,
      ["send-key", "--surface", this.target, "enter"],
      { sensitive: true },
    );
    return { ok: true, provider: this.name, target: this.target };
  }
}

class HerdrProvider {
  constructor({
    target,
    executable,
    env = process.env,
    spawnSync: spawnImpl,
    identity = null,
    identityMode = "establish",
    expectedAgentSessionId = "",
  } = {}) {
    this.name = "herdr";
    this.target = target || env.HERDR_PANE_ID || "";
    this.executable = executable || resolveHerdrExecutable({ env }) || "herdr";
    this.env = env;
    this.spawnSync = spawnImpl;
    this.diagnosticValues = providerDiagnosticValues(this.name, env);
    this.identity = identity;
    this.identityMode = identityMode;
    this.expectedAgentSessionId = nonEmptyString(expectedAgentSessionId);
    if (!this.target) throw new Error("Herdr provider requires --target or HERDR_PANE_ID");
  }

  verify() {
    if (!["establish", "require"].includes(this.identityMode)) {
      throw new Error(`Unknown Herdr identity mode: ${this.identityMode}`);
    }
    const liveIdentity = herdrIdentityFromOutput(
      providerCommand(this, ["pane", "get", this.target]),
    );
    if (this.expectedAgentSessionId && !liveIdentity.agentSession) {
      throw new Error(
        "Herdr target does not report the expected agent session; refusing Slack injection. Restart the Slack agent session from the intended agent",
      );
    }
    if (
      this.expectedAgentSessionId
      && !herdrAgentSessionMatches(
        liveIdentity.agentSession,
        this.expectedAgentSessionId,
      )
    ) {
      throw new Error(
        "Herdr target reports a different agent session; refusing Slack injection. Restart the Slack agent session from the intended agent",
      );
    }
    const identity = acceptProviderIdentity(
      this,
      liveIdentity,
      normalizeHerdrIdentity,
    );
    this.target = identity.paneId;
    return { ok: true, name: this.name, target: this.target, identity };
  }

  inject(text) {
    this.verify();
    providerCommand(this, ["agent", "prompt", this.target, text], {
      sensitive: true,
    });
    return { ok: true, provider: this.name, target: this.target };
  }

  snapshot() {
    return providerCommand(this, [
      "pane", "read", this.target,
      "--source", "recent-unwrapped",
      "--lines", "200",
    ]);
  }
}

class StdioProvider {
  constructor({ target = "stdout", writer = console.log } = {}) {
    this.name = "stdio";
    this.target = target;
    this.writer = writer;
    this.injections = [];
  }

  verify() {
    return { ok: true, name: this.name, target: this.target, simulated: true };
  }

  inject(text) {
    this.injections.push(text);
    this.writer(JSON.stringify({
      type: "agent_session_injection",
      provider: this.name,
      target: this.target,
      text,
    }));
    return { ok: true, provider: this.name, target: this.target, simulated: true };
  }
}

function resolveProviderConfig({ name = "auto", target = "", env = process.env } = {}) {
  if (!PROVIDER_NAMES.includes(name)) {
    throw new Error(`Unknown provider ${name}. Expected one of: ${PROVIDER_NAMES.join(", ")}`);
  }
  const inspection = inspectProviders(env);
  const resolvedName = name === "auto" ? inspection.detected : name;
  if (!resolvedName) {
    throw new Error("No supported terminal provider detected. Start inside tmux, cmux, or Herdr, or pass --provider and --target.");
  }
  const resolvedTarget = target || inspection.targets[resolvedName] || (resolvedName === "stdio" ? "stdout" : "");
  if (!resolvedTarget && resolvedName !== "stdio") {
    throw new Error(`${resolvedName} was selected but no target was detected; pass --target`);
  }
  const connection = captureProviderConnection(resolvedName, env);
  return {
    name: resolvedName,
    target: resolvedTarget,
    executable: inspection.executables[resolvedName] || null,
    ...(connection ? { connection } : {}),
    inspection,
  };
}

function createProvider(config, dependencies = {}) {
  const options = {
    ...config,
    ...dependencies,
    env: applyProviderConnection(config, dependencies.env || process.env),
  };
  if (config.name === "tmux") return new TmuxProvider(options);
  if (config.name === "cmux") return new CmuxProvider(options);
  if (config.name === "herdr") return new HerdrProvider(options);
  if (config.name === "stdio") return new StdioProvider(options);
  throw new Error(`Cannot create provider: ${config.name}`);
}

module.exports = {
  CmuxProvider,
  HerdrProvider,
  PROVIDER_CONNECTION_ENV_KEYS,
  PROVIDER_DYNAMIC_CONTEXT_ENV_KEYS,
  PROVIDER_NAMES,
  StdioProvider,
  TmuxProvider,
  applyProviderConnection,
  captureProviderConnection,
  createProvider,
  escapeCmuxSendText,
  findExecutable,
  inspectProviders,
  providerConnectionEnvironment,
  providerDiagnosticValues,
  herdrIdentityFromOutput,
  normalizeHerdrIdentity,
  normalizeTmuxIdentity,
  resolveProviderConfig,
  run,
  sanitizeProviderDiagnostic,
  tmuxIdentityFromOutput,
};
