# Slack Agent Sessions

An agent session binds exactly one Slack thread to exactly one local terminal agent.
New thread replies become agent input; explicit agent responses go back to the same
thread. In the recommended flow, a standalone Herdr or cmux pane owns the
long-running listener while the original coding-agent pane remains free for coding
work.

The listener uses the authenticated browser session already configured for
`slack-api`. No Slack app is required.

## Agent Skill

The repository includes a harness-neutral Agent Skills package at
`.agents/skills/slack-agent-session`. Codex, OpenCode, and Pi discover that location
directly. Claude Code supports the same `SKILL.md` contents from
`.claude/skills/slack-agent-session`; symlink or copy the repository skill there.

The skill instructs the coding agent to use the configured self-DM destination,
preflight authentication and hosting, create the new thread automatically, retain
the generated session and host-pane IDs, send replies through private message
files, and preserve the owner and collaborator approval boundaries.

## Recommended Defaults

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

Configure this profile once:

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

Precedence is explicit command-line option, environment override, saved session
default, then built-in safe fallback. `session defaults show` reports each effective
value and its source.

## Start a Session

Run the provider, host, default, and authentication checks from the agent's terminal
environment:

```sh
slack-api whoami
slack-api session doctor
```

With the recommended profile configured, start a new self-DM session:

```sh
slack-api session start
```

The explicit equivalent for standalone hosting is:

```sh
slack-api session start --host auto
```

The command verifies the original coding-agent target, preflights the host, resolves
the authenticated user's self-DM, creates an internal session ID, posts a new root
message, and stores the thread binding. It then creates a dedicated Herdr or cmux
pane, starts the listener there, waits for runtime readiness, and returns to the
initiating agent. The hosted pane owns polling and logs; the initiating agent does
not keep a script open or continuously supervise it.

For `host=auto`, the CLI preflights matching and available cmux/Herdr hosts in
order, falls through an unavailable server, and uses the managed process host only
when no standalone host is ready. Start and restart fail closed—and attempt to
clean up their managed listener—unless the runtime bridge and first poll both
report ready. If host cleanup fails, the owned host remains marked
`cleanup_pending` so it stays auditable and a later stop or restart can retry it.

The result includes a `start` verifier with the channel, permalink, root timestamp,
root author, owner, effective defaults, standalone host pane, coding-agent
provider/target, worktree attachment, startup timings, and a refresh hint. Open the
permalink directly if Slack has not yet surfaced the new root in the sidebar.

Use explicit destinations as per-run overrides:

```sh
slack-api session start --self --host auto
slack-api session start --channel '#agent-sessions' --host auto
```

`--channel me` and `--self` both resolve the authenticated user's self-DM.
`--no-send-responses` keeps response posting and lifecycle reactions in dry-run mode
for one session. It is a session-level ceiling: a later response command cannot
override it with `--send`. Channel IDs, channel names, and DM IDs remain supported.

Use a custom root message with `--message` or `--message-file`.

Attaching to an existing thread remains available as an advanced API:

```sh
slack-api session start \
  --link 'https://example.slack.com/archives/C0123456789/p1778784641394639' \
  --host auto
```

Existing-thread attachment begins after the latest reply by default. Add
`--replay-existing` intentionally when you want its previous replies injected.

After a session is bound, inspect its complete Slack thread with the permalink
returned by the session:

```sh
slack-api read --link 'https://example.slack.com/archives/C0123456789/p1778784641394639' --include-text
```

This is the canonical bound-session inspection command. `channel history` returns
parent/channel-history messages only and does not expand replies, even when a
parent reports a nonzero `replyCount`. If only the channel ID and root timestamp
are available, use `slack-api channel replies --channel ID --thread-ts TS`.

Use `--foreground` only for supervised troubleshooting. `--once` processes one
complete snapshot and exits.

## Single-Turn Event Envelope

Every actionable Slack reply is injected as one physical line beginning with a
versioned sentinel:

```text
# [SLACK_AGENT_SESSION_EVENT v1] {"eventId":"evt_...","sessionId":"sess_...","messageTs":"...","thread":"...","from":{"id":"U...","name":"Owner"},"text":"line one\nline two","response":{...}}
```

