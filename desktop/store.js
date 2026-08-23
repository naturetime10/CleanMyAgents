// Per-session storage for everything codex sends over: one JSONL file per
// thread under <userData>/sessions/. Append-only, so a crash mid-write loses
// at most one line and analysis tools can tail it.
// ponytail: flat files, no index — a real store when queries outgrow ls+read.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function createSessionStore(dir) {
  mkdirSync(dir, { recursive: true });
  // thread ids come off the wire; they become filenames, so anything outside
  // [A-Za-z0-9._-] is replaced rather than trusted
  const safe = (id) => (String(id ?? "").replace(/[^A-Za-z0-9._-]/g, "_") || "_unknown");
  return {
    append(threadId, entry) {
      appendFileSync(join(dir, `${safe(threadId)}.jsonl`), JSON.stringify(entry) + "\n");
    },
    list() {
      return readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => {
          const st = statSync(join(dir, f));
          return { id: f.slice(0, -6), bytes: st.size, updatedAt: st.mtime.toISOString() };
        })
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    read(threadId) {
      const p = join(dir, `${safe(threadId)}.jsonl`);
      if (!existsSync(p)) return null;
      return readFileSync(p, "utf8").split("\n").filter(Boolean).flatMap((l) => {
        try { return [JSON.parse(l)]; } catch { return []; } // skip a torn line
      });
    },
  };
}
