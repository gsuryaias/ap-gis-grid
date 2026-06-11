import { describe, expect, it } from "vitest";
import {
  gateManifest,
  loadManifest,
  MANIFEST_GATES,
  staleness,
  validateManifest,
  type DatasetManifest,
} from "./manifests.ts";

const NOW = Date.parse("2026-06-11T00:00:00Z");

function manifest(over: Partial<DatasetManifest>): DatasetManifest {
  return {
    id: "psp-daily",
    schema: MANIFEST_GATES["psp-daily"]!.schema,
    source: {
      name: "Grid-India daily PSP report",
      url: "https://grid-india.in/en/reports/daily-psp-report",
    },
    licence: "Government Open Data License - India",
    attribution: "Grid-India (POSOCO)",
    cadence: "daily",
    vintage: "2026-06-10",
    lastSuccess: "2026-06-10T06:00:00Z",
    paths: ["timeseries/psp-daily.parquet"],
    ...over,
  };
}

describe("validateManifest", () => {
  it("accepts a well-formed manifest", () => {
    expect(validateManifest(manifest({}))).toBe(true);
  });

  it("rejects missing or malformed required fields", () => {
    expect(validateManifest(null)).toBe(false);
    expect(validateManifest({})).toBe(false);
    expect(validateManifest(manifest({ id: "" }))).toBe(false);
    expect(validateManifest(manifest({ source: { name: "", url: "https://example.com" } }))).toBe(false);
    expect(validateManifest(manifest({ source: { name: "x", url: "" } }))).toBe(false);
    expect(validateManifest(manifest({ cadence: "hourly" as DatasetManifest["cadence"] }))).toBe(false);
    expect(validateManifest(manifest({ paths: [] }))).toBe(false);
    expect(validateManifest(manifest({ lastSuccess: "" }))).toBe(false);
    expect(validateManifest(manifest({ rowCount: -1 }))).toBe(false);
    expect(validateManifest(manifest({ pipelineFailureIssueUrl: "not-a-url" }))).toBe(false);
  });

  it("accepts optional pipelineFailureIssueUrl when http(s)", () => {
    expect(
      validateManifest(
        manifest({ pipelineFailureIssueUrl: "https://github.com/gsuryaias/ap-gis-grid/issues/42" }),
      ),
    ).toBe(true);
  });
});

describe("gateManifest", () => {
  it("passes when schema and rowCount meet registered gates", () => {
    expect(() => gateManifest(manifest({ rowCount: 48 }))).not.toThrow();
    expect(() =>
      gateManifest({
        ...manifest({ id: "vidyut-daily", schema: MANIFEST_GATES["vidyut-daily"]!.schema, rowCount: 3 }),
      }),
    ).not.toThrow();
  });

  it("fails on schema drift or sub-threshold rowCount", () => {
    expect(() => gateManifest(manifest({ schema: { date: "VARCHAR" } }))).toThrow(/schema/);
    expect(() => gateManifest(manifest({ rowCount: 48 }))).not.toThrow();
    expect(() => gateManifest(manifest({ rowCount: 10 }))).toThrow(/rowCount/);
  });

  it("skips unknown manifest ids", () => {
    expect(() => gateManifest(manifest({ id: "custom-dataset" }))).not.toThrow();
  });
});

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

  it("treats 15min cadence as sub-hourly refresh", () => {
    const freshAt = new Date(NOW - 29 * 60_000).toISOString();
    const staleAt = new Date(NOW - 31 * 60_000).toISOString();
    expect(staleness(manifest({ cadence: "15min", lastSuccess: freshAt }), NOW)).toBe("fresh");
    expect(staleness(manifest({ cadence: "15min", lastSuccess: staleAt }), NOW)).toBe("stale");
  });

  it("never marks a static or one-time dataset stale", () => {
    expect(staleness(manifest({ cadence: "static", lastSuccess: "2020-01-01T00:00:00Z" }), NOW)).toBe("fresh");
    expect(staleness(manifest({ cadence: "one-time", lastSuccess: "2020-01-01T00:00:00Z" }), NOW)).toBe("fresh");
  });

  it("is missing for a null manifest or an unparseable lastSuccess", () => {
    expect(staleness(null, NOW)).toBe("missing");
    expect(staleness(manifest({ lastSuccess: "not a date" }), NOW)).toBe("missing");
  });
});

describe("live data-branch manifests", () => {
  const live = process.env.CI === "true";

  for (const id of Object.keys(MANIFEST_GATES)) {
    it.skipIf(!live)(`validates ${id} from the data branch`, async () => {
      const m = await loadManifest(id);
      expect(m, `${id} manifest missing or invalid on data branch`).not.toBeNull();
      gateManifest(m!);
    });
  }
});
