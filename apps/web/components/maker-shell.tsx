"use client";

import { AlertTriangle, LogOut } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { Pill } from "./ui/primitives";
import { SpreadMark, type SpreadMarkState } from "./spread-mark";

export const makerViews = [
  { id: "desk", label: "Desk" },
  { id: "strategy", label: "Strategy" },
  { id: "markets", label: "Markets" },
  { id: "performance", label: "Performance" },
  { id: "venues", label: "Venues" },
] as const;

export type MakerView = (typeof makerViews)[number]["id"];

function viewFromHash(hash: string): MakerView {
  const candidate = hash.replace(/^#/, "");
  return makerViews.some((view) => view.id === candidate)
    ? (candidate as MakerView)
    : "desk";
}

export function useMakerView() {
  const [activeView, setActiveView] = useState<MakerView>("desk");

  useEffect(() => {
    const syncHash = () => setActiveView(viewFromHash(window.location.hash));
    syncHash();
    window.addEventListener("hashchange", syncHash);
    window.addEventListener("popstate", syncHash);
    return () => {
      window.removeEventListener("hashchange", syncHash);
      window.removeEventListener("popstate", syncHash);
    };
  }, []);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [activeView]);

  const selectView = useCallback((view: MakerView) => {
    if (window.location.hash !== `#${view}`) {
      window.history.pushState(null, "", `#${view}`);
    }
    setActiveView(view);
  }, []);

  return { activeView, selectView };
}

type MakerShellProps = {
  activeView: MakerView;
  selectView: (view: MakerView) => void;
  markState: SpreadMarkState;
  mode: "observe" | "paper" | "live";
  running: boolean;
  live: boolean;
  accountLabel: string;
  notice: string | null;
  onDismissNotice: () => void;
  onLogout: () => void;
  children: ReactNode;
};

export function MakerShell({
  activeView,
  selectView,
  markState,
  mode,
  running,
  live,
  accountLabel,
  notice,
  onDismissNotice,
  onLogout,
  children,
}: MakerShellProps) {
  const displayedMode = running ? mode : "stopped";
  const modeTone =
    displayedMode === "live"
      ? "live"
      : displayedMode === "paper"
        ? "paper"
        : "neutral";
  const activeLabel =
    makerViews.find((view) => view.id === activeView)?.label ?? "Desk";

  return (
    <main className="shell">
      {live && <div className="live-rail" aria-hidden="true" />}
      <header className="maker-nav">
        <div className="maker-phone-heading">
          <span className="maker-phone-title">
            <SpreadMark
              state={markState}
              size={30}
              label={`Maker is ${displayedMode}`}
            />
            <strong>{activeLabel}</strong>
          </span>
          <Pill tone={modeTone} dot={running}>
            {displayedMode[0]?.toUpperCase()}
            {displayedMode.slice(1)}
          </Pill>
        </div>
        <a
          className="maker-nav-brand"
          href="#desk"
          onClick={(event) => {
            event.preventDefault();
            selectView("desk");
          }}
        >
          <SpreadMark state={markState} label={`Maker is ${displayedMode}`} />
          <strong>Maker</strong>
        </a>

        <nav className="maker-view-tabs" aria-label="Maker views">
          {makerViews.map((view) => (
            <a
              key={view.id}
              href={`#${view.id}`}
              className={activeView === view.id ? "is-active" : undefined}
              aria-current={activeView === view.id ? "page" : undefined}
              onClick={(event) => {
                event.preventDefault();
                selectView(view.id);
              }}
            >
              {view.label}
            </a>
          ))}
        </nav>

        <div className="maker-nav-right">
          <Pill tone={modeTone} dot={running}>
            {displayedMode[0]?.toUpperCase()}
            {displayedMode.slice(1)}
          </Pill>
          <span className="maker-account-label">{accountLabel}</span>
          <button
            className="ui-button ui-button-quiet ui-button-icon maker-logout"
            onClick={onLogout}
            title="Sign out"
            aria-label="Sign out"
            type="button"
          >
            <LogOut size={16} aria-hidden="true" />
          </button>
        </div>
      </header>

      {notice && (
        <div className="notice" role="status">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>{notice}</span>
          <button onClick={onDismissNotice} aria-label="Dismiss notice">
            ×
          </button>
        </div>
      )}

      <div className="maker-view-content">{children}</div>
    </main>
  );
}
