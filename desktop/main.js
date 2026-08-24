// CleanMyAgent desktop — menu bar tray with a CleanMyMac-style status panel,
// the tool-call gate, and the guardian API codex reports to.
//   npm start
import { app, Tray, BrowserWindow, screen } from "electron";
import { createServer, request } from "node:http";
import { appendFileSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createEquile } from "@nodus-ai/equile";
import { createRubbishStore } from "./similarity.js";
import { createSessionStore } from "./store.js";

// Optional ops sidecar. Nothing in this app starts one: /snapshot and /apply
// are proxied if something is already listening, and answer 502 otherwise —
// the panel then drops the snapshot-backed cards and every other feature is
// unaffected.
const API_PORT = 4488;
const APP_PORT = 4490;   // webui/dist + API proxy, same-origin like prod (4499 is vite dev's)
const DIST = fileURLToPath(new URL("../webui/dist/", import.meta.url));
const PANEL = fileURLToPath(new URL("./panel.html", import.meta.url));

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
               ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };

app.setName("CleanMyAgent"); // userData → ~/Library/Application Support/CleanMyAgent

let tray, win;

// tiny ingest backend: external tools (hooks, scripts) POST events here
// ponytail: in-memory + JSONL append; a real store when someone needs queries
const events = [];
let eventsFile;

function loadEvents() {
  eventsFile = join(app.getPath("userData"), "events.jsonl");
  if (existsSync(eventsFile)) {
    for (const line of readFileSync(eventsFile, "utf8").split("\n")) {
      if (line.trim()) try { events.push(JSON.parse(line)); } catch {}
    }
  }
}

function handleEvents(req, res, url) {
  res.setHeader("content-type", "application/json");
  if (req.method === "POST") {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => { size += c.length; if (size > 1e6) req.destroy(); chunks.push(c); });
    req.on("end", () => {
      try {
        const ev = { ...JSON.parse(Buffer.concat(chunks).toString()), receivedAt: new Date().toISOString() };
        events.push(ev);
        appendFileSync(eventsFile, JSON.stringify(ev) + "\n");
        // a call the feed reports as blocked seeds the blocked index too
        if (ev.status === "blocked" || ev.blocked || ev.decision === "deny" || ev.verdict === "deny") {
          blockedIndex.add(String(ev.text ?? JSON.stringify(ev.action ?? ev.activity ?? "")));
        }
        if (threadOf(ev)) sessions.append(threadOf(ev), ev); // keyed feeds get the per-thread copy
        res.end(JSON.stringify({ ok: true, count: events.length }));
      } catch { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: "invalid JSON" })); }
    });
    return;
  }
  const limit = Number(url.searchParams.get("limit")) || 100;
  res.end(JSON.stringify(events.slice(-limit)));
}

