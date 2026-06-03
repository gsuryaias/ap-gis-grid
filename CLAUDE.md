# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

**AP-TRANSCO Grid Atlas** — a static, client-side GIS + MIS lookup for the AP-TRANSCO
transmission network (400 / 220 / 132 kV lines and substations), plus optional lazy overlays: a
**generation-plant overlay** (energy-mix classified) and a **power-grid overlay** (POWERGRID/PGCIL
765/400 kV inter-state grid + railway-traction & bulk-load HT substations). No backend, no database,
no API keys. Source data is ESRI shapefiles (core transmission SS + lines, and the power-grid layers)
plus a Google-Earth KML (generation plants) and a GeoNames AP place extract (search-box gazetteer);
a build-time ETL turns it into clean static assets the browser loads. Deploys to GitHub Pages (project site, base `/ap-gis-grid/`).

## Commands

```bash
npm run dev          # Vite dev server → http://localhost:5173/ap-gis-grid/
npm run build:data   # ETL: data/raw/gridmap/*.shp + generation.kml → public/data/*.{geojson,json}
npm run build        # tsc --noEmit && vite build  (production)
npm run preview       # serve dist/ (use this to verify prod; dev HMR can be flaky for map state)
npm test             # Vitest: ETL helper unit tests + emitted-data integrity checks
npm run typecheck    # tsc --noEmit
```

After ANY ETL or component change, run `npm run typecheck` (strict, `noUnusedLocals`).

## Architecture

```
data/raw/Transco.kml       ─┐
data/raw/generation.kml    ─┤
data/raw/gridmap/*.shp+dbf ─┤
data/raw/geonames-ap.tsv   ─┴(ETL)─▶ public/data/*.{geojson,json} ─▶ React + MapLibre app ─▶ GitHub Pages
```

`build:data` reads the shapefiles via the `shapefile` dep (build-time only). All source layers are
WGS84 (EPSG:4326) — no reprojection.

| Layer | Path | Notes |
|-------|------|-------|
| ETL | `scripts/build-data.mts` + `scripts/etl-lib.ts` | pure helpers in etl-lib (unit-tested); orchestration in build-data.mts |
| Data | `src/data/` | `types.ts` (canonical types), `load.ts` (fetch via `import.meta.env.BASE_URL`), `selectors.ts` |
| State | `src/state/store.ts` (Zustand) + `src/url/` | versioned URL-hash sync, selection history (`back()`) |
| Map | `src/map/` | `MapView.tsx`, `layers.ts` (paint), `basemaps.ts` (CARTO light/dark vector + Esri satellite raster), `measure.ts` (distance/area tool) |
| UI | `src/components/` | SearchBar, DetailPanel, DataTableSheet, SummaryView, DataQualityView, ControlPanel, MeasureControl |
| Theme | `src/theme/palette.ts` + `src/index.css` | voltage palette (Okabe-Ito, CVD-safe) as both JS + CSS tokens |
| Geo | `src/lib/geo.ts` | pure geodesic helpers (haversine length, spherical-excess area) for the measure tool — unit-tested like etl-lib |

The emitted `public/data/*` files are **committed** so CI/Pages builds don't need the KML.

## Generation overlay (lazy-loaded)

A second, optional layer of **generation plants** classified by energy mix. It is **lazy** by design —
none of its code path runs until the user enables it.

- **Source / ETL**: `data/raw/generation.kml` → `buildGeneration()` in `build-data.mts` → `public/data/generation.geojson`.
  Energy class comes from the KML `SS Type` cell via `classifyEnergy()` (canonical
  `Solar | Wind | Thermal | Gas | Hydro | Other`; source spells hydro "Hydal", `<Null>` → `Other`).
  IDs are synthetic `g-<slug(name)>`. Validation gate: **57 plants**. Counts (current data):
  Solar 21, Thermal 11, Wind 10, Gas 9, Hydro 5, Other 1.
- **Lazy contract**: `loadGridData()` does NOT fetch `generation.geojson`. The store action
  `toggleGeneration()` fetches it via `loadGeneration()` on first enable, caches it
  (`genStatus: idle→loading→ready`), and `applyHash` re-triggers it for a `gen=1` deep link. The map
  source/layers are added by `addGenerationLayers()` only once data arrives (re-added after a basemap
  style reload, same as the grid layers). Plants are NOT in the initial search index or the data table.
