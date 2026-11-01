"use client";

import { ChevronDown, LoaderCircle, Pause, Play, Square } from "lucide-react";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { createPortal } from "react-dom";

import type { RunBundle, RunPhase, RunState } from "../lib/run-state";
import { formatPaperBlocker } from "../lib/paper-blocker";
import { Sheet } from "./ui/primitives";

type BundleAction = "start" | "pause" | "resume";

type RunControlProps = {
  run: RunState;
  compact?: boolean;
  open: boolean;
  selectedBundleId: string | null;
  stoppedAt: Record<string, string | undefined>;
  onOpenChange: (open: boolean) => void;
  onBundleAction: (bundleId: string, action: BundleAction) => void;
  onStopAll: () => void;
  onManageBundles: () => void;
  onOpenStrategy: () => void;
  onOpenVenues: () => void;
};

function usePhoneLayout() {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 700px)");
    const update = () => setPhone(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return phone;
}

function formatSince(value: string | null) {
  if (!value) return "this session";
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function statusWord(phase: RunPhase) {
  if (phase === "starting") return "Starting…";
  if (phase === "running") return "Quoting";
  if (phase === "attention") return "Needs attention";
  if (phase === "pausing" || phase === "stopping") {
    return "Cancelling orders…";
  }
  if (phase === "paused") return "Paused";
  return "Stopped";
}

function indicatorClass(indicator: RunState["indicator"] | "hollow"): string {
  return `run-state-indicator is-${indicator}`;
}

function StateIndicator({
  indicator,
  size = "small",
  amberHollow = false,
}: {
  indicator: RunState["indicator"] | "hollow";
  size?: "small" | "row";
  amberHollow?: boolean;
}) {
  if (indicator === "spinner") {
    return (
      <LoaderCircle
        className={`run-state-spinner is-${size}`}
        size={size === "row" ? 14 : 12}
        aria-hidden="true"
      />
    );
  }
  return (
    <span
      className={`${indicatorClass(indicator)} is-${size}${
        amberHollow ? " is-amber-ring" : ""
      }`}
      aria-hidden="true"
    />
  );
}

function rowIndicator(bundle: RunBundle): RunState["indicator"] {
  if (
    bundle.phase === "starting" ||
    bundle.phase === "pausing" ||
    bundle.phase === "stopping"
  ) {
    return "spinner";
  }
  if (bundle.phase === "attention") return "amber";
  if (bundle.phase === "running") {
    return bundle.mode === "live" ? "ember" : "tide";
  }
  return "hollow";
}

function rowDetail(
  bundle: RunBundle,
  stoppedAt: string | undefined,
): {
  text: string;
  tone?: "amber" | undefined;
  destination?: "strategy" | "venues" | "bundles" | undefined;
  copyAddress?: string | undefined;
  rotation?: boolean;
  checked?: string | null;
} {
  if (bundle.startError) {
    const fix = bundle.startError.fix;
    return {
      text: bundle.startError.message,
      tone: "amber",
      ...(fix?.kind === "copy" && fix.value ? { copyAddress: fix.value } : {}),
      ...(fix?.kind === "accounts"
        ? { destination: "venues" as const }
        : fix?.kind === "strategy" ||
            fix?.kind === "venues" ||
            fix?.kind === "bundles"
          ? { destination: fix.kind }
          : {}),
    };
  }
  if (bundle.needsStrategy) {
    return {
      text: "Needs a strategy.",
      tone: "amber",
      destination: "bundles",
    };
  }
  if (bundle.phase === "attention") {
    if (bundle.snapshot?.paperBlocker) {
      const blocker = formatPaperBlocker(bundle.snapshot.paperBlocker);
      return {
        text: blocker.sentence,
        tone: "amber",
        destination: blocker.destination ?? undefined,
        copyAddress: blocker.copyAddress,
        rotation: blocker.rotation,
        checked: blocker.checked,
      };
    }
    const reason =
      bundle.lastError ?? bundle.snapshot?.lastError ?? "Needs review.";
    const normalized = reason.toLowerCase();
    return {
      text: reason,
      tone: "amber",
      destination: /balance|account|trading key|agent/.test(normalized)
        ? "venues"
        : /market|strategy/.test(normalized)
          ? "strategy"
          : undefined,
    };
  }
  if (bundle.phase === "starting") return { text: "Starting…" };
  if (bundle.phase === "pausing" || bundle.phase === "stopping") {
    return { text: "Cancelling its orders…" };
  }
  if (bundle.phase === "paused") {
    return {
      text: bundle.holdsOrders
        ? "Paused. Cancelling its orders…"
        : "Paused. No orders open.",
    };
  }
  if (bundle.phase === "stopped") {
    return stoppedAt
      ? {
          text: `Stopped at ${formatSince(stoppedAt)}. Its orders are cancelled.`,
        }
      : { text: "Stopped" };
  }
  const symbols = (bundle.snapshot?.markets ?? [])
    .map((market) => market.symbol)
    .filter((symbol): symbol is string => Boolean(symbol));
  if (!symbols.length) return { text: "Waiting for its first quote" };
  return {
    text:
      symbols.length > 2
        ? `Quoting ${symbols.length} markets`
        : `Quoting ${symbols.join(" and ")}`,
  };
}

function actionFor(bundle: RunBundle): BundleAction | null {
  if (bundle.phase === "running" || bundle.phase === "attention") {
    return "pause";
  }
  if (bundle.phase === "paused") return "resume";
  if (bundle.phase === "stopped" && !bundle.needsStrategy) return "start";
  return null;
}

function actionLabel(
  bundle: RunBundle,
  action: BundleAction | null,
  blocked: boolean,
) {
  if (!action) {
    return bundle.needsStrategy
      ? `Start ${bundle.name}, attach a strategy first`
      : `${bundle.name} is busy`;
  }
  const verb =
    action === "pause" ? "Pause" : action === "resume" ? "Resume" : "Start";
  return blocked
    ? `${verb} ${bundle.name}, apply its strategy changes first`
    : `${verb} ${bundle.name}`;
}

function sortedBundles(bundles: RunBundle[]) {
  const rank: Record<RunPhase, number> = {
    attention: 0,
    running: 1,
    starting: 2,
    pausing: 2,
    stopping: 2,
    paused: 3,
    stopped: 4,
  };
  return [...bundles].sort(
    (left, right) =>
      rank[left.phase] - rank[right.phase] ||
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
  );
}

export function RunStatusChip({
  bundle,
  onClick,
}: {
  bundle: RunBundle;
  onClick: () => void;
}) {
  const state = statusWord(bundle.phase);
  return (
    <button
      className="run-status-chip"
      type="button"
      onClick={onClick}
      aria-label={`${bundle.name}: ${state}. Open run status`}
    >
      <StateIndicator indicator={rowIndicator(bundle)} />
      {state}
    </button>
  );
}

function RunStatusContent({
  run,
  selectedBundleId,
  stoppedAt,
  onClose,
  onBundleAction,
  onStopAll,
  onManageBundles,
  onOpenStrategy,
  onOpenVenues,
  headingRef,
  rowsRef,
}: {
  run: RunState;
  selectedBundleId: string | null;
  stoppedAt: Record<string, string | undefined>;
  onClose: () => void;
  onBundleAction: (bundleId: string, action: BundleAction) => void;
  onStopAll: () => void;
  onManageBundles: () => void;
  onOpenStrategy: () => void;
  onOpenVenues: () => void;
  headingRef: MutableRefObject<HTMLHeadingElement | null>;
  rowsRef: MutableRefObject<Record<string, HTMLDivElement | null>>;
}) {
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const starting = run.bundles.find((bundle) => bundle.phase === "starting");
  const stopping = run.stop.phase === "stopping";
  const unconfirmed = run.stop.phase === "unconfirmed";
  const stoppedTargets = run.stop.targets.filter((id) => {
    const bundle = run.bundles.find((candidate) => candidate.id === id);
    return bundle && !bundle.holdsOrders;
  });
  const targetNames = run.stop.targets
    .map((id) => run.bundles.find((bundle) => bundle.id === id)?.name)
    .filter((name): name is string => Boolean(name));
  const title = unconfirmed
    ? `Stop not confirmed for ${targetNames.join(", ") || "bundles"}`
    : stopping
      ? `Stopping ${run.stop.targets.length} bundles`
      : starting && run.running.length === 0
        ? `Starting ${starting.name}`
        : run.running.length
          ? `${run.running.length} of ${run.bundles.length} bundles running`
          : "Nothing running";
  const subline = stopping
    ? "Cancelling open orders"
    : run.running.length === 0
      ? "Start any bundle below."
      : run.liveCount && run.paperCount
        ? `${run.liveCount} live, ${run.paperCount} on paper`
        : run.liveCount
          ? `Live since ${formatSince(run.since)}`
          : `On paper since ${formatSince(run.since)}`;

  return (
    <section
      id="run-status"
      className="run-status-popover"
      aria-label="Run status"
    >
      <header className="run-status-header">
        <div>
          <h2 ref={headingRef} tabIndex={-1}>
            {title}
          </h2>
          <p>{subline}</p>
        </div>
        <button
          className="run-status-manage"
          type="button"
          onClick={() => {
            onManageBundles();
            onClose();
          }}
        >
          Manage bundles
        </button>
      </header>
      {run.configDirty && (
        <p className="run-status-dirty">
          Apply or discard your Strategy changes to start or resume bundles.{" "}
          <button
            type="button"
            onClick={() => {
              onOpenStrategy();
              onClose();
            }}
          >
            Open Strategy
          </button>
        </p>
      )}
      <div className="run-status-rows">
        {sortedBundles(run.bundles).map((bundle) => {
          const action = actionFor(bundle);
          const blocked = Boolean(
            run.configDirty && (action === "start" || action === "resume"),
          );
          const detail = rowDetail(bundle, stoppedAt[bundle.id]);
          const busy =
            bundle.phase === "starting" ||
            bundle.phase === "pausing" ||
            bundle.phase === "stopping";
          return (
            <div
              className={
                bundle.id === selectedBundleId
                  ? "run-status-row is-selected"
                  : "run-status-row"
              }
              ref={(element) => {
                rowsRef.current[bundle.id] = element;
              }}
              key={bundle.id}
            >
              <span className="run-status-row-indicator">
                <StateIndicator indicator={rowIndicator(bundle)} size="row" />
              </span>
              <div className="run-status-row-copy">
                <div>
                  <strong>{bundle.name}</strong>
                  <span className={`run-mode-tag is-${bundle.mode}`}>
                    {bundle.mode === "live" ? "Live" : "Paper"}
                  </span>
                </div>
                <p className={detail.tone === "amber" ? "is-amber" : undefined}>
                  {detail.text}
                  {detail.checked && <> {detail.checked}.</>}{" "}
                  {detail.destination === "venues" && (
                    <button
                      type="button"
                      onClick={() => {
                        onOpenVenues();
                        onClose();
                      }}
                    >
                      {bundle.startError?.fix?.kind === "venues" ||
                      bundle.startError?.fix?.kind === "accounts"
                        ? "Authorize it in Venues"
                        : "Open Venues"}
                    </button>
                  )}
                  {detail.copyAddress && (
                    <button
                      type="button"
                      aria-live="polite"
                      onClick={() =>
                        void navigator.clipboard
                          .writeText(detail.copyAddress!)
                          .then(
                            () => setCopiedAddress(bundle.id),
                            () => setCopiedAddress(null),
                          )
                      }
                    >
                      {copiedAddress === bundle.id
                        ? "Copied"
                        : "Copy trading key address"}
                    </button>
                  )}
                  {detail.rotation && (
                    <button
                      type="button"
                      onClick={() => {
                        onOpenStrategy();
                        onClose();
                      }}
                    >
                      Edit strategy
                    </button>
                  )}
                  {detail.destination === "strategy" && (
                    <button
                      type="button"
                      onClick={() => {
                        onOpenStrategy();
                        onClose();
                      }}
                    >
                      Open Strategy
                    </button>
                  )}
                  {detail.destination === "bundles" && (
                    <button
                      type="button"
                      onClick={() => {
                        onManageBundles();
                        onClose();
                      }}
                    >
                      Open Bundles
                    </button>
                  )}
                </p>
              </div>
              <button
                className="run-status-row-action"
                type="button"
                disabled={busy || !action || blocked}
                aria-label={actionLabel(bundle, action, blocked)}
                title={actionLabel(bundle, action, blocked)}
                onClick={() => action && onBundleAction(bundle.id, action)}
              >
                {busy ? (
                  <LoaderCircle
                    size={16}
                    className="run-state-spinner"
                    aria-hidden="true"
                  />
                ) : action === "pause" ? (
                  <Pause size={17} aria-hidden="true" />
                ) : (
                  <Play size={17} aria-hidden="true" />
                )}
              </button>
            </div>
          );
        })}
      </div>
      <footer className="run-status-footer">
        {stopping ? (
          <>
            <span className="run-status-stopping">
              <LoaderCircle
                size={15}
                className="run-state-spinner"
                aria-hidden="true"
              />
              Stopping…
            </span>
            <p>
              {stoppedTargets.length
                ? `${stoppedTargets.length} of ${run.stop.targets.length} stopped. Cancelling the rest of the orders.`
                : `Cancelling orders for ${run.stop.targets.length} bundles.`}
            </p>
          </>
        ) : run.stoppable ? (
          <>
            <button
              className="run-status-stop"
              type="button"
              onClick={onStopAll}
            >
              <Square size={11} fill="currentColor" aria-hidden="true" />
              {unconfirmed ? "Retry stop" : "Stop all"}
            </button>
            <p>
              {unconfirmed
                ? "Maker didn't confirm within 20 seconds. Orders may still be open on Aftermath."
                : "Cancels every open order. Positions stay open until you flatten them on Desk."}
            </p>
          </>
        ) : (
          <button
            className="run-status-recovery"
            type="button"
            onClick={onStopAll}
          >
            Cancel any leftover Maker orders
          </button>
        )}
      </footer>
    </section>
  );
}

export function RunControl({
  run,
  compact = false,
  open,
  selectedBundleId,
  stoppedAt,
  onOpenChange,
  onBundleAction,
  onStopAll,
  onManageBundles,
  onOpenStrategy,
  onOpenVenues,
}: RunControlProps) {
  const phone = usePhoneLayout();
  const visible = compact ? phone : !phone;
  const contentOpen = open && visible;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const rowsRef = useRef<Record<string, HTMLDivElement | null>>({});
  const [announced, setAnnounced] = useState(run.label);
  const [mounted, setMounted] = useState(false);
  const announcementRef = useRef({
    label: run.label,
    at: 0,
    timer: 0 as number | null,
  });

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const current = announcementRef.current;
    if (current.label === run.label) return;
    const publish = () => {
      announcementRef.current = {
        label: run.label,
        at: Date.now(),
        timer: null,
      };
      setAnnounced(run.label);
    };
    const elapsed = Date.now() - current.at;
    if (elapsed >= 2_000) {
      publish();
      return;
    }
    current.timer = window.setTimeout(publish, 2_000 - elapsed);
    return () => {
      if (announcementRef.current.timer) {
        window.clearTimeout(announcementRef.current.timer);
        announcementRef.current.timer = null;
      }
    };
  }, [run.label]);

  useEffect(() => {
    if (!contentOpen) return;
    const frame = window.requestAnimationFrame(() => {
      headingRef.current?.focus();
      if (selectedBundleId) {
        rowsRef.current[selectedBundleId]?.scrollIntoView({ block: "nearest" });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [contentOpen, selectedBundleId]);

  useEffect(() => {
    if (!contentOpen || compact) return;
    const closeForOutsidePress = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onOpenChange(false);
    };
    const closeForEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onOpenChange(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeForOutsidePress);
    document.addEventListener("keydown", closeForEscape);
    return () => {
      document.removeEventListener("pointerdown", closeForOutsidePress);
      document.removeEventListener("keydown", closeForEscape);
    };
  }, [compact, contentOpen, onOpenChange]);

  if (!visible) return null;

  const close = () => onOpenChange(false);
  const stop = () => onStopAll();
  const shortLabel =
    run.label === "Stopped"
      ? "Stopped"
      : run.label.includes("needs attention")
        ? "Needs attention"
        : run.label.replace(/^([A-Za-z0-9 ]+) on paper$/, "On paper");
  const isStopping = run.stop.phase === "stopping";
  const showStop = run.stoppable && !isStopping;
  const status = (
    <RunStatusContent
      run={run}
      selectedBundleId={selectedBundleId}
      stoppedAt={stoppedAt}
      onClose={close}
      onBundleAction={onBundleAction}
      onStopAll={stop}
      onManageBundles={onManageBundles}
      onOpenStrategy={onOpenStrategy}
      onOpenVenues={onOpenVenues}
      headingRef={headingRef}
      rowsRef={rowsRef}
    />
  );

  if (compact) {
    return (
      <>
        <div className="run-control run-control-compact" ref={rootRef}>
          <button
            ref={triggerRef}
            className="run-control-label"
            type="button"
            onClick={() => onOpenChange(!open)}
            aria-expanded={open}
            aria-controls="run-status"
            aria-label={`Run status: ${shortLabel}`}
          >
            <StateIndicator indicator={run.indicator} amberHollow={run.stale} />
            <span>{shortLabel}</span>
            <ChevronDown size={14} aria-hidden="true" />
          </button>
          {showStop && (
            <button
              className="run-control-stop"
              type="button"
              aria-label="Stop all"
              title="Stop all bundles"
              onClick={stop}
            >
              <Square size={12} fill="currentColor" aria-hidden="true" />
            </button>
          )}
        </div>
        <span className="run-control-live" aria-live="polite">
          {announced}
        </span>
        {mounted &&
          createPortal(
            <Sheet
              open={contentOpen}
              title="Run status"
              description={run.label}
              onClose={close}
            >
              {status}
            </Sheet>,
            document.body,
          )}
      </>
    );
  }

  return (
    <div
      className={showStop ? "run-control" : "run-control is-solo"}
      ref={rootRef}
    >
      <button
        ref={triggerRef}
        className={`run-control-label ${run.tone === "amber" ? "is-amber" : ""}`}
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-controls="run-status"
        aria-label={`Run status: ${run.label}`}
      >
        <StateIndicator indicator={run.indicator} amberHollow={run.stale} />
        <span>{run.label}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {showStop && (
        <button
          className="run-control-stop"
          type="button"
          aria-label="Stop all"
          title="Stop all bundles"
          onClick={stop}
        >
          <Square size={11} fill="currentColor" aria-hidden="true" />
        </button>
      )}
      <span className="run-control-live" aria-live="polite">
        {announced}
      </span>
      {contentOpen && status}
    </div>
  );
}