// --- tool-call gate -------------------------------------------------------
// ponytail: keyword rules for now; swap scan() for the trained detector when it lands
const RULES = [
  ["destructive shell", /\brm\s+-rf?\b|\bmkfs\b|\bdiskutil\s+erase/i],
  ["pipe-to-shell", /\b(curl|wget)\b[^|;&]*\|\s*(ba|z)?sh\b/i],
  // both orders: the noun can lead ("token ... echo") or trail ("cat ... credentials").
  // Dotfile paths are matched without a leading \b — there is no word boundary
  // between the "/" and the "." in "~/.aws", so \b\. would only ever fire on
  // "foo.env" and never on the dotfiles this is here to catch.
  ["credential access", /\b(secret|password|api[_-]?key|token|credential)s?\b.{0,40}\b(cat|read|print|echo|curl|post)\b|\b(cat|read|print|echo|curl|post)\b.{0,40}\b(secret|password|api[_-]?key|token|credential)s?\b|\b(cat|read)\b.{0,40}\.(env|aws|ssh)\b/i],
  ["prompt injection", /ignore (all )?(previous|prior) (instructions|rules)|disregard your (instructions|system prompt)/i],
  ["exfiltration", /\b(curl|wget|fetch|http)\b.{0,60}(\.env\b|\b(id_rsa|keychain|cookies)\b)/i],
  ["obfuscation", /base64\s+(-d|--decode)|\beval\s*\(\s*atob/i],
];
const scan = (text) => RULES.filter(([, re]) => re.test(text)).map(([name]) => name);

// --- the skip list --------------------------------------------------------
// Not everything the gate stops is dangerous. Some calls are simply a waste of
// a turn — a lint run nobody asked for, a `sleep 5`, an `echo test` — and some
// tool output is noise the model should never have to read: funding pitches,
// upgrade nags, the advertising a package manager prints around the part that
// matters.
//
// Neither is a judgment call, so neither reaches the island: there is nothing
// for a person to decide. A matching call is skipped where it arrives, and
// matching output lines are dropped while the rest of the output survives.
const GARBAGE = [
  // lint and formatting runs: they prove nothing about the task in hand and
  // cost a turn each
  ["lint run", /\b(eslint|tslint|stylelint|ruff|flake8|pylint|rubocop|golangci-lint)\b|\bcargo\s+clippy\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?lint\b/i],
  ["formatter run", /\b(prettier|gofmt|rustfmt|clang-format)\b|\bcargo\s+fmt\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?(format|fmt)\b|\bblack\s+\S/i],
  // busywork: burns a turn and prints nothing worth reading
  ["idle wait", /\bsleep\s+\d|\bwhile\s+true\b|\byes\s*[|>]/i],
  ["placeholder command", /\becho\s+["']?(test|testing|foo|bar|baz|hello world)\b/i],
];

// Matched line by line against tool output, so one advertising line does not
// cost the model the whole result.
const NOISE = [
  ["funding pitch", /packages are looking for funding|run `npm fund`|^\s*(sponsor|donate|support (us|this project)|backers?)\b|opencollective|patreon/i],
  ["upgrade nag", /new (major |minor )?version of \S+ (is )?available|^npm notice|\bnew release available\b|to update, run:|consider upgrading/i],
  ["telemetry notice", /anonymous (usage )?(data|telemetry)|\btelemetry\b.{0,40}\b(enabled|collect)/i],
  ["subscription pitch", /^\s*(subscribe|follow us|join our|sign up)\b|\bnewsletter\b/i],
];

// The name of the first list entry `text` trips, or undefined.
const firstMatch = (list, text) => list.find(([, re]) => re.test(text))?.[0];

// The model-visible text of a tool result. codex sends exec output as a bare
// JSON string and MCP results as {content:[{text}]}; anything else is only
// worth scanning as its JSON.
const outputText = (response) =>
  typeof response === "string" ? response
  : typeof response?.output === "string" ? response.output
  : Array.isArray(response?.content) ? response.content.map((c) => c?.text ?? "").join("\n")
  : JSON.stringify(response ?? "");

// Drops every output line the NOISE list covers. Returns undefined when the
// output is clean, so it takes the normal path untouched.
function trimNoise(response) {
  const text = outputText(response);
  const name = firstMatch(NOISE, text);
  if (!name) return undefined;
  const lines = text.split("\n");
  const kept = lines.filter((line) => !firstMatch(NOISE, line));
  return { name, kept: kept.join("\n"), dropped: lines.length - kept.length };
}

const pending = new Map(); // id → {res, key} awaiting a decision
let seq = 0, island, islandReady, rulesFile;
let savedRules = {};       // key → "allow" | "deny", persisted

// "ask on everything": when on, a clean call is still challenged on the island
// instead of sailing through. Seeded from CMA_ASK_ALL at boot, flipped live over
// POST /settings, persisted so a restart keeps whatever was chosen.
let settings = { askAll: false }, settingsFile;

function loadSettings() {
  settingsFile = join(app.getPath("userData"), "settings.json");
  if (existsSync(settingsFile)) try { settings = { ...settings, ...JSON.parse(readFileSync(settingsFile, "utf8")) }; } catch {}
  if (process.env.CMA_ASK_ALL) settings.askAll = process.env.CMA_ASK_ALL !== "0";
}

const saveSettings = () => writeFileSync(settingsFile, JSON.stringify(settings, null, 1));

// The synthetic hit that stands in for "no rule fired, but ask anyway". It rides
// the normal hits array so the island, the event log and the saved-rule key all
// treat it like any other reason to stop.
const ASK_ALL = "ask-all";

function loadRules() {
  rulesFile = join(app.getPath("userData"), "decisions.json");
  if (existsSync(rulesFile)) try { savedRules = JSON.parse(readFileSync(rulesFile, "utf8")); } catch {}
}

// rubbish index: rows the user marked in the trajectory; similar future tool
// calls are challenged on the island instead of sailing through
let rubbish;
// blocked index: every call that was actually denied — by a person on the
// island, by a saved rule, or reported blocked by the feed. A new call that
// looks like one of these gets a human review, not a pass.
let blockedIndex;
// per-thread JSONL under userData/sessions — the analysable record of
// everything codex reported, keyed the way codex keys it
let sessions;
const threadOf = (x) => x?.context?.thread_id ?? x?.ctx?.thread_id ?? x?.thread_id;

// GET lists, POST {text} adds, DELETE {text} prunes — same shape for both indexes
function handleIndex(store, req, res) {
  res.setHeader("content-type", "application/json");
  if (req.method === "GET") {
    return res.end(JSON.stringify({ count: store.size(), texts: store.texts().slice(-20) }));
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    try {
      const { text } = JSON.parse(Buffer.concat(chunks).toString());
      if (!text) throw new Error("no text");
      if (req.method === "DELETE") {
        return res.end(JSON.stringify({ ok: store.remove(String(text)), count: store.size() }));
      }
      res.end(JSON.stringify({ ok: true, count: store.add(String(text)) }));
    } catch { res.statusCode = 400; res.end('{"ok":false,"error":"expected {text}"}'); }
  });
}

function askIsland(req, res, key) {
  const id = String(++seq);
  pending.set(id, { res, key, text: req.text });
  // The island loads its page asynchronously at boot, so an early review can
  // land before show() exists. Waiting for the load turns that race into a
  // short delay instead of a call that hangs until the guardian times out.
  islandReady
    // show() reports the height the content needs, so the window always fits it
    .then(() => island.webContents.executeJavaScript(`show(${JSON.stringify({ id, ...req })})`))
    .then((h) => {
      const display = screen.getPrimaryDisplay();
      const w = 520;
      island.setBounds({
        x: Math.round(display.workArea.x + display.workArea.width / 2 - w / 2),
        y: display.workArea.y + 8, // floats just under the menu bar, like a native HUD
        width: w,
        height: Math.ceil(Number(h) || 200),
      });
      island.showInactive(); // don't steal focus from the agent's terminal
    })
    .catch((e) => {
      // No island means no way to ask, and a gate that cannot ask must not
      // silently pass. Deny loudly rather than leave the caller hanging.
      console.error("island failed to render; denying", id, e);
      settle(id, false, false);
    });
}

function settle(id, allow, always) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (always) {
    savedRules[p.key] = allow ? "allow" : "deny";
    writeFileSync(rulesFile, JSON.stringify(savedRules, null, 1));
  }
  if (!allow && p.text) blockedIndex.add(p.text); // a human deny seeds the index
  p.res.end(JSON.stringify({ allow, verdict: allow ? "user-approved" : "user-denied" }));
  if (pending.size === 0) island.hide();
}

function handleToolcall(req, res) {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    let call;
    try { call = JSON.parse(Buffer.concat(chunks).toString()); }
    catch { res.statusCode = 400; return res.end('{"error":"invalid JSON"}'); }
    const text = `${call.tool ?? ""} ${typeof call.args === "string" ? call.args : JSON.stringify(call.args ?? "")}`;
    // the skip list first: a call that is only a waste of a turn is refused
    // here, before the rules and the indexes, and never reaches the island
    const garbage = firstMatch(GARBAGE, text);
    if (garbage) {
      events.push({ kind: "toolcall", tool: call.tool, hits: [`garbage:${garbage}`], receivedAt: new Date().toISOString() });
      appendFileSync(eventsFile, JSON.stringify(events[events.length - 1]) + "\n");
      return res.end(JSON.stringify({ allow: false, verdict: "garbage", reason: `skipped: ${garbage}` }));
    }
    const hits = scan(text);
    // keyword rules catch known-bad shapes; the rubbish index catches whatever
    // the user personally declared junk. Stable label so saved decisions stick.
    const junk = rubbish.match(text);
    if (junk) hits.push("rubbish-similar");
    // a call that looks like one that was already denied gets a human look
    const past = blockedIndex.match(text);
    if (past) hits.push("similar-to-blocked");
    // before the event is written, so the log records the reason the call was
    // actually challenged rather than the empty hits it had a moment earlier
    if (hits.length === 0 && settings.askAll) hits.push(ASK_ALL);
    events.push({ kind: "toolcall", tool: call.tool, hits, receivedAt: new Date().toISOString() });
    appendFileSync(eventsFile, JSON.stringify(events[events.length - 1]) + "\n");
    if (hits.length === 0) return res.end('{"allow":true,"verdict":"clean"}');
    const key = `${call.tool ?? "unknown"}|${hits.join(",")}`;
    const saved = savedRules[key];
    if (saved) {
      if (saved === "deny") blockedIndex.add(text); // rule denials keep seeding
      return res.end(JSON.stringify({ allow: saved === "allow", verdict: `rule-${saved}` }));
    }
    const near = [junk, past].filter(Boolean).sort((a, b) => b.sim - a.sim)[0];
    askIsland({ tool: call.tool, text, hits,
                match: near && { sim: Math.round(near.sim * 100), text: near.text,
                                 kind: near === past ? "blocked" : "rubbish" } }, res, key);
  });
}

