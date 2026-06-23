# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**AP-TRANSCO Grid Atlas** — a static, client-side GIS + MIS lookup for the AP-TRANSCO
transmission network (400 / 220 / 132 kV lines and substations), plus optional lazy overlays: a
**generation-plant overlay** (energy-mix classified) and a **power-grid overlay** (POWERGRID/PGCIL
765/400 kV inter-state grid + railway-traction & bulk-load HT substations). No backend, no database,
no API keys. Source data is ESRI shapefiles (core transmission SS + lines, and the power-grid layers)
plus a Google-Earth KML (generation plants) and a GeoNames AP place extract (search-box gazetteer);
a build-time ETL turns it into clean static assets the browser loads. Deploys to GitHub Pages (project site, base `/ap-gis-grid/`).

The reference map is the **Atlas** workspace. On top of it sits a **decision-support (DSS) shell** with
one more workspace — **Risk Room** — a lazy-loaded chunk sharing one embedded map. Everything the app
renders is pure static assets, so there is no backend at request time.

> **Removed workspaces (2026-06):** the **Planning Studio** and **MIS** workspaces were removed from the
> app and preserved on the `archive/planning-studio` and `archive/mis-workspace` branches (cut from
> `main` before removal). `WorkspaceId` is now `atlas | risk`. The **MIS data pipelines** (`pipelines/`,
> the `data` branch, the freshness manifests) and the pure analytics libs (`dcflow.ts`, `dlr.ts`) are
> **still in the repo** — they no longer have an in-app consumer (the MIS dashboards that read the
> parquet, and the Planning Studio that drove `dcflow`, are gone). The pipelines section below is
> retained for reference; if you don't intend to revive MIS, the `pipelines.yml` CI job and the `data`
> branch can be disabled separately (out of scope of the removal).

## Commands

```bash
npm run dev          # Vite dev server → http://localhost:5173/ap-gis-grid/
npm run build:data   # ETL: data/raw/{gridmap/*.shp, generation.kml, geonames-ap.tsv, coastline-ap.geojson} → public/data/*
npm run build        # tsc --noEmit && vite build  (production)
npm run preview      # serve dist/ (use this to verify prod; dev HMR can be flaky for map state)
npm test             # Vitest run: ETL + lib + pipeline-parser unit tests + emitted-data integrity checks
npm run typecheck    # tsc --noEmit

# MIS data pipelines (run in CI; see "MIS data pipelines" below). Each needs the cert bundle, so
# invoke via the npm script (it sets NODE_EXTRA_CA_CERTS) rather than calling tsx directly.
npm run pipelines              # all five in sequence
npm run pipeline:psp           # NLDC daily PSP (.xls)         → data branch parquet
npm run pipeline:psp-frequency # NLDC frequency / FVI compliance
npm run pipeline:vidyut        # Vidyut Pravah AP daily (HTML)
npm run pipeline:vidyut-blocks # Vidyut Pravah AP 15-min block (HTML)
npm run pipeline:cea           # CEA monthly generation mix (JSON)
```

Run a single test file with `npx vitest run src/lib/graph.test.ts` (add `-t "<name>"` to filter by
test name). After ANY ETL or component change, run `npm run typecheck` (strict, `noUnusedLocals`).
**There is no ESLint/Prettier step** — the only quality gates are `npm run typecheck` (strict;
`noUnusedLocals` + `noUnusedParameters`, so unused imports/params *fail* the build) and `npm test`.

## Architecture

```
data/raw/{generation.kml, gridmap/*.shp+dbf,    ─(build:data ETL)─▶ public/data/*.{geojson,json}  ─┐
          geonames-ap.tsv, coastline-ap.geojson}    [committed]                                     ├▶ React + MapLibre + DSS shell ─▶ GitHub Pages
NLDC / Vidyut Pravah / CEA (live public sources) ─(pipelines, CI)─▶ `data` branch /timeseries/*.parquet ─┘  (manifests/*.json read over HTTP)
```

