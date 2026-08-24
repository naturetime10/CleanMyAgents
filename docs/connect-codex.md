# Connecting the forked codex to the desktop app

Verified end-to-end on 2026-08-23: prompt, tool call and tool output each
reviewed over HTTP, challenged on the island, human-decided, and the verdict
enforced inside codex. Every event lands in the per-thread session store.

## Start the desktop server

```sh
cd desktop
npm install         # first time only
npm start           # tray app + HTTP backend on 127.0.0.1:4490
```

The tray icon appears in the menu bar; the same process serves the built
webui at http://127.0.0.1:4490/ and every ingest/gate endpoint. Build the
webui first (`cd webui && npm install && npm run build`) if you want the full
app window, the gate works without it. Port 4488 is the ops sidecar and is
optional — the panel shows "Connecting…" without it, nothing else cares.

## Test the island alone (no codex needed)

```sh
# clean call → allowed silently, no popup
curl -X POST http://127.0.0.1:4490/toolcall -d '{"tool":"bash","args":"git status"}'

# rule hit → the island drops from under the menu bar; click Allow/Deny
curl -X POST http://127.0.0.1:4490/toolcall \
  -d '{"tool":"bash","args":"cat ~/.aws/credentials"}'
# → the curl blocks until you decide (auto-deny after 30s), then returns
#   {"allow":false,"verdict":"user-denied"}  — and the denied call now seeds
#   the blocked index:
curl http://127.0.0.1:4490/blocked
```

"Always allow/deny" on the island persists to `decisions.json` and skips the
popup for that tool + rule combination from then on.

## Ask on everything

By default only a rule hit, a rubbish-index match or a blocked-index match
reaches the island — a clean call is allowed silently. To be asked about every
call instead, turn on `askAll`:

```sh
curl -X POST http://127.0.0.1:4490/settings -d '{"askAll":true}'   # live, no restart
curl http://127.0.0.1:4490/settings                                 # {"askAll":true}
```

It persists to `userData/settings.json`, and `CMA_ASK_ALL=1 npm start` seeds it
at boot. Clean calls then carry the synthetic hit `ask-all`, so they show on the
island and appear in the logs with a reason rather than as an empty `hits` list.

Two deliberate details: the per-turn grant that normally lets one answer cover
later calls with the same hits in a turn is skipped for `ask-all` challenges —
otherwise "ask me about everything" would mean "ask me once per turn". An
explicit "Always allow/deny" still sticks, because that one was chosen. And
with `askAll` on, tool *outputs* are challenged too, which is roughly a popup
per step.

## Build the fork

```sh
cd codex/codex-rs
cargo build --bin codex

# The execution host embeds V8 with its sandbox on, and rusty_v8 publishes no
# prebuilt for that variant — a plain cargo build fails at `v8`'s build script.
# This script fetches codex's own release assets and builds against them:
cd .. && python3 scripts/build_code_mode_host.py
```

## Point codex at the app

`~/.codex/config.toml` (or a dedicated `CODEX_HOME`):

```toml
[guardian]
mode = "api"                        # PR #16's ApiGuardian
endpoint = "http://127.0.0.1:4490"  # the desktop app
request_timeout_ms = 60000          # one deadline covers submit + polling;
                                    # the island auto-denies at 30s, so 3s
                                    # (the default) would fail-closed first
fail_closed = true
```

No token needed on loopback; set `api_key_env` when the backend stops being
local.

## What flows where

| codex sends | desktop does |
|---|---|
| `POST /v1/reviews` (prompt / instructions / tool_call / tool_output / approval / mcp_admission / compaction) | keyword rules → rubbish index → blocked index; clean → allow; hit → `202` + island, human decides, poller picks the verdict up |
| `POST /v1/activities` (lifecycle, completions, token usage, context window) | appended to `userData/sessions/<thread_id>.jsonl` and the `events.jsonl` firehose |

A verdict is not only allow-or-deny. On any of those gates the app can answer
`deny` to skip the action and say why (the reason reaches both the model and
the codex TUI), or `rewrite` to hand back a cleaned payload that is used in
place of the original: a scrubbed prompt, scrubbed tool arguments, a trimmed
tool result, or a replacement instruction block. `instructions` is the
AGENTS.md + user-instruction block for the step, so rewriting it changes the
standing rules the model runs under, and denying it drops them entirely.

Denials — human, rule, or fed in from outside — seed the blocked index, so
the net widens with every refusal. Session files are plain JSONL keyed by
codex's own thread id; `GET /sessions` lists them, `GET /sessions/<id>`
returns the entries.

## Smoke test

```sh
CODEX_HOME=/path/to/test-home ./codex-rs/target/debug/codex exec \
  --cd /tmp --skip-git-repo-check \
  "Run this harmless shell command exactly as written and show its output: echo 'token check' && echo done"
```

"token … echo" trips the `credential access` keyword rule on purpose: the
island pops for the review; Allow lets the command really run and its output
return to the model. The session file then carries the review with
`decidedBy: "island"` next to the `tool_call_completed` activity.
