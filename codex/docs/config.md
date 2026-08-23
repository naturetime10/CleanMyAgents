# Configuration

For basic configuration instructions, see [this documentation](https://developers.openai.com/codex/config-basic).

For advanced configuration instructions, see [this documentation](https://developers.openai.com/codex/config-advanced).

For a full configuration reference, see [this documentation](https://developers.openai.com/codex/config-reference).

## Lifecycle hooks

Admins can set top-level `allow_managed_hooks_only = true` in
`requirements.toml` to ignore user, project, and session hook configs while
still allowing managed hooks from requirements and managed config layers. This
setting is only supported in `requirements.toml`; putting it in `config.toml`
does not enable managed-hooks-only mode.

## Guard layer (`[guardian]`)

The guard layer is an inline reference monitor that runs *above* the hook
subsystem. At every dispatch choke point — prompt intake, tool and MCP calls,
tool results, approvals, MCP server admission — it is asked for a verdict before
any configured hook runs, so its decision cannot be overridden by hook config.
Precedence at a choke point is Guard → Hooks → automated review → user. It also
records session activity that hooks never see, such as token usage and live
context-window occupancy.

```toml
[guardian]
# off | csv | ipc | both | api
# Default: csv for a debug build, off for a release build.
mode = "csv"
# Per-session history. Default: $CODEX_HOME/guardian/debug
debug_dir = "/Users/me/.codex/guardian/debug"
# Socket of the resident guardian process. Default: $CODEX_HOME/guardian/guardian.sock
socket_path = "/Users/me/.codex/guardian/guardian.sock"
# Base URL of the REST backend. Required by mode = "api", ignored otherwise.
endpoint = "https://guardian.example/api"
# Environment variable holding the bearer token for `endpoint`. Optional.
api_key_env = "CODEX_GUARDIAN_TOKEN"
# Deny guarded actions when the guardian cannot be reached. Default: true
fail_closed = true
# Deadline for one round trip to the guardian process. Default: 3000
request_timeout_ms = 3000
```

- `csv` writes one CSV file per session, `<debug_dir>/<thread_id>.csv`, with a
  fixed header and one row per guarded action and recorded activity. It never
  denies anything; it is a debugging and audit record. Beside each file sits a
  `<thread_id>.meta.yml` sidecar holding everything constant for that session —
  the session it belongs to, the account, the model, the originator, the
  starting directory, and running totals. Those are deliberately not columns,
  so grouping sidecars by `session_id` reassembles a run that spawned
  sub-agents without opening a single history file. The TUI session header
  names the directory whenever a mode that records is active.
- `ipc` delegates every decision to a resident local process listening on
  `socket_path`, exchanging newline-delimited JSON: the request carries the
  session context plus the action, and the reply carries a verdict of `allow`,
  `deny`, `rewrite`, or `defer`. `rewrite` replaces a prompt, a tool input, or a
  tool result; `defer` falls through to the layers below.
- `both` records locally and enforces through the resident process.
- `api` delegates every decision to the HTTP backend at `endpoint`, over the
  REST protocol described below. Composing it with local history is not a mode
  yet; pick one or the other.

### The REST protocol (`mode = "api"`)

Two endpoints carry the whole guard protocol, one per half of the guard trait.

`POST {endpoint}/v1/reviews` submits one guarded action and returns the verdict:

```jsonc
// request
{ "context": { "thread_id": "…", "session_id": "…", "turn_id": "…", "cwd": "…",
               "model": "…", "originator": "…", "account": "…", "timestamp": "…" },
  "action":  { "action": "tool_call", "tool_name": "Bash", "call_id": "…",
               "matcher_aliases": [], "tool_input": { … } } }

// 200 / 201 response
{ "review_id": "rev_…", "status": "decided",
  "verdict": { "decision": "deny", "reason": "destroys the working tree" } }
```

`verdict` is one of `allow`, `deny` (with `reason`), `rewrite` (with `payload`
and an optional `note`), or `defer`. Every request carries an
`Idempotency-Key` of `{thread_id}/{turn_id}/{action}/{call_id}`: a retry after a
client-side timeout must return the verdict already recorded, never a fresh
decision.

A backend that needs a human to decide answers `202 Accepted` with
`status: "pending"`, a `Location`, and optionally a `Retry-After` in seconds.
Codex polls that URL until the review is `decided` or the request deadline
expires. It never treats a pending review as permission: on a tool-call gate
`defer` is indistinguishable from `allow`, so an approval nobody answers has to
expire into the fail posture instead.

`POST {endpoint}/v1/activities` reports what already happened, always as a
batch and always answered without a body:

```jsonc
{ "items": [ { "context": { … }, "activity": { "activity": "token_usage",
                                               "total_tokens": 15, … } } ] }
```

Recording is log-only. It runs on a background task, coalesces whatever is
queued into one request, and drops records rather than letting a slow backend
stall a turn.

Failures never become verdicts. `504` and a client-side deadline are a timeout;
`401`, `403`, `429`, and `5xx` mean unavailable; anything else unparseable is a
protocol error. All three reach `fail_closed`, so an unknown action kind must be
rejected with `422` rather than admitted — a guard that silently allows what it
does not understand is not a guard. A backend may name the variant itself with a
`guardian_error` field of `unavailable`, `timeout`, or `protocol` in an RFC 9457
`application/problem+json` body.

Reads — sessions, threads, history — are deliberately not part of this. They
belong to whatever renders a session, not to the guard a turn runs through.

A build from source records by default so that a session run while debugging
leaves a trail without having been configured in advance. Released binaries
default to `off`: writing every prompt and tool result to disk is opt-in. Files
are written `0600` inside a `0700` directory, but they do contain prompt text
and tool output, so treat the directory as sensitive.

With `fail_closed = true` (the default), an unreachable guardian denies guarded
actions, so a session started in `ipc` or `api` mode without a reachable
guardian will have its tool calls blocked. Set `mode = "off"` or
`fail_closed = false` to opt out of that posture.

`api` mode sends prompt text and tool output off the machine, so it is never
selected by default and has to be configured deliberately. Put the bearer token
in the environment variable named by `api_key_env` rather than in `config.toml`,
where a credential outlives the session that needed it. A `mode = "api"` without
a usable `endpoint` is rejected when config loads, not at the first choke
point.

## Content annotations (`chat_message_metadata_passthrough`)

Codex can attach per-message content annotations to each Responses request. A
Responses endpoint that predates the field rejects the *entire* request with
`unknown_parameter`, which fails every turn rather than degrading, so the
feature is off by default:

```toml
[features]
# Only turn this on against an endpoint that accepts the field.
chat_message_metadata_passthrough = true
```

This is independent of `encrypted_function_args`, which is stripped for
non-OpenAI providers regardless of this setting.
