import { useState } from "react";
import { apply, hueOf, injectorsOf, kfmt, pct } from "./api";
import { ActionButton, Body, Card, Empty, Foot, ICON, Kpis, LineChart, Rank, Select } from "./components";
import type { OpsSnapshot } from "./types";

const Toolbar = ({ s }: { s: OpsSnapshot }) => (
  <div className="toolbar">
    <Select label={`${s.stats.sessions} sessions`} icon={ICON.filter} />
    <Select label={s.efficiency.daily.length ? `${s.efficiency.daily.length} days` : "All time"} icon={ICON.filter} />
    <button className="btn-dark" onClick={() => {
      const blob = new Blob([JSON.stringify(s, null, 2)], { type: "application/json" });
      const a = Object.assign(document.createElement("a"), {
        href: URL.createObjectURL(blob), download: `cleanmyagent-${s.generatedAt.slice(0, 10)}.json`,
      });
      a.click();
      URL.revokeObjectURL(a.href);
    }}>
      <svg viewBox="0 0 24 24"><path d={ICON.export} /></svg>Export
    </button>
  </div>
);

export function Analytics({ s, go }: { s: OpsSnapshot; go: (tab: string, sel: string) => void }) {
  const crit = s.audit.findings.filter((f) => f.severity === "critical").length;
  const daily = s.efficiency.daily ?? [];
  const rows = s.budget.perServer.filter((r) => r.tokens > 0);
  const inj = injectorsOf(s).filter((i) => i.payload);
  const busiest = [...daily].sort((a, b) => b.calls - a.calls).slice(0, 3);
  const worst = [...s.efficiency.byTool].filter((t) => t.failed).sort((a, b) => b.failed - a.failed).slice(0, 3);

  return (
    <>
      <Toolbar s={s} />
      <Kpis items={[
        { label: "Tool calls", value: kfmt(s.efficiency.toolCalls), sub: `${s.efficiency.sessions} sessions scanned` },
        { label: "Failure rate", value: pct(s.efficiency.failureRate),
          tone: s.efficiency.failureRate > 0.1 ? "crit" : "warn", sub: `${s.efficiency.failed} calls hit an error` },
        { label: "Wasted context", value: kfmt(s.budget.wastedTokens), tone: "crit", sub: "per request, unused MCP tools" },
        { label: "Injected context", value: kfmt((s.injections?.totalTokens ?? 0) / Math.max(1, s.injections?.sessions ?? 1)),
          sub: "per session, before you type" },
        { label: "Critical findings", value: String(crit), tone: crit ? "crit" : "ok", sub: `${s.audit.hookCount} hooks audited` },
      ]} />

      <div className="cards">
        <Card title="Tool calls over time" icon={ICON.analytics} right={<Select label="Calls" />}>
          <Body>{daily.length > 1
            ? <LineChart points={daily} yLabel="Tool calls" valueOf={(d) => d.calls} color="#2a78d6" />
            : <Empty>Not enough history yet</Empty>}</Body>
          <Foot title="Busiest days">
            {busiest.length ? busiest.map((d) => (
              <Rank key={d.date} name={d.date} value={d.calls} max={busiest[0].calls} color="#2a78d6" text={`${d.calls} calls`} />
            )) : <Empty>No data available</Empty>}
          </Foot>
        </Card>

        <Card title="Failed calls" icon={ICON.findings} right={<Select label="Failures" />}>
          <Body>{daily.length > 1
            ? <LineChart points={daily} yLabel="Failed calls" valueOf={(d) => d.failed} color="#e34948" />
            : <Empty>Not enough history yet</Empty>}</Body>
          <Foot title="Tools by failure count">
            {worst.length ? worst.map((t) => (
              <Rank key={t.tool} name={t.tool} value={t.failed} max={worst[0].failed} color="#e34948"
                    text={`${t.failed}/${t.calls}`} danger={t.failed / t.calls > 0.2}
                    title={`${pct(t.failed / t.calls)} of calls failed`} />
            )) : <Empty>No failures recorded</Empty>}
          </Foot>
        </Card>

        <Card title="Context budget" icon={ICON.mcp} right={<Select label={`${kfmt(s.budget.totalTokens)} tok`} />}>
          <Body>{rows.length ? rows.map((r) => (
            <Rank key={r.server} name={r.server} value={r.tokens} max={Math.max(...rows.map((x) => x.tokens))}
                  color={r.calls === 0 ? "#c9c9c4" : hueOf(r.server)} text={kfmt(r.tokens)} danger={r.calls === 0}
                  title={`${r.calls} calls`} onClick={() => go("mcp", r.server)} />
          )) : <Empty>No MCP servers configured</Empty>}</Body>
          <Foot><div className="muted">{s.budget.wastedTokens
            ? `Grey bars were never called across ${s.stats.sessions} sessions — ${kfmt(s.budget.wastedTokens)} tokens wasted on every request.`
            : "Every configured server is in use."}</div></Foot>
        </Card>

        <Card title="Context injectors" icon={ICON.injectors} right={<Select label="Per session" />}>
          <Body>{inj.length ? inj.map((i) => (
            <Rank key={i.id} name={i.id} value={i.payload!.perSession}
                  max={Math.max(...inj.map((x) => x.payload!.perSession))}
                  color={i.findings ? "#eda100" : hueOf(i.id)} text={`${kfmt(i.payload!.perSession)} tok`}
                  title={i.payload!.label} onClick={() => go("injectors", i.id)} />
          )) : <Empty>No injections measured</Empty>}</Body>
          <Foot><div className="muted">Measured from developer blocks in scanned sessions.</div></Foot>
        </Card>

        <Card title="Repeated commands" icon={ICON.efficiency} right={<Select label="All time" />} full>
          <Body>{s.efficiency.repeats.length ? (
            <table>
              <thead><tr><th>Command</th><th className="r">Runs</th><th className="r">Redundant</th></tr></thead>
              <tbody>{s.efficiency.repeats.slice(0, 8).map((r) => (
                <tr key={r.command}>
                  <td className="mono">{r.command.replace(/\s+/g, " ").slice(0, 96)}</td>
                  <td className="num">{r.count}</td>
                  <td className="num"><u>+{r.count - 1}</u></td>
                </tr>
              ))}</tbody>
            </table>
          ) : <Empty>No command ran twice</Empty>}</Body>
        </Card>
      </div>
    </>
  );
}