- **Not in `data.byId`**: plants live in a separate `generation.byId` (store). `DetailPanel` and
  `MapView` resolve a selection across both maps. Plant `voltage` reuses the grid voltage palette;
  `energy` drives `ENERGY_COLOR` / the legend. There is **no capacity (MW) data** in the KML
  (`capacityMw` is always null) and **no grid connectivity** is modelled for plants.

## Power-grid overlay (lazy-loaded)

A third, optional layer **group** sourced from ESRI shapefiles (`data/raw/gridmap/`, copied — Towers
and admin-boundary layers excluded). Like the generation overlay it is **lazy**: nothing runs until the
user enables it. It bundles **three classes** behind one master toggle, each with its own sub-toggle
(mirrors the generation per-energy-type sub-toggles):

- **POWERGRID (PGCIL)** — the national inter-state grid: `powergrid-lines.geojson` (**54** lines,
  765/400 kV — note voltages OUTSIDE the 400/220/132 grid palette) + `powergrid-ss.geojson` (**28** SS).
  Line route length is computed geodesically from geometry (`haversineMeters` sum) — the shapefile has
  no km field. IDs `pl-<seq>` / `ps-<slug>`.
- **Railway traction SS** — `railway-ss.geojson` (**62** RTSS points). IDs `rs-<slug>`.
- **Bulk-load / HT SS** — `bulkload-ss.geojson` (**139** private/industrial HT-consumer points). IDs `bs-<slug>`.

- **Source / ETL**: `buildPowerGrid()` in `build-data.mts` reads all four shapefiles, filters nothing
  (these layers are already curated), and emits the four geojson. Pure helpers (`cleanPgName`,
  `normalizeKv`, `parseMva`) live in `etl-lib.ts`. Voltage is a **`number`** (765 supported); a few
  source rows have unparseable voltage → `0` (UI shows "—"). Validation gate: build fails on 0 features.
- **Lazy contract**: `loadGridData()` does NOT fetch these. `togglePowerGrid()` fetches all four files
  via `loadPowerGrid()` (one `Promise.all`) on first enable, caches them (`pgStatus`), and `applyHash`
  re-triggers for a `pg=1` deep link. Per-class visibility is `filters.pgClasses` (NOT in the URL hash —
  only the single `pg=1` key, like generation's `genTypes`). Layers added by `addPowerGridLayers()`,
  re-added on `styledata`.
- **Not in `data.byId`**: all classes live in a shared `powergrid.byId` (store) with kinds
  `pg-line | pg-substation | rail-substation | bulk-substation`. Distinct overlay colours (NOT the
  voltage palette): POWERGRID rose `#e11d48`, Railway violet `#7c3aed`, Bulk-load teal `#0d9488`.
  Voltage shown as plain text (NOT `VoltageBadge`, which only types 400/220/132). No grid connectivity
  is modelled (the `connectedSs` string is indicative only).

## Measurement tool

A client-side **distance / area** measure tool (top-centre `MeasureControl` pill). All geodesy is in
`src/lib/geo.ts` (haversine length, spherical-excess area — no Turf/deps), unit-tested in `geo.test.ts`.

- **Controller**: `src/map/measure.ts` (`MeasureController`) owns a dedicated `src-measure` GeoJSON
  source + overlay layers (magenta — outside every other palette) and all click/move/dbl-click/keyboard
  handling. One instance per map, created in `MapView`; `setMode(mode|null)` toggles it. `ensureLayers`
  is idempotent and **re-run on `styledata`** like the grid/generation layers (setStyle drops them).
- Click adds vertices, a dashed rubber-band tracks the cursor, **double-click / Enter** finishes,
  **Esc** clears (or exits if empty), **Backspace** undoes. Live readout published to the store
  (`measureMode` / `measureStats` — **transient, never in the URL hash**).
- While a mode is active, `MapView`'s feature hover/select handlers early-return (`clickSuppressed()`,
  which is true for **either** the measure tool or the nearest-SS tool) and `doubleClickZoom` is
  disabled, so clicks place points instead of selecting features / zooming.

## Lookup utilities (export · regional slice · nearest substation)

Three client-side conveniences for the MIS/lookup workflow — all pure-data + existing patterns, no new
deps, no backend.

