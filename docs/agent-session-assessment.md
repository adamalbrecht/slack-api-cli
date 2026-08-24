# Agent Session Assessment

This assessment compares the idea notes in
`~/ideas/slack-agent-session.md` with this repository after the
agent-session implementation.

| Source idea | Current assessment |
|---|---|
| Browser-session authentication | Existing and reused. The listener stores auth paths, never token or cookie copies. |
| Agent-friendly Slack toolkit | Existing. Session polling reuses complete paginated thread reads with text intentionally enabled for injection. |
| Dry-run-safe mutations | Existing and preserved. Safe built-ins keep response posting disabled; a saved session profile can enable it, and `--no-send-responses` always opts out for one run. |
| Saved session profile | Implemented with a private versioned defaults file, explicit → environment → saved → built-in precedence, per-value source reporting, and inverse flags. Named multi-workspace authentication profiles remain separate work. |
| Self-DM/thread listener | Implemented. A configured bare `session start`, `--self`, or `--channel me` dynamically resolves the authenticated user's self-DM and creates a new root. Explicit channels and existing-thread links remain overrides. |
| Slack thread ↔ terminal bridge | Implemented for tmux, cmux, and Herdr targets. Each inbound message is one correlated, shell-inert `# [SLACK_AGENT_SESSION_EVENT v1]` line; output uses an explicit response command and authenticated localhost bridge instead of unreliable terminal scraping. |
| Standalone listener ownership | Implemented through `--host auto|cmux|herdr|process`. Herdr/cmux hosts own a visible pane, while process hosting preserves backward compatibility. Host and coding-agent target metadata are stored separately. |
| Lifecycle and auditability | Implemented. List/show expose host, worktree, attached agent session, provider, redacted last-sent/last-received state, timings, and outbound quarantine; stop closes only a CLI-owned host and restart preserves the Slack binding. |
| Shared ownership and approvals | Owner controls, pause/resume/stop, allowlists, approval queues, and provider-native tool approvals are implemented. Rich typed cross-provider tool-policy objects and delegated owner veto during an already-running tool call remain future work. |
| Agent session skill | Implemented. The portable skill teaches configured bare startup, standalone hosting, sentinel/correlation handling, safe response files, reactions, timing interpretation, and lifecycle commands. |

## Architecture Decision

The listener is a small local workflow rather than a dashboard server. In the
recommended profile, `--host auto` creates a standalone Herdr or cmux pane and runs
the listener there; `host=process` remains the safe built-in and compatibility
fallback. The host owns polling and logs, while the provider target identifies the
original coding-agent pane that receives events.

Starting a new session resolves its destination, creates and persists its Slack root
thread, launches the selected host, and returns after runtime readiness. The listener
polls only that thread and exposes a random-port, bearer-authenticated localhost
endpoint solely for responses. This keeps inbound Slack state complete and
auditable while avoiding an always-on public endpoint or ongoing supervision by the
initiating agent.

State uses an atomic owner-only JSON file and append-only NDJSON event journals.
That avoids a native SQLite dependency in the Node 20 CLI. Pending approval text is
private state; routine audit records and last-message summaries store hashes,
lengths, IDs, and timestamps rather than Slack text.

## Validation Status

Automated coverage includes:

- complete simulated Slack thread lifecycle;
- private saved defaults, validation, source precedence, and migration-safe built-ins;
- authenticated self-DM resolution and fail-before-post behavior;
- one-physical-line sentinel framing with escaped multiline text and event correlation;
- owner, collaborator, and unknown-user routing;
- pause/resume controls and approval queues;
- different/normalized outbound-delivery quarantine;
- fake-clock timing, slow-response warnings, and idempotent
  `eyes` → `hourglass_flowing_sand` → `white_check_mark` progression;
- authenticated localhost responses;
- tmux literal paste behavior;
- exact cmux and Herdr injection and standalone-host command construction;
- managed-host close protection and host command input validation;
- private state permissions, duplicate binding prevention, audit redaction, and
  backward-compatible session normalization;
- skill assertions for recommended defaults, hosted ownership, one-event
  interpretation, quarantine, timing, and lifecycle guidance.

Still pending real end-to-end verification on a Slack-equipped machine with the
actual terminal applications:

- real private API polling and `chat.postMessage`;
- a configured bare self-DM start and direct permalink visibility;
- workspace-specific rate limits and policy restrictions;
- live Herdr pane creation, command launch, logs, stop, and restart;
- cmux hosting against real Slack and the real target provider (standalone cmux
  create, readiness, inspect, restart, and owned-host stop have been exercised
  with simulated Slack);
- exactly-one-turn framing in the actual Pi/Codex/Claude/OpenCode TUI;
- live `eyes`, optional hourglass, and `white_check_mark` rendering;
- live Slack mrkdwn rendering and `:robot_face:` response prefix;
- one observed outbound quarantine with no reinjection;
- captured startup/acknowledgment/first-response timings without private message
  text;
- an explicit-channel run proving it overrides the saved self-DM destination.

The `npm run session:demo` fixture, automated host adapters, and installed-cmux
simulated lifecycle smoke test are the acceptance harness until that live
verification is run. They do not prove private Slack API behavior, live Herdr
compatibility, or real target-agent turn framing.
