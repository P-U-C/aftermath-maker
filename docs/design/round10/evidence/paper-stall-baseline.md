# Round 10: Paper account-read stall baseline

Read-only source baseline: detached `origin/main` at `1235e15` in a disposable
worktree. The Round 10 test and offline FakeGateway/buildServer harness were
copied into that worktree; **`apps/control/src/runtime.ts` remained the
unmodified main version**. No venue/Sui RPC or production database was used.

Command, run inside the detached baseline worktree:

```bash
npx vitest run test/runtime-stall.test.ts \
  -t 'recovers after getAgentPortfolioSnapshot hangs once' --reporter=verbose
```

Expected baseline failure (exit 1):

```text
× recovers after getAgentPortfolioSnapshot hangs once instead of freezing all later Paper ticks
AssertionError: expected 1793409115000 to be greater than 1793409115000
Test Files 1 failed (1)   Tests 1 failed | 5 skipped (6)
```

On `fix/round10` the same test passes: the pending read is timed out after
15 seconds, the Paper bundle remains running, and its next tick records a newer
`accountReadAt`. The separate 60-second Paper cycle deadline test covers an
await that is **not** itself a venue read.