- **Export & reporting** — `src/lib/export.ts` (pure CSV + GeoJSON builders, RFC-4180 escaping;
  unit-tested in `export.test.ts`). The `DataTableSheet` header has **CSV** + **GeoJSON** buttons that
  export the *currently-shown* rows of the active tab (respecting the text filter); `DetailPanel` has a
  per-feature **GeoJSON** download (substation Point / line geometry from `linesFc`). `downloadText()`
  is the only impure helper (Blob + anchor; no-op outside a browser, so the builders stay testable).
- **Regional slice by circle** — `filters.circle: string | null` (in `FilterState`). The `ControlPanel`
  **Region → Circle** `<select>` (13 canonical circles from `meta.circles`) filters the **core** lines +
  substations (`applyFilters` ANDs `["==",["get","circle"],…]`) and `MapView.fitToCircle` zooms to the
  circle's SS bounds (back to `meta.bounds` when cleared). Deep-linkable: hash key **`circle`**.
  **Circle-only** because `zone`/`division` exist on substations but are **absent on all lines** — circle
  is the one admin field both layers carry. Overlays are not sliced (PGCIL has no circle).
- **Nearest substation / locate-me** — `NearbyControl` pill (beside Measure): **Locate me** (browser
  geolocation) or **Pick point** (map click) sets the transient `nearbyOrigin` (`{lng,lat,label,fly}`);
  `nearbyMode` gates the pick. `NearbyPanel` lists the **6 nearest** SS by `haversineMeters`, with a
  compass bearing (`bearingDeg`/`compass8` in `geo.ts`), respecting the active voltage + circle filters.
  An azure **`.nearby-dot`** MapLibre marker (DOM overlay → survives style reloads) marks the origin.
  Mutually exclusive with the measure tool. All nearby state is **transient (never in the hash)**.

## Place search (AP gazetteer, lazy-loaded)

The search box also matches **~33.5k Andhra-Pradesh place names** (villages/towns/cities, districts,
mandals, rivers/reservoirs, hills, railway stations, temples, forests…) from a committed **GeoNames
extract** (`data/raw/geonames-ap.tsv` — the `IN` dump filtered to admin1 = `02`, roads excluded;
**CC BY 4.0**, credited in the App footer).

- **ETL**: `buildPlaces()` in `build-data.mts`; pure helpers `parsePlacesTsv` / `placeType` /
  `dedupePlaces` in `etl-lib.ts` (unit-tested). Near-duplicates (same name + feature class within
  10 km) collapse to the most populous row (33,497 from 34,649); district names come from the
  extract's own ADM2 rows (covers both the 13- and 26-district vintages GeoNames mixes); the
  town/village split is by population (the source has no such distinction — Vijayawada is a plain
  `PPL`). Emits `public/data/places.json` as compact tuples `[name, type, district, lng, lat, pop]`
  (~2 MB raw / ~450 KB gz). Validation gate: > 25k rows.
- **Lazy contract**: fetched by the store's `ensurePlaces()` on first **focus** of the search box
  (`placesStatus`; a failed fetch resets to `idle` so the next focus retries). Never part of the
  initial payload.
- **Search-only — places are NOT map features**: no layer, no `byId`, no selection, no hash key.
  `SearchBar` appends up to 8 gazetteer hits under a "Places" divider (grid assets always rank
  first; rank ties break by population so Tirupati-the-city beats its namesake villages, and
  same-name villages disambiguate by district). Choosing one calls `setNearbyOrigin` with a
  type-based zoom (state 7 / district 9 / mandal 11 / city 12 / default 13) — `MapView`'s
  `NearbyOrigin.zoom` branch **flies** there (may zoom OUT, unlike the GPS `easeTo`), drops the
  azure nearby-dot and opens the nearest-substations panel. All transient, like the nearby tool.

## Derived analytics (indicative capacity · asset age)

Two **client-side, derived** read-outs computed live from data already on each line — no ETL change,
no new data, no graph. Both are **purely presentational** (computed in the component / pure lib, not
emitted to geojson) and clearly labelled **indicative**, mirroring the "inferred connectivity"
honesty convention.

