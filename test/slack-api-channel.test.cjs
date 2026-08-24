const assert = require("node:assert/strict");
const test = require("node:test");

const {
  parseArgs,
  runHistory,
  runReplies,
} = require("../slack-api-channel.cjs");

function resolvedChannel() {
  return {
    ok: true,
    error: null,
    channelId: "C123",
    channel: { id: "C123", name: "general" },
    candidates: [],
  };
}

function response(json) {
  return {
    response: { status: 200 },
    json,
    auth: { source: "cache" },
  };
}

test("channel history returns parent messages only and makes reply exclusion explicit", async () => {
  const calls = [];
  const args = parseArgs([
    "history",
    "--channel",
    "C123",
    "--workspace",
    "https://example.slack.com",
    "--include-text",
  ]);
  const output = await runHistory(args, {
    resolveChannel: async () => resolvedChannel(),
    slackApiCall: async (_args, method, params) => {
      calls.push({ method, params });
      return response({
        ok: true,
        has_more: false,
        messages: [{
          user: "U123",
          ts: "100.000001",
          text: "Thread parent",
          reply_count: 2,
        }],
      });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "conversations.history");
  assert.equal(output.messageScope, "channel_history_parents_only");
  assert.equal(output.threadRepliesIncluded, false);
  assert.match(output.threadRepliesHint, /channel replies/);
  assert.equal(output.messageCount, 1);
  assert.equal(output.messages[0].replyCount, 2);
  assert.equal(output.messages[0].text, "Thread parent");
});

test("channel replies retrieves every paginated thread message with read redaction semantics", async () => {
  const calls = [];
  const args = parseArgs([
    "replies",
    "--channel",
    "C123",
    "--thread-ts",
    "100.000001",
    "--limit",
    "2",
  ]);
  const output = await runReplies(args, {
    resolveChannel: async () => resolvedChannel(),
    slackApiCall: async (_args, method, params) => {
      assert.equal(method, "conversations.replies");
      calls.push(params);
      if (!params.cursor) {
        return response({
          ok: true,
          messages: [
            { user: "U123", ts: "100.000001", text: "Thread parent" },
            { user: "U234", ts: "200.000002", thread_ts: "100.000001", text: "First reply" },
          ],
          has_more: true,
          response_metadata: { next_cursor: "page-2" },
        });
      }
      return response({
        ok: true,
        messages: [
          { user: "U345", ts: "300.000003", thread_ts: "100.000001", text: "Second reply" },
        ],
        has_more: false,
        response_metadata: { next_cursor: "" },
      });
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].cursor, "page-2");
  assert.equal(output.ok, true);
  assert.equal(output.complete, true);
  assert.equal(output.messageScope, "full_thread");
  assert.equal(output.threadRepliesIncluded, true);
  assert.equal(output.messageCount, 3);
  assert.equal(output.pageCount, 2);
  assert.equal(output.rootTs, "100.000001");
  assert.equal(output.messages[2].text, "[redacted; rerun with --include-text to save message text]");
});

test("channel replies requires an explicit thread root timestamp", () => {
  assert.throws(
    () => parseArgs(["replies", "--channel", "C123"]),
    /--thread-ts is required for channel replies/,
  );
});