// GET → current settings, POST {askAll} → flip it live, no restart needed
function handleSettings(req, res) {
  res.setHeader("content-type", "application/json");
  if (req.method === "GET") return res.end(JSON.stringify(settings));
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if ("askAll" in body) settings.askAll = Boolean(body.askAll);
      saveSettings();
      res.end(JSON.stringify(settings));
    } catch { res.statusCode = 400; res.end('{"error":"expected {askAll}"}'); }
  });
}

function handleDecision(req, res) {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    try { const { id, allow, always } = JSON.parse(Buffer.concat(chunks).toString()); settle(id, Boolean(allow), Boolean(always)); } catch {}
    res.end('{"ok":true}');
  });
}
// --- guardian REST API (codex PR #16 ApiGuardian) ---------------------------
// codex config:  [guardian] mode = "api"  endpoint = "http://127.0.0.1:4490"
//                request_timeout raised past the island's 30s auto-deny.
// POST /v1/reviews {context, action} → decided verdict, or 202+Location while
// a human decides on the island; GET /v1/reviews/<id> polls it.
// POST /v1/activities {items:[{context, activity}]} → appended to events.
// ponytail: reviews/idem maps grow per session; prune when someone leaves the
// app running for weeks.
const reviews = new Map(); // id → { status: "pending"|"decided", verdict? }
const idem = new Map();    // idempotency-key → review id (a retry must not re-decide)
// One human answer covers the turn: codex reviews the same action at up to
// three gates (prompt, tool_call, tool_output), and asking three times for the
// same rule hits in the same turn is noise, not safety.
const turnGrants = new Map(); // `${turn_id}|${hits}` → allow

