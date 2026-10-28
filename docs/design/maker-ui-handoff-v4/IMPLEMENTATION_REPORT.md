# Maker v4 implementation report

The ui/v4 branch is based on origin/main at 361a086, because the connect-button and motion branch had already merged. Parts F, M and L were implemented and verified on this web-only branch; no deployment, signing, production-service request, environment-file change, or live-setting change was made. B1 was not completed safely, so B2 did not start and B3 remains out of scope.

## Step status

| Step | Commit | Status | What changed | Accept result |
| --- | --- | --- | --- | --- |
| F1 | bc0c692 | done | Centralised money/copy formatting, full status/fill words, and untruncated control-log time. | Format tests and the desk/table clipping check pass. |
| F2 | 47d9448 | done | Replaced the long strategy surface with the five-step builder, inline limits, moved Review mode, and moved market rotation/rank controls. | The configuration-body comparison, quick-pick coverage, and five-step save walk pass. |
| F3 | 3e2b5b3 | done | Filtered fills by market, corrected ranks, made tables scroll locally, and rebuilt goal evidence. | Fixture performance view has no negative-zero value or page-level overflow. |
| F4 | d6f0544 | done | Added active Add/In-strategy market controls, operator-only fee content, and readable inactive account roles. | Contrast audit and role-assignment harness pass. |
| F5 | 6e4edff | done | Raised phone target sizes, reserved sticky-bar space, and added scrollable fading tabs/local table overflow. | Final full-state 390 px shots pass in light and dark. |
| F6 | f59b6f1 | done | Sized the desktop desk lane and preserved stable engine mount inputs. | 1440 px desk evidence has no empty lane band. |
| F7 | 00880b4 | done | Made web tests timezone-independent, skipped viewless states, and added the root contrast command. | TZ=America/Vancouver npm run check passes. |
| M1 | eaa479d | done | Added view, number, row, freshness, sheet, and reduced-motion animation behavior. | Motion verifier captures transition/settled states; reduced-motion and ten-second-idle checks pass. |
| M2 | 067fe5e, 9f03307 | done | Added the remaining landing sections, links, illustration replay, demos, safety/trust placement, closing CTA, and footer; repaired the browser fixture's visible wallet-picker selection. | Landing screenshot/overflow checks and wallet-preauth denied scenario pass. |
| L1 | d484216 | done | Built chapter-driven Learn scenes, sticky responsive stage, glossary links, and deep links. | Learn scene/deep-link verifier passes, including reduced-motion poses and the hedge end state. |
| L2 | 383b5ec | done | Added non-overlapping desktop Explain placement, phone note sheet, tour prompt, and Escape/focus return. | Explain verifier passes at 1440 and 390 for Desk, Strategy, Markets, Performance, and Venues. |
| B1 | — | not done | No server change was committed. | Required migration/compatibility and byte-identical order tests were not run. |
| B2 | — | not started | Gated on a merged B1 and completed F2. | Blocked by B1. |
| B3 | — | out of scope | Not attempted. | Not applicable. |

## Evidence

The review baseline reported viewless-state shot timeouts and incomplete visual coverage. The final commands below passed with a local server on port 8899:

    node apps/web/e2e/shots.mjs --base-url http://127.0.0.1:8899 --view all
    # exited 0; captured every fixture state/view/capture combination

    node apps/web/e2e/wallet-preauth.mjs --base-url http://127.0.0.1:8899 --scenario denied
    ok   denied/desktop
    ok   denied/phone

    npm run audit:ui -- --base-url http://127.0.0.1:8899
    ok   signed-out/light/desktop
    ok   signed-out/light/phone
    ok   signed-out/dark/desktop
    ok   signed-out/dark/phone
    ok   not-on-list/light/desktop
    ok   not-on-list/light/phone
    ok   not-on-list/dark/desktop
    ok   not-on-list/dark/phone
    ok   onboarding/light/desktop
    ok   onboarding/light/phone
    ok   onboarding/dark/desktop
    ok   onboarding/dark/phone
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

Committed 1× PNG evidence is in report/: signed-out landing, denied wallet-preauth path, all requested paper-running product views at 1440 light/dark and 390 dark, plus the five Learn chapter captures. Bundle views are intentionally absent because B1 and B2 are not complete.

## Motion-engine changes

apps/web/lib/market-motion-engine.js remains the mounted mockup engine. L1 made only these extensions:

1. Added director: false to prevent autonomous simulated takers in Learn.
2. Added cancellable named play(name) chapter scripts.
3. Added still pose(name) chapter keyframes, used for reduced motion.
4. Added chapter-timer cleanup on a subsequent scene and on destroy.
5. Exposed play() and pose() through the returned controller.
6. Emitted chapter events through the existing event callback.
7. Added the displayed time-qualified counter used by the Rewards scene.

The changes exist solely to make the labelled landing/Learn illustration deterministic and accessible; desk data rendering continues to use snapshots, fills, and hedges.

## Bundles

There is no B1/B2 implementation diff in this branch. Parts F/M/L do not change quoting, hedging, risk, rotation, signing, or Stop decisions. B1 remains unreported as complete; the RFC migration/compatibility and byte-identical order tests must pass before a B1 PR is opened, and B2 must wait for its merge.

## Final command tails

    TZ=America/Vancouver npm run check
    Test Files  3 passed (3)   Tests 40 passed (40)   # core
    Test Files  4 passed (4)   Tests 38 passed (38)   # aftermath
    Test Files  8 passed (8)   Tests 71 passed (71)   # control
    Test Files  4 passed (4)   Tests 21 passed (21)   # web
    ✓ Compiled successfully
    ✓ Generating static pages using 6 workers (3/3)

    npm audit --omit=dev
    found 0 vulnerabilities
