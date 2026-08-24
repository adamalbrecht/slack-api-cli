#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const {
  DEFAULT_SESSION_DIR,
  parseCommonArgs,
  parsePositiveInt,
} = require("./slack-api-common.cjs");
const {
  applyProviderConnection,
  createProvider,
  inspectProviders,
  providerConnectionEnvironment,
  resolveProviderConfig,
} = require("./slack-api-session-provider.cjs");
const {
  createSessionHost,
  resolveHostCandidates,
  resolveHostConfig,
} = require("./slack-api-session-host.cjs");
const {
  SimulatedSlackThreadClient,
  SlackThreadClient,
  targetFromArgs,
} = require("./slack-api-session-slack.cjs");
const { SessionDefaultsStore } = require("./slack-api-session-defaults.cjs");
const {
  SessionStore,
  newSessionId,
  processIsAlive,
} = require("./slack-api-session-store.cjs");
const {
  DEFAULT_POLL_TIMEOUT_MS,
  SessionRuntime,
  postBridgeResponse,
} = require("./slack-api-session-runtime.cjs");

const PROCESS_LAUNCH_SCHEDULING_OVERHEAD_MS = 2_500;
const STANDALONE_LAUNCH_SCHEDULING_OVERHEAD_MS = 10_000;
const PROVIDER_VERIFICATION_BUDGET_MS = Object.freeze({
  cmux: 20_000,
  herdr: 10_000,
  stdio: 0,
  tmux: 10_000,
});

function printRespondHelp() {
  console.log(`
Usage:
  slack-api session respond --id SESSION_ID --event EVENT_ID --message TEXT [--send]
  slack-api session respond --id SESSION_ID --event EVENT_ID --message-file FILE [--send]
  slack-api session respond --id SESSION_ID --event EVENT_ID --stdin [--send]
  slack-api session respond --id SESSION_ID --event EVENT_ID --status progress [--send]

Options:
  --id SESSION_ID       Bound agent session (required)
  --message TEXT        Read response text from one literal argument
  --message-file FILE   Read response text from a caller-owned file
  --stdin               Read response text from standard input
  --event EVENT_ID      Correlate the response to one injected Slack event (required)
  --status STATUS       progress, complete (default), or error
  --send                Post only when the session response policy is enabled;
                        otherwise remain a dry run

Message format:
  Responses are posted with Slack mrkdwn enabled. Use *bold*, <url|label>,
  _italic_, ~strike~, and backticks for code. GitHub-style **bold** is not
  translated and may render literally.

Safety:
  For complete/error, supply exactly one of --message, --message-file, or --stdin.
  Progress changes reaction state only and accepts no response text. Prefer a
  uniquely named private --message-file for generated or Slack-derived text, or
  --stdin when trusted text is already available on standard input. Never
  interpolate generated or Slack-derived text into shell arguments.

  The CLI reads caller-owned files without changing or deleting them. Remove a
  temporary message file yourself only after a successful send.
`);
}

function printDefaultsHelp() {
  console.log(`
Usage:
  slack-api session defaults [show] [--state-dir DIR]
  slack-api session defaults set [options] [--state-dir DIR]
  slack-api session defaults reset [--state-dir DIR]

Actions:
  show                 Show saved and effective values. Default action
  set                  Persist only the values explicitly supplied
  reset                Remove all saved session defaults

Set options:
  --channel ID_OR_NAME|me
  --send-responses | --no-send-responses
  --provider auto|tmux|cmux|herdr|stdio
  --poll-seconds N
  --headless | --headed
  --host auto|herdr|cmux|process

Precedence:
  Explicit command-line option, environment override, saved session default,
  then built-in safe fallback.
`);
}

function printHelp(action = "") {
  if (action === "respond") {
    printRespondHelp();
    return;
  }
  if (action === "defaults") {
    printDefaultsHelp();
    return;
  }
  console.log(`
Usage:
  slack-api session start [--self|--channel CHANNEL] [options]
  slack-api session start --link SLACK_THREAD_LINK [options]
  slack-api session defaults [show]
  slack-api session defaults set [options]
  slack-api session defaults reset
  slack-api session list [--active]
  slack-api session show --id SESSION_ID [--verbose]
  slack-api session events --id SESSION_ID [--limit N]
  slack-api session restart --id SESSION_ID [--host HOST|--keep-host]
  slack-api session pause|resume --id SESSION_ID
  slack-api session stop --id SESSION_ID [--keep-host]
  slack-api session approve|reject --id SESSION_ID --event MESSAGE_ID
  slack-api session respond --id SESSION_ID --event EVENT_ID [--status progress|complete|error] [--message TEXT|--message-file FILE|--stdin] [--send]
  slack-api session doctor [--provider PROVIDER] [--target TARGET] [--host HOST]

Start options:
  --self                        Create the thread in the authenticated user's self-DM
  --channel ID_OR_NAME|me       Where to create the new thread. Built-in default: me
  --message TEXT                Custom session root message
  --message-file FILE           Read the session root message from a file
  --link URL                    Advanced: bind an existing root or reply permalink
  --channel ID --thread-ts TS   Advanced: bind an explicit existing thread
  --provider auto|tmux|cmux|herdr|stdio
                                Auto detects cmux, then Herdr, then tmux
  --target ID                   Provider pane/surface target; normally auto detected
  --poll-seconds N              Poll interval. Default: 3
  --replay-existing             Inject existing replies; default starts after latest reply
  --allow-user USER_ID          Permit a collaborator; repeat as needed
  --allow-any-user              Permit any thread participant (still approval-gated)
  --auto-approve-collaborators  Inject allowed collaborators without owner approval
  --send-responses              Allow the local response bridge to post to Slack
  --no-send-responses           Keep responses and reactions in dry-run mode
  --host auto|herdr|cmux|process
                                Own the listener in a standalone pane or local process
  --standalone                  Alias for --host auto
  --agent-session ID            Persist the attached native coding-agent session ID
  --agent-provider NAME         Codex, Claude Code, OpenCode, Pi, or another provider
  --worktree PATH               Persist the attached worktree (normally auto detected)
  --foreground                  Keep the listener attached to this terminal
  --once                        Process one snapshot, then stop (implies --foreground)
  --simulate FILE               Use a deterministic Slack JSON fixture
  --state-dir DIR               Override local private session storage

Lifecycle options:
  --active                      With list, include only verified live listeners
  --verbose                     With show, inspect listener and host health
  --host auto|herdr|cmux|process
                                With restart, replace the saved host policy
  --keep-host                   With stop, leave the owned pane open; with restart,
                                reuse the exact verified owned pane
  --limit N                     Limit show/events audit records. Default: 100

Configured profile:
  slack-api session defaults set --channel me --send-responses --provider auto \\
    --poll-seconds 3 --headless --host auto
  slack-api session start

Safety:
  Sessions are thread-only and owner-only by default. Collaborator messages are
  queued until approved unless --auto-approve-collaborators is explicit. Response
  posting and acknowledgment reactions follow the effective saved profile and can
  always be disabled per run with --no-send-responses. Sent agent replies are
  prefixed with :robot_face:.

Slack thread controls (owner only):
  !session status
  !session pause
  !session resume
  !session stop
  !session approve MESSAGE_ID
  !session reject MESSAGE_ID

Examples:
  slack-api session doctor
  slack-api session start --host auto
  slack-api session start --channel '#agent-sessions'
  slack-api session start --link 'https://example.slack.com/archives/C123/p1778784641394639'
  slack-api session respond --id sess_... --event evt_... --message 'The build passed.' --send
  npm run session:demo
`);
}

function parseArgs(argv) {
  const { args: common, remaining } = parseCommonArgs(argv, {});
  const explicit = {};
  if (argv.includes("--headless") || argv.includes("--headed")) explicit.headless = true;
  const args = {
    ...common,
    action: remaining[0] || "help",
    defaultsAction: "",
    id: "",
    link: "",
    channel: "",
    channelProvided: false,
    self: false,
    threadTs: "",
    provider: "auto",
    target: "",
    host: "process",
    hostTarget: "",
    agentSession: "",
    agentProvider: "",
    worktree: "",
    pollSeconds: 3,
    replayExisting: false,
    allowedUserIds: [],
    allowAnyUser: false,
    autoApproveCollaborators: false,
    sendResponses: false,
    foreground: false,
    once: false,
    simulate: "",
    stateDir: DEFAULT_SESSION_DIR,
    eventId: "",
    message: "",
    messageProvided: false,
    messageFile: "",
    stdin: false,
    send: false,
    responseStatus: "complete",
    limit: 100,
    verbose: false,
    keepHost: false,
    runtimeInstance: "",
    activeOnly: false,
    helpFor: "",
    explicit,
  };
  if (args.action === "--help" || args.action === "-h") args.action = "help";
  let optionStart = 1;
  if (args.action === "defaults") {
    const explicitDefaultsAction = Boolean(
      remaining[1] && !remaining[1].startsWith("-"),
    );
    args.defaultsAction = explicitDefaultsAction
      ? remaining[1].toLowerCase()
      : "show";
    optionStart = explicitDefaultsAction ? 2 : 1;
  }
  for (let index = optionStart; index < remaining.length; index += 1) {
    const arg = remaining[index];
    const next = () => {
      index += 1;
      if (index >= remaining.length) throw new Error(`Missing value for ${arg}`);
      return remaining[index];
    };
    if (arg === "--id") args.id = next();
    else if (arg === "--link") {
      args.link = next();
      explicit.link = true;
    }
    else if (arg === "--channel") {
      args.channel = next();
      args.channelProvided = true;
      explicit.channel = true;
    }
    else if (arg === "--self") {
      args.self = true;
      args.channel = "me";
      explicit.channel = true;
    }
    else if (arg === "--thread-ts") args.threadTs = next();
    else if (arg === "--provider") {
      args.provider = next().toLowerCase();
      explicit.provider = true;
    }
    else if (arg === "--target") args.target = next();
    else if (arg === "--host") {
      args.host = next().toLowerCase();
      explicit.host = true;
    }
    else if (arg === "--standalone") {
      args.host = "auto";
      explicit.host = true;
    }
    else if (arg === "--no-standalone") {
      args.host = "process";
      explicit.host = true;
    }
    else if (arg === "--host-target") args.hostTarget = next();
    else if (arg === "--agent-session") args.agentSession = next();
    else if (arg === "--agent-provider") args.agentProvider = next();
    else if (arg === "--worktree") args.worktree = path.resolve(next());
    else if (arg === "--poll-seconds") {
      args.pollSeconds = parsePositiveInt(next(), "--poll-seconds");
      explicit.pollSeconds = true;
    }
    else if (arg === "--replay-existing") args.replayExisting = true;
    else if (arg === "--allow-user") args.allowedUserIds.push(next());
    else if (arg === "--allow-any-user") args.allowAnyUser = true;
    else if (arg === "--auto-approve-collaborators") args.autoApproveCollaborators = true;
    else if (arg === "--send-responses") {
      args.sendResponses = true;
      explicit.sendResponses = true;
    }
    else if (arg === "--no-send-responses") {
      args.sendResponses = false;
      explicit.sendResponses = true;
    }
    else if (arg === "--foreground") args.foreground = true;
    else if (arg === "--once") {
      args.once = true;
      args.foreground = true;
    } else if (arg === "--simulate") args.simulate = path.resolve(next());
    else if (arg === "--state-dir") args.stateDir = path.resolve(next());
    else if (arg === "--event") args.eventId = next();
    else if (arg === "--status") args.responseStatus = next().toLowerCase();
    else if (arg === "--message" || arg === "--root-message") {
      args.message = next();
      args.messageProvided = true;
    }
    else if (arg === "--message-file") args.messageFile = path.resolve(next());
    else if (arg === "--stdin") args.stdin = true;
    else if (arg === "--send") args.send = true;
    else if (arg === "--limit") args.limit = parsePositiveInt(next(), "--limit");
    else if (arg === "--verbose") args.verbose = true;
    else if (arg === "--keep-host") args.keepHost = true;
    else if (arg === "--runtime-instance") args.runtimeInstance = next();
    else if (arg === "--active") args.activeOnly = true;
    else if (arg === "--help" || arg === "-h") {
      args.helpFor = args.action;
      args.action = "help";
    }
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.stdin && args.action !== "respond" && args.helpFor !== "respond") {
    throw new Error("--stdin is only supported by session respond");
  }
  if (args.runtimeInstance && args.action !== "run") {
    throw new Error("--runtime-instance is only supported by the internal session runtime");
  }
  if (!["progress", "complete", "error"].includes(args.responseStatus)) {
    throw new Error("--status must be progress, complete, or error");
  }
  return args;
}