const verdictFor = (allow) =>
  allow ? { decision: "allow" } : { decision: "deny", reason: "denied by CleanMyAgent" };

function respondReview(res, id) {
  const r = reviews.get(id);
  if (!r) { res.statusCode = 404; return res.end('{"title":"unknown review"}'); }
  if (r.status === "pending") {
    res.statusCode = 202;
    res.setHeader("location", `/v1/reviews/${id}`);
    res.setHeader("retry-after", "1");
    return res.end(JSON.stringify({ review_id: id, status: "pending" }));
  }
  res.end(JSON.stringify({ review_id: id, status: "decided", verdict: r.verdict }));
}

function handleReviewPost(req, res) {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString()); }
    catch { res.statusCode = 400; return res.end('{"title":"invalid JSON"}'); }
    const key = String(req.headers["idempotency-key"] ?? `no-key-${++seq}`);
    if (idem.has(key)) return respondReview(res, idem.get(key));
    const id = `rev-${++seq}`;
    idem.set(key, id);

    const text = JSON.stringify(body.action ?? "");
    const tool = body.action?.tool_name ?? body.action?.tool ?? body.action?.type ?? "codex";
    const kind = body.action?.action;
    // the firehose entry, the per-thread copy and "answer it now" — hoisted so
    // the skip list can record its own decisions before the rules ever run
    const logEvent = (hits) => {
      events.push({ kind: "review", tool, hits, receivedAt: new Date().toISOString() });
      appendFileSync(eventsFile, JSON.stringify(events[events.length - 1]) + "\n");
    };
    // reviews land in the same per-thread file, verdict stamped when decided
    const logReview = (verdict, decidedBy, hits) => sessions.append(threadOf(body), {
      kind: "review", review_id: id, ...body, hits, verdict, decidedBy,
      receivedAt: new Date().toISOString(),
    });
    const decide = (verdict, decidedBy, hits) => {
      logEvent(hits);
      reviews.set(id, { status: "decided", verdict });
      logReview(verdict, decidedBy, hits);
      return respondReview(res, id);
    };

    // The skip list, ahead of everything else. A call it covers is refused on
    // the spot with the reason it was refused for; noisy output comes back with
    // the noise taken out. Neither asks a person, and neither is remembered as
    // a rule — the list is the rule.
    if (kind === "tool_call" || kind === "approval") {
      const garbage = firstMatch(GARBAGE, text);
      if (garbage) {
        return decide({ decision: "deny", reason: `skipped: ${garbage} — it burns a turn and proves nothing` },
                      "garbage", [`garbage:${garbage}`]);
      }
    }
    if (kind === "tool_output") {
      const noise = trimNoise(body.action?.tool_response);
      if (noise) {
        return decide(noise.kept.trim()
          ? { decision: "rewrite", payload: noise.kept, note: `dropped ${noise.dropped} line(s) of ${noise.name}` }
          : { decision: "deny", reason: `skipped: the output was nothing but ${noise.name}` },
          "noise", [`noise:${noise.name}`]);
      }
    }

    // keyword rules describe actions; a tool *output* is not one, so it only
    // faces the vector checks — this alone drops one popup per flagged call
    const hits = kind === "tool_output" ? [] : scan(text);
    // the rubbish index is taste, not danger: match it strictly (0.90) so it
    // challenges near-duplicates, not everything in the same neighbourhood
    const junk = rubbish.match(text, 0.90);
    if (junk) hits.push("rubbish-similar");
    const past = blockedIndex.match(text);
    if (past) hits.push("similar-to-blocked");
    if (hits.length === 0 && settings.askAll) hits.push(ASK_ALL);
    logEvent(hits);

    if (hits.length === 0) {
      reviews.set(id, { status: "decided", verdict: verdictFor(true) });
      logReview(verdictFor(true), "clean", hits);
      return respondReview(res, id);
    }
    const ruleKey = `${tool}|${hits.join(",")}`;
    const saved = savedRules[ruleKey];
    if (saved) {
      if (saved === "deny") blockedIndex.add(text);
      reviews.set(id, { status: "decided", verdict: verdictFor(saved === "allow") });
      logReview(verdictFor(saved === "allow"), `rule-${saved}`, hits);
      return respondReview(res, id);
    }
    // a human already answered for these hits in this turn — honour it
    // A turn grant is inferred, not chosen: one answer covers every later call
    // with the same hits in the turn. That is the right call for a rule hit, but
    // it would turn "ask me about everything" into "ask me once per turn", so
    // ask-all challenges skip it. An explicit "always" (savedRules, above) still
    // counts — the user picked that one.
    const turnKey = `${body.context?.turn_id ?? ""}|${hits.join(",")}`;
    if (!hits.includes(ASK_ALL) && body.context?.turn_id && turnGrants.has(turnKey)) {
      const allow = turnGrants.get(turnKey);
      reviews.set(id, { status: "decided", verdict: verdictFor(allow) });
      logReview(verdictFor(allow), "turn-grant", hits);
      return respondReview(res, id);
    }
    reviews.set(id, { status: "pending" });
    const near = [junk, past].filter(Boolean).sort((a, b) => b.sim - a.sim)[0];
    // adapter: settle() answers an http res; here the answer lands in the map
    // the poller reads instead
    askIsland(
      { tool, text, hits,
        match: near && { sim: Math.round(near.sim * 100), text: near.text,
                         kind: near === past ? "blocked" : "rubbish" } },
      { end: (out) => {
          const allow = JSON.parse(out).allow;
          reviews.set(id, { status: "decided", verdict: verdictFor(allow) });
          if (body.context?.turn_id && !hits.includes(ASK_ALL)) turnGrants.set(turnKey, allow);
          logReview(verdictFor(allow), "island", hits);
        } },
      ruleKey);
    respondReview(res, id); // 202 — ApiGuardian polls the Location
  });
}

