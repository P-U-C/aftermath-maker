import { describe, expect, it } from "vitest";
import { buildPaperAtomicTwapPlan } from "../src/index.js";

describe("Paper Atomic-TWAP planner", () => {
  it("builds a stable Paper-only TWAP slice plan and rejects invalid schedules", () => {
    const schedule = {
      mode: "Paper" as const,
      basketId: "basket-alpha",
      startSourceTime: 1_730_000_000_000,
      cadenceMs: 60_000,
      windowMs: 30_000,
      sliceCount: 3,
      totalUsd: 300,
    };

    const plan = buildPaperAtomicTwapPlan(schedule);
    expect(plan).toEqual({
      mode: "Paper",
      basketId: "basket-alpha",
      totalUsd: 300,
      slices: [
        {
          sliceId: "basket-alpha:twap:1730000000000:0",
          sourceWindow: { start: 1_730_000_000_000, end: 1_730_000_030_000 },
          sizeUsd: 100,
        },
        {
          sliceId: "basket-alpha:twap:1730000000000:1",
          sourceWindow: { start: 1_730_000_060_000, end: 1_730_000_090_000 },
          sizeUsd: 100,
        },
        {
          sliceId: "basket-alpha:twap:1730000000000:2",
          sourceWindow: { start: 1_730_000_120_000, end: 1_730_000_150_000 },
          sizeUsd: 100,
        },
      ],
    });
    expect(buildPaperAtomicTwapPlan(schedule)).toEqual(plan);

    for (const invalid of [
      { ...schedule, mode: "Live" },
      { ...schedule, cadenceMs: 0 },
      { ...schedule, cadenceMs: -60_000, sliceCount: 1 },
      { ...schedule, cadenceMs: Number.POSITIVE_INFINITY },
      { ...schedule, windowMs: -1 },
      { ...schedule, windowMs: 0 },
      { ...schedule, windowMs: 60_001 },
      { ...schedule, sliceCount: 0 },
      { ...schedule, sliceCount: 10_001 },
      { ...schedule, totalUsd: 0 },
      { ...schedule, totalUsd: -1 },
      { ...schedule, totalUsd: Number.NaN },
      { ...schedule, sliceIds: ["slice-a", "slice-a", "slice-c"] },
      { ...schedule, startSourceTime: Number.MAX_SAFE_INTEGER, cadenceMs: 1 },
    ]) {
      expect(() => buildPaperAtomicTwapPlan(invalid)).toThrow();
    }
    for (const windowMs of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => buildPaperAtomicTwapPlan({ ...schedule, windowMs })).toThrow(
        "window must be a positive safe integer",
      );
    }
  });
});