> **No in-app parquet reader since the MIS removal.** The app fetches only the data-branch
> `manifests/*.json` at runtime (`manifests.ts` → `FreshnessBadge`/`MethodCard`/Risk Room — freshness
> only); nothing reads the `timeseries/*.parquet` anymore. Consequently `@duckdb/duckdb-wasm` and
> `echarts` are now **dependencies with no importer in `src`** (they powered the removed MIS dashboards)
> — leave them unless you're deliberately pruning, but don't reach for them expecting a live consumer.

`build:data` reads the shapefiles via the `shapefile` dep (build-time only). All source layers are
WGS84 (EPSG:4326) — no reprojection. `Transco.kml` is retained for reference but is **no longer a source**.

| Layer | Path | Notes |
|-------|------|-------|
| ETL | `scripts/build-data.mts` + `scripts/etl-lib.ts` | pure helpers in etl-lib (unit-tested); orchestration in build-data.mts |
| Pipelines | `pipelines/*.mts` + `pipelines/*-parse.ts` + `pipelines/lib.ts` | live MIS ETL → `data` branch parquet (see "MIS data pipelines") |
| Data | `src/data/` | `types.ts` (canonical types), `load.ts` (fetch via `import.meta.env.BASE_URL`), `selectors.ts`, `graph-data.ts` (memoised topology), `manifests.ts` (dataset freshness), `weather.ts` |
| State | `src/state/store.ts` (Zustand) + `src/url/` | versioned URL-hash sync (`VERSION=1`), selection history (`back()`), workspace + workspaceContext |
| Map | `src/map/` | `MapView.tsx` (Atlas full-screen) / `MapPane.tsx` (shared embeddable wrapper), `layers.ts` (paint), `layer-presets.ts` (per-workspace overlay defaults), `basemaps.ts`, `measure.ts`, `weather-layers.ts`, `risk-layers.ts`, `map-helpers.ts` (shared map utils) |
| Shell / UI | `src/App.tsx` + `src/components/` | workspace switcher + map/panel layout; `BrandHeader`, `WorkspaceChrome`, `MapLayerPanel`, `FreshnessBadge`, SearchBar, DetailPanel, DataTableSheet, Summary/DataQuality/Weather views, ControlPanel, Measure/Nearby controls |
| Workspaces | `src/workspaces/<id>/` + `registry.ts` | `atlas` (inline) / `risk` (lazy chunk). Planning + MIS removed — see "Workspaces (DSS shell)" |
| Analytics libs | `src/lib/` | pure, unit-tested: `geo.ts`, `capacity.ts`, `dlr.ts`, `graph.ts`, `dcflow.ts`, `risk.ts`, `risk-engine.ts`, `format.ts`, `export.ts` |
| Theme | `src/theme/palette.ts` + `src/index.css` | voltage palette (Okabe-Ito, CVD-safe) as both JS + CSS tokens |

The emitted `public/data/*` files are **committed** so CI/Pages builds don't need the raw sources. The
`data`-branch parquet is **not** committed to `main` — it is published by the pipelines and fetched at runtime.

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

## Live-weather overlay + Weather monitor (lazy, real-time)

The one feature that talks to **external live APIs** (everything else is static assets). All sources
are free, keyless and CORS-enabled, so the static site calls them directly — still no backend:

- **Open-Meteo forecast API** — current conditions + 3-day outlook at the **13 circle centroids**
  (computed at runtime by `circlePoints()` from loaded substations — no ETL change, one batched call).
- **Open-Meteo marine API** — wave/swell at 6 fixed offshore points (`AP_COAST_POINTS`).
- **RainViewer** — composite rain-radar raster tiles. Free tier: **past frames only, zoom ≤ 7**
  (the source is capped `maxzoom: 7`, MapLibre overzooms beyond), Universal-Blue colour scheme,
  attribution required (on the raster source + App footer).
