# RFC 0002 amendment 2: shared Paper markets

**Decision (Round 9).** A wallet may run several bundles on the same market as long as at most one of those running bundles is Live. A Paper bundle may overlap a Paper bundle or a Live bundle; a second running Live bundle on that market is rejected with the named `market-taken` precondition. Paused and stopped bundles do not reserve markets.

This replaces the stricter running-market exclusivity rule in [the first amendment](0002-strategies-markets-amendment.md). Paper simulations never sign or broadcast orders, so two Paper bundles cannot trade with each other. Live remains limited to Core; the Live/Live overlap is a future safety boundary, not permission to add Live bundles now.

Before allowing two Live bundles to quote one market, a separate RFC must define self-trade protection across resting Maker quotes and the other bundle's taker hedge. This amendment changes neither the Live gate nor quote, hedge, signing, stop, risk and performance attribution behavior. Wallet limits still sum the exposure and resting quotes of _each_ bundle even when they share a symbol. Performance attribution remains tied to each bundle's accounts, not the market symbol.

**Acceptance:** two Paper bundles can start on NEAR, but a test-only second running Live configuration is rejected atomically; shared-market wallet limits and account-scoped fill attribution remain independent.
