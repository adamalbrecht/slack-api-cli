---
name: slack-agent-session
description: Start, operate, and stop Slack-backed coding-agent sessions through the slack-api CLI. Use when a user asks to connect a Slack thread to the current Codex, OpenCode, Claude Code, or Pi terminal; inspect a session; reply to Slack; approve collaborator input; or troubleshoot tmux, cmux, or Herdr provider detection.
---

# Slack Agent Session

Bridge one newly created Slack thread to the coding agent running in the current
terminal. The configured flow puts the long-running listener in a standalone Herdr
or cmux pane, while the original coding-agent pane remains the injection target.
Keep all conversation in the bound Slack thread, let the CLI generate and persist
the session ID, and use the explicit response command for messages sent back to
Slack.

## Recommended Defaults

Use this profile unless the user explicitly requests an override:

| Setting | Recommended value |
|---|---|
| Destination | Authenticated user's self-DM (`me`) |
| Binding | Create a new thread |
| Listener host | Standalone pane (`auto`) |
| Agent provider | Auto-detect, preferring cmux |
| Agent target | Current coding-agent pane or surface |
| Send responses | Enabled |
| Poll interval | 3 seconds |
| Allowed users | Authenticated owner only |
| Collaborator approval | Manual |
| Existing reply replay | Disabled |
| Authentication | Headless |

Configure that profile once:

```sh
slack-api session defaults set \
  --channel me \
  --send-responses \
  --provider auto \
  --poll-seconds 3 \
  --headless \
  --host auto
slack-api session defaults show
```

Explicit command-line options override environment values, which override saved
session defaults, which override built-in safe fallbacks. Use `--no-send-responses`
for a hard dry-run response policy on one start; a later response command cannot
override that session-level opt-out.

## Locate and Check the CLI

Prefer an installed `slack-api` command. When it is unavailable and the current
repository contains `slack-api.cjs`, substitute `node slack-api.cjs` in every command.

Before starting a real session, run:

```sh
slack-api whoami
slack-api session doctor
```

If authentication is unavailable, tell the user to run `slack-api setup` or
`slack-api auth --refresh --headed`. Do not claim that a live session is ready until
`whoami` succeeds.

## Start a New Session

Treat a user request to start a session as authorization to post one new root
message to Slack and, when the configured profile enables it, to post agent
responses and lifecycle reactions in that new thread. Do not ask for a channel,
user ID, session ID, thread timestamp, provider, polling interval, response mode,
or permalink when the recommended profile is configured.

Use the configured one-command flow first:

```sh
slack-api session start
```

This is equivalent to the following explicit hosting override when the saved
destination and response defaults are already configured:

```sh
slack-api session start --host auto
```

`--host auto` creates a dedicated Herdr or cmux pane, starts the listener there,
binds it to the coding agent in the original pane, confirms runtime readiness, and
returns immediately. The hosted pane—not the initiating agent—owns polling, logs,
and the long-running process. Do not keep a command open, poll continuously, or
spend the initiating agent's context supervising it.

Auto hosting preflights matching and available cmux/Herdr CLIs before any Slack
mutation, falls through failed candidates, and uses the managed process host only
when no standalone host is ready. A start or restart that does not reach runtime
and first-poll readiness fails closed and attempts to clean up its managed
listener. If host cleanup itself fails, the owned host remains marked
`cleanup_pending` so it stays auditable and a later stop or restart can retry it.

Capture the returned Slack session ID, host pane ID, agent provider/target,
worktree, and `start` verifier fields. Report the channel, permalink, root
timestamp, host pane, and owner concisely. If the root is not visible in the Slack
client yet, use the returned permalink directly and suggest refreshing Slack; do
not require the user to paste any identifier back.

Use `--message-file /absolute/path/to/root.txt` for a custom root message. Keep
`--send-responses` or the saved equivalent only when the user wants the agent to
post replies; `--no-send-responses` makes responses and lifecycle reactions a hard
dry run even if a later command includes `--send`.

Use explicit destinations only as overrides:

```sh
slack-api session start --self --host auto
slack-api session start --channel '#agent-sessions' --host auto
```

Binding an existing thread is an advanced fallback:

```sh
slack-api session start \
  --link 'https://workspace.slack.com/archives/C123/p123' \
  --host auto
```

## Separate the Host from the Agent Target

The host pane owns the listener; the agent provider and target identify where
complete Slack events are injected. They are different identities. Let
`session doctor` and `--host auto` detect Herdr or cmux hosting, and let
`--provider auto` detect the original cmux, Herdr, or tmux coding-agent target.
Pass `--provider` and `--target` only when binding a different agent pane or
surface.

The standalone hosted flow runs the listener inside its dedicated pane and avoids
making the initiating agent own a detached process. The legacy local-detached cmux
flow still requires `CMUX_SOCKET_MODE=allowAll`; otherwise use the hosted flow.
Do not work around provider or host verification, and never bypass the coding
harness's own approval prompts.