async function readAll(stream) {
  let value = "";
  stream.setEncoding?.("utf8");
  for await (const chunk of stream) value += chunk;
  return value;
}

function responseSources(args) {
  return [
    (args.messageProvided || args.message) ? "--message" : "",
    args.messageFile ? "--message-file" : "",
    args.stdin ? "--stdin" : "",
  ].filter(Boolean);
}

async function responseMessage(args, dependencies = {}) {
  const sources = responseSources(args);
  if (sources.length > 1) {
    throw new Error("--message, --message-file, and --stdin are mutually exclusive");
  }
  if (args.stdin) return readAll(dependencies.stdin || process.stdin);
  if (args.messageFile) return fs.readFileSync(args.messageFile, "utf8");
  return args.message;
}

function stableJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

function startRequestFingerprint(value) {
  return crypto.createHash("sha256")
    .update(stableJson(value), "utf8")
    .digest("hex");
}

function transitionStartIntent(store, claim, state, fields = {}) {
  if (!claim) return null;
  return store.updateStartIntent(
    claim.intent.id,
    claim.intent.activeAttemptId,
    (intent) => ({
      ...intent,
      ...fields,
      state,
      activeAttemptId: ["posting", "root_posted", "starting"].includes(state)
        ? intent.activeAttemptId
        : null,
      leaseUntil: ["posting", "root_posted", "starting"].includes(state)
        ? intent.leaseUntil
        : null,
      ...(state === "completed" ? { completedAt: new Date().toISOString() } : {}),
      ...(state === "failed" ? { failedAt: new Date().toISOString() } : {}),
    }),
  );
}

function slackConfig(args) {
  return {
    workspace: args.workspace,
    profile: args.profile,
    authCache: args.authCache,
    configPath: args.configPath,
    teamId: args.teamId,
    refreshAuth: args.refreshAuth,
    headless: args.headless,
    timeoutMs: args.timeoutMs,
  };
}

function explicitSessionDefaults(args) {
  const values = {};
  for (const key of ["channel", "sendResponses", "provider", "pollSeconds", "headless", "host"]) {
    if (args.explicit?.[key]) values[key] = args[key];
  }
  return values;
}

function applySessionDefaults(args, env = process.env) {
  const defaultsStore = new SessionDefaultsStore(args.stateDir);
  const resolved = defaultsStore.resolve({
    explicit: explicitSessionDefaults(args),
    env,
  });
  Object.assign(args, resolved.values);
  args.effective = {
    destination: args.link
      ? { value: args.link, source: { kind: "explicit" }, mode: "existing_thread" }
      : { value: args.channel, source: resolved.sources.channel, mode: "new_thread" },
    sendResponses: {
      value: args.sendResponses,
      source: resolved.sources.sendResponses,
    },
    provider: { value: args.provider, source: resolved.sources.provider },
    pollSeconds: { value: args.pollSeconds, source: resolved.sources.pollSeconds },
    headless: { value: args.headless, source: resolved.sources.headless },
    host: { value: args.host, source: resolved.sources.host },
    authorization: {
      ownerOnly: !args.allowAnyUser && args.allowedUserIds.length === 0,
      allowAnyUser: args.allowAnyUser,
      collaborators: args.autoApproveCollaborators ? "auto-approved" : "manual-approval",
    },
  };
  return { defaultsStore, resolved };
}

function createSlackForSession(session, dependencies = {}) {
  if (dependencies.slack) return dependencies.slack;
  if (session.simulation?.fixturePath) {
    return new SimulatedSlackThreadClient(session.simulation.fixturePath);
  }
  return new SlackThreadClient(session.slackConfig || {});
}

function createRuntimeForSession(store, session, dependencies = {}) {
  const slack = createSlackForSession(session, dependencies);
  const provider = dependencies.provider || createProvider(session.provider, {
    env: dependencies.env || process.env,
    ...(dependencies.providerDependencies || {}),
    identityMode: "require",
    expectedAgentSessionId: session.attachment?.agentSessionId || "",
  });
  return new SessionRuntime({
    store,
    slack,
    provider,
    sessionId: session.id,
    logger: dependencies.logger || console,
    now: dependencies.now,
    pollTimeoutMs: dependencies.pollTimeoutMs,
    runtimeInstanceId: session.runtimeInstanceId,
  });
}

async function waitForRuntime(store, id, milliseconds = 2500) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const session = store.get(id);
    if (!["active", "paused"].includes(session.status)) return session;
    if (session.pid && session.bridge?.port && session.timings?.firstPollAt) return session;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return store.get(id);
}

function runtimeIsReady(session) {
  return Boolean(
    session?.pid
    && session.bridge?.port
    && session.timings?.runtimeReadyAt
    && session.timings?.firstPollAt,
  );
}

function newRuntimeInstanceId() {
  return `runtime_${crypto.randomBytes(18).toString("base64url")}`;
}

function runtimeInstanceMatches(actual, expected) {
  const left = Buffer.from(String(actual || ""));
  const right = Buffer.from(String(expected || ""));
  return left.length > 0
    && left.length === right.length
    && crypto.timingSafeEqual(left, right);
}

function runtimeReadinessTimeoutMs(session, mode, dependencies = {}) {
  const explicit = Number(dependencies.runtimeReadyTimeoutMs);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const configuredPollTimeout = Number(
    dependencies.pollTimeoutMs || session?.slackConfig?.timeoutMs,
  );
  const pollTimeout = Number.isFinite(configuredPollTimeout) && configuredPollTimeout > 0
    ? configuredPollTimeout
    : DEFAULT_POLL_TIMEOUT_MS;
  const launchSchedulingOverhead = mode === "standalone"
    ? STANDALONE_LAUNCH_SCHEDULING_OVERHEAD_MS
    : PROCESS_LAUNCH_SCHEDULING_OVERHEAD_MS;
  const providerVerificationBudget = PROVIDER_VERIFICATION_BUDGET_MS[
    session?.provider?.name
  ] ?? 10_000;
  return pollTimeout + providerVerificationBudget + launchSchedulingOverhead;
}

function runtimeProcessIsAlive(session, dependencies = {}) {
  if (!session?.pid) return false;
  const isAlive = dependencies.processIsAlive || processIsAlive;
  return isAlive(session.pid);
}

function escapedRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function commandHasExactArgument(command, flag, value) {
  if (!String(command || "").trim() || !String(value || "")) return false;
  const escapedFlag = escapedRegExp(flag);
  const escapedValue = escapedRegExp(value);
  return new RegExp(
    `(?:^|\\s)${escapedFlag}(?:=|\\s+)(?:'${escapedValue}'|"${escapedValue}"|${escapedValue})(?=\\s|$)`,
  ).test(String(command));
}

function defaultRuntimeOwnershipVerifier(session, dependencies = {}) {
  if (!session.runtimeInstanceId) {
    return {
      owned: false,
      verified: false,
      reason: "runtime_instance_missing",
      command: null,
    };
  }
  const inspectProcessCommand = dependencies.inspectProcessCommand || ((pid) => {
    const result = spawnSync(
      "ps",
      ["-ww", "-o", "command=", "-p", String(pid)],
      { encoding: "utf8", timeout: 2_000 },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        String(result.stderr || "").trim() || `ps exited with status ${result.status}`,
      );
    }
    return String(result.stdout || "").trim();
  });
  let command;
  try {
    command = inspectProcessCommand(session.pid);
  } catch (error) {
    return {
      owned: false,
      verified: false,
      reason: "process_command_unavailable",
      error: String(error.message || error).slice(0, 1000),
      command: null,
    };
  }
  const sessionMatches = commandHasExactArgument(command, "--id", session.id);
  const instanceMatches = commandHasExactArgument(
    command,
    "--runtime-instance",
    session.runtimeInstanceId,
  );
  return {
    owned: sessionMatches && instanceMatches,
    verified: true,
    reason: sessionMatches && instanceMatches ? "identity_matches" : "identity_mismatch",
    command: null,
  };
}

function runtimeOwnership(session, dependencies = {}) {
  const alive = runtimeProcessIsAlive(session, dependencies);
  if (!alive) {
    return {
      alive: false,
      owned: false,
      verified: true,
      reason: session?.pid ? "process_not_alive" : "pid_missing",
    };
  }
  const verifier = dependencies.runtimeOwnershipVerifier;
  let verification;
  try {
    verification = verifier
      ? verifier(session)
      : defaultRuntimeOwnershipVerifier(session, dependencies);
  } catch (error) {
    verification = {
      owned: false,
      verified: false,
      reason: "ownership_verifier_failed",
      error: String(error.message || error).slice(0, 1000),
    };
  }
  if (typeof verification === "boolean") {
    verification = {
      owned: verification,
      verified: true,
      reason: verification ? "identity_matches" : "identity_mismatch",
    };
  }
  const verified = verification?.verified !== false;
  const owned = verified ? Boolean(verification?.owned) : null;
  return {
    alive: true,
    owned,
    verified,
    reason: verification?.reason
      || (verification?.owned ? "identity_matches" : "identity_mismatch"),
    ...(verification?.error ? { error: verification.error } : {}),
  };
}

