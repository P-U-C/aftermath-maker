# Running Maker with parallel agents

This is the operating contract for more than one coding agent working on
Maker at once. It exists so agents can work without a person reading every
step, and so a person can tell from one screen whether the work is real.

Three things define "done" here, in this order:

1. `node scripts/agent-gate.mjs` prints `GATE PASS`.
2. The task's own acceptance test, named in the task, exists and passes.
3. A row in [LIVE_TEST_READINESS.md](LIVE_TEST_READINESS.md) moves, with the
   test or evidence file that moved it.

Merged pull requests, lines changed, and tokens spent are activity. None of
them is progress unless a readiness row moved.

## The gate

```bash
node scripts/agent-gate.mjs                 # before every push, about a minute
node scripts/agent-gate.mjs --scope core    # tight loop inside one workspace
node scripts/agent-gate.mjs --repeat 5      # before asking for merge
node scripts/agent-gate.mjs --full          # adds the production build
```

It runs the same format, lint, type and test checks as the required
`maker-dev-gate` workflow and prints one line per step. Raw logs go to
`.agent-gate/`; read a log only for a step that failed. The test suites print
many expected-error log lines, so a red-looking log is not a failure. The
gate's verdict is.

The gate adds three guards that CI does not have:

| Guard                    | Fails or holds when                                                             |
| ------------------------ | ------------------------------------------------------------------------------- |
| `guard:live-gates`       | A Live or Mainnet gate literal is no longer pinned off                          |
| `guard:human-only-paths` | The change touches a path in the human-only list below (verdict `HOLD`, exit 2) |
| `guard:test-integrity`   | The change removes more tests than it adds, or adds `.skip`, `.only`, `.todo`   |

A test that passes in some runs and fails in others is reported as `FLAKY`
and fails the gate. Fix the flake or the code; never rerun until green.

## Rules that no task overrides

- No agent enables Live trading, sets `ALLOW_MAINNET`, handles a key, or runs
  the live canary. Those stay with the operator, by hand, on the host.
- No agent edits a human-only path without the task saying so, and such a
  change always waits for the operator's review:
  `.github/`, `deploy/`, `move/`, `Dockerfile`, `docker-compose*.yml`,
  `.env.example`, `SECURITY.md`, `AGENTS.md`, `audits/`,
  `scripts/agent-gate.mjs`,
  `apps/control/src/live-canary*.ts`.
- No agent weakens a test to pass the gate. If a test is wrong, the pull
  request says why and replaces it with a stricter one.
- A new venue or strategy starts read-only (Observe), then Paper. It gets no
  Live path in the same pull request, matching
  [the strategy corpus buckets](strategies/README.md).
- Missing or stale inputs fail closed and are recorded as unavailable, never
  as zero.

## Lanes

Agents collide on files, not on ideas. Between 7 and 11 November, 32 commits
reached `dev`; `runtime.ts` was in 12 of them, and `store.ts` and
`server-app.ts` in 11 each. Those files cannot be shared, so the number of
useful parallel agents is the number of lanes below, not the number of
sessions that can be opened.

| Lane       | Owns                                                             | Writers at once |
| ---------- | ---------------------------------------------------------------- | --------------- |
| `runtime`  | `apps/control/src/{runtime,store,server-app}.ts` and their tests | 1               |
| `core`     | `packages/core`                                                  | 1               |
| `venue-af` | `packages/aftermath`                                             | 1               |
| `web`      | `apps/web`                                                       | 1               |
| `venue-hl` | new `packages/hyperliquid` (read-only adapter, recorder)         | 1               |
| `evidence` | `docs/`, fixtures, soak and retest reports; no `src/` changes    | 1               |
| `review`   | reads everything, writes only review comments                    | 1 or 2          |

Each lane has its own clone of the repository, so no two agents share a
working tree or a git index.

A task belongs to exactly one lane. If it needs a change in another lane,
the worker stops and files that change as its own task instead of making it.
A `runtime` task that needs a new pure function asks `core` for it first;
that keeps the single-writer lane's changes small.

Fix the gate first, with one session. Then start three writers (`runtime`,
`core`, `evidence`) and one reviewer, and add `venue-hl` as the fourth. Add a
lane only when the review queue is empty and the gate has been green for a
day.

## Tasks

The ledger is GitHub Issues with the label `swarm` and one lane label. One
issue is one pull request into `dev`. Each issue uses this shape:

