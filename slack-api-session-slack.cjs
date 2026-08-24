const fs = require("node:fs");
const path = require("node:path");
const {
  loadAuth,
  looksLikeChannelId,
  parsePermalink,
  permalinkFor,
  resolveChannel,
  slackApiCall,
} = require("./slack-api-common.cjs");
const { fetchThreadReplies } = require("./slack-api-read.cjs");

const AMBIGUOUS_ROOT_POST_ERRORS = new Set([
  "duplicate_message",
  "duplicate_message_not_allowed",
  "fatal_error",
  "internal_error",
  "request_timeout",
  "service_unavailable",
]);

function rootPostResponseIsAmbiguous(response, json) {
  const status = Number(response?.status);
  return (
    (Number.isFinite(status) && status >= 500)
    || AMBIGUOUS_ROOT_POST_ERRORS.has(String(json?.error || "").trim())
  );
}

function timestampKey(value) {
  const normalized = String(value || "").replace(".", "");
  return /^\d+$/.test(normalized) ? BigInt(normalized) : 0n;
}

function sortMessages(messages) {
  return [...messages].sort((left, right) => (
    timestampKey(left.ts) < timestampKey(right.ts) ? -1
      : timestampKey(left.ts) > timestampKey(right.ts) ? 1 : 0
  ));
}

class SlackThreadClient {
  constructor(args, dependencies = {}) {
    this.args = { ...args };
    this.callSlackApi = dependencies.slackApiCall || slackApiCall;
    this.authenticate = dependencies.loadAuth || loadAuth;
    this.resolveSlackChannel = dependencies.resolveChannel || resolveChannel;
    this.authenticatedIdentity = null;
  }

  async identity() {
    if (this.authenticatedIdentity) return this.authenticatedIdentity;
    this.args.auth = await this.authenticate(this.args);
    const { json } = await this.callSlackApi(this.args, "auth.test");
    if (!json.ok || !json.user_id) {
      throw new Error(`Could not resolve the authenticated Slack user: ${json.error || "auth_test_failed"}`);
    }
    this.authenticatedIdentity = json;
    return this.authenticatedIdentity;
  }

  async resolveDestination(channel, identity = null) {
    const requested = String(channel || "").trim();
    if (!requested) {
      throw new Error("--channel is required when no saved/default session destination is available");
    }
    if (/^(me|self)$/i.test(requested)) {
      const authenticated = identity || await this.identity();
      const { json } = await this.callSlackApi(this.args, "conversations.open", {
        users: authenticated.user_id,
        return_im: true,
      });
      if (!json.ok || !json.channel?.id) {
        throw new Error(`Could not resolve the authenticated user's self-DM: ${json.error || "conversations_open_failed"}`);
      }
      return {
        channelId: json.channel.id,
        channel: json.channel,
        requested: "me",
        kind: "self_dm",
      };
    }
    if (looksLikeChannelId(requested)) {
      return {
        channelId: requested,
        channel: null,
        requested,
        kind: requested.startsWith("D") ? "dm" : "channel",
      };
    }
    const resolved = await this.resolveSlackChannel(this.args, requested);
    if (!resolved.ok || !resolved.channelId) {
      const candidates = (resolved.candidates || []).map((candidate) => candidate.name || candidate.id).filter(Boolean);
      throw new Error(
        `Could not resolve Slack channel ${requested}: ${resolved.error || "channel_not_found"}`
        + (candidates.length ? `. Candidates: ${candidates.join(", ")}` : ""),
      );
    }
    return {
      channelId: resolved.channelId,
      channel: resolved.channel,
      requested,
      kind: "channel",
    };
  }

  async initialize({ channelId, threadTs }) {
    const identity = await this.identity();
    const snapshot = await this.readThread({ channelId, threadTs });
    const root = snapshot.messages.find((message) => message.ts === threadTs);
    if (!root) throw new Error(`Slack thread root ${threadTs} was not found in ${channelId}`);
    return {
      ownerUserId: identity.user_id,
      ownerName: identity.user || null,
      teamId: identity.team_id || null,
      workspace: this.args.workspace,
      latestTs: snapshot.messages.at(-1)?.ts || threadTs,
      messages: snapshot.messages,
      permalink: permalinkFor(this.args.workspace, channelId, threadTs),
    };
  }

  createdThreadResult({
    authenticated,
    channelId,
    channelInfo,
    message,
    reconciled = false,
    clientMessageId = null,
  }) {
    return {
      ownerUserId: authenticated.user_id,
      ownerName: authenticated.user || null,
      teamId: authenticated.team_id || null,
      workspace: this.args.workspace,
      channelId,
      channel: channelInfo,
      threadTs: message.ts,
      latestTs: message.ts,
      messages: [message],
      permalink: permalinkFor(this.args.workspace, channelId, message.ts),
      reconciled,
      clientMessageId,
    };
  }