function runtimeOwnershipIsExact(ownership) {
  return Boolean(
    ownership?.alive
    && ownership.verified
    && ownership.owned,
  );
}

function clearReconciledRuntimeReadiness(store, id, ownership, phase) {
  const cleared = store.update(id, (current) => {
    current.pid = null;
    current.bridge = { host: "127.0.0.1", port: null, url: null };
    if (current.host) {
      current.host.pid = null;
      current.host.status = current.host.target ? "reconciling" : "pending";
    }
    if (current.timings) {
      current.timings.runtimeReadyAt = null;
      current.timings.firstPollAt = null;
      current.timings.firstPollDurationMs = null;
      current.timings.runtimeReadyToFirstPollMs = null;
    }
    return current;
  });
  store.audit(id, "start_reconcile_runtime_ownership_rejected", {
    phase,
    alive: Boolean(ownership?.alive),
    verified: Boolean(ownership?.verified),
    owned: ownership?.owned === true,
    reason: ownership?.reason || "unknown",
  });
  return cleared;
}

function runtimeHealth(session, dependencies = {}) {
  const ownership = runtimeOwnership(session, dependencies);
  const configuredActive = ["active", "paused"].includes(session.status);
  let health;
  if (configuredActive && ownership.owned) health = "healthy";
  else if (!ownership.alive) health = configuredActive ? "runtime_dead" : "inactive";
  else if (!ownership.verified) health = "ownership_unverified";
  else if (!ownership.owned) health = "runtime_unowned";
  else health = "runtime_still_running";
  return {
    configuredActive,
    runtimeAlive: ownership.alive,
    runtimeOwned: ownership.owned,
    health,
    runtimeOwnershipReason: ownership.reason,
  };
}

function sessionWithRuntimeHealth(publicSession, privateSession, dependencies = {}) {
  return {
    ...publicSession,
    ...runtimeHealth(privateSession, dependencies),
  };
}

function signalRuntimeProcess(session, dependencies = {}) {
  const ownership = runtimeOwnership(session, dependencies);
  if (!ownership.alive || !ownership.owned) return false;
  const killProcess = dependencies.killProcess || process.kill.bind(process);
  try {
    killProcess(session.pid, "SIGTERM");
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function providerRuntimeEnvironment(provider) {
  return providerConnectionEnvironment(
    provider?.name,
    provider?.connection?.environment,
  );
}

function sanitizeHostDiagnostic(descriptor, value) {
  return Object.values(descriptor?.connection?.environment || {}).reduce(
    (diagnostic, endpoint) => (
      endpoint
        ? diagnostic.replaceAll(endpoint, "[redacted host connection]")
        : diagnostic
    ),
    String(value || ""),
  ).slice(-2000);
}

function publicHostDescriptor(descriptor) {
  if (!descriptor?.connection) return descriptor;
  return {
    ...descriptor,
    ...(descriptor.cleanup?.error
      ? {
        cleanup: {
          ...descriptor.cleanup,
          error: sanitizeHostDiagnostic(descriptor, descriptor.cleanup.error),
        },
      }
      : {}),
    connection: {
      environmentKeys: Object.keys(descriptor.connection.environment || {}).sort(),
    },
  };
}

function publicProviderDescriptor(descriptor) {
  if (!descriptor?.connection) return descriptor;
  return {
    ...descriptor,
    connection: {
      environmentKeys: Object.keys(descriptor.connection.environment || {}).sort(),
    },
  };
}

function publicHostInspection(result = {}) {
  const safe = {};
  for (const key of [
    "ok",
    "exists",
    "owned",
    "ownership",
    "delegated",
    "reason",
    "error",
  ]) {
    if (Object.hasOwn(result, key)) safe[key] = result[key];
  }
  safe.descriptor = publicHostDescriptor(result.descriptor);
  return safe;
}

function spawnRuntime(args, session, store, dependencies = {}) {
  if (!session.runtimeInstanceId) {
    throw new Error(`Session ${session.id} has no runtime instance identity`);
  }
  const logPath = path.join(store.baseDir, "events", `${session.id}.log`);
  const descriptor = fs.openSync(logPath, "a", 0o600);
  const childArgs = [
    __filename,
    "run",
    "--id", session.id,
    "--runtime-instance", session.runtimeInstanceId,
    "--state-dir", store.baseDir,
  ];
  let child;
  try {
    const spawnProcess = dependencies.spawn || spawn;
    child = spawnProcess(process.execPath, childArgs, {
      detached: true,
      stdio: ["ignore", descriptor, descriptor],
      env: {
        ...applyProviderConnection(
          session.provider,
          dependencies.env || process.env,
        ),
        SLACK_AGENT_SESSION_ID: session.id,
        SLACK_AGENT_TARGET_SESSION_ID: session.attachment?.agentSessionId || "",
      },
    });
    child.unref();
  } finally {
    fs.closeSync(descriptor);
  }
  store.audit(session.id, "runtime_spawned", { pid: child.pid, logPath });
  return { pid: child.pid, logPath };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function runtimeLaunchCommand(
  sessionId,
  stateDir,
  environment = {},
  runtimeInstanceId = "",
) {
  if (!runtimeInstanceId) {
    throw new Error(`Session ${sessionId} has no runtime instance identity`);
  }
  const assignments = Object.entries(environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, rawValue]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new Error(`Invalid runtime environment variable name: ${key}`);
      }
      const value = String(rawValue ?? "");
      if (/[\0\r\n]/.test(value)) {
        throw new Error(`Runtime environment variable ${key} contains a control character`);
      }
      return `${key}=${shellQuote(value)}`;
    });
  return [
    ...assignments,
    shellQuote(process.execPath),
    shellQuote(__filename),
    "run",
    "--id", shellQuote(sessionId),
    "--runtime-instance", shellQuote(runtimeInstanceId),
    "--state-dir", shellQuote(stateDir),
  ].join(" ");
}

function resolvedSessionHost(args, providerConfig, dependencies = {}) {
  const env = dependencies.env || process.env;
  const config = dependencies.hostConfig || resolveHostConfig({
    kind: args.host,
    provider: providerConfig,
    executable: args.hostExecutable || "",
    env,
    connection: args.hostConnection || null,
  }, dependencies.hostResolutionDependencies);
  const host = dependencies.sessionHost || createSessionHost(config, {
    env,
    now: dependencies.now,
    ...(dependencies.hostDependencies || {}),
  });
  return { config, host };
}

async function preflightSessionHost(args, providerConfig, dependencies = {}) {
  if (dependencies.hostConfig || dependencies.sessionHost || args.host !== "auto") {
    const resolved = resolvedSessionHost(args, providerConfig, dependencies);
    await resolved.host.preflight();
    return resolved;
  }
  const env = dependencies.env || process.env;
  const candidates = resolveHostCandidates({
    kind: "auto",
    provider: providerConfig,
    executable: args.hostExecutable || "",
    env,
    connection: args.hostConnection || null,
  }, dependencies.hostResolutionDependencies);
  const failures = [];
  for (const config of candidates) {
    const host = createSessionHost(config, {
      env,
      now: dependencies.now,
      ...(dependencies.hostDependencies || {}),
    });
    try {
      await host.preflight();
      return { config, host, failures };
    } catch (error) {
      failures.push({
        kind: config.kind,
        error: String(error.message || error).slice(0, 1000),
      });
    }
  }
  throw new Error(
    `No session host passed preflight: ${failures.map((failure) => (
      `${failure.kind}: ${failure.error}`
    )).join("; ")}`,
  );
}

async function launchRuntimeInStandaloneHost({
  args,
  session,
  store,
  host,
  hostConfig,
  now = () => Date.now(),
}) {
  const attachment = session.attachment || {};
  const runtimeEnvironment = {
    ...providerRuntimeEnvironment(session.provider),
    SLACK_AGENT_SESSION_ID: session.id,
    SLACK_AGENT_TARGET_SESSION_ID: attachment.agentSessionId || "",
  };
  let descriptor = null;
  let createCompleted = false;
  try {
    descriptor = await host.create({
      sessionId: session.id,
      cwd: attachment.worktree || process.cwd(),
      label: `Slack session ${session.id}`,
      environment: runtimeEnvironment,
      windowId: args.hostTarget || null,
    });
    createCompleted = true;
    descriptor = {
      ...descriptor,
      requestedKind: session.host?.requestedKind,
      connection: descriptor.connection || hostConfig.connection,
      source: hostConfig.source,
      status: "created",
    };
    store.update(session.id, (latest) => {
      latest.host = descriptor;
      return latest;
    });
    const launched = await host.launch(descriptor, {
      command: runtimeLaunchCommand(
        session.id,
        store.baseDir,
        runtimeEnvironment,
        session.runtimeInstanceId,
      ),
    });
    descriptor = {
      ...launched.descriptor,
      connection: launched.descriptor.connection || descriptor.connection || hostConfig.connection,
      source: hostConfig.source,
      status: "launching",
    };
    store.update(session.id, (latest) => {
      latest.host = descriptor;
      return latest;
    });
    store.audit(session.id, "runtime_host_launched", {
      kind: descriptor.kind,
      target: descriptor.target,
      workspaceId: descriptor.workspaceId,
      paneId: descriptor.paneId,
      surfaceId: descriptor.surfaceId,
    });
    return descriptor;
  } catch (error) {
    let cleanupPending = false;
    if (!createCompleted && error.hostDescriptor) {
      cleanupPending = true;
      descriptor = {
        ...error.hostDescriptor,
        requestedKind: session.host?.requestedKind,
        connection: error.hostDescriptor.connection || hostConfig.connection,
        source: hostConfig.source,
        status: "cleanup_pending",
      };
    } else if (descriptor) {
      try {
        const closed = await host.close(descriptor);
        descriptor = closed.descriptor || descriptor;
      } catch (cleanupError) {
        cleanupPending = true;
        descriptor = {
          ...descriptor,
          status: "cleanup_pending",
          cleanup: {
          attempted: true,
          ok: false,
          pending: true,
          status: null,
          error: sanitizeHostDiagnostic(
            descriptor,
            cleanupError.message || cleanupError,
          ),
          },
        };
      }
    }
    store.update(session.id, (latest) => {
      latest.status = "startup_failed";
      latest.stoppedAt = new Date(now()).toISOString();
      latest.host = {
        ...(descriptor || latest.host),
        requestedKind: latest.host?.requestedKind ?? session.host?.requestedKind,
        managed: descriptor ? Boolean(descriptor.managed) : false,
        status: cleanupPending
          ? "cleanup_pending"
          : createCompleted
            ? "launch_failed"
            : "create_failed",
      };
      return latest;
    });
    store.audit(session.id, createCompleted ? "runtime_host_launch_failed" : "runtime_host_create_failed", {
      kind: descriptor?.kind || hostConfig.kind,
      target: descriptor?.target || null,
      cleanupPending,
      cleanupError: sanitizeHostDiagnostic(
        descriptor || hostConfig,
        descriptor?.cleanup?.error || error.hostCleanup?.error || "",
      ) || null,
      error: sanitizeHostDiagnostic(
        descriptor || hostConfig,
        error.message || error,
      ),
    });
    throw error;
  }
}

