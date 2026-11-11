# maker-dev Paper soak evidence fixtures

`maker-dev-soak-report.mjs` validates a recorded, offline JSON report. It
does not contact `maker-dev`, start Paper, or close readiness row R4.

The evidence record declares its UTC window and maximum observation gap. Every
observation must be a healthy `Paper` sample in that window. At least one event
must be a forced restart, and every event must explicitly be marked
`reconciled: true`. The record also carries an operator-facing duration
proposal; it is not approval.

Run the deterministic valid fixture with:

```bash
node scripts/maker-dev-soak-report.mjs docs/soak-reports/valid-paper-soak.json
```

The three negative fixtures show the rejection conditions: an observation gap,
no forced restart, and an unreconciled event. The checked-in report is fixture
output only. A real operator-run soak must use an approved duration and its
recorded maker-dev evidence before R4 can move.
