// CleanMyAgent desktop — menu bar tray with a CleanMyMac-style status panel.
// Full app window serves webui/dist; /snapshot + /apply proxy to the ops sidecar.
//   npm start           (live: needs codex on PATH)
//   npm start -- --demo (canned data)
import { app, Tray, BrowserWindow, screen } from "electron";
import { spawn } from "node:child_process";
import { createServer, request } from "node:http";
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRubbishStore } from "./similarity.js";

const API_PORT = 4488;   // ops sidecar (data API)
const APP_PORT = 4490;   // webui/dist + API proxy, same-origin like prod (4499 is vite dev's)
// ponytail: data engine still lives in the sibling clownfish repo; move it into backend/ when it's ported
const CLI = fileURLToPath(new URL("../../clownfish/src/cli.ts", import.meta.url));
const DIST = fileURLToPath(new URL("../webui/dist/", import.meta.url));
const PANEL = fileURLToPath(new URL("./panel.html", import.meta.url));
const demo = process.argv.includes("--demo");

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
               ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };

app.setName("CleanMyAgent"); // userData → ~/Library/Application Support/CleanMyAgent

let tray, win, sidecar;

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
  ["credential access", /\b(secret|password|api[_-]?key|token|credential)s?\b.{0,40}\b(cat|read|print|echo|curl|post)\b|\b(cat|read)\b.{0,40}\b\.(env|aws|ssh)\b/i],
  ["prompt injection", /ignore (all )?(previous|prior) (instructions|rules)|disregard your (instructions|system prompt)/i],
  ["exfiltration", /\b(curl|wget|fetch|http)\b.{0,60}\b(\.env|id_rsa|keychain|cookies)\b/i],
  ["obfuscation", /base64\s+(-d|--decode)|\beval\s*\(\s*atob/i],
];
const scan = (text) => RULES.filter(([, re]) => re.test(text)).map(([name]) => name);

const pending = new Map(); // id → {res, key} awaiting a decision
let seq = 0, island, rulesFile;
let savedRules = {};       // key → "allow" | "deny", persisted

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

function handleRubbish(req, res) {
  res.setHeader("content-type", "application/json");
  if (req.method !== "POST") {
    return res.end(JSON.stringify({ count: rubbish.size(), texts: rubbish.texts().slice(-20) }));
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    try {
      const { text } = JSON.parse(Buffer.concat(chunks).toString());
      if (!text) throw new Error("no text");
      res.end(JSON.stringify({ ok: true, count: rubbish.add(String(text)) }));
    } catch { res.statusCode = 400; res.end('{"ok":false,"error":"expected {text}"}'); }
  });
}

function askIsland(req, res, key) {
  const id = String(++seq);
  pending.set(id, { res, key, text: req.text });
  // show() reports the height the content needs, so the window always fits it
  island.webContents.executeJavaScript(`show(${JSON.stringify({ id, ...req })})`).then((h) => {
    const display = screen.getPrimaryDisplay();
    const w = 520;
    island.setBounds({
      x: Math.round(display.workArea.x + display.workArea.width / 2 - w / 2),
      y: display.workArea.y + 8, // floats just under the menu bar, like a native HUD
      width: w,
      height: Math.ceil(Number(h) || 200),
    });
    island.showInactive(); // don't steal focus from the agent's terminal
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
    const hits = scan(text);
    // keyword rules catch known-bad shapes; the rubbish index catches whatever
    // the user personally declared junk. Stable label so saved decisions stick.
    const junk = rubbish.match(text);
    if (junk) hits.push("rubbish-similar");
    // a call that looks like one that was already denied gets a human look
    const past = blockedIndex.match(text);
    if (past) hits.push("similar-to-blocked");
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
    const hits = scan(text);
    const junk = rubbish.match(text);
    if (junk) hits.push("rubbish-similar");
    const past = blockedIndex.match(text);
    if (past) hits.push("similar-to-blocked");
    events.push({ kind: "review", tool, hits, receivedAt: new Date().toISOString() });
    appendFileSync(eventsFile, JSON.stringify(events[events.length - 1]) + "\n");

    if (hits.length === 0) {
      reviews.set(id, { status: "decided", verdict: verdictFor(true) });
      return respondReview(res, id);
    }
    const ruleKey = `${tool}|${hits.join(",")}`;
    const saved = savedRules[ruleKey];
    if (saved) {
      if (saved === "deny") blockedIndex.add(text);
      reviews.set(id, { status: "decided", verdict: verdictFor(saved === "allow") });
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
      { end: (out) => reviews.set(id, { status: "decided", verdict: verdictFor(JSON.parse(out).allow) }) },
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
    }
    res.end(JSON.stringify({ ok: true, count: items.length }));
  });
}
// --------------------------------------------------------------------------

