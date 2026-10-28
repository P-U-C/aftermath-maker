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
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

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
  { id: "learn", label: "Learn" },
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

type CoachNote = {
  selector: string;
  title: string;
  body: string;
};

const coachNotes: Partial<Record<MakerView, CoachNote[]>> = {
  desk: [
    {
      selector: ".desk-narration",
      title: "Right now",
      body: "This sentence tells you what the desk is doing with the data it has.",
    },
    {
      selector: ".desk-ladder-card",
      title: "Your two quotes",
      body: "Your bid sits below the price and your ask sits above it.",
    },
    {
      selector: ".desk-risk-card",
      title: "Limits",
      body: "These are the guardrails that can pause or stop the run.",
    },
    {
      selector: ".desk-markets-card",
      title: "Markets",
      body: "Each row says whether that selected market is quoting or waiting.",
    },
  ],
  strategy: [
    {
      selector: ".strategy-title",
      title: "Strategy",
      body: "Choose the markets, size, limits, and review the mode before saving.",
    },
    {
      selector: ".execution-model",
      title: "Two accounts",
      body: "The Maker account quotes; the Taker account can reduce inventory.",
    },
    {
      selector: ".strategy-capital-section",
      title: "Size and limits",
      body: "These limits describe the amount of risk the desk may take.",
    },
    {
      selector: ".strategy-save-bar",
      title: "Save changes",
      body: "Changes are sent only when you save this strategy.",
    },
  ],
  markets: [
    {
      selector: ".markets-title",
      title: "Market list",
      body: "Compare the markets that can be included in the strategy.",
    },
    {
      selector: ".markets-table",
      title: "Add markets",
      body: "Use the rows to inspect a market before adding it to the strategy.",
    },
  ],
  performance: [
    {
      selector: ".performance-board",
      title: "Performance",
      body: "Results separate what is measured from what still needs evidence.",
    },
    {
      selector: ".performance-metrics",
      title: "The headline numbers",
      body: "Choose a period to see the current result, volume, fills, and rewards.",
    },
    {
      selector: ".performance-table",
      title: "Fills",
      body: "Each attributed fill keeps the price, size, and realised result.",
    },
  ],
  venues: [
    {
      selector: ".venues-board",
      title: "Venue connection",
      body: "This is the venue Maker uses and the status of your account access.",
    },
    {
      selector: ".fee-panel",
      title: "Fee inspection",
      body: "Operators can inspect the venue fee before configuring the desk.",
    },
  ],
};

function CoachLayer({
  activeView,
  open,
  onClose,
}: {
  activeView: MakerView;
  open: boolean;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLElement>(null);
  const [positions, setPositions] = useState<
    Array<{ note: CoachNote; x: number; y: number }>
  >([]);

  useEffect(() => {
    if (!open) return;
    const update = () => {
      const root = document.querySelector(
        `.maker-view[data-view="${activeView}"]:not([hidden])`,
      );
      const next = (coachNotes[activeView] ?? []).flatMap((note) => {
        const target = root?.querySelector<HTMLElement>(note.selector);
        if (!target) return [];
        const rect = target.getBoundingClientRect();
        const x = Math.max(
          12,
          Math.min(window.innerWidth - 272, rect.left + 18),
        );
        const y = Math.max(
          76,
          Math.min(window.innerHeight - 132, rect.top + 14),
        );
        return [{ note, x, y }];
      });
      setPositions(next);
    };
    update();
    dialog.current?.focus();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", keydown);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("keydown", keydown);
    };
  }, [activeView, onClose, open]);

  if (!open || positions.length === 0) return null;
  return (
    <aside
      ref={dialog}
      className="maker-coach"
      aria-label="Explain this view"
      tabIndex={-1}
    >
      {positions.map(({ note, x, y }, index) => (
        <article
          className="maker-coach-note"
          key={note.title}
          style={{ left: x, top: y }}
        >
          <span>{index + 1}</span>
          <div>
            <strong>{note.title}</strong>
            <p>{note.body}</p>
          </div>
        </article>
      ))}
      <button className="maker-coach-close" type="button" onClick={onClose}>
        Close explain
      </button>
    </aside>
  );
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
  const [explainOpen, setExplainOpen] = useState(false);
  const activeTab = useRef<HTMLAnchorElement>(null);
  const closeCoach = useCallback(() => setExplainOpen(false), []);

  useEffect(() => {
    try {
      if (!window.localStorage.getItem("maker:explain-seen")) {
        setExplainOpen(true);
        window.localStorage.setItem("maker:explain-seen", "1");
      }
    } catch {
      // Explain still works when storage is unavailable.
    }
  }, []);

  useEffect(() => {
    activeTab.current?.scrollIntoView({
      block: "nearest",
      inline: "center",
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  }, [activeView]);

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
          {makerViews
            .filter((view) => view.id !== "learn" && view.id !== "accounts")
            .map((view) => (
              <a
                key={view.id}
                href={`#${view.id}`}
                ref={activeView === view.id ? activeTab : undefined}
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
          <button
            className="maker-explain-toggle"
            type="button"
            aria-pressed={explainOpen}
            onClick={() => setExplainOpen((open) => !open)}
          >
            Explain
          </button>
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
      <CoachLayer
        activeView={activeView}
        open={explainOpen}
        onClose={closeCoach}
      />
    </main>
  );
}