- **GDACS (UN/EC JRC)** — tropical-cyclone events (`geteventlist/SEARCH?eventlist=TC`, filtered to
  `iscurrent` + the NIO basin via `cycloneInBasin`) + per-event `getgeometry` (Class-tagged: kept
  classes are `Line_*` track, `Poly_Cones`, `Poly_Green/Orange/Red` swaths, `Point_Centroid`).

Layout: pure helpers in `src/lib/weather.ts` (+ `pointInRing`/`pointInPolygonGeom` in `geo.ts`) —
unit-tested; fetch clients in `src/data/weather.ts` (`loadWeather()` = one `Promise.allSettled`,
**per-source degradation**: failures land in `sourceErrors`, only all-four-down rejects); map layers
in `src/map/weather-layers.ts`; dashboard in `src/components/WeatherView.tsx`.

- **Lazy contract**: same as generation/powergrid — nothing fetches until the ControlPanel "Live
  weather" toggle OR the BrandHeader "Weather" dashboard opens (`toggleWeather` /
  `toggleWeatherView` → `refreshWeather`; `wxStatus` mirrors `genStatus`). Hash key **`wx=1`**
  (master only; `wxLayers` radar/cyclone sub-toggles are NOT in the hash, like `genTypes`). A wx=1
  deep link arrives before grid data, so `init()` re-triggers the fetch once circle points exist.
- **Auto-refresh**: one module-level 10-min `setInterval`, alive only while the overlay or dashboard
  is in use (`syncWeatherTimer`); refreshes keep stale data on screen and only error when empty.
  `weather`/`wxStatus` are otherwise transient — never persisted.
- **Map layers** (`addWeatherLayers`, idempotent, re-run on `styledata`): radar raster + cyclone
  fills inserted **beneath `grid-lines-casing`** so the grid stays legible; track/positions/cone
  outline on top. Radar frame swap uses `RasterTileSource.setTiles` (URL memoised per map in a
  WeakMap). Substations inside a forecast cone get an amber halo — a separate `wx-risk-substations`
  circle layer on the core SS source with an id `in`-filter (NOT feature-state). Visibility is
  gated by `applyWeatherVisibility(map, filters)` — called by MapView alongside `applyFilters`.
- **Weather monitor** (`WeatherView`, `weatherOpen` like `summaryOpen`, not in hash): cyclone alert
  cards (GDACS level colours + "N substations inside the forecast envelope" via `assetsInCone`),
  13-circle conditions grid, coastal sea state, 3-day outlook table, last-updated + manual refresh.
- **DetailPanel** shows a "Weather now" line for a selected substation **only while the overlay is
  on** (`loadSpotWeather`, deduped per ~1 km cell in a module cache).
- Palette: cyclone swaths use GDACS's semantic green/orange/red (`WX_ALERT_COLOR`), track is
  rose-900 `WX_TRACK_COLOR`, risk halo amber `WX_RISK_COLOR` — all outside the voltage palette.
  Everything is labelled **indicative** (model output, not IMD advisories) per the honesty convention.

## Measurement tool

A client-side **distance / area** measure tool (top-centre `MeasureControl` pill). All geodesy is in
`src/lib/geo.ts` (haversine length, spherical-excess area — no Turf/deps), unit-tested in `geo.test.ts`.

