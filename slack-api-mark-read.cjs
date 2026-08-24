#!/usr/bin/env node

const fs = require("node:fs/promises");
const path = require("node:path");
const {
  DEFAULT_CONVERSATION_TYPES,
  buildTimeWindow,
  isTimestampInWindow,
  listConversations,
  loadAuth,
  parseCommonArgs,
  parsePermalink,
  parsePositiveInt,
  resolveChannel,
  slackApiCall,
  summarizeChannel,
  summarizeMessage,
} = require("./slack-api-common.cjs");

const COMMAND_ALIASES = {
  read: "all",
  all: "all",
  channel: "channel",
};

function parseSlackTimestamp(value, flagName, options = {}) {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d+)(?:\.(\d{1,6}))?$/);
  if (!match) {
    throw new Error(`${flagName} must be a Slack timestamp such as 1778784641.394639`);
  }

  const seconds = BigInt(match[1]);
  const micros = BigInt((match[2] || "").padEnd(6, "0"));
  const valueMicros = (seconds * 1_000_000n) + micros;
  if (!options.allowZero && valueMicros <= 0n) {
    throw new Error(`${flagName} must be greater than zero`);
  }

  return { raw, valueMicros };
}

function compareSlackTimestamps(left, right) {
  const leftValue = parseSlackTimestamp(left, "timestamp", { allowZero: true }).valueMicros;
  const rightValue = parseSlackTimestamp(right, "timestamp", { allowZero: true }).valueMicros;
  if (leftValue === rightValue) return 0;
  return leftValue < rightValue ? -1 : 1;
}

function parseArgs(argv) {
  const { args, remaining } = parseCommonArgs(argv, {
    command: "all",
    channel: "",
    link: "",
    types: DEFAULT_CONVERSATION_TYPES,
    limit: 50,
    maxPages: 20,
    maxMessagePages: 100,
    since: "",
    sinceTs: "",
    untilTs: "",
    includeText: process.env.SLACK_INCLUDE_TEXT === "1",
    mark: false,
    throughTs: "",
    ifLastRead: "",
    scanAllConversations: false,
    excludeMuted: false,
    priority: [],
    out: "",
    includePages: false,
  });

  if (remaining[0] && !remaining[0].startsWith("-")) {
    const rawCommand = remaining.shift();
    args.command = COMMAND_ALIASES[rawCommand] || rawCommand;
  }

  for (let index = 0; index < remaining.length; index += 1) {
    const arg = remaining[index];
    const next = () => {
      index += 1;
      if (index >= remaining.length) throw new Error(`Missing value for ${arg}`);
      return remaining[index];
    };

    if (arg === "--channel" || arg === "-c") args.channel = next();
    else if (arg === "--link") args.link = next();
    else if (arg === "--types") args.types = next();
    else if (arg === "--limit") args.limit = parsePositiveInt(next(), "--limit");
    else if (arg === "--max-pages") args.maxPages = parsePositiveInt(next(), "--max-pages");
    else if (arg === "--max-message-pages") args.maxMessagePages = parsePositiveInt(next(), "--max-message-pages");
    else if (arg === "--since" || arg === "--last") args.since = next();
    else if (arg === "--since-ts") args.sinceTs = next();
    else if (arg === "--until-ts") args.untilTs = next();
    else if (arg === "--include-text") args.includeText = true;
    else if (arg === "--redact-text") args.includeText = false;
    else if (arg === "--mark") args.mark = true;
    else if (arg === "--through-ts" || arg === "--ts") args.throughTs = next();
    else if (arg === "--if-last-read") args.ifLastRead = next();
    else if (arg === "--scan-all" || arg === "--scan-all-conversations") args.scanAllConversations = true;
    else if (arg === "--exclude-muted") args.excludeMuted = true;
    else if (arg === "--priority") {
      const values = next().split(",").map((value) => value.trim()).filter(Boolean);
      if (values.length === 0) throw new Error("--priority requires at least one channel ID or name");
      args.priority.push(...values);
    }
    else if (arg === "--out") args.out = path.resolve(next());
    else if (arg === "--include-pages") args.includePages = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!["all", "channel"].includes(args.command)) {
    throw new Error(`Unknown mark-read command: ${args.command}. Use 'all' or 'channel'.`);
  }

  if (args.link) {
    const target = parsePermalink(args.link);
    args.channel = target.channelId;
    args.command = "channel";
    if (args.mark && !args.throughTs) args.throughTs = target.messageTs;
    if (args.mark && args.throughTs
      && compareSlackTimestamps(args.throughTs, target.messageTs) !== 0) {
      throw new Error("--through-ts must match the message timestamp in --link");
    }
  }

  if (args.command === "channel" && !args.channel) {
    throw new Error("--channel or --link is required for mark-read channel");
  }

  const hasTimeFilter = Boolean(args.since || args.sinceTs || args.untilTs);
  if (args.mark && hasTimeFilter) {
    throw new Error("Time filters cannot be used with --mark because advancing a read cursor also clears older unread messages");
  }
  if (args.mark && args.scanAllConversations) {
    throw new Error("--scan-all-conversations is only valid for read-only scans");
  }
  if (args.mark && args.command !== "channel") {
    throw new Error("--mark is intentionally limited to one channel; use 'mark-read channel'");
  }
  if (args.excludeMuted && args.command !== "all") {
    throw new Error("--exclude-muted is only valid for mark-read all");
  }
  if (args.priority.length > 0 && !args.excludeMuted) {
    throw new Error("--priority requires --exclude-muted");
  }
  if (args.mark && !args.throughTs) {
    throw new Error("--through-ts (or a --link) is required with --mark");
  }
  if (!args.mark && (args.throughTs || args.ifLastRead)) {
    throw new Error("--through-ts and --if-last-read are only valid with --mark");
  }
  if (args.ifLastRead && !args.throughTs) {
    throw new Error("--if-last-read requires --through-ts");
  }

  if (args.throughTs) parseSlackTimestamp(args.throughTs, "--through-ts");
  if (args.ifLastRead) parseSlackTimestamp(args.ifLastRead, "--if-last-read", { allowZero: true });

  args.timeWindow = buildTimeWindow(args);
  return args;
}