function serveApp() {
  createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    if (path === "/events") return handleEvents(req, res, url);
    if (path === "/rubbish") return handleRubbish(req, res);
    if (path === "/blocked") { // read-only: the index fills itself from denials
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ count: blockedIndex.size(), texts: blockedIndex.texts().slice(-20) }));
    }
    if (path === "/toolcall" && req.method === "POST") return handleToolcall(req, res);
    if (path === "/v1/reviews" && req.method === "POST") return handleReviewPost(req, res);
    if (path.startsWith("/v1/reviews/") && req.method === "GET") {
      res.setHeader("content-type", "application/json");
      return respondReview(res, path.slice("/v1/reviews/".length));
    }
    if (path === "/v1/activities" && req.method === "POST") return handleActivities(req, res);
    if (path === "/decision" && req.method === "POST") return handleDecision(req, res);
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

async function refresh() {
  try {
    const snap = await (await fetch(`http://127.0.0.1:${APP_PORT}/snapshot`)).json();
    await win.webContents.executeJavaScript(`render(${JSON.stringify(snap)})`);
  } catch { /* sidecar still booting; panel shows "Connecting…" */ }
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

function openFullApp() {
  const full = new BrowserWindow({ width: 1100, height: 760, titleBarStyle: "hiddenInset" });
  full.loadURL(`http://127.0.0.1:${APP_PORT}/`);
  win.hide();
}

app.whenReady().then(() => {
  app.dock?.hide();

  // reuse an already-running sidecar (e.g. started by `npm run dev` elsewhere), else spawn one
  fetch(`http://127.0.0.1:${API_PORT}/snapshot`).catch(() => {
    sidecar = spawn(process.execPath, [CLI, "ui", String(API_PORT), ...(demo ? ["--demo"] : [])], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "inherit", "inherit"],
    });
  });
  loadEvents();
  loadRules();
  rubbish = createRubbishStore(join(app.getPath("userData"), "rubbish.json"));
  blockedIndex = createRubbishStore(join(app.getPath("userData"), "blocked.json"));
  serveApp();

  win = new BrowserWindow({
    width: 380, height: 470, show: false, frame: false, resizable: false,
    skipTaskbar: true, alwaysOnTop: true, transparent: true, hasShadow: true,
  });
  win.on("blur", () => win.hide());
  win.loadFile(PANEL);
  // window.open() from the panel = "Open CleanMyAgent" → full webui window
  win.webContents.setWindowOpenHandler(() => { openFullApp(); return { action: "deny" }; });

  // notch "island" for tool-call approvals — CodeIsland-style, top-center over the notch
  island = new BrowserWindow({
    width: 500, height: 220, show: false, frame: false, transparent: true,
    resizable: false, skipTaskbar: true, hasShadow: false, focusable: true,
  });
  island.setAlwaysOnTop(true, "screen-saver");
  island.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  island.loadURL(`http://127.0.0.1:${APP_PORT}/island`);

  // "Template" suffix → macOS tints it for light/dark menu bars automatically
  tray = new Tray(fileURLToPath(new URL("./trayTemplate.png", import.meta.url)));
  tray.setToolTip("CleanMyAgent");
  tray.on("click", toggle);
});

app.on("window-all-closed", () => {}); // tray app: keep running
app.on("before-quit", () => sidecar?.kill());
