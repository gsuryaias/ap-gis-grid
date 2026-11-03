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
one more workspace — **Network MIS** — a lazy-loaded chunk sharing one embedded map. Everything the app
renders is pure static assets, so there is no backend at request time.

> **Risk Room removed, Network MIS added (2026-11):** the Risk Room workspace (`workspaces/risk/`,
> `map/risk-layers.ts`) was replaced by the **Network MIS** (`workspaces/mis/`) and preserved on the
> local `archive/risk-room` branch. `WorkspaceId` is now `atlas | mis`. `lib/risk.ts` stays (DetailPanel,
> SummaryView, WeatherView use it); `lib/risk-engine.ts` + `public/data/wind-zones.geojson` now have no
> in-app consumer (kept, tested — like `dcflow.ts`).

> **Removed workspaces (2026-06):** the **Planning Studio** and **MIS** workspaces were removed from the
> app and preserved on the `archive/planning-studio` and `archive/mis-workspace` branches (cut from
> `main` before removal). The **MIS data pipelines** (`pipelines/`,
> the `data` branch, the freshness manifests) and the pure analytics libs (`dcflow.ts`, `dlr.ts`) are
> **still in the repo** — they no longer have an in-app consumer (the MIS dashboards that read the
> parquet, and the Planning Studio that drove `dcflow`, are gone). The pipelines section below is
> retained for reference; if you don't intend to revive MIS, the `pipelines.yml` CI job and the `data`
> branch can be disabled separately (out of scope of the removal).

## Commands