function printHelp() {
  console.log(`
Usage:
  slack-api mark-read
  slack-api mark-read channel --channel '#general'
  slack-api mark-read channel --channel C0123456789 --through-ts 1778784641.394639 --mark
  slack-api mark-read channel --link 'https://.../archives/C0123456789/p1778784641394639' --mark

Commands:
  all       Scan positive users.counts unread conversations (default)
  channel   Scan one channel, or mark one channel through an exact timestamp

Scan options:
  --channel ID|#name   Channel id or name (for 'channel' subcommand)
  --link URL           Slack message permalink. With --mark, its message timestamp is the target.
  --types CSV          Conversation types to scan. Default: ${DEFAULT_CONVERSATION_TYPES}
  --limit N            Messages per history page. Default: 50
  --max-pages N        Max pages for conversations.list. Default: 20
  --max-message-pages N  Max history pages per channel. Default: 100
  --scan-all-conversations  Bypass users.counts and scan every joined conversation
  --exclude-muted      Exclude muted conversations before fetching their history
  --priority ID|NAME   Include a muted channel anyway. Repeat or use comma-separated values.
  --since DURATION     Show unread messages newer than duration: 30s, 5m, 12h, 7d
  --last DURATION      Alias for --since
  --since-ts TS        Show unread messages at/after Slack timestamp
  --until-ts TS        Show unread messages before/at Slack timestamp
  --include-text       Include message text in the summary
  --redact-text        Redact message text. Default

Exact mark options:
  --mark               Call conversations.mark. Only valid for one channel.
  --through-ts TS      Exact read cursor target; required with --mark unless --link supplies it
  --if-last-read TS    Fail without marking unless Slack's current last_read equals TS

Output options:
  --out FILE           Write owner-only JSON output to a file instead of stdout
  --include-pages      Include pagination metadata in output
  --workspace URL      Slack workspace URL
  --profile DIR        Browser profile directory. Default: configured profile
  --auth-cache FILE    Auth cache path. Default: configured auth cache
  --refresh-auth       Refresh auth from the signed-in browser profile before scanning
  --headed             Show the browser window if Slack needs login

Safety:
  Scans never mutate Slack. A scan is complete only after every unread history page is fetched.
  The default all-scan targets only positive conversation/DM unread counts from users.counts.
  Muted conversations are included by default. --exclude-muted reads your Slack notification preferences once.
  --exclude-muted fails before history if Slack's mute preference source is missing or unrecognized.
  Use --scan-all-conversations for a slower diagnostic scan of every joined conversation.
  Marking is separate, exact, single-channel, and never chooses a newer message automatically.
  Time filters are display-only and are rejected in mark mode.
`);
}

async function fetchChannelInfo(args, channelId, dependencies = {}) {
  const callSlackApi = dependencies.slackApiCall || slackApiCall;
  const { json } = await callSlackApi(args, "conversations.info", {
    channel: channelId,
    include_num_members: false,
  });
  if (!json || typeof json !== "object") {
    return { ok: false, error: "invalid_conversations_info_response", lastRead: null, channelId };
  }
  if (!json.ok) {
    return { ok: false, error: json.error || "conversations_info_failed", lastRead: null, channelId };
  }
  const lastRead = json.channel?.last_read || null;
  const channel = json.channel ? summarizeChannel(json.channel) : null;
  return { ok: true, error: null, lastRead, channelId, channel };
}

