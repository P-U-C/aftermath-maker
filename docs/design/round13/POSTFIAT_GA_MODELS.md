# Post Fiat GA models: discovery record

## Result

This is discovery only. On 2026-11-03 the supplied index was not readable
from this machine without an authenticated Post Fiat session, so this document
does **not** infer a model, symbol, prediction, cadence, licence, or trading
signal from its URL.

## Read-only retrieval evidence

The requested read-only request was:

```text
GET https://tasknode.postfiat.org/api/research/bundles/ga-models/index.html
```

Its redacted sample response was:

```json
{"ok":false,"error":"not_signed_in"}
```

No credentials, cookies, wallet addresses, account IDs, or headers were
recorded in this repository. The active local Task Node helper also reported
that its current profile is not linked, so it could not supply an authenticated
read-only session. No alternate profile was tried.

## Bundle and model inventory

| Item | What it is / how produced | Symbols and Aftermath mapping | Fields, horizon, cadence, history, format | Access and terms |
| --- | --- | --- | --- | --- |
| `ga-models/index.html` | Index requested by the owner; contents unavailable while signed out. | Not available. No symbols or market IDs are claimed. | Not available. | Requires a signed-in session. Rate limits, URL stability, and licence/terms remain unconfirmed. |

The linked files cannot be enumerated until the index is readable. When access
is supplied, this table should be completed directly from each downloaded file,
including a separate **unmapped symbols** list and the exact source format.

## Safe proposal after discovery is complete

Do not connect a research model to Live execution. A first integration should
be a **Paper-only** Suggest-markets experiment:

1. Map an observed model symbol to an Aftermath market by symbol and verified
   market ID; leave ambiguous and unmapped symbols out.
2. Use a model field as a ranking filter or a bounded quote-skew input, with
   the original value, timestamp, prediction horizon and model version shown
   in the UI.
3. Keep the existing execution suitability checks (session, spread, depth,
   margin, inventory, gross exposure and OI) as hard gates.

### Testable hypothesis

If the accessible bundle contains a directional score with an explicit update
timestamp and a documented horizon, then Paper quotes skewed toward that score
will have a higher signed mark-out after the same horizon than unskewed Paper
quotes on the same eligible markets.

Measure this only after the source schema is known: record model version,
score, timestamp, horizon, market ID, quote skew, fills, and mark-out at the
declared horizon. Compare paired Paper windows with identical market,
spread/depth and risk constraints. Do not attribute a result to the model when
the source is stale, incomplete, unmapped, or lacks a stated horizon.

## Required follow-up

The smallest next step is a read-only, authenticated session for the owner’s
current Post Fiat account (for example, link the active Task Node terminal
profile or provide a signed-in browser export through the owner-approved
workflow). Then fetch the index and its directly linked files, redact any
credential-shaped values, and replace this discovery record with the verified
inventory above. No account data, wallet addresses, keys, or Maker data should
be sent to that API.