async function hostControllerForSession(session, dependencies = {}) {
  if (!session.host?.kind || ["foreground", "pending", "unknown"].includes(session.host.kind)) {
    return null;
  }
  if (dependencies.sessionHost) return dependencies.sessionHost;
  const env = dependencies.env || process.env;
  const config = resolveHostConfig({
    kind: session.host.kind,
    provider: session.provider,
    executable: session.host.executable || "",
    env,
    connection: session.host.connection || null,
  }, dependencies.hostResolutionDependencies);
  return createSessionHost(config, {
    env,
    now: dependencies.now,
    ...(dependencies.hostDependencies || {}),
  });
}

async function closeSessionHost(store, session, dependencies = {}) {
  if (!session.host?.managed) {
    return {
      ok: true,
      closed: false,
      reason: "host_not_managed",
      descriptor: publicHostDescriptor(session.host),
    };
  }
  if (session.host.closedAt || session.host.status === "closed") {
    return {
      ok: true,
      closed: false,
      reason: "host_already_closed",
      descriptor: publicHostDescriptor(session.host),
    };
  }
  const host = await hostControllerForSession(session, dependencies);
  if (!host) {
    return {
      ok: true,
      closed: false,
      reason: "host_unavailable",
      descriptor: publicHostDescriptor(session.host),
    };
  }
  let result;
  try {
    result = await host.close(session.host);
    if (result?.ok === false) {
      throw new Error(result.error || result.reason || "host close failed");
    }
  } catch (error) {
    const diagnostic = sanitizeHostDiagnostic(
      session.host,
      error.message || error,
    ) || "host close failed";
    const updated = store.update(session.id, (latest) => {
      latest.host = {
        ...latest.host,
        status: "cleanup_pending",
        cleanup: {
          ...(latest.host?.cleanup || {}),
          attempted: true,
          ok: false,
          pending: true,
          status: Number.isInteger(error.status) ? error.status : null,
          error: diagnostic,
          lastAttemptAt: new Date().toISOString(),
        },
      };
      return latest;
    });
    store.audit(session.id, "runtime_host_cleanup_pending", {
      kind: session.host.kind,
      target: session.host.target,
      error: diagnostic,
    });
    const wrapped = new Error(diagnostic);
    wrapped.hostDescriptor = updated.host;
    wrapped.hostCleanup = updated.host.cleanup;
    throw wrapped;
  }
  const updated = store.update(session.id, (latest) => {
    latest.host = {
      ...(result.descriptor || latest.host),
      requestedKind: latest.host?.requestedKind,
      status: result.closed ? "closed" : latest.host.status,
    };
    return latest;
  });
  store.audit(session.id, "runtime_host_closed", {
    kind: session.host.kind,
    target: session.host.target,
    closed: result.closed,
    reason: result.reason || null,
  });
  return { ...result, descriptor: updated.host };
}

function clearRuntimeStateAfterExit(store, id) {
  return store.update(id, (session) => {
    session.pid = null;
    if (session.host) session.host.pid = null;
    session.bridge = { host: "127.0.0.1", port: null, url: null };
    return session;
  });
}

async function waitForRuntimeStop(store, id, milliseconds = 5_000, dependencies = {}) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const session = store.get(id, { includeSecret: true });
    const ownership = runtimeOwnership(session, dependencies);
    if (!ownership.alive || !ownership.owned) return session;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return store.get(id, { includeSecret: true });
}

async function failRuntimeLifecycle(store, id, {
  status,
  event,
  error,
  closeHost = true,
} = {}, dependencies = {}) {
  store.update(id, (current) => {
    current.status = "stopped";
    current.stoppedAt = new Date().toISOString();
    return current;
  });
  let session = store.get(id, { includeSecret: true });
  if (closeHost && session.host?.managed && !["process", "foreground"].includes(session.host.kind)) {
    let hostCleanupFailed = false;
    try {
      await closeSessionHost(store, session, dependencies);
    } catch (closeError) {
      hostCleanupFailed = true;
      store.audit(id, "runtime_host_cleanup_failed", {
        error: String(closeError.message || closeError).slice(0, 2000),
      });
    }
    try {
      const current = store.get(id, { includeSecret: true });
      const signalled = signalRuntimeProcess(current, dependencies);
      store.audit(
        id,
        hostCleanupFailed
          ? "runtime_signalled_after_host_cleanup_failure"
          : "runtime_signalled_after_host_close",
        {
          pid: current.pid || null,
          signalled,
        },
      );
    } catch (signalError) {
      store.audit(id, "runtime_signal_failed", {
        reason: hostCleanupFailed ? "host_cleanup_failed" : "host_closed_runtime_alive",
        error: String(signalError.message || signalError).slice(0, 2000),
      });
    }
  } else {
    try {
      signalRuntimeProcess(session, dependencies);
    } catch (signalError) {
      store.audit(id, "runtime_signal_failed", {
        error: String(signalError.message || signalError).slice(0, 2000),
      });
    }
  }
  session = await waitForRuntimeStop(
    store,
    id,
    dependencies.runtimeStopTimeoutMs || 5_000,
    dependencies,
  );
  const ownership = runtimeOwnership(session, dependencies);
  if (ownership.alive && ownership.owned) {
    store.audit(id, "runtime_termination_timed_out", {
      requestedStatus: status,
      host: session.host?.kind || null,
    });
    return session;
  }
  if (ownership.alive && !ownership.verified) {
    session = store.update(id, (current) => {
      current.status = status;
      current.stoppedAt ||= new Date().toISOString();
      return current;
    });
    store.audit(id, "runtime_termination_unverified", {
      requestedStatus: status,
      host: session.host?.kind || null,
      reason: ownership.reason,
    });
    return session;
  }
  if (ownership.alive && !ownership.owned) {
    store.audit(id, "stale_runtime_pid_ignored", {
      pid: session.pid,
      reason: ownership.reason,
    });
  }
  session = store.update(id, (current) => {
    current.status = status;
    current.stoppedAt ||= new Date().toISOString();
    current.pid = null;
    if (current.host) current.host.pid = null;
    current.bridge = { host: "127.0.0.1", port: null, url: null };
    return current;
  });
  store.audit(id, event, {
    error: String(error || "").slice(0, 2000),
    host: session.host?.kind || null,
  });
  return session;
}

function startVerification(session, effective = null) {
  return {
    channel: session.slack.channelId,
    permalink: session.slack.permalink,
    rootTs: session.slack.threadTs,
    author: session.slack.rootAuthorName
      || session.slack.rootAuthorUserId
      || session.ownerName
      || session.ownerUserId,
    authorUserId: session.slack.rootAuthorUserId || session.ownerUserId,
    owner: session.ownerName || session.ownerUserId,
    ownerUserId: session.ownerUserId,
    provider: session.provider,
    host: session.host,
    attachment: session.attachment,
    timings: session.timings,
    effective,
    refreshHint: "Open the permalink directly; refresh Slack if the new thread is not visible yet.",
  };
}

function detectAgentAttachment(args, env = process.env) {
  let agentProvider = String(args.agentProvider || "").trim();
  let agentSessionId = String(args.agentSession || "").trim();
  if (!agentSessionId && env.CODEX_THREAD_ID) {
    agentSessionId = env.CODEX_THREAD_ID;
    agentProvider ||= "codex";
  } else if (!agentSessionId && env.CLAUDE_SESSION_ID) {
    agentSessionId = env.CLAUDE_SESSION_ID;
    agentProvider ||= "claude-code";
  } else if (!agentSessionId && env.OPENCODE_SESSION_ID) {
    agentSessionId = env.OPENCODE_SESSION_ID;
    agentProvider ||= "opencode";
  } else if (!agentSessionId && (env.PI_SESSION_FILE || env.PI_SESSION_ID)) {
    // Herdr reports the Pi agent session as its launch file (kind "path"), so
    // prefer PI_SESSION_FILE; PI_SESSION_ID remains the fallback.
    agentSessionId = env.PI_SESSION_FILE || env.PI_SESSION_ID;
    agentProvider ||= "pi";
  }
  if (!agentProvider) agentProvider = agentSessionId ? "unknown" : "unattached";

  let worktree = String(args.worktree || "").trim();
  if (!worktree) {
    let candidate = path.resolve(process.cwd());
    while (candidate !== path.dirname(candidate)) {
      if (fs.existsSync(path.join(candidate, ".git"))) {
        worktree = candidate;
        break;
      }
      candidate = path.dirname(candidate);
    }
  }
  return {
    agentSessionId: agentSessionId || null,
    agentProvider,
    worktree: worktree || null,
  };
}

