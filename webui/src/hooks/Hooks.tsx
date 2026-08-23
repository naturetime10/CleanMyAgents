/**
 * Hooks — what is installed in this harness, where it hooks in, what it injects
 * and what that costs. Every hook point can be switched off on its own.
 *
 * Data is mock; toggles change local state only.
 */
import { useMemo, useState } from "react";
import { Card, Empty, Kpis, ICON, Icon } from "../components";
import { FLAG_LABEL, FLAG_WHY, isDeadWeight, providerTokens, totals,
         type HookPoint, type Provider, type Trust } from "./model";
import { mockProviders } from "./mock";
import "./hooks.css";

const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

const TRUST_ICON: Record<Trust, string> = {
  trusted: "M4 12l5 5 11-11",
  managed: "M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z",
  untrusted: "M12 8v5m0 3h.01M12 3l9 16H3z",
  modified: "M12 8v5m0 3h.01M12 3l9 16H3z",
};
const TRUST_TEXT: Record<Trust, string> = {
  trusted: "trusted",
  managed: "built in",
  untrusted: "not trusted",
  modified: "changed since trusted",
};

function Point({ point, onToggle, locked }: {
  point: HookPoint; onToggle: () => void; locked: boolean;
}) {
  const [open, setOpen] = useState(false);
  const nothing = point.tokens === 0;
  return (
    <>
      <div className="hk-row" data-off={!point.enabled || undefined} onClick={() => setOpen((v) => !v)}>
        <div className="hk-ev">
          {point.event}
          {point.matcher && <em> · {point.matcher}</em>}
        </div>
        <div className="hk-inj" data-nothing={nothing || undefined}>
          {nothing ? "injects nothing" : point.injects}
          {point.flags?.map((f) => (
            <span className="hk-flag" data-f={f} key={f} title={FLAG_WHY[f]}>{FLAG_LABEL[f]}</span>
          ))}
        </div>
        <div className="hk-num" data-hot={point.tokens >= 1000 || undefined}>
          {point.tokens ? fmt(point.tokens) : "—"}
        </div>
        <div className="hk-num">
          {point.fires}
          <span className="sub">{point.intercepts ? ` · ${point.intercepts}✋` : ""}</span>
        </div>
        <button
          className="hk-sw"
          role="switch"
          aria-checked={point.enabled}
          aria-label={`${point.enabled ? "Disable" : "Enable"} ${point.event}`}
          disabled={locked}
          title={locked ? "Built into the harness — tune it in settings instead" : undefined}
          onClick={(e) => { e.stopPropagation(); onToggle(); }}
        />
      </div>
      {open && (
        <div className="hk-detail">
          <dl>
            <dt>Event</dt><dd>{point.event}</dd>
            <dt>Matcher</dt><dd>{point.matcher ?? "every tool"}</dd>
            <dt>Injects</dt><dd>{nothing ? "nothing" : `${point.injects} · ${point.tokens.toLocaleString()} tokens per session`}</dd>
            <dt>Fired</dt><dd>{point.fires} times</dd>
            <dt>Intercepted</dt><dd>{point.intercepts ? `${point.intercepts} calls blocked or rewritten` : "never"}</dd>
          </dl>
          {point.flags?.length ? (
            <ul className="hk-why">
              {point.flags.map((f) => (
                <li key={f}><b>{FLAG_LABEL[f]}</b> — {FLAG_WHY[f]}</li>
              ))}
            </ul>
          ) : null}
          <div className="hk-label">Command</div>
          <pre className="hk-code">{point.command}</pre>
          {point.sample && (<>
            <div className="hk-label">Injected content</div>
            <pre className="hk-code">{point.sample}</pre>
          </>)}
        </div>
      )}
    </>
  );
}