The JSON envelope contains the authoritative session ID, event/correlation ID,
thread, sender, Slack timestamp, escaped message text, and response routing
metadata. A multiline Slack body uses JSON-escaped `\n`, so one Slack message
produces one provider input and one agent turn. Before calling `cmux send`, the
provider converts those JSON escapes to cmux-safe Unicode escapes so cmux cannot
interpret them as terminal Enter or Tab keys.

Leading/trailing whitespace and Unicode are preserved, with CRLF normalized to
`\n`. The complete 40,000-character Slack text limit is accepted. Larger payloads
are audited and cursor-advanced without injection rather than being silently
truncated.

The leading `# ` is part of the sentinel. It makes the line a comment in shells
that support interactive comments, and the formatter additionally Unicode-escapes
`$`, backticks, and `!` in the physical JSON so an abandoned zsh/tmux target cannot
expand Slack text before failing harmlessly. JSON parsing restores the exact text.
Herdr injection fails closed when no coding agent owns the target pane; it never
falls back to submitting untrusted text to a raw shell.

Only a complete sentinel envelope is actionable. Incomplete sentinels, standalone
metadata, empty probes, response reminders, and command fragments are ignored.
Once an event is handled, its metadata is not a reason to repeatedly run
`session show`, read event logs, or reread the thread.

The listener persists an injection claim before it mutates the terminal. A
`claimed` or `uncertain` injection state means that an attempt began but successful
submission was never durably confirmed. The cursor still advances and the event is
quarantined, so polling, approval, and cursor regression cannot automatically
submit it again. `session respond --event` also refuses claimed or uncertain events
because they are not safely known to be active agent turns.

Recover these events manually. Inspect the event and injection-attempt IDs,
timestamps, fingerprints, and exact provider target with `session show --verbose`
and `session events`. If the target's state is not provable, stop the Slack
session, restart the coding-agent session to discard any partial terminal input,
start or restart a verified Slack binding, and have the sender resend the request
as a new Slack message. Never automatically retry or re-approve the old event:
doing so can duplicate a submitted turn or concatenate onto a partial paste.

## Respond from the Agent

The generated session and event IDs are included in every envelope's response
routing metadata; they are not values the user has to copy into the start command:

```sh
slack-api session respond \
  --id sess_EXAMPLE \
  --event evt_EXAMPLE \
  --status complete \
  --message-file /absolute/path/to/slack-response-UNIQUE.txt \
  --send
```

Both `--id` and `--event` are required by the public response command. Use the
exact values from one complete envelope; a session lookup cannot reconstruct a
missing event ID safely.

For long-running work, explicitly mark the event in progress without posting a text
response:

```sh
slack-api session respond \
  --id sess_EXAMPLE \
  --event evt_EXAMPLE \
  --status progress \
  --send
```

Responses are posted with Slack mrkdwn enabled. Write `*bold*`, `<url|label>`,
`_italic_`, `~strike~`, and backticks for code. Text is passed through unchanged:
GitHub-style `**bold**` is not translated and may render literally.

Use a uniquely named private `--message-file` for agent-generated, Slack-derived, or
untrusted text so a shell never interprets response contents. The CLI reads the
caller-owned file but does not change or delete it; remove it yourself only after a
successful send. Do not reuse a shared `/tmp/slack_response_msg.txt`.

`--stdin` reads a response directly from standard input and is useful when trusted
agent-authored text is already available there. Do not interpolate generated or
Slack-derived text into `--message`, `echo`, or `printf` shell arguments.
`--message` remains convenient for simple literal responses. Exactly one response
source may be supplied.

Without `--send`, response posting is a dry run. A running listener exposes an
authenticated localhost-only response bridge; the command uses it when available
and otherwise calls Slack directly.

Before sending a bridge token or response body, the command verifies that the
stored PID is the exact session/runtime instance and performs a body-free,
credential-free nonce challenge. The listener proves knowledge of the bridge
secret and confirms its current stored runtime identity; redirects, mismatched
instances, and stale or reused loopback ports fail before the response POST. A
bridge failure has no direct fallback because a late or ambiguous result could
otherwise post the same response twice. Stop or restart the session instead of
bypassing this check.