function sortMessagesNewestFirst(messages) {
  return [...messages].sort((left, right) => {
    try {
      return compareSlackTimestamps(right.ts, left.ts);
    } catch {
      return String(right.ts || "").localeCompare(String(left.ts || ""));
    }
  });
}

async function fetchUnreadMessages(args, channelId, lastRead, dependencies = {}) {
  const callSlackApi = dependencies.slackApiCall || slackApiCall;
  const messages = [];
  const messageKeys = new Set();
  const paginationStates = new Set();
  const pages = [];
  let cursor = "";
  let latest = "";
  let complete = false;

  for (let pageIndex = 0; pageIndex < args.maxMessagePages; pageIndex += 1) {
    const paginationState = `${cursor}\u0000${latest}`;
    if (paginationStates.has(paginationState)) {
      return {
        ok: false,
        complete: false,
        error: "history_pagination_stalled",
        messages: sortMessagesNewestFirst(messages),
        hasMore: true,
        pages,
        snapshotThroughTs: sortMessagesNewestFirst(messages)[0]?.ts || null,
      };
    }
    paginationStates.add(paginationState);

    let response;
    let json;
    try {
      ({ response, json } = await callSlackApi(args, "conversations.history", {
        channel: channelId,
        limit: args.limit,
        oldest: lastRead,
        latest,
        cursor,
        inclusive: false,
      }));
    } catch (error) {
      return {
        ok: false,
        complete: false,
        error: error.message || String(error),
        messages: sortMessagesNewestFirst(messages),
        hasMore: true,
        pages,
        snapshotThroughTs: sortMessagesNewestFirst(messages)[0]?.ts || null,
      };
    }

    if (!json || typeof json !== "object") {
      return {
        ok: false,
        complete: false,
        error: "invalid_conversations_history_response",
        messages: sortMessagesNewestFirst(messages),
        hasMore: true,
        pages,
        snapshotThroughTs: sortMessagesNewestFirst(messages)[0]?.ts || null,
      };
    }

    const pageMessages = Array.isArray(json.messages) ? json.messages : [];
    const nextCursor = json.response_metadata?.next_cursor || "";
    const hasMore = Boolean(json.has_more || nextCursor);
    pages.push({
      ok: Boolean(json.ok),
      status: response?.status ?? null,
      error: json.error || null,
      itemCount: pageMessages.length,
      cursor,
      latest,
      nextCursor,
      hasMore,
    });

    if (!json.ok) {
      return {
        ok: false,
        complete: false,
        error: json.error || "conversations_history_failed",
        messages: sortMessagesNewestFirst(messages),
        hasMore: true,
        pages,
        snapshotThroughTs: sortMessagesNewestFirst(messages)[0]?.ts || null,
      };
    }

    for (const message of pageMessages) {
      const key = String(message.ts || "");
      if (!key || messageKeys.has(key)) continue;
      messageKeys.add(key);
      messages.push({ ...message, channel: channelId });
    }

    if (!hasMore) {
      complete = true;
      break;
    }

    if (nextCursor) {
      cursor = nextCursor;
      latest = "";
      continue;
    }

    const oldestMessageTs = pageMessages.at(-1)?.ts || "";
    if (!oldestMessageTs) {
      return {
        ok: false,
        complete: false,
        error: "history_pagination_stalled",
        messages: sortMessagesNewestFirst(messages),
        hasMore: true,
        pages,
        snapshotThroughTs: sortMessagesNewestFirst(messages)[0]?.ts || null,
      };
    }
    cursor = "";
    latest = oldestMessageTs;
  }

  const sortedMessages = sortMessagesNewestFirst(messages);
  if (!complete) {
    return {
      ok: false,
      complete: false,
      error: "history_page_limit_reached",
      messages: sortedMessages,
      hasMore: true,
      pages,
      snapshotThroughTs: sortedMessages[0]?.ts || null,
    };
  }

  return {
    ok: true,
    complete: true,
    error: null,
    messages: sortedMessages,
    hasMore: false,
    pages,
    snapshotThroughTs: sortedMessages[0]?.ts || null,
  };
}

function failedChannelResult(channelId, channelSummary, error, lastRead = null) {
  return {
    channelId,
    channel: channelSummary || null,
    ok: false,
    complete: false,
    error,
    lastRead,
    snapshotThroughTs: null,
    unreadCount: 0,
    capturedUnreadCount: 0,
    messages: [],
    marked: false,
    alreadyRead: false,
    markResult: null,
    hasMore: false,
  };
}

async function processChannel(args, channelId, channelSummary, dependencies = {}) {
  let info;
  try {
    info = await fetchChannelInfo(args, channelId, dependencies);
  } catch (error) {
    return failedChannelResult(channelId, channelSummary, error.message || String(error));
  }

  if (!info.ok) {
    return failedChannelResult(channelId, channelSummary, info.error);
  }
  return processChannelWithInfo(args, channelId, channelSummary, info, dependencies);
}