- **Indicative thermal capacity** — `src/lib/capacity.ts` (pure, unit-tested in `capacity.test.ts`).
  The source has **no MVA/rating data**, so capacity is inferred from `conductor`: a lookup
  `CONDUCTOR_AMPACITY` (nominal continuous Amps per sub-conductor for the standard Indian ACSR codes
  — Panther 480, Zebra 735, Moose 800, …) × a bundle factor (Twin ×2 / Quad ×4) → `conductorRating()`;
  then `lineCapacity()` = **√3 · kV · A / 1000** per circuit, × circuit count (DC ×2). `conductorRating`
  folds the source's conductor-name typos ("Zeebra"→Zebra, "Panter"→Panther) → **1181/1190 lines
  rated (~99%)**; the rest (bare "UG Cable", "AL59" alloy) return null → UI shows nothing. `DetailPanel`
  shows it per line (≈ 610 MVA, with a per-circuit split for DC) + an honesty footnote; `SummaryView`
  shows the network total (≈ 560 GVA) with coverage. **Indicative only** — not a load-flow result;
  real ratings depend on ambient/conductor temperature, sag and bundle geometry.
- **Asset age** — `commissionYear()` / `ageYears()` / `formatAge()` in `src/lib/format.ts`
  (unit-tested in `format.test.ts`). Parses the year from the `commissioned` "Mon YYYY" string and
  derives age vs. `new Date().getFullYear()` (kept pure by passing the reference year in).
  `DetailPanel` appends "· 9 yrs" to the Commissioned field. (A dedicated age choropleth / filter is a
  natural follow-up.)

> **Next analytics milestone (deferred — needs the connectivity graph):** topological criticality &
> **N-1 islanding** screening (betweenness, articulation points, "remove this line → who is islanded").
> Build it on the `graph.ts` from the *Trace the Grid* feature (`SESSION-PLAN.md`); the data already
> shows the payoff — **24 single-fed and 109 double-fed substations**.

## Data decisions (core network now sourced from the Gridmap ESRI shapefiles)

The core transmission substations + lines were **migrated off `Transco.kml`** onto the authoritative
Gridmap shapefiles (`data/raw/gridmap/aptransco-ss.*` + `lines-{400,220,132}kv.*`). `Transco.kml` is
left in the repo but is **no longer a source** (generation still uses `generation.kml`). Decisions:

