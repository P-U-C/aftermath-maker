import { readFileSync } from "node:fs";

function buildTime(): string {
  if (process.env.BUILT_AT) return process.env.BUILT_AT;
  try {
    return readFileSync(".maker-built-at", "utf8").trim();
  } catch {
    return "unknown";
  }
}

export const buildIdentity = Object.freeze({
  commit: process.env.GIT_COMMIT ?? "unknown",
  builtAt: buildTime(),
});