- **Controller**: `src/map/measure.ts` (`MeasureController`) owns a dedicated `src-measure` GeoJSON
  source + overlay layers (magenta — outside every other palette) and all click/move/dbl-click/keyboard
  handling. One instance per map, created in `MapPane` (full/Atlas mode only) **once the map's `load`
  has fired** — creation is gated on a `mapReady` state so the effect re-runs after the async load
  (a ref alone can't, which is what silently left the tool dead on a fresh Atlas load); `setMode(mode|null)`
  toggles it. `ensureLayers` is idempotent and **re-run on `styledata`** like the grid/generation layers
  (setStyle drops them).
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

## Connectivity graph + power-flow + risk (pure analytics libs)

The topological criticality / N-1 islanding work that earlier docs flagged as *deferred* is now built.
All of it is **pure, side-effect-free, unit-tested** (node env) and **indicative only** — it runs on the
inferred geometric connectivity, hand-digitised wind zones and assumed impedances, never authoritative
ratings or a real load-flow. `graph.ts`/`risk-engine.ts`/`risk.ts` drive the Risk Room; `dcflow.ts` and
`dlr.ts` were the analytical foundation of the removed Planning Studio and currently have no in-app
consumer (kept, tested, importable — see the intro note).

- **`src/lib/graph.ts`** — a multigraph over substation ids (parallel circuits are distinct edges, since
  N-1 line loss ≠ corridor loss). `buildGridGraph(substations, lines)`, then `connectedComponents()`,
  `feedDegree(ssId)` (distinct neighbours, not edge count), `singleFedSubstations()`, `bridgeLines()` +
  `articulationSubstations()` (one Tarjan low-link DFS), `lineOutageImpact(lineId)` (N-1: who is islanded
  when a bridge is out), `neighborhood(ssId, hops)` (k-hop ego net for the map spotlight).
- **`src/data/graph-data.ts`** — `graphAnalysis(data)` memoises the above per `GridData` instance
  (WeakMap) → `{graph, bridgeImpacts, articulationIds, singleFedIds, feedDegrees}`; `spotlightFor(...)`
  returns the SS/line ids to highlight for a selection.
- **`src/lib/dcflow.ts`** — indicative **DC load-flow** (B′θ, flat 1.0 pu, lossless, no reactive power)
  over the largest connected component. Per-voltage series reactance (`DEFAULT_OHM_PER_KM` 400/220/132),
  `DEFAULT_ASSUMED_LENGTH_KM = 30` for missing length, `DEFAULT_BASE_MVA = 100`, slack = highest-degree
  400 kV SS. `buildDcNetwork` → `solveDcFlow` (dense Gaussian elimination, n≈376) → `lineUtilisation`
  (flow vs. the `capacity.ts` thermal rating) + `n1Screen` (per-line outage → newly-overloaded survivors
  + islanded SS).
- **`src/lib/dlr.ts`** — **dynamic line rating**: ambient-temperature derating of the `capacity.ts`
  nominal ampacity, `I(Ta)/I(Tref) = √((Tcond − Ta)/(Tcond − Tref))` (Tcond 75 °C, Tref 40 °C, cool-weather
  uprate capped 1.15 — no wind/solar data). `deratingFactor` / `deratedCapacityMva` / `formatDerating`.
- **`src/lib/risk.ts`** — single-axis **vulnerability** index `substationRisk()` (coastal band, redundancy
  via feed degree, age, voltage → 0–100 + factor list) + `riskTier()`.
- **`src/lib/risk-engine.ts`** — three-axis DSS model: `hazardScore` (wind zone + coastal + active cyclone
  cone), `criticalityScore` (voltage + hub size + redundancy), `compositeRisk` (weighted geometric mean,
  hazard^0.4 · vulnerability^0.4 · criticality^0.2, each axis floored at 5 so none vetoes), and
  `windZoneAt(lng, lat, zones)` over the IS 875 wind-zone polygons (`public/data/wind-zones.geojson`).

## Workspaces (DSS shell)

The app is a **multi-workspace shell** (`src/App.tsx` + `src/workspaces/registry.ts`). `WorkspaceId` =
`atlas | risk` (Planning Studio + MIS were removed — see the intro note). Adding a workspace = one folder
under `src/workspaces/<id>/` + one entry in `registry.ts` (the shell handles switcher + routing + overlay
pre-fetch); the shell is workspace-agnostic, so a registry entry is all it takes to add/remove a tab.

- **Code-split**: `atlas` is the inline default (never split out); `risk` declares a
  `load: () => import(...)` and mounts lazily in a `<Suspense>` boundary. Each declares `requiredManifests`
  the shell can gate/badge on (both are now `[]`).
- **Map embedding**: `MapPane` renders the shared map in `full` (Atlas), `embedded` (split layout) or
  `hidden` (collapsed) modes; the collapse is `mapLayout` (`open|collapsed|atlas-only`). The split is
  **drag-resizable** — `App`'s `PaneSplitter` sets the map-column width (persisted to localStorage under
  `dss-map-pane-w`, clamped to `[320, innerWidth−380]`), and a `ResizeObserver` in `MapPane` redraws the
  canvas on any container size change. `WORKSPACE_LAYER_PRESETS[ws]` (in `map/layer-presets.ts`) declares
  which overlays each workspace expects; `App` auto-toggles them on switch (visibility stays
  user-controlled via `MapLayerPanel`).
