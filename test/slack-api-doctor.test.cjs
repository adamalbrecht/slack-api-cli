const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  classifySlackFailure,
  exitCodeForReport,
  formatHumanReport,
  parseArgs,
  runDoctor,
} = require("../slack-api-doctor.cjs");
const { ensurePrivateDirectory } = require("../slack-api-common.cjs");

const REPO_ROOT = path.resolve(__dirname, "..");

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "slack-api-doctor-"));
  const configDir = path.join(root, "config");
  const dataDir = path.join(root, "data");
  const profile = path.join(dataDir, "browser-profile");
  const authCache = path.join(dataDir, "auth.json");
  const config = path.join(configDir, "config.json");
  const binDir = path.join(root, "bin");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(profile, { recursive: true });
  fs.chmodSync(profile, 0o700);
  fs.mkdirSync(binDir, { recursive: true });
  fs.symlinkSync(path.join(REPO_ROOT, "slack-api.cjs"), path.join(binDir, "slack-api"));
  fs.writeFileSync(config, JSON.stringify({
    workspace: "https://example.slack.com",
    teamId: "T123",
    profile,
    authCache,
  }), { mode: 0o600 });
  fs.writeFileSync(authCache, JSON.stringify({
    workspace: "https://example.slack.com",
    token: "secret-token-never-print",
    cookieHeader: "secret-cookie-never-print",
    cachedAt: "2026-08-22T12:00:00.000Z",
  }), { mode: 0o600 });
  const env = {
    PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
    SLACK_API_CONFIG: config,
    SLACK_API_DATA_DIR: dataDir,
  };
  return { root, config, dataDir, profile, authCache, env };
}

function fakeCommon(calls) {
  return {
    loadPlaywright: () => ({ chromium: { executablePath: () => "" } }),
    loadAuth: async () => ({ source: "cache" }),
    slackApiCall: async (_args, method) => {
      calls.push(method);
      if (method === "auth.test") {
        return { response: { status: 200 }, json: { ok: true, user: "alex", user_id: "U123", team_id: "T123" } };
      }
      if (method === "users.info") {
        return {
          response: { status: 200 },
          json: { ok: true, user: { id: "U123", team_id: "T123", name: "alex" } },
        };
      }
      if (method === "users.counts") {
        return { response: { status: 200 }, json: { ok: true, channels: [{ id: "C1", unread_count: 1 }] } };
      }
      if (method === "users.prefs.get") {
        return {
          response: { status: 200 },
          json: {
            ok: true,
            prefs: {
              all_notifications_prefs: JSON.stringify({ channels: { C1: { muted: true } } }),
            },
          },
        };
      }
      assert.equal(method, "conversations.list");
      return { response: { status: 200 }, json: { ok: true, channels: [] } };
    },
  };
}

test("doctor runs the complete read-only API audit and produces a healthy agent report", async (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const calls = [];
  const args = parseArgs(["--json", "--no-session"], {
    env: fixture.env,
    homeDirectory: fixture.root,
  });
  const report = await runDoctor(args, {
    env: fixture.env,
    homeDirectory: fixture.root,
    common: fakeCommon(calls),
    extractMutedConversationIds: (prefs) => {
      assert.equal(typeof prefs.all_notifications_prefs, "string");
      return { mutedConversationIds: new Set(["C1"]), sources: ["all_notifications_prefs"] };
    },
    now: () => Date.parse("2026-08-22T13:00:00.000Z"),
  });

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.ok, true);
  assert.equal(report.strictSatisfied, true);
  assert.equal(report.exitCode, 0);
  assert.equal(report.status, "healthy");
  assert.deepEqual(calls, [
    "auth.test",
    "users.info",
    "users.counts",
    "users.prefs.get",
    "conversations.list",
  ]);
  assert.deepEqual(report.safety, {
    localMutation: false,
    slackMutation: false,
    browserLaunched: false,
    messageContentRead: false,
  });
  assert.equal(report.checks.find((check) => check.id === "api.notification_preferences").details.mutedConversations, 1);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes("secret-token-never-print"), false);
  assert.equal(serialized.includes("secret-cookie-never-print"), false);
  assert.equal(exitCodeForReport(report), 0);
});

