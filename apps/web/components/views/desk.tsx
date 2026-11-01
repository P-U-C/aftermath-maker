"use client";

import { ArrowDownRight, Clock3, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  formatEventTimestamp,
  formatExactMoney,
  formatMoney,
  formatSignedMoney,
  formatTimestamp,
  moneyTone,
} from "../../lib/format";
import type { VenueDescriptor } from "../../lib/venues";
import { AnimatedNumber } from "../ui/animated-number";
import { GlossaryTerm } from "../ui/glossary-term";
import {
  Button,
  Card,
  ListRow,
  Meter,
  SegmentedTabs,
  Sheet,
} from "../ui/primitives";
import { useRowEnter } from "../ui/use-row-enter";
import {
  MarketMotion,
  type MarketBook,
  type MarketMotionHandle,
} from "../market-motion";
import { VenueChip } from "../venue-chip";
import type { RunState } from "../../lib/run-state";
import { ViewFrame } from "./view-frame";

export type DeskMarketRow = {
  id: string;
  symbol: string;
  status: "queued" | "healthy" | "error";
  bundleName: string | null;
  inventoryUsd: number;
  unrealizedPnlUsd: number;
  effectiveSpreadBps: number | null;
  customFieldCount?: number;
  activityLabel?: string;
  updatedAt: string | null;
};

export type DeskFill = {
  id: string;
  occurredAt: string;
  symbol: string;
  side: "bid" | "ask";
  price: number;
  notionalUsd: number;
  realizedPnlUsd: number;
  txDigest: string;
  estimated: boolean;
};

export type DeskEvent = {
  id: number;
  occurredAt: string;
  severity: "info" | "warning" | "error";
  sentence: string;
  fixes?: Array<{
    label: string;
    view?: "venues" | "strategy" | "bundles";
    copyAddress?: string;
  }>;
};

type DeskViewProps = {
  active: boolean;
  venue: VenueDescriptor;
  run: RunState;
  refreshBusy: boolean;
  flattenBusy: boolean;
  flattenDisabled: boolean;
  flattenArmed: boolean;
  pnlUsd: number | null;
  equityUsd: number | null;
  reportBundleName: string | null;
  grossExposureUsd: number | null;
  marketCount: number;
  lastFill: DeskFill | null;
  narration: string;
  mode: "observe" | "paper" | "live";
  paper: {
    estimated: boolean;
    openOrders: number;
    fills: number;
    hedges: number;
    makerInventoryUsd: number;
    hedgeInventoryUsd: number;
    grossExposureUsd: number;
  };
  market: {
    symbol: string;
    tickSize: number | null;
    indexPrice: number | null;
    bestBid: number | null;
    bestAsk: number | null;
    ourBid: number | null;
    ourAsk: number | null;
    spreadBps: number;
    updatedAt: string | null;
    book: MarketBook;
    subtitle: string;
  };
  risk: {
    grossExposureUsd: number | null;
    grossExposureLimitUsd: number;
    hedgeTriggerUsd: number | null;
    worstSideFillUsd: number;
    runDrawdownUsd: number | null;
    runDrawdownLimitUsd: number;
    gasRunwayTransactions: number | null;
    updatedAt: string | null;
  };
  markets: DeskMarketRow[];
  marketsUpdatedAt: string | null;
  fills: DeskFill[];
  fillsUpdatedAt: string | null;
  events: DeskEvent[];
  onEventFilterChange: (filter: "all" | "problems") => void;
  onEventFix: (view: "venues" | "strategy" | "bundles") => void;
  staleAfterMs: number;
  lastHedgeDigest: string | null;
  unavailable: boolean;
  showMarketLane: boolean;
  bundleLanes?: ReactNode;
  onRefresh: () => void;
  onFlatten: () => void;
  onCancelFlatten: () => void;
};