- **`workspaceContext`** (store) carries cross-workspace focus that *is* hash-synced: `scenario` +
  `sort` (Risk). Transient map overlays (`riskScores`, `highlightIds`, `riskSelection`) are **never** hashed.

- **Risk Room** (`workspaces/risk/`): `model.ts` composes `graphAnalysis` + `risk-engine` + GDACS live
  cyclone cones + wind zones into per-SS `BaseRow`s, then four scenario presets (`normal|watch|severe|
  active`, each a hazard multiplier) re-rank assets by `compositeRisk`. `RiskRoom.tsx` is the **paginated,
  faceted** at-risk register (filters: name, circle, voltage chips, tier, single-fed, in-cone; sort by any
  column; row → fly-to + map halo via `risk-layers.ts` + factor breakdown); `BriefingPack.tsx` exports a
  print-ready pack. Pagination is the shared `usePager`/`PagerBar` in `components/Pager.tsx` (also used by
  the Atlas `DataTableSheet`, which carries the same voltage/circle/circuit facets + a drag-resizable
  sheet height).

## MIS data pipelines (`pipelines/`, CI-scheduled → `data` branch)

The only live-ETL part of the system. Five scheduled jobs fetch official, keyless public-sector data,
parse it, gate it, upsert into Parquet, write a manifest, and force-publish to a dedicated **`data` git
branch** (never to `main`, never triggers a Pages deploy). Since the MIS removal the parquet has **no
in-app reader** — only the `manifests/*.json` are still fetched at runtime (for the freshness badges)
over `DATA_BRANCH_BASE` (raw.githubusercontent.com of the `data` branch by default; overridable via env,
see `src/data/manifests.ts`).

| Pipeline | Source | Output (on `data` branch) |
|----------|--------|---------------------------|
| `pipeline:psp` | Grid-India / NLDC daily PSP `.xls` | `timeseries/psp-daily.parquet` (energy met/shortage/demand by entity) |
| `pipeline:psp-frequency` | same `.xls`, section B | `timeseries/psp-frequency.parquet` (FVI band compliance + net exchange) |
| `pipeline:vidyut` | vidyutpravah.in AP page (HTML) | `timeseries/vidyut-daily.parquet` (AP demand/shortage/price) |
| `pipeline:vidyut-blocks` | same page, live 15-min block | `timeseries/vidyut-blocks.parquet` |
| `pipeline:cea` | cea.nic.in generation + renewable APIs (JSON) | `timeseries/cea-monthly.parquet` (generation mix BU→MU) |

- **Layout**: pure parsers `pipelines/*-parse.ts` (xlsx for `.xls`, `node-html-parser` for HTML, JSON for
  CEA — unit-tested in `pipelines.test.ts` against committed `pipelines/fixtures/*`) + orchestration
  `pipelines/*.mts` (fetch → parse → **hard validation gates** → idempotent upsert keyed on date/entity).
  Shared helpers in `pipelines/lib.ts` (`fetchWithRetry`, IST date math, the manifest writer).
- **TLS quirk**: Grid-India and Vidyut Pravah serve **incomplete TLS chains** (missing intermediate CA),
  so the npm scripts set `NODE_EXTRA_CA_CERTS=pipelines/certs/extra-cas.pem` (Go Daddy G2 + emSign G1
  intermediates) **and** `lib.ts` loads the same bundle into an undici Agent. The `.pem` must contain
  certs only — no `#` comment lines (OpenSSL rejects them in `NODE_EXTRA_CA_CERTS`). **Always invoke via
  the npm script**, not `tsx` directly, or the fetch fails cert verification.