test("offline doctor skips Slack probes without loading auth", async (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  let authLoads = 0;
  const args = parseArgs(["--offline", "--no-session"], {
    env: fixture.env,
    homeDirectory: fixture.root,
  });
  const report = await runDoctor(args, {
    env: fixture.env,
    homeDirectory: fixture.root,
    common: {
      loadPlaywright: () => ({ chromium: { executablePath: () => "" } }),
      loadAuth: async () => { authLoads += 1; },
    },
  });

  assert.equal(authLoads, 0);
  assert.equal(report.ok, true);
  assert.equal(report.checks.filter((check) => check.category === "slack-api").length, 7);
  assert.equal(report.checks.filter((check) => check.category === "slack-api").every((check) => check.status === "skip"), true);
});

test("session audit does not create missing storage", async (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const sessionDirectory = path.join(fixture.dataDir, "sessions");
  assert.equal(fs.existsSync(sessionDirectory), false);
  const args = parseArgs(["--offline"], {
    env: fixture.env,
    homeDirectory: fixture.root,
  });
  const report = await runDoctor(args, {
    env: fixture.env,
    homeDirectory: fixture.root,
    common: { loadPlaywright: () => ({ chromium: { executablePath: () => "" } }) },
    inspectProviders: () => ({
      detected: null,
      installed: { tmux: false, cmux: false, herdr: false },
      executables: { tmux: null, cmux: null, herdr: null },
      contexts: { tmux: false, cmux: false, herdr: false },
      detachedListener: { ready: true, issue: null, remediation: null },
    }),
  });

  assert.equal(fs.existsSync(sessionDirectory), false);
  assert.equal(report.checks.find((check) => check.id === "session.storage").status, "pass");
  assert.equal(report.checks.find((check) => check.id === "session.providers").status, "warn");
  assert.equal(report.safety.localMutation, false);
});

test("doctor fails insecure credential permissions and strict mode fails warnings", async (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.chmodSync(fixture.authCache, 0o644);
  const args = parseArgs(["--offline", "--no-session"], {
    env: fixture.env,
    homeDirectory: fixture.root,
  });
  const report = await runDoctor(args, {
    env: fixture.env,
    homeDirectory: fixture.root,
    common: { loadPlaywright: () => ({ chromium: { executablePath: () => "" } }) },
  });

  const permissionCheck = report.checks.find((check) => check.id === "auth.permissions");
  assert.equal(permissionCheck.status, "fail");
  assert.match(permissionCheck.remediation, /chmod 600/);
  assert.equal(report.status, "unhealthy");
  assert.equal(exitCodeForReport(report), 1);

  const warningOnly = {
    strict: true,
    summary: { passed: 1, warnings: 1, failed: 0, skipped: 0 },
  };
  assert.equal(exitCodeForReport(warningOnly), 1);
  assert.equal(exitCodeForReport({ ...warningOnly, strict: false }), 0);
});

test("doctor reports structurally invalid JSON documents instead of crashing", async (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.writeFileSync(fixture.config, "null\n", { mode: 0o600 });
  fs.writeFileSync(fixture.authCache, "null\n", { mode: 0o600 });
  const args = parseArgs(["--offline", "--no-session"], {
    env: fixture.env,
    homeDirectory: fixture.root,
  });
  const report = await runDoctor(args, {
    env: fixture.env,
    homeDirectory: fixture.root,
    common: { loadPlaywright: () => ({ chromium: { executablePath: () => "" } }) },
  });

  assert.equal(report.status, "unhealthy");
  assert.equal(report.checks.find((check) => check.id === "config.file").status, "fail");
  assert.equal(report.checks.find((check) => check.id === "auth.cache").status, "fail");
  assert.equal(report.checks.find((check) => check.id === "config.permissions").status, "pass");
  assert.equal(report.checks.find((check) => check.id === "auth.permissions").status, "pass");
});

test("doctor attributes a preference parsing failure and continues independent probes", async (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const calls = [];
  const args = parseArgs(["--no-session"], {
    env: fixture.env,
    homeDirectory: fixture.root,
  });
  const report = await runDoctor(args, {
    env: fixture.env,
    homeDirectory: fixture.root,
    common: fakeCommon(calls),
    extractMutedConversationIds: () => { throw new Error("invalid_all_notifications_prefs"); },
  });

  assert.equal(report.checks.find((check) => check.id === "api.auth").status, "pass");
  assert.equal(report.checks.find((check) => check.id === "api.unread_counts").status, "pass");
  assert.equal(report.checks.find((check) => check.id === "api.notification_preferences").status, "fail");
  assert.equal(report.checks.find((check) => check.id === "api.conversations").status, "pass");
  assert.deepEqual(calls, ["auth.test", "users.info", "users.counts", "users.prefs.get", "conversations.list"]);
});

