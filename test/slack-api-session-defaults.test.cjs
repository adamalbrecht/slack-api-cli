const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  BUILT_IN_SESSION_DEFAULTS,
  SESSION_DEFAULT_ENV,
  SESSION_DEFAULTS_VERSION,
  SessionDefaultsStore,
  resetSessionDefaults,
  resolveSessionDefaults,
  sessionDefaultsFromEnvironment,
  setSessionDefaults,
  showSessionDefaults,
  validateSessionDefaults,
} = require("../slack-api-session-defaults.cjs");

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "slack-session-defaults-"));
}

test("missing defaults file resolves all safe built-ins", () => {
  const directory = path.join(temporaryDirectory(), "sessions");
  const store = new SessionDefaultsStore(directory);
  const shown = store.show({ env: {} });

  assert.equal(shown.version, SESSION_DEFAULTS_VERSION);
  assert.equal(shown.path, path.join(directory, "defaults.json"));
  assert.deepEqual(shown.saved, {});
  assert.deepEqual(shown.effective, BUILT_IN_SESSION_DEFAULTS);
  assert.deepEqual(
    Object.fromEntries(Object.entries(shown.sources).map(([key, source]) => [key, source.kind])),
    {
      channel: "built-in",
      sendResponses: "built-in",
      provider: "built-in",
      pollSeconds: "built-in",
      headless: "built-in",
      host: "built-in",
    },
  );
  assert.equal(fs.existsSync(shown.path), false);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
});

test("set writes a private versioned file atomically and normalizes values", () => {
  const directory = temporaryDirectory();
  fs.chmodSync(directory, 0o755);
  const store = new SessionDefaultsStore(directory);
  const written = store.set({
    channel: "  #Agent-Sessions  ",
    sendResponses: true,
    provider: "CMUX",
    pollSeconds: 4,
    headless: false,
    host: "HERDR",
  });

  assert.deepEqual(written, {
    version: SESSION_DEFAULTS_VERSION,
    defaults: {
      channel: "#Agent-Sessions",
      sendResponses: true,
      provider: "cmux",
      pollSeconds: 4,
      headless: false,
      host: "herdr",
    },
  });
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(store.defaultsPath).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(store.defaultsPath, "utf8")), written);
  assert.deepEqual(
    fs.readdirSync(directory).filter((name) => name.includes(".tmp")),
    [],
  );
});

test("set merges updates while show reports saved and built-in sources", () => {
  const store = new SessionDefaultsStore(temporaryDirectory());
  store.set({ channel: "me", sendResponses: true });
  store.set({ pollSeconds: 8 });
  const shown = store.show({ env: {} });

  assert.deepEqual(shown.saved, {
    channel: "me",
    sendResponses: true,
    pollSeconds: 8,
  });
  assert.deepEqual(shown.effective, {
    channel: "me",
    sendResponses: true,
    provider: "auto",
    pollSeconds: 8,
    headless: true,
    host: "process",
  });
  assert.equal(shown.sources.channel.kind, "saved");
  assert.equal(shown.sources.sendResponses.kind, "saved");
  assert.equal(shown.sources.provider.kind, "built-in");
  assert.equal(shown.sources.pollSeconds.kind, "saved");
});

test("resolver applies explicit over environment over saved over built-in", () => {
  const resolved = resolveSessionDefaults({
    explicit: {
      channel: "C_EXPLICIT",
      headless: false,
    },
    env: {
      SLACK_API_SESSION_CHANNEL: "C_ENV",
      SLACK_API_SESSION_SEND_RESPONSES: "yes",
      SLACK_API_SESSION_HEADLESS: "true",
    },
    saved: {
      channel: "C_SAVED",
      sendResponses: false,
      provider: "herdr",
      host: "auto",
    },
  });

  assert.deepEqual(resolved.values, {
    channel: "C_EXPLICIT",
    sendResponses: true,
    provider: "herdr",
    pollSeconds: 3,
    headless: false,
    host: "auto",
  });
  assert.deepEqual(resolved.sources, {
    channel: { kind: "explicit" },
    sendResponses: {
      kind: "environment",
      variable: "SLACK_API_SESSION_SEND_RESPONSES",
    },
    provider: { kind: "saved" },
    pollSeconds: { kind: "built-in" },
    headless: { kind: "explicit" },
    host: { kind: "saved" },
  });
});

test("every environment override is parsed and identifies its variable", () => {
  const env = {
    SLACK_API_SESSION_CHANNEL: " D123 ",
    SLACK_API_SESSION_SEND_RESPONSES: "ON",
    SLACK_API_SESSION_PROVIDER: "TMUX",
    SLACK_API_SESSION_POLL_SECONDS: "9",
    SLACK_API_SESSION_HEADLESS: "0",
    SLACK_API_SESSION_HOST: "CMUX",
  };
  const parsed = sessionDefaultsFromEnvironment(env);
  const resolved = resolveSessionDefaults({ env });

  assert.deepEqual(parsed, {
    channel: "D123",
    sendResponses: true,
    provider: "tmux",
    pollSeconds: 9,
    headless: false,
    host: "cmux",
  });
  assert.deepEqual(resolved.values, parsed);
  for (const [key, variable] of Object.entries(SESSION_DEFAULT_ENV)) {
    assert.deepEqual(resolved.sources[key], { kind: "environment", variable });
  }
});

test("boolean environment overrides accept explicit true and false spellings", () => {
  for (const value of ["1", "true", "TRUE", "yes", "on"]) {
    assert.equal(sessionDefaultsFromEnvironment({
      SLACK_API_SESSION_SEND_RESPONSES: value,
    }).sendResponses, true);
  }
  for (const value of ["0", "false", "FALSE", "no", "off"]) {
    assert.equal(sessionDefaultsFromEnvironment({
      SLACK_API_SESSION_HEADLESS: value,
    }).headless, false);
  }
});