- **Manifests + freshness** (`src/data/manifests.ts`): each pipeline writes `manifests/<id>.json`
  (`id, schema, source, licence, attribution, cadence, vintage, lastSuccess, paths, rowCount`). The app
  binds to **manifest ids, never raw URLs**. `staleness(m, now)` → `fresh|stale|missing` (stale past
  2× cadence; `static`/`one-time` never stale) drives `FreshnessBadge`. `MANIFEST_GATES` are CI lower-bound
  row checks; `LIVE_DATA_MANIFEST_IDS = ["psp-daily","vidyut-daily"]` are what the deploy gate expects to
  already exist on the `data` branch.
- **Schedule** (`.github/workflows/pipelines.yml`, single-concurrency): daily 01:30 UTC (PSP + PSP-freq +
  Vidyut daily), `vidyut-blocks` 6×/day, `cea-monthly` on the 5th. CI restores the `data` branch into a
  worktree first (to accumulate history), force-publishes only if files changed, and opens a
  `pipeline-failure` issue on daily failure (its URL is surfaced in the manifest → the badge).

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
- **Coastal exposure** is derived at ETL time from `data/raw/coastline-ap.geojson`: each SS/line gets
  `coastalKm` (nearest-coast distance) and `coastalBand` (`0` <10 km / `1` 10–25 / `2` 25–50 / `3` >50),
  reported in `data-quality.json` and consumed by the Risk workspace + the `coast=` band filter.
- Counts (validation gate, lower-bound asserts): **376 substations, ~1190 lines** (0 dropped in current
  data). The old fixed 499/715 KML gate is retired. Places gazetteer gate is **> 25k rows**.

## Gotchas / conventions

- **Never install to global space** — all deps are project-local (`npm install`, `npx`/`tsx`).
- **`xlsx` is pinned to the SheetJS CDN tarball** (`https://cdn.sheetjs.com/xlsx-0.20.3/...tgz` in
  `package.json`), NOT the npm-registry package (which SheetJS froze/deprecated). Don't "fix" it to a
  `^x` registry range — keep the CDN URL when bumping. It's used only by the `.xls` PSP pipeline parser.
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
and/or `data/raw/coastline-ap.geojson` (coastal-exposure bands) →
`npm run build:data` → review `public/data/data-quality.json` → commit + push (the GitHub Action
re-runs ETL + tests + build and redeploys). All sources are processed by the one `build:data` run. The
shapefile parser is the `shapefile` dev-dep (build-time only); keep the `gridmap/` raw files committed
so CI can regenerate. `Transco.kml` is retained for reference but unused.

The **MIS time-series** data is NOT part of `build:data` — it is refreshed by the `pipelines/` jobs on
their own CI schedule into the `data` branch (see "MIS data pipelines"). To test a pipeline locally run
its npm script (which sets the cert bundle); it writes to a `data-branch/` worktree, not `public/data/`.

## Deploy

`.github/workflows/deploy.yml` publishes `dist/` to Pages on push to `main` (it runs `build:data` →
`npm test` → `build`). Vite `base` is `/ap-gis-grid/` (override via `BASE_PATH` env — `/` for a
user/org site, `/<repo>/` if renamed). Repo: Settings → Pages → Source = GitHub Actions. The
**`data` branch is separate** — written only by `pipelines.yml`, consumed at runtime over HTTP
(`DATA_BRANCH_BASE`), and never triggers a Pages deploy.

## Design docs

In-repo design specs live under `docs/specs/` (e.g. `2026-06-11-dss-revamp-design.md`, the rationale
for the multi-workspace DSS shell). Read the relevant spec before reworking a feature it covers.

## Where non-repo artifacts live

Memory, plans, and transcripts are stored globally under `~/.claude/` (keyed by this project's
path), not in the repo — intentionally, so they aren't committed.