test("argument validation and human formatting are deterministic", () => {
  assert.throws(() => parseArgs(["--refresh-auth"]), /read-only/);
  assert.throws(() => parseArgs(["--timeout-ms", "10"]), /at least 1000/);
  assert.throws(() => parseArgs(["--max-deep-conversations", "0"]), /positive integer/);

  const report = {
    status: "degraded",
    summary: { passed: 1, warnings: 1, failed: 0, skipped: 0 },
    checks: [
      { id: "one", status: "pass", summary: "works" },
      { id: "two", status: "warn", summary: "needs attention", remediation: "Fix it." },
    ],
  };
  const formatted = formatHumanReport(report);
  assert.match(formatted, /Slack API CLI doctor: DEGRADED/);
  assert.match(formatted, /\[PASS\] one: works/);
  assert.match(formatted, /Fix: Fix it\./);
});

test("doctor classifies enterprise policy failures and still runs unrelated probes", async (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const calls = [];
  const common = fakeCommon(calls);
  const baseCall = common.slackApiCall;
  common.slackApiCall = async (args, method, params) => {
    if (method === "users.counts") {
      calls.push(method);
      return {
        response: { status: 200 },
        json: { ok: false, error: "enterprise_is_restricted" },
      };
    }
    return baseCall(args, method, params);
  };

  const report = await runDoctor(parseArgs(["--no-session"], {
    env: fixture.env,
    homeDirectory: fixture.root,
  }), {
    env: fixture.env,
    homeDirectory: fixture.root,
    common,
  });

  const unread = report.checks.find((check) => check.id === "api.unread_counts");
  assert.equal(unread.status, "fail");
  assert.deepEqual(unread.diagnostic, {
    classification: "enterprise_policy",
    retryable: false,
    requiresAdmin: true,
    action: "contact_workspace_admin",
    rawError: "enterprise_is_restricted",
  });
  assert.equal(report.checks.find((check) => check.id === "api.notification_preferences").status, "pass");
  assert.equal(report.checks.find((check) => check.id === "api.conversations").status, "pass");
  assert.deepEqual(calls, ["auth.test", "users.info", "users.counts", "users.prefs.get", "conversations.list"]);
});

test("doctor reports Enterprise routing and restricted account context", async (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.writeFileSync(fixture.config, JSON.stringify({
    workspace: "https://example.slack.com",
    profile: fixture.profile,
    authCache: fixture.authCache,
  }), { mode: 0o600 });
  const calls = [];
  const common = fakeCommon(calls);
  const baseCall = common.slackApiCall;
  common.slackApiCall = async (args, method, params) => {
    if (method === "auth.test") {
      calls.push(method);
      return {
        response: { status: 200 },
        json: {
          ok: true,
          user: "alex",
          user_id: "U123",
          team_id: "T123",
          enterprise_id: "E123",
          is_enterprise_install: true,
        },
      };
    }
    if (method === "users.info") {
      calls.push(method);
      return {
        response: { status: 200 },
        json: { ok: true, user: { id: "U123", team_id: "T123", is_restricted: true } },
      };
    }
    return baseCall(args, method, params);
  };

  const report = await runDoctor(parseArgs(["--no-session"], {
    env: fixture.env,
    homeDirectory: fixture.root,
  }), {
    env: fixture.env,
    homeDirectory: fixture.root,
    common,
  });

  const enterprise = report.checks.find((check) => check.id === "api.enterprise");
  const user = report.checks.find((check) => check.id === "api.current_user");
  assert.equal(enterprise.status, "warn");
  assert.equal(enterprise.details.enterpriseId, "E123");
  assert.equal(enterprise.diagnostic.classification, "enterprise_routing");
  assert.equal(user.status, "warn");
  assert.equal(user.details.isRestricted, true);
  assert.equal(user.diagnostic.classification, "account_restriction");
  assert.equal(report.capabilities.find((capability) => capability.id === "enterprise_routing").status, "degraded");
});

