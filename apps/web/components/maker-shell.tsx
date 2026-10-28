"use client";

import {
  AlertTriangle,
  ChevronDown,
  CircleCheck,
  CircleX,
  Copy,
  LogOut,
  WalletCards,
} from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { Pill } from "./ui/primitives";
import { MakerWordmark } from "./maker-mark";
import { SpreadMark, type SpreadMarkState } from "./spread-mark";

export const makerViews = [
  { id: "desk", label: "Desk" },
  { id: "strategy", label: "Strategy" },
  { id: "markets", label: "Markets" },
  { id: "performance", label: "Performance" },
  { id: "accounts", label: "Accounts" },
  { id: "venues", label: "Venues" },
] as const;

export type MakerView = (typeof makerViews)[number]["id"];
export type MakerNoticeTone = "success" | "warning" | "error";

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
  walletAddress: string;
  walletLabel: string;
  accountLabel: string;
  operator: boolean;
  notice: string | null;
  noticeTone: MakerNoticeTone;
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
  walletAddress,
  walletLabel,
  accountLabel,
  operator,
  notice,
  noticeTone,
  onDismissNotice,
  onLogout,
  children,
}: MakerShellProps) {
  const [addressCopied, setAddressCopied] = useState(false);

  useEffect(() => {
    let icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!icon) {
      icon = document.createElement("link");
      icon.rel = "icon";
      document.head.append(icon);
    }
    icon.type = "image/svg+xml";
    icon.href = `/icon-${markState}.svg`;
  }, [markState]);

  const displayedMode = running ? mode : "stopped";
  const modeTone =
    displayedMode === "live"
      ? "live"
      : displayedMode === "paper"
        ? "paper"
        : "neutral";
  const activeLabel =
    makerViews.find((view) => view.id === activeView)?.label ?? "Desk";
  const NoticeIcon =
    noticeTone === "success"
      ? CircleCheck
      : noticeTone === "warning"
        ? AlertTriangle
        : CircleX;

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
          <MakerWordmark state={markState} />
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
          <details className="maker-wallet-menu">
            <summary aria-label={`Wallet ${walletLabel}`}>
              <WalletCards size={15} aria-hidden="true" />
              <span>{walletLabel}</span>
              <ChevronDown size={14} aria-hidden="true" />
            </summary>
            <div className="maker-wallet-popover">
              <div className="maker-wallet-heading">
                <span>Connected wallet</span>
                <strong>{walletLabel}</strong>
                <small>{walletAddress}</small>
              </div>
              <dl className="maker-wallet-facts">
                <div>
                  <dt>Access</dt>
                  <dd>{operator ? "Operator" : "Whitelisted"}</dd>
                </div>
                <div>
                  <dt>Trading account</dt>
                  <dd>{accountLabel}</dd>
                </div>
              </dl>
              <div className="maker-wallet-actions">
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(walletAddress)
                      .then(() => {
                        setAddressCopied(true);
                        window.setTimeout(() => setAddressCopied(false), 1_500);
                      });
                  }}
                >
                  <Copy size={15} aria-hidden="true" />
                  {addressCopied ? "Copied" : "Copy address"}
                </button>
                <button type="button" onClick={() => selectView("accounts")}>
                  <WalletCards size={15} aria-hidden="true" />
                  Manage accounts
                </button>
                <button type="button" onClick={onLogout}>
                  <LogOut size={15} aria-hidden="true" />
                  Disconnect
                </button>
              </div>
            </div>
          </details>
        </div>
      </header>

      {notice && (
        <div
          className={`notice notice-${noticeTone}`}
          role={noticeTone === "error" ? "alert" : "status"}
        >
          <NoticeIcon size={16} aria-hidden="true" />
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
