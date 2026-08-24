const test = require("node:test");
const assert = require("node:assert/strict");
const { slackApiCall } = require("../slack-api-common.cjs");
const { SlackThreadClient } = require("../slack-api-session-slack.cjs");

function response(json) {
  return { json, response: { status: 200 }, auth: { source: "test" } };
}

test("createThread posts a new root and returns its automatic thread binding", async () => {
  const calls = [];
  const client = new SlackThreadClient({
    workspace: "https://example.slack.com",
  }, {
    async loadAuth() {
      return { source: "test", token: "hidden", cookieHeader: "hidden" };
    },
    async slackApiCall(args, method, params) {
      calls.push({ method, params });
      if (method === "auth.test") {
        return response({ ok: true, user_id: "U_OWNER", team_id: "T1" });
      }
      if (method === "chat.postMessage") {
        return response({
          ok: true,
          channel: "C123AGENT",
          ts: "1778784641.394639",
          message: { ts: "1778784641.394639", user: "U_OWNER", text: params.text },
        });
      }
      throw new Error(`Unexpected method: ${method}`);
    },
  });
  const created = await client.createThread({
    channel: "C123AGENT",
    text: "Agent session started",
  });
  assert.equal(created.channelId, "C123AGENT");
  assert.equal(created.threadTs, "1778784641.394639");
  assert.equal(created.ownerUserId, "U_OWNER");
  assert.match(created.permalink, /archives\/C123AGENT\/p1778784641394639/);
  assert.deepEqual(calls.map((call) => call.method), ["auth.test", "chat.postMessage"]);
  assert.equal("thread_ts" in calls[1].params, false);
});

test("createThread resolves a channel name before posting", async () => {
  const calls = [];
  const client = new SlackThreadClient({
    workspace: "https://example.slack.com",
  }, {
    async loadAuth() { return { source: "test" }; },
    async resolveChannel(args, value) {
      assert.equal(value, "#agent-sessions");
      return { ok: true, channelId: "C_RESOLVED", channel: { id: "C_RESOLVED", name: "agent-sessions" } };
    },
    async slackApiCall(args, method, params) {
      calls.push({ method, params });
      if (method === "auth.test") return response({ ok: true, user_id: "U_OWNER", team_id: "T1" });
      if (method === "chat.postMessage") {
        return response({ ok: true, channel: "C_RESOLVED", ts: "1778784641.394639" });
      }
      throw new Error(`Unexpected method: ${method}`);
    },
  });
  const created = await client.createThread({
    channel: "#agent-sessions",
    text: "Started",
  });
  assert.equal(created.channelId, "C_RESOLVED");
  assert.equal(calls[1].params.channel, "C_RESOLVED");
});

test("createThread resolves me through auth.test and conversations.open before posting", async () => {
  const calls = [];
  const client = new SlackThreadClient({
    workspace: "https://example.slack.com",
  }, {
    async loadAuth() { return { source: "test" }; },
    async slackApiCall(args, method, params) {
      calls.push({ method, params });
      if (method === "auth.test") {
        return response({ ok: true, user_id: "U_OWNER", user: "Owner", team_id: "T1" });
      }
      if (method === "conversations.open") {
        return response({ ok: true, channel: { id: "D_SELF", is_im: true } });
      }
      if (method === "chat.postMessage") {
        return response({ ok: true, channel: "D_SELF", ts: "1778784641.394639" });
      }
      throw new Error(`Unexpected method: ${method}`);
    },
  });

  const created = await client.createThread({ channel: "me", text: "Started" });
  assert.equal(created.channelId, "D_SELF");
  assert.deepEqual(calls.map((call) => call.method), [
    "auth.test",
    "conversations.open",
    "chat.postMessage",
  ]);
  assert.deepEqual(calls[1].params, { users: "U_OWNER", return_im: true });
  assert.equal(calls[2].params.channel, "D_SELF");
});

