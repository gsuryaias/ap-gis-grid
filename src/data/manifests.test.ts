import { describe, expect, it } from "vitest";
import { staleness, type DatasetManifest } from "./manifests.ts";

const NOW = Date.parse("2026-06-11T00:00:00Z");

function manifest(over: Partial<DatasetManifest>): DatasetManifest {
  return {
    id: "psp-daily",
    schema: { date: "DATE", demandMet: "DOUBLE" },
    source: "Grid-India daily PSP report",
    licence: "Government Open Data License - India",
    attribution: "Grid-India (POSOCO)",
    cadence: "daily",
    vintage: "2026-06-10",
    lastSuccess: "2026-06-10T06:00:00Z",
    paths: ["timeseries/psp-daily.parquet"],
    ...over,
  };
}

describe("staleness", () => {
  it("is fresh while lastSuccess is within 2× the cadence", () => {
    expect(staleness(manifest({}), NOW)).toBe("fresh");
    // Exactly 2 days old for a daily cadence — the boundary is still fresh (strict >).
    expect(staleness(manifest({ lastSuccess: "2026-06-09T00:00:00Z" }), NOW)).toBe("fresh");
  });

  it("is stale once lastSuccess exceeds 2× the cadence", () => {
    expect(staleness(manifest({ lastSuccess: "2026-06-08T23:59:59Z" }), NOW)).toBe("stale");
    expect(staleness(manifest({ cadence: "monthly", lastSuccess: "2026-01-01T00:00:00Z" }), NOW)).toBe("stale");
    expect(staleness(manifest({ cadence: "annual", lastSuccess: "2023-01-01T00:00:00Z" }), NOW)).toBe("stale");
  });

  it("respects slower cadences", () => {
    expect(staleness(manifest({ cadence: "monthly", lastSuccess: "2026-05-01T00:00:00Z" }), NOW)).toBe("fresh");
    expect(staleness(manifest({ cadence: "annual", lastSuccess: "2025-01-01T00:00:00Z" }), NOW)).toBe("fresh");
  });

  it("never marks a static dataset stale", () => {
    expect(staleness(manifest({ cadence: "static", lastSuccess: "2020-01-01T00:00:00Z" }), NOW)).toBe("fresh");
  });

  it("is missing for a null manifest or an unparseable lastSuccess", () => {
    expect(staleness(null, NOW)).toBe("missing");
    expect(staleness(manifest({ lastSuccess: "not a date" }), NOW)).toBe("missing");
  });
});