async function startSession(args, dependencies = {}) {
  if (args.messageFile && (args.messageProvided || args.message)) {
    throw new Error("--message and --message-file are mutually exclusive");
  }
  const store = dependencies.store || new SessionStore(args.stateDir);
  store.readState();
  const now = dependencies.now || (() => Date.now());
  const commandStartedAtMs = now();
  const timings = {
    commandStartedAt: new Date(commandStartedAtMs).toISOString(),
  };
  const slack = dependencies.slack || (
    args.simulate
      ? new SimulatedSlackThreadClient(args.simulate)
      : new SlackThreadClient(slackConfig(args), dependencies.slackDependencies)
  );
  const requestedProvider = args.simulate && args.provider === "auto" ? "stdio" : args.provider;
  const providerEnv = dependencies.env || process.env;
  const attachment = detectAgentAttachment(args, providerEnv);
  const providerConfig = resolveProviderConfig({
    name: requestedProvider,
    target: args.target,
    env: providerEnv,
  });
  const provider = dependencies.provider || createProvider(providerConfig, {
    env: providerEnv,
    ...(dependencies.providerDependencies || {}),
    identityMode: "establish",
    expectedAgentSessionId: attachment.agentSessionId || "",
  });
  let phaseStartedAt = now();
  const providerVerification = provider.verify();
  timings.providerPreflightMs = Math.max(0, now() - phaseStartedAt);
  let hostConfig = { kind: "foreground", executable: null, source: "explicit" };
  let sessionHost = null;
  if (!args.foreground) {
    phaseStartedAt = now();
    const resolvedHost = await preflightSessionHost(args, providerConfig, dependencies);
    hostConfig = resolvedHost.config;
    sessionHost = resolvedHost.host;
    timings.hostPreflightMs = Math.max(0, now() - phaseStartedAt);
    args.effective ||= {};
    args.effective.host = {
      ...(args.effective.host || {}),
      resolved: hostConfig.kind,
      executable: hostConfig.executable,
      resolutionSource: hostConfig.source,
    };
  } else {
    timings.hostPreflightMs = 0;
  }
  const cmuxSocketMode = String(providerEnv.CMUX_SOCKET_MODE || "").toLowerCase().replaceAll(/[-_]/g, "");
  if (
    providerConfig.name === "cmux"
    && !args.foreground
    && hostConfig.kind !== "cmux"
    && cmuxSocketMode !== "allowall"
  ) {
    throw new Error(
      "A cmux target hosted outside cmux requires CMUX_SOCKET_MODE=allowAll because cmux's default socket mode checks process ancestry. "
      + "Set it for the listener, use --host cmux, or use --foreground from a separate cmux surface.",
    );
  }

  if (args.link && (args.self || (args.explicit?.channel && args.channel))) {
    throw new Error("--link conflicts with --self and --channel; choose one destination mode");
  }
  if (args.self && args.channelProvided) {
    throw new Error("--self and --channel are mutually exclusive");
  }
  if (args.link && args.threadTs) {
    throw new Error("--link and --thread-ts are mutually exclusive");
  }
  if (args.self && args.threadTs) {
    throw new Error("--self cannot be used when binding an existing thread");
  }
  if (args.threadTs && (!args.channel || !args.explicit?.channel)) {
    throw new Error("--thread-ts requires an explicit --channel");
  }
  if (args.threadTs && /^(me|self)$/i.test(args.channel)) {
    throw new Error("--thread-ts requires a concrete Slack channel or DM ID, not me");
  }

  let identity = null;
  phaseStartedAt = now();
  if (typeof slack.identity === "function") identity = await slack.identity();
  timings.authenticationMs = Math.max(0, now() - phaseStartedAt);

  let id = newSessionId();
  let runtimeInstanceId = newRuntimeInstanceId();
  const bindsExistingThread = Boolean(args.link || args.threadTs);
  let startIntentClaim = null;
  let target;
  let initialized;
  if (bindsExistingThread) {
    phaseStartedAt = now();
    target = targetFromArgs(args);
    initialized = await slack.initialize(target);
    timings.destinationResolutionMs = Math.max(0, now() - phaseStartedAt);
    timings.rootCreationMs = 0;
  } else {
    phaseStartedAt = now();
    const destination = typeof slack.resolveDestination === "function"
      ? await slack.resolveDestination(args.channel, identity)
      : { channelId: args.channel, requested: args.channel, kind: "unknown" };
    timings.destinationResolutionMs = Math.max(0, now() - phaseStartedAt);
    const customMessage = args.messageFile
      ? fs.readFileSync(args.messageFile, "utf8")
      : args.message;
    const normalizedCustomMessage = String(customMessage || "").trim();
    const requestFingerprint = startRequestFingerprint({
      version: 1,
      workspace: args.workspace || null,
      teamId: identity?.team_id || null,
      ownerUserId: identity?.user_id || null,
      channelId: destination.channelId,
      customMessageSha256: normalizedCustomMessage
        ? crypto.createHash("sha256").update(normalizedCustomMessage, "utf8").digest("hex")
        : null,
      provider: {
        name: providerConfig.name,
        target: providerVerification?.target || provider.target || providerConfig.target,
        executable: providerConfig.executable || null,
        connection: providerConfig.connection || null,
        identity: providerVerification?.identity || provider.identity || null,
      },
      host: {
        requestedKind: args.host,
        resolvedKind: hostConfig.kind,
        executable: hostConfig.executable || null,
        connection: hostConfig.connection || null,
        windowId: args.hostTarget || null,
      },
      attachment,
      policy: {
        allowedUserIds: [...args.allowedUserIds].sort(),
        allowAnyUser: args.allowAnyUser,
        autoApproveCollaborators: args.autoApproveCollaborators,
        sendResponses: args.sendResponses,
        pollSeconds: args.pollSeconds,
        replayExisting: args.replayExisting,
      },
      simulation: args.simulate || null,
    });
    startIntentClaim = store.claimStartIntent({
      requestFingerprint,
      slack: {
        workspace: args.workspace || null,
        teamId: identity?.team_id || null,
        channelId: destination.channelId,
      },
    }, {
      now: Date.now(),
      leaseMs: Math.max(Number(args.timeoutMs) || 30_000, 30_000) + 5_000,
    });
    if (startIntentClaim.kind === "in-flight") {
      const error = new Error(
        `An identical Slack session start is already in progress as ${startIntentClaim.intent.sessionId}; `
        + "wait for it to finish, then use session show before retrying",
      );
      error.code = "SESSION_START_IN_PROGRESS";
      throw error;
    }
    id = startIntentClaim.intent.sessionId;
    const rootMessage = String(customMessage || "").trim() || [
      `Agent session \`${id}\` started; target ${providerConfig.name}, listener host ${hostConfig.kind}.`,
      "Reply in this thread to send a message to the local agent.",
      "Owner controls: `!session status`, `!session pause`, `!session resume`, `!session stop`.",
    ].join("\n");
    phaseStartedAt = now();
    try {
      initialized = await slack.createThread({
        channel: args.channel,
        text: rootMessage,
        identity,
        destination,
        clientMessageId: startIntentClaim.intent.clientMessageId,
        reconcile: Boolean(
          startIntentClaim.resumedFrom
          || startIntentClaim.intent.root,
        ),
      });
    } catch (error) {
      transitionStartIntent(
        store,
        startIntentClaim,
        error.rootPostAmbiguous === false ? "failed" : "ambiguous",
        {
          lastError: String(error.message || error).slice(0, 1000),
        },
      );
      throw error;
    }
    timings.rootCreationMs = Math.max(0, now() - phaseStartedAt);
    target = {
      channelId: initialized.channelId,
      threadTs: initialized.threadTs,
      link: initialized.permalink,
    };
    const recorded = transitionStartIntent(
      store,
      startIntentClaim,
      "root_posted",
      {
        root: {
          channelId: initialized.channelId,
          threadTs: initialized.threadTs,
          permalink: initialized.permalink,
          reconciled: Boolean(initialized.reconciled),
        },
      },
    );
    if (!recorded?.updated) {
      throw new Error(
        `Slack session start ${startIntentClaim.intent.id} was superseded by another retry`,
      );
    }
  }
  if (!target.channelId || !target.threadTs) throw new Error("Could not resolve the Slack session thread");

  let session;
  let reusedPersistedSession = false;
  const sessionInput = {
      id,
      runtimeInstanceId,
      slack: {
        workspace: initialized.workspace,
        teamId: initialized.teamId,
        channelId: target.channelId,
        threadTs: target.threadTs,
        permalink: initialized.permalink,
        rootAuthorUserId: initialized.messages
          ?.find((message) => message.ts === target.threadTs)?.user
          || initialized.ownerUserId,
        rootAuthorName: initialized.messages
          ?.find((message) => message.ts === target.threadTs)?.username
          || initialized.ownerName
          || null,
        rootStartIntentId: startIntentClaim?.intent.id || null,
        rootClientMessageId: startIntentClaim?.intent.clientMessageId || null,
        rootPostReconciled: Boolean(initialized.reconciled),
        createdBySession: !bindsExistingThread,
        bindingMode: bindsExistingThread ? "existing_thread" : "created_thread",
      },
      provider: {
        name: providerConfig.name,
        target: providerVerification?.target || provider.target || providerConfig.target,
        executable: providerConfig.executable || null,
        connection: providerConfig.connection,
        ...(providerVerification?.identity || provider.identity
          ? { identity: providerVerification?.identity || provider.identity }
          : {}),
      },
      host: {
        kind: args.foreground ? "foreground" : hostConfig.kind,
        requestedKind: args.host,
        target: null,
        managed: !args.foreground,
        createdAt: null,
        closedAt: null,
        executable: hostConfig.executable,
        source: hostConfig.source,
        connection: hostConfig.connection,
      },
      attachment: {
        ...attachment,
        provider: providerConfig.name,
        target: providerVerification?.target || provider.target || providerConfig.target,
      },
      ownerUserId: initialized.ownerUserId,
      ownerName: initialized.ownerName,
      allowedUserIds: args.allowedUserIds,
      allowAnyUser: args.allowAnyUser,
      autoApproveCollaborators: args.autoApproveCollaborators,
      sendResponses: args.sendResponses,
      pollIntervalMs: args.pollSeconds * 1000,
      cursorTs: bindsExistingThread && args.replayExisting ? target.threadTs : initialized.latestTs,
      simulation: args.simulate ? { fixturePath: args.simulate } : null,
      slackConfig: args.simulate ? null : slackConfig(args),
      timings,
  };
  try {
    if (startIntentClaim) {
      const mode = hostConfig.kind === "process" ? "detached" : "standalone";
      const startingLeaseMs = Math.max(
        runtimeReadinessTimeoutMs(sessionInput, mode, dependencies) + 60_000,
        Number(args.timeoutMs) || 30_000,
      );
      const persisted = store.createStartSession(
        sessionInput,
        startIntentClaim,
        {
          leaseUntil: new Date(Date.now() + startingLeaseMs).toISOString(),
        },
      );
      session = persisted.session;
      reusedPersistedSession = persisted.reused;
      runtimeInstanceId = store.get(session.id, {
        includeSecret: true,
      }).runtimeInstanceId;
    } else {
      session = store.create(sessionInput);
    }
  } catch (error) {
    let latestIntentState = null;
    try {
      latestIntentState = startIntentClaim
        ? store.getStartIntent(startIntentClaim.intent.id).state
        : null;
    } catch {}
    if (latestIntentState !== "starting") {
      transitionStartIntent(store, startIntentClaim, "root_posted", {
        lastError: String(error.message || error).slice(0, 1000),
      });
    }
    throw error;
  }

  let reconciledPrivateSession = null;
  let reconciledOwnershipFailure = null;
  if (reusedPersistedSession) {
    reconciledPrivateSession = store.get(session.id, { includeSecret: true });
    if (runtimeIsReady(reconciledPrivateSession)) {
      const ownership = runtimeOwnership(reconciledPrivateSession, dependencies);
      if (runtimeOwnershipIsExact(ownership)) {
        const ready = store.get(session.id);
        transitionStartIntent(store, startIntentClaim, "completed", {
          completedSessionId: ready.id,
          completedThreadTs: ready.slack.threadTs,
        });
        return {
          ok: true,
          mode: "reconciled",
          spawned: null,
          host: ready.host,
          start: startVerification(ready, args.effective || null),
          effective: args.effective || null,
          session: ready,
          warning: null,
        };
      }
      reconciledOwnershipFailure = ownership;
      clearReconciledRuntimeReadiness(
        store,
        session.id,
        ownership,
        "initial",
      );
      reconciledPrivateSession = store.get(session.id, { includeSecret: true });
    }
  }

  if (args.foreground) {
    const runtime = new SessionRuntime({
      store,
      slack,
      provider,
      sessionId: session.id,
      logger: dependencies.logger || console,
      now,
      pollTimeoutMs: dependencies.pollTimeoutMs,
      runtimeInstanceId,
    });
    let completed;
    try {
      completed = await runtime.run({ once: args.once });
    } catch (error) {
      store.update(session.id, (current) => {
        current.status = "startup_failed";
        current.stoppedAt ||= new Date(now()).toISOString();
        return current;
      });
      store.audit(session.id, "foreground_runtime_start_failed", {
        error: String(error.message || error).slice(0, 2000),
      });
      transitionStartIntent(store, startIntentClaim, "failed", {
        lastError: String(error.message || error).slice(0, 1000),
      });
      throw error;
    }
    const output = {
      ok: true,
      mode: "foreground",
      start: startVerification(completed, args.effective || null),
      effective: args.effective || null,
      session: completed,
    };
    transitionStartIntent(store, startIntentClaim, "completed", {
      completedSessionId: completed.id,
      completedThreadTs: completed.slack.threadTs,
    });
    return output;
  }
  const runtimeLaunchStartedAt = now();
  const waitRuntime = dependencies.waitForRuntime || waitForRuntime;
  let spawned = null;
  let hosted = null;
  let mode = "detached";
  const reconciledHostLaunch = Boolean(
    reusedPersistedSession
    && (
      reconciledPrivateSession?.pid
      || reconciledPrivateSession?.host?.target
    ),
  );
  if (reconciledHostLaunch) {
    if (reconciledPrivateSession.host?.kind === "process") {
      spawned = {
        pid: reconciledPrivateSession.pid,
        logPath: reconciledPrivateSession.host.logPath || null,
        reconciled: true,
      };
    } else {
      mode = "standalone";
      hosted = reconciledPrivateSession.host;
    }
  } else {
    try {
      if (hostConfig.kind === "process") {
        spawned = spawnRuntime(
          args,
          store.get(session.id, { includeSecret: true }),
          store,
          dependencies,
        );
        store.update(session.id, (latest) => {
          latest.pid = spawned.pid;
          latest.host = {
            kind: "process",
            requestedKind: latest.host?.requestedKind || args.host,
            target: String(spawned.pid),
            pid: spawned.pid,
            managed: true,
            createdAt: new Date(runtimeLaunchStartedAt).toISOString(),
            launchedAt: new Date(runtimeLaunchStartedAt).toISOString(),
            closedAt: null,
            logPath: spawned.logPath,
            executable: process.execPath,
            source: hostConfig.source,
            status: "launching",
          };
          return latest;
        });
      } else {
        mode = "standalone";
        hosted = await launchRuntimeInStandaloneHost({
          args,
          session: store.get(session.id, { includeSecret: true }),
          store,
          host: sessionHost,
          hostConfig,
          now,
        });
      }
    } catch (error) {
      await failRuntimeLifecycle(store, session.id, {
        status: "startup_failed",
        event: "runtime_launch_failed",
        error: error.message || error,
        closeHost: false,
      }, dependencies);
      transitionStartIntent(store, startIntentClaim, "failed", {
        lastError: String(error.message || error).slice(0, 1000),
      });
      throw error;
    }
  }
  const readinessTimeoutMs = runtimeReadinessTimeoutMs(
    store.get(session.id, { includeSecret: true }),
    mode,
    dependencies,
  );
  store.update(session.id, (latest) => {
    latest.timings.runtimeReadinessBudgetMs = readinessTimeoutMs;
    return latest;
  });
  await waitRuntime(
    store,
    session.id,
    readinessTimeoutMs,
  );
  store.update(session.id, (latest) => {
    latest.timings.runtimeReadinessMs = Math.max(0, now() - runtimeLaunchStartedAt);
    if (hostConfig.kind === "process") {
      latest.host.status = runtimeIsReady(latest) ? "running" : "launching";
    } else if (latest.host) {
      latest.host.status = latest.pid ? "running" : "launching";
    }
    return latest;
  });
  let ready = store.get(session.id);
  if (reusedPersistedSession && runtimeIsReady(ready)) {
    const ownership = runtimeOwnership(
      store.get(session.id, { includeSecret: true }),
      dependencies,
    );
    if (!runtimeOwnershipIsExact(ownership)) {
      reconciledOwnershipFailure = ownership;
      ready = clearReconciledRuntimeReadiness(
        store,
        session.id,
        ownership,
        "readiness",
      );
    }
  }
  if (!runtimeIsReady(ready)) {
    const readinessError = reconciledOwnershipFailure
      ? `Reconciled listener ownership was not verified (${reconciledOwnershipFailure.reason}) for session ${session.id}`
      : mode === "standalone"
        ? `Listener did not report runtime and first-poll readiness in ${ready.host.kind}:${ready.host.target}`
        : `Listener did not report runtime and first-poll readiness; inspect ${
          spawned?.logPath || ready.host?.logPath || `session ${session.id}`
        }`;
    ready = await failRuntimeLifecycle(store, session.id, {
      status: "startup_failed",
      event: "runtime_readiness_failed",
      error: readinessError,
    }, dependencies);
    transitionStartIntent(store, startIntentClaim, "failed", {
      lastError: readinessError.slice(0, 1000),
    });
    throw new Error(`${readinessError}; session ${session.id} was stopped`);
  }
  const output = {
    ok: true,
    mode,
    spawned,
    host: ready.host,
    start: startVerification(ready, args.effective || null),
    effective: args.effective || null,
    session: ready,
    warning: null,
  };
  transitionStartIntent(store, startIntentClaim, "completed", {
    completedSessionId: ready.id,
    completedThreadTs: ready.slack.threadTs,
  });
  return output;
}

