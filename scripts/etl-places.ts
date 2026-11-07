// Place-search gazetteer (GeoNames AP extract) → places.json (Atlas 2.0 phase 4 split of build-data.mts).
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { dedupePlaces, parsePlacesTsv, placeType, round5, type PlaceTuple } from "./etl-lib.ts";

/**
 * Build the place-search gazetteer from the committed GeoNames AP extract
 * (data/raw/geonames-ap.tsv, CC BY 4.0). Emitted as compact tuples — `places.json` is
 * LAZY-loaded by the search box on first use (never part of the initial payload) and is
 * search-only: places are not a map layer and are never selectable features.
 */
export function buildPlaces(outDir: string): void {
  const tsvPath = resolve("data/raw/geonames-ap.tsv");
  console.log(`[etl] reading ${tsvPath}`);
  const rows = parsePlacesTsv(readFileSync(tsvPath, "utf-8"));

  // District names for disambiguation, from the extract's own ADM2 rows (covers both the
  // 13-district and 26-district vintages GeoNames mixes).
  const districts = new Map<string, string>();
  for (const r of rows) if (r.fcode === "ADM2") districts.set(r.admin2, r.name);

  const deduped = dedupePlaces(rows).sort(
    (a, b) => b.population - a.population || a.name.localeCompare(b.name),
  );
  const places: PlaceTuple[] = deduped.map((r) => {
    const type = placeType(r.fclass, r.fcode, r.population);
    // Districts / the state row need no district disambiguator of their own.
    const district = r.fclass === "A" && r.fcode !== "ADM3" ? "" : (districts.get(r.admin2) ?? "");
    return [r.name, type, district, round5(r.lng), round5(r.lat), r.population];
  });

  if (places.length < 25_000) {
    console.error(`[etl] VALIDATION FAILED: places gazetteer has ${places.length} rows (< 25000)`);
    process.exit(1);
  }
  writeFileSync(
    resolve(outDir, "places.json"),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      source: "GeoNames gazetteer, Andhra Pradesh extract (CC BY 4.0)",
      count: places.length,
      places,
    }),
  );
  console.log(`[etl] wrote ${places.length} gazetteer places (dedup ${rows.length} → ${places.length})`);
}
