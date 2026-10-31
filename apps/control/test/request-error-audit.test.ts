import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../src/store.js";
import { classifyHttpError, UserFacingError } from "../src/http-error.js";
import {
  createRequestErrorRecorder,
  type RequestFailureEvent,
} from "../src/request-error-audit.js";

describe("owner-scoped request failures", () => {
  it("classifies fixable errors without exposing unknown failures", () => {
    expect(
      classifyHttpError(
        new UserFacingError("gas-reserve-low", "Add gas to the trading key.", {
          kind: "copy",
          value: "0xagent",
        }),
      ),
    ).toMatchObject({
      status: 409,
      code: "gas-reserve-low",
      publicMessage: "Add gas to the trading key.",
      fix: { kind: "copy", value: "0xagent" },
    });
    expect(classifyHttpError(new Error("private DB path /secret"))).toEqual({
      status: 500,
      internalMessage: "private DB path /secret",
      publicMessage: "Internal server error",
    });
  });

  it("logs only public fields and suppresses owner/action/code retries for 60 seconds", () => {
    let time = 100_000;
    const entries: Array<{ owner: string; event: RequestFailureEvent }> = [];
    const record = createRequestErrorRecorder(
      (owner, event) => entries.push({ owner, event }),
      () => time,
    );
    const response = classifyHttpError(
      new UserFacingError("needs-strategy", "Attach a strategy in Bundles.", {
        kind: "bundles",
      }),
    );
    const failure = {
      owner: "0xAAA",
      path: "/api/bundles/bundle-1/start",
      reference: "req-1",
      response,
      bundleId: "bundle-1",
    };
    expect(record(failure)).toBe(true);
    expect(record({ ...failure, reference: "req-2" })).toBe(false);
    expect(record({ ...failure, owner: "0xBBB" })).toBe(true);
    time += 60_000;
    expect(record({ ...failure, reference: "req-3" })).toBe(true);
    expect(entries[0]).toEqual({
      owner: "0xAAA",
      event: {
        category: "request",
        action: "bundle-start",
        outcome: "rejected",
        detail: {
          status: 409,
          code: "needs-strategy",
          message: "Attach a strategy in Bundles.",
          reference: "req-1",
          bundleId: "bundle-1",
        },
      },
    });
    expect(entries).toHaveLength(3);
  });

  it("persists one sanitized owner-scoped 5xx event in the audit table", () => {
    const dir = join(
      process.env.TMPDIR ?? "/tmp",
      `maker-error-audit-${randomBytes(8).toString("hex")}`,
    );
    mkdirSync(dir, { recursive: true });
    const store = new Store(join(dir, "audit.db"));
    const owner = `0x${"1".repeat(64)}`;
    const anotherOwner = `0x${"2".repeat(64)}`;
    const record = createRequestErrorRecorder((address, event) =>
      store.forTenant(address).logEvent(event),
    );
    const response = classifyHttpError(
      new Error("private wallet seed and DB path"),
    );
    record({
      owner,
      path: "/api/bundles/id/start",
      reference: "req-safe",
      bundleId: "id",
      response,
    });
    record({
      owner,
      path: "/api/bundles/id/start",
      reference: "req-repeat",
      bundleId: "id",
      response,
    });
    expect(store.forTenant(owner).listEvents()).toMatchObject([
      {
        category: "request",
        action: "bundle-start",
        outcome: "error",
        detail: {
          status: 500,
          message: "Internal server error",
          reference: "req-safe",
          bundleId: "id",
        },
      },
    ]);
    expect(JSON.stringify(store.forTenant(owner).listEvents())).not.toContain(
      "private wallet seed",
    );
    expect(store.forTenant(anotherOwner).listEvents()).toEqual([]);
    store.close();
  });

  it("records one sanitized 5xx reference; auth failures never enter owner events", () => {
    const entries: RequestFailureEvent[] = [];
    const record = createRequestErrorRecorder((_owner, event) =>
      entries.push(event),
    );
    const secret = "private SQL and wallet seed";
    expect(
      record({
        owner: "0xAAA",
        path: "/api/strategies/id",
        reference: "req-9",
        strategyId: "id",
        response: classifyHttpError(new Error(secret)),
      }),
    ).toBe(true);
    expect(
      record({
        owner: "0xAAA",
        path: "/api/strategies/id",
        reference: "req-10",
        response: classifyHttpError({
          statusCode: 401,
          message: "Wallet session required",
        }),
      }),
    ).toBe(false);
    expect(
      record({
        owner: null,
        path: "/api/bundles",
        reference: "req-11",
        response: classifyHttpError({ statusCode: 403, message: "Forbidden" }),
      }),
    ).toBe(false);
    expect(entries).toEqual([
      {
        category: "request",
        action: "strategy-save",
        outcome: "error",
        detail: {
          status: 500,
          message: "Internal server error",
          reference: "req-9",
          strategyId: "id",
        },
      },
    ]);
    expect(JSON.stringify(entries)).not.toContain(secret);
  });
});
