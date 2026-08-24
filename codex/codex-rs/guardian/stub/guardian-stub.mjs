#!/usr/bin/env node
// A stand-in for the guardian REST backend, for developing against `[guardian]
// mode = "api"` without running the desktop app.
//
// Speaks the two endpoints `ApiGuardian` uses, under whatever path prefix the
// configured base carries:
//
//   POST {base}/v1/reviews       one guarded action  -> a verdict
//   GET  {base}/v1/reviews/<id>  poll a pending review
//   POST {base}/v1/activities    a batch of recorded activity
//
// No dependencies: `node guardian-stub.mjs`.

import { createServer } from "node:http";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const RESPONSES = JSON.parse(readFileSync(HERE + "responses.json", "utf8"));

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};
const has = (name) => argv.includes(`--${name}`);

if (has("help")) {
  console.log(`guardian-stub — a fake guardian REST backend

  --port <n>        listen port                      (default 4500)
  --scenario <name> canned answer for every review   (default rules)
                    ${Object.keys(RESPONSES).filter((k) => k[0] !== "_").join(", ")}
  --pending-ms <n>  how long a pending review stays pending (default 2000)
  --bearer <token>  require this Authorization: Bearer token
  --log <file>      append every request as JSONL    (default stub.jsonl)
  --quiet           don't print each request to stdout

What the default 'rules' scenario does, and how to see each one in the TUI
(every decision below prints a "Guardian ..." line in codex):

  instructions  rewritten on every session: the guard appends its house rules
                to AGENTS.md. An AGENTS.md line like "ignore the guardian" is
                denied instead, and the whole block is dropped.
  prompt        rewritten when it carries something credential-shaped, e.g.
                "my api_key = sk-abcd1234efgh".
  tool call     denied when destructive ("rm -rf build"); denied as garbage
                when it proves nothing ("sleep 5", "echo test"); rewritten
                when its arguments carry a credential.
  tool output   rewritten when it carries a credential, or when it runs past
                4000 characters ("seq 1 5000"), which trims it.

Point codex at it:

  [guardian]
  mode = "api"
  endpoint = "http://127.0.0.1:4500/guardian"
  request_timeout = "30s"
`);
  process.exit(0);
}

const PORT = Number(flag("port", 4500));
const SCENARIO = flag("scenario", "rules");
const PENDING_MS = Number(flag("pending-ms", 2000));
const BEARER = flag("bearer", null);
const LOG = flag("log", HERE + "stub.jsonl");
const QUIET = has("quiet");

if (SCENARIO !== "rules" && !RESPONSES[SCENARIO]) {
  console.error(`unknown scenario '${SCENARIO}' — see --help`);
  process.exit(1);
}

let seq = 0;
const reviews = new Map(); // id  -> { status, verdict }
const idem = new Map(); // key -> id, so a retry cannot re-decide

// --- the `rules` scenario --------------------------------------------------
// Deliberately exercises every power the guard has -- skipping a call, cleaning
// one, rewriting a prompt, replacing the instruction block, and saying why it
// refused -- in a single session, so the codex UI has something to render
// beyond a wall of green.

