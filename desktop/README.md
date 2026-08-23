# CleanMyAgent — menu bar app

Three surfaces, in order of how often they matter:

| | |
|---|---|
| **tray title** | always visible: wasted tokens per request, or a warning count |
| **island** | appears only when a call wants approval |
| **panel** | a click away: the figures, the standing rules, a link to the console |

```
npm install
npm run dev      # electron-vite, with the renderer hot-reloading
npm test         # decision and risk rules
npm run build
```

The console is expected at `http://127.0.0.1:4499`; override with `CMA_CONSOLE_URL`.
No daemon answering is a normal state — the tray shows `–` rather than an error.

## Decisions

Four answers. The two "once" answers are the large buttons; the two "always"
answers are small, because a standing rule should cost a deliberate click.

A rule is keyed by **tool and rule id**, not by the command:
`Bash|pipe-to-shell`. Keying on the command would ask the same question again
for every URL, when the thing being decided is whether this tool may pipe a
download into a shell at all.

Rules live in `decisions.json` under the app's user-data directory. Deleting a
line there is how a rule is forgotten; the panel has a button for it.

Timeout is 30s and resolves as **deny once** — refusing a call is recoverable,
allowing one nobody looked at is not — and writes no rule, because silence is
not a policy.