function handleActivities(req, res) {
  const chunks = [];
  let size = 0;
  req.on("data", (c) => { size += c.length; if (size > 5e6) req.destroy(); chunks.push(c); });
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    let batch;
    try { batch = JSON.parse(Buffer.concat(chunks).toString()); }
    catch { res.statusCode = 400; return res.end('{"title":"invalid JSON"}'); }
    const items = Array.isArray(batch.items) ? batch.items : [];
    for (const item of items) {
      const ev = { kind: "activity", ...item, receivedAt: new Date().toISOString() };
      events.push(ev);
      appendFileSync(eventsFile, JSON.stringify(ev) + "\n");
      sessions.append(threadOf(item), ev); // the per-thread copy analysis reads
    }
    res.end(JSON.stringify({ ok: true, count: items.length }));
  });
}
// --- deep scan ------------------------------------------------------------
// POST /deep-scan {file?} → ship the rollout log to the user's Equile Grok
// agent, wait for its annotations, return them shaped like scan Findings.
// One long-poll request; the run takes minutes and the caller just waits.

const SESSIONS_DIR = join(homedir(), ".codex", "sessions");
const LOG_CAP = 5 * 1024 * 1024; // inline resource limit is ~7 MB post-base64

const DEEP_PROMPT = `Read session/rollout.jsonl: a Codex agent session rollout log, one JSON object per line ({timestamp, type, payload}; types: session_meta, turn_context, response_item, event_msg). It may be tail-truncated.

Annotate it. Report findings in two areas:
- waste: repeated or redundant context re-sent every turn, oversized tool schemas, retry loops, verbose payloads that burn tokens without changing the outcome
- security: dangerous tool calls (destructive shell, credential access, exfiltration, pipe-to-shell), prompt-injection attempts, obfuscated commands

Only report what the log actually shows. End your final message with exactly one JSON document, no fences, of this shape:
{"findings": [{"severity": "critical"|"warn"|"info", "title": "short title", "where": "the tool/turn/file it concerns", "evidence": "the measurement or observation that makes it a finding", "excerpt": "optional short verbatim quote", "fix": {"label": "short action", "detail": "one sentence"}}]}`;

