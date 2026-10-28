# B1b Core runtime report

## Scope

B1b moves the single-bundle runtime manager to an owner-and-Core-bundle key. It is server-only: there is no bundle UI and no multi-bundle execution path.

## Runtime and queue

- A configured wallet resolves to its Core bundle; the manager key is `owner:bundle`.
- Core runtimes use the same `AftermathGateway` instance already shared by the manager. Its existing owner-scoped priority mutation queue remains the sole transaction queue.
- Stop continues to use the existing urgent cancellation queue path. The existing runtime and stop suites are unchanged and pass.
- A first-time wallet can still reach the legacy projection before its first configuration creates Core. The manager then moves that same runtime object to the Core key. A logical rollback continues to read the legacy projection and does not create a second loop.

## Attribution

New audit events, executions, Maker orders, hedge executions, and processed hedge fills record Core's bundle ID. Historical rows are assigned to Core only when the migration evidence shows Core has never been saved after creation; all other historical rows remain unassigned for the later "Before bundles" presentation.

## Single-Core behaviour

`apps/control/src/runtime.ts` has no production changes in this step. Quote construction, hedge/risk checks, rotation, signing boundaries, gas reserve checks, and Stop behaviour therefore remain the existing single-Core behaviour. The Core compatibility test serializes the quote intent and gateway submission payload on identical fixtures and asserts byte equality.

## Verification

- `npm run check`
- `npm audit --omit=dev`
- Control tests cover Core record attribution, conservative history backfill, Core quote/submission byte compatibility, and the existing runtime/stop suites.
