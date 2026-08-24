const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("CLI simulates a complete thread-to-provider session without Slack", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "slack-session-e2e-"));
  const fixture = path.join(__dirname, "fixtures", "session-thread.json");
  const result = spawnSync(process.execPath, [
    path.resolve(__dirname, "..", "slack-api.cjs"),
    "session", "start",
    "--channel", "C0AGENT12345",
    "--simulate", fixture,
    "--provider", "stdio",
    "--replay-existing",
    "--once",
    "--foreground",
    "--state-dir", directory,
  ], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /agent_session_injection/);
  const injections = result.stdout
    .split("\n")
    .filter((line) => line.startsWith("{\"type\":\"agent_session_injection\""))
    .map((line) => JSON.parse(line));
  assert.equal(injections.length, 4);
  const eventIds = [];
  for (const injection of injections) {
    assert.equal(injection.text.includes("\n"), false);
    assert.match(injection.text, /^# \[SLACK_AGENT_SESSION_EVENT v1\] /);
    const envelope = JSON.parse(injection.text.replace(/^# \[SLACK_AGENT_SESSION_EVENT v1\] /, ""));
    eventIds.push(envelope.eventId);
    assert.equal(envelope.sessionId.startsWith("sess_"), true);
    assert.equal(envelope.response.eventId, envelope.eventId);
  }
  const firstEnvelope = JSON.parse(
    injections[0].text.replace(/^# \[SLACK_AGENT_SESSION_EVENT v1\] /, ""),
  );
  assert.equal(
    firstEnvelope.text,
    "Summarize the current implementation.\nTell me what remains to test against real Slack.",
  );
  assert.equal(new Set(eventIds).size, 4);
  assert.match(result.stdout, /\"start\":/);
  assert.match(result.stdout, /\"channel\": \"C0AGENT12345\"/);
  assert.match(result.stdout, /\"rootTs\": \"1778784641.394639\"/);
  assert.match(result.stdout, /\"author\": \"Owner\"/);
  assert.match(result.stdout, /\"owner\": \"Owner\"/);
  assert.match(result.stdout, /Open the permalink directly; refresh Slack/);
  const state = JSON.parse(fs.readFileSync(path.join(directory, "state.json"), "utf8"));
  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0].status, "stopped");
  assert.equal(state.sessions[0].slack.createdBySession, true);
  assert.equal(state.sessions[0].slack.bindingMode, "created_thread");
  assert.equal(state.sessions[0].slack.threadTs, "1778784641.394639");
  assert.equal(state.sessions[0].injectedCount, 4);
  assert.equal(state.sessions[0].rejectedCount, 1);
  assert.equal(state.sessions[0].cursorTs, "1778784648.500000");
  assert.equal(state.sessions[0].lastInjectedTs, "1778784645.500000");
  assert.deepEqual(state.sessions[0].recentInjectedTs, [
    "1778784642.400000",
    "1778784643.500000",
    "1778784644.500000",
    "1778784645.500000",
  ]);
  const events = fs.readFileSync(
    path.join(directory, "events", `${state.sessions[0].id}.ndjson`),
    "utf8",
  );
  assert.equal(events.match(/"type":"message_skipped"/g)?.length, 2);
});

test("session respond help documents mrkdwn, stdin, and caller-owned files", () => {
  const result = spawnSync(process.execPath, [
    path.resolve(__dirname, "..", "slack-api.cjs"),
    "session", "respond", "--help",
  ], { encoding: "utf8", timeout: 10_000 });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Responses are posted with Slack mrkdwn enabled/);
  assert.match(result.stdout, /\*bold\*, <url\|label>,/);
  assert.match(result.stdout, /--stdin\s+Read response text from standard input/);
  assert.match(result.stdout, /--event EVENT_ID\s+.*\(required\)/);
  assert.match(result.stdout, /reads caller-owned files without changing or deleting them/);
  assert.match(result.stdout, /only after a successful send/);
});

test("session help exposes defaults reset, events, and host lifecycle controls", () => {
  const cli = path.resolve(__dirname, "..", "slack-api.cjs");
  const general = spawnSync(process.execPath, [
    cli, "session", "--help",
  ], { encoding: "utf8", timeout: 10_000 });
  assert.equal(general.status, 0, general.stderr);
  assert.match(general.stdout, /session defaults reset/);
  assert.match(general.stdout, /session events --id SESSION_ID/);
  assert.match(general.stdout, /restart --id SESSION_ID \[--host HOST\|--keep-host\]/);
  assert.match(general.stdout, /With list, include only verified live listeners/);

  const defaults = spawnSync(process.execPath, [
    cli, "session", "defaults", "--help",
  ], { encoding: "utf8", timeout: 10_000 });
  assert.equal(defaults.status, 0, defaults.stderr);
  assert.match(defaults.stdout, /defaults reset \[--state-dir DIR\]/);
  assert.match(defaults.stdout, /Remove all saved session defaults/);
});
