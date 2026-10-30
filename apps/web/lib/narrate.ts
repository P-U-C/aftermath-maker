import { formatMoney, formatPrice } from "./format";

export type NarrationInput = {
  name?: string;
  running: boolean;
  mode: "observe" | "paper" | "live";
  market?: {
    symbol?: string | null;
    bid?: number | null;
    ask?: number | null;
    tickSize?: number | null;
  };
  inventoryUsd?: number | null;
  maxInventoryUsd?: number | null;
  lastFillAgeSeconds?: number | null;
  hedge?: {
    fired?: boolean;
    side?: "bought" | "sold";
    notionalUsd?: number | null;
  };
  rotation?: {
    secondsLeft?: number | null;
    nextSymbol?: string | null;
  };
};

const finite = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value);

export function narrate(input: NarrationInput): string {
  const name = input.name ?? "Maker";
  if (!input.running) {
    if (finite(input.inventoryUsd) && input.inventoryUsd !== 0) {
      const market = input.market?.symbol ? ` of ${input.market.symbol}` : "";
      return `Stopped in this view; confirm orders are cancelled on the venue. You still hold ${formatMoney(Math.abs(input.inventoryUsd))}${market}.`;
    }
    return "Stopped in this view; confirm orders are cancelled on the venue. No exposure is shown.";
  }
  if (input.mode === "paper") {
    return `${name} is reading markets in Paper. No real orders are placed; a dry run may be blocked.`;
  }

  const clauses: string[] = [];
  const market = input.market;
  if (
    market?.symbol &&
    finite(market.bid) &&
    finite(market.ask) &&
    market.ask > market.bid
  ) {
    const mid = (market.ask + market.bid) / 2;
    const spreadBps = ((market.ask - market.bid) / mid) * 10_000;
    clauses.push(
      `${name} calculated ${market.symbol} quote levels of ${formatPrice(market.bid, market.tickSize ?? null)} bid and ${formatPrice(market.ask, market.tickSize ?? null)} ask, ${Math.round(spreadBps)} bps apart. These prices do not prove orders are resting.`,
    );
  }

  if (
    finite(input.inventoryUsd) &&
    input.inventoryUsd !== 0 &&
    market?.symbol
  ) {
    const age = finite(input.lastFillAgeSeconds)
      ? ` from a fill ${Math.max(0, Math.round(input.lastFillAgeSeconds))} s ago`
      : "";
    clauses.push(
      `It holds ${formatMoney(Math.abs(input.inventoryUsd))} of ${market.symbol}${age}, so calculated quote levels lean ${input.inventoryUsd > 0 ? "lower to sell it back" : "higher to buy it back"}.`,
    );
  }

  if (
    input.hedge?.fired &&
    input.hedge.side &&
    finite(input.hedge.notionalUsd) &&
    market?.symbol
  ) {
    clauses.push(
      `Inventory passed its limit, so the taker account ${input.hedge.side} ${formatMoney(input.hedge.notionalUsd)} of ${market.symbol} at market.`,
    );
  }

  if (
    finite(input.rotation?.secondsLeft) &&
    input.rotation?.nextSymbol &&
    market?.symbol
  ) {
    clauses.push(
      `${market.symbol} has ${Math.max(0, Math.round(input.rotation.secondsLeft))} s left. ${input.rotation.nextSymbol} is next.`,
    );
  }

  if (
    finite(input.inventoryUsd) &&
    finite(input.maxInventoryUsd) &&
    input.maxInventoryUsd > 0 &&
    Math.abs(input.inventoryUsd) >= input.maxInventoryUsd * 0.8
  ) {
    clauses.push(
      `${name} is at ${formatMoney(Math.abs(input.inventoryUsd))} of its ${formatMoney(input.maxInventoryUsd)} inventory limit, so it may quote only the side that reduces it.`,
    );
  }

  return (
    clauses.join(" ") || `${name} is waiting for a complete market snapshot.`
  );
}