async function processChannelWithInfo(args, channelId, channelSummary, info, dependencies = {}) {
  if (!info.lastRead) {
    return failedChannelResult(channelId, channelSummary || info.channel, "missing_last_read");
  }

  try {
    parseSlackTimestamp(info.lastRead, "Slack last_read", { allowZero: true });
  } catch {
    return failedChannelResult(channelId, channelSummary || info.channel, "invalid_last_read", info.lastRead);
  }

  const historyResult = await fetchUnreadMessages(args, channelId, info.lastRead, dependencies);
  const resolvedChannelSummary = channelSummary || info.channel || null;
  const filteredMessages = historyResult.messages.filter((message) => {
    if (!args.since && !args.sinceTs && !args.untilTs) return true;
    return isTimestampInWindow(message.ts, args.timeWindow);
  });

  return {
    channelId,
    channel: resolvedChannelSummary,
    ok: historyResult.ok,
    complete: historyResult.complete,
    error: historyResult.error,
    lastRead: info.lastRead,
    snapshotThroughTs: historyResult.snapshotThroughTs,
    unreadCount: filteredMessages.length,
    capturedUnreadCount: historyResult.messages.length,
    messages: filteredMessages.map((message) => summarizeMessage(args, message, args.includeText)),
    marked: false,
    alreadyRead: false,
    markResult: null,
    hasMore: historyResult.hasMore,
    pages: args.includePages ? historyResult.pages : undefined,
  };
}

function buildAllScanCoverage(args) {
  const conversationTypes = new Set(String(args.types || DEFAULT_CONVERSATION_TYPES).split(","));
  const conversationTimelineUnread = ["public_channel", "private_channel", "mpim"]
    .some((type) => conversationTypes.has(type));
  const directMessageUnread = conversationTypes.has("im");
  return {
    scope: "conversation_timeline_and_dm_unread",
    selection: args.scanAllConversations
      ? "all_joined_conversations"
      : "users.counts_positive_unread_conversations",
    conversationTimelineUnread,
    directMessageUnread,
    activityNotifications: false,
    threadNotifications: false,
    note: "Covers selected conversation timeline and DM unread state; Slack Activity and thread notifications are not covered.",
  };
}

function positiveCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function countCollectionEntries(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).map(([id, item]) => {
    if (item && typeof item === "object") return { ...item, id: item.id || id };
    return { id, unread_count: item };
  });
}

function extractUnreadConversationCounts(json, args) {
  const allowedTypes = new Set(String(args.types || DEFAULT_CONVERSATION_TYPES).split(","));
  const groups = [
    {
      key: "channels",
      allowed: allowedTypes.has("public_channel") || allowedTypes.has("private_channel"),
      isIm: false,
      isMpim: false,
    },
    { key: "ims", allowed: allowedTypes.has("im"), isIm: true, isMpim: false },
    { key: "mpims", allowed: allowedTypes.has("mpim"), isIm: false, isMpim: true },
  ];
  const conversations = new Map();

  for (const group of groups) {
    if (!group.allowed) continue;
    for (const item of countCollectionEntries(json[group.key])) {
      const id = String(item.id || item.channel_id || "").trim();
      if (!id) continue;
      const unreadCount = positiveCount(item.unread_count);
      const unreadCountDisplay = positiveCount(item.unread_count_display);
      const dmCount = positiveCount(item.dm_count);
      if (unreadCount === 0 && unreadCountDisplay === 0 && dmCount === 0) continue;

      const previous = conversations.get(id);
      conversations.set(id, {
        id,
        is_im: group.isIm,
        is_mpim: group.isMpim,
        is_member: true,
        unreadSignal: {
          source: `users.counts.${group.key}`,
          unreadCount: Math.max(previous?.unreadSignal.unreadCount || 0, unreadCount),
          unreadCountDisplay: Math.max(previous?.unreadSignal.unreadCountDisplay || 0, unreadCountDisplay),
          dmCount: Math.max(previous?.unreadSignal.dmCount || 0, dmCount),
        },
      });
    }
  }

  return [...conversations.values()];
}

