# RFC 0003: Paper that mimics Live

- **Status:** Approved — implementation in progress
- **Date:** 2026-10-29
- **Scope:** Replace the user-facing Observe mode with Paper and make Paper a live-like, non-signing dry run.

## Decision

Expose only **Paper** and **Live**. Observe becomes an internal readiness/check mode;
existing historical Observe records remain labelled Observe. Upgrading an existing Observe
bundle must leave it stopped and convert its editable mode to Paper with an audit event;
nothing starts automatically.

Paper follows the Live preparation path but never signs, broadcasts, or changes an
on-chain capability:

1. Normalize the same composed config and perform the same account, wallet-limit, gas
   reserve, queue, risk, and Stop-priority checks as Live.
2. Build the same transaction bytes that Live would build, then dry-run those bytes
   against the chain and retain the actual gas estimate and dry-run error/result.
3. Track paper resting orders in a paper-only ledger. Estimate fills only when a sampled
   book or trade crosses a resting paper order; resulting inventory, hedges, and
   performance are explicitly labelled **estimated**.

A chain dry run cannot create a resting order or prove queue position/fill. It is therefore
not an execution claim and must never be presented as one.

## Boundaries and API

Paper state is partitioned from submitted orders and real executions by bundle, mode, and
trial correlation id. It may use the owner-scoped gateway queue for serialized
construction/dry-run work, but it cannot consume a signing capability, broadcast, or
change Live request behavior.

`POST /api/runtime/paper-trial` runs a bounded three-cycle Paper trial in an isolated
scratch ledger. It may run while other bundles run, has no configuration side effect, and
is cancelable by **Stop all**. Stop retains queue priority and remains available at all
times. The UI calls it “Test run: 3 cycles” and says “Paper dry run; fills are estimated.”

Live remains a separately gated path. Its transaction construction and submission code are
unchanged; shared construction is acceptable only if existing byte-identical order tests
prove no Live byte change.

## Migration

- Preserve raw historical `observe` values for audit/performance display.
- On config migration, map editable Observe configs to stopped Paper configs, write an
  audit event, and preserve the previous raw mode in history.
- Add no automatic Paper fills to existing execution history.
- Rollback keeps the current legacy/Core compatibility mirrors; it does not discard Paper
  ledger history.

## Tests and acceptance

- Existing Live order-byte and submitted-order-byte fixtures still match exactly.
- Paper uses the same constructed bytes and records dry-run gas/error, while tests prove
  no signer, broadcaster, capability, or real execution write is invoked.
- Deterministic fixtures prove estimated fills only on a crossing sample and prove
  inventory, hedge, and performance remain marked estimated.
- A three-cycle trial works beside a running bundle without changing that bundle's bytes
  or state; Stop all preempts both safely.
- Observe-to-Paper migration is stopped, auditable, idempotent, and preserves historical
  labels.

## Non-goals

No Live expansion, automatic fill claim, strategy selection change, trading-decision
change, or production deployment is included in this RFC.