async function runSession(args, dependencies = {}) {
  if (!args.id) throw new Error("--id is required");
  const store = dependencies.store || new SessionStore(args.stateDir);
  const session = store.get(args.id, { includeSecret: true });
  if (!runtimeInstanceMatches(args.runtimeInstance, session.runtimeInstanceId)) {
    store.audit(args.id, "runtime_instance_rejected", {
      supplied: Boolean(args.runtimeInstance),
      expected: Boolean(session.runtimeInstanceId),
    });
    throw new Error(`Runtime instance identity did not match session ${args.id}`);
  }
  const runtime = createRuntimeForSession(store, session, dependencies);
  const completed = await runtime.run({ once: args.once });
  let hostCleanup = null;
  if (
    completed.status === "stopped"
    && completed.host?.managed
    && !completed.host?.keepOpenOnStop
    && !completed.host?.closedAt
  ) {
    try {
      hostCleanup = await closeSessionHost(
        store,
        store.get(args.id, { includeSecret: true }),
        dependencies,
      );
    } catch (error) {
      store.audit(args.id, "runtime_host_self_cleanup_failed", {
        error: String(error.message || error).slice(0, 2000),
      });
      hostCleanup = { ok: false, closed: false, error: error.message };
    }
  }
  return { ok: true, mode: "run", hostCleanup, session: store.get(args.id) };
}

async function inspectRuntimeHost(session, dependencies = {}) {
  const runtime = runtimeHealth(session, dependencies);
  if (session.host?.kind === "process") {
    return {
      ok: true,
      exists: runtime.runtimeAlive,
      hostExists: runtime.runtimeAlive,
      ...runtime,
      orphanedRuntime: false,
      running: runtime.runtimeOwned,
      descriptor: publicHostDescriptor(session.host),
    };
  }
  const host = await hostControllerForSession(session, dependencies);
  if (!host) {
    return {
      ok: true,
      exists: null,
      hostExists: null,
      ...runtime,
      orphanedRuntime: null,
      running: runtime.runtimeOwned,
      descriptor: publicHostDescriptor(session.host),
    };
  }
  try {
    const result = await host.inspect(session.host);
    return {
      ...publicHostInspection(result),
      hostExists: result.exists,
      ...runtime,
      orphanedRuntime: Boolean(runtime.runtimeOwned && result.exists === false),
      running: runtime.runtimeOwned,
    };
  } catch (error) {
    return {
      ok: false,
      exists: null,
      hostExists: null,
      ...runtime,
      orphanedRuntime: null,
      running: runtime.runtimeOwned,
      error: String(error.message || error),
      descriptor: publicHostDescriptor(session.host),
    };
  }
}

const RESTART_HOST_KINDS = new Set(["auto", "cmux", "herdr", "process"]);

function requestedHostKindForRestart(args, originalHost) {
  if (args.explicit?.host) return args.host;
  if (RESTART_HOST_KINDS.has(originalHost.requestedKind)) {
    return originalHost.requestedKind;
  }
  return RESTART_HOST_KINDS.has(originalHost.kind) && originalHost.kind !== "auto"
    ? originalHost.kind
    : "process";
}

function exactReusableHostWasInspected(originalHost, inspection) {
  if (!inspection?.ok || inspection.exists !== true) return false;
  if (inspection.owned === false || inspection.ownershipVerified === false) return false;
  if (originalHost.kind === "herdr" && inspection.owned !== true) return false;
  const inspected = inspection.descriptor || {};
  if (
    !originalHost.managed
    || !["cmux", "herdr"].includes(originalHost.kind)
    || inspected.kind !== originalHost.kind
    || !originalHost.workspaceId
    || inspected.workspaceId !== originalHost.workspaceId
  ) {
    return false;
  }
  const identityKey = originalHost.kind === "cmux" ? "surfaceId" : "paneId";
  const originalIdentity = originalHost[identityKey] || originalHost.target;
  const inspectedIdentity = inspected[identityKey] || inspected.target;
  return Boolean(originalIdentity && inspectedIdentity === originalIdentity);
}

