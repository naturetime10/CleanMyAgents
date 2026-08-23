import { useEffect, useState } from "react";
import { useSnapshot } from "./api";
import { Icon } from "./components";
import { Analytics, Efficiency, Findings, Mcp, VIEWS, type ViewId } from "./views";
import Hooks from "./hooks/Hooks";
import Trajectory from "./trajectory/Trajectory";
import "./theme.css";

const readHash = (): ViewId => {
  const h = location.hash.slice(1) as ViewId;
  return VIEWS.some((v) => v.id === h) ? h : "overview";
};

export default function App() {
  const { snapshot, error, reload } = useSnapshot();
  const [tab, setTab] = useState<ViewId>(readHash);
  const [sel, setSel] = useState<string | null>(null);

  useEffect(() => {
    const onHash = () => { setTab(readHash()); setSel(null); };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  const go = (next: string, selection: string) => {
    setSel(selection);
    setTab(next as ViewId);
    location.hash = next;
  };

  return (
    <>
      <div className="topbar">
        <div className="mark">c</div>
        <div className="org">CleanMyAgent</div>
        <div className="badge">local</div>
        <div className="spacer" />
        {error && <div className="stale">backend unreachable — {error}</div>}
      </div>

      <nav>
        {VIEWS.map((v) => (
          <button key={v.id} className={v.id === tab ? "on" : ""}
                  onClick={() => { setTab(v.id); setSel(null); location.hash = v.id; }}>
            <Icon d={v.icon} />{v.label}
          </button>
        ))}
        {tab === "sessions" && (
          <button className="nav-action" type="button">
            <Icon d="M12 3v11m0 0l-4-4m4 4l4-4M4 17v3h16v-3" />Session log
          </button>
        )}
      </nav>

      <div className={tab === "sessions" ? "page page-bleed" : "page"}>
        {tab === "sessions" ? <Trajectory /> : !snapshot ? (
          <div className="loading">{error ? "Waiting for the backend…" : "Loading…"}</div>
        ) : tab === "injectors" ? <Hooks />
          : tab === "mcp" ? <Mcp s={snapshot} sel={sel} setSel={setSel} reload={reload} />
          : tab === "efficiency" ? <Efficiency s={snapshot} />
          : tab === "findings" ? <Findings s={snapshot} go={go} />
          : <Analytics s={snapshot} go={go} />}
      </div>
    </>
  );
}