test("deep doctor finds unresolved unread metadata without reading messages", async (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const calls = [];
  const common = fakeCommon(calls);
  const baseCall = common.slackApiCall;
  common.slackApiCall = async (args, method, params) => {
    if (method === "users.counts") {
      calls.push(method);
      return {
        response: { status: 200 },
        json: {
          ok: true,
          channels: {
            C1: { unread_count: 2 },
            C2: { unread_count_display: 1 },
          },
          ims: {},
          mpims: {},
        },
      };
    }
    if (method === "users.prefs.get") {
      calls.push(method);
      return {
        response: { status: 200 },
        json: {
          ok: true,
          prefs: { all_notifications_prefs: JSON.stringify({ channels: { C2: { muted: true } } }) },
        },
      };
    }
    if (method === "conversations.info") {
      calls.push(`${method}:${params.channel}`);
      if (params.channel === "C2") {
        return { response: { status: 200 }, json: { ok: false, error: "channel_not_found" } };
      }
      return {
        response: { status: 200 },
        json: { ok: true, channel: { id: "C1", is_ext_shared: true } },
      };
    }
    return baseCall(args, method, params);
  };

  const report = await runDoctor(parseArgs(["--deep", "--strict", "--no-session"], {
    env: fixture.env,
    homeDirectory: fixture.root,
  }), {
    env: fixture.env,
    homeDirectory: fixture.root,
    common,
  });

  const coverage = report.checks.find((check) => check.id === "api.unread_coverage");
  assert.equal(coverage.status, "warn");
  assert.equal(coverage.details.positiveUnreadConversations, 2);
  assert.equal(coverage.details.resolvedConversations, 1);
  assert.equal(coverage.details.externallySharedConversations, 1);
  assert.equal(coverage.details.unresolvedConversations[0].channelId, "C2");
  assert.equal(coverage.diagnostic.classification, "resource_visibility");
  assert.equal(calls.some((method) => /history|replies|search/.test(method)), false);
  assert.equal(report.safety.messageContentRead, false);
  assert.equal(report.ok, true);
  assert.equal(report.strictSatisfied, false);
  assert.equal(report.exitCode, 1);
  assert.equal(exitCodeForReport(report), 1);
});

test("successful Slack warnings degrade the corresponding capability", async (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const calls = [];
  const common = fakeCommon(calls);
  const baseCall = common.slackApiCall;
  common.slackApiCall = async (args, method, params) => {
    if (method === "conversations.list") {
      calls.push(method);
      return {
        response: {
          status: 200,
          headers: { "x-slack-req-id": "req-123" },
        },
        json: { ok: true, channels: [], warning: "partial_results" },
      };
    }
    return baseCall(args, method, params);
  };

  const report = await runDoctor(parseArgs(["--no-session"], {
    env: fixture.env,
    homeDirectory: fixture.root,
  }), {
    env: fixture.env,
    homeDirectory: fixture.root,
    common,
  });

  const conversations = report.checks.find((check) => check.id === "api.conversations");
  assert.equal(conversations.status, "warn");
  assert.deepEqual(conversations.details.warnings, ["partial_results"]);
  assert.equal(conversations.details.requestId, "req-123");
  assert.equal(report.capabilities.find((capability) => capability.id === "conversation_resolution").status, "degraded");
  assert.equal(report.strictSatisfied, true);
  assert.equal(report.exitCode, 0);
});

test("Slack error classifier distinguishes rate limits and corporate network policy", () => {
  const rateLimited = Object.assign(new Error("ratelimited"), { slackError: "ratelimited" });
  assert.deepEqual(classifySlackFailure(rateLimited), {
    classification: "rate_limit",
    retryable: true,
    requiresAdmin: false,
    action: "retry_after_delay",
    rawError: "ratelimited",
    remediation: "Wait for the reported Retry-After interval, then rerun doctor.",
  });
  assert.equal(classifySlackFailure(new Error("TLS certificate rejected by proxy")).classification, "network_policy");
});

test("browser auth preparation repairs profile directory permissions", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "slack-api-profile-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = path.join(root, "browser-profile");
  fs.mkdirSync(profile, { mode: 0o755 });

  await ensurePrivateDirectory(profile);

  assert.equal(fs.statSync(profile).mode & 0o777, 0o700);
});