async function restartSession(args, dependencies = {}) {
  if (!args.id) throw new Error("--id is required");
  if (args.keepHost && args.explicit?.host) {
    throw new Error("--keep-host and --host are mutually exclusive");
  }
  const store = dependencies.store || new SessionStore(args.stateDir);
  let session = store.get(args.id, { includeSecret: true });
  const originalHost = structuredClone(session.host || {});
  const requestedKind = requestedHostKindForRestart(args, originalHost);
  if (
    args.keepHost
    && (!originalHost.managed || !["cmux", "herdr"].includes(originalHost.kind))
  ) {
    throw new Error("--keep-host can only reuse an open managed cmux or Herdr host");
  }
  if (args.keepHost && (originalHost.closedAt || originalHost.status === "closed")) {
    throw new Error("Cannot keep a host that is already closed");
  }

  const fixedPolicySameHost = (
    !args.explicit?.host
    && requestedKind !== "auto"
    && requestedKind === originalHost.kind
  );
  const preserveOriginalEndpoint = args.keepHost || fixedPolicySameHost;
  const restartArgs = {
    ...args,
    host: args.keepHost ? originalHost.kind : requestedKind,
    hostExecutable: preserveOriginalEndpoint ? originalHost.executable || "" : "",
    hostConnection: preserveOriginalEndpoint ? originalHost.connection || null : null,
    hostTarget: args.hostTarget
      || (fixedPolicySameHost ? originalHost.windowId || "" : ""),
  };

  let hostConfig;
  let host;
  try {
    const injectionProvider = dependencies.restartProvider
      || dependencies.provider
      || createProvider(session.provider, {
        env: dependencies.env || process.env,
        ...(dependencies.providerDependencies || {}),
        identityMode: "require",
        expectedAgentSessionId: session.attachment?.agentSessionId || "",
      });
    injectionProvider.verify();
    const resolvedHost = await preflightSessionHost(
      restartArgs,
      session.provider,
      dependencies,
    );
    hostConfig = resolvedHost.config;
    host = resolvedHost.host;
    if (args.keepHost) {
      const inspection = await host.inspect(originalHost);
      if (!exactReusableHostWasInspected(originalHost, inspection)) {
        throw new Error(
          `Cannot keep ${originalHost.kind} host ${originalHost.target || ""}: `
          + "the exact managed host is missing or its ownership could not be verified",
        );
      }
    }
  } catch (error) {
    store.audit(args.id, "session_restart_preflight_failed", {
      host: requestedKind,
      oldRuntimePreserved: true,
      error: String(error.message || error).slice(0, 2000),
    });
    throw error;
  }
  const hostKind = hostConfig.kind;

  const originalOwnership = runtimeOwnership(session, dependencies);
  if (originalOwnership.alive && originalOwnership.owned === null) {
    store.audit(args.id, "session_restart_ownership_unverified", {
      pid: session.pid,
      reason: originalOwnership.reason,
      oldRuntimePreserved: true,
    });
    throw new Error(
      `Session ${args.id} runtime ownership could not be verified; restart was not attempted`,
    );
  }

  store.update(args.id, (current) => {
    current.status = "stopped";
    current.stoppedAt = new Date().toISOString();
    if (current.host) current.host.keepOpenOnStop = Boolean(args.keepHost);
    return current;
  });
  let restartHostCloseError = null;
  if (
    !args.keepHost
    && originalHost.managed
    && !["process", "foreground"].includes(originalHost.kind)
    && !originalHost.closedAt
  ) {
    try {
      await closeSessionHost(
        store,
        session,
        dependencies.oldSessionHost
          ? { ...dependencies, sessionHost: dependencies.oldSessionHost }
          : dependencies,
      );
    } catch (error) {
      restartHostCloseError = error;
      store.audit(args.id, "runtime_host_close_failed", {
        source: "session_restart",
        error: String(error.message || error).slice(0, 2000),
      });
    }
    try {
      signalRuntimeProcess(
        store.get(args.id, { includeSecret: true }),
        dependencies,
      );
    } catch (signalError) {
      store.audit(args.id, "runtime_signal_failed", {
        reason: restartHostCloseError
          ? "restart_host_close_failed"
          : "restart_host_closed_runtime_alive",
        error: String(signalError.message || signalError).slice(0, 2000),
      });
    }
  } else {
    signalRuntimeProcess(session, dependencies);
  }
  session = await waitForRuntimeStop(
    store,
    args.id,
    dependencies.runtimeStopTimeoutMs || 5_000,
    dependencies,
  );
  const remainingOwnership = runtimeOwnership(session, dependencies);
  if (remainingOwnership.alive && remainingOwnership.owned === true) {
    store.audit(args.id, "session_restart_stop_timed_out", {
      pid: session.pid,
      host: originalHost.kind,
    });
    throw new Error(`Session ${args.id} runtime did not stop; restart was not attempted`);
  }
  if (remainingOwnership.alive && remainingOwnership.owned === null) {
    store.update(args.id, (current) => {
      current.status = "restart_failed";
      return current;
    });
    store.audit(args.id, "session_restart_ownership_unverified", {
      pid: session.pid,
      reason: remainingOwnership.reason,
      oldRuntimePreserved: false,
    });
    throw new Error(
      `Session ${args.id} runtime ownership became indeterminate; restart was not attempted`,
    );
  }
  if (remainingOwnership.alive && remainingOwnership.owned === false) {
    store.audit(args.id, "stale_runtime_pid_ignored", {
      pid: session.pid,
      reason: remainingOwnership.reason,
    });
  }
  session = clearRuntimeStateAfterExit(store, args.id);
  if (restartHostCloseError) {
    store.update(args.id, (current) => {
      current.status = "restart_failed";
      return current;
    });
    throw new Error(
      `Session ${args.id} listener stopped, but its ${originalHost.kind} host could not be closed; restart was not attempted: ${restartHostCloseError.message || restartHostCloseError}`,
    );
  }

  const restartLaunchStartedAt = (dependencies.now || (() => Date.now()))();
  session = store.update(args.id, (current) => {
    current.status = "active";
    current.stoppedAt = null;
    current.pid = null;
    current.runtimeInstanceId = newRuntimeInstanceId();
    current.bridge = { host: "127.0.0.1", port: null, url: null };
    current.restartCount = (current.restartCount || 0) + 1;
    current.lastRestartAt = new Date().toISOString();
    current.timings.runtimeReadinessMs = null;
    current.timings.runtimeReadinessBudgetMs = null;
    current.timings.runtimeReadyAt = null;
    current.timings.firstPollAt = null;
    current.timings.firstPollDurationMs = null;
    current.timings.runtimeReadyToFirstPollMs = null;
    return current;
  });
  session = store.get(args.id, { includeSecret: true });

  let spawned = null;
  let hosted = null;
  try {
    if (hostKind === "process") {
      spawned = spawnRuntime(restartArgs, session, store, dependencies);
      store.update(args.id, (current) => {
        current.pid = spawned.pid;
        current.host = {
          kind: "process",
          requestedKind: originalHost.requestedKind,
          target: String(spawned.pid),
          pid: spawned.pid,
          managed: true,
          createdAt: new Date().toISOString(),
          launchedAt: new Date().toISOString(),
          closedAt: null,
          logPath: spawned.logPath,
          executable: process.execPath,
          source: hostConfig.source,
          status: "launching",
        };
        return current;
      });
    } else if (args.keepHost) {
      const launched = await host.launch(originalHost, {
        command: runtimeLaunchCommand(args.id, store.baseDir, {
          ...providerRuntimeEnvironment(session.provider),
          SLACK_AGENT_SESSION_ID: session.id,
          SLACK_AGENT_TARGET_SESSION_ID: session.attachment?.agentSessionId || "",
        }, session.runtimeInstanceId),
      });
      hosted = {
        ...launched.descriptor,
        requestedKind: originalHost.requestedKind,
        status: "launching",
        closedAt: null,
        keepOpenOnStop: false,
      };
      store.update(args.id, (current) => {
        current.host = hosted;
        return current;
      });
    } else {
      hosted = await launchRuntimeInStandaloneHost({
        args: restartArgs,
        session: store.get(args.id, { includeSecret: true }),
        store,
        host,
        hostConfig,
        now: dependencies.now || (() => Date.now()),
      });
    }
  } catch (error) {
    await failRuntimeLifecycle(store, args.id, {
      status: "restart_failed",
      event: "session_restart_launch_failed",
      error: error.message || error,
      closeHost: false,
    }, dependencies);
    throw error;
  }
  const waitRuntime = dependencies.waitForRuntime || waitForRuntime;
  const readinessMode = hostKind === "process" ? "process" : "standalone";
  const readinessTimeoutMs = runtimeReadinessTimeoutMs(
    store.get(args.id, { includeSecret: true }),
    readinessMode,
    dependencies,
  );
  store.update(args.id, (current) => {
    current.timings.runtimeReadinessBudgetMs = readinessTimeoutMs;
    return current;
  });
  await waitRuntime(
    store,
    args.id,
    readinessTimeoutMs,
  );
  const restartNow = dependencies.now || (() => Date.now());
  const ready = store.update(args.id, (current) => {
    current.timings.runtimeReadinessMs = Math.max(
      0,
      restartNow() - restartLaunchStartedAt,
    );
    if (runtimeIsReady(current) && current.host) {
      current.host.status = "running";
      current.host.requestedKind = requestedKind;
    }
    return current;
  });
  if (!runtimeIsReady(ready)) {
    const readinessError = `Restarted listener did not report runtime and first-poll readiness in ${hostKind}`;
    await failRuntimeLifecycle(store, args.id, {
      status: "restart_failed",
      event: "session_restart_readiness_failed",
      error: readinessError,
      closeHost: !args.keepHost,
    }, dependencies);
    throw new Error(`${readinessError}; session ${args.id} was stopped`);
  }
  store.audit(args.id, "session_restarted", {
    source: "cli",
    host: hostKind,
    requestedHost: requestedKind,
    slackBindingPreserved: true,
  });
  return {
    ok: true,
    mode: hostKind === "process" ? "detached" : "standalone",
    spawned,
    host: ready.host,
    session: ready,
  };
}

