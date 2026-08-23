#!/usr/bin/env node
// A fake Responses API, so the guardian stub can be exercised end to end without
// spending tokens or depending on the network.
//
// Scripted rather than clever: the first turn answers with a destructive shell
// call (which the guardian stub denies), the rest with a plain message. That is
// enough to drive every guard gate a turn goes through.

import { createServer } from "node:http";

const PORT = Number(process.argv[process.argv.indexOf("--port") + 1] || 4599);

const sse = (events) =>
  events
    .map((ev) => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`)
    .join("");

const created = (id) => ({ type: "response.created", response: { id } });
const completed = (id) => ({
  type: "response.completed",
  response: {
    id,
    usage: {
      input_tokens: 0,
      input_tokens_details: null,
      output_tokens: 0,
      output_tokens_details: null,
      total_tokens: 0,
    },
  },
});
const message = (id, text) => ({
  type: "response.output_item.done",
  item: {
    type: "message",
    role: "assistant",
    id,
    content: [{ type: "output_text", text }],
  },
});
const functionCall = (callId, name, args) => ({
  type: "response.output_item.done",
  item: { type: "function_call", call_id: callId, name, arguments: args },
});

let turn = 0;

createServer((req, res) => {
  if (req.method !== "POST") {
    res.statusCode = 404;
    return res.end();
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    turn += 1;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    const id = `resp-${turn}`;
    const body =
      turn === 1
        ? sse([
            created(id),
            functionCall(
              `call-${turn}`,
              "exec_command",
              JSON.stringify({ cmd: "rm -rf /tmp/does-not-exist" }),
            ),
            completed(id),
          ])
        : sse([
            created(id),
            message(`msg-${turn}`, "Done — the guardian stub decided on that one."),
            completed(id),
          ]);

    console.error(`[mock-model] turn ${turn} -> ${turn === 1 ? "shell call" : "message"}`);
    res.end(body);
  });
}).listen(PORT, "127.0.0.1", () => {
  console.error(`mock model on http://127.0.0.1:${PORT}`);
});
