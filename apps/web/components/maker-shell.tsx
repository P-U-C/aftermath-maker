"use client";

import {
  AlertTriangle,
  ChevronDown,
  CircleCheck,
  CircleHelp,
  CircleX,
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

import type { RunState } from "../lib/run-state";
import { MakerWordmark } from "./maker-mark";
import { RunControl } from "./run-control";
import { SpreadMark } from "./spread-mark";
import { Button } from "./ui/primitives";

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

const RunControlsContext = createContext<{
  open: (bundleId?: string) => void;
} | null>(null);

export function useMakerRunControls() {
  const context = useContext(RunControlsContext);
  if (!context) throw new Error("Run status must be inside MakerShell");
  return context;
}

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

const coachNotes: Record<MakerView, CoachNote[]> = {
  desk: [
    {
      selector: ".desk-hero",
      title: "Wallet total",
      body: "This is the saved strategy's wallet-level result, equity, and exposure.",
    },
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
    {
      selector: ".desk-log-card",
      title: "Control log",
      body: "This records what Maker did, using plain language and real error severity.",
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
      selector: ".strategy-builder",
      title: "Steps",
      body: "Move through goal, markets, limits, hedging, and review in any order.",
    },
    {
      selector: ".rotation-mode-control",
      title: "Rotation",
      body: "Choose whether Maker quotes all saved pairs or one pair at a time.",
    },
    {
      selector: ".strategy-capital-section",
      title: "Size and limits",
      body: "These limits describe the amount of risk the desk may take.",
    },
    {
      selector: ".strategy-hedging",
      title: "Hedging",
      body: "A separate Taker account can reduce inventory after fills.",
    },
    {
      selector: ".strategy-review-step",
      title: "Review",
      body: "Review the saved mode and run a paper test before starting Maker.",
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
      body: "Compare every venue market before selecting it in Strategy.",
    },
    {
      selector: ".rotation-board",
      title: "Rotation and exposure",
      body: "Saved bundle assignments, current state, and exposure stay visible here without changing a draft.",
    },
  ],
  bundles: [
    {
      selector: ".bundles-title",
      title: "Bundles",
      body: "A bundle keeps its own accounts, markets, and start or pause state.",
    },
    {
      selector: ".bundle-wallet-limits",
      title: "Wallet limits",
      body: "These limits apply across every bundle in this wallet.",
    },
    {
      selector: ".bundle-card-grid",
      title: "Bundle controls",
      body: "Select a bundle to edit its strategy, or start and pause that bundle here.",
    },
  ],
  performance: [
    {
      selector: ".rewards-board",
      title: "Reward efficiency",
      body: "Reward estimates are separated from the trading result and its known costs.",
    },
    {
      selector: ".objective-evidence",
      title: "Goal evidence",
      body: "Each goal states what has been measured and what still needs more observation.",
    },
    {
      selector: ".reward-table-wrap",
      title: "Market ranking",
      body: "These are market signals for planning; they do not change a saved strategy.",
    },
    {
      selector: ".performance-board",
      title: "Attributed performance",
      body: "Use wallet, bundle, and period filters to inspect attributed results.",
    },
    {
      selector: ".performance-volume-by-market",
      title: "Market results",
      body: "Expand a market to inspect its attributed fills and known result.",
    },
    {
      selector: ".performance-note",
      title: "Coverage",
      body: "This explains what the performance record includes and what it cannot yet prove.",
    },
  ],
  accounts: [
    {
      selector: ".accounts-title",
      title: "Accounts",
      body: "Create, fund, authorise, and name the accounts Maker can use.",
    },
    {
      selector: ".onboarding",
      title: "Setup",
      body: "Complete owner-wallet and trading-key setup before Maker can run.",
    },
    {
      selector: ".account-desk",
      title: "Trading accounts",
      body: "Assign Maker and Taker roles, then manage collateral and trading keys.",
    },
  ],
  venues: [
    {
      selector: ".venues-title",
      title: "Venue",
      body: "This is the execution venue and its connection state.",
    },
    {
      selector: ".venue-accounts-card",
      title: "Venue accounts",
      body: "Accounts are grouped by their current bundle or available state.",
    },
    {
      selector: ".venue-execution-card",
      title: "Execution boundary",
      body: "Maker can trade through its delegated key but cannot move withdrawals.",
    },
    {
      selector: ".venue-accounts-card .ui-card-header",
      title: "Exposure",
      body: "Venue and portfolio totals show the shared risk envelope.",
    },
    {
      selector: ".fee-panel",
      title: "Fee inspection",
      body: "Inspect the venue fee before configuring the desk.",
    },
  ],
  learn: [
    {
      selector: ".learn-heading",
      title: "Learn",
      body: "Follow the illustration to see how Maker quotes, fills, and manages inventory.",
    },
    {
      selector: ".learn-stage",
      title: "The book",
      body: "The animated book shows Maker's bid and ask around the market price.",
    },
    {
      selector: ".learn-chapters",
      title: "Chapters",
      body: "Choose a chapter to step through the lifecycle one decision at a time.",
    },
    {
      selector: ".learn-glossary",
      title: "Glossary",
      body: "Definitions use the same terms you see throughout the desk.",
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
      highlighted.splice(0).forEach((target) => {
        target.classList.remove("maker-coach-target");
        target.removeAttribute("data-coach-target");
      });
      const root = document.querySelector<HTMLElement>(
        '.maker-view[data-view="' + activeView + '"]:not([hidden])',
      );
      const targets = (coachNotes[activeView] ?? []).flatMap((note) => {
        const target = root?.querySelector<HTMLElement>(note.selector);
        if (!target) return [];
        const rect = target.getBoundingClientRect();
        const style = getComputedStyle(target);
        if (
          rect.width < 2 ||
          rect.height < 2 ||
          style.display === "none" ||
          style.visibility === "hidden"
        ) {
          return [];
        }
        return [{ note, target, rect }];
      });
      if (window.innerWidth < 620) {
        targets.forEach(({ target }) => {
          target.setAttribute("data-coach-target", "true");
          highlighted.push(target);
        });
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
          // A phone note occupies the lower reading area. Keep its section
          // below the sticky header instead of hiding its heading under tabs.
          const navHeight =
            document
              .querySelector<HTMLElement>(
                ".strategy-mobile-sheet-header, .maker-nav",
              )
              ?.getBoundingClientRect().height ?? 0;
          const targetTop =
            current.target.getBoundingClientRect().top + window.scrollY;
          window.scrollTo({
            top: Math.max(0, targetTop - navHeight - 12),
            behavior: "auto",
          });
        }
        return;
      }

      targets.forEach(({ target }) => {
        target.classList.add("maker-coach-target");
        target.setAttribute("data-coach-target", "true");
        highlighted.push(target);
      });
      const margin = 8;
      const gap = 12;
      const width = 260;
      const height = 136;
      // The desk result is the primary reading surface. Explain notes may point
      // at nearby cards, but must never sit over that result.
      const protectedRects =
        activeView === "desk"
          ? [
              root
                ?.querySelector<HTMLElement>(".desk-hero")
                ?.getBoundingClientRect(),
            ].filter((rect): rect is DOMRect => Boolean(rect))
          : [];
      const occupied = [...targets.map(({ rect }) => rect), ...protectedRects];
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
      setPositions(
        next.some((position) => position.docked)
          ? next.map((position) => ({ ...position, docked: true }))
          : next,
      );
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
      highlighted.forEach((target) => {
        target.classList.remove("maker-coach-target");
        target.removeAttribute("data-coach-target");
      });
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
  run: RunState;
  stoppedAt: Record<string, string | undefined>;
  onBundleAction: (
    bundleId: string,
    action: "start" | "pause" | "resume",
  ) => void;
  canOperate: boolean;
  serviceUnavailable: boolean;
  lastGoodDataAt: string | null;
  walletAddress: string;
  walletLabel: string;
  walletSummary: {
    enabledVenues: number;
    runningBundles: number;
    totalBundles: number;
    authorizedAccounts: number;
  };
  operator: boolean;
  controlBuild: { commit: string; builtAt: string } | null;
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
  run,
  stoppedAt,
  onBundleAction,
  canOperate,
  serviceUnavailable,
  lastGoodDataAt,
  walletAddress,
  walletLabel,
  walletSummary,
  operator,
  controlBuild,
  notice,
  noticeTone,
  onDismissNotice,
  onLogout,
  onStopAll,
  children,
}: MakerShellProps) {
  const [addressCopied, setAddressCopied] = useState(false);
  const [runControlsOpen, setRunControlsOpen] = useState(false);
  const [controlBundleId, setControlBundleId] = useState<string | null>(null);
  const openRunControls = (bundleId?: string) => {
    setControlBundleId(bundleId ?? null);
    setRunControlsOpen(true);
  };
  const [explainOpen, setExplainOpen] = useState(false);
  const [tourPrompt, setTourPrompt] = useState(false);
  const toggleExplain = useCallback(() => setExplainOpen((open) => !open), []);
  const activeTab = useRef<HTMLAnchorElement>(null);
  const walletMenu = useRef<HTMLDetailsElement>(null);
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
    walletMenu.current?.removeAttribute("open");
    setRunControlsOpen(false);
    setControlBundleId(null);
  }, [activeView]);

  useEffect(() => {
    const icons = Array.from(
      document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'),
    );
    const targets = icons.length
      ? icons
      : [document.head.appendChild(document.createElement("link"))];
    for (const icon of targets) {
      icon.rel = "icon";
      icon.type = "image/svg+xml";
      icon.href = `/icon-${run.markState}.svg`;
    }
  }, [run.markState]);

  const activeLabel =
    makerViews.find((view) => view.id === activeView)?.label ?? "Desk";
  const NoticeIcon =
    noticeTone === "success"
      ? CircleCheck
      : noticeTone === "warning"
        ? AlertTriangle
        : CircleX;
  const lastGoodDataText = lastGoodDataAt
    ? new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(lastGoodDataAt))
    : "the last update";

  return (
    <ExplainContext.Provider
      value={{ open: explainOpen, toggle: toggleExplain }}
    >
      <RunControlsContext.Provider value={{ open: openRunControls }}>
        <main
          className={
            activeView === "strategy" ? "shell is-strategy-active" : "shell"
          }
        >
          {run.liveRail && <div className="live-rail" aria-hidden="true" />}
          <header className="maker-nav">
            <div className="maker-phone-heading">
              <span className="maker-phone-title">
                <SpreadMark
                  state={run.markState}
                  size={30}
                  label={`Maker is ${run.label}`}
                />
                <strong>{activeLabel}</strong>
              </span>
              <div className="maker-phone-actions">
                <RunControl
                  compact
                  run={run}
                  open={runControlsOpen}
                  selectedBundleId={controlBundleId}
                  stoppedAt={stoppedAt}
                  onOpenChange={setRunControlsOpen}
                  onBundleAction={onBundleAction}
                  onStopAll={onStopAll}
                  onManageBundles={() => selectView("bundles")}
                  onOpenStrategy={() => selectView("strategy")}
                  onOpenVenues={() => selectView("venues")}
                />
                <button
                  ref={phoneExplainSwitch}
                  className="maker-phone-explain"
                  type="button"
                  aria-label="Explain this page"
                  title="Explain this page"
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
              <MakerWordmark state={run.markState} />
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
              <RunControl
                run={run}
                open={runControlsOpen}
                selectedBundleId={controlBundleId}
                stoppedAt={stoppedAt}
                onOpenChange={setRunControlsOpen}
                onBundleAction={onBundleAction}
                onStopAll={onStopAll}
                onManageBundles={() => selectView("bundles")}
                onOpenStrategy={() => selectView("strategy")}
                onOpenVenues={() => selectView("venues")}
              />
              <button
                ref={explainSwitch}
                className="maker-explain-toggle"
                type="button"
                aria-label="Explain this page"
                title="Explain this page"
                aria-pressed={explainOpen}
                onClick={toggleExplain}
              >
                <CircleHelp size={18} aria-hidden="true" />
              </button>
              <details className="maker-wallet-menu" ref={walletMenu}>
                <summary aria-label={`Wallet ${walletLabel}`}>
                  <WalletCards size={15} aria-hidden="true" />
                  <span>{walletLabel}</span>
                  <ChevronDown size={14} aria-hidden="true" />
                </summary>
                <div className="maker-wallet-popover">
                  <div className="maker-wallet-heading">
                    <span>Connected wallet</span>
                    <strong>{walletLabel}</strong>
                    <small title={walletAddress}>{walletLabel}</small>
                  </div>
                  <dl className="maker-wallet-facts">
                    <div>
                      <dt>Access</dt>
                      <dd>{operator ? "Operator" : "Whitelisted"}</dd>
                    </div>
                    <div>
                      <dt>Venues enabled</dt>
                      <dd>
                        <button
                          type="button"
                          onClick={() => selectView("venues")}
                        >
                          Aftermath {walletSummary.enabledVenues ? "✓" : "—"}
                        </button>
                      </dd>
                    </div>
                    <div>
                      <dt>Bundles</dt>
                      <dd>
                        <button
                          type="button"
                          onClick={() => selectView("bundles")}
                        >
                          {walletSummary.runningBundles} running of{" "}
                          {walletSummary.totalBundles}
                        </button>
                      </dd>
                    </div>
                    <div>
                      <dt>Accounts</dt>
                      <dd>
                        <button
                          type="button"
                          onClick={() => selectView("accounts")}
                        >
                          {walletSummary.authorizedAccounts} authorized
                        </button>
                      </dd>
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
                    <button type="button" onClick={onLogout}>
                      <LogOut size={15} aria-hidden="true" />
                      Disconnect
                    </button>
                  </div>
                  <div className="maker-build-info">
                    Web{" "}
                    {(process.env.NEXT_PUBLIC_GIT_COMMIT ?? "unknown").slice(
                      0,
                      7,
                    )}
                    , control {(controlBuild?.commit ?? "unknown").slice(0, 7)}
                  </div>
                  {operator &&
                    process.env.NEXT_PUBLIC_GIT_COMMIT &&
                    process.env.NEXT_PUBLIC_GIT_COMMIT !== "unknown" &&
                    (!controlBuild || controlBuild.commit === "unknown") && (
                      <p className="maker-build-skew" role="status">
                        Control build identity is unavailable. Deploy both from
                        the same commit.
                      </p>
                    )}
                  {operator &&
                    controlBuild &&
                    process.env.NEXT_PUBLIC_GIT_COMMIT &&
                    process.env.NEXT_PUBLIC_GIT_COMMIT !== "unknown" &&
                    controlBuild.commit !== "unknown" &&
                    process.env.NEXT_PUBLIC_GIT_COMMIT !==
                      controlBuild.commit && (
                      <p className="maker-build-skew" role="status">
                        Web and control are on different builds. Deploy both
                        from the same commit.
                      </p>
                    )}
                </div>
              </details>
            </div>
          </header>

          {tourPrompt && canOperate && (
            <div className="maker-tour-prompt" role="status">
              <SpreadMark size={28} state="stopped" />
              <div className="maker-tour-copy">
                <strong>New to Maker?</strong>
                <span>
                  A 30-second tour of the desk, strategies and the run control.
                </span>
              </div>
              <div className="maker-tour-actions">
                <Button variant="quiet" onClick={() => chooseTour(false)}>
                  Not now
                </Button>
                <Button variant="primary" onClick={() => chooseTour(true)}>
                  Take the tour
                </Button>
              </div>
            </div>
          )}

          {serviceUnavailable && (
            <div className="maker-service-banner" role="status">
              <AlertTriangle size={16} aria-hidden="true" />
              <span>
                Can&apos;t reach Maker. Showing data from {lastGoodDataText}.
              </span>
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
      </RunControlsContext.Provider>
    </ExplainContext.Provider>
  );
}
