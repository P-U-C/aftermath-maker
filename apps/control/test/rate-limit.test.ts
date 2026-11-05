import { describe, expect, it } from "vitest";
import { appHarness, OWNER } from "./helpers/app.js";

describe("request rate limit", () => {
  it("lets a signed-in owner's dashboards poll well past 120 a minute", async () => {
    const h = await appHarness();
    try {
      const headers = h.signedInAs();
      const statuses: number[] = [];
      for (let index = 0; index < 200; index += 1) {
        statuses.push(
          (await h.app.inject({ method: "GET", url: "/api/setup", headers }))
            .statusCode,
        );
      }
      expect(statuses.filter((status) => status === 429)).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it("keeps a throttled request out of the owner's activity log", async () => {
    const h = await appHarness();
    try {
      const headers = h.signedInAs();
      let throttled = 0;
      for (let index = 0; index < 610 && !throttled; index += 1) {
        const reply = await h.app.inject({
          method: "GET",
          url: "/api/setup",
          headers,
        });
        if (reply.statusCode === 429) throttled += 1;
      }
      expect(throttled).toBe(1);
      expect(
        h.store
          .forTenant(OWNER)
          .listEvents(50)
          .filter((event) => event.detail?.code === "rate-limited"),
      ).toEqual([]);
    } finally {
      await h.close();
    }
  });
});
