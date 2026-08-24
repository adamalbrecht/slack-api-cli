const fs = require("node:fs");
const { SessionRuntime } = require("../slack-api-session-runtime.cjs");
const { SessionStore } = require("../slack-api-session-store.cjs");

const [stateDir, sessionId, eventId, callLog] = process.argv.slice(2);
const store = new SessionStore(stateDir);
const runtime = new SessionRuntime({
  store,
  sessionId,
  provider: { verify() {}, inject() {} },
  logger: { error() {} },
  slack: {
    async reply(current, text, { clientMessageId }) {
      fs.appendFileSync(callLog, `${process.pid}:${clientMessageId}\n`);
      await new Promise((resolve) => setTimeout(resolve, 150));
      return {
        ok: true,
        mode: "sent",
        sent: true,
        ts: `999.${String(process.pid).padStart(6, "0")}`,
        clientMessageId,
      };
    },
  },
});

runtime.respond("Cross-process final.", {
  send: true,
  eventId,
  status: "complete",
}).then(
  (result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  },
  (error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  },
);