Only one final `complete` or `error` payload may claim an event. Concurrent
responders share an atomic persisted delivery claim, exact retries reuse the same
Slack `client_msg_id`, and an exact retry after delivery returns
`already-delivered`. Changing the final status or text for that event is rejected.

Sent responses are prefixed with `:robot_face:`. When response sending is enabled,
accepted inbound work follows `:eyes:` → `:white_check_mark:` for quick work. Work
that remains open for 30 seconds, or is explicitly marked in progress, follows
`:eyes:` → `:hourglass_flowing_sand:` → `:white_check_mark:`. Transient reactions
are removed during each transition. Dry-run and simulated clients record the same
planned transitions deterministically without mutating Slack.

The poll after a sent response normally records `outbound_delivery_observed` with
`direction=outbound` and `reason=self_authored`. This is expected confirmation that
the response was quarantined. Slack may normalize mrkdwn or whitespace, so the
prepared and observed fingerprints can differ; the event reports the normalization
result and is never injected, reacted to, or answered.

This explicit response protocol is intentional. Terminal screen scraping cannot
reliably distinguish an agent's final answer from prompts, progress UI, approvals,
and tool output.

## Standalone Hosts and Agent Providers

The host and provider are separate:

| Role | Purpose |
|---|---|
| Host | Owns the listener process, visible logs, and host-pane lifecycle |
| Agent provider/target | Identifies the original coding-agent pane that receives events |

`--host auto` selects a live Herdr or cmux host after preflight and records its
pane/surface identity, with process hosting as the final fallback. Agent-provider
auto detection checks cmux, Herdr, then tmux; cmux comes
first because its Claude Teams mode may also export fake tmux variables.

| Agent provider | Detection | Injection |
|---|---|---|
| cmux | `CMUX_WORKSPACE_ID`, `CMUX_SURFACE_ID` | `cmux send` plus `send-key` |
| Herdr | `HERDR_ENV`, `HERDR_PANE_ID` | atomic `herdr agent prompt`; fails closed when no agent owns the pane |
| tmux | `TMUX`, `TMUX_PANE` | literal paste buffer plus `Enter` |

Pass `--provider` and `--target` only when attaching a different coding-agent pane.
At start, the CLI records a provider-target identity in addition to the visible
pane or surface ID. It verifies that identity again before every injection so a
reused tmux pane ID, replaced Herdr terminal/agent session, or changed cmux target
fails closed instead of receiving Slack text. Legacy sessions without this identity
must be restarted before they can inject.
Herdr can bind that check to the native attached-agent session. cmux and tmux can
verify the surface or pane lifetime, but cannot detect a coding-agent replacement
inside an otherwise unchanged terminal. After an in-place agent restart, stop the
old Slack session and start a fresh binding from the replacement agent before
accepting more input. A lifecycle `session restart` deliberately preserves the old
agent attachment.

The standalone host runs the listener inside its owned pane. Any listener hosted
outside cmux while targeting a cmux surface requires
`CMUX_SOCKET_MODE=allowAll`; otherwise use `--host cmux` or `--host auto`. The CLI
fails closed instead of starting a listener that cannot inject.
Host shutdown similarly verifies the saved workspace topology—and, for Herdr, the
full saved label and pane membership—before closing anything.

## Ownership and Approvals

Sessions accept only the authenticated Slack user by default.

Add a known collaborator:

```sh
slack-api session start --link "$THREAD" --allow-user U123456
```

Their messages are queued, not injected. Inspect the session, then approve or reject:

```sh
slack-api session show --id sess_EXAMPLE
slack-api session approve --id sess_EXAMPLE --event evt_EXAMPLE
slack-api session reject --id sess_EXAMPLE --event evt_EXAMPLE
```

`--auto-approve-collaborators` removes that gate. `--allow-any-user` expands who can
enter the queue, but does not remove approval by itself.

The owner can control the listener from Slack:

```text
!session status
!session pause
!session resume
!session stop
!session approve evt_EXAMPLE
!session reject evt_EXAMPLE
```

While paused, normal messages are queued and owner controls continue to be polled.
Terminal-agent approval prompts remain the final guard for tool and shell actions;
the bridge does not bypass the agent provider's own permission system.

## Session Management

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

`session list` exposes active worktrees, attached coding-agent session IDs,
provider targets, host panes, and redacted last-received/last-sent metadata so stale
workflows can be audited; queued message bodies are redacted from public list/show
output. Last-received metadata advances for observed inbound traffic even when a
message is queued, rejected, or safely skipped. `session list --active` includes
only configured-active listeners whose
process identity is still live and verified; the normal list retains stale or
uncertain records for audit and cleanup. `stop` stops the listener and closes only
the pane owned by that session.
The Slack `!session stop` control performs the same owned-host cleanup. `restart`
preserves the Slack and agent binding while starting a new standalone host when
necessary. A normal restart reuses the stored host policy: `auto` performs fresh
host selection, while an explicit saved kind remains fixed. Pass
`restart --host auto|herdr|cmux|process` to replace that policy, or
`restart --keep-host` to reuse the exact open, verified owned Herdr/cmux pane.
`--keep-host` and `--host` are mutually exclusive. `stop --keep-host` stops the
listener while deliberately leaving its owned pane open.

Only one active session may bind a thread. State is stored under
`~/.local/share/slack-api-cli/sessions` by default with owner-only permissions.
Event logs retain timestamps, routing decisions, text lengths, and SHA-256
fingerprints rather than Slack text. Messages awaiting approval must retain their
text temporarily in the private state file, but public session views expose only
their metadata, length, and fingerprint.

The poller uses complete cursor-paginated thread reads, advances a monotonic durable
timestamp cursor, and applies capped exponential backoff with jitter after Slack or
network failures. Outbound replies persist a Slack `client_msg_id` before posting,
reuse it after ambiguous failures, and quarantine the canonical delivered
timestamp so retry uncertainty cannot create duplicate work. If Slack accepted a
post whose request timed out, the next poll recognizes that `client_msg_id`,
persists the canonical timestamp, and completes the correlated response without
injecting the agent's own message.

Empty/whitespace messages, bot-authored messages, and Slack system subtypes are
audited and cursor-advanced without injection. Filtered, rejected, outbound, and
approval-gated messages receive no acknowledgment reaction. `session show` exposes
`cursorTs` and `listenerCursorAt` independently from `lastInjectedTs` and
`lastInjectedAt`, with `recentInjectedTs` retaining only a small timestamp history.
This makes a mid-poll count mismatch distinguishable from a skipped or not-yet-seen
reply without retaining extra message content.

`session show --verbose` exposes startup durations for provider preflight,
authentication, destination resolution, root creation, runtime readiness, first
poll, and acknowledgment. It also reports `injectedToAcknowledgedMs` and
`injectedToFirstResponseMs`. Thirty seconds is the slow-first-response threshold:
crossing it adds a redacted audit warning and the hourglass state, but it is not a
hard failure for long-running coding work.

## Simulation

No Slack workspace is needed for the deterministic end-to-end demo:

```sh
npm run session:demo
```

Or supply another fixture:

```sh
slack-api session start \
  --simulate test/fixtures/session-thread.json \
  --provider stdio \
  --replay-existing \
  --once \
  --foreground
```

The simulation exercises thread validation, cursoring, authorization, injection,
auditing, and shutdown. Real Slack remains the required final compatibility test
for private API behavior and workspace policy.

## Slack UI Notes

Slack can report `isMember: false` for a working self-DM. Treat that field as
informational for `im` conversations; successful destination preflight is the
usable signal.

Slack's “Out of office” banner comes from the user's Slack profile status. The
session CLI does not set or clear profile status, so change it in Slack when the
banner is unexpected.

## Current Transport Boundary

Slack I/O is isolated behind `SlackThreadClient`. An official Slack app, Socket
Mode receiver, or webhook-backed sender can be added later without changing session
storage, provider injection, ownership, or command semantics.