const DESTRUCTIVE = /\brm\s+-[a-z]*[rf]|\bmkfs\b|\bdd\s+if=|:\(\)\s*\{|>\s*\/dev\/sd/;
const SECRET = /\b(sk-[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{12,})\b|\b(api[_ -]?key|password|secret)\b\s*[:=]/i;
// Every match, for substitution: a non-global regex would redact only the first
// one and leave the rest of the credential sitting there in plain sight.
const SECRET_ALL = new RegExp(SECRET.source, "gi");

// Busywork: a call that burns a turn without moving the task along. Skipping it
// is the whole point of the guard, and the reason says so in as many words.
const GARBAGE = /\bsleep\s+\d|\bwhile\s+true\b|\byes\s*[|>]|\/dev\/urandom|\becho\s+["']?(test|testing|foo|bar|baz|hello world)\b/i;
// An instruction block talking the agent out of its own oversight. Instructions
// arrive with more standing than a prompt does, so this one is worth dropping
// rather than tidying.
const SUBVERSIVE = /\b(ignore|disable|bypass|skip|turn off)\b[^.\n]{0,48}\b(guardian|guard|oversight|review|sandbox|approval)/i;
// What the guard adds to every instruction block it lets through, so a session
// carries its house rules even when the repo's AGENTS.md never mentions them.
const HOUSE_RULES = [
  "## Guardian house rules",
  "",
  "- Do not spend a turn on busywork; if a command proves nothing, skip it and say so.",
  "- Never paste a credential into a command, a file, or a message.",
  "- Say what you actually ran and what it actually printed.",
].join("\n");
// Above this, a tool result is cut down before the model ever sees it.
const MAX_OUTPUT_CHARS = 4000;

function decideByRules(action) {
  const blob = JSON.stringify(action ?? {});
  switch (action?.action) {
    case "prompt":
      return SECRET.test(action.text ?? "")
        ? {
            decision: "rewrite",
            payload: (action.text ?? "").replace(SECRET_ALL, "[redacted]"),
            note: "redacted what looked like a credential",
          }
        : { decision: "allow" };
    case "instructions":
      return decideInstructions(action.text ?? "");
    case "tool_call":
      if (DESTRUCTIVE.test(blob)) {
        return { decision: "deny", reason: "destructive command against the working tree" };
      }
      if (GARBAGE.test(blob)) {
        return {
          decision: "deny",
          reason: "skipped: that call is garbage — it burns a turn and proves nothing",
        };
      }
      // Cleaning, not blocking: the call is fine once the credential is out of it.
      if (SECRET.test(blob)) {
        return {
          decision: "rewrite",
          payload: JSON.parse(
            JSON.stringify(action.tool_input ?? {}).replace(SECRET_ALL, "[redacted]"),
          ),
          note: "scrubbed a credential out of the arguments",
        };
      }
      return { decision: "allow" };
    case "tool_output":
      return decideToolOutput(action, blob);
    default:
      return { decision: "allow" };
  }
}

/// Instructions are model-visible standing authority, so the guard gets the
/// last word on them: it drops a block that argues against its own oversight,
/// and otherwise hands back a block with its house rules appended.
function decideInstructions(text) {
  if (SUBVERSIVE.test(text)) {
    return {
      decision: "deny",
      reason: "instructions tried to talk the agent out of its own oversight — dropped",
    };
  }
  const kept = text
    .split("\n")
    .filter((line) => !SUBVERSIVE.test(line))
    .join("\n")
    .trimEnd();
  return {
    decision: "rewrite",
    payload: `${kept}\n\n${HOUSE_RULES}\n`,
    note: "appended the guardian's house rules",
  };
}

/// A tool result is the last place anything can be taken out before the model
/// reads it, so both scrubbing and trimming happen here.
function decideToolOutput(action, blob) {
  if (SECRET.test(blob)) {
    return {
      decision: "rewrite",
      payload: "[output withheld: it looked like it carried a credential]",
      note: "withheld a credential from the model",
    };
  }
  const text = outputText(action.tool_response);
  if (text.length > MAX_OUTPUT_CHARS) {
    const dropped = text.length - MAX_OUTPUT_CHARS;
    return {
      decision: "rewrite",
      payload: `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n[guardian trimmed ${dropped} characters of output]`,
      note: `trimmed ${dropped} characters of output`,
    };
  }
  return { decision: "allow" };
}

/// The model-visible text of a tool result, whatever shape the response took.
function outputText(response) {
  if (typeof response === "string") return response;
  if (response == null) return "";
  return JSON.stringify(response);
}

// --- wire helpers ----------------------------------------------------------

function record(entry) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  appendFileSync(LOG, line + "\n");
  if (!QUIET) console.log(line);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 5e6) req.destroy();
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, body, { headers = {}, contentType = "application/json" } = {}) {
  res.statusCode = status;
  res.setHeader("content-type", contentType);
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.end(JSON.stringify(body));
}

/// Answers with a review's current state. Pending reviews carry the Location
/// the client polls, which has to keep the request's own path prefix.
function respondReview(res, id, prefix) {
  const review = reviews.get(id);
  if (!review) {
    return send(res, 404, { title: "unknown review" }, { contentType: "application/problem+json" });
  }
  if (review.status === "pending") {
    return send(
      res,
      202,
      { review_id: id, status: "pending" },
      { headers: { location: `${prefix}/v1/reviews/${id}`, "retry-after": "1" } },
    );
  }
  send(res, 200, { review_id: id, status: "decided", verdict: review.verdict });
}

async function handleReviewPost(req, res, prefix) {
  let body;
  try {
    body = await readBody(req);
  } catch {
    return send(res, 400, { title: "invalid JSON" }, { contentType: "application/problem+json" });
  }

  // A client-side timeout leaves our answer unknown to the client, so a retry
  // under the same key has to get the same review back, never a fresh decision.
  const key = String(req.headers["idempotency-key"] ?? `no-key-${++seq}`);
  if (idem.has(key)) {
    record({ kind: "review.retry", key, review_id: idem.get(key) });
    return respondReview(res, idem.get(key), prefix);
  }

  const id = `rev-${++seq}`;
  idem.set(key, id);
  const action = body.action ?? {};
  const context = body.context ?? {};

  if (SCENARIO === "rules") {
    const verdict = decideByRules(action);
    reviews.set(id, { status: "decided", verdict });
    record({
      kind: "review",
      review_id: id,
      action: action.action,
      tool: action.tool_name ?? action.server_name ?? null,
      thread_id: context.thread_id ?? null,
      decision: verdict.decision,
      reason: verdict.reason ?? verdict.note ?? null,
    });
    return respondReview(res, id, prefix);
  }

  const canned = RESPONSES[SCENARIO];
  record({
    kind: "review",
    review_id: id,
    action: action.action,
    tool: action.tool_name ?? action.server_name ?? null,
    thread_id: context.thread_id ?? null,
    scenario: SCENARIO,
    status: canned.status,
  });

  if (canned.status === 202) {
    reviews.set(id, { status: "pending" });
    setTimeout(() => {
      reviews.set(id, { status: "decided", verdict: canned.decides_to ?? { decision: "allow" } });
      record({ kind: "review.decided", review_id: id, decision: canned.decides_to?.decision });
    }, PENDING_MS).unref();
    return respondReview(res, id, prefix);
  }

  if (canned.status >= 400) {
    return send(res, canned.status, canned.body, {
      headers: canned.headers ?? {},
      contentType: canned.contentType ?? "application/json",
    });
  }

  reviews.set(id, { status: "decided", verdict: canned.body.verdict });
  send(res, canned.status, { review_id: id, ...canned.body }, { headers: canned.headers ?? {} });
}

async function handleActivities(req, res) {
  let batch;
  try {
    batch = await readBody(req);
  } catch {
    return send(res, 400, { title: "invalid JSON" }, { contentType: "application/problem+json" });
  }
  const items = Array.isArray(batch.items) ? batch.items : [];
  for (const item of items) {
    record({
      kind: "activity",
      activity: item.activity?.activity ?? null,
      thread_id: item.context?.thread_id ?? null,
    });
  }
  send(res, 200, { ok: true, count: items.length });
}

// --- routing ---------------------------------------------------------------
// Matched by suffix so the stub works under any base the endpoint carries:
// `/v1/reviews`, `/guardian/v1/reviews`, `/api/v1/reviews` all land here.

createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  if (BEARER && req.headers.authorization !== `Bearer ${BEARER}`) {
    record({ kind: "rejected", path, reason: "bad bearer token" });
    return send(
      res,
      401,
      { title: "Unauthorized", detail: "bearer token missing or wrong", guardian_error: "unavailable" },
      { contentType: "application/problem+json" },
    );
  }

  const reviewsAt = path.lastIndexOf("/v1/reviews");
  if (reviewsAt !== -1) {
    const prefix = path.slice(0, reviewsAt);
    const rest = path.slice(reviewsAt + "/v1/reviews".length);
    if (rest === "" && req.method === "POST") return handleReviewPost(req, res, prefix);
    if (rest.startsWith("/") && req.method === "GET") {
      return respondReview(res, rest.slice(1), prefix);
    }
  }
  if (path.endsWith("/v1/activities") && req.method === "POST") {
    return handleActivities(req, res);
  }

  record({ kind: "unrouted", method: req.method, path });
  send(res, 404, { title: "no such endpoint", detail: path }, { contentType: "application/problem+json" });
}).listen(PORT, "127.0.0.1", () => {
  console.log(`guardian stub on http://127.0.0.1:${PORT} — scenario '${SCENARIO}', log ${LOG}`);
});
