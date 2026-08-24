const assert = require("node:assert/strict");
const test = require("node:test");

const {
  exitCodeForOutput,
  extractMutedConversationIds,
  fetchUnreadMessages,
  markChannelThrough,
  parseArgs,
  processChannel,
  runAll,
  runMarkChannel,
  writeOutputFile,
} = require("../slack-api-mark-read.cjs");

function scanArgs(overrides = {}) {
  return {
    workspace: "https://example.slack.com",
    types: "public_channel,private_channel,im,mpim",
    limit: 2,
    maxPages: 20,
    maxMessagePages: 10,
    since: "",
    sinceTs: "",
    untilTs: "",
    includeText: true,
    includePages: true,
    scanAllConversations: false,
    excludeMuted: false,
    priority: [],
    timeWindow: { sinceTs: null, untilTs: null },
    ...overrides,
  };
}

function markArgs(overrides = {}) {
  return scanArgs({
    command: "channel",
    channel: "C123",
    mark: true,
    throughTs: "300.000003",
    ifLastRead: "100.000001",
    ...overrides,
  });
}

function okResponse(json) {
  return { response: { status: 200 }, json };
}

test("fetchUnreadMessages follows cursor pagination before declaring a scan complete", async () => {
  const calls = [];
  const result = await fetchUnreadMessages(
    scanArgs(),
    "C123",
    "100.000001",
    {
      slackApiCall: async (_args, method, params) => {
        assert.equal(method, "conversations.history");
        calls.push(params);
        if (!params.cursor) {
          return okResponse({
            ok: true,
            messages: [{ ts: "300.000003" }, { ts: "200.000002" }],
            has_more: true,
            response_metadata: { next_cursor: "page-2" },
          });
        }
        return okResponse({
          ok: true,
          messages: [{ ts: "150.000001" }],
          has_more: false,
          response_metadata: { next_cursor: "" },
        });
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.equal(result.hasMore, false);
  assert.equal(result.snapshotThroughTs, "300.000003");
  assert.deepEqual(result.messages.map((message) => message.ts), [
    "300.000003",
    "200.000002",
    "150.000001",
  ]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].cursor, "page-2");
});

test("fetchUnreadMessages falls back to time pagination when Slack omits a cursor", async () => {
  const calls = [];
  const result = await fetchUnreadMessages(
    scanArgs(),
    "C123",
    "100.000001",
    {
      slackApiCall: async (_args, _method, params) => {
        calls.push(params);
        if (!params.latest) {
          return okResponse({
            ok: true,
            messages: [{ ts: "300.000003" }, { ts: "200.000002" }],
            has_more: true,
          });
        }
        return okResponse({
          ok: true,
          messages: [{ ts: "150.000001" }],
          has_more: false,
        });
      },
    },
  );

  assert.equal(result.complete, true);
  assert.equal(calls[1].latest, "200.000002");
  assert.equal(calls[1].oldest, "100.000001");
});

test("fetchUnreadMessages fails closed when the history page cap is reached", async () => {
  let calls = 0;
  const result = await fetchUnreadMessages(
    scanArgs({ maxMessagePages: 1 }),
    "C123",
    "100.000001",
    {
      slackApiCall: async () => {
        calls += 1;
        return okResponse({
          ok: true,
          messages: [{ ts: "300.000003" }],
          has_more: true,
          response_metadata: { next_cursor: "page-2" },
        });
      },
    },
  );

  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.complete, false);
  assert.equal(result.error, "history_page_limit_reached");
  assert.equal(result.hasMore, true);
});

test("processChannel refuses to infer unread state when last_read is missing", async () => {
  const methods = [];
  const result = await processChannel(
    scanArgs(),
    "C123",
    { id: "C123", name: "general" },
    {
      slackApiCall: async (_args, method) => {
        methods.push(method);
        return okResponse({ ok: true, channel: {} });
      },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.complete, false);
  assert.equal(result.error, "missing_last_read");
  assert.deepEqual(methods, ["conversations.info"]);
});

test("runAll retains channel failures and exits unsuccessfully", async () => {
  const result = await runAll(
    scanArgs(),
    {
      stderr: { write() {} },
      slackApiCall: async (_args, method, params) => {
        if (method === "users.counts") {
          return okResponse({
            ok: true,
            channels: [
              { id: "C_OK", unread_count: 1 },
              { id: "C_FAIL", unread_count_display: 1 },
            ],
          });
        }
        if (method === "conversations.info" && params.channel === "C_FAIL") {
          return okResponse({ ok: false, error: "ratelimited" });
        }
        if (method === "conversations.info") {
          return okResponse({ ok: true, channel: { last_read: "100.000001" } });
        }
        return okResponse({ ok: true, messages: [], has_more: false });
      },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.complete, false);
  assert.equal(result.error, "channel_scan_failed");
  assert.equal(result.failedChannels, 1);
  assert.equal(result.channels.length, 2);
  const failedChannel = result.channels.find((channel) => channel.channelId === "C_FAIL");
  assert.equal(failedChannel.error, "ratelimited");
  assert.equal(result.selection.source, "users.counts");
  assert.equal(result.coverage.activityNotifications, false);
  assert.equal(result.coverage.threadNotifications, false);
  assert.equal(exitCodeForOutput(result), 1);
});

test("runAll scans only positive users.counts channel and DM entries", async () => {
  const methods = [];
  const result = await runAll(scanArgs(), {
    stderr: { write() {} },
    listConversations: async () => {
      throw new Error("conversations.list should not be called in counts mode");
    },
    slackApiCall: async (_args, method, params) => {
      methods.push([method, params.channel || null]);
      if (method === "users.counts") {
        return okResponse({
          ok: true,
          channels: [
            { id: "C_POSITIVE", unread_count: 2 },
            { id: "C_ZERO", unread_count: 0, unread_count_display: 0 },
          ],
          ims: [
            { id: "D_POSITIVE", dm_count: "1" },
            { id: "D_ZERO", dm_count: 0 },
          ],
        });
      }
      if (method === "conversations.info") {
        return okResponse({
          ok: true,
          channel: {
            id: params.channel,
            is_im: params.channel.startsWith("D"),
            last_read: "100.000001",
          },
        });
      }
      return okResponse({
        ok: true,
        messages: [{ ts: params.channel.startsWith("D") ? "300.000003" : "200.000002" }],
        has_more: false,
      });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.equal(result.scannedChannels, 2);
  assert.equal(result.selection.selectedConversations, 2);
  assert.deepEqual(
    methods.filter(([method]) => method === "conversations.info").map(([, channel]) => channel),
    ["C_POSITIVE", "D_POSITIVE"],
  );
  assert.equal(result.channels.some((channel) => channel.channelId === "C_ZERO"), false);
  assert.equal(result.channels.some((channel) => channel.channelId === "D_ZERO"), false);
  assert.equal(result.scope, "conversation_timeline_and_dm_unread");
  assert.equal(result.coverage.conversationTimelineUnread, true);
  assert.equal(result.coverage.directMessageUnread, true);
});

test("runAll treats all-zero users.counts as a complete empty snapshot", async () => {
  const methods = [];
  const result = await runAll(scanArgs(), {
    stderr: { write() {} },
    slackApiCall: async (_args, method) => {
      methods.push(method);
      return okResponse({
        ok: true,
        channels: [{ id: "C_ZERO", unread_count: 0, unread_count_display: 0 }],
        ims: [{ id: "D_ZERO", dm_count: 0 }],
      });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.equal(result.scannedChannels, 0);
  assert.equal(result.selection.selectedConversations, 0);
  assert.deepEqual(methods, ["users.counts"]);
});

test("extractMutedConversationIds supports modern object and legacy preference shapes", () => {
  const result = extractMutedConversationIds({
    all_notifications_prefs: JSON.stringify({
      channels: {
        C_MUTED: { muted: true },
        C_STRING: { muted: "1" },
        C_LOUD: { muted: false },
      },
    }),
    muted_channels: "C_LEGACY,C_MUTED",
  });

  assert.deepEqual([...result.mutedConversationIds].sort(), [
    "C_LEGACY",
    "C_MUTED",
    "C_STRING",
  ]);
  assert.deepEqual(result.sources, ["all_notifications_prefs", "muted_channels"]);

  const arrayResult = extractMutedConversationIds({
    all_notifications_prefs: {
      channels: [
        { id: "C_ARRAY", muted: 1 },
        { channel_id: "C_NOT_MUTED", muted: 0 },
      ],
    },
  });
  assert.deepEqual([...arrayResult.mutedConversationIds], ["C_ARRAY"]);
});

test("runAll excludes muted conversations before history and lets priority names override", async () => {
  const calls = [];
  const names = {
    C_MUTED: "low-signal",
    C_PRIORITY: "product",
    C_NORMAL: "general",
  };
  const result = await runAll(
    scanArgs({ excludeMuted: true, priority: ["#product"] }),
    {
      stderr: { write() {} },
      slackApiCall: async (_args, method, params) => {
        calls.push([method, params.channel || null]);
        if (method === "users.counts") {
          return okResponse({
            ok: true,
            channels: Object.keys(names).map((id) => ({ id, unread_count: 1 })),
          });
        }
        if (method === "users.prefs.get") {
          return okResponse({
            ok: true,
            prefs: {
              all_notifications_prefs: JSON.stringify({
                channels: {
                  C_MUTED: { muted: true },
                  C_PRIORITY: { muted: true },
                },
              }),
            },
          });
        }
        if (method === "conversations.info") {
          return okResponse({
            ok: true,
            channel: { id: params.channel, name: names[params.channel], last_read: "100.000001" },
          });
        }
        assert.equal(method, "conversations.history");
        return okResponse({
          ok: true,
          messages: [{ ts: "200.000002" }],
          has_more: false,
        });
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.selection.selectedConversations, 3);
  assert.equal(result.scannedChannels, 2);
  assert.equal(result.excludedMutedChannels, 1);
  assert.equal(result.priorityIncludedChannels, 1);
  assert.deepEqual(result.excluded.map((item) => item.channelId), ["C_MUTED"]);
  assert.deepEqual(
    calls.filter(([method]) => method === "conversations.history").map(([, channel]) => channel),
    ["C_PRIORITY", "C_NORMAL"],
  );
  assert.equal(calls.filter(([method]) => method === "users.prefs.get").length, 1);
  assert.equal(result.channels.find((item) => item.channelId === "C_PRIORITY").priorityIncluded, true);
});

test("runAll excludes definitely muted conversations before channel metadata resolution", async () => {
  const calls = [];
  const result = await runAll(scanArgs({ excludeMuted: true }), {
    stderr: { write() {} },
    slackApiCall: async (_args, method, params) => {
      calls.push([method, params.channel || null]);
      if (method === "users.counts") {
        return okResponse({
          ok: true,
          channels: [
            { id: "C_STALE_MUTED", unread_count: 1 },
            { id: "C_NORMAL", unread_count: 1 },
          ],
        });
      }
      if (method === "users.prefs.get") {
        return okResponse({
          ok: true,
          prefs: {
            all_notifications_prefs: JSON.stringify({
              channels: { C_STALE_MUTED: { muted: true } },
            }),
          },
        });
      }
      if (method === "conversations.info") {
        assert.equal(params.channel, "C_NORMAL");
        return okResponse({
          ok: true,
          channel: { id: "C_NORMAL", name: "general", last_read: "100.000001" },
        });
      }
      assert.equal(method, "conversations.history");
      assert.equal(params.channel, "C_NORMAL");
      return okResponse({ ok: true, messages: [{ ts: "200.000002" }], has_more: false });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.excludedMutedChannels, 1);
  assert.deepEqual(result.excluded.map((item) => item.channelId), ["C_STALE_MUTED"]);
  assert.equal(calls.some(([method, channel]) => method === "conversations.info" && channel === "C_STALE_MUTED"), false);
});

test("runAll fails closed when Slack exposes no recognized mute preference source", async () => {
  const methods = [];
  const result = await runAll(scanArgs({ excludeMuted: true }), {
    stderr: { write() {} },
    slackApiCall: async (_args, method) => {
      methods.push(method);
      if (method === "users.counts") {
        return okResponse({ ok: true, channels: [{ id: "C123", unread_count: 1 }] });
      }
      return okResponse({ ok: true, prefs: { unrelated_preference: true } });
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "mute_preferences_failed");
  assert.equal(result.filter.error, "mute_preference_source_missing");
  assert.deepEqual(methods, ["users.counts", "users.prefs.get"]);
  assert.equal(exitCodeForOutput(result), 1);
});

test("runAll fails closed before history when mute preferences cannot be parsed", async () => {
  const methods = [];
  const result = await runAll(scanArgs({ excludeMuted: true }), {
    stderr: { write() {} },
    slackApiCall: async (_args, method) => {
      methods.push(method);
      if (method === "users.counts") {
        return okResponse({ ok: true, channels: [{ id: "C123", unread_count: 1 }] });
      }
      return okResponse({
        ok: true,
        prefs: { all_notifications_prefs: "not-json" },
      });
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "mute_preferences_failed");
  assert.equal(result.filter.error, "invalid_all_notifications_prefs");
  assert.deepEqual(methods, ["users.counts", "users.prefs.get"]);
  assert.equal(exitCodeForOutput(result), 1);
});

test("runAll fails closed when users.counts fails", async () => {
  const result = await runAll(scanArgs(), {
    stderr: { write() {} },
    slackApiCall: async () => okResponse({ ok: false, error: "ratelimited" }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.complete, false);
  assert.equal(result.error, "ratelimited");
  assert.equal(result.scannedChannels, 0);
  assert.equal(exitCodeForOutput(result), 1);
});

test("runAll reports an incomplete conversations.list traversal", async () => {
  const result = await runAll(scanArgs({ scanAllConversations: true }), {
    stderr: { write() {} },
    listConversations: async () => ({
      ok: true,
      cursor: "still-more",
      pages: [],
      items: [],
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.complete, false);
  assert.equal(result.error, "conversation_page_limit_reached");
  assert.equal(exitCodeForOutput(result), 1);
});

test("exact mark uses the stored timestamp and precondition without scanning history", async () => {
  const calls = [];
  const args = markArgs();
  const result = await runMarkChannel(args, {
    resolveChannel: async () => ({
      ok: true,
      channelId: "C123",
      channel: { id: "C123", name: "general" },
      candidates: [],
    }),
    slackApiCall: async (_args, method, params) => {
      calls.push({ method, params });
      if (method === "conversations.info") {
        return okResponse({ ok: true, channel: { last_read: "100.000001" } });
      }
      assert.equal(method, "conversations.mark");
      return okResponse({ ok: true });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.equal(result.allMarked, true);
  assert.deepEqual(calls.map((call) => call.method), [
    "conversations.info",
    "conversations.mark",
  ]);
  assert.equal(calls[1].params.ts, "300.000003");
});

test("exact mark fails without mutating when last_read changed", async () => {
  const methods = [];
  const result = await markChannelThrough(
    markArgs(),
    "C123",
    { id: "C123" },
    {
      slackApiCall: async (_args, method) => {
        methods.push(method);
        return okResponse({ ok: true, channel: { last_read: "200.000002" } });
      },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.complete, false);
  assert.equal(result.error, "last_read_changed");
  assert.deepEqual(methods, ["conversations.info"]);
});

test("exact mark never moves a cursor backward", async () => {
  const methods = [];
  const result = await markChannelThrough(
    markArgs({ ifLastRead: "", throughTs: "200.000002" }),
    "C123",
    { id: "C123" },
    {
      slackApiCall: async (_args, method) => {
        methods.push(method);
        return okResponse({ ok: true, channel: { last_read: "300.000003" } });
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.alreadyRead, true);
  assert.equal(result.marked, false);
  assert.deepEqual(methods, ["conversations.info"]);
});

test("mark API errors fail closed and produce a nonzero output status", async () => {
  const result = await runMarkChannel(markArgs(), {
    resolveChannel: async () => ({
      ok: true,
      channelId: "C123",
      channel: { id: "C123" },
      candidates: [],
    }),
    slackApiCall: async (_args, method) => {
      if (method === "conversations.info") {
        return okResponse({ ok: true, channel: { last_read: "100.000001" } });
      }
      return okResponse({ ok: false, error: "ratelimited" });
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.complete, false);
  assert.equal(result.error, "ratelimited");
  assert.equal(result.allMarked, false);
  assert.equal(exitCodeForOutput(result), 1);
});

test("argument validation rejects broad or time-filtered mutation", () => {
  assert.throws(
    () => parseArgs(["--mark", "--through-ts", "300.000003"]),
    /limited to one channel/,
  );
  assert.throws(
    () => parseArgs([
      "channel",
      "--channel",
      "C123",
      "--mark",
      "--through-ts",
      "300.000003",
      "--since",
      "1h",
    ]),
    /Time filters cannot be used with --mark/,
  );
  assert.throws(
    () => parseArgs(["channel", "--channel", "C123", "--mark"]),
    /--through-ts/,
  );
  assert.throws(
    () => parseArgs(["--priority", "general"]),
    /requires --exclude-muted/,
  );
  assert.throws(
    () => parseArgs(["channel", "--channel", "C123", "--exclude-muted"]),
    /only valid for mark-read all/,
  );
});

test("argument parsing accepts repeatable and comma-separated priority channels", () => {
  const args = parseArgs([
    "--exclude-muted",
    "--priority",
    "#general,C123",
    "--priority",
    "product",
  ]);

  assert.equal(args.excludeMuted, true);
  assert.deepEqual(args.priority, ["#general", "C123", "product"]);
});

test("a permalink supplies the exact mark target", () => {
  const args = parseArgs([
    "channel",
    "--link",
    "https://example.slack.com/archives/C0123456789/p1778784641394639",
    "--mark",
  ]);

  assert.equal(args.channel, "C0123456789");
  assert.equal(args.throughTs, "1778784641.394639");
});

test("writeOutputFile requests and enforces owner-only permissions", async () => {
  const operations = [];
  const handle = {
    chmod: async (mode) => operations.push(["chmod", mode]),
    writeFile: async (contents) => operations.push(["writeFile", contents]),
    close: async () => operations.push(["close"]),
  };
  const fakeFs = {
    mkdir: async (directory, options) => operations.push(["mkdir", directory, options]),
    open: async (file, flags, mode) => {
      operations.push(["open", file, flags, mode]);
      return handle;
    },
  };

  await writeOutputFile("/tmp/slack-observer/output.json", "{}\n", { fs: fakeFs });

  assert.deepEqual(operations[1], [
    "open",
    "/tmp/slack-observer/output.json",
    "w",
    0o600,
  ]);
  assert.deepEqual(operations[2], ["chmod", 0o600]);
  assert.deepEqual(operations.at(-1), ["close"]);
});
