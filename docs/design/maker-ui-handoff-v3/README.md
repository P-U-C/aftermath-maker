# Maker v3.1 handoff: explain, one theme, strategy builder, motion, bundles RFC

Design handoff for `P-U-C/aftermath-maker`, reviewed at `main` `6499d06` and the open branch `fix/wallet-control-and-theme` (`f3c9afb`). Prepared Oct 27, 2026; v3.1 on Oct 28, 2026.

**Implementing agent: start with `AGENT_INSTRUCTIONS.md`.**

**This copy is safe to commit to the public repo.** It leaves out the security items (S1 to S5), which the owner sends to the agent directly.

## What v3.1 changes

- **The mark:** the two-capsule mark, redrawn on a 16-unit grid with live, paper and stopped states (`mockups/mark.js`, step A1b).
- **The animation:** the mirrored order book that opens on the mark (`mockups/motion.js`, step A4).
- **Depth on the desk:** a third read-only A8 field, `snapshot.market.book`, so the desk draws the real book (approved Oct 28, 2026).

Everything else is as in v3.

## Contents

```
maker-ui-handoff-v3/
├── README.md
├── AGENT_INSTRUCTIONS.md        constraints, steps A1–A8 (with A1b; A8 now three fields), S1–S5 (sent separately), B0 (RFC, then stop), checks, report
├── docs/
│   ├── 03-product-audit.md      the audit: notes answered, theme, bundles, learning, screens, mark, motion, plan
│   └── images/                  figures used by the audit, including mark.png
├── mockups/
│   ├── maker3.css               corrected tokens and components (canonical values)
│   ├── mark.js                  the mark: geometry, small cut, states, lockup
│   ├── motion.js                the market-making animation (illustration mode + live API)
│   ├── fixture-book.json/.js    sample MON depth standing in for snapshot.market.book
│   ├── coach.js                 Explain-mode note placement
│   ├── mona.woff2, MONA-SANS-LICENSE.txt
│   ├── landing.html  learn.html  desk3.html  bundles.html  strategy3.html  performance3.html  phone3.html
│   ├── render3.mjs              re-renders renders/*.png with the repo's playwright-core
│   ├── render3.py               the same with Python Playwright
│   └── renders/                 visual targets, light and dark
└── tools/
    ├── contrast_fn.js           the text-contrast and size measurement used in the audit
    └── contrast_files.py        runs it over local pages in both themes
```

## Viewing

```bash
cd mockups && python3 -m http.server 8090
# http://localhost:8090/desk3.html   ?theme=dark   ?explain=1   ?still=1   ?book=0 (before A8)
# http://localhost:8090/strategy3.html?step=3
# http://localhost:8090/learn.html   (the animation)
```

Make the renders with `node docs/design/maker-ui-handoff-v3/mockups/render3.mjs` from the checkout (it uses `CHROMIUM_PATH` like `shots.mjs`), or with `python3 render3.py`.

## Notes

- This builds on `docs/design/maker-ui-handoff/` (v2). Identity, venue neutrality and copy rules still hold; v3.1 wins where they differ, including the mark.
- The mockups show two bundles. Phase A builds the single-bundle version; bundles are specified in an RFC (B0) and wait for the owner's approval.
- Figures come from the repo's fixtures. The second bundle and the animation's simulated takers are illustrative.
- The desk mockup runs the animation in live mode from fixture prices and `fixture-book.json`, which is sample depth standing in for the new `snapshot.market.book` field. With `?book=0` it shows the fallback: the venue's best bid and ask only.
- Mona Sans is © The Mona Sans Project Authors under the SIL OFL 1.1 (license included).
