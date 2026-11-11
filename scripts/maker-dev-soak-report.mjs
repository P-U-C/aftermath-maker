import { readFile } from "node:fs/promises";

function failure(code, message) {
  return { code, message };
}

function parseTimestamp(value) {
  if (typeof value !== "string") {
    return null;
  }

  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function renderReport(evidence, failures, durationMs) {
  const valid = failures.length === 0;
  const durationHours = durationMs / (60 * 60 * 1000);
  const lines = [
    "# maker-dev Paper soak evidence report",
    "",
    `Status: ${valid ? "VALID FIXTURE" : "INVALID"}`,
    "",
    `Window: ${evidence.window?.startedAt ?? "unavailable"} to ${evidence.window?.endedAt ?? "unavailable"}`,
    `Declared duration: ${Number.isFinite(durationHours) ? `${durationHours} hours` : "unavailable"}`,
    `Observations: ${Array.isArray(evidence.observations) ? evidence.observations.length : 0}`,
    `Events: ${Array.isArray(evidence.events) ? evidence.events.length : 0}`,
    "",
  ];

  if (evidence.durationProposal?.status === "proposal") {
    lines.push(
      `Proposed duration: ${evidence.durationProposal.hours} hours (operator approval required).`,
      evidence.durationProposal.rationale,
      "",
    );
  }

  if (valid) {
    lines.push(
      "This is a deterministic fixture only. It does not represent a maker-dev run and cannot close R4.",
    );
  } else {
    lines.push("Failures:");
    for (const item of failures) {
      lines.push(`- ${item.code}: ${item.message}`);
    }
  }

  return lines.join("\n");
}

/**
 * Validate recorded Paper-soak evidence without contacting maker-dev. A valid
 * record has continuous healthy Paper observations, one forced restart, and
 * reconciliation for every recorded event.
 */
export function validatePaperSoakEvidence(evidence) {
  const failures = [];
  const record = evidence && typeof evidence === "object" ? evidence : {};

  if (record.schemaVersion !== 1) {
    failures.push(failure("schema-version", "schemaVersion must be 1"));
  }
  if (record.environment !== "maker-dev") {
    failures.push(failure("environment", "environment must be maker-dev"));
  }
  if (record.mode !== "Paper") {
    failures.push(failure("mode", "mode must be Paper"));
  }

  const startedAt = parseTimestamp(record.window?.startedAt);
  const endedAt = parseTimestamp(record.window?.endedAt);
  const maxGapMinutes = record.window?.maxObservationGapMinutes;
  const maxGapMs =
    typeof maxGapMinutes === "number" &&
    Number.isFinite(maxGapMinutes) &&
    maxGapMinutes > 0
      ? maxGapMinutes * 60 * 1000
      : null;

  if (startedAt === null || endedAt === null || endedAt <= startedAt) {
    failures.push(
      failure("window", "window must have increasing ISO timestamps"),
    );
  }
  if (maxGapMs === null) {
    failures.push(
      failure(
        "observation-cadence",
        "window.maxObservationGapMinutes must be a positive number",
      ),
    );
  }

  const observations = Array.isArray(record.observations)
    ? record.observations
    : [];
  const observationTimes = observations.map((observation) =>
    parseTimestamp(observation?.at),
  );
  const hasInvalidObservation = observations.some(
    (observation, index) =>
      observation?.mode !== "Paper" ||
      observation?.healthy !== true ||
      observationTimes[index] === null,
  );
  const hasOutOfOrderObservation = observationTimes.some(
    (time, index) =>
      index > 0 && time !== null && time <= observationTimes[index - 1],
  );
  const hasOutsideObservation = observationTimes.some(
    (time) =>
      time !== null &&
      startedAt !== null &&
      endedAt !== null &&
      (time < startedAt || time > endedAt),
  );

  if (
    hasInvalidObservation ||
    hasOutOfOrderObservation ||
    hasOutsideObservation
  ) {
    failures.push(
      failure(
        "invalid-observation",
        "observations must be ordered, healthy Paper samples within the window",
      ),
    );
  } else if (startedAt !== null && endedAt !== null && maxGapMs !== null) {
    const coverage = [startedAt, ...observationTimes, endedAt];
    const hasGap = coverage.some(
      (time, index) => index > 0 && time - coverage[index - 1] > maxGapMs,
    );
    if (hasGap) {
      failures.push(
        failure(
          "observation-gap",
          `healthy Paper observations exceed the declared ${maxGapMinutes}-minute cadence`,
        ),
      );
    }
  }

  const events = Array.isArray(record.events) ? record.events : [];
  const eventTimes = events.map((event) => parseTimestamp(event?.at));
  const hasInvalidEvent = events.some(
    (event, index) =>
      typeof event?.id !== "string" ||
      event.id.length === 0 ||
      eventTimes[index] === null ||
      (startedAt !== null && eventTimes[index] < startedAt) ||
      (endedAt !== null && eventTimes[index] > endedAt),
  );
  if (hasInvalidEvent) {
    failures.push(
      failure(
        "invalid-event",
        "events need an id and an in-window ISO timestamp",
      ),
    );
  }

  const forcedRestart = events.find(
    (event) => event?.type === "restart" && event.forced === true,
  );
  if (!forcedRestart) {
    failures.push(
      failure(
        "missing-forced-restart",
        "at least one event must record a forced restart",
      ),
    );
  }

  const unreconciledEvent = events.find((event) => event?.reconciled !== true);
  if (unreconciledEvent) {
    failures.push(
      failure(
        "unreconciled-event",
        `event ${unreconciledEvent.id ?? "without an id"} is not reconciled`,
      ),
    );
  }

  const durationProposal = record.durationProposal;
  if (
    durationProposal?.status !== "proposal" ||
    typeof durationProposal.hours !== "number" ||
    !Number.isFinite(durationProposal.hours) ||
    durationProposal.hours <= 0 ||
    typeof durationProposal.rationale !== "string" ||
    durationProposal.rationale.length === 0
  ) {
    failures.push(
      failure(
        "duration-proposal",
        "durationProposal must be a non-empty operator-facing proposal",
      ),
    );
  }

  const durationMs =
    startedAt === null || endedAt === null ? Number.NaN : endedAt - startedAt;
  return {
    valid: failures.length === 0,
    failures,
    markdown: renderReport(record, failures, durationMs),
  };
}

async function main() {
  const evidencePath = process.argv[2];
  if (!evidencePath) {
    throw new Error(
      "Usage: node scripts/maker-dev-soak-report.mjs <evidence.json>",
    );
  }

  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  const report = validatePaperSoakEvidence(evidence);
  process.stdout.write(`${report.markdown}\n`);
  if (!report.valid) {
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  await main();
}