// The API does not accept outputSchema yet, so the deliverable is prompt-enforced
// JSON at the end of finalOutput. structuredOutput wins if the backend grows it.
function parseFindings(run) {
  const direct = run.structuredOutput;
  if (direct && Array.isArray(direct.findings)) return direct.findings;
  const m = (run.finalOutput ?? "").match(/\{[\s\S]*\}/);
  if (m) try {
    const o = JSON.parse(m[0]);
    if (Array.isArray(o.findings)) return o.findings;
  } catch {}
  return null;
}

function latestRollout() {
  if (!existsSync(SESSIONS_DIR)) return null;
  let best = null, bestT = 0;
  for (const rel of readdirSync(SESSIONS_DIR, { recursive: true })) {
    if (!String(rel).endsWith(".jsonl")) continue;
    const p = join(SESSIONS_DIR, String(rel));
    const t = statSync(p).mtimeMs;
    if (t > bestT) { bestT = t; best = p; }
  }
  return best;
}

// Whole file when it fits; otherwise the session_meta first line + the last 5 MB.
function readLog(file) {
  const buf = readFileSync(file);
  if (buf.length <= LOG_CAP) return buf.toString("utf8");
  const head = buf.subarray(0, buf.indexOf(10) + 1);
  let tail = buf.subarray(buf.length - LOG_CAP);
  tail = tail.subarray(tail.indexOf(10) + 1); // drop the line the cut split
  return head.toString("utf8") + tail.toString("utf8");
}