test("self-DM resolution failure occurs before any root message mutation", async () => {
  const calls = [];
  const client = new SlackThreadClient({
    workspace: "https://example.slack.com",
  }, {
    async loadAuth() { return { source: "test" }; },
    async slackApiCall(args, method) {
      calls.push(method);
      if (method === "auth.test") return response({ ok: true, user_id: "U_OWNER" });
      if (method === "conversations.open") return response({ ok: false, error: "cannot_dm_bot" });
      throw new Error(`Unexpected method: ${method}`);
    },
  });

  await assert.rejects(
    client.createThread({ channel: "self", text: "Started" }),
    /Could not resolve.*self-DM.*cannot_dm_bot/,
  );
  assert.deepEqual(calls, ["auth.test", "conversations.open"]);
});

test("createThread requires only a destination, never a thread or session id", async () => {
  const client = new SlackThreadClient({ workspace: "https://example.slack.com" }, {
    async loadAuth() { return { source: "test" }; },
    async slackApiCall() {
      return response({ ok: true, user_id: "U_OWNER", team_id: "T1" });
    },
  });
  await assert.rejects(client.createThread({ text: "Started" }), /--channel is required/);
});

test("session root length uses Slack characters rather than UTF-16 code units", async () => {
  let posts = 0;
  const client = new SlackThreadClient({
    workspace: "https://example.slack.com",
  }, {
    async slackApiCall(args, method) {
      assert.equal(method, "chat.postMessage");
      posts += 1;
      return response({
        ok: true,
        channel: "D_SELF",
        ts: "1778784641.394639",
        message: { ts: "1778784641.394639", user: "U_OWNER" },
      });
    },
  });
  const options = {
    identity: { user_id: "U_OWNER", team_id: "T1" },
    destination: { channelId: "D_SELF", channel: { id: "D_SELF" } },
  };

  const accepted = await client.createThread({
    ...options,
    text: "😀".repeat(40_000),
  });
  assert.equal(accepted.threadTs, "1778784641.394639");
  await assert.rejects(
    client.createThread({
      ...options,
      text: "😀".repeat(40_001),
    }),
    /exceeds Slack's 40,000-character limit/,
  );
  assert.equal(posts, 1);
});

test("createThread sends a stable client id and reconciles it without a second post", async () => {
  const calls = [];
  const clientMessageId = "11111111-1111-4111-8111-111111111111";
  const client = new SlackThreadClient({
    workspace: "https://example.slack.com",
  }, {
    async slackApiCall(args, method, params) {
      calls.push({ method, params });
      if (method === "conversations.history") {
        return response({
          ok: true,
          messages: [{
            ts: "1778784641.394639",
            user: "U_OWNER",
            text: "Started",
            client_msg_id: clientMessageId,
          }],
          response_metadata: { next_cursor: "" },
        });
      }
      throw new Error(`Unexpected method: ${method}`);
    },
  });

  const created = await client.createThread({
    text: "Started",
    identity: { user_id: "U_OWNER", team_id: "T1" },
    destination: { channelId: "D_SELF", channel: { id: "D_SELF" } },
    clientMessageId,
    reconcile: true,
  });

  assert.equal(created.reconciled, true);
  assert.equal(created.threadTs, "1778784641.394639");
  assert.deepEqual(calls.map((call) => call.method), ["conversations.history"]);
});

test("createThread recovers an accepted post after its response is lost", async () => {
  const calls = [];
  const clientMessageId = "22222222-2222-4222-8222-222222222222";
  const client = new SlackThreadClient({
    workspace: "https://example.slack.com",
  }, {
    async slackApiCall(args, method, params) {
      calls.push({ method, params });
      if (method === "chat.postMessage") {
        assert.equal(params.client_msg_id, clientMessageId);
        throw new Error("connection reset after upload");
      }
      if (method === "conversations.history") {
        return response({
          ok: true,
          messages: [{
            ts: "1778784641.394639",
            user: "U_OWNER",
            text: "Started",
            client_msg_id: clientMessageId,
          }],
          response_metadata: { next_cursor: "" },
        });
      }
      throw new Error(`Unexpected method: ${method}`);
    },
  });

  const created = await client.createThread({
    text: "Started",
    identity: { user_id: "U_OWNER", team_id: "T1" },
    destination: { channelId: "D_SELF", channel: { id: "D_SELF" } },
    clientMessageId,
  });

  assert.equal(created.reconciled, true);
  assert.deepEqual(calls.map((call) => call.method), [
    "chat.postMessage",
    "conversations.history",
  ]);
});

