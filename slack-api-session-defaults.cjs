const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SESSION_DEFAULTS_VERSION = 1;
const SESSION_DEFAULTS_FILENAME = "defaults.json";
const SESSION_DEFAULT_KEYS = Object.freeze([
  "channel",
  "sendResponses",
  "provider",
  "pollSeconds",
  "headless",
  "host",
]);
const SESSION_PROVIDERS = Object.freeze(["auto", "tmux", "cmux", "herdr", "stdio"]);
const SESSION_HOSTS = Object.freeze(["auto", "cmux", "herdr", "process"]);
const SESSION_DEFAULT_ENV = Object.freeze({
  channel: "SLACK_API_SESSION_CHANNEL",
  sendResponses: "SLACK_API_SESSION_SEND_RESPONSES",
  provider: "SLACK_API_SESSION_PROVIDER",
  pollSeconds: "SLACK_API_SESSION_POLL_SECONDS",
  headless: "SLACK_API_SESSION_HEADLESS",
  host: "SLACK_API_SESSION_HOST",
});
const SESSION_DEFAULT_ENV_ALIASES = Object.freeze({
  headless: Object.freeze(["SLACK_HEADLESS"]),
});
const BUILT_IN_SESSION_DEFAULTS = Object.freeze({
  channel: "me",
  sendResponses: false,
  provider: "auto",
  pollSeconds: 3,
  headless: true,
  host: "process",
});

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseBoolean(value, label) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") {
    throw new Error(`${label} must be a boolean`);
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${label} must be one of: true, false, 1, 0, yes, no, on, off`);
}

function normalizeValue(key, value, { coerceStrings = false, label = key } = {}) {
  if (key === "channel") {
    if (typeof value !== "string") throw new Error(`${label} must be a string`);
    const normalized = value.trim();
    if (!normalized) throw new Error(`${label} must not be empty`);
    if (normalized.length > 512) throw new Error(`${label} must be at most 512 characters`);
    if (/[\r\n\0]/.test(normalized)) {
      throw new Error(`${label} must be a single line without null bytes`);
    }
    return normalized;
  }
  if (key === "sendResponses" || key === "headless") {
    if (coerceStrings) return parseBoolean(value, label);
    if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
    return value;
  }
  if (key === "provider") {
    if (typeof value !== "string") throw new Error(`${label} must be a string`);
    const normalized = value.trim().toLowerCase();
    if (!SESSION_PROVIDERS.includes(normalized)) {
      throw new Error(`${label} must be one of: ${SESSION_PROVIDERS.join(", ")}`);
    }
    return normalized;
  }
  if (key === "pollSeconds") {
    const normalized = coerceStrings && typeof value === "string"
      ? Number(value.trim())
      : value;
    if (!Number.isSafeInteger(normalized) || normalized < 1) {
      throw new Error(`${label} must be a positive integer`);
    }
    return normalized;
  }
  if (key === "host") {
    if (typeof value !== "string") throw new Error(`${label} must be a string`);
    const normalized = value.trim().toLowerCase();
    if (!SESSION_HOSTS.includes(normalized)) {
      throw new Error(`${label} must be one of: ${SESSION_HOSTS.join(", ")}`);
    }
    return normalized;
  }
  throw new Error(`Unknown session default: ${key}`);
}

function validateSessionDefaults(values, {
  coerceStrings = false,
  requireAll = false,
  source = "session defaults",
} = {}) {
  if (!isPlainObject(values)) throw new Error(`${source} must be an object`);
  const unknown = Object.keys(values).filter((key) => !SESSION_DEFAULT_KEYS.includes(key));
  if (unknown.length) {
    throw new Error(`Unknown session default${unknown.length === 1 ? "" : "s"} in ${source}: ${unknown.join(", ")}`);
  }

  const normalized = {};
  for (const key of SESSION_DEFAULT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(values, key) || values[key] === undefined) continue;
    normalized[key] = normalizeValue(key, values[key], {
      coerceStrings,
      label: `${source}.${key}`,
    });
  }
  if (requireAll) {
    const missing = SESSION_DEFAULT_KEYS.filter((key) => !Object.prototype.hasOwnProperty.call(normalized, key));
    if (missing.length) throw new Error(`${source} is missing: ${missing.join(", ")}`);
  }
  return normalized;
}

function sessionDefaultsFromEnvironment(env = process.env) {
  const values = {};
  for (const key of SESSION_DEFAULT_KEYS) {
    const variable = [
      SESSION_DEFAULT_ENV[key],
      ...(SESSION_DEFAULT_ENV_ALIASES[key] || []),
    ].find((candidate) => env?.[candidate] !== undefined);
    if (!variable) continue;
    values[key] = normalizeValue(key, env[variable], {
      coerceStrings: true,
      label: variable,
    });
  }
  return values;
}

function resolveSessionDefaults({
  explicit = {},
  env = process.env,
  saved = {},
  builtIns = BUILT_IN_SESSION_DEFAULTS,
} = {}) {
  const normalizedBuiltIns = validateSessionDefaults(builtIns, {
    requireAll: true,
    source: "built-in session defaults",
  });
  const normalizedSaved = validateSessionDefaults(saved, {
    source: "saved session defaults",
  });
  const environment = sessionDefaultsFromEnvironment(env);
  const normalizedExplicit = validateSessionDefaults(explicit, {
    source: "explicit session defaults",
  });
  const values = {};
  const sources = {};

  for (const key of SESSION_DEFAULT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(normalizedExplicit, key)) {
      values[key] = normalizedExplicit[key];
      sources[key] = { kind: "explicit" };
    } else if (Object.prototype.hasOwnProperty.call(environment, key)) {
      values[key] = environment[key];
      const variable = [
        SESSION_DEFAULT_ENV[key],
        ...(SESSION_DEFAULT_ENV_ALIASES[key] || []),
      ].find((candidate) => env?.[candidate] !== undefined);
      sources[key] = { kind: "environment", variable };
    } else if (Object.prototype.hasOwnProperty.call(normalizedSaved, key)) {
      values[key] = normalizedSaved[key];
      sources[key] = { kind: "saved" };
    } else {
      values[key] = normalizedBuiltIns[key];
      sources[key] = { kind: "built-in" };
    }
  }

  return { values, sources };
}

class SessionDefaultsStore {
  constructor(baseDir) {
    const directory = String(baseDir || "").trim();
    if (!directory) throw new Error("A session state directory is required");
    this.baseDir = path.resolve(directory);
    this.defaultsPath = path.join(this.baseDir, SESSION_DEFAULTS_FILENAME);
    fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.baseDir, 0o700);
  }

  readDocument() {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.defaultsPath, "utf8"));
      fs.chmodSync(this.defaultsPath, 0o600);
    } catch (error) {
      if (error.code === "ENOENT") {
        return { version: SESSION_DEFAULTS_VERSION, defaults: {} };
      }
      if (error instanceof SyntaxError) {
        throw new Error(`Session defaults at ${this.defaultsPath} are not valid JSON`);
      }
      throw error;
    }
    if (!isPlainObject(parsed)) {
      throw new Error(`Session defaults at ${this.defaultsPath} must be an object`);
    }
    if (parsed.version !== SESSION_DEFAULTS_VERSION) {
      throw new Error(
        `Unsupported session defaults schema at ${this.defaultsPath}: expected version ${SESSION_DEFAULTS_VERSION}`,
      );
    }
    if (!Object.prototype.hasOwnProperty.call(parsed, "defaults")) {
      throw new Error(`Session defaults at ${this.defaultsPath} are missing the defaults object`);
    }
    const unknown = Object.keys(parsed).filter((key) => !["version", "defaults"].includes(key));
    if (unknown.length) {
      throw new Error(`Unknown fields in session defaults at ${this.defaultsPath}: ${unknown.join(", ")}`);
    }
    return {
      version: SESSION_DEFAULTS_VERSION,
      defaults: validateSessionDefaults(parsed.defaults, {
        source: `saved session defaults at ${this.defaultsPath}`,
      }),
    };
  }

  writeDocument(defaults) {
    const normalized = validateSessionDefaults(defaults, {
      source: "saved session defaults",
    });
    const document = {
      version: SESSION_DEFAULTS_VERSION,
      defaults: normalized,
    };
    const temporaryPath = `${this.defaultsPath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      fs.renameSync(temporaryPath, this.defaultsPath);
      fs.chmodSync(this.defaultsPath, 0o600);
    } finally {
      try {
        fs.unlinkSync(temporaryPath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return structuredClone(document);
  }

  read() {
    return structuredClone(this.readDocument().defaults);
  }

  set(values) {
    const normalized = validateSessionDefaults(values, {
      source: "session defaults update",
    });
    if (!Object.keys(normalized).length) {
      throw new Error("At least one session default is required");
    }
    return this.writeDocument({
      ...this.readDocument().defaults,
      ...normalized,
    });
  }

  reset(keys) {
    if (keys === undefined || keys === null) {
      try {
        fs.unlinkSync(this.defaultsPath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      return { version: SESSION_DEFAULTS_VERSION, defaults: {} };
    }
    const requested = typeof keys === "string" ? [keys] : keys;
    if (!Array.isArray(requested) || !requested.length) {
      throw new Error("reset keys must be a non-empty string or array");
    }
    const unique = [...new Set(requested)];
    const unknown = unique.filter((key) => !SESSION_DEFAULT_KEYS.includes(key));
    if (unknown.length) {
      throw new Error(`Unknown session default${unknown.length === 1 ? "" : "s"} to reset: ${unknown.join(", ")}`);
    }
    const defaults = this.readDocument().defaults;
    for (const key of unique) delete defaults[key];
    if (!Object.keys(defaults).length) {
      return this.reset();
    }
    return this.writeDocument(defaults);
  }

  resolve({ explicit = {}, env = process.env } = {}) {
    return resolveSessionDefaults({
      explicit,
      env,
      saved: this.readDocument().defaults,
    });
  }

  show({ explicit = {}, env = process.env } = {}) {
    const document = this.readDocument();
    const resolved = resolveSessionDefaults({
      explicit,
      env,
      saved: document.defaults,
    });
    return {
      version: document.version,
      path: this.defaultsPath,
      saved: structuredClone(document.defaults),
      effective: resolved.values,
      sources: resolved.sources,
    };
  }
}

function showSessionDefaults(baseDir, options) {
  return new SessionDefaultsStore(baseDir).show(options);
}

function setSessionDefaults(baseDir, values) {
  return new SessionDefaultsStore(baseDir).set(values);
}

function resetSessionDefaults(baseDir, keys) {
  return new SessionDefaultsStore(baseDir).reset(keys);
}

module.exports = {
  BUILT_IN_SESSION_DEFAULTS,
  SESSION_DEFAULT_ENV,
  SESSION_DEFAULT_ENV_ALIASES,
  SESSION_DEFAULT_KEYS,
  SESSION_DEFAULTS_FILENAME,
  SESSION_DEFAULTS_VERSION,
  SESSION_HOSTS,
  SESSION_PROVIDERS,
  SessionDefaultsStore,
  parseBoolean,
  resetSessionDefaults,
  resolveSessionDefaults,
  sessionDefaultsFromEnvironment,
  setSessionDefaults,
  showSessionDefaults,
  validateSessionDefaults,
};
