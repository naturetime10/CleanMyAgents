# guardian stub backend

A stand-in for the guardian REST backend, so `[guardian] mode = "api"` can be
developed against without running the desktop app. No dependencies.

```
node guardian-stub.mjs           # scenario 'rules' on 127.0.0.1:4500
node guardian-stub.mjs --help
```

Point codex at it in `config.toml`:

```toml
[guardian]
mode = "api"
endpoint = "http://127.0.0.1:4500/guardian"
request_timeout = "30s"   # raise this before trying --scenario pending
```

## What it speaks

| | |
|---|---|
| `POST {base}/v1/reviews` | one guarded action → a verdict |
| `GET {base}/v1/reviews/<id>` | poll a review left pending |
| `POST {base}/v1/activities` | a batch of recorded activity |

Routes match by suffix, so the stub works under any base the endpoint carries —
`/v1/reviews`, `/guardian/v1/reviews`, and `/api/v1/reviews` all land in the same
handler, and a pending review's `Location` keeps the prefix it arrived under.

`idempotency-key` is honoured: a retry under a key already seen gets the review
it got the first time, never a fresh decision.

## Scenarios

`--scenario rules` (the default) decides per action, and is the one to use when
you want the codex UI to render something other than a wall of green:

- a prompt carrying what looks like a credential → **rewrite**, redacted
- a tool call matching `rm -rf`, `mkfs`, `dd if=`, a fork bomb → **deny**
- a tool output carrying what looks like a credential → **rewrite**, withheld
- everything else → **allow**

Every other scenario answers every review the same way, from `responses.json`:

| scenario | what codex sees |
|---|---|
| `allow` `deny` `rewrite` `defer` | that verdict, decided immediately |
| `pending` | `202` + `Location`, decided after `--pending-ms` (default 2000) |
| `unauthorized` `unavailable` `throttled` | RFC 9457 problem body, `guardian_error: unavailable` |
| `timeout` | `504` with `guardian_error: timeout` |
| `protocol` | a decided review with no verdict — a protocol error, not permission |

`responses.json` is meant to be edited. `review_id` and the pending `location`
are filled in per request, so leave them out of the file.

Add `--bearer <token>` to require an `Authorization` header, which is what
`[guardian] api_key_env` sends.

## The log

Every request is appended to `stub.jsonl` (`--log` to move it, `--quiet` to stop
mirroring it to stdout) as one object per line:

```json
{"at":"…","kind":"review","review_id":"rev-2","action":"tool_call","tool":"Bash","thread_id":"…","decision":"deny","reason":"destructive command against the working tree"}
{"at":"…","kind":"activity","activity":"session_started","thread_id":"…"}
```

`tail -f stub.jsonl` while a session runs is the quickest way to see which gates
codex is actually routing through.