async function fetchUnreadConversationCounts(args, dependencies = {}) {
  const callSlackApi = dependencies.slackApiCall || slackApiCall;
  let response;
  let json;
  let auth;
  try {
    ({ response, json, auth } = await callSlackApi(args, "users.counts", {}));
  } catch (error) {
    return {
      ok: false,
      complete: false,
      error: error.message || String(error),
      status: null,
      authSource: null,
      items: [],
    };
  }

  if (!json || typeof json !== "object") {
    return {
      ok: false,
      complete: false,
      error: "invalid_users_counts_response",
      status: response?.status ?? null,
      authSource: auth?.source || null,
      items: [],
    };
  }
  if (!json.ok) {
    return {
      ok: false,
      complete: false,
      error: json.error || "users_counts_failed",
      status: response?.status ?? null,
      authSource: auth?.source || null,
      authHint: json.authHint,
      items: [],
    };
  }

  const nextCursor = json.response_metadata?.next_cursor || "";
  if (nextCursor) {
    return {
      ok: false,
      complete: false,
      error: "users_counts_pagination_unsupported",
      status: response?.status ?? null,
      authSource: auth?.source || null,
      items: [],
      nextCursor,
    };
  }

  return {
    ok: true,
    complete: true,
    error: null,
    status: response?.status ?? null,
    authSource: auth?.source || null,
    items: extractUnreadConversationCounts(json, args),
  };
}

function booleanPreference(value) {
  if (value === true || value === 1) return true;
  return ["true", "1"].includes(String(value || "").trim().toLowerCase());
}

function preferenceChannelEntries(value) {
  if (Array.isArray(value)) {
    return value.map((item) => [item?.id || item?.channel_id || "", item]);
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value);
}

function extractMutedConversationIds(prefs) {
  if (!prefs || typeof prefs !== "object") {
    throw new Error("invalid_users_prefs_response");
  }

  const mutedConversationIds = new Set();
  const sources = [];
  const rawNotificationPrefs = prefs.all_notifications_prefs;
  if (rawNotificationPrefs !== undefined && rawNotificationPrefs !== null && rawNotificationPrefs !== "") {
    let notificationPrefs = rawNotificationPrefs;
    if (typeof rawNotificationPrefs === "string") {
      try {
        notificationPrefs = JSON.parse(rawNotificationPrefs);
      } catch {
        throw new Error("invalid_all_notifications_prefs");
      }
    }
    if (!notificationPrefs || typeof notificationPrefs !== "object") {
      throw new Error("invalid_all_notifications_prefs");
    }

    for (const [key, item] of preferenceChannelEntries(notificationPrefs.channels)) {
      if (!item || typeof item !== "object" || !booleanPreference(item.muted)) continue;
      const channelId = String(item.id || item.channel_id || key || "").trim();
      if (channelId) mutedConversationIds.add(channelId);
    }
    sources.push("all_notifications_prefs");
  }

  const legacyMutedChannels = prefs.muted_channels;
  if (legacyMutedChannels !== undefined && legacyMutedChannels !== null && legacyMutedChannels !== "") {
    const ids = Array.isArray(legacyMutedChannels)
      ? legacyMutedChannels
      : String(legacyMutedChannels).split(",");
    for (const value of ids) {
      const channelId = String(value || "").trim();
      if (channelId) mutedConversationIds.add(channelId);
    }
    sources.push("muted_channels");
  }

  return {
    mutedConversationIds,
    sources,
  };
}

async function fetchNotificationPreferences(args, dependencies = {}) {
  const callSlackApi = dependencies.slackApiCall || slackApiCall;
  let response;
  let json;
  let auth;
  try {
    ({ response, json, auth } = await callSlackApi(args, "users.prefs.get", {}));
  } catch (error) {
    return {
      ok: false,
      error: error.message || String(error),
      status: null,
      authSource: null,
      mutedConversationIds: new Set(),
      sources: [],
    };
  }

  if (!json || typeof json !== "object") {
    return {
      ok: false,
      error: "invalid_users_prefs_response",
      status: response?.status ?? null,
      authSource: auth?.source || null,
      mutedConversationIds: new Set(),
      sources: [],
    };
  }
  if (!json.ok) {
    return {
      ok: false,
      error: json.error || "users_prefs_get_failed",
      status: response?.status ?? null,
      authSource: auth?.source || null,
      authHint: json.authHint,
      mutedConversationIds: new Set(),
      sources: [],
    };
  }

  try {
    const extracted = extractMutedConversationIds(json.prefs);
    if (extracted.sources.length === 0) {
      return {
        ok: false,
        error: "mute_preference_source_missing",
        status: response?.status ?? null,
        authSource: auth?.source || null,
        mutedConversationIds: new Set(),
        sources: [],
      };
    }
    return {
      ok: true,
      error: null,
      status: response?.status ?? null,
      authSource: auth?.source || null,
      ...extracted,
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message || String(error),
      status: response?.status ?? null,
      authSource: auth?.source || null,
      mutedConversationIds: new Set(),
      sources: [],
    };
  }
}