function handleDeepScan(req, res) {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    const fail = (code, error) => { res.statusCode = code; res.end(JSON.stringify({ error })); };
    const apiKey = process.env.EQUILE_API_KEY;
    if (!apiKey) return fail(503, "EQUILE_API_KEY not set — export it and restart the app");
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch {}
    const file = body.file ?? latestRollout();
    if (!file || !existsSync(file)) return fail(404, "no rollout log found under ~/.codex/sessions");

    const equile = createEquile({
      baseUrl: process.env.EQUILE_BASE_URL ?? "https://api.equile.tech",
      apiKey,
    });
    equile.agentRuns
      .createAndWait({
        provider: "grok",
        prompt: DEEP_PROMPT,
        resources: [{ contentBase64: Buffer.from(readLog(file)).toString("base64"), path: "session/rollout.jsonl" }],
        timeoutSeconds: 900,
      })
      .then(({ run }) => {
        const raw = parseFindings(run);
        if (!raw) return fail(502, "run completed but its output had no findings JSON");
        const findings = raw.map((f, i) => ({
          id: `deep-${i}`,
          source: "session",
          severity: ["critical", "warn", "info"].includes(f.severity) ? f.severity : "info",
          title: String(f.title ?? "Untitled finding"),
          where: `Grok · ${f.where ?? file}`,
          evidence: String(f.evidence ?? ""),
          ...(f.excerpt ? { excerpt: String(f.excerpt) } : {}),
          options: [
            { id: "fix", label: String(f.fix?.label ?? "Fix"), detail: String(f.fix?.detail ?? ""),
              reclaimsPerSession: 0, reclaimsPerRequest: 0, cost: "manual change — nothing applied automatically" },
            { id: "keep", label: "Keep as is", detail: "Leave it alone.",
              reclaimsPerSession: 0, reclaimsPerRequest: 0, cost: "" },
          ],
          recommend: "keep",
        }));
        res.end(JSON.stringify({ file, findings, usage: run.usage }));
      })
      .catch((e) => fail(502, String(e?.message ?? e)));
  });
}
// --------------------------------------------------------------------------

function serveApp() {
  createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    if (path === "/events") return handleEvents(req, res, url);
    if (path === "/rubbish") return handleIndex(rubbish, req, res);
    // POST is deliberately absent for /blocked: it fills itself from denials
    if (path === "/blocked" && req.method !== "POST") return handleIndex(blockedIndex, req, res);
    if (path === "/toolcall" && req.method === "POST") return handleToolcall(req, res);
    if (path === "/v1/reviews" && req.method === "POST") return handleReviewPost(req, res);
    if (path.startsWith("/v1/reviews/") && req.method === "GET") {
      res.setHeader("content-type", "application/json");
      return respondReview(res, path.slice("/v1/reviews/".length));
    }
    if (path === "/v1/activities" && req.method === "POST") return handleActivities(req, res);
    if (path === "/sessions") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(sessions.list()));
    }
    if (path.startsWith("/sessions/")) {
      res.setHeader("content-type", "application/json");
      const entries = sessions.read(decodeURIComponent(path.slice("/sessions/".length)));
      if (!entries) { res.statusCode = 404; return res.end('{"title":"unknown session"}'); }
      return res.end(JSON.stringify(entries));
    }
    if (path === "/settings") return handleSettings(req, res);
    if (path === "/decision" && req.method === "POST") return handleDecision(req, res);
    if (path === "/deep-scan" && req.method === "POST") return handleDeepScan(req, res);
    // /sessions is the guardian's per-thread store; the codex rollout files on
    // disk are a different thing and live here
    if (path === "/rollouts") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(rollouts().map(({ path: _p, ...s }) => s)));
    }
    // ?id= picks one and makes it current; bare GET returns whatever is current
    if (path === "/rollout") {
      res.setHeader("content-type", "application/json");
      return loadSession(url.searchParams.get("id"))
        .then((s) => res.end(JSON.stringify(s ?? { error: "no session" })))
        .catch((e) => { res.statusCode = 500; res.end(JSON.stringify({ error: String(e?.message ?? e) })); });
    }
    if (path === "/island") {
      res.setHeader("content-type", "text/html");
      return res.end(readFileSync(fileURLToPath(new URL("./island.html", import.meta.url))));
    }
    if (path === "/snapshot" || path === "/apply") {
      const up = request({ host: "127.0.0.1", port: API_PORT, path, method: req.method },
        (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
      up.on("error", () => { res.statusCode = 502; res.end("{}"); });
      req.pipe(up);
      return;
    }
    const file = join(DIST, path === "/" ? "index.html" : path.slice(1));
    if (!file.startsWith(DIST) || !existsSync(file)) { // ponytail: SPA fallback to index
      res.setHeader("content-type", "text/html");
      return res.end(readFileSync(join(DIST, "index.html")));
    }
    res.setHeader("content-type", MIME[extname(file)] ?? "application/octet-stream");
    res.end(readFileSync(file));
  }).listen(APP_PORT, "127.0.0.1");
}