- **Shapefile fields are authoritative** for voltage and circuit — `voltage` (with the source's
  `"200"`→**220 kV** typo normalised) and `circuit_ty` (`SC`/`DC`/`DC-SC`→`circuit`, raw kept in
  `circuitType`). The old folder-path/name parsing and the `circuitAmbiguous`/`voltageMismatch` review
  flags are retired (set `false`; there's no folder-vs-name conflict to flag anymore).
- **Substations are TRANSCO-only (376)** from `APTransco SS` (Polygon/MultiPolygon → marker = ring
  centroid). Non-TRANSCO endpoints are **not** core markers (they'd double-draw the overlays); instead
  a line records them as display-only `externalEndpoints: {name, category}` (Generation/Railway/
  PowerGrid/HT), snapped ≤ 500 m to the union of those facility layers.
- **IDs are synthetic** (`s-<slug(sap_ss_id)>`, synth `s-<slug(name)>-<v>` for the 51 ID-less SS;
  `l-<seq>`), never bare names. Deep-link hash + selection key on these IDs.
- **Adjacency is geometric, against the SS POLYGON** (not the centroid): an endpoint is matched if it
  falls inside the compound (0 m — **80% of endpoints do**) or within ≤ 1000 m of the polygon edge
  (catches lines drawn slightly short). Helpers `pointInPolygons` / `distancePointToPolygons`.
- **Connectivity counts non-TRANSCO endpoints too.** ~71% of lines link TRANSCO-to-TRANSCO, but an end
  that lands at a non-TRANSCO facility (Generation / Railway-traction / PowerGrid / HT-consumer — from
  the same Gridmap layers) is a real connection, captured as `externalEndpoints` and snapped the same
  way. Counting both, **~95% of lines connect at both ends** (`pctBothEndsResolved`); only ~5% have an
  end beyond 1 km of anything. Connections shown as **inferred**, never authoritative.
- **Circuit-km** = `lengthKm` (`line_lengt`) × per-circuit multiplier (SC ×1; DC / DC-SC / MC ×2).
- **Lines are per-circuit (~1190 features)** — `Ckt-1`/`Ckt-2` are separate rows. **"(P)" in a line
  name is NOT "proposed"** — it's a naming token (616/686 such lines have real past commissioning
  dates), so there is no proposed-filter. New per-line fields: `conductor`, `commissioned` ("Mon YYYY",
  1899 sentinel → null), `circuitType`, `zone`, `division`.

## Data quirks / what's NOT in the source

- **`circle` is normalised to the 13 canonical AP-TRANSCO circles** via `canonicalizeCircle()` (keeps
  the primary token of composites like "Anantapur, Kadapa", folds spelling variants
  "Thirupathi"/"Tirupati", "Ananthapur"/"Anantapur", "Srikalulam"/"Srikakulam"; drops cross-state
  second tokens). The SS layer's own `circle` is an opaque numeric code, so each **substation's circle
  is derived from the majority circle of its connected lines** (and a circle-less line inherits from a
  connected SS) — one clean namespace for the Summary. `zone` (3) / `division` are the authoritative
  source groupings.
- **MVA / transformer-capacity** exists for the overlays (railway/bulk-load `cmd_in_mva`) but the core
  `APTransco SS` layer has no commissioning date (`doc` is null) and no per-SS capacity.
- Counts (validation gate, lower-bound asserts): **376 substations, ~1190 lines** (0 dropped in current
  data). The old fixed 499/715 KML gate is retired.

## Gotchas / conventions

- **Never install to global space** — all deps are project-local (`npm install`, `npx`/`tsx`).
- **MapLibre + Tailwind v4 CSS layering**: MapLibre's unlayered `.maplibregl-map { position: relative }`
  beats Tailwind's layered `.absolute`. Size the map container with `h-full w-full`, NOT `absolute inset-0`.
- **MapLibre paint expressions**: `["zoom"]` must be the TOP-LEVEL input of `interpolate`/`step`.
  To scale by feature-state, fold the factor into each interpolate stop output (see `layers.ts`
  `zoomInterp`), don't wrap the interpolate in `["*", …]`.
- Pin **maplibre-gl `^5`** (v6 is WebGL2/ESM-only breaking), **Tailwind v4** (class-based dark via
  `@custom-variant dark` in `index.css`), latest **@tanstack/react-table v8**.
- **Tailwind v4 toggle switches**: don't position a thumb with arbitrary `translate-x-[…]` — v4 maps
  it to the `translate` CSS prop and it collided with `left`. Use an inline `style={{transform}}`
  (see `ControlPanel.tsx` `Switch`).
- **Basemaps**: light/dark are CARTO vector style URLs; **satellite is an inline raster style object**
  (Esri World Imagery) that must include a `glyphs` URL (we reuse CARTO's) or the substation label
  symbol layer fails. Label font is `Open Sans Bold` (served by CARTO's glyph CDN). Satellite + dark
  both apply the `.dark` UI class.
- **Satellite deep zoom**: map `maxZoom` is **19**, but the Esri source is capped at `maxzoom: 18`
  so MapLibre **overzooms** (upscales) the z18 tile for z18→19. Esri serves a *"Map data not yet
  available"* placeholder (a 200, not a 404 — so no auto-fallback) for missing deep tiles; z18 has
  broad coverage over AP land while z19 is patchy/rural-absent. Don't raise the source `maxzoom` back
  to 19 — rural substations would show the placeholder instead of (slightly soft) real imagery.
- **Verify on `npm run preview`, not dev** — HMR can desync map/store state while editing.

## Updating the network data

Replace the relevant `data/raw/gridmap/*.{shp,dbf,shx,prj,cpg}` layers — `aptransco-ss` +
`lines-{400,220,132}kv` (core network), `powergrid-*` / `railway-ss` / `bulkload-ss` / `generation-ss`
(overlays + external-endpoint snapping) — and/or `data/raw/generation.kml` (generation overlay),
and/or `data/raw/geonames-ap.tsv` (place-search gazetteer; regenerate from the GeoNames `IN` dump:
filter admin1 = `02`, drop fclass `R`, keep cols geonameid/asciiname/lat/lng/fclass/fcode/admin2/population) →
`npm run build:data` → review `public/data/data-quality.json` → commit + push (the GitHub Action
re-runs ETL + tests + build and redeploys). All sources are processed by the one `build:data` run. The
shapefile parser is the `shapefile` dev-dep (build-time only); keep the `gridmap/` raw files committed
so CI can regenerate. `Transco.kml` is retained for reference but unused.

## Deploy

`.github/workflows/deploy.yml` publishes `dist/` to Pages on push to `main`. Vite `base` is
`/ap-gis-grid/` (override via `BASE_PATH` env — `/` for a user/org site, `/<repo>/` if renamed).
Repo: Settings → Pages → Source = GitHub Actions.

## Where non-repo artifacts live

Memory, plans, and transcripts are stored globally under `~/.claude/` (keyed by this project's
path), not in the repo — intentionally, so they aren't committed.