On start, the CLI records a private identity fingerprint for the exact tmux or
Herdr agent target. Before every injection it verifies that fingerprint, including
the Herdr terminal topology and native agent-session identity when available.
Reused pane IDs, changed terminal ownership, or a different attached agent session
must fail closed before any prompt is sent. A legacy tmux or Herdr session without
this fingerprint cannot be resumed safely: stop it and start a new Slack session;
do not bypass the verification.

Herdr exposes the native attached-agent session and can verify it directly. cmux
and tmux can verify the surface/pane lifetime but cannot prove that a coding-agent
process was not replaced inside that unchanged terminal. If the target agent is
restarted or replaced in-place, stop the old Slack session and start a fresh
binding from the replacement agent before accepting more input. Reuse the existing
Slack thread explicitly only when that is intentional; a lifecycle
`session restart` preserves the old agent attachment.

## Handle Slack Input

Only a complete, single-physical-line event beginning with this exact sentinel is
actionable Slack input:

```text
# [SLACK_AGENT_SESSION_EVENT v1] {"sessionId":"sess_...","eventId":"evt_...","text":"line one\nline two","response":{...}}
```

The JSON envelope includes the authoritative session ID, event/correlation ID (the
event ID serves both roles), thread permalink, sender, Slack timestamp, escaped
message text, response policy, and response routing metadata.
The leading `# ` is part of the sentinel and makes an abandoned shell target inert; shell-expanding
characters are also JSON Unicode-escaped while preserving decoded text.
JSON-escaped `\n` preserves a multiline Slack message without creating multiple provider turns.
Treat one complete sentinel envelope as exactly one user turn and use its exact
routing metadata when responding. Never guess a session, event, or correlation ID.
The listener preserves leading/trailing whitespace and Unicode, normalizes CRLF to
`\n`, and accepts the full 40,000-character Slack message size. A larger payload is
audited and cursor-advanced without injection; it is never silently truncated.

Ignore incomplete sentinels, standalone metadata, empty probes, response reminders,
and command fragments. Do not acknowledge or reply to them. Keep the conversation
in the bound thread; never create a second session or thread unless the user
explicitly asks.

The listener filters empty/whitespace replies and bot/system message subtypes before
injection, audits the skip, and advances its cursor. It does not inject those events.
`session show` reports `cursorTs`/`listenerCursorAt` separately from
`lastInjectedTs`/`lastInjectedAt`, plus a short timestamp-only injection history, so
a cursor ahead of `lastInjectedTs` means the listener observed a non-injected event.

Before terminal mutation, the listener durably records an injection claim. A
`claimed` or `uncertain` injection state in `session show` or `session events`
means the prompt may have been partially or fully submitted even when no successful
injection was confirmed. It is a fail-closed quarantine: never re-approve the
event, rewind the cursor, replay its text, or send a correlated response. The CLI
refuses responses for events that were not safely confirmed as injected.

For manual recovery, inspect the event ID, injection-attempt ID, timestamps, and
fingerprints together with the exact coding-agent target. If you cannot prove what
the terminal accepted, stop the Slack session, restart the coding-agent session so
no partial prompt remains, start or restart a verified Slack binding, and ask the
sender to resend the request as a new Slack message. Never automatically retry an
uncertain event; retrying can duplicate a turn or concatenate text onto a partial
terminal submission.

Only the authenticated Slack user is accepted by default. Collaborator messages are
queued for approval. Inspect and approve or reject them explicitly:

```sh
slack-api session show --id sess_EXAMPLE
slack-api session approve --id sess_EXAMPLE --event evt_EXAMPLE
slack-api session reject --id sess_EXAMPLE --event evt_EXAMPLE
```

Do not enable `--allow-any-user` or `--auto-approve-collaborators` without explicit
user authorization.

The poll after an agent reply normally records `outbound_delivery_observed` with
`direction=outbound` and `reason=self_authored`. This is expected quarantine
confirmation, even when Slack's observed fingerprint differs after normalization.
It is never injected, reacted to, or answered, and requires no action.

Do not repeatedly run `session show`, inspect event logs, or reread the Slack thread
merely because an already handled event's metadata or outbound-delivery confirmation
appears. Inspect only when the user asks, the workflow reports a failure, or state is
genuinely ambiguous.

## Send an Agent Response

Send only a short, summarized user-facing response. Use Slack mrkdwn, not
GitHub-flavored Markdown: `*bold*`, `<url|label>`, `_italic_`, `~strike~`, and
backticks for code. Do not expect `**bold**` to be translated.

For generated or Slack-derived text, create a uniquely named private temporary file
with the harness's file-editing capability; do not reuse a shared path. Then run:

```sh
slack-api session respond \
  --id sess_EXAMPLE \
  --event evt_EXAMPLE \
  --status complete \
  --message-file /absolute/path/to/slack-response-UNIQUE.txt \
  --send
```

