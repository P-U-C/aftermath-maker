# Maker UI handoff: spread identity

Design handoff for the Maker web app (`P-U-C/aftermath-maker`, `apps/web`), based on `external-audit-remediation-v1` (`6b1ffe1`). Prepared Oct 27, 2026.

**Implementing agent: start with `AGENT_INSTRUCTIONS.md`.** It holds the safety constraints, steps, checks, and report format.

## Contents

```
maker-ui-handoff/
├── README.md                     this file
├── AGENT_INSTRUCTIONS.md         what to build, in what order, how it is checked
├── docs/
│   ├── 01-visual-polish-audit.md look, brand, tokens, copy, venue neutrality (primary)
│   ├── 02-ux-design-review.md    layout, IA, controls, states (secondary)
│   └── images/                   figures used by both documents
└── mockups/
    ├── maker2.css                design tokens and component styles (canonical values)
    ├── mark.js                   the spread mark in stopped / paper / live
    ├── desk.html                 desk, light; ?theme=dark; ?sheet=1 for the Go-Live sheet
    ├── signin.html               signed-out page
    ├── venues.html               Venues tab
    ├── phone.html                phone desk at 390×844
    ├── brand.html                brand sheet
    ├── mona.woff2                Mona Sans variable, latin subset (for the mockups only)
    ├── MONA-SANS-LICENSE.txt     SIL Open Font License 1.1
    ├── render2.py                re-renders renders/*.png with Playwright
    └── renders/                  the visual targets
```

## Reading order

1. `AGENT_INSTRUCTIONS.md`: sections 1 and 2 first.
2. `docs/01-visual-polish-audit.md`: the design.
3. `mockups/renders/`: what it should look like.
4. `docs/02-ux-design-review.md`: the layout and control problems the design solves.

## Precedence

The safety constraints come first, then existing app behavior, the mockup CSS and markup, the polish audit, and the design review. The design review came before the polish audit. Its "keep warm paper, black frames, mono numbers" advice is superseded, and its Accounts tab is now Venues.

## Viewing the mockups

```bash
cd mockups && python3 -m http.server 8090
# http://localhost:8090/desk.html   ?theme=dark   ?sheet=1
```

To re-render the targets, run `pip install playwright && playwright install chromium`, then `python3 render2.py` (or name a job, for example `python3 render2.py desk-dark`).

## Notes

- Figures in the mockups come from the audit screenshots in `audits/2026-10-27-mainnet/`. The PnL curve and the second account's equity are illustrative. The app must show real data only.
- Mona Sans is © The Mona Sans Project Authors, under the SIL OFL 1.1 (license included). In the app, install it from `@fontsource-variable/mona-sans` and self-host it. Do not hotlink it.
- Aftermath is the first venue, not the brand. Nothing in Maker's own identity uses a venue's name or colors.
