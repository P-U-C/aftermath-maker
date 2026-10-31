/** Shared control-API fixture routing for headless runs. */
function fallbackStrategy(fixture) {
  const maker = fixture.config.config;
  if (!maker) return null;
  const {
    markets,
    mode: _mode,
    makerAccountId: _makerAccountId,
    hedge,
    ...settings
  } = maker;
  const { accountId: _hedgeAccountId, ...hedgeSettings } = hedge;
  return {
    id: "core-strategy",
    name: "Core strategy",
    config: { ...settings, hedge: hedgeSettings },
    marketRule: {
      kind: "preferred-list",
      marketIds: markets.map((market) => market.marketId),
    },
    markets,
    version: 1,
    usedBy: [{ id: "core-fixture", name: "Core" }],
    archivedAt: null,
  };
}
function routePathFor(url) {
  const marker = "/api/control/";
  return url.pathname.slice(url.pathname.indexOf(marker) + marker.length);
}

export function controlRequestHangs(fixture, url) {
  return (
    fixture.scenario === "stop-timeout" &&
    routePathFor(url) === "api/runtime/stop"
  );
}

export function apiResponse(fixture, url, method = "GET") {
  const routePath = routePathFor(url);

  if (routePath === "api/runtime/stop" && method === "POST") {
    fixture.bundles.bundles = fixture.bundles.bundles.map((bundle) =>
      bundle.status === "running" || bundle.status === "error"
        ? { ...bundle, status: "stopped" }
        : bundle,
    );
    fixture.status.bundles = (fixture.status.bundles ?? []).map((entry) => ({
      bundle:
        fixture.bundles.bundles.find(
          (bundle) => bundle.id === entry.bundle.id,
        ) ?? entry.bundle,
      snapshot: { ...entry.snapshot, running: false, startedAt: null },
    }));
    fixture.status.snapshot = {
      ...fixture.status.snapshot,
      running: false,
      startedAt: null,
    };
    return { status: 200, body: { ok: true } };
  }
  if (
    /^api\/bundles\/[^/]+\/(start|pause|resume)$/.test(routePath) &&
    method === "POST"
  ) {
    const [, bundleId, action] =
      routePath.match(/^api\/bundles\/([^/]+)\/(start|pause|resume)$/) ?? [];
    const nextStatus = action === "pause" ? "paused" : "running";
    fixture.bundles.bundles = fixture.bundles.bundles.map((bundle) =>
      bundle.id === bundleId ? { ...bundle, status: nextStatus } : bundle,
    );
    fixture.status.bundles = (fixture.status.bundles ?? []).map((entry) => ({
      bundle:
        fixture.bundles.bundles.find(
          (bundle) => bundle.id === entry.bundle.id,
        ) ?? entry.bundle,
      snapshot:
        entry.bundle.id === bundleId
          ? { ...entry.snapshot, running: nextStatus === "running" }
          : entry.snapshot,
    }));
    return { status: 200, body: { ok: true } };
  }
  if (routePath === "api/auth/me") return fixture.auth;
  if (routePath === "api/access-requests") {
    return { status: 200, body: { ok: true } };
  }
  if (routePath === "api/status") {
    return { status: 200, body: fixture.status };
  }
  if (routePath === "api/config") {
    return { status: 200, body: fixture.config };
  }
  if (routePath === "api/strategies") {
    const fallback = fallbackStrategy(fixture);
    return {
      status: 200,
      body: {
        strategies:
          fixture.strategies?.strategies ?? (fallback ? [fallback] : []),
      },
    };
  }
  if (routePath.startsWith("api/strategies/")) {
    return {
      status: 200,
      body: {
        strategy:
          fixture.strategies?.strategies?.[0] ?? fallbackStrategy(fixture),
        affectedBundles: [],
      },
    };
  }
  if (routePath === "api/bundles") {
    return { status: 200, body: fixture.bundles };
  }
  if (/^api\/bundles\/[^/]+\/config$/.test(routePath)) {
    return { status: 200, body: fixture.config };
  }
  if (/^api\/bundles\/[^/]+$/.test(routePath)) {
    return {
      status: 200,
      body: {
        bundle: fixture.bundles.bundles[0],
        config: fixture.config.config,
      },
    };
  }
  if (/^api\/bundles\/[^/]+\/(start|pause|resume|archive)$/.test(routePath)) {
    return { status: 200, body: { ok: true } };
  }
  if (routePath === "api/setup") {
    return { status: 200, body: fixture.setup };
  }
  if (routePath === "api/events") {
    return { status: 200, body: fixture.events };
  }
  if (routePath === "api/performance") {
    const period = url.searchParams.get("period") ?? "1D";
    return {
      status: 200,
      body: {
        performance: {
          ...fixture.performance.performance,
          period,
          periodStartedAt:
            period === "ALL"
              ? null
              : period === "EPOCH"
                ? fixture.rewards.rewards.epoch.startedAt
                : fixture.performance.performance.periodStartedAt,
        },
      },
    };
  }
  if (routePath === "api/rewards") {
    return { status: 200, body: fixture.rewards };
  }
  if (routePath === "api/markets") {
    return { status: 200, body: fixture.markets };
  }
  if (routePath === "api/accounts") {
    return { status: 200, body: fixture.accounts };
  }
  if (routePath === "api/operator/status") {
    return { status: 200, body: fixture.operator };
  }

  return {
    status: 501,
    body: { error: `No screenshot fixture for ${routePath}` },
  };
}
