"use client";

import {
  AlertTriangle,
  ChevronDown,
  CircleCheck,
  CircleHelp,
  CircleX,
  CircleStop,
  Copy,
  LogOut,
  WalletCards,
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
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
  { id: "bundles", label: "Bundles" },
  { id: "performance", label: "Performance" },
  { id: "accounts", label: "Accounts" },
  { id: "venues", label: "Venues" },
  { id: "learn", label: "Learn" },
] as const;

export type MakerView = (typeof makerViews)[number]["id"];
export type MakerNoticeTone = "success" | "warning" | "error";

const ExplainContext = createContext<{
  open: boolean;
  toggle: () => void;
} | null>(null);

export function useMakerExplain() {
  const context = useContext(ExplainContext);
  if (!context)
    throw new Error("useMakerExplain must be used inside MakerShell");
  return context;
}

function viewFromHash(hash: string): MakerView {
  const candidate = hash.replace(/^#/, "").split("/")[0];
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
    const update = () => {
      if (window.location.hash !== `#${view}`) {
        window.history.pushState(null, "", `#${view}`);
      }
      setActiveView(view);
    };
    const transitions = document as Document & {
      startViewTransition?: (callback: () => void) => unknown;
    };
    if (
      transitions.startViewTransition &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      transitions.startViewTransition(update);
      return;
    }
    update();
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
      selector: ".performance-v3-stats",
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
      selector: ".venue-card-heading",
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

type CoachPosition = {
  note: CoachNote;
  x: number;
  y: number;
  markerX: number;
  markerY: number;
  docked: boolean;
};

const coachRectOverlaps = (
  first: { left: number; top: number; right: number; bottom: number },
  second: { left: number; top: number; right: number; bottom: number },
) =>
  first.left < second.right &&
  first.right > second.left &&
  first.top < second.bottom &&
  first.bottom > second.top;

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
  const [positions, setPositions] = useState<CoachPosition[]>([]);
  const [phoneIndex, setPhoneIndex] = useState(0);

  useEffect(() => {
    if (!open) return;
    const highlighted: HTMLElement[] = [];
    const update = () => {
      highlighted
        .splice(0)
        .forEach((target) => target.classList.remove("maker-coach-target"));
      const root = document.querySelector<HTMLElement>(
        '.maker-view[data-view="' + activeView + '"]:not([hidden])',
      );
      const targets = (coachNotes[activeView] ?? []).flatMap((note) => {
        const target = root?.querySelector<HTMLElement>(note.selector);
        if (!target) return [];
        return [{ note, target, rect: target.getBoundingClientRect() }];
      });
      if (window.innerWidth < 620) {
        setPositions(
          targets.map(({ note, rect }) => ({
            note,
            x: 0,
            y: 0,
            markerX: rect.left + rect.width / 2,
            markerY: rect.top + rect.height / 2,
            docked: false,
          })),
        );
        const current = targets[Math.min(phoneIndex, targets.length - 1)];
        if (current) {
          current.target.classList.add("maker-coach-target");
          highlighted.push(current.target);
          current.target.scrollIntoView({ block: "center", behavior: "auto" });
        }
        return;
      }

      targets.forEach(({ target }) => {
        target.classList.add("maker-coach-target");
        highlighted.push(target);
      });
      const margin = 8;
      const gap = 12;
      const width = 260;
      const height = 136;
      const occupied = targets.map(({ rect }) => rect);
      const next: CoachPosition[] = [];
      for (const { note, rect } of targets) {
        const candidates = [
          { x: rect.right + gap, y: rect.top },
          { x: rect.left - width - gap, y: rect.top },
          { x: rect.left, y: rect.bottom + gap },
          { x: rect.left, y: rect.top - height - gap },
        ];
        const candidate = candidates.find(({ x, y }) => {
          const noteRect = {
            left: x,
            top: y,
            right: x + width,
            bottom: y + height,
          };
          return (
            noteRect.left >= margin &&
            noteRect.top >= margin &&
            noteRect.right <= window.innerWidth - margin &&
            noteRect.bottom <= window.innerHeight - margin &&
            !occupied.some((targetRect) =>
              coachRectOverlaps(noteRect, targetRect),
            ) &&
            !next.some((placed) =>
              coachRectOverlaps(noteRect, {
                left: placed.x,
                top: placed.y,
                right: placed.x + width,
                bottom: placed.y + height,
              }),
            )
          );
        });
        if (candidate) {
          next.push({
            note,
            x: candidate.x,
            y: candidate.y,
            markerX: rect.left + rect.width / 2,
            markerY: rect.top + rect.height / 2,
            docked: false,
          });
        } else {
          next.push({
            note,
            x: 0,
            y: 0,
            markerX: rect.left + rect.width / 2,
            markerY: rect.top + rect.height / 2,
            docked: true,
          });
        }
      }
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
      highlighted.forEach((target) =>
        target.classList.remove("maker-coach-target"),
      );
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("keydown", keydown);
    };
  }, [activeView, onClose, open, phoneIndex]);

  useEffect(() => {
    if (phoneIndex < positions.length) return;
    setPhoneIndex(0);
  }, [phoneIndex, positions.length]);

  if (!open || positions.length === 0) return null;
  const phone = window.innerWidth < 620;
  const current = positions[phoneIndex] ?? positions[0];
  const docked = positions.filter((position) => position.docked);

  return (
    <aside
      ref={dialog}
      className={phone ? "maker-coach maker-coach-phone" : "maker-coach"}
      aria-label="Explain this view"
      tabIndex={-1}
    >
      {phone && current ? (
        <article className="maker-coach-note" key={current.note.title}>
          <span>{phoneIndex + 1}</span>
          <div>
            <strong>{current.note.title}</strong>
            <p>{current.note.body}</p>
          </div>
          <footer>
            <span>
              {phoneIndex + 1} of {positions.length}
            </span>
            <div>
              <button
                type="button"
                onClick={() => setPhoneIndex((index) => Math.max(0, index - 1))}
                disabled={phoneIndex === 0}
              >
                Back
              </button>
              <button
                type="button"
                onClick={() =>
                  setPhoneIndex((index) =>
                    Math.min(positions.length - 1, index + 1),
                  )
                }
                disabled={phoneIndex === positions.length - 1}
              >
                Next
              </button>
            </div>
          </footer>
        </article>
      ) : (
        <>
          {positions
            .filter((position) => !position.docked)
            .map((position, index) => (
              <article
                className="maker-coach-note"
                key={position.note.title}
                style={{
                  left: position.x,
                  top: position.y,
                  animationDelay: String(index * 40) + "ms",
                }}
              >
                <span>{index + 1}</span>
                <div>
                  <strong>{position.note.title}</strong>
                  <p>{position.note.body}</p>
                </div>
              </article>
            ))}
          {positions.map((position, index) => (
            <span
              className="maker-coach-marker"
              key={"marker-" + position.note.title}
              style={{ left: position.markerX, top: position.markerY }}
            >
              {index + 1}
            </span>
          ))}
          {docked.length > 0 && (
            <section className="maker-coach-dock" aria-label="Notes">
              <strong>Notes</strong>
              {docked.map((position) => (
                <article key={position.note.title}>
                  <span>{positions.indexOf(position) + 1}</span>
                  <div>
                    <b>{position.note.title}</b>
                    <p>{position.note.body}</p>
                  </div>
                </article>
              ))}
            </section>
          )}
        </>
      )}
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
  onStopAll: () => void;
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
  onStopAll,
  children,
}: MakerShellProps) {
  const [addressCopied, setAddressCopied] = useState(false);
  const [explainOpen, setExplainOpen] = useState(false);
  const [tourPrompt, setTourPrompt] = useState(false);
  const toggleExplain = useCallback(() => setExplainOpen((open) => !open), []);
  const activeTab = useRef<HTMLAnchorElement>(null);
  const explainSwitch = useRef<HTMLButtonElement>(null);
  const phoneExplainSwitch = useRef<HTMLButtonElement>(null);
  const closeCoach = useCallback(() => {
    setExplainOpen(false);
    const strategySwitch = document.querySelector<HTMLButtonElement>(
      ".strategy-mobile-explain",
    );
    const target =
      window.matchMedia("(max-width: 619px)").matches &&
      strategySwitch?.getClientRects().length
        ? strategySwitch
        : window.matchMedia("(max-width: 619px)").matches
          ? phoneExplainSwitch.current
          : explainSwitch.current;
    target?.focus();
  }, []);

  useEffect(() => {
    try {
      setTourPrompt(!window.localStorage.getItem("maker:explain-seen"));
    } catch {
      setTourPrompt(true);
    }
  }, []);

  const chooseTour = useCallback((start: boolean) => {
    setTourPrompt(false);
    if (start) setExplainOpen(true);
    try {
      window.localStorage.setItem("maker:explain-seen", "1");
    } catch {
      // The explicit controls remain available without storage.
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
    <ExplainContext.Provider
      value={{ open: explainOpen, toggle: toggleExplain }}
    >
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
            <div className="maker-phone-actions">
              <Pill tone={modeTone} dot={running}>
                {displayedMode[0]?.toUpperCase()}
                {displayedMode.slice(1)}
              </Pill>
              <button
                ref={phoneExplainSwitch}
                className="maker-phone-explain"
                type="button"
                aria-label="Explain"
                title="Explain"
                aria-pressed={explainOpen}
                onClick={toggleExplain}
              >
                <CircleHelp size={19} aria-hidden="true" />
              </button>
            </div>
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
            {running && (
              <button
                className="maker-stop-all"
                type="button"
                onClick={onStopAll}
              >
                <CircleStop size={15} aria-hidden="true" />
                Stop all
              </button>
            )}
            <button
              ref={explainSwitch}
              className="maker-explain-toggle"
              type="button"
              aria-pressed={explainOpen}
              onClick={toggleExplain}
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
                          window.setTimeout(
                            () => setAddressCopied(false),
                            1_500,
                          );
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

        {tourPrompt && (
          <div className="maker-tour-prompt" role="status">
            <span>New here? Take the 30-second tour</span>
            <div>
              <button type="button" onClick={() => chooseTour(true)}>
                Start
              </button>
              <button type="button" onClick={() => chooseTour(false)}>
                Not now
              </button>
            </div>
          </div>
        )}

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
    </ExplainContext.Provider>
  );
}