// What the app itself knows. No sidecar involved, so this is always available
// — the panel renders from it whether or not an ops snapshot exists.
function localState() {
  const gated = events.filter((e) => e.kind === "review" || e.kind === "toolcall");
  const logs = sessions.list();
  return {
    sessions: logs.length,
    events: events.length,
    reviewed: gated.length,
    challenged: gated.filter((e) => e.hits?.length).length,
    blocked: blockedIndex.size(),
    rubbish: rubbish.size(),
    rules: Object.keys(savedRules).length,
    recent: logs.slice(0, 5),
  };
}

async function refresh() {
  // The ops snapshot is optional and normally absent — nothing serves 4488
  // unless someone runs a sidecar there. A 502 is not a reason to show
  // nothing, so the panel gets local state either way and the snapshot-backed
  // cards simply don't render without one.
  let ops = null;
  try {
    const res = await fetch(`http://127.0.0.1:${APP_PORT}/snapshot`);
    if (res.ok) ops = await res.json();
  } catch { /* no sidecar; ops stays null */ }
  const payload = JSON.stringify({ local: localState(), ops });
  try {
    await win.webContents.executeJavaScript(`render(${payload})`);
  } catch (e) {
    console.error("panel render failed:", e); // a stuck panel should say why
  }
}

function toggle() {
  if (win.isVisible()) return win.hide();
  const { x, y, width } = tray.getBounds();
  const display = screen.getDisplayNearestPoint({ x, y });
  const [w] = win.getSize();
  const wx = Math.min(Math.round(x + width / 2 - w / 2), display.workArea.x + display.workArea.width - w - 8);
  win.setPosition(wx, display.workArea.y + 6); // native popovers sit ~6px below the menu bar
  void refresh();
  win.show();
}

function openFullApp(url) {
  const full = new BrowserWindow({ width: 1100, height: 760, titleBarStyle: "hiddenInset" });
  const home = `http://127.0.0.1:${APP_PORT}/`;
  // the panel's links carry the tab hash; anything else opens the app home
  full.loadURL(url?.startsWith(home) ? url : home);
  win.hide();
}

app.whenReady().then(() => {
  app.dock?.hide();

  loadEvents();
  loadSettings();
  loadRules();
  rubbish = createRubbishStore(join(app.getPath("userData"), "rubbish.json"));
  blockedIndex = createRubbishStore(join(app.getPath("userData"), "blocked.json"));
  sessions = createSessionStore(join(app.getPath("userData"), "sessions"));
  serveApp();

  win = new BrowserWindow({
    width: 380, height: 470, show: false, frame: false, resizable: false,
    skipTaskbar: true, alwaysOnTop: true, transparent: true, hasShadow: true,
  });
  win.on("blur", () => win.hide());
  win.loadFile(PANEL);
  // window.open() from the panel = "Open CleanMyAgent" → full webui window
  win.webContents.setWindowOpenHandler(({ url }) => { openFullApp(url); return { action: "deny" }; });

  // notch "island" for tool-call approvals — CodeIsland-style, top-center over the notch
  island = new BrowserWindow({
    width: 500, height: 220, show: false, frame: false, transparent: true,
    resizable: false, skipTaskbar: true, hasShadow: false, focusable: true,
  });
  island.setAlwaysOnTop(true, "screen-saver");
  island.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  islandReady = new Promise((resolve, reject) => {
    island.webContents.once("did-finish-load", resolve);
    island.webContents.once("did-fail-load", (_e, code, desc) => reject(new Error(`island load failed: ${code} ${desc}`)));
  });
  island.loadURL(`http://127.0.0.1:${APP_PORT}/island`);

  // "Template" suffix → macOS tints it for light/dark menu bars automatically
  tray = new Tray(fileURLToPath(new URL("./trayTemplate.png", import.meta.url)));
  tray.setToolTip("CleanMyAgent");
  tray.on("click", toggle);
});

app.on("window-all-closed", () => {}); // tray app: keep running