test("legacy SLACK_HEADLESS remains an environment override for session auth", () => {
  const legacy = resolveSessionDefaults({ env: { SLACK_HEADLESS: "0" } });
  assert.equal(legacy.values.headless, false);
  assert.deepEqual(legacy.sources.headless, {
    kind: "environment",
    variable: "SLACK_HEADLESS",
  });

  const canonical = resolveSessionDefaults({
    env: {
      SLACK_HEADLESS: "0",
      SLACK_API_SESSION_HEADLESS: "1",
    },
  });
  assert.equal(canonical.values.headless, true);
  assert.equal(canonical.sources.headless.variable, "SLACK_API_SESSION_HEADLESS");
});

test("invalid environment overrides fail instead of silently falling back", () => {
  const cases = [
    ["SLACK_API_SESSION_CHANNEL", ""],
    ["SLACK_API_SESSION_SEND_RESPONSES", "sometimes"],
    ["SLACK_API_SESSION_PROVIDER", "screen"],
    ["SLACK_API_SESSION_POLL_SECONDS", "1.5"],
    ["SLACK_API_SESSION_HEADLESS", ""],
    ["SLACK_API_SESSION_HOST", "tmux"],
  ];
  for (const [variable, value] of cases) {
    assert.throws(
      () => sessionDefaultsFromEnvironment({ [variable]: value }),
      new RegExp(variable),
    );
  }
});

test("saved and explicit values are strictly validated", () => {
  const invalid = [
    [{ unknown: true }, /Unknown session default/],
    [{ channel: "" }, /channel must not be empty/],
    [{ channel: "line one\nline two" }, /single line/],
    [{ sendResponses: "true" }, /sendResponses must be a boolean/],
    [{ provider: "screen" }, /provider must be one of/],
    [{ pollSeconds: 0 }, /pollSeconds must be a positive integer/],
    [{ pollSeconds: 1.5 }, /pollSeconds must be a positive integer/],
    [{ headless: 1 }, /headless must be a boolean/],
    [{ host: "tmux" }, /host must be one of/],
  ];
  for (const [values, pattern] of invalid) {
    assert.throws(
      () => validateSessionDefaults(values, { source: "test defaults" }),
      pattern,
    );
    assert.throws(
      () => resolveSessionDefaults({ explicit: values, env: {} }),
      pattern,
    );
  }
});

test("malformed, unsupported, and unknown saved documents fail clearly", () => {
  const cases = [
    ["{", /not valid JSON/],
    [JSON.stringify({ version: 99, defaults: {} }), /Unsupported session defaults schema/],
    [JSON.stringify({ version: 1 }), /missing the defaults object/],
    [JSON.stringify({ version: 1, defaults: [], extra: true }), /Unknown fields/],
    [JSON.stringify({ version: 1, defaults: { pollSeconds: "3" } }), /pollSeconds must be a positive integer/],
  ];

  for (const [contents, pattern] of cases) {
    const store = new SessionDefaultsStore(temporaryDirectory());
    fs.writeFileSync(store.defaultsPath, contents, { mode: 0o644 });
    assert.throws(() => store.readDocument(), pattern);
  }
});

test("reset removes selected values and reset-all restores missing-file compatibility", () => {
  const store = new SessionDefaultsStore(temporaryDirectory());
  store.set({
    channel: "C1",
    sendResponses: true,
    provider: "cmux",
  });

  const partial = store.reset(["channel", "provider", "channel"]);
  assert.deepEqual(partial.defaults, { sendResponses: true });
  assert.equal(fs.existsSync(store.defaultsPath), true);
  assert.deepEqual(store.show({ env: {} }).effective, {
    channel: "me",
    sendResponses: true,
    provider: "auto",
    pollSeconds: 3,
    headless: true,
    host: "process",
  });

  const empty = store.reset();
  assert.deepEqual(empty, { version: SESSION_DEFAULTS_VERSION, defaults: {} });
  assert.equal(fs.existsSync(store.defaultsPath), false);
  assert.deepEqual(store.reset(), empty);
  assert.throws(() => store.reset([]), /non-empty/);
  assert.throws(() => store.reset("unknown"), /Unknown session default/);
});

test("convenience set, show, and reset primitives share the same store contract", () => {
  const directory = temporaryDirectory();
  setSessionDefaults(directory, { host: "auto", pollSeconds: 6 });
  const shown = showSessionDefaults(directory, {
    env: { SLACK_API_SESSION_PROVIDER: "cmux" },
  });

  assert.equal(shown.saved.host, "auto");
  assert.equal(shown.effective.provider, "cmux");
  assert.equal(shown.sources.provider.variable, "SLACK_API_SESSION_PROVIDER");
  resetSessionDefaults(directory, "host");
  assert.equal(showSessionDefaults(directory, { env: {} }).effective.host, "process");
  resetSessionDefaults(directory);
  assert.equal(fs.existsSync(path.join(directory, "defaults.json")), false);
});

test("undefined explicit values are treated as absent and returned values are independent", () => {
  const resolved = resolveSessionDefaults({
    explicit: { channel: undefined },
    env: {},
  });
  resolved.values.channel = "changed";
  resolved.sources.channel.kind = "changed";

  assert.equal(BUILT_IN_SESSION_DEFAULTS.channel, "me");
  const next = resolveSessionDefaults({ env: {} });
  assert.equal(next.values.channel, "me");
  assert.equal(next.sources.channel.kind, "built-in");
});
