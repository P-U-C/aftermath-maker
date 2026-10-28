/** Shared control-API fixture routing for headless runs. */
export function apiResponse(fixture, url) {
  const marker = "/api/control/";
  const routePath = url.pathname.slice(
    url.pathname.indexOf(marker) + marker.length,
  );

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