For work expected to take longer than 30 seconds, use the envelope's progress
routing command first:

```sh
slack-api session respond \
  --id sess_EXAMPLE \
  --event evt_EXAMPLE \
  --status progress \
  --send
```

Both `--id` and `--event` are required. Use the exact response routing metadata
supplied by the sentinel envelope; `session list` can recover a session ID for
inspection, but it cannot replace the event ID. If there is no complete envelope,
do not guess a correlation or send a response. The CLI does not change or delete
caller-owned message files.
Delete the exact temporary file yourself only after a successful send; retain it
after a failure for inspection. Never interpolate generated, Slack-derived, or
untrusted response text into a shell argument.

`--stdin` is also available when trusted agent-authored text is already supplied on
standard input. Do not build `echo` or `printf` shell snippets containing generated
or Slack-derived text.

With a running listener, the response command first verifies the exact local
runtime process and instance, then authenticates the loopback bridge with a nonce
proof that sends no bridge token or response body. Only a matching healthy runtime
receives the later response request. If this preflight fails, do not bypass it or
retry with `curl`; stop or restart the session. The CLI deliberately makes no
direct fallback after a bridge failure because the outcome could otherwise be
duplicated.

## Known Pitfalls

- Do not paste raw Slack JSON, terminal output, hidden reasoning, or literal
  `slack-api session respond` command blocks into the Slack reply.
- Ignore harness-only reminders, empty probes, and injected session metadata that
  contain no user-authored message. Do not acknowledge or reply to them.
- Keep replies short and summarize only the result and important tool outcomes.
- Slack responses use mrkdwn; write the response explicitly in Slack syntax.
- Use a unique private temporary file per response and remove it only after a
  successful send.

When sending is enabled, the listener adds `:eyes:` to accepted inbound work.
Normal quick work follows `:eyes:` → `:white_check_mark:`. Work still open after
the 30-second slow-response threshold follows `:eyes:` →
`:hourglass_flowing_sand:` → `:white_check_mark:`. Filtered, rejected, outbound,
and approval-gated messages are not reacted to.
Agent responses are prefixed with `:robot_face:` automatically; do not add a
second prefix.

`session show --verbose` separates startup phases (provider preflight,
authentication, destination resolution, root creation, host/runtime readiness,
first poll, and acknowledgment) and reports `injectedToAcknowledgedMs` and
`injectedToFirstResponseMs`. A slow-response warning after 30 seconds means work is
still in progress, not that a long-running coding task failed. Do not post diagnostic
timing text to Slack.

## Manage the Session

The initiating agent does not supervise a healthy hosted listener. Use the
persisted ID for explicit inspection and lifecycle requests:

```sh
slack-api session list
slack-api session list --active
slack-api session show --id sess_EXAMPLE --verbose
slack-api session events --id sess_EXAMPLE --limit 200
slack-api session pause --id sess_EXAMPLE
slack-api session resume --id sess_EXAMPLE
slack-api session stop --id sess_EXAMPLE
slack-api session restart --id sess_EXAMPLE
```

`session list` identifies active worktrees, attached coding-agent sessions,
providers/targets, standalone host panes, and the last sent/received message
metadata. `session list --active` shows only verified live listener identities; use
the ordinary list to retain stale or uncertain records for audit. Pending message
bodies remain redacted in list/show output.
`stop` stops the workflow and closes its owned host pane, including when the owner sends
`!session stop` from Slack. `restart`
recreates or reuses an appropriate standalone pane while preserving the stored
Slack and coding-agent binding. A normal restart reuses the stored host policy:
saved `auto` re-runs host selection, while a saved explicit host remains fixed.
Use `restart --host auto|herdr|cmux|process` to replace that policy. Use
`restart --keep-host` only to reuse the exact open, verified owned Herdr/cmux pane;
it cannot be combined with `--host`. `stop --keep-host` stops the listener but
deliberately leaves its owned pane open. Never close an unrelated pane.

The Slack owner can also send `!session status`, `!session pause`,
`!session resume`, or `!session stop` inside the thread.

## Inspect the Bound Thread

Once a session is bound, use its stored permalink to read the complete thread:

```sh
slack-api read --link 'https://workspace.slack.com/archives/C123/p123' --include-text
```

This is the canonical inspection command for a bound session. `slack-api channel
history` returns parent/channel-history messages only. A nonzero `replyCount` does
not mean the reply bodies are present. When only channel coordinates are
available, use:

```sh
slack-api channel replies --channel C123 --thread-ts 1778748406.056539 --include-text
```

## Simulate and Troubleshoot

When real Slack is unavailable and the current repository contains the fixture, run:

```sh
npm run session:demo
```

Use simulation only to validate routing, authorization, provider injection, and
storage. State clearly that private Slack API behavior still needs a real workspace
test.
