# Agent instructions

Read [docs/SWARM.md](docs/SWARM.md) before any work. It is the operating
contract; this file is the part that must never be missed.

- Work is done when `node scripts/agent-gate.mjs` prints `GATE PASS` and the
  acceptance test named in your task exists and passes. Read `.agent-gate/`
  logs only for a step that failed.
- Never enable Live trading or Mainnet, handle a key, or run the live canary.
- Stay inside the paths your task lists under "May touch". A change to a
  human-only path (listed in docs/SWARM.md) waits for the operator.
- Never skip, delete or loosen a test to make the gate pass.
- One task per session. When blocked, stop, push a draft and say what blocked
  you.

Setup: Node 22, `npm ci`, branch from `dev`, pull requests target `dev`.
