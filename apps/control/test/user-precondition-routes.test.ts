import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import ts from "typescript";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makerConfigSchema } from "@puc/core";
import { classifyHttpError, UserFacingError } from "../src/http-error.js";
import { Store } from "../src/store.js";

type Harness = {
  tenant: ReturnType<Store["forTenant"]>;
  owner: string;
  core: ReturnType<ReturnType<Store["forTenant"]>["listBundles"]>[number];
  config: ReturnType<typeof makerConfigSchema.parse>;
};

function withStore(run: (h: Harness) => void) {
  const dir = join(
    process.env.TMPDIR ?? "/tmp",
    `maker-preconditions-${randomBytes(8).toString("hex")}`,
  );
  mkdirSync(dir, { recursive: true });
  const store = new Store(join(dir, "test.db"));
  const owner = `0x${"e".repeat(64)}`;
  const tenant = store.forTenant(owner);
  const config = makerConfigSchema.parse({
    markets: [{ marketId: "0x9901", symbol: "MON" }],
  });
  tenant.setConfig(config);
  const core = tenant.listBundles()[0]!;
  try {
    run({ tenant, owner, core, config });
  } finally {
    store.close();
  }
}

describe("typed preconditions on user-facing routes", () => {
  it("catalogues every converted server/store/runtime precondition as a safe 4xx with a stable code", () => {
    let converted = 0;
    for (const file of ["server.ts", "store.ts", "runtime-manager.ts"]) {
      const source = ts.createSourceFile(
        file,
        readFileSync(join(import.meta.dirname, "../src", file), "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node: ts.Node) => {
        if (
          ts.isNewExpression(node) &&
          node.expression.getText(source) === "UserFacingError"
        ) {
          const args = node.arguments ?? [];
          const code = args[0];
          const copy = args[1];
          expect(
            code && ts.isStringLiteral(code),
            `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`,
          ).toBe(true);
          const stableCode = (code as ts.StringLiteral).text;
          expect(stableCode).toMatch(/^[a-z][a-z0-9-]+$/);
          const message =
            copy && ts.isStringLiteral(copy)
              ? copy.text
              : copy && ts.isTemplateExpression(copy)
                ? [
                    copy.head.text,
                    ...copy.templateSpans.map((part) => part.literal.text),
                  ].join(" value ")
                : "This operation needs attention. Review your setup and retry.";
          expect(message.length, stableCode).toBeGreaterThan(12);
          const statusArg = args[3];
          const status =
            statusArg && ts.isNumericLiteral(statusArg)
              ? Number(statusArg.text)
              : 409;
          expect(
            classifyHttpError(
              new UserFacingError(stableCode, message, undefined, status),
            ),
          ).toMatchObject({
            status,
            code: stableCode,
            publicMessage: message,
          });
          converted += 1;
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(converted).toBeGreaterThan(50);
  });

  const cases: Array<{
    route: string;
    code: string;
    status: number;
    message: string;
    run: (h: Harness) => void;
  }> = [
    {
      route: "POST /api/strategies",
      code: "strategy-name-taken",
      status: 409,
      message: "Choose a different name.",
      run: ({ tenant }) => {
        const saved = tenant.listStrategies()[0]!;
        tenant.createStrategy({
          name: saved.name,
          config: saved.config,
          marketRule: saved.marketRule,
          markets: saved.markets,
        });
      },
    },
    {
      route: "PATCH /api/strategies/:id (stale)",
      code: "strategy-version-conflict",
      status: 409,
      message: "Compare your draft",
      run: ({ tenant }) => {
        const saved = tenant.listStrategies()[0]!;
        tenant.updateStrategy({
          strategyId: saved.id,
          name: saved.name,
          config: saved.config,
          marketRule: saved.marketRule,
          markets: saved.markets,
          expectedVersion: saved.version - 1,
        });
      },
    },
    {
      route: "POST /api/strategies/:id/archive",
      code: "strategy-in-use",
      status: 409,
      message: "Detach it in Bundles",
      run: ({ tenant }) =>
        tenant.archiveStrategy(tenant.listStrategies()[0]!.id),
    },
    {
      route: "POST /api/bundles/:id/start (needs strategy)",
      code: "needs-strategy",
      status: 409,
      message: "Attach a strategy in Bundles",
      run: ({ tenant, owner, config }) => {
        const draft = tenant.createAllocatedBundle({
          name: "Draft",
          makerAccountId: null,
          takerAccountId: null,
          mode: "paper",
          strategyId: null,
          markets: config.markets,
        });
        // The route calls this tenant guard before runtime admission.
        tenant.assertBundleMarketsAvailableToStart(draft.id);
      },
    },
    {
      route: "POST /api/bundles/:id/start (market taken)",
      code: "market-taken",
      status: 409,
      message: "Duplicate the strategy",
      run: ({ tenant, core, config }) => {
        tenant.confirmWalletLimits();
        const other = tenant.createAllocatedBundle({
          name: "Second",
          makerAccountId: null,
          takerAccountId: null,
          mode: "paper",
          strategyId: core.strategyId,
          markets: config.markets,
        });
        tenant.setBundleStatus(core.id, "running");
        tenant.assertBundleMarketsAvailableToStart(other.id);
      },
    },
    {
      route: "PATCH /api/bundles/:id (stale)",
      code: "bundle-version-conflict",
      status: 409,
      message: "Compare your changes",
      run: ({ tenant, core }) =>
        tenant.updateBundleAllocation({
          bundleId: core.id,
          expectedUpdatedAt: "2025-01-01T00:00:00Z",
          mode: "paper",
        }),
    },
    {
      route: "POST /api/bundles (limit)",
      code: "bundle-limit",
      status: 409,
      message: "Archive an unused bundle",
      run: ({ tenant, config }) => {
        tenant.confirmWalletLimits();
        for (let i = 1; i <= 3; i++)
          tenant.createBundle({
            name: `Paper ${i}`,
            config: {
              ...config,
              markets: [{ marketId: `0x99${i + 1}1`, symbol: `P${i}` }],
            },
          });
        tenant.createBundle({ name: "Fifth", config });
      },
    },
  ];
  it.each(cases)(
    "$route returns $code without masking it as 500",
    ({ code, status, message, run }) => {
      withStore((h) => {
        let thrown: unknown;
        try {
          run(h);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(UserFacingError);
        expect(classifyHttpError(thrown)).toMatchObject({
          status,
          code,
          publicMessage: expect.stringContaining(message),
        });
      });
    },
  );
});