  async findCreatedThread({
    channelId,
    clientMessageId,
    identity,
    channelInfo = null,
    maxPages = 5,
  }) {
    const requestedClientMessageId = String(clientMessageId || "").trim();
    if (!requestedClientMessageId) return null;
    const authenticated = identity || await this.identity();
    let cursor = "";
    for (let page = 0; page < maxPages; page += 1) {
      const { json } = await this.callSlackApi(
        this.args,
        "conversations.history",
        {
          channel: channelId,
          limit: 200,
          cursor,
        },
      );
      if (!json.ok) {
        throw new Error(
          `Could not reconcile the Slack session root: ${json.error || "conversations_history_failed"}`,
        );
      }
      const message = (json.messages || []).find((candidate) => (
        candidate.client_msg_id === requestedClientMessageId
      ));
      if (message?.ts) {
        return this.createdThreadResult({
          authenticated,
          channelId,
          channelInfo,
          message,
          reconciled: true,
          clientMessageId: requestedClientMessageId,
        });
      }
      cursor = String(json.response_metadata?.next_cursor || "").trim();
      if (!cursor) break;
    }
    return null;
  }

  async createThread({
    channel = "",
    text,
    identity = null,
    destination = null,
    clientMessageId = null,
    reconcile = false,
  }) {
    const authenticated = identity || await this.identity();
    const resolvedDestination = destination || await this.resolveDestination(channel, authenticated);
    let channelId = resolvedDestination.channelId;
    const channelInfo = resolvedDestination.channel;
    const requestedClientMessageId = String(clientMessageId || "").trim() || null;

    const message = String(text || "").trim();
    if (!message) throw new Error("Session root message is empty");
    if ([...message].length > 40_000) {
      throw new Error("Session root message exceeds Slack's 40,000-character limit");
    }
    if (reconcile && requestedClientMessageId) {
      const existing = await this.findCreatedThread({
        channelId,
        clientMessageId: requestedClientMessageId,
        identity: authenticated,
        channelInfo,
      });
      if (existing) return existing;
    }

    let response;
    let json;
    try {
      ({ response, json } = await this.callSlackApi(this.args, "chat.postMessage", {
        channel: channelId,
        text: message,
        client_msg_id: requestedClientMessageId,
      }));
    } catch (cause) {
      if (requestedClientMessageId) {
        try {
          const recovered = await this.findCreatedThread({
            channelId,
            clientMessageId: requestedClientMessageId,
            identity: authenticated,
            channelInfo,
          });
          if (recovered) return recovered;
        } catch {}
      }
      const error = new Error(
        `Could not determine whether Slack created the session root: ${cause.message || cause}`,
        { cause },
      );
      error.rootPostAmbiguous = true;
      throw error;
    }
    if (!json.ok || !json.ts) {
      if (requestedClientMessageId) {
        try {
          const recovered = await this.findCreatedThread({
            channelId,
            clientMessageId: requestedClientMessageId,
            identity: authenticated,
            channelInfo,
          });
          if (recovered) return recovered;
        } catch {}
      }
      const error = new Error(
        `Could not create the Slack session thread: ${json.error || "chat_postMessage_failed"}`,
      );
      error.rootPostAmbiguous = rootPostResponseIsAmbiguous(response, json);
      throw error;
    }
    channelId = json.channel || channelId;
    return this.createdThreadResult({
      authenticated,
      channelId,
      channelInfo,
      message: {
        ...(json.message || {}),
        ts: json.message?.ts || json.ts,
        user: json.message?.user || authenticated.user_id,
        text: json.message?.text ?? message,
        ...(requestedClientMessageId
          ? { client_msg_id: json.message?.client_msg_id || requestedClientMessageId }
          : {}),
      },
      clientMessageId: requestedClientMessageId,
    });
  }

  async readThread({ channelId, threadTs, signal = null }) {
    const result = await fetchThreadReplies({
      ...this.args,
      auth: this.args.auth,
      channel: channelId,
      ts: threadTs,
      threadTs,
      limit: 200,
      maxPages: 50,
      signal,
    }, { slackApiCall: this.callSlackApi });
    if (!result.ok || !result.complete) {
      throw new Error(`Slack thread read was incomplete: ${result.error || "unknown_error"}`);
    }
    return { messages: sortMessages(result.messages), pages: result.pages };
  }

  async poll(session, { signal = null } = {}) {
    return this.readThread({
      channelId: session.slack.channelId,
      threadTs: session.slack.threadTs,
      signal,
    });
  }