function Freshness({
  timestamp,
  staleAfterMs,
  unavailable = false,
}: {
  timestamp: string | null;
  staleAfterMs: number;
  unavailable?: boolean;
}) {
  const parsed = timestamp ? Date.parse(timestamp) : Number.NaN;
  const stale =
    unavailable ||
    (Number.isFinite(parsed) &&
      Date.now() - parsed > Math.max(1, staleAfterMs));
  const lastTimestamp = useRef(timestamp);
  const [fresh, setFresh] = useState(false);

  useEffect(() => {
    if (timestamp === lastTimestamp.current) return;
    lastTimestamp.current = timestamp;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setFresh(true);
    const timer = window.setTimeout(() => setFresh(false), 400);
    return () => window.clearTimeout(timer);
  }, [timestamp]);

  return (
    <span
      className={[
        "desk-freshness",
        stale ? "is-stale" : null,
        fresh ? "is-fresh" : null,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {formatTimestamp(timestamp)}
    </span>
  );
}

export function DeskView({
  active,
  venue,
  run,
  refreshBusy,
  flattenBusy,
  flattenDisabled,
  flattenArmed,
  pnlUsd,
  equityUsd,
  reportBundleName,
  grossExposureUsd,
  marketCount,
  lastFill,
  narration,
  mode,
  paper,
  market,
  risk,
  markets,
  marketsUpdatedAt,
  fills,
  fillsUpdatedAt,
  events,
  onEventFilterChange,
  onEventFix,
  staleAfterMs,
  lastHedgeDigest,
  unavailable,
  showMarketLane,
  bundleLanes,
  onRefresh,
  onFlatten,
  onCancelFlatten,
}: DeskViewProps) {
  const running = run.running.length > 0;
  const startedAt = run.since;
  const motion = useRef<MarketMotionHandle>(null);
  const motionReady = useRef(false);
  // The meter shows the selected market's signed inventory, so a short reads as short. It
  // fills toward the hedge trigger, or toward the gross limit when hedging is off.
  const inventoryUsd =
    markets.find((row) => row.symbol === market.symbol)?.inventoryUsd ?? 0;
  const inventoryScaleUsd = risk.hedgeTriggerUsd ?? risk.grossExposureLimitUsd;
  const seenFillIds = useRef(new Set<string>());
  const seenHedgeDigest = useRef<string | null>(null);
  const fillEnterClass = useRowEnter(fills);
  const eventEnterClass = useRowEnter(events);
  const [eventFilter, setEventFilter] = useState<"all" | "problems">("all");
  const [eventsExpanded, setEventsExpanded] = useState(false);
  const [copiedEventId, setCopiedEventId] = useState<number | null>(null);
  const visibleEvents = eventsExpanded ? events : events.slice(0, 12);

  useEffect(() => {
    const update = {
      mid: market.indexPrice,
      bid: market.ourBid,
      ask: market.ourAsk,
      bestBid: market.bestBid,
      bestAsk: market.bestAsk,
      inventoryUsd,
      book: market.book,
    };
    motion.current?.update(update);

    if (!motionReady.current) {
      motionReady.current = true;
      fills.forEach((fill) => seenFillIds.current.add(fill.id));
      seenHedgeDigest.current = lastHedgeDigest;
      return;
    }

    const newFills = fills.filter((fill) => !seenFillIds.current.has(fill.id));
    newFills.forEach((fill) => {
      seenFillIds.current.add(fill.id);
      motion.current?.fill(fill.side);
    });
    if (
      lastHedgeDigest &&
      seenHedgeDigest.current &&
      lastHedgeDigest !== seenHedgeDigest.current
    ) {
      motion.current?.hedge();
    }
    seenHedgeDigest.current = lastHedgeDigest;
  }, [
    fills,
    lastHedgeDigest,
    market.bestAsk,
    market.bestBid,
    market.book,
    market.indexPrice,
    market.ourAsk,
    market.ourBid,
    inventoryUsd,
  ]);

  const marketCaption = running
    ? mode === "paper"
      ? "Paper quotes are simulated; no real orders are placed."
      : "Maker is reading markets. Verify resting quotes on the venue."
    : "Waiting for its first market turn.";
  return (
    <ViewFrame active={active} name="desk">
      <div className={running ? "desk-page is-running" : "desk-page"}>
        <section className="desk-hero">
          <div>
            <span>Net known result, last 24 hours</span>
            <strong
              className={`desk-pnl is-${moneyTone(pnlUsd)}`}
              title={formatExactMoney(pnlUsd)}
            >
              <AnimatedNumber
                value={formatSignedMoney(pnlUsd)}
                motionId="known-result"
              />
            </strong>
            <div className="desk-facts">
              <span>
                {reportBundleName
                  ? `${reportBundleName} maker equity`
                  : "Maker equity"}{" "}
                <b>
                  <AnimatedNumber
                    value={formatMoney(equityUsd)}
                    motionId="maker-equity"
                  />
                </b>
              </span>
              <span>
                Bundle gross exposure{" "}
                <b>
                  <AnimatedNumber
                    value={formatMoney(grossExposureUsd)}
                    motionId="maker-exposure"
                  />
                </b>
              </span>
              <span>
                Markets <b>{marketCount}</b>
              </span>
              <span>
                Running since{" "}
                <b>
                  {startedAt
                    ? new Date(startedAt).toLocaleTimeString([], {
                        hour: "numeric",
                        minute: "2-digit",
                      })
                    : "Not running"}
                </b>
              </span>
              <span>
                Last fill{" "}
                <b>
                  {lastFill
                    ? `${formatMoney(lastFill.notionalUsd)} ${lastFill.side}`
                    : "Waiting"}
                </b>
              </span>
              <Button
                className="desk-flatten-desktop"
                variant="secondary"
                onClick={onFlatten}
                disabled={flattenDisabled}
              >
                Flatten positions…
              </Button>
              {paper.estimated && (
                <span>
                  Paper estimate{" "}
                  <b>
                    {paper.openOrders} orders / {paper.fills} fills /{" "}
                    {paper.hedges} hedges
                  </b>
                </span>
              )}
            </div>
          </div>

          <div className="desk-hero-actions">
            <Button
              className="desk-flatten-phone"
              variant="secondary"
              onClick={onFlatten}
              disabled={flattenDisabled}
            >
              Flatten positions…
            </Button>
          </div>
        </section>

        {bundleLanes}

        <p className="desk-narration" aria-live="polite">
          Right now: {narration}
        </p>

        <div
          className={
            showMarketLane
              ? "desk-primary-grid"
              : "desk-primary-grid is-wallet-total"
          }
        >
          {showMarketLane && (
            <Card
              className="desk-ladder-card"
              title={
                <span className="desk-card-title">
                  {running && (
                    <span className="desk-card-title-prefix">Checking </span>
                  )}
                  {market.symbol}
                  <VenueChip venue={venue} />
                </span>
              }
              subtitle={market.subtitle}
              action={
                <div className="desk-card-action">
                  <Freshness
                    timestamp={market.updatedAt}
                    staleAfterMs={staleAfterMs}
                    unavailable={unavailable}
                  />
                  <Button
                    size="icon"
                    variant="quiet"
                    onClick={onRefresh}
                    aria-label="Refresh market"
                  >
                    <RefreshCw
                      size={17}
                      className={refreshBusy ? "spin" : undefined}
                      aria-hidden="true"
                    />
                  </Button>
                </div>
              }
            >
              <MarketMotion
                ref={motion}
                className="desk-market-motion"
                compact
                height={300}
                sim={false}
                mid={market.indexPrice}
                bid={market.ourBid}
                ask={market.ourAsk}
                bestBid={market.bestBid}
                bestAsk={market.bestAsk}
                inventoryUsd={inventoryUsd}
                book={market.book}
                hedgeTriggerUsd={inventoryScaleUsd}
              />
              <p className="desk-market-caption">{marketCaption}</p>
            </Card>
          )}

          <Card
            className="desk-risk-card"
            title="Risk"
            subtitle="Current exposure against configured limits."
            action={
              <Freshness
                timestamp={risk.updatedAt}
                staleAfterMs={staleAfterMs}
                unavailable={unavailable}
              />
            }
          >
            <div className="desk-risk-stack">
              {risk.grossExposureUsd === null ? (
                <p className="desk-action-note" role="status">
                  Exposure unavailable for this bundle; do not infer zero risk
                  from the stopped Core snapshot.
                </p>
              ) : (
                <Meter
                  label="Gross exposure"
                  value={risk.grossExposureUsd}
                  max={risk.grossExposureLimitUsd}
                  valueText={`${formatMoney(risk.grossExposureUsd)} of ${formatMoney(risk.grossExposureLimitUsd)}`}
                />
              )}
              <Meter
                label="Worst-side fills"
                value={risk.worstSideFillUsd}
                max={risk.grossExposureLimitUsd}
                valueText={`${formatMoney(risk.worstSideFillUsd)} of ${formatMoney(risk.grossExposureLimitUsd)}`}
              />
              <Meter
                label="Run drawdown"
                value={risk.runDrawdownUsd ?? 0}
                max={risk.runDrawdownLimitUsd}
                valueText={
                  risk.runDrawdownUsd === null
                    ? `Not reported / ${formatMoney(risk.runDrawdownLimitUsd)} limit`
                    : `${formatMoney(risk.runDrawdownUsd)} of ${formatMoney(risk.runDrawdownLimitUsd)}`
                }
              />
              <Meter
                label="Gas runway"
                value={risk.gasRunwayTransactions ?? 0}
                max={Math.max(300, risk.gasRunwayTransactions ?? 0)}
                tone={
                  risk.gasRunwayTransactions === null
                    ? "warning"
                    : risk.gasRunwayTransactions < 3
                      ? "limit"
                      : risk.gasRunwayTransactions < 30
                        ? "warning"
                        : "normal"
                }
                valueText={
                  risk.gasRunwayTransactions === null
                    ? "Not reported"
                    : `${risk.gasRunwayTransactions} paid actions after reserve`
                }
              />
              <p className="desk-drawdown-note">
                {risk.runDrawdownUsd === null
                  ? "Run drawdown is not reported yet."
                  : `Stops if it falls ${formatMoney(risk.runDrawdownLimitUsd)} from its best point this run.`}{" "}
                <a href="#strategy">Size and limits</a>
              </p>
            </div>
          </Card>
        </div>

        <div className="desk-secondary-grid">
          <Card
            className="desk-markets-card"
            title="Markets"
            subtitle="Inventory and unrealized result by selected market."
            action={
              <Freshness
                timestamp={marketsUpdatedAt}
                staleAfterMs={staleAfterMs}
                unavailable={unavailable}
              />
            }
          >
            <div className="desk-market-headings" aria-hidden="true">
              <span>Market</span>
              <span>Status</span>
              <span>Inventory</span>
              <span>Policy</span>
              <span>
                <GlossaryTerm term="unrealizedPnl">
                  Unrealized P&amp;L
                </GlossaryTerm>
              </span>
            </div>
            <div className="desk-list">
              {markets.length ? (
                markets.map((row) => (
                  <ListRow
                    key={row.id}
                    trailing={
                      <span
                        className={`desk-row-pnl is-${moneyTone(row.unrealizedPnlUsd)}`}
                      >
                        {formatSignedMoney(row.unrealizedPnlUsd)}
                      </span>
                    }
                  >
                    <span className="desk-market-row">
                      <strong>{row.symbol}</strong>
                      <span className={`desk-market-state is-${row.status}`}>
                        {row.status === "healthy"
                          ? "Quoting"
                          : row.status === "error"
                            ? "Needs attention"
                            : "Waiting"}
                      </span>
                      <span>
                        {formatSignedMoney(row.inventoryUsd)} inventory
                      </span>
                      <span>
                        {row.effectiveSpreadBps === null
                          ? "—"
                          : row.customFieldCount
                            ? `${row.customFieldCount} custom`
                            : "Strategy"}
                      </span>
                    </span>
                  </ListRow>
                ))
              ) : (
                <div className="desk-empty">Pick markets to start.</div>
              )}
            </div>
          </Card>

          <Card
            className="desk-fills-card"
            title="Fills"
            subtitle={
              paper.estimated
                ? "Exchange fills are confirmed; Paper fills and results are estimates."
                : "Confirmed fills from Maker-tagged orders."
            }
            action={
              <Freshness
                timestamp={fillsUpdatedAt}
                staleAfterMs={staleAfterMs}
                unavailable={unavailable}
              />
            }
          >
            <div className="desk-list">
              {fills.length ? (
                fills.slice(0, 8).map((fill) => (
                  <ListRow
                    key={fill.id}
                    className={fillEnterClass(fill.id, fill.side)}
                    leading={<VenueChip venue={venue} compact />}
                    trailing={
                      <span
                        className={`desk-row-pnl is-${moneyTone(fill.realizedPnlUsd)}`}
                      >
                        {formatSignedMoney(fill.realizedPnlUsd)}
                      </span>
                    }
                  >
                    <span className="desk-fill-row">
                      <strong>{fill.symbol}</strong>
                      <span className={`desk-fill-side is-${fill.side}`}>
                        {fill.estimated ? "Estimated " : ""}
                        {fill.side === "bid" ? "Bought" : "Sold"}
                      </span>
                      <span>{formatMoney(fill.notionalUsd)}</span>
                      <span>{formatTimestamp(fill.occurredAt)}</span>
                    </span>
                  </ListRow>
                ))
              ) : (
                <div className="desk-empty">
                  Confirmed fills will appear here.
                </div>
              )}
            </div>
          </Card>
        </div>

        <Card
          className="desk-log-card"
          title="Control log"
          subtitle="Recent engine and risk events."
          action={
            <SegmentedTabs
              label="Control log filter"
              value={eventFilter}
              options={[
                { value: "all", label: "All" },
                { value: "problems", label: "Problems" },
              ]}
              onChange={(filter) => {
                setEventFilter(filter);
                setEventsExpanded(false);
                onEventFilterChange(filter);
              }}
            />
          }
        >
          <div className="desk-event-list">
            {visibleEvents.length ? (
              visibleEvents.map((event) => (
                <ListRow
                  key={event.id}
                  className={eventEnterClass(event.id)}
                  leading={<Clock3 size={15} aria-hidden="true" />}
                >
                  <span className="desk-event-row">
                    <time dateTime={event.occurredAt}>
                      {formatEventTimestamp(event.occurredAt)}
                    </time>
                    <span
                      className={`desk-event-severity is-${event.severity}`}
                    >
                      {event.severity}
                    </span>
                    <strong className="desk-event-description">
                      {event.sentence}{" "}
                      {event.fixes?.map((fix) => (
                        <button
                          key={fix.label}
                          type="button"
                          onClick={() => {
                            if (fix.view) onEventFix(fix.view);
                            else if (fix.copyAddress)
                              void navigator.clipboard
                                .writeText(fix.copyAddress)
                                .then(() => setCopiedEventId(event.id));
                          }}
                        >
                          {copiedEventId === event.id && fix.copyAddress
                            ? "Copied"
                            : fix.label}
                        </button>
                      ))}
                    </strong>
                  </span>
                </ListRow>
              ))
            ) : (
              <div className="desk-empty">
                {eventFilter === "problems"
                  ? "No problems recorded."
                  : "No control events recorded."}
              </div>
            )}
          </div>
          {!eventsExpanded && events.length > 12 && (
            <Button
              variant="secondary"
              size="small"
              onClick={() => setEventsExpanded(true)}
            >
              Show more
            </Button>
          )}
        </Card>
      </div>

      <Sheet
        open={flattenArmed}
        title="Flatten positions?"
        description="This cancels Maker orders, then uses reduce-only market orders across the Maker and Taker accounts."
        onClose={() => {
          if (!flattenBusy) onCancelFlatten();
        }}
        footer={
          <>
            <Button
              variant="quiet"
              onClick={onCancelFlatten}
              disabled={flattenBusy}
            >
              Cancel
            </Button>
            <Button variant="stop" onClick={onFlatten} disabled={flattenBusy}>
              <ArrowDownRight size={17} aria-hidden="true" />
              {flattenBusy ? "Flattening…" : "Confirm flatten"}
            </Button>
          </>
        }
      >
        <div className="desk-flatten-summary">
          <ListRow trailing={venue.name}>Venue</ListRow>
          <ListRow trailing={formatMoney(grossExposureUsd)}>
            Current gross exposure
          </ListRow>
          <ListRow trailing="Up to 1%">Maximum slippage</ListRow>
          <p>
            Residual positions may remain when a thin market cannot fill within
            the slippage limit. Review the Desk after completion.
          </p>
        </div>
      </Sheet>
    </ViewFrame>
  );
}