```bash
npm run sync:live    # pull TRANSCO + DISCOM layers from gis.aptransco.gov.in → data/raw/live/* (India-only network!)
npm run sync:towers  # pull the ~114k transmission towers (400/220/132 kV) → data/raw/live/towers-*.json (~8 s)
npm run build:ref    # RTGS shapefile library (OneDrive, RTGS_DIR) → public/data/ref/* — run locally, commit outputs
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
> `manifests/*.json` at runtime (`manifests.ts` → `FreshnessBadge`/`MethodCard` — freshness
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
| Map | `src/map/` | `MapView.tsx` (Atlas full-screen) / `MapPane.tsx` (shared embeddable wrapper), `layers.ts` (paint), `layer-presets.ts` (per-workspace overlay defaults), `basemaps.ts`, `measure.ts`, `weather-layers.ts`, `mis-layers.ts` (MIS thematic layer), `map-helpers.ts` (shared map utils) |
| Shell / UI | `src/App.tsx` + `src/components/` | workspace switcher + map/panel layout; `BrandHeader`, `WorkspaceChrome`, `MapLayerPanel`, `FreshnessBadge`, SearchBar, DetailPanel, DataTableSheet, Summary/DataQuality/Weather views, ControlPanel, Measure/Nearby controls |
| Workspaces | `src/workspaces/<id>/` + `registry.ts` | `atlas` (inline) / `mis` (Network MIS, lazy chunk). See "Workspaces (DSS shell)" |
| Analytics libs | `src/lib/` | pure, unit-tested: `geo.ts`, `capacity.ts`, `dlr.ts`, `graph.ts`, `dcflow.ts`, `risk.ts`, `risk-engine.ts`, `format.ts`, `export.ts` |
| Theme | `src/theme/palette.ts` + `src/index.css` | voltage palette (Okabe-Ito, CVD-safe) as both JS + CSS tokens |

The emitted `public/data/*` files are **committed** so CI/Pages builds don't need the raw sources. The
`data`-branch parquet is **not** committed to `main` — it is published by the pipelines and fetched at runtime.

## Live network sync (`scripts/sync-live.mts` → `data/raw/live/`)

The core network is **no longer a frozen snapshot**: it is pulled from the **AP-TRANSCO enterprise GIS**
(ArcGIS Enterprise 11.5 REST at `https://gis.aptransco.gov.in/server/rest/services`, hosted in the AP State
Data Centre — the same server the Google-Earth KMZ `NetworkLink`s in the user's Drive point at, via
`…/MapServer/KmlServer`). We read the REST `query` endpoint (`f=geojson`, `outSR=4326`, paged by OID).

- **Layers** are declared in `scripts/live-sources.ts` (`LIVE_LAYERS`): `AP_Grid_Map/gridmapkml/MapServer`
  layers 0 (Transco SS **points**), 12/13/14 (400/220/132 kV lines), 16 (generation — has MW + unit config the
  KML lacked), 8/9 (PGCIL), 15 (railway), 10 (bulk-load); DISCOM: `SPDCL/SPDCL_Network_33KV` 5 (SS) + 0 (lines),
  `EPDCL/Substations` 0 + `EPDCL/EPDCL_33KV_LINE` 1, and **APCPDCL 33/11 kV SS from the open
  `Hosted/SUBSTATION_BOUNDERY/FeatureServer` 0** (949). **The `APCPDCL` folder and the `TRANSCO` folder are token-protected**
  (`499 Token Required`) — the sync supports `AP_GIS_TOKEN` or `AP_GIS_USERNAME`/`AP_GIS_PASSWORD`, and
  `npm run sync:live -- --discover APCPDCL` lists layers once credentials exist. Never try to bypass auth.
- **Transco layers' keys are truncated to 10 chars** (`truncateKeys`) so they match the dBASE names of the
  `data/raw/gridmap/*.shp` snapshots — the ETL's `readLayer(name)` reads live GeoJSON when present, else the
  shapefile (set `ETL_SNAPSHOT_ONLY=1` to force snapshots). Epoch-ms date fields → ISO strings.
- **Safety gates** (`gatePull`): a pull below the layer's `minCount` floor or dropping >15% vs the last good
  pull is REJECTED and the previous file kept. A 20 s preflight fails fast (exit 3) when the server is
  unreachable. Exit 2 only if every layer failed.
- **Outputs are committed** (git history = network audit trail): one feature per line, sorted by stable key
  (`keyFields`) → minimal diffs. `manifest.json` (per-layer status/count/sha/lastChangedAt) and
  `changelog.json` (newest-first runs that changed something; the first pull of a layer is a baseline, not a
  change). `build:data` folds both into `public/data/live-status.json` → the header **Live badge**, the
  **Live network sync** sheet (per-layer table + change log) and the "network data was updated — reload" toast.
- **Substation footprints**: the live SS layer is points, but adjacency wants compound polygons. Each live point
  borrows its surveyed polygon from the snapshot by SAP id (325), else the nearest same-voltage polygon ≤ 300 m
  (51), else a synthetic 150 m footprint (13 genuinely new SS). Counts in `data-quality.json → substationFootprints`.

### Updating — one manual command, India-only network
The State Data Centre firewall **drops traffic from outside India** (verified 2026-11-03: GitHub-hosted runners
time out even on the raw IP; public DNS is flaky too — 8.8.8.8 returns nothing, 1.1.1.1 resolves). So there is
**no scheduled/CI sync by design** — the owner runs, from the project folder on an Indian connection:

```bash
npm run update              # scripts/update.sh: pull main → sync:live → build:data → tests → commit → push
npm run update -- --no-push # stop before pushing
```

It requires a clean tree on `main`, exits 3 with a clear message if the GIS is unreachable, and always commits
(even "no changes", so the deployed `lastSuccess` reflects the check). The push triggers `deploy.yml` → Pages.
Badge: green "Synced · N ago" while `lastSuccess` ≤ 7 days (`STALE_AFTER_DAYS`), amber after, grey "Snapshot"
if never synced. (A self-hosted runner in India could automate this later; deliberately not set up.)

## Transmission towers (`scripts/sync-towers.mts` + `scripts/towers-lib.ts`, lazy overlay)

~114k tower points from the open `AP_Grid_Map/gridmapkml` layers 2/3/4 (400 kV 16,353 · 220 kV 44,053 ·
132 kV 53,555). Fields: tower_number, cp_sp (CP / SP / Boom / Gantry, spelling varies → `canonicalCpSp`),
tower_type ("DA+3": design type + body extension), tower_ckts_conductor ("DCT, 2C, Quad Moose"), conductor,
circuit type, commissioning date, relay-setting length, circle/zone/division/subdivision; the 132 kV layer
also has ~24 structural/insulator fields that are currently empty (the popup shows any that get filled).
- **Storage — grouped by line, not GeoJSON** (~40 MB as GeoJSON): `groupTowers` keeps each line's shared
  attributes once and one row per tower (`[lineIdx, lng, lat, …cols]`, natural tower-number order, one row
  per text line for small diffs) → `data/raw/live/towers-<kv>.json` (15 MB total, lossless vs the fields
  kept; objectid/globalid/lat-lng duplicates/`linename_sd_merge` dropped). Change detection keys on
  line + tower number (`towerKeys`/`diffTowers`); gates: per-layer floor + >15% drop rejected.
  `towers-manifest.json` = per-layer status. `npm run update` runs it after `sync:live` (non-fatal).
- **ETL** (`buildTowers` in build-data): `buildWebTowers` dictionary-encodes low-cardinality columns →
  `public/data/towers-<kv>.json` (≈ 180 / 480 / 620 KB gz), matches each tower line to a core line by
  normalised name (99.6% of towers), and folds a per-line summary into `lines.geojson` as
  `LineProps.towers` `{n, cp, sp, types}`; counts in `live-status.json → towers`.
- **UI**: overlay defs `TOWER_DEFS` (`overlays/catalog.ts`, `format: "towers"`, `aboveGrid` — drawn between
  the grid lines and the SS dots, unlike every other overlay), decoded by `overlays/towers.ts`; per-voltage
  toggles in the layer panel ("Transmission · towers"), minzoom 9 (400 kV 8), CP towers larger + ringed,
  labels (tower no.) from z14. A tower tap wins over the line beneath and opens a popup with every
  attribute + a link to the line. `components/LineTowers.tsx` (line DetailPanel + MIS line dossier): count,
  CP/SP split, top types, "Show towers on map".

## DISCOM 33 kV overlay (`scripts/etl-discom.ts`, lazy)

`buildDiscom()` → `public/data/discom-ss.geojson` (33/11 kV SS: polygon → centroid; EPDCL carries circle →
section hierarchy, feeder counts, capacity; SPDCL carries mandal/district/commissioning) +
`discom-lines.geojson` (EPDCL: one feature per 33 kV feeder with source EHT SS; **SPDCL: ~12k pole-to-pole
spans, half unnamed, grouped by (feeder, division) then split into connected components on an ~11 m endpoint
grid**, 11 kV/440 V-tagged spans dropped). Douglas–Peucker ~8 m, 5 dp, null props dropped (~680 KB gz total).
Source coverage is partial (APSPDCL lines ≈ 3,400 km) — the UI says so. IDs `ds-sp-*`/`ds-ep-*`/`ds-cp-*`, `dl-*`.

**APCPDCL 33 kV feeders (462, ≈ 8,820 km) are NOT on the open GIS** — they come from APCPDCL's own GIS export
(shapefiles kept in the private `~/Documents/arnab-cyclone-tracker/data/raw/discom/apcpdcl_gis`, where they are
marked sensitive). The owner decided (2026-11-03) to publish **routes only**: `scripts/import-apcpdcl.mts` →
committed `data/raw/discom/apcpdcl-33kv-feeders.geojson` (feeder name, source EHT SS, circle/division/sub-div,
conductor, pole count, km). **Never import its HT-consumer services, AB switches or poles.** `npm run update`
does not refresh these — re-run the import when APCPDCL supplies a newer export; the UI footnote shows the export
date (`live-status.json → discom.APCPDCL.linesFrom`).

**APSPDCL 11 kV routes (≈ 4,900 feeders, ≈ 112,000 km) come from APSPDCL's HT pole survey**, exported from
its internal GeoServer as one KML per circle (`circle_<name>_HT_points.kml`, ~3 M points, 9.6 GB; kept in
the owner's Google Drive `Transco/maps/SPDCL_HT_KML_Files`, with compressed KMZ copies in
`SPDCL_HT_KMZ_Compressed`). Every point records `back_link_point` (the pole it hangs off), so
`npm run import:spdcl` (`scripts/import-spdcl-11kv.mts`, pure helpers in `spdcl-lib.ts`, tests in
`spdcl.test.ts`) chains child → parent spans per (circle, division, 33/11 kV SS, feeder) into routes:
points within 5 m of their parent are contracted (duplicate captures), spans > 1 km dropped, and the tree is
walked into ≈ one polyline per leaf (`chainTree`), Douglas–Peucker 5 m, 5 dp →
committed `data/raw/discom/spdcl-11kv/<circle>.geojson` + `index.json` (vintage, per-circle stats,
**skipped** circles). Owner decision (2026-11-03, same as APCPDCL): **routes only** — feeder, SS, section/
sub-div/division/circle, pole / DTR-pole / VCB counts, km. **Never publish individual pole, DTR or VCB points,
their ids, survey ids or back-links.** A truncated export (GeoServer died mid-download — no `</kml>` or a
`ServiceException` tail; **Kadapa as of 2026-11-02**) is skipped. In `buildNetwork` the import replaces the
open-GIS APSPDCL 11 kV spans wherever it has coverage (`coverageMask`, ~330 m cells); open-GIS spans survive
only in uncovered areas (Kadapa). The overlay is ≈ 6.8 MB gz as a result. Not refreshed by `npm run update` —
re-run the import when APSPDCL supplies a new export (and re-export Kadapa).

## TRANSCO → 33 kV connectivity (`scripts/etl-connectivity.ts`, inferred)

`buildDiscom()` links the DISCOM network to the TRANSCO grid (pure helpers, `scripts/connectivity.test.ts`):
- **Feeder → source TRANSCO SS**: (a) `name` — the DISCOM's recorded source SS (APEPDCL `eht_ss_name`, APCPDCL
  `SUBSTN`) matched to a TRANSCO SS within 40 km by `normSsName` + `namesMatch` (prefix / 1-edit / consonant
  `skeleton` for transliteration variants like Narsapuram~Narasapuram) or `abbrevMatch` ("J R GUDEM" ~
  Jangareddygudem), voltage hint honoured, nearest wins; (b) `proximity` — a feeder end ≤ 1.5 km from a TRANSCO
  SS (APSPDCL records no source); (c) `feeder-group` — other runs of the same named feeder inherit.
  Recorded sources absent from TRANSCO's data (Gundlapadu, Abburu, Jindal…) fall to (b); the popup shows both.
- **Feeder → 33/11 kV SS served**: same-DISCOM SS within 300 m of the route (grid-indexed point-segment).
- Current coverage: APEPDCL 531/532 feeders, APCPDCL 462/462, 33/11 kV SS traced to TRANSCO 909/972 and 916/949;
  APSPDCL only 273/1,704 (its 33 kV map is partial — every DISCOM SS also gets `nearestTranscoSs`).
- Outputs: link props on `discom-lines`/`discom-ss` (`transcoSsId`, `transcoSs`, `linkMethod`, `servesSs*`,
  `feeders`, `nearestTranscoSs`); `transco-33kv.json` (lazy index for the detail panel: feeder tuples
  `[id,name,discom,km,method,ssIds]` per TRANSCO SS + `ss` lookup); `transco-33kv-connectivity.csv` (statewide,
  one row per feeder run); stats in `live-status.json → connectivity`.
- UI: `components/DiscomDownstream.tsx` in the TRANSCO substation detail (feeder list → served SS, Show on map,
  per-SS CSV/GeoJSON, statewide CSV link); selection sets the overlay store `focus` → amber highlight layers
  `ov-focus-lines`/`ov-focus-ss` in `overlays/map.ts`; popups link "TRANSCO source" back to the SS (`data-select`).

## RTGS reference layers (`scripts/build-ref-layers.mts` → `public/data/ref/`, lazy)

27 curated layers from the RTGS (AP Real-Time Governance Society) shapefile library on the owner's OneDrive
(`RTGS_DIR`, ~12 GB, 2023 vintage, some in UTM 44N) — boundaries (districts/mandals/revenue divisions/
assembly/parliament/municipal/HQs), transport (NH/SH/rail/stations/airports/seaports), environment / ROW
constraints (reserve forest, forest, wildlife, eco-sensitive, CRZ line, mining), water (rivers, reservoirs,
major canals), hazards (seismic zones, cyclone shelters, NRSC flood 2024-09-03, Michaung track). Built with the
project-local `mapshaper` (reproject, Visvalingam simplify, 5 dp; every file ≤ 2.5 MB, 16 MB total).
`catalog.json` describes them; `scripts/ref-layers.test.ts` gates it. **Mining `name` is the mineral, never the
lessee** (lessees are often private individuals — deliberately withheld). Static: re-run `npm run build:ref`
only when RTGS publishes new data (`npx tsx scripts/build-ref-layers.mts <id…>` rebuilds a subset but does NOT
rewrite `catalog.json`).

## Overlay catalog module (`src/overlays/`)

DISCOM + RTGS overlays live in a **self-contained module** rather than the per-overlay store/selection plumbing:
`catalog.ts` (defs + cartography `REF_STYLE`), `store.ts` (own zustand store: enabled/status/data, DISCOM
sub-filter, per-device persistence in localStorage `apgg-overlays-v1` — NOT in the URL hash), `map.ts`
(`attachOverlays(map)` — called once in `MapPane`'s `load`; re-mounts after style reloads; keeps every overlay
**beneath `grid-lines-casing`**; tap → MapLibre popup, core grid features always win the tap; outline-only
boundaries are not tappable). **Every map mutation in `sync()` is conditional** — setLayoutProperty/moveLayer/
setFilter emit `styledata`, which re-schedules `sync`; it also re-runs on `idle` because `isStyleLoaded()` is
false while any source loads. UI: `components/OverlaySections.tsx` (`DistributionSection`, `ReferenceSection`).

## PWA / offline

`public/manifest.webmanifest` + `public/sw.js` (registered in `main.tsx`, prod only): hashed assets cache-first,
navigations network-first, `data/*` stale-while-revalidate (`live-status.json` network-first), CARTO/Esri
basemap tiles SWR in a 1,500-entry cache. Bump `VERSION` in `sw.js` to invalidate. Because data is SWR, the
"updated — reload" toast compares the loaded `meta.generatedAt` with the latest `live-status.generatedAt`.

## Generation overlay (lazy-loaded)

A second, optional layer of **generation plants** classified by energy mix. It is **lazy** by design —
none of its code path runs until the user enables it.

- **Source / ETL**: live `Generation_SS` layer (`buildGenerationLive`, with `capacityMw` + `units`) when synced,
  else `data/raw/generation.kml` → `buildGeneration()` in `build-data.mts` → `public/data/generation.geojson`.
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
  `energy` drives `ENERGY_COLOR` / the legend. The KML had no capacity; the **live layer carries
  `capacityMw` (`total_capacity`) + `units`** for the plants the source has filled in (null otherwise). **No grid
  connectivity** is modelled for plants.

## Power-grid overlay (lazy-loaded)

A third, optional layer **group** sourced from ESRI shapefiles (`data/raw/gridmap/`, copied — tower
and admin-boundary shapefiles excluded; towers now come live, see "Transmission towers"). Like the generation overlay it is **lazy**: nothing runs until the
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
  shows the network total (≈ 300 GVA) with coverage. A row is rated for the circuits IT carries
  (`LineProps.circuits`, see "Circuit-km" below), so Ckt-1 + Ckt-2 rows of one corridor sum to 2 circuits. **Indicative only** — not a load-flow result;
  real ratings depend on ambient/conductor temperature, sag and bundle geometry.
- **Asset age** — `commissionYear()` / `ageYears()` / `formatAge()` in `src/lib/format.ts`
  (unit-tested in `format.test.ts`). Parses the year from the `commissioned` "Mon YYYY" string and
  derives age vs. `new Date().getFullYear()` (kept pure by passing the reference year in).
  `DetailPanel` appends "· 9 yrs" to the Commissioned field; the Network MIS adds the age bands, the
  commissioning histogram and the line-age map theme.

## Connectivity graph + power-flow + risk (pure analytics libs)

The topological criticality / N-1 islanding work that earlier docs flagged as *deferred* is now built.
All of it is **pure, side-effect-free, unit-tested** (node env) and **indicative only** — it runs on the
inferred geometric connectivity, hand-digitised wind zones and assumed impedances, never authoritative
ratings or a real load-flow. `graph.ts` (via `graph-data.ts`) drives the Network MIS N-1 screening and the
map spotlight; `risk.ts` the DetailPanel / Summary / Weather vulnerability read-outs. `risk-engine.ts`
(the removed Risk Room), `dcflow.ts` and `dlr.ts` (the removed Planning Studio) currently have no in-app
consumer (kept, tested, importable — see the intro notes).

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
`atlas | mis` (Planning Studio, the old MIS and Risk Room were removed — see the intro notes). Adding a
workspace = one folder under `src/workspaces/<id>/` + one entry in `registry.ts` (the shell handles switcher
+ routing); the shell is workspace-agnostic, so a registry entry is all it takes to add/remove a tab.

- **Code-split**: `atlas` is the inline default (never split out); `mis` declares a
  `load: () => import(...)` and mounts lazily in a `<Suspense>` boundary. Each declares `requiredManifests`
  the shell can gate/badge on (both are now `[]`).
- **Map embedding**: `MapPane` renders the shared map in `full` (Atlas), `embedded` (split layout) or
  `hidden` (collapsed) modes; the collapse is `mapLayout` (`open|collapsed|atlas-only`). The split is
  **drag-resizable** — `App`'s `PaneSplitter` sets the map-column width (persisted to localStorage under
  `dss-map-pane-w`, clamped to `[320, innerWidth−380]`), and a `ResizeObserver` in `MapPane` redraws the
  canvas on any container size change. `WORKSPACE_LAYER_PRESETS[ws]` (in `map/layer-presets.ts`) declares
  which overlay groups the embedded map may mount (no auto-toggling — visibility stays user-controlled
  via `MapLayerPanel`). An analysis workspace that needs overlay DATA without showing the layer calls the
  store's `ensureGeneration()` / `ensurePowerGrid()`.
- **`workspaceContext`** (store) carries cross-workspace focus. Hash-synced (only while `w=mis`): `misBy`
  (`by=`, default circle), `misFilters` (`mf=`, the drill path `dim:value~dim:value`), `misTab` (`tab=`),
  `misTheme` (`theme=`). Transient, never hashed: `misMap` (thematic classes + scope ids for the map) and
  `fit` (`{key, bounds}` — MapPane fits once per new key).

- **Network MIS** (`workspaces/mis/`) — an analyst's view of the network built on the live GIS data
  (the old parquet-based MIS is dead: the PSP/Vidyut feeds stopped at 2026-06-11).
  - `model.ts` (pure, `model.test.ts`): `buildModel` joins core SS/lines with `graphAnalysis` (feed degree,
    cut points, bridge impacts), line age (`commissionYear`), conductor family, indicative MVA and the
    TRANSCO→33 kV index (`transco-33kv.json`) into `SsRow`/`LineRow`. **Pivot, not a tree** — zone/circle/
    division do NOT nest in the source (3 circles straddle zones, 9 divisions span circles), so the drill is
    "add a `(dim = value)` filter, then regroup": `DIMENSIONS` (circle, zone, division, voltage, line-age
    band, conductor, N-1 role, coastal band) each with an SS and/or line accessor; `applyScope` (a line-only
    filter keeps the SS those lines touch; an SS-only filter keeps lines touching those SS); `groupBy` /
    `metrics` (ckm-weighted mean age, share ≥ 35 yrs = CERC useful life, distinct 33/11 kV SS); lines take
    zone/division from their first resolved end SS (lines carry neither). `bridgeImpacts` ranks bridges by
    downstream 33/11 kV SS stranded.
  - UI: `MisWorkspace.tsx` (sticky drill breadcrumb + map-theme switch, KPI tiles, breakdown, thematic tabs,
    register, provenance footer), `tables.tsx` (`Breakdown` pivot — click row = drill + auto-regroup via
    `nextDim`; `Register` — paginated SS/line lists, hover = map hover, click = dossier + fly), `themes.tsx`
    (Asset age · N-1 exposure · 33 kV downstream · Conductors & rating · Generation & interfaces),
    `Dossier.tsx` (SS / line dossier — the core-feature detail card is suppressed on the map in MIS),
    `charts.tsx` / `ui.tsx` (dependency-free SVG/HTML marks per the dataviz conventions; voltage palette for
    stacks, validated blue ordinal ramp for age). Every view has a CSV export.
  - Map (`map/mis-layers.ts`): `mis-line-theme` + `mis-ss-theme` ride the CORE sources via feature-state
    (`misC` class / `misV` value), filtered to the scope; themes = line age (ordinal ramp, reversed on
    dark/satellite), N-1 (status red/orange: bridges, cut-point / single-fed rings), 33 kV load
    (proportional circles ∝ √ 33/11 SS served). Out-of-scope features are dimmed through `applySpotlight`
    (a selection spotlight, when armed, wins).
  - Pagination is the shared `usePager`/`PagerBar` in `components/Pager.tsx` (also used by the Atlas
    `DataTableSheet`).

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
- **Circuit-km / route-km** (`lineAccounting` in `etl-lib.ts`, fixed 2026-11 — the old rule overstated
  the network as 33,327 route-km / 62,543 ckm). Each row carries `circuits` (circuits THIS row represents)
  and `routeKm` (its share of the physical route): a per-circuit row (`circuitTag` finds "Ckt-n" anywhere
  in the name) = 1 circuit, and sibling Ckt rows of one DC tower corridor (`corridorKey` = voltage + name
  minus the Ckt token) split the route (÷ min(siblings, 2)); a whole-line row = `lineCircuitMultiplier`
  (SC 1, **DC/SC 1 — DC towers, single circuit strung**, DC 2, MC 2) and owns its route. `ckm = lengthKm ×
  circuits`; `meta` route totals sum `routeKm`. Current: **24,287 route-km · 33,474 ckm** (400 kV 5,708 ·
  220 kV 13,549 · 132 kV 14,217).
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
  reported in `data-quality.json` and consumed by the Network MIS coastal dimension + the Atlas `coast=` band filter.
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