async function respond(args, dependencies = {}) {
  if (!args.id) throw new Error("--id is required");
  if (!args.eventId) throw new Error("--event is required");
  if (args.responseStatus === "progress" && responseSources(args).length) {
    throw new Error("--status progress does not accept --message, --message-file, or --stdin");
  }
  const store = dependencies.store || new SessionStore(args.stateDir);
  const session = store.get(args.id, { includeSecret: true });
  if (!dependencies.skipBridge && session.bridge?.url) {
    const ownership = runtimeOwnership(session, dependencies);
    if (!ownership.alive || !ownership.verified || !ownership.owned) {
      store.audit(session.id, "bridge_authentication_refused", {
        reason: ownership.reason,
        runtimeAlive: ownership.alive,
        runtimeOwned: ownership.owned,
        runtimeOwnershipVerified: ownership.verified,
      });
      throw new Error(
        "The session response bridge was not contacted because its exact runtime "
        + `ownership could not be authenticated (${ownership.reason}); `
        + "no direct fallback was attempted",
      );
    }
  }
  const message = await responseMessage(args, dependencies);
  if (args.responseStatus !== "progress" && !String(message || "").trim()) {
    throw new Error("--message, --message-file, or --stdin is required");
  }
  if (!dependencies.skipBridge && session.bridge?.url) {
    try {
      const bridged = await postBridgeResponse(session, message, {
        send: args.send,
        eventId: args.eventId,
        status: args.responseStatus,
      });
      return { ok: true, via: "bridge", result: bridged };
    } catch (error) {
      store.audit(session.id, "bridge_failed", { error: error.message.slice(0, 1000) });
      throw new Error(
        `The session response bridge failed, so no direct fallback was attempted (to avoid a duplicate Slack post): ${error.message}`,
      );
    }
  }
  const slack = createSlackForSession(session, dependencies);
  const runtime = new SessionRuntime({
    store,
    slack,
    provider: dependencies.provider || { verify() {}, inject() {} },
    sessionId: session.id,
    logger: dependencies.logger || console,
  });
  const result = await runtime.respond(message, {
    send: args.send,
    eventId: args.eventId,
    status: args.responseStatus,
  });
  return { ok: true, via: "direct", result };
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const args = parseArgs(argv);
  if (args.action === "help") {
    printHelp(args.helpFor);
    return null;
  }
  if (args.action === "defaults") {
    const defaultsStore = dependencies.defaultsStore || new SessionDefaultsStore(args.stateDir);
    if (args.defaultsAction === "show") {
      return { ok: true, defaults: defaultsStore.show({ env: dependencies.env || process.env }) };
    }
    if (args.defaultsAction === "set") {
      const updated = defaultsStore.set(explicitSessionDefaults(args));
      return {
        ok: true,
        updated,
        defaults: defaultsStore.show({ env: dependencies.env || process.env }),
      };
    }
    if (args.defaultsAction === "reset") {
      const reset = defaultsStore.reset();
      return {
        ok: true,
        reset,
        defaults: defaultsStore.show({ env: dependencies.env || process.env }),
      };
    }
    throw new Error(`Unknown session defaults action: ${args.defaultsAction}`);
  }
  if (args.action === "start") {
    applySessionDefaults(args, dependencies.env || process.env);
    return startSession(args, dependencies);
  }
  if (args.action === "run") return runSession(args, dependencies);
  if (args.action === "restart") return restartSession(args, dependencies);
  if (args.action === "respond") return respond(args, dependencies);

  const store = dependencies.store || new SessionStore(args.stateDir);
  if (args.action === "list") {
    const sessions = store.list({ includeStopped: true }).map((session) => (
      sessionWithRuntimeHealth(
        session,
        store.get(session.id, { includeSecret: true }),
        dependencies,
      )
    ));
    return {
      ok: true,
      sessions: args.activeOnly
        ? sessions.filter((session) => (
          session.configuredActive
          && session.runtimeAlive
          && session.runtimeOwned === true
        ))
        : sessions,
    };
  }
  if (args.action === "show" || args.action === "status") {
    if (!args.id) throw new Error("--id is required");
    const inspectedSession = store.get(args.id, { includeSecret: true });
    const session = sessionWithRuntimeHealth(
      store.get(args.id),
      inspectedSession,
      dependencies,
    );
    return {
      ok: true,
      session,
      events: store.readEvents(args.id, args.limit),
      hostStatus: args.verbose
        ? await inspectRuntimeHost(inspectedSession, dependencies)
        : undefined,
    };
  }
  if (args.action === "events") {
    if (!args.id) throw new Error("--id is required");
    return { ok: true, events: store.readEvents(args.id, args.limit) };
  }
  if (args.action === "stop") {
    if (!args.id) throw new Error("--id is required");
    const before = store.get(args.id, { includeSecret: true });
    const ownershipBeforeStop = runtimeOwnership(before, dependencies);
    store.update(args.id, (current) => {
      current.status = "stopped";
      current.stoppedAt = new Date().toISOString();
      if (current.host) current.host.keepOpenOnStop = Boolean(args.keepHost);
      return current;
    });
    if (args.keepHost || before.host?.kind === "process") {
      signalRuntimeProcess(before, dependencies);
    }
    let host;
    if (args.keepHost) {
      host = {
        ok: true,
        closed: false,
        reason: "keep_host_requested",
        descriptor: publicHostDescriptor(before.host),
      };
    } else {
      try {
        host = await closeSessionHost(store, before, dependencies);
      } catch (error) {
        store.audit(args.id, "runtime_host_close_failed", {
          source: "cli_stop",
          error: String(error.message || error).slice(0, 2000),
        });
        host = {
          ok: false,
          closed: false,
          reason: "host_close_failed",
          error: String(error.message || error),
          signalled: false,
          descriptor: publicHostDescriptor(before.host),
        };
      }
    }
    if (!args.keepHost && before.host?.kind !== "process") {
      try {
        const signalled = signalRuntimeProcess(
          store.get(args.id, { includeSecret: true }),
          dependencies,
        );
        if (host.ok === false) host.signalled = signalled;
      } catch (signalError) {
        store.audit(args.id, "runtime_signal_failed", {
          reason: host.ok === false ? "host_close_failed" : "host_closed_runtime_alive",
          error: String(signalError.message || signalError).slice(0, 2000),
        });
      }
    }
    let stopped = await waitForRuntimeStop(
      store,
      args.id,
      dependencies.runtimeStopTimeoutMs || 5_000,
      dependencies,
    );
    const remainingOwnership = runtimeOwnership(stopped, dependencies);
    const stopPending = (
      remainingOwnership.alive
      && (remainingOwnership.owned === true || remainingOwnership.owned === null)
    );
    if (!stopPending) {
      if (remainingOwnership.alive && remainingOwnership.owned === false) {
        store.audit(args.id, "stale_runtime_pid_ignored", {
          pid: stopped.pid,
          reason: remainingOwnership.reason,
        });
      }
      stopped = clearRuntimeStateAfterExit(store, args.id);
    } else if (remainingOwnership.owned === null) {
      store.audit(args.id, "runtime_stop_ownership_unverified", {
        pid: stopped.pid,
        reason: remainingOwnership.reason,
      });
    }
    store.audit(args.id, "session_stop", {
      source: "cli",
      hostClosed: Boolean(host.closed),
      keepHost: args.keepHost,
      stopPending,
    });
    const publicStopped = store.get(args.id);
    if (host?.descriptor) {
      host = {
        ...host,
        descriptor: publicStopped.host,
      };
    }
    return {
      ok: !stopPending && host.ok !== false,
      session: publicStopped,
      host,
      stopPending,
      error: stopPending
        ? remainingOwnership.owned === null
          ? "Listener process ownership could not be verified; no signal was sent"
          : "Listener process did not stop before the timeout"
        : host.ok === false
          ? host.error
          : null,
      runtimeOwnership: {
        before: ownershipBeforeStop.owned,
        after: remainingOwnership.owned,
        reason: remainingOwnership.reason,
      },
    };
  }
  if (args.action === "pause" || args.action === "resume") {
    if (!args.id) throw new Error("--id is required");
    const session = store.update(args.id, (current) => {
      if (args.action === "pause" && current.status === "active") current.status = "paused";
      if (args.action === "resume" && current.status === "paused") current.status = "active";
      return current;
    });
    store.audit(args.id, `session_${args.action}`, { source: "cli" });
    return { ok: true, session };
  }
  if (args.action === "approve" || args.action === "reject") {
    if (!args.id || !args.eventId) throw new Error("--id and --event are required");
    const session = store.get(args.id, { includeSecret: true });
    const runtime = createRuntimeForSession(store, session, dependencies);
    const result = args.action === "approve"
      ? await runtime.approve(args.eventId)
      : runtime.reject(args.eventId);
    return { ok: true, result, session: store.get(args.id) };
  }
  if (args.action === "doctor") {
    const defaults = applySessionDefaults(args, dependencies.env || process.env);
    const env = dependencies.env || process.env;
    const inspection = inspectProviders(env);
    let providerConfig = null;
    let providerVerification = null;
    let providerError = null;
    let hostConfig = null;
    let hostError = null;
    try {
      providerConfig = resolveProviderConfig({
        name: args.provider,
        target: args.target,
        env,
      });
      const provider = dependencies.provider || createProvider(providerConfig, {
        env,
        ...(dependencies.providerDependencies || {}),
      });
      const verified = provider.verify();
      providerVerification = {
        ok: verified?.ok !== false,
        name: verified?.name || providerConfig.name,
        target: verified?.target || providerConfig.target,
      };
      providerConfig.target = providerVerification.target;
      args.effective.provider.resolved = providerConfig.name;
      args.effective.provider.target = providerConfig.target;
    } catch (error) {
      providerError = String(error.message || error);
    }
    if (providerConfig && !providerError) {
      try {
        const resolvedHost = await preflightSessionHost(
          args,
          providerConfig,
          dependencies,
        );
        hostConfig = resolvedHost.config;
        args.effective.host.resolved = hostConfig.kind;
        args.effective.host.executable = hostConfig.executable;
        args.effective.host.resolutionSource = hostConfig.source;
      } catch (error) {
        hostError = String(error.message || error);
      }
    }
    const cmuxSocketMode = String(env.CMUX_SOCKET_MODE || "")
      .toLowerCase()
      .replaceAll(/[-_]/g, "");
    const detachedIssue = providerConfig?.name === "cmux"
      && hostConfig?.kind !== "cmux"
      && cmuxSocketMode !== "allowall";
    const detachedDiagnosis = detachedIssue
      ? "Listeners hosted outside cmux cannot reconnect with the current socket mode."
      : null;
    const detachedGuidance = detachedIssue
      ? "Set CMUX_SOCKET_MODE=allowAll before `slack-api session start`, use --host cmux, or use --foreground from a separate cmux surface."
      : null;
    const diagnosis = providerError || hostError || detachedDiagnosis;
    return {
      ok: !diagnosis,
      sessionDirectory: store.baseDir,
      providerOrder: ["cmux", "herdr", "tmux"],
      defaults: defaults.defaultsStore.show({ env: dependencies.env || process.env }),
      effective: args.effective,
      provider: publicProviderDescriptor(providerConfig),
      providerVerification,
      providerError,
      host: publicHostDescriptor(hostConfig),
      hostError,
      ...inspection,
      diagnosis,
      guidance: providerError
        ? providerError
        : hostError
          ? hostError
          : detachedGuidance
            || `Verified target ${providerConfig.name}:${providerConfig.target}; listener host ${hostConfig.kind}.`,
    };
  }
  throw new Error(`Unknown session action: ${args.action}`);
}

if (require.main === module) {
  main().then((output) => {
    if (output) {
      console.log(JSON.stringify(output, null, 2));
      if (output.ok === false) process.exitCode = 1;
    }
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  applySessionDefaults,
  closeSessionHost,
  createRuntimeForSession,
  createSlackForSession,
  detectAgentAttachment,
  explicitSessionDefaults,
  inspectRuntimeHost,
  launchRuntimeInStandaloneHost,
  main,
  parseArgs,
  preflightSessionHost,
  readAll,
  restartSession,
  respond,
  responseMessage,
  runtimeHealth,
  runtimeLaunchCommand,
  runtimeOwnership,
  runtimeReadinessTimeoutMs,
  runtimeIsReady,
  shellQuote,
  slackConfig,
  spawnRuntime,
  startVerification,
  startSession,
  waitForRuntime,
};
