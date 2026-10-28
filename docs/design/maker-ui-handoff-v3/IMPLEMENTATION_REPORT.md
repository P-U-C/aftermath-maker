# Maker v3.1 implementation report

This branch is based on `origin/main` at `1225e08`, after the wallet-control/theme PR merged. It delivers the v3.1 visual system, explainability surfaces, read-only runtime observations, and the requested product redesign while retaining the existing trading controls and Live gates. The bundle work ends at RFC 0001; no bundle schema, route, runtime, or trading code was added.

## Steps and verification

| Step  | Commit(s)            | Delivered                                                                                                                           | Verification                                                                           |
| ----- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Setup | `f1355cc`            | Safe v3.1 handoff bundle                                                                                                            | Branch rebased onto `origin/main`                                                      |
| A1    | `8b43772`            | Token contrast corrections, 12 px audit floor, and gate                                                                             | Contrast audit: 0 failures                                                             |
| A1b   | `2dd9db6`            | Refined Maker mark, stateful favicons, and Apple icon                                                                               | Web typecheck and screenshots                                                          |
| A2    | `9c3514c`, `c8f9c30` | Shared visual treatment for legacy surfaces, Taker copy, Accounts under Venues navigation, ordinary table headers, and plain footer | Screenshot harness and contrast audit                                                  |
| A3    | `9e8f6c8`, `9c3514c` | Glossary, narration, Explain switch/tour, and hash-based Learn view                                                                 | Narration and web tests                                                                |
| A4    | `9c3514c`            | Mirrored live-book desk motion, real-book fallback, reduced-motion still frame, and illustrative Learn/landing motion               | Motion fixture and screenshot checks                                                   |
| A5    | `9c3514c`            | Landing hero, access flow visuals, illustration, and three setup moves                                                              | Access-request browser path retained                                                   |
| A6    | `9c3514c`            | Five-step strategy summary, quick picks, market evidence, and Strategy entry points from Markets                                    | Quick-pick unit tests                                                                  |
| A7    | `9c3514c`, `c8f9c30` | Four performance stats, volume-by-market expansion, plain rewards qualification, and goal evidence                                  | Fixture screenshots and web tests                                                      |
| A8    | `dbb3ae3`, `b339336` | Read-only runtime response shaping and fixture coverage                                                                             | Control tests and quote-invariance coverage                                            |
| S1    | `a1587a4`            | Completed                                                                                                                           | `apps/control/test/auth.test.ts`; `apps/control/test/store.test.ts`                    |
| S4    | `cc9934b`            | Completed                                                                                                                           | `apps/control/test/access-request-notifier.test.ts`; `apps/control/test/store.test.ts` |
| B0    | `3c3990b`            | Bundle RFC only                                                                                                                     | No bundle code added                                                                   |

## Contrast audit

The handoff baseline recorded 78 secondary-text contrast failures and 330 text runs
below 12 px. The post-change audit reported zero failures for signed-out,
not-on-list, onboarding, paper-running, paper-running-no-book, live-running, and
stopped fixtures in light/dark desktop and phone viewports.

Representative final output:

```text
ok   paper-running/light/desktop
ok   paper-running/light/phone
ok   paper-running/dark/desktop
ok   paper-running/dark/phone
ok   paper-running-no-book/light/desktop
ok   paper-running-no-book/light/phone
ok   paper-running-no-book/dark/desktop
ok   paper-running-no-book/dark/phone
ok   live-running/light/desktop
ok   live-running/light/phone
ok   live-running/dark/desktop
ok   live-running/dark/phone
ok   stopped/light/desktop
ok   stopped/light/phone
ok   stopped/dark/desktop
ok   stopped/dark/phone
```

## Screenshots

The final browser captures are local review artifacts:

- `/tmp/maker-v31-landing-1436/signed-out-desktop-light.png`
- `/tmp/maker-v31-a4-1428/paper-running-desk-desktop-light.png`
- `/tmp/maker-v31-no-book-1428/paper-running-no-book-desk-desktop-reduced.png`
- `/tmp/maker-v31-all-1435/paper-running-{desk,strategy,markets,performance,accounts,venues,learn}-desktop-light.png`
- `/tmp/maker-v31-strategy-1438/paper-running-strategy-phone-dark.png`
- `/tmp/maker-v31-performance-1440/paper-running-performance-desktop-dark.png`

## Deviations and data gaps

The Learn page is deliberately a hash view (`#learn`) rather than a server route; it is
reached by the glossary and does not add a bundle-era navigation item. The strategy
keeps its existing advanced controls reachable below the five-step summary so no
current configuration field or request body changes. The new desk motion uses only
snapshot values, fills, hedge changes, and order-book depth in live mode; landing and
Learn are visibly labelled illustrations.

Presentation gaps are recorded in
[`DATA_GAPS.md`](./DATA_GAPS.md): calendar-day performance windows, PnL samples,
fill markouts, complete Taker fill rows, gas runway time, and future legacy bundle
attribution. These remain omissions or explicitly qualified views rather than guessed
values.

## A8 and remediation scope

A8 is confined to response shaping and tests. The runtime uses the order book already
fetched during the cycle, exposes observation data only, and the tests confirm quote
output is unchanged with different book depth; no quoting, hedging, rotation, risk,
signing, Stop, or Live-gate decision changed.

S1 and S4 likewise did not change trading decisions; the test filenames are listed in
the step table only. The S2 and S3 findings were sent directly to the owner and are
not recorded here.

## B0 and owner decisions

[RFC 0001](../../../rfc/0001-bundles.md) specifies Core migration/rollback,
compatibility for the current config API, one runtime per wallet-and-bundle sharing the
gateway, aggregate wallet limits, gas reserve, isolated bundle errors, Stop all and
Pause, uniqueness constraints, the initial four-bundle cap, and the independent
retest required before any multi-bundle Live phase. The open decisions are default
wallet envelopes, presentation of unassignable legacy history, the measured bundle
cap, and isolated-error resume policy.

## Final checks

```text
npm run check
Checking formatting...
All matched files use Prettier code style!
@puc/core: 40 tests passed
@puc/aftermath: 36 tests passed
@puc/control: 71 tests passed
@puc/web: 19 tests passed
next build: Compiled successfully

npm audit --omit=dev
found 0 vulnerabilities
```
