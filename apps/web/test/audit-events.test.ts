import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { auditEventCopyKeys, deskEvent } from "../lib/audit-events";
import {
  AUDIT_EVENT_KINDS,
  PROBLEM_OUTCOMES,
} from "../../control/src/audit-event-kinds";
import { fixtureStates } from "../e2e/fixtures/control";

const root = path.resolve(import.meta.dirname, "../../..");

function eventObjects(source: string) {
  const events: string[] = [];
  let cursor = 0;
  while (true) {
    const start = source.indexOf(".logEvent({", cursor);
    if (start === -1) return events;
    const objectStart = source.indexOf("{", start);
    let depth = 0;
    for (let index = objectStart; index < source.length; index += 1) {
      if (source[index] === "{") depth += 1;
      if (source[index] === "}") depth -= 1;
      if (depth === 0) {
        events.push(source.slice(objectStart, index + 1));
        cursor = index + 1;
        break;
      }
    }
  }
}

function stringLiterals(expression: string) {
  return [...expression.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
}

function loggedEventKeys() {
  return ["apps/control/src/server.ts", "apps/control/src/runtime.ts"].flatMap(
    (file) => {
      const source = fs.readFileSync(path.join(root, file), "utf8");
      return eventObjects(source).flatMap((event) => {
        const category = event.match(/category:\s*"([^"]+)"/)?.[1];
        const action = event.match(/action:\s*([\s\S]*?),\s*outcome:/)?.[1];
        const outcome = event.match(
          /outcome:\s*([\s\S]*?)(?:,\s*detail:|\n\s*}\s*$)/,
        )?.[1];
        if (!category || !action || !outcome) {
          throw new Error(`Could not catalogue a server audit event: ${event}`);
        }
        const actionValues = stringLiterals(
          action.includes("?") ? action.slice(action.indexOf("?") + 1) : action,
        );
        return actionValues.flatMap((actionName) =>
          stringLiterals(outcome).map(
            (outcomeName) => `${category}:${actionName}:${outcomeName}`,
          ),
        );
      });
    },
  );
}

describe("desk audit events", () => {
  it("names the bundle when Paper resumes simulation and gives a blocked collateral event both fixes", () => {
    const cleared = deskEvent(
      {
        id: 1,
        occurredAt: "2026-11-01T00:00:00Z",
        category: "paper",
        action: "simulation",
        outcome: "cleared",
        detail: { accountId: "1757" },
      },
      { bundleName: "Core" },
    );
    expect(cleared.sentence).toBe("Paper on Core is simulating again.");
    const blocked = deskEvent(
      {
        id: 2,
        occurredAt: "2026-11-01T00:00:00Z",
        category: "paper",
        action: "simulation",
        outcome: "blocked",
        detail: {
          code: "collateral",
          accountId: "1757",
          availableUsd: 0,
          requiredUsd: 100,
          concurrentMarkets: 5,
          quoteSizeUsd: 10,
          leverage: 1,
          message: "fallback",
        },
      },
      { bundleName: "Core" },
    );
    expect(blocked.sentence).toContain(
      "Core: Paper is waiting on account 1757.",
    );
    expect(blocked.fixes?.map((fix) => fix.label)).toEqual([
      "Open Venues",
      "Edit strategy",
    ]);
  });
  it("narrates every declared server kind and every fixture event", () => {
    const kinds = [
      ...AUDIT_EVENT_KINDS,
      ...fixtureStates["paper-running"].events.events.map(
        (event) => `${event.category}:${event.action}:${event.outcome}`,
      ),
    ];
    for (const kind of kinds) {
      const [category, action, outcome] = kind.split(":");
      const result = deskEvent({
        id: 1,
        occurredAt: "2026-10-31T00:00:00.000Z",
        category: category!,
        action: action!,
        outcome: outcome!,
        detail: {
          message: "Check your bundle settings.",
          reference: "req-test",
        },
      });
      expect(result.sentence, kind).not.toContain("unclassified");
    }
    expect(
      new Set(AUDIT_EVENT_KINDS.filter((kind) => !kind.startsWith("request:"))),
    ).toEqual(new Set(auditEventCopyKeys));
  });

  it("every server-defined problem has a fix destination and warning/error tone", () => {
    for (const kind of AUDIT_EVENT_KINDS) {
      const [category, action, outcome] = kind.split(":");
      if (!PROBLEM_OUTCOMES.some((problem) => problem === outcome)) continue;
      const row = deskEvent(
        {
          id: 1,
          occurredAt: "2026-11-01T00:00:00Z",
          category: category!,
          action: action!,
          outcome: outcome!,
          detail: { message: "Review this bundle.", reference: "req-test" },
        },
        { bundleName: "Core" },
      );
      expect(row.severity, kind).not.toBe("info");
      expect(row.fixes?.length, kind).toBeGreaterThan(0);
      expect(row.sentence, kind).toContain("Core");
    }
  });

  it("uses plain control-log copy for routine progress", () => {
    expect(
      deskEvent({
        id: 1,
        occurredAt: "2026-10-29T00:00:00.000Z",
        category: "onboarding",
        action: "agent.grant",
        outcome: "confirmed",
        detail: { accountId: "1745" },
      }),
    ).toMatchObject({
      severity: "info",
      sentence: "Trading key approved for account 1745.",
    });
    expect(
      deskEvent({
        id: 2,
        occurredAt: "2026-10-29T00:00:00.000Z",
        category: "accounts",
        action: "metadata.update",
        outcome: "success",
        detail: { accountId: "1745" },
      }),
    ).toMatchObject({
      severity: "info",
      sentence: "Account name and tags saved.",
    });
  });

  it("makes a blocked Paper simulation actionable", () => {
    expect(
      deskEvent({
        id: 3,
        occurredAt: "2026-10-30T00:00:00.000Z",
        category: "paper",
        action: "simulation",
        outcome: "blocked",
        detail: {
          message:
            "Paper can't simulate: the trading key for account 1757 has no SUI for gas. Send 0.1 SUI to 0xagent; Maker will keep reading the market.",
        },
      }),
    ).toMatchObject({
      severity: "warning",
      sentence:
        "Paper can't simulate: the trading key for account 1757 has no SUI for gas. Send 0.1 SUI to 0xagent; Maker will keep reading the market.",
    });
  });

  it("adds the bundle and account when the desk can resolve them", () => {
    expect(
      deskEvent(
        {
          id: 3,
          occurredAt: "2026-10-29T00:00:00.000Z",
          category: "onboarding",
          action: "agent.grant",
          outcome: "confirmed",
          detail: { accountId: "1745" },
        },
        { bundleName: "Core", accountId: "1745" },
      ),
    ).toMatchObject({
      sentence: "Core · account 1745: trading key approved.",
    });
  });

  it("keeps unknown events informational", () => {
    expect(
      deskEvent({
        id: 3,
        occurredAt: "2026-10-29T00:00:00.000Z",
        category: "future",
        action: "new-action",
        outcome: "prepared",
        detail: {},
      }),
    ).toMatchObject({ severity: "info" });
  });

  it("covers every audit event currently emitted by the control service", () => {
    expect(auditEventCopyKeys).toEqual(
      expect.arrayContaining(loggedEventKeys()),
    );
  });
});
