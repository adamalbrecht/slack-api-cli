const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");
const skillDir = path.join(repoRoot, ".agents", "skills", "slack-agent-session");

test("portable agent skill has minimal standard frontmatter", () => {
  const skill = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/);

  assert.ok(frontmatter, "SKILL.md should begin with YAML frontmatter");
  assert.match(frontmatter[1], /^name: slack-agent-session$/m);
  assert.match(frontmatter[1], /^description: .+$/m);

  const keys = [...frontmatter[1].matchAll(/^([a-z][a-z0-9-]*):/gm)]
    .map((match) => match[1]);
  assert.deepEqual(keys.sort(), ["description", "name"]);
});

test("agent skill starts the configured self-DM session in a standalone host", () => {
  const skill = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");

  const defaultsTable = skill.indexOf("| Destination | Authenticated user's self-DM (`me`) |");
  const firstStart = skill.indexOf("slack-api session start");
  assert.ok(defaultsTable >= 0, "recommended defaults table should be present");
  assert.ok(defaultsTable < firstStart, "recommended defaults should precede the first start command");
  assert.match(skill, /slack-api session defaults set[\s\S]*--channel me[\s\S]*--send-responses/);
  assert.match(skill, /--provider auto[\s\S]*--poll-seconds 3[\s\S]*--headless[\s\S]*--host auto/);
  assert.match(skill, /slack-api session start\n/);
  assert.match(skill, /slack-api session start --host auto/);
  assert.match(skill, /dedicated Herdr or cmux pane/i);
  assert.match(skill, /returns immediately/i);
  assert.match(skill, /hosted pane.*owns polling, logs,[\s\S]*long-running process/i);
  assert.match(skill, /original pane/i);
  assert.match(skill, /Do not ask for a channel,[\s\S]*session ID,[\s\S]*provider/);
  assert.doesNotMatch(skill, /If the user did not provide a destination, ask/);
  assert.match(skill, /--message-file \/absolute\/path\/to\/slack-response-UNIQUE\.txt/);
  assert.match(skill, /Never guess a session, event, or correlation ID/);
  assert.match(skill, /Codex, OpenCode, Claude Code, or Pi/);
  assert.match(skill, /slack-api read --link .+ --include-text/);
  assert.match(skill, /canonical inspection command for a bound session/i);
  assert.match(skill, /channel\s+history.*parent\/channel-history messages only/is);
  assert.match(skill, /slack-api channel replies --channel C123 --thread-ts/);
  assert.match(skill, /listener filters empty\/whitespace replies and bot\/system message subtypes/);
  assert.match(skill, /`cursorTs`\/`listenerCursorAt` separately from/);
  assert.match(skill, /adds `:eyes:` to accepted inbound work/);
  assert.match(skill, /prefixed with `:robot_face:` automatically/);
});

test("agent skill treats one complete sentinel envelope as one actionable turn", () => {
  const skill = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");

  assert.match(skill, /# \[SLACK_AGENT_SESSION_EVENT v1\]/);
  assert.match(skill, /leading `# ` is part of the sentinel/);
  assert.match(skill, /abandoned shell target inert/);
  assert.match(skill, /single-physical-line event/i);
  assert.match(skill, /event\/correlation ID/i);
  assert.match(skill, /JSON-escaped `\\n`/);
  assert.match(skill, /preserves leading\/trailing whitespace and Unicode/i);
  assert.match(skill, /full 40,000-character Slack message size/i);
  assert.match(skill, /never silently truncated/i);
  assert.match(skill, /one\s+complete sentinel envelope as exactly\s+one user turn/i);
  assert.match(skill, /--event evt_EXAMPLE[\s\S]*--status complete/);
  assert.match(skill, /--event evt_EXAMPLE[\s\S]*--status progress/);
  assert.match(skill, /Both `--id` and `--event` are required/);
  assert.match(skill, /If there is no complete envelope,[\s\S]*do not guess a correlation/);
  assert.match(skill, /Ignore incomplete sentinels, standalone metadata, empty probes/);
  assert.match(skill, /outbound_delivery_observed/);
  assert.match(skill, /direction=outbound/);
  assert.match(skill, /reason=self_authored/);
  assert.match(skill, /requires no action/i);
  assert.match(skill, /Do not repeatedly run `session show`, inspect event logs, or reread the Slack thread/);
});

test("agent skill documents hosted lifecycle, timing, and reaction progression", () => {
  const skill = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");

  assert.match(skill, /slack-api session show --id sess_EXAMPLE --verbose/);
  assert.match(skill, /slack-api session restart --id sess_EXAMPLE/);
  assert.match(skill, /`stop` stops the workflow and closes its owned host pane/);
  assert.match(skill, /active worktrees, attached coding-agent sessions/);
  assert.match(skill, /On start, the CLI records a private identity fingerprint/);
  assert.match(skill, /Before every injection it verifies that fingerprint/);
  assert.match(skill, /cmux\s+and tmux can verify the surface\/pane lifetime but cannot prove/);
  assert.match(skill, /session list --active` shows only verified live listener identities/);
  assert.match(skill, /restart --host auto\|herdr\|cmux\|process/);
  assert.match(skill, /restart --keep-host` only to reuse the exact open, verified owned/);
  assert.match(skill, /`stop --keep-host` stops the listener/);
  assert.match(skill, /injectedToAcknowledgedMs/);
  assert.match(skill, /injectedToFirstResponseMs/);
  assert.match(skill, /30-second slow-response threshold/);
  assert.match(skill, /`:eyes:`[\s\S]*`:hourglass_flowing_sand:`[\s\S]*`:white_check_mark:`/);
  assert.match(skill, /durably records an injection claim/);
  assert.match(skill, /`claimed` or `uncertain` injection state/);
  assert.match(skill, /Never automatically retry an\s+uncertain event/i);
  assert.match(skill, /restart the coding-agent session/);
  assert.match(skill, /resend the request as a new Slack message/);
  assert.match(skill, /nonce\s+proof that sends no\s+bridge token or response body/i);
  assert.match(skill, /no\s+direct fallback after a bridge failure/i);
});

test("agent skill locks response formatting and temporary-file pitfalls", () => {
  const skill = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");

  assert.match(skill, /Use Slack mrkdwn/);
  assert.match(skill, /`\*bold\*`, `<url\|label>`, `_italic_`, `~strike~`/);
  assert.match(skill, /does not change or delete\s+caller-owned message files/);
  assert.match(skill, /only after a successful send/);
  assert.match(skill, /Do not paste raw Slack JSON/);
  assert.match(skill, /literal\s+`slack-api session respond` command blocks/);
  assert.match(skill, /Ignore harness-only reminders, empty probes/);
  assert.match(skill, /Keep replies short/);
  assert.doesNotMatch(skill, /\/tmp\/slack_response_msg\.txt/);
});

test("Codex metadata invokes the portable skill by name", () => {
  const metadata = fs.readFileSync(
    path.join(skillDir, "agents", "openai.yaml"),
    "utf8",
  );

  assert.match(metadata, /display_name: "Slack Agent Session"/);
  assert.match(metadata, /default_prompt: "Use \$slack-agent-session /);
});
