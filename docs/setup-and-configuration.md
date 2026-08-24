# Setup and Configuration

## First-Time Setup

Run:

```sh
slack-api setup
```

After setup, run the read-only health audit:

```sh
slack-api doctor
```

For AI agents and automation, request the stable JSON report:

```sh
slack-api doctor --json
```

The doctor checks installation integrity, Node compatibility, configuration and
credential permissions, browser refresh readiness, cached authentication, the
private unread and notification-preference endpoints, conversation resolution,
Enterprise identity and routing, current-user restrictions, Slack response
warnings, and local agent-session readiness. Probes run independently after
authentication, so a policy restriction on one endpoint does not hide the state
of the others. It does not refresh credentials, launch a browser, read message
content, change local configuration, or mutate Slack.

Use `--offline` when network access is unavailable. Use `--strict` when warnings
should also produce a nonzero exit status.

Use the deeper coverage audit when unread resolution itself may be incomplete:

```sh
slack-api doctor --deep --strict
```

`--deep` calls `conversations.info` for positive unread conversation IDs and
reports stale, archived, externally shared, muted, inaccessible, or unresolved
metadata. It still does not call message history or read message bodies. The
default safety cap is 100 conversations and can be changed with
`--max-deep-conversations N`.

The JSON report includes a capability matrix and structured diagnostics with
`classification`, `retryable`, `requiresAdmin`, `action`, and `rawError` fields.
It also reports `strictSatisfied` and the expected `exitCode`, so an agent does
not need to infer strict-mode success from warning counts.
Mutation capabilities are reported as `unknown_not_safely_testable` because a
read-only doctor cannot verify posting, reactions, uploads, drafts, or mark-read
without changing Slack state.

Setup asks for your Slack workspace URL, opens a browser profile, and waits while you sign in. When auth succeeds, setup writes:

- config: `~/.config/slack-api-cli/config.json`
- browser profile: `~/.local/share/slack-api-cli/browser-profile`
- auth cache: `~/.local/share/slack-api-cli/auth.json`

Treat the browser profile and auth cache as sensitive session material.

## Finding Your Workspace URL

In the Slack desktop app, click the workspace name in the top-left menu. The workspace URL is shown in that menu and should look like `https://example.slack.com` or `https://example.enterprise.slack.com`.

## Alternate Setup Options

Pass the workspace URL up front:

```sh
slack-api setup --workspace https://example.slack.com
```

If your Slack login takes longer than the default five-minute setup window:

```sh
slack-api setup --timeout-ms 600000
```

If Slack later rejects the cache, refresh it:

```sh
slack-api auth --refresh --headed
```

Setup checks for Playwright's Chromium browser before opening Slack. If the browser runtime is missing, run the command shown in the terminal. It will look similar to:

```sh
npx playwright@1.59.1 install chromium
slack-api setup
```

## Configuration

Environment variables override saved config:

- `SLACK_WORKSPACE_URL`
- `SLACK_TEAM_ID`
- `SLACK_BROWSER_PROFILE`
- `SLACK_API_AUTH_CACHE`
- `SLACK_API_CONFIG`
- `SLACK_API_CONFIG_DIR`
- `SLACK_API_DATA_DIR`
- `SLACK_HEADLESS`
- `SLACK_INCLUDE_SNIPPETS`
- `SLACK_INCLUDE_TEXT`

Most commands also accept `--workspace`, `--profile`, and `--auth-cache`.

## Agent-Session Defaults

Agent-session behavior is stored separately from Slack authentication. The default
path is:

```text
~/.local/share/slack-api-cli/sessions/defaults.json
```

It follows `SLACK_API_SESSION_DIR` or a command's `--state-dir` override. The parent
directory is owner-only (`0700`) and the defaults file is owner-only (`0600`).

Schema version 1 has this shape:

```json
{
  "version": 1,
  "defaults": {
    "channel": "me",
    "sendResponses": true,
    "provider": "auto",
    "pollSeconds": 3,
    "headless": true,
    "host": "auto"
  }
}
```

Configure the recommended self-DM and standalone-host profile with:

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

`session defaults` is an alias for `session defaults show`, including when
`--state-dir` is supplied directly. Use `session defaults reset` to remove every
saved session default and return to environment/built-in resolution.

`host` accepts `auto`, `cmux`, `herdr`, or `process`. `auto` preflights matching
and installed cmux/Herdr CLIs, falls through unavailable servers, and uses the
managed process listener only when no standalone host is ready. `process` remains
the backward-compatible local detached listener.

Effective values use this precedence:

1. Explicit command-line option
2. Environment override
3. Saved agent-session default
4. Built-in safe fallback

The session-specific environment overrides are:

- `SLACK_API_SESSION_CHANNEL`
- `SLACK_API_SESSION_SEND_RESPONSES`
- `SLACK_API_SESSION_PROVIDER`
- `SLACK_API_SESSION_POLL_SECONDS`
- `SLACK_API_SESSION_HEADLESS`
- `SLACK_API_SESSION_HOST`

For compatibility, `SLACK_HEADLESS` also supplies the session `headless` value when
`SLACK_API_SESSION_HEADLESS` is absent. The session-specific variable wins when
both are set.

`session defaults show` returns the schema version and path plus `saved`,
`effective`, and `sources` objects. Each `sources` entry identifies
`explicit`, `environment`, `saved`, or `built-in`; environment entries also name
the variable that supplied the value.

Built-in fallbacks use `channel=me`, `sendResponses=false`, `provider=auto`,
`pollSeconds=3`, `headless=true`, and `host=process`. This lets a new installation
resolve the authenticated user's self-DM without silently enabling Slack responses
or creating a terminal pane. Saving the recommended profile opts into response
delivery and standalone hosting.

Use inverse flags for a one-run override when a saved default enables a behavior:

```sh
slack-api session start --no-send-responses
slack-api session start --headed
```

`--no-send-responses` is a hard policy for that session; later `respond --send`
commands remain dry runs.

Explicit `--channel`, `--self`, or `--link` values override the saved destination.
Conflicting destination options fail before Slack posts a root message.

## Local Files To Keep Private

Do not commit or publish:

- auth cache files
- browser profile directories
- agent-session defaults and state files
- result exports containing Slack message data
- local `.env` files

The project `.gitignore` excludes the repo-local paths used during development, but setup stores new user data outside the repository by default.