test("createThread preserves retry intent for ambiguous Slack API responses", async () => {
  const ambiguousResponses = [
    { error: "fatal_error", status: 200 },
    { error: "internal_error", status: 200 },
    { error: "service_unavailable", status: 200 },
    { error: "request_timeout", status: 200 },
    { error: "duplicate_message_not_allowed", status: 200 },
    { error: "unexpected_gateway_failure", status: 503 },
  ];

  for (const ambiguous of ambiguousResponses) {
    const client = new SlackThreadClient({
      workspace: "https://example.slack.com",
    }, {
      async slackApiCall(args, method) {
        if (method === "chat.postMessage") {
          return {
            ...response({ ok: false, error: ambiguous.error }),
            response: { status: ambiguous.status },
          };
        }
        if (method === "conversations.history") {
          return response({
            ok: true,
            messages: [],
            response_metadata: { next_cursor: "" },
          });
        }
        throw new Error(`Unexpected method: ${method}`);
      },
    });

    await assert.rejects(
      client.createThread({
        text: "Started",
        identity: { user_id: "U_OWNER", team_id: "T1" },
        destination: { channelId: "D_SELF", channel: { id: "D_SELF" } },
        clientMessageId: "33333333-3333-4333-8333-333333333333",
      }),
      (error) => {
        assert.equal(error.rootPostAmbiguous, true, ambiguous.error);
        return true;
      },
    );
  }

  const definiteClient = new SlackThreadClient({
    workspace: "https://example.slack.com",
  }, {
    async slackApiCall(args, method) {
      if (method === "chat.postMessage") {
        return response({ ok: false, error: "channel_not_found" });
      }
      if (method === "conversations.history") {
        return response({
          ok: true,
          messages: [],
          response_metadata: { next_cursor: "" },
        });
      }
      throw new Error(`Unexpected method: ${method}`);
    },
  });
  await assert.rejects(
    definiteClient.createThread({
      text: "Started",
      identity: { user_id: "U_OWNER", team_id: "T1" },
      destination: { channelId: "D_SELF", channel: { id: "D_SELF" } },
      clientMessageId: "44444444-4444-4444-8444-444444444444",
    }),
    (error) => {
      assert.equal(error.rootPostAmbiguous, false);
      return true;
    },
  );
});

test("session polling forwards its cancellation signal to Slack API reads", async () => {
  const controller = new AbortController();
  let receivedSignal = null;
  const client = new SlackThreadClient({
    workspace: "https://example.slack.com",
    auth: { source: "test" },
  }, {
    async slackApiCall(args, method) {
      receivedSignal = args.signal;
      assert.equal(method, "conversations.replies");
      return response({
        ok: true,
        messages: [{ ts: "100.000001", user: "U_OWNER", text: "root" }],
        has_more: false,
        response_metadata: { next_cursor: "" },
      });
    },
  });

  const result = await client.poll({
    slack: { channelId: "C123AGENT", threadTs: "100.000001" },
  }, { signal: controller.signal });

  assert.equal(result.messages.length, 1);
  assert.equal(receivedSignal, controller.signal);
});