  async reply(session, text, {
    send = false,
    clientMessageId = null,
    signal = null,
  } = {}) {
    const message = String(text || "").trim();
    if (!message) throw new Error("Response message is empty");
    if (message.length > 40_000) throw new Error("Response exceeds Slack's 40,000-character message limit");
    if (!send) {
      return {
        ok: true,
        mode: "dry-run",
        sent: false,
        channel: session.slack.channelId,
        threadTs: session.slack.threadTs,
        textLength: message.length,
      };
    }
    if (!this.args.auth) this.args.auth = await this.authenticate(this.args);
    const payload = {
      channel: session.slack.channelId,
      thread_ts: session.slack.threadTs,
      text: message,
      mrkdwn: true,
      reply_broadcast: false,
    };
    if (clientMessageId) payload.client_msg_id = clientMessageId;
    const { json } = await this.callSlackApi(
      { ...this.args, signal },
      "chat.postMessage",
      payload,
    );
    if (!json.ok || !json.ts) {
      throw new Error(`Slack response failed: ${json.error || "chat_postMessage_failed"}`);
    }
    return {
      ok: true,
      mode: "sent",
      sent: true,
      channel: json.channel || session.slack.channelId,
      threadTs: session.slack.threadTs,
      ts: json.ts,
      messageTs: json.message?.ts || json.ts,
      clientMessageId,
    };
  }

  async react(session, messageTs, emoji, { add, send = false, signal = null } = {}) {
    const action = add ? "add" : "remove";
    if (!send) {
      return {
        ok: true,
        mode: "dry-run",
        action,
        emoji,
        messageTs,
      };
    }
    if (!this.args.auth) this.args.auth = await this.authenticate(this.args);
    const { json } = await this.callSlackApi(
      { ...this.args, signal },
      add ? "reactions.add" : "reactions.remove",
      {
        channel: session.slack.channelId,
        timestamp: messageTs,
        name: emoji,
      },
    );
    const expectedError = add ? "already_reacted" : "no_reaction";
    if (!json.ok && json.error !== expectedError) {
      throw new Error(`Slack reaction ${action} failed: ${json.error || "reaction_failed"}`);
    }
    return {
      ok: true,
      mode: json.error === expectedError
        ? (add ? "already-present" : "not-present")
        : (add ? "added" : "removed"),
      action,
      emoji,
      messageTs,
    };
  }
}

class SimulatedSlackThreadClient {
  constructor(fixturePathOrObject) {
    this.fixturePath = typeof fixturePathOrObject === "string"
      ? path.resolve(fixturePathOrObject)
      : null;
    this.fixture = typeof fixturePathOrObject === "string"
      ? JSON.parse(fs.readFileSync(this.fixturePath, "utf8"))
      : structuredClone(fixturePathOrObject);
    this.pollIndex = 0;
    this.replies = [];
    this.reactions = [];
    this.reactionState = new Map();
    this.replySequence = 0;
    this.createdThreads = [];
  }

  target() {
    const target = this.fixture.thread || {};
    if (target.link) {
      const parsed = parsePermalink(target.link);
      return { channelId: parsed.channelId, threadTs: parsed.rootTs };
    }
    return { channelId: target.channelId, threadTs: target.threadTs };
  }

  allMessagesForPoll() {
    if (Array.isArray(this.fixture.polls)) {
      const index = Math.min(this.pollIndex, Math.max(0, this.fixture.polls.length - 1));
      this.pollIndex += 1;
      return this.fixture.polls[index] || [];
    }
    return this.fixture.messages || [];
  }

  async identity() {
    return {
      ok: true,
      user_id: this.fixture.authenticatedUserId || "U_OWNER",
      user: this.fixture.authenticatedUsername || null,
      team_id: this.fixture.teamId || "T_SIMULATED",
    };
  }

  async resolveDestination(channel) {
    const expected = this.target();
    const requested = String(channel || "").trim();
    if (!requested) throw new Error("A destination is required when creating a new simulated session thread");
    if (/^(me|self)$/i.test(requested)) {
      return {
        channelId: expected.channelId,
        channel: { id: expected.channelId, is_im: true },
        requested: "me",
        kind: "self_dm",
      };
    }
    if (requested !== expected.channelId) {
      throw new Error(`Simulated Slack channel ${requested} does not match fixture channel ${expected.channelId}`);
    }
    return {
      channelId: requested,
      channel: { id: requested, name: "simulated", isIm: requested.startsWith("D") },
      requested,
      kind: requested.startsWith("D") ? "dm" : "channel",
    };
  }