export function Injectors({ s, sel, setSel }: { s: OpsSnapshot; sel: string | null; setSel: (v: string) => void }) {
  const groups = injectorsOf(s);
  const g = groups.find((x) => x.id === sel) ?? groups[0];
  return (
    <>
      <Toolbar s={s} />
      <div className="withside">
        <div className="side">
          <h5>Injectors</h5>
          {groups.map((x) => (
            <button key={x.id} className={x.id === g?.id ? "on" : ""} onClick={() => setSel(x.id)}>
              {x.id}<span>{x.payload ? kfmt(x.payload.perSession) : x.hooks.length}</span>
            </button>
          ))}
        </div>
        {!g ? (
          <Card title="Injectors" icon={ICON.injectors}><Body><Empty>No hooks configured</Empty></Body></Card>
        ) : (
          <Card title={g.id} icon={ICON.injectors} plain
                right={g.findings ? <span className="pill crit">{g.findings} findings</span> : undefined}>
            <Body>
              <dl className="kv">
                <dt>Source</dt><dd>{g.hooks[0]?.sourcePath ?? "measured from session history"}</dd>
                <dt>Hooks</dt><dd>{g.hooks.length || "none"}</dd>
                {g.hooks.length > 0 && (<><dt>Events</dt>
                  <dd>{[...new Set(g.hooks.map((h) => h.eventName))].join(", ")}</dd></>)}
                <dt>Injects</dt><dd>{g.payload ? g.payload.label : "nothing measured"}</dd>
                {g.payload && (<>
                  <dt>Per session</dt><dd>{kfmt(g.payload.perSession)} tokens</dd>
                  <dt>Largest block</dt><dd>{kfmt(g.payload.maxTokens)} tokens</dd>
                  <dt>Observed</dt><dd>{g.payload.blocks} blocks across {s.injections.sessions} sessions</dd>
                  <dt>Share of injected</dt><dd>{pct(g.payload.tokens / Math.max(1, s.injections.totalTokens))}</dd>
                </>)}
              </dl>

              <div className="sect">Injected content</div>
              {g.payload?.sample
                ? <pre>{g.payload.sample}{g.payload.sample.length >= 240 ? " …" : ""}</pre>
                : <Empty>No developer block in the scanned sessions carries this plugin's signature.</Empty>}

              {g.hooks.length > 0 && (<>
                <div className="sect">Hooks</div>
                <table>
                  <thead><tr><th>Event</th><th>Matcher</th><th>Trust</th><th>Command</th></tr></thead>
                  <tbody>{g.hooks.map((h) => {
                    const flags = s.audit.findings.filter((f) => f.hookKey === h.key);
                    const tone = flags.some((f) => f.severity === "critical") ? "crit"
                      : flags.length ? "warn" : h.trustStatus === "trusted" ? "ok" : "";
                    return (
                      <tr key={h.key}>
                        <td>{h.eventName}</td>
                        <td className="muted">{h.matcher ?? "all"}</td>
                        <td><span className={"pill " + tone}>{h.trustStatus}</span></td>
                        <td className="mono">{(h.command ?? []).join(" ").slice(0, 90)}</td>
                      </tr>
                    );
                  })}</tbody>
                </table>
              </>)}
            </Body>
          </Card>
        )}
      </div>
    </>
  );
}

export function Mcp({ s, sel, setSel, reload }: {
  s: OpsSnapshot; sel: string | null; setSel: (v: string) => void; reload: () => void;
}) {
  const r = s.budget.perServer.find((x) => x.server === sel) ?? s.budget.perServer[0];
  const srv = s.servers.find((x) => x.id === r?.server);
  return (
    <>
      <Toolbar s={s} />
      <Kpis items={[
        { label: "Servers", value: String(s.budget.perServer.length) },
        { label: "Tools exposed", value: String(s.budget.totalTools) },
        { label: "Context cost", value: kfmt(s.budget.totalTokens), sub: "tokens per request" },
        { label: "Wasted", value: kfmt(s.budget.wastedTokens), tone: "crit", sub: "never-called servers" },
      ]} />
      <div className="withside">
        <div className="side">
          <h5>Servers</h5>
          {s.budget.perServer.map((x) => (
            <button key={x.server} className={x.server === r?.server ? "on" : ""} onClick={() => setSel(x.server)}>
              {x.server}<span>{kfmt(x.tokens)}</span>
            </button>
          ))}
        </div>
        {!r ? (
          <Card title="Servers" icon={ICON.mcp}><Body><Empty>No MCP servers configured</Empty></Body></Card>
        ) : (
          <Card title={r.server} icon={ICON.mcp} plain
                right={<span className={"pill " + (!r.enabled ? "" : r.calls === 0 ? "warn" : "ok")}>
                  {!r.enabled ? "disabled" : r.calls === 0 ? "unused" : "active"}</span>}>
            <Body>
              <dl className="kv">
                <dt>Command</dt><dd>{srv?.command ?? srv?.url ?? "—"}</dd>
                <dt>Runtime status</dt><dd>{r.runtimeStatus}</dd>
                <dt>Tools</dt><dd>{r.tools}</dd>
                <dt>Context cost</dt><dd>{kfmt(r.tokens)} tokens per request</dd>
                <dt>Calls observed</dt><dd>{r.calls}</dd>
                <dt>Per session</dt><dd>{(r.calls / Math.max(1, s.stats.sessions)).toFixed(1)}</dd>
                <dt>Share of all calls</dt><dd>{pct(r.calls / Math.max(1, s.stats.toolCalls))}</dd>
                <dt>Last used</dt><dd>{r.lastUsed?.slice(0, 10) ?? "never"}</dd>
              </dl>

              {r.enabled && r.calls === 0 && r.tokens > 0 && (<>
                <div className="sect">Recommendation</div>
                <div className="muted">
                  Never called across {s.stats.sessions} sessions. Disabling frees {kfmt(r.tokens)} tokens on every request.
                </div>
                <div className="actions">
                  <ActionButton label="Disable server" done="Disabled" tone="danger"
                    onRun={async () => { const ok = await apply({ kind: "disable-mcp", server: r.server }); if (ok) reload(); return ok; }} />
                </div>
              </>)}
              {!r.enabled && (
                <div className="actions">
                  <ActionButton label="Enable server" done="Enabled" tone="primary"
                    onRun={async () => { const ok = await apply({ kind: "enable-mcp", server: r.server }); if (ok) reload(); return ok; }} />
                </div>
              )}

              {srv?.toolNames?.length ? (<>
                <div className="sect">Tools ({srv.toolNames.length})</div>
                <pre>{srv.toolNames.slice(0, 14).join("\n")}
                  {srv.toolNames.length > 14 ? `\n… ${srv.toolNames.length - 14} more` : ""}</pre>
              </>) : null}
            </Body>
          </Card>
        )}
      </div>
    </>
  );
}

export function Efficiency({ s }: { s: OpsSnapshot }) {
  const e = s.efficiency;
  return (
    <>
      <Toolbar s={s} />
      <Kpis items={[
        { label: "Tool calls", value: kfmt(e.toolCalls), sub: `across ${e.sessions} sessions` },
        { label: "Failed", value: String(e.failed), tone: e.failureRate > 0.1 ? "crit" : "warn", sub: `${pct(e.failureRate)} of all calls` },
        { label: "Redundant", value: String(e.repeatedCalls), tone: e.repeatedCalls > 20 ? "crit" : "warn", sub: "re-ran a known command" },
        { label: "Peak context", value: kfmt(e.peakTokens), sub: "highest single session" },
      ]} />
      <div className="cards">
        <Card title="Tool usage" icon={ICON.efficiency} right={<Select label="Calls" />} full>
          <Body>{e.byTool.length ? e.byTool.map((t) => (
            <Rank key={t.tool} name={t.tool} value={t.calls - t.failed} max={Math.max(...e.byTool.map((x) => x.calls))}
                  color={hueOf(t.tool)} sub={t.failed} danger={t.failed / t.calls > 0.2}
                  text={t.failed ? `${t.calls} / ${t.failed}✗` : String(t.calls)}
                  title={`${t.calls} calls, ${t.failed} failed`} />
          )) : <Empty>No tool calls recorded</Empty>}</Body>
          <Foot><div className="muted">Red segment marks calls whose output carried an error signal.</div></Foot>
        </Card>
        <Card title="Repeated commands" icon={ICON.analytics} right={<Select label="Top 12" />} full>
          <Body>{e.repeats.length ? e.repeats.slice(0, 12).map((r) => (
            <Rank key={r.command} name={r.command.replace(/\s+/g, " ").slice(0, 52)} value={r.count}
                  max={Math.max(...e.repeats.map((x) => x.count))} color="#eda100" text={`${r.count}×`}
                  title={r.command.replace(/\s+/g, " ").slice(0, 240)} />
          )) : <Empty>No command ran twice</Empty>}</Body>
        </Card>
      </div>
    </>
  );
}

export function Findings({ s, go }: { s: OpsSnapshot; go: (tab: string, sel: string) => void }) {
  const crit = s.audit.findings.filter((f) => f.severity === "critical").length;
  return (
    <>
      <Toolbar s={s} />
      <Kpis items={[
        { label: "Hooks audited", value: String(s.audit.hookCount) },
        { label: "Critical", value: String(crit), tone: crit ? "crit" : "ok" },
        { label: "Warnings", value: String(s.audit.findings.length - crit), tone: "warn" },
        { label: "Injectors", value: String(injectorsOf(s).filter((i) => i.hooks.length).length) },
      ]} />
      <Card title="Findings" icon={ICON.findings} right={<Select label="All severity" />} full>
        <Body>{s.audit.findings.length ? (
          <table>
            <thead><tr><th>Severity</th><th>Rule</th><th>Injected by</th><th>Event</th><th>Evidence</th></tr></thead>
            <tbody>{s.audit.findings.map((f) => {
              const h = s.hooks.find((x) => x.key === f.hookKey);
              return (
                <tr key={f.hookKey + f.rule} className="clickable"
                    onClick={() => go("injectors", h?.pluginId ?? h?.source ?? "")}>
                  <td><span className={"pill " + (f.severity === "critical" ? "crit" : "warn")}>{f.severity}</span></td>
                  <td>{f.rule}</td>
                  <td>{h?.pluginId ?? h?.source ?? "—"}</td>
                  <td className="muted">{h?.eventName ?? "—"}</td>
                  <td className="mono">{f.evidence.slice(0, 70)}</td>
                </tr>
              );
            })}</tbody>
          </table>
        ) : <Empty>No findings — every hook passed the audit.</Empty>}</Body>
      </Card>
    </>
  );
}

/** Route table used by App; keeps tab metadata in one place. */
export const VIEWS = [
  { id: "scan", label: "Scan", icon: ICON.scan },
  { id: "overview", label: "Analytics", icon: ICON.analytics },
  { id: "injectors", label: "Hooks", icon: ICON.injectors },
  { id: "mcp", label: "MCP", icon: ICON.mcp },
  { id: "efficiency", label: "Efficiency", icon: ICON.efficiency },
  { id: "findings", label: "Findings", icon: ICON.findings },
  { id: "sessions", label: "Trajectory", icon: ICON.sessions },
] as const;

export type ViewId = (typeof VIEWS)[number]["id"];
export const useSelection = () => useState<string | null>(null);