```text
Lane: runtime
Readiness row: R2
Goal: one sentence, stated as an observable outcome.
Acceptance test: the exact test file and test name that must exist and pass.
May touch: explicit paths.
Must not touch: explicit paths, plus the human-only list.
Evidence to attach: gate output, and any fixture or report the row needs.
Out of scope: what a reasonable agent might be tempted to add.
```

A task without a named acceptance test is not ready to hand out. Writing
that test's name is the planner's job and the main place a person's judgment
goes.

Claiming is self-assignment plus a draft pull request from
`swarm/<issue>-<slug>`. An issue with an assignee is taken. A claim with no
push for four hours is released by the planner.

## Roles

Each role is a separate session with a fresh context. A worker never plans
the queue, and the planner never writes product code.

**Planner (one).** Reads `LIVE_TEST_READINESS.md`, the open issues and the
last day's merged pull requests. Keeps three to five ready tasks per active
lane, each with a named acceptance test. Splits anything that would touch two
lanes. Updates readiness rows only from merged evidence.

**Worker (one per lane).** Takes the oldest ready task in its lane. Works in
its lane's own clone of the repository. Writes the acceptance test first and
sees it fail, then makes it pass. Runs the scoped gate while iterating and the full gate with
`--repeat 5` before requesting review. Pastes the gate's output into the pull
request. Stops and reports, rather than improvising, when the task is wrong,
needs another lane, or needs a human-only path.

**Reviewer (one or two).** Did not write the change and starts without the
worker's transcript. Checks out the branch, reruns the gate itself, reads the
diff against the task's "May touch" list, and tries to break the acceptance
test: would it still pass if the feature were removed? Approves, or returns
specific failing cases. Never fixes the code.

**Operator (a person).** Merges. Reviews every `HOLD`. Owns the readiness
definition, the live canary and anything involving keys or capital. Reads the
gate and the readiness table, not transcripts.

## Session hygiene

- One task per session. Start a new session for the next task; long sessions
  drift and carry stale assumptions.
- A session opens by reading this file, the task, and only the files in "May
  touch". It does not read the whole repository.
- Each task carries a budget in the issue (wall time or spend). At the
  budget the worker stops, pushes what it has as a draft, and writes what
  blocked it.
- Anything decided twice becomes a script or a test, so the next agent runs
  it instead of re-deriving it.

## Prompts

Paste as the first message of the session, with the issue number filled in.

**Planner**

```text
You are the planner for the Maker repository. Read docs/SWARM.md and
docs/LIVE_TEST_READINESS.md in full, then the open issues labelled swarm and
the pull requests merged into dev in the last 24 hours. Do not write product
code. For each active lane, make sure three to five issues are ready, each in
the exact task shape from docs/SWARM.md with a named acceptance test and
explicit May touch and Must not touch paths. Split any task that spans two
lanes. Release claims with no push for four hours. Propose readiness-row
updates only where merged evidence supports them, and list for the operator
anything that needs a person: a HOLD, a readiness definition question, or a
row only a live run can close. End with a one-screen status: rows moved, rows
blocked and why, queue depth per lane.
```

**Worker**

```text
You are a worker in the <lane> lane of the Maker repository. Read
docs/SWARM.md, then issue #<n>. Work only in this lane's clone, on a new
branch swarm/<n>-<slug> cut from an up-to-date dev, and only in the paths the
issue lists under May touch.
First write the acceptance test named in the issue and confirm it fails for
the right reason. Then make it pass. Use `node scripts/agent-gate.mjs --scope
<workspace>` while iterating; read .agent-gate logs only for failed steps.
Before requesting review run `node scripts/agent-gate.mjs --repeat 5` and
paste its full output into the pull request. Never enable Live trading, never
touch a human-only path unless the issue says to, never skip, delete or
loosen a test. If the task is wrong, needs another lane, or you reach the
budget, stop, push a draft, and write exactly what blocked you.
```

**Reviewer**

```text
You are reviewing pull request #<n> in the Maker repository. You did not
write it. Read docs/SWARM.md and the linked issue, then check out the branch
and run `node scripts/agent-gate.mjs --repeat 5` yourself; do not trust
pasted output. Confirm every changed file is inside the issue's May touch
list. Then attack the acceptance test: would it still pass if the feature
were deleted, the guard inverted, or the input stale? Check that missing data
fails closed and is recorded as unavailable. Do not fix anything. Reply with
APPROVE, or with the specific cases that fail and how to reproduce each.
```
