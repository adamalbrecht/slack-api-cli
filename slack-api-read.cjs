#!/usr/bin/env node

const {
  loadAuth,
  parseCommonArgs,
  parsePermalink,
  parsePositiveInt,
  slackApiCall,
} = require("./slack-api-common.cjs");

function parseArgs(argv) {
  const { args, remaining } = parseCommonArgs(argv, {
    link: "",
    channel: "",
    ts: "",
    threadTs: "",
    limit: 50,
    maxPages: 20,
    includeText: process.env.SLACK_INCLUDE_TEXT === "1",
  });

  for (let index = 0; index < remaining.length; index += 1) {
    const arg = remaining[index];
    const next = () => {
      index += 1;
      if (index >= remaining.length) throw new Error(`Missing value for ${arg}`);
      return remaining[index];
    };

    if (arg === "--link") args.link = next();
    else if (arg === "--channel") args.channel = next();
    else if (arg === "--ts") args.ts = next();
    else if (arg === "--thread-ts") args.threadTs = next();
    else if (arg === "--limit") args.limit = parsePositiveInt(next(), "--limit");
    else if (arg === "--max-pages") args.maxPages = parsePositiveInt(next(), "--max-pages");
    else if (arg === "--include-text") args.includeText = true;
    else if (arg === "--redact-text") args.includeText = false;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (args.link) {
    const target = parsePermalink(args.link);
    args.channel = target.channelId;
    args.ts = target.messageTs;
    args.threadTs = target.rootTs;
    args.isThreadReply = target.isThreadReply;
  }

  if (!args.channel) throw new Error("--link or --channel is required");
  if (!args.ts) throw new Error("--link or --ts is required");
  if (!args.threadTs) args.threadTs = args.ts;

  return args;
}

function printHelp() {
  console.log(`
Usage:
  slack-api read --link SLACK_MESSAGE_LINK
  slack-api read --channel C123 --ts 1778748406.056539

Options:
  --link URL          Slack message or thread reply permalink
  --channel ID        Slack channel id
  --ts TS             Target message timestamp
  --thread-ts TS      Thread root timestamp. Defaults to --ts
  --limit N           Messages per replies page. Default: 50
  --max-pages N       Maximum replies pages. Default: 20
  --include-text      Include message text
  --redact-text       Redact message text in output. Default
  --workspace URL     Slack workspace URL
  --profile DIR       Browser profile directory. Default: configured profile
  --auth-cache FILE   Auth cache path. Default: configured auth cache
  --refresh-auth      Refresh auth from the signed-in browser profile before reading
  --headed            Show the browser window if Slack needs login
`);
}

function sanitizeMessage(message, includeText) {
  return {
    user: message.user || null,
    username: message.username || null,
    type: message.type || null,
    subtype: message.subtype || null,
    ts: message.ts || null,
    threadTs: message.thread_ts || null,
    parentUserId: message.parent_user_id || null,
    text: includeText ? (message.text || "") : "[redacted; rerun with --include-text to save message text]",
    reactionNames: Array.isArray(message.reactions)
      ? message.reactions.map((reaction) => reaction.name).filter(Boolean)
      : [],
  };
}

async function fetchThreadReplies(args, dependencies = {}) {
  const callSlackApi = dependencies.slackApiCall || slackApiCall;
  const messages = [];
  const messageTimestamps = new Set();
  const seenCursors = new Set();
  const pages = [];
  let cursor = "";
  let status = null;
  let authSource = null;
  let authHint;

  for (let pageIndex = 0; pageIndex < args.maxPages; pageIndex += 1) {
    if (seenCursors.has(cursor)) {
      return {
        ok: false,
        complete: false,
        error: "replies_pagination_stalled",
        status,
        authSource,
        authHint,
        hasMore: true,
        nextCursor: cursor,
        messages,
        pages,
      };
    }
    seenCursors.add(cursor);

    let response;
    let json;
    let auth;
    try {
      ({ response, json, auth } = await callSlackApi(args, "conversations.replies", {
        channel: args.channel,
        ts: args.threadTs,
        limit: args.limit,
        cursor,
        inclusive: true,
      }));
    } catch (error) {
      return {
        ok: false,
        complete: false,
        error: error.message || String(error),
        status,
        authSource,
        authHint,
        hasMore: true,
        nextCursor: cursor,
        messages,
        pages,
      };
    }

    status = response?.status ?? status;
    authSource = auth?.source || authSource;
    authHint = json?.authHint || authHint;
    if (!json || typeof json !== "object") {
      return {
        ok: false,
        complete: false,
        error: "invalid_conversations_replies_response",
        status,
        authSource,
        authHint,
        hasMore: true,
        nextCursor: cursor,
        messages,
        pages,
      };
    }

    const pageMessages = Array.isArray(json.messages) ? json.messages : [];
    const nextCursor = json.response_metadata?.next_cursor || "";
    const hasMore = Boolean(json.has_more || nextCursor);
    pages.push({
      ok: Boolean(json.ok),
      status,
      error: json.error || null,
      itemCount: pageMessages.length,
      cursor,
      nextCursor,
      hasMore,
    });

    if (!json.ok) {
      return {
        ok: false,
        complete: false,
        error: json.error || "conversations_replies_failed",
        status,
        authSource,
        authHint,
        hasMore: true,
        nextCursor,
        messages,
        pages,
      };
    }

    for (const message of pageMessages) {
      const timestamp = String(message.ts || "");
      if (!timestamp || messageTimestamps.has(timestamp)) continue;
      messageTimestamps.add(timestamp);
      messages.push(message);
    }

    if (!hasMore) {
      return {
        ok: true,
        complete: true,
        error: null,
        status,
        authSource,
        authHint,
        hasMore: false,
        nextCursor: "",
        messages,
        pages,
      };
    }

    if (!nextCursor) {
      return {
        ok: false,
        complete: false,
        error: "replies_next_cursor_missing",
        status,
        authSource,
        authHint,
        hasMore: true,
        nextCursor: "",
        messages,
        pages,
      };
    }
    cursor = nextCursor;
  }

  return {
    ok: false,
    complete: false,
    error: "replies_page_limit_reached",
    status,
    authSource,
    authHint,
    hasMore: true,
    nextCursor: cursor,
    messages,
    pages,
  };
}

function buildOutput(args, result) {
  const target = result.messages.find((message) => message.ts === args.ts);
  return {
    ok: result.ok,
    complete: result.complete,
    status: result.status,
    error: result.error,
    channelId: args.channel,
    targetTs: args.ts,
    rootTs: args.threadTs,
    isThreadReply: Boolean(args.isThreadReply),
    includeText: args.includeText,
    authSource: result.authSource,
    authHint: result.authHint,
    hasMore: result.hasMore,
    pageCount: result.pages.length,
    nextCursor: result.nextCursor || "",
    messageCount: result.messages.length,
    target: target ? sanitizeMessage(target, args.includeText) : null,
    messages: result.messages.map((message) => sanitizeMessage(message, args.includeText)),
  };
}

function exitCodeForOutput(output) {
  return output?.ok && output.complete ? 0 : 1;
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const args = parseArgs(argv);
  const authenticate = dependencies.loadAuth || loadAuth;
  args.auth = await authenticate(args);
  const result = await fetchThreadReplies(args, dependencies);
  const output = buildOutput(args, result);
  console.log(JSON.stringify(output, null, 2));
  return output;
}

if (require.main === module) {
  main().then((output) => {
    process.exitCode = exitCodeForOutput(output);
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  buildOutput,
  exitCodeForOutput,
  fetchThreadReplies,
  main,
  parseArgs,
  sanitizeMessage,
};