function normalizePriorityTarget(value) {
  return String(value || "").trim().replace(/^#/, "").toLowerCase();
}

function isPriorityConversation(args, channelId, channelSummary) {
  const targets = new Set((args.priority || []).map(normalizePriorityTarget));
  const candidates = [
    channelId,
    channelSummary?.id,
    channelSummary?.name,
  ].map(normalizePriorityTarget).filter(Boolean);
  return candidates.some((candidate) => targets.has(candidate));
}

function excludedMutedConversation(channel, channelSummary) {
  return {
    channelId: channel.id,
    channel: channelSummary,
    reason: "muted",
    unreadSignal: channel.unreadSignal || null,
  };
}

function failedRunAll(args, error, extra = {}) {
  const coverage = buildAllScanCoverage(args);
  return {
    ok: false,
    complete: false,
    error,
    command: "all",
    mode: "dry-run",
    scannedChannels: 0,
    successfulChannels: 0,
    failedChannels: 0,
    channelsWithUnread: 0,
    totalUnreadMessages: 0,
    totalCapturedUnreadMessages: 0,
    allMarked: false,
    scope: coverage.scope,
    coverage,
    includeText: args.includeText,
    timeWindow: args.timeWindow,
    channels: [],
    ...extra,
  };
}

async function runAll(args, dependencies = {}) {
  const list = dependencies.listConversations || listConversations;
  const progress = dependencies.stderr || process.stderr;
  const coverage = buildAllScanCoverage(args);
  let channelsToScan;
  let selectionComplete = true;
  let selectionError = null;
  let selectionMetadata;
  let selectionPages;

  if (args.scanAllConversations) {
    let listed;
    try {
      listed = await list(args, {
        types: args.types,
        limit: 1000,
        maxPages: args.maxPages,
      });
    } catch (error) {
      return failedRunAll(args, error.message || String(error));
    }

    if (!listed.ok) {
      return failedRunAll(args, listed.error || "conversations_list_failed", {
        pages: args.includePages ? listed.pages : undefined,
      });
    }

    selectionComplete = !listed.cursor;
    selectionError = selectionComplete ? null : "conversation_page_limit_reached";
    selectionPages = listed.pages;
    channelsToScan = listed.items.filter((channel) => {
      if (channel.is_im || channel.is_mpim) return true;
      return channel.is_member;
    });
    selectionMetadata = {
      source: "conversations.list",
      mode: "all_joined_conversations",
      selectedConversations: channelsToScan.length,
    };
  } else {
    const counts = await fetchUnreadConversationCounts(args, dependencies);
    if (!counts.ok || !counts.complete) {
      return failedRunAll(args, counts.error || "users_counts_failed", {
        selection: {
          source: "users.counts",
          mode: "positive_unread_counts",
          status: counts.status,
          authSource: counts.authSource,
          selectedConversations: 0,
        },
      });
    }
    channelsToScan = counts.items;
    selectionMetadata = {
      source: "users.counts",
      mode: "positive_unread_counts",
      status: counts.status,
      authSource: counts.authSource,
      selectedConversations: channelsToScan.length,
    };
  }

  let notificationPreferences = null;
  if (args.excludeMuted) {
    notificationPreferences = await fetchNotificationPreferences(args, dependencies);
    if (!notificationPreferences.ok) {
      return failedRunAll(args, "mute_preferences_failed", {
        selection: selectionMetadata,
        filter: {
          muted: "exclude",
          priority: args.priority,
          ok: false,
          error: notificationPreferences.error,
          status: notificationPreferences.status,
          authSource: notificationPreferences.authSource,
        },
      });
    }
  }

  progress.write(`Scanning ${channelsToScan.length} conversations for unread messages...\n`);

  const results = [];
  const excluded = [];
  for (const channel of channelsToScan) {
    const channelLabel = channel.is_im ? "DM" : channel.is_mpim ? "MPIM" : `#${channel.name || channel.id}`;
    progress.write(`  ${channelLabel}... `);
    let channelSummary = args.scanAllConversations ? summarizeChannel(channel) : null;
    let result;

    if (args.excludeMuted) {
      const muted = notificationPreferences.mutedConversationIds.has(channel.id);
      let priority = muted && isPriorityConversation(args, channel.id, channelSummary);
      const priorityNeedsNameResolution = muted
        && !priority
        && (args.priority || []).length > 0
        && !channelSummary?.name;
      if (muted && !priority && !priorityNeedsNameResolution) {
        excluded.push(excludedMutedConversation(channel, channelSummary));
        progress.write("excluded (muted)\n");
        continue;
      }

      let info;
      try {
        info = await fetchChannelInfo(args, channel.id, dependencies);
      } catch (error) {
        result = failedChannelResult(channel.id, channelSummary, error.message || String(error));
      }

      if (!result && !info.ok) {
        result = failedChannelResult(channel.id, channelSummary, info.error);
      }

      if (!result) {
        channelSummary = channelSummary || info.channel || null;
        priority = muted && (priority || isPriorityConversation(args, channel.id, channelSummary));
        if (muted && !priority) {
          excluded.push(excludedMutedConversation(channel, channelSummary));
          progress.write("excluded (muted)\n");
          continue;
        }

        result = await processChannelWithInfo(args, channel.id, channelSummary, info, dependencies);
        result.muted = muted;
        result.priorityIncluded = priority;
      }
    } else {
      result = await processChannel(args, channel.id, channelSummary, dependencies);
    }

    result.unreadSignal = channel.unreadSignal || null;
    results.push(result);
    if (!result.ok || !result.complete) {
      progress.write(`failed (${result.error || "incomplete"})\n`);
    } else {
      progress.write(`${result.unreadCount > 0 ? result.unreadCount + " unread" : "clean"}\n`);
    }
  }

  const failedResults = results.filter((result) => !result.ok || !result.complete);
  const channelResults = results.filter((result) => (
    result.unreadSignal || result.unreadCount > 0 || !result.ok || !result.complete
  ));
  const totalUnreadMessages = channelResults.reduce((sum, channel) => sum + channel.unreadCount, 0);
  const totalCapturedUnreadMessages = channelResults.reduce((sum, channel) => sum + channel.capturedUnreadCount, 0);
  const complete = selectionComplete && failedResults.length === 0;

  return {
    ok: complete,
    complete,
    error: !selectionComplete
      ? selectionError
      : (failedResults.length > 0 ? "channel_scan_failed" : null),
    command: "all",
    mode: "dry-run",
    scannedChannels: results.length,
    successfulChannels: results.length - failedResults.length,
    failedChannels: failedResults.length,
    excludedMutedChannels: excluded.length,
    priorityIncludedChannels: results.filter((result) => result.priorityIncluded).length,
    channelsWithUnread: results.filter((result) => result.unreadCount > 0).length,
    totalUnreadMessages,
    totalCapturedUnreadMessages,
    allMarked: false,
    scope: coverage.scope,
    coverage,
    selection: selectionMetadata,
    filter: {
      muted: args.excludeMuted ? "exclude" : "include",
      priority: args.priority || [],
      ok: true,
      preferencesSource: notificationPreferences?.sources || [],
    },
    includeText: args.includeText,
    timeWindow: args.timeWindow,
    pages: args.includePages ? selectionPages : undefined,
    channels: channelResults,
    excluded,
  };
}

async function runChannel(args, dependencies = {}) {
  const resolve = dependencies.resolveChannel || resolveChannel;
  let resolved;
  try {
    resolved = await resolve(args, args.channel, {
      types: args.types,
      maxPages: args.maxPages,
    });
  } catch (error) {
    resolved = { ok: false, error: error.message || String(error), channelId: null, channel: null, candidates: [] };
  }

  if (!resolved.ok) {
    return {
      ok: false,
      complete: false,
      error: resolved.error,
      command: "channel",
      mode: "dry-run",
      channelId: resolved.channelId || null,
      channel: resolved.channel || null,
      candidates: resolved.candidates,
      scannedChannels: 0,
      successfulChannels: 0,
      failedChannels: 1,
      channelsWithUnread: 0,
      totalUnreadMessages: 0,
      totalCapturedUnreadMessages: 0,
      allMarked: false,
      channels: [],
    };
  }

  const result = await processChannel(args, resolved.channelId, resolved.channel, dependencies);
  const succeeded = result.ok && result.complete;

  return {
    ok: succeeded,
    complete: succeeded,
    error: result.error,
    command: "channel",
    mode: "dry-run",
    scannedChannels: 1,
    successfulChannels: succeeded ? 1 : 0,
    failedChannels: succeeded ? 0 : 1,
    channelsWithUnread: result.unreadCount > 0 ? 1 : 0,
    totalUnreadMessages: result.unreadCount,
    totalCapturedUnreadMessages: result.capturedUnreadCount,
    allMarked: false,
    includeText: args.includeText,
    timeWindow: args.timeWindow,
    channels: result.unreadCount > 0 || !succeeded ? [result] : [],
  };
}

async function markChannelRead(args, channelId, timestamp, dependencies = {}) {
  const callSlackApi = dependencies.slackApiCall || slackApiCall;
  const { response, json } = await callSlackApi(args, "conversations.mark", {
    channel: channelId,
    ts: timestamp,
  });
  if (!json || typeof json !== "object") {
    return {
      ok: false,
      status: response?.status ?? null,
      error: "invalid_conversations_mark_response",
      channelId,
      markedTs: timestamp,
    };
  }
  return {
    ok: Boolean(json.ok),
    status: response?.status ?? null,
    error: json.error || null,
    channelId,
    markedTs: timestamp,
  };
}

async function markChannelThrough(args, channelId, channelSummary, dependencies = {}) {
  let info;
  try {
    info = await fetchChannelInfo(args, channelId, dependencies);
  } catch (error) {
    return failedChannelResult(channelId, channelSummary, error.message || String(error));
  }

  if (!info.ok) return failedChannelResult(channelId, channelSummary, info.error);
  if (!info.lastRead) return failedChannelResult(channelId, channelSummary, "missing_last_read");

  try {
    parseSlackTimestamp(info.lastRead, "Slack last_read", { allowZero: true });
  } catch {
    return failedChannelResult(channelId, channelSummary, "invalid_last_read", info.lastRead);
  }

  if (args.ifLastRead
    && compareSlackTimestamps(info.lastRead, args.ifLastRead) !== 0) {
    return {
      ...failedChannelResult(channelId, channelSummary, "last_read_changed", info.lastRead),
      throughTs: args.throughTs,
      expectedLastRead: args.ifLastRead,
    };
  }

  if (compareSlackTimestamps(info.lastRead, args.throughTs) >= 0) {
    return {
      channelId,
      channel: channelSummary || null,
      ok: true,
      complete: true,
      error: null,
      lastRead: info.lastRead,
      throughTs: args.throughTs,
      expectedLastRead: args.ifLastRead || null,
      snapshotThroughTs: null,
      unreadCount: 0,
      capturedUnreadCount: 0,
      messages: [],
      marked: false,
      alreadyRead: true,
      markResult: null,
      hasMore: false,
    };
  }

  let markResult;
  try {
    markResult = await markChannelRead(args, channelId, args.throughTs, dependencies);
  } catch (error) {
    return {
      ...failedChannelResult(channelId, channelSummary, error.message || String(error), info.lastRead),
      throughTs: args.throughTs,
      expectedLastRead: args.ifLastRead || null,
    };
  }

  return {
    channelId,
    channel: channelSummary || null,
    ok: markResult.ok,
    complete: markResult.ok,
    error: markResult.error,
    lastRead: info.lastRead,
    throughTs: args.throughTs,
    expectedLastRead: args.ifLastRead || null,
    snapshotThroughTs: null,
    unreadCount: 0,
    capturedUnreadCount: 0,
    messages: [],
    marked: markResult.ok,
    alreadyRead: false,
    markResult,
    hasMore: false,
  };
}

async function runMarkChannel(args, dependencies = {}) {
  const resolve = dependencies.resolveChannel || resolveChannel;
  let resolved;
  try {
    resolved = await resolve(args, args.channel, {
      types: args.types,
      maxPages: args.maxPages,
    });
  } catch (error) {
    resolved = { ok: false, error: error.message || String(error), channelId: null, channel: null, candidates: [] };
  }

  if (!resolved.ok) {
    return {
      ok: false,
      complete: false,
      error: resolved.error,
      command: "channel",
      mode: "mark",
      channelId: resolved.channelId || null,
      channel: resolved.channel || null,
      candidates: resolved.candidates,
      throughTs: args.throughTs,
      expectedLastRead: args.ifLastRead || null,
      allMarked: false,
      channels: [],
    };
  }

  const result = await markChannelThrough(args, resolved.channelId, resolved.channel, dependencies);
  const succeeded = result.ok && result.complete;
  return {
    ok: succeeded,
    complete: succeeded,
    error: result.error,
    command: "channel",
    mode: "mark",
    channelId: resolved.channelId,
    channel: resolved.channel,
    throughTs: args.throughTs,
    expectedLastRead: args.ifLastRead || null,
    allMarked: succeeded && (result.marked || result.alreadyRead),
    channels: [result],
  };
}

function exitCodeForOutput(output) {
  return output?.ok && output.complete !== false ? 0 : 1;
}

async function writeOutputFile(file, serialized, dependencies = {}) {
  const fileSystem = dependencies.fs || fs;
  await fileSystem.mkdir(path.dirname(file), { recursive: true });
  const handle = await fileSystem.open(file, "w", 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(serialized);
  } finally {
    await handle.close();
  }
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const args = parseArgs(argv);
  const authenticate = dependencies.loadAuth || loadAuth;
  args.auth = await authenticate(args);

  const output = args.mark
    ? await runMarkChannel(args, dependencies)
    : args.command === "channel"
      ? await runChannel(args, dependencies)
      : await runAll(args, dependencies);

  const serialized = `${JSON.stringify(output, null, 2)}\n`;
  if (args.out) {
    await writeOutputFile(args.out, serialized, dependencies);
  } else {
    process.stdout.write(serialized);
  }
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
  buildAllScanCoverage,
  compareSlackTimestamps,
  exitCodeForOutput,
  fetchChannelInfo,
  fetchNotificationPreferences,
  fetchUnreadConversationCounts,
  fetchUnreadMessages,
  extractMutedConversationIds,
  extractUnreadConversationCounts,
  isPriorityConversation,
  main,
  markChannelRead,
  markChannelThrough,
  parseArgs,
  parseSlackTimestamp,
  processChannel,
  processChannelWithInfo,
  runAll,
  runChannel,
  runMarkChannel,
  writeOutputFile,
};