export default function Hooks() {
  const [providers, setProviders] = useState<Provider[]>(() => mockProviders());
  const sums = useMemo(() => totals(providers), [providers]);

  const toggle = (pid: string, index: number) =>
    setProviders((list) => list.map((p) =>
      p.id !== pid ? p
        : { ...p, points: p.points.map((h, i) => (i === index ? { ...h, enabled: !h.enabled } : h)) }));

  const setAll = (pid: string, enabled: boolean) =>
    setProviders((list) => list.map((p) =>
      p.id !== pid ? p : { ...p, points: p.points.map((h) => ({ ...h, enabled })) }));

  return (
    <>
      <Kpis items={[
        { label: "Providers", value: String(sums.providers), sub: `${sums.points} hook points` },
        { label: "Active points", value: String(sums.enabled), sub: `${sums.points - sums.enabled} switched off` },
        { label: "Injected per session", value: fmt(sums.tokens), tone: "warn", sub: "before you type anything" },
        { label: "Reclaimable", value: fmt(sums.reclaimable), tone: "crit", sub: "costs tokens, never intercepts" },
        { label: "Vendor content", value: fmt(sums.vendorTokens), tone: sums.vendorTokens ? "warn" : "ok",
          sub: "recommends a specific product" },
        { label: "Not trusted", value: String(sums.untrusted), tone: sums.untrusted ? "crit" : "ok",
          sub: "will not run until reviewed" },
      ]} />

      <div className="hk">
        {providers.map((p) => {
          const cost = providerTokens(p);
          const dead = p.points.filter(isDeadWeight);
          const allOff = p.points.every((h) => !h.enabled);
          const locked = p.trust === "managed";
          return (
            <div className="hk-card" key={p.id} data-off={allOff || undefined}>
              <div className="hk-top">
                <div>
                  <div className="hk-name">
                    <b>{p.name}</b>
                    <span className="hk-ver">v{p.version}</span>
                    <span className="hk-trust" data-t={p.trust}>
                      <svg viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
                        <path d={TRUST_ICON[p.trust]} />
                      </svg>
                      {TRUST_TEXT[p.trust]}
                    </span>
                  </div>
                  <p className="hk-desc">{p.description}</p>
                  <div className="hk-meta">
                    <span>{p.publisher}</span>
                    {p.repo
                      ? <a href={`https://${p.repo}`} target="_blank" rel="noreferrer">{p.repo}</a>
                      : <span className="none">no repository published</span>}
                    <span>installed {p.installedAt}</span>
                    <span>{p.path}</span>
                  </div>
                </div>
                <div className="hk-right">
                  <div className="hk-cost">
                    <b data-hot={cost >= 1000 || undefined}>{cost ? fmt(cost) : "0"}</b>
                    <span>tok / session</span>
                  </div>
                  <div className="hk-act">
                    {!locked && (allOff
                      ? <button className="hk-btn" onClick={() => setAll(p.id, true)}>Enable all</button>
                      : <button className="hk-btn warn" onClick={() => setAll(p.id, false)}>Disable all</button>)}
                  </div>
                </div>
              </div>

              {dead.length > 0 && (
                <div className="hk-tip">
                  <Icon d={ICON.findings} />
                  <span>
                    <b>{dead.length === 1 ? "One hook point" : `${dead.length} hook points`}</b> here cost{" "}
                    <b>{fmt(dead.reduce((n, h) => n + h.tokens, 0))} tokens</b> per session, fired{" "}
                    {dead.reduce((n, h) => n + h.fires, 0)} times, and never blocked or changed a call.
                  </span>
                </div>
              )}

              <div className="hk-points">
                <div className="hk-row hk-head">
                  <div>Hook point</div><div>Injects</div>
                  <div style={{ textAlign: "right" }}>Tokens</div>
                  <div style={{ textAlign: "right" }}>Fires</div>
                  <div />
                </div>
                {p.points.map((h, i) => (
                  <Point key={`${h.event}-${i}`} point={h} locked={locked}
                         onToggle={() => toggle(p.id, i)} />
                ))}
              </div>
            </div>
          );
        })}
        {!providers.length && (
          <Card title="Hooks" icon={ICON.injectors}>
            <div className="body"><Empty>Nothing registers a hook in this harness.</Empty></div>
          </Card>
        )}
      </div>
    </>
  );
}
