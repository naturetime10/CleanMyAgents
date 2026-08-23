/**
 * Step one: what to read.
 *
 * Choosing everything is offered but not defaulted. A sessions directory on a
 * working machine reaches tens of gigabytes with single rollout files past
 * 80 MB, so "all" is a decision, not a starting position.
 */
import { useEffect, useMemo, useState } from "react";
import { Icon } from "../components";
import type { SessionRef } from "./model";
import type { Scope } from "./api";
import { fetchSessions } from "./api";

const mb = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(0)} MB` : `${Math.round(n / 1e3)} KB`);

/** Big files dominate the read; worth showing before someone picks them. */
const HEAVY_BYTES = 20_000_000;

export default function Scope({ onStart }: { onStart: (scope: Scope, live: boolean) => void }) {
  const [sessions, setSessions] = useState<SessionRef[] | null>(null);
  const [live, setLive] = useState(false);
  const [all, setAll] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    void fetchSessions().then((r) => {
      if (!alive) return;
      setSessions(r.sessions);
      setLive(r.live);
      // Default to the ten newest, which is the cheap useful answer.
      setPicked(new Set(r.sessions.slice(0, 10).map((s) => s.id)));
    });
    return () => { alive = false; };
  }, []);

  const chosen = useMemo(
    () => (all ? (sessions ?? []) : (sessions ?? []).filter((s) => picked.has(s.id))),
    [all, picked, sessions],
  );
  const bytes = chosen.reduce((n, s) => n + s.bytes, 0);
  const days = new Set(chosen.map((s) => s.day)).size;
  const heavy = chosen.filter((s) => s.bytes >= HEAVY_BYTES).length;

  const toggle = (id: string) =>
    setPicked((p) => {
      const next = new Set(p);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <div className="sp">
      <div className="sp-left">
        <h1>What should be read?</h1>
        <p className="sp-sub">
          Hooks and MCP servers are always read. Sessions are where the cost is measured.
        </p>

        <div className="sp-choices">
          <button className="sp-choice" aria-pressed={all} onClick={() => setAll(true)}>
            <span className="sp-radio" />
            <span>
              <b>Every session</b>
              <i>{sessions ? `${sessions.length} files · ${mb(sessions.reduce((n, s) => n + s.bytes, 0))}` : "…"}</i>
            </span>
          </button>
          <button className="sp-choice" aria-pressed={!all} onClick={() => setAll(false)}>
            <span className="sp-radio" />
            <span>
              <b>Choose sessions</b>
              <i>{picked.size} selected</i>
            </span>
          </button>
        </div>

        {!all && (
          <div className="sp-list">
            {(sessions ?? []).map((s) => (
              <label className="sp-row" key={s.id} data-on={picked.has(s.id) || undefined}>
                <input type="checkbox" checked={picked.has(s.id)} onChange={() => toggle(s.id)} />
                <span className="sp-when">{s.startedAt.replace("T", " ").slice(0, 16)}</span>
                <span className="sp-size" data-heavy={s.bytes >= HEAVY_BYTES || undefined}>{mb(s.bytes)}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      <aside className="sp-right">
        <div className="sp-card">
          <div className="sp-num">
            <b>{chosen.length}</b>
            <span>sessions</span>
          </div>
          <dl className="sp-kv">
            <dt>Spanning</dt><dd>{days} {days === 1 ? "day" : "days"}</dd>
            <dt>To read</dt><dd>{mb(bytes)}</dd>
            <dt>Source</dt><dd>{live ? "this machine" : "sample data"}</dd>
          </dl>
          {heavy > 0 && (
            <p className="sp-warn">
              <Icon d="M12 3l9 16H3zM12 9v5m0 3h.01" />
              {heavy} {heavy === 1 ? "file is" : "files are"} over 20 MB. They are streamed, not
              loaded, but the scan will take longer.
            </p>
          )}
          <button
            className="sp-go"
            disabled={!chosen.length}
            onClick={() => onStart(all ? { kind: "all" } : { kind: "sessions", ids: [...picked] }, live)}
          >
            Scan
          </button>
        </div>
      </aside>
    </div>
  );
}
