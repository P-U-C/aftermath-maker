"use client";

import { useEffect, useRef, type KeyboardEvent } from "react";
import { ChevronDown } from "lucide-react";

type StrategyOption = {
  id: string;
  name: string;
  marketCount: number;
  selection: string;
  bundleCount: number;
};

function optionSummary(strategy: StrategyOption): string {
  return `${strategy.marketCount} market${strategy.marketCount === 1 ? "" : "s"} · ${strategy.selection} · ${strategy.bundleCount ? `${strategy.bundleCount} attached bundle${strategy.bundleCount === 1 ? "" : "s"}` : "Not attached"}`;
}

export function StrategyPicker({
  strategies,
  selectedId,
  draftName,
  onSelect,
  variant = "card",
}: {
  strategies: StrategyOption[];
  selectedId: string | null;
  draftName: string | null;
  onSelect: (strategyId: string) => Promise<boolean>;
  variant?: "card" | "menu";
}) {
  const details = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  const selected = strategies.find((strategy) => strategy.id === selectedId);
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !details.current?.contains(event.target) &&
        details.current
      )
        details.current.open = false;
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, []);
  const nameIsDraft = Boolean(
    selected && draftName !== null && draftName.trim() !== selected.name,
  );
  const focusSummary = () => {
    summary.current?.focus({ preventScroll: true });
    summary.current?.scrollIntoView({ block: "center", behavior: "auto" });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDetailsElement>) => {
    if (event.key === "Escape" && details.current?.open) {
      event.preventDefault();
      details.current.open = false;
      focusSummary();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const options = [
      ...(details.current?.querySelectorAll<HTMLButtonElement>(
        '[role="option"]',
      ) ?? []),
    ];
    if (!options.length) return;
    const active = options.indexOf(document.activeElement as HTMLButtonElement);
    if (active === -1 && event.key !== "ArrowDown") return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? options.length - 1
          : event.key === "ArrowUp"
            ? (active - 1 + options.length) % options.length
            : (active + 1) % options.length;
    options[next]?.focus();
  };

  return (
    <details
      className={
        variant === "menu" ? "strategy-picker is-menu" : "strategy-picker"
      }
      ref={details}
      onKeyDown={onKeyDown}
      onToggle={(event) => {
        if (event.currentTarget.open)
          window.requestAnimationFrame(() =>
            summary.current?.scrollIntoView({ block: "center" }),
          );
      }}
    >
      <summary
        ref={summary}
        aria-label={`Choose strategy: ${nameIsDraft ? draftName : (selected?.name ?? "none")}; ${selected ? optionSummary(selected) : "No strategies yet"}`}
      >
        {variant === "menu" ? (
          <>
            <strong>
              {strategies.length}{" "}
              {strategies.length === 1 ? "strategy" : "strategies"}
            </strong>
            <ChevronDown size={14} aria-hidden="true" />
          </>
        ) : (
          <>
            <span>Strategy</span>
            <strong>
              {nameIsDraft
                ? draftName
                : (selected?.name ?? "Choose a strategy")}
            </strong>
            <small>
              {selected ? optionSummary(selected) : "No strategies yet"}
            </small>
            {nameIsDraft && <em>Draft name · applied as {selected?.name}</em>}
          </>
        )}
      </summary>
      <div
        className="strategy-picker-options"
        role="listbox"
        aria-label="Strategies"
      >
        {strategies.length ? (
          strategies.map((strategy) => (
            <button
              key={strategy.id}
              type="button"
              role="option"
              aria-selected={strategy.id === selectedId}
              aria-label={`${strategy.name}; ${optionSummary(strategy)}`}
              onClick={async () => {
                if (await onSelect(strategy.id)) {
                  if (details.current) details.current.open = false;
                  focusSummary();
                }
              }}
            >
              <strong>{strategy.name}</strong>
              <small>{optionSummary(strategy)}</small>
            </button>
          ))
        ) : (
          <p>No strategies yet. Create one to begin.</p>
        )}
      </div>
    </details>
  );
}