  async initialize({ channelId, threadTs }) {
    const expected = this.target();
    if (!channelId) channelId = expected.channelId;
    if (!threadTs) threadTs = expected.threadTs;
    if (channelId !== expected.channelId || threadTs !== expected.threadTs) {
      throw new Error("Simulated Slack target does not match the fixture thread");
    }
    const messages = sortMessages(this.fixture.messages || this.fixture.polls?.[0] || []);
    if (!messages.some((message) => message.ts === threadTs)) {
      throw new Error("Simulation fixture must contain its thread root message");
    }
    return {
      ownerUserId: this.fixture.authenticatedUserId || "U_OWNER",
      ownerName: this.fixture.authenticatedUsername || null,
      teamId: this.fixture.teamId || "T_SIMULATED",
      workspace: this.fixture.workspace || "https://simulated.slack.com",
      latestTs: messages.at(-1)?.ts || threadTs,
      messages,
      permalink: this.fixture.thread.link
        || `${this.fixture.workspace || "https://simulated.slack.com"}/archives/${channelId}/p${threadTs.replace(".", "")}`,
    };
  }

  async createThread({
    channel = "",
    text,
    destination = null,
    clientMessageId = null,
  }) {
    const expected = this.target();
    const resolvedDestination = destination || await this.resolveDestination(channel);
    const channelId = resolvedDestination.channelId;
    if (channelId !== expected.channelId) throw new Error("Simulated Slack destination does not match fixture");
    const existing = clientMessageId
      ? this.createdThreads.find((thread) => thread.clientMessageId === clientMessageId)
      : null;
    if (existing) return structuredClone(existing.result);
    const messages = sortMessages(this.fixture.messages || this.fixture.polls?.[0] || []);
    const root = messages.find((message) => message.ts === expected.threadTs);
    if (!root) throw new Error("Simulation fixture must contain the created thread root");
    root.text = String(text);
    if (clientMessageId) root.client_msg_id = clientMessageId;
    const created = {
      ownerUserId: this.fixture.authenticatedUserId || "U_OWNER",
      ownerName: this.fixture.authenticatedUsername || null,
      teamId: this.fixture.teamId || "T_SIMULATED",
      workspace: this.fixture.workspace || "https://simulated.slack.com",
      channelId,
      channel: { id: channelId, name: "simulated", isIm: channelId.startsWith("D") },
      threadTs: expected.threadTs,
      latestTs: expected.threadTs,
      messages: [root],
      permalink: this.fixture.thread.link
        || `${this.fixture.workspace || "https://simulated.slack.com"}/archives/${channelId}/p${expected.threadTs.replace(".", "")}`,
      clientMessageId,
    };
    this.createdThreads.push({
      channelId,
      threadTs: expected.threadTs,
      text: String(text),
      clientMessageId,
      result: structuredClone(created),
    });
    return created;
  }

  async poll() {
    return { messages: sortMessages(this.allMessagesForPoll()), pages: [{ simulated: true }] };
  }

  async reply(session, text, { send = false } = {}) {
    this.replySequence += 1;
    const response = {
      ok: true,
      mode: send ? "simulated-sent" : "dry-run",
      sent: Boolean(send),
      channel: session.slack.channelId,
      threadTs: session.slack.threadTs,
      ts: send ? `9999999999.${String(this.replySequence).padStart(6, "0")}` : null,
      text: String(text),
    };
    this.replies.push(response);
    return response;
  }

  async react(session, messageTs, emoji, { add, send = false } = {}) {
    const key = `${messageTs}:${emoji}`;
    const present = this.reactionState.has(key);
    let mode = "dry-run";
    if (send && add && !present) {
      this.reactionState.set(key, true);
      mode = "added";
    } else if (send && add) {
      mode = "already-present";
    } else if (send && !add && present) {
      this.reactionState.delete(key);
      mode = "removed";
    } else if (send && !add) {
      mode = "not-present";
    }
    const reaction = {
      ok: true,
      mode,
      action: add ? "add" : "remove",
      emoji,
      messageTs,
      channel: session.slack.channelId,
    };
    this.reactions.push(reaction);
    return reaction;
  }
}

function targetFromArgs({ link, channel, threadTs }) {
  if (link) {
    const parsed = parsePermalink(link);
    return {
      channelId: parsed.channelId,
      threadTs: parsed.rootTs,
      link,
    };
  }
  if (!channel || !threadTs) {
    throw new Error("Binding an existing thread requires --link, or both --channel and --thread-ts.");
  }
  return { channelId: channel, threadTs, link: null };
}

module.exports = {
  SimulatedSlackThreadClient,
  SlackThreadClient,
  sortMessages,
  targetFromArgs,
  timestampKey,
};
