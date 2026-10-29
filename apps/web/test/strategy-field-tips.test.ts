import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { advancedFieldTips } from "../lib/strategy-field-tips";

const dashboard = fs.readFileSync(
  path.resolve(import.meta.dirname, "../components/maker-dashboard.tsx"),
  "utf8",
);

describe("advanced strategy help", () => {
  it("gives every Advanced field a help tip from the shared copy file", () => {
    const renderedTips = new Set(
      [...dashboard.matchAll(/<AdvancedTip id="([^"]+)" \/>/g)].map(
        (match) => match[1],
      ),
    );
    expect(renderedTips).toEqual(new Set(Object.keys(advancedFieldTips)));
  });

  it("explains control, unit, and direction for every field", () => {
    for (const tip of Object.values(advancedFieldTips)) {
      expect(tip.length).toBeGreaterThan(70);
      expect(tip).toMatch(/Raising|Shorter|lowering|Lowering/);
    }
  });
});
