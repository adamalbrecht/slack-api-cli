# Agent Usage

When a user asks you to use this project, use the local `slack-api` CLI directly. Do not switch to Slack MCP tools unless the user explicitly asks for them.

## Start Here

Check the installed CLI and cached identity:

```sh
slack-api --help
slack-api whoami
```

Use command-specific help when you are not sure about flags:

```sh
slack-api help dm
slack-api help user
slack-api help search
```

## Common Agent Tasks

Read a 1:1 DM history with a person:

```sh
slack-api dm history --user "Alice Smith" --include-text
```

Find a user:

```sh
slack-api user profile --name "Alice Smith"
slack-api user search --query "Alice Smith"
```

Search messages:

```sh
slack-api search --query "customer escalation" --any-author --include-snippets
```

Use Slack-native search syntax:

```sh
slack-api search --raw-query 'from:<@U123456> "customer escalation"' --include-snippets
```

Read a permalink:

```sh
slack-api read --link 'https://example.slack.com/archives/C0123456789/p1778784641394639' --include-text
```

`channel history` returns parent/channel-history messages only and never expands
thread replies. Use `channel replies --channel ID --thread-ts TS` when starting
from channel coordinates. Once an agent session is bound, its permalink is known,
so `slack-api read --link` is the canonical way to inspect the complete thread.

Bridge a Slack thread to this terminal agent:

```sh
slack-api session doctor
slack-api session start
```

With the recommended saved profile, the bare start resolves the authenticated
user's self-DM, creates and stores a new thread, enables responses, and launches the
listener in a standalone Herdr or cmux pane. The explicit hosted form is
`slack-api session start --host auto`. It returns after readiness; do not keep a
script open or continuously poll the hosted process from the initiating agent.

Use `--self`, `--channel`, or `--link` only as intentional destination overrides.
Use `--no-send-responses` for a dry-run response bridge on one start.

Only a complete, one-line event beginning with
`# [SLACK_AGENT_SESSION_EVENT v1]` is actionable Slack input. The `# ` shell-safety
prefix is part of the sentinel. Treat its escaped JSON body as one user turn, and
use the exact session and event/correlation IDs from its response metadata:

```sh
slack-api session respond \
  --id sess_EXAMPLE \
  --event evt_EXAMPLE \
  --status complete \
  --message-file /absolute/path/to/slack-response-UNIQUE.txt \
  --send
```

Keep the reply short and use Slack mrkdwn (`*bold*`, `<url|label>`, `_italic_`,
`~strike~`, and backticks), not GitHub `**bold**`. Do not post raw Slack JSON,
terminal output, or literal response command blocks. Preserve the agent provider's
normal approval flow for tool actions.

Use a uniquely named private `--message-file` so generated or Slack-derived text is
not interpreted by a shell. The CLI reads but does not delete the file; remove it
only after a successful send. `--stdin` is available for trusted text already on
standard input. See [Slack agent sessions](agent-sessions.md) for ownership,
provider, and simulation details.

The expected post-send `outbound_delivery_observed` event is a quarantined copy of
the agent's own response and requires no action. Do not repeatedly inspect the
session or thread merely because metadata for an already handled event appears.

An inbound injection state of `claimed` or `uncertain` is different: terminal
mutation may have happened without durable confirmation. Never retry, re-approve,
rewind, or respond to that event automatically. Inspect its redacted attempt
metadata, then stop the Slack session, restart the coding-agent session, restore a
verified binding, and ask for a new Slack message if the terminal outcome cannot be
proved. This prevents duplicate turns and concatenated partial prompts.

The running response bridge is also fail-closed. Before any token or response body
is sent, the CLI verifies the exact runtime process/instance and authenticates the
loopback listener with a credential-free nonce challenge. On failure, stop or
restart the session; do not bypass the check or force a direct retry.

For an explicit audit or lifecycle request, use:

```sh
slack-api session list
slack-api session list --active
slack-api session show --id sess_EXAMPLE --verbose
slack-api session events --id sess_EXAMPLE --limit 200
slack-api session stop --id sess_EXAMPLE
slack-api session restart --id sess_EXAMPLE
```

The list/show output identifies the attached worktree and coding-agent session,
injection provider, standalone host pane, redacted last sent/received metadata, and
timings. A response still open after 30 seconds transitions from `:eyes:` to
`:hourglass_flowing_sand:`; completion replaces transient state with
`:white_check_mark:`. The slow threshold is an observability warning, not a hard
failure. A restart reuses the saved host policy by default; pass `--host` to replace
it or `--keep-host` to reuse the exact verified open Herdr/cmux pane.

## Output Defaults

Message text is redacted by default. Add `--include-text` or `--include-snippets` only when the user asked for message content.

Mutating commands are dry-run by default. Do not add flags such as `--send`, `--add`, `--remove`, `--create`, or `--delete` unless the user explicitly asked you to mutate Slack.