test("the shared Slack transport enforces the configured request timeout", async () => {
  const originalFetch = global.fetch;
  let receivedSignal = null;
  global.fetch = async (url, options) => {
    receivedSignal = options.signal;
    return new Promise((resolve, reject) => {
      receivedSignal.addEventListener("abort", () => reject(receivedSignal.reason), {
        once: true,
      });
    });
  };

  try {
    await assert.rejects(
      slackApiCall({
        workspace: "https://example.slack.com",
        auth: { source: "test", token: "hidden", cookieHeader: "hidden" },
        timeoutMs: 25,
      }, "auth.test"),
      /Slack API request timed out after 25ms/,
    );
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(receivedSignal.aborted, true);
});

test("Slack request cancellation works on Node 20 without AbortSignal.any", async () => {
  const originalFetch = global.fetch;
  const originalAny = Object.getOwnPropertyDescriptor(AbortSignal, "any");
  const controller = new AbortController();
  global.fetch = async (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(options.signal.reason), {
      once: true,
    });
    queueMicrotask(() => controller.abort());
  });
  Object.defineProperty(AbortSignal, "any", {
    configurable: true,
    writable: true,
    value: undefined,
  });

  try {
    await assert.rejects(
      slackApiCall({
        workspace: "https://example.slack.com",
        auth: { source: "test", token: "hidden", cookieHeader: "hidden" },
        signal: controller.signal,
        timeoutMs: 10_000,
      }, "auth.test"),
      /Slack API request was cancelled/,
    );
  } finally {
    global.fetch = originalFetch;
    if (originalAny) {
      Object.defineProperty(AbortSignal, "any", originalAny);
    } else {
      delete AbortSignal.any;
    }
  }
});

test("session replies explicitly enable mrkdwn and preserve response text", async () => {
  const calls = [];
  const client = new SlackThreadClient({
    workspace: "https://example.slack.com",
    auth: { source: "test" },
  }, {
    async slackApiCall(args, method, params) {
      calls.push({ method, params });
      return response({
        ok: true,
        channel: "C123AGENT",
        ts: "1778784999.000001",
        message: { ts: "1778784999.000001" },
      });
    },
  });
  const mrkdwn = "*bold* <https://example.com|label> _italic_ ~strike~ `code` **literal**";

  const result = await client.reply({
    slack: {
      channelId: "C123AGENT",
      threadTs: "1778784641.394639",
    },
  }, mrkdwn, {
    send: true,
    clientMessageId: "4d03d13a-5b4e-4ed2-a37d-5e983302b912",
  });

  assert.equal(result.mode, "sent");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "chat.postMessage");
  assert.equal(calls[0].params.text, mrkdwn);
  assert.equal(calls[0].params.mrkdwn, true);
  assert.equal(calls[0].params.reply_broadcast, false);
  assert.equal(calls[0].params.client_msg_id, "4d03d13a-5b4e-4ed2-a37d-5e983302b912");
});

test("session reactions reuse Slack reaction APIs and treat idempotent outcomes as success", async () => {
  const calls = [];
  const client = new SlackThreadClient({
    workspace: "https://example.slack.com",
  }, {
    async loadAuth() { return { source: "test" }; },
    async slackApiCall(args, method, params) {
      calls.push({ method, params });
      if (method === "reactions.add") return response({ ok: false, error: "already_reacted" });
      if (method === "reactions.remove") return response({ ok: false, error: "no_reaction" });
      throw new Error(`Unexpected method: ${method}`);
    },
  });
  const session = {
    slack: { channelId: "C123AGENT", threadTs: "100.000001" },
  };

  const dryRun = await client.react(session, "101.000001", "eyes", { add: true });
  const added = await client.react(session, "101.000001", "eyes", { add: true, send: true });
  const removed = await client.react(session, "101.000001", "eyes", { add: false, send: true });

  assert.equal(dryRun.mode, "dry-run");
  assert.equal(added.mode, "already-present");
  assert.equal(removed.mode, "not-present");
  assert.deepEqual(calls.map((call) => call.method), ["reactions.add", "reactions.remove"]);
  assert.deepEqual(calls[0].params, {
    channel: "C123AGENT",
    timestamp: "101.000001",
    name: "eyes",
  });
});
