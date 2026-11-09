#!/usr/bin/env python3
"""Check accounting targets and pseudonym-only packaging."""
import collections
import json
import pathlib
import re
from decimal import Decimal

ROOT = pathlib.Path(__file__).resolve().parent


def load(path):
    return json.loads((ROOT / path).read_text())


def d(value):
    return Decimal(str(value or 0))


def near(actual, expected, tolerance="0.001"):
    assert abs(d(actual) - d(expected)) <= Decimal(tolerance), (actual, expected)


def audit(ep):
    rows = load(f"epoch_{ep}/filled_orders.json")
    events = load(f"epoch_{ep}/collateral_events.json")
    e = load("expected_metrics.json")[f"epoch{ep}"]
    assert len(rows) == e["filledEvents"]
    total = lambda kind, expression: sum((expression(r) for r in rows if r["eventType"] == kind), Decimal(0))
    taker = total("FilledTakerOrder", lambda r: d(r["size"]) * d(r["price"]))
    maker = total("FilledMakerOrder", lambda r: d(r["size"]) * d(r["price"]))
    fees = sum((d(r["venueFeeUsd"]) for r in rows), Decimal(0))
    pnl = sum((d(r["realizedPnlUsd"]) for r in rows), Decimal(0))
    funding = sum((d(r["collateralChangeUsd"]) for r in events if r["eventType"] == "SettledFunding"), Decimal(0))
    liquidations = sum((d(r["pnlUsd"]) - d((r["fees"] or {}).get("netFeesUsd"))
                        for r in events if r["eventType"] == "LiquidatedPosition"), Decimal(0))
    cost = fees - pnl - funding - liquidations
    near(taker, e["takerNotionalUsd"])
    near(maker, e["makerNotionalUsd"])
    near(cost, e["realizedCostUsd"])
    if ep == 5:
        near(fees, e["netExecutionFeesUsd"])
        near(pnl, e["realizedPnlUsd"])
        near(funding, e["settledFundingUsd"])
        by_tx = collections.defaultdict(list)
        for r in rows:
            by_tx[r["txAlias"]].append(r)
        takers = [r for r in rows if r["eventType"] == "FilledTakerOrder"]
        matched = [r for r in takers if any(
            q["accountId"] != r["accountId"] and q["eventType"] == "FilledMakerOrder"
            and q["marketAlias"] == r["marketAlias"] and q["size"] == r["size"]
            and q["price"] == r["price"] and q["side"] != r["side"]
            for q in by_tx[r["txAlias"]])]
        assert len({r["txAlias"] for r in takers}) == e["uniqueTakerDigests"]
        assert len({r["txAlias"] for r in matched}) == e["matchedOwnedTakerDigests"]
        candles = load("epoch_5/hourly_market_candles.json")
        assert len(candles["markets"]) == 65
        volume = sum((d(c["volume"]) for m in candles["markets"].values() for c in m["candles"]), Decimal(0))
        near(volume, e["allMarketMatchedVolumeUsd"])
        near(taker / volume * 100, e["takerSharePct"], "0.000001")
    reward = load(f"epoch_{ep}/reward_observations.json")
    csv_perps = sum((d(v) for k, v in reward["epochCsvRowUsd"].items() if k not in ("referral", "integrator")), Decimal(0))
    near(csv_perps, e["csvPerpsUsd"], "0.000001")
    print(f"Epoch {ep}: {len(rows)} fills, taker ${taker:.2f}, maker ${maker:.2f}, cost ${cost:.2f}")


if __name__ == "__main__":
    audit(4)
    audit(5)
    for path in ROOT.rglob("*.json"):
        content = path.read_text()
        assert not re.search(r"0x[0-9a-fA-F]{64}", content), path
        assert "txDigest" not in content and "orderId" not in content, path
    print("Sanitization check: no full hex IDs or raw digest/order fields")
