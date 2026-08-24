const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildOutput,
  exitCodeForOutput,
  fetchThreadReplies,
  parseArgs,
} = require("../slack-api-read.cjs");

function args(overrides = {}) {
  return {
    channel: "C123",
    ts: "300.000003",
    threadTs: "100.000001",
    limit: 2,
    maxPages: 10,
    includeText: true,
    ...overrides,
  };
}

function response(json) {
  return {
    response: { status: 200 },
    json,
    auth: { source: "cache" },
  };
}

test("fetchThreadReplies follows response_metadata.next_cursor through every page", async () => {
  const calls = [];
  const result = await fetchThreadReplies(args(), {
    slackApiCall: async (_args, method, params) => {
      assert.equal(method, "conversations.replies");
      calls.push(params);
      if (!params.cursor) {
        return response({
          ok: true,
          messages: [{ ts: "100.000001" }, { ts: "200.000002" }],
          has_more: true,
          response_metadata: { next_cursor: "page-2" },
        });
      }
      return response({
        ok: true,
        messages: [{ ts: "300.000003" }],
        has_more: false,
        response_metadata: { next_cursor: "" },
      });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.equal(result.hasMore, false);
  assert.equal(result.pages.length, 2);
  assert.equal(result.messages.length, 3);
  assert.equal(calls[1].cursor, "page-2");

  const output = buildOutput(args(), result);
  assert.equal(output.messageCount, 3);
  assert.equal(output.pageCount, 2);
  assert.equal(output.target.ts, "300.000003");
  assert.equal(exitCodeForOutput(output), 0);
});

test("fetchThreadReplies reports incomplete and fails when the page cap is reached", async () => {
  const result = await fetchThreadReplies(args({ maxPages: 1 }), {
    slackApiCall: async () => response({
      ok: true,
      messages: [{ ts: "100.000001" }],
      has_more: true,
      response_metadata: { next_cursor: "page-2" },
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.complete, false);
  assert.equal(result.error, "replies_page_limit_reached");
  assert.equal(result.hasMore, true);
  assert.equal(result.nextCursor, "page-2");
  assert.equal(exitCodeForOutput(buildOutput(args(), result)), 1);
});

test("fetchThreadReplies fails closed when has_more lacks a next cursor", async () => {
  const result = await fetchThreadReplies(args(), {
    slackApiCall: async () => response({
      ok: true,
      messages: [{ ts: "100.000001" }],
      has_more: true,
      response_metadata: { next_cursor: "" },
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.complete, false);
  assert.equal(result.error, "replies_next_cursor_missing");
  assert.equal(exitCodeForOutput(buildOutput(args(), result)), 1);
});

test("fetchThreadReplies preserves partial messages on a later API failure", async () => {
  const result = await fetchThreadReplies(args(), {
    slackApiCall: async (_args, _method, params) => {
      if (!params.cursor) {
        return response({
          ok: true,
          messages: [{ ts: "100.000001" }],
          response_metadata: { next_cursor: "page-2" },
        });
      }
      return response({ ok: false, error: "ratelimited" });
    },
  });

  const output = buildOutput(args(), result);
  assert.equal(output.ok, false);
  assert.equal(output.complete, false);
  assert.equal(output.error, "ratelimited");
  assert.equal(output.messageCount, 1);
  assert.equal(exitCodeForOutput(output), 1);
});

test("read argument validation accepts page controls and rejects invalid values", () => {
  const parsed = parseArgs([
    "--channel",
    "C123",
    "--ts",
    "300.000003",
    "--limit",
    "25",
    "--max-pages",
    "4",
  ]);
  assert.equal(parsed.limit, 25);
  assert.equal(parsed.maxPages, 4);
  assert.throws(
    () => parseArgs(["--channel", "C123", "--ts", "300.000003", "--max-pages", "0"]),
    /--max-pages must be an integer >= 1/,
  );
});
