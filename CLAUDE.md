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

The app is **one map with four task lenses** — **Explore** (the reference map, default), **Field** (O&M on
site), **Plan** (the **Network MIS**, a lazy chunk beside an embedded map) and **Storm** (control room). See
"Lenses (the shell)". Everything the app renders is pure static assets, so there is no backend at request time.

> **Atlas 2.0 revamp in progress (2026-11):** an approved, phased re-architecture — four task *lenses*
> (Explore · Field · Plan · Storm) over one map, a single layer registry + sync engine, one resource
> loader, one Inspector, URL v2 with real Back/Forward, a layer catalogue + ⌘K omnisearch, then static
> vector tiles. **Read `docs/specs/2026-11-05-atlas-2-design.md` (progress table at the top) before
> touching the shell, map wiring, store, URL or search** — several modules below are slated for
> replacement there.

> **Dormant code retired (2026-11, Atlas 2.0 phase 0):** `lib/dcflow.ts`, `lib/risk-engine.ts`,
> `public/data/wind-zones.geojson`, `data/manifests.ts` + `FreshnessBadge`/`MethodCard`, the `MapView`
> shim, the whole `pipelines/` directory + `pipelines.yml`, and the `@duckdb/*`, `echarts`, `xlsx`,
> `undici` deps were removed — preserved on the local `archive/dormant-2026-11` branch. The remote
> `data` branch (old parquet) is untouched and unused. Don't revive these without an explicit ask.

> **Risk Room removed, Network MIS added (2026-11):** the Risk Room workspace was replaced by the
> **Network MIS** (`workspaces/mis/`, now the Plan lens), preserved on the local `archive/risk-room` branch.
> `lib/risk.ts` stays (the Inspector, SummaryView, WeatherView use it).

> **Removed workspaces (2026-06):** the Planning Studio and the old parquet MIS live on the
> `archive/planning-studio` / `archive/mis-workspace` branches.

## Commands

```bash
npm run sync:live    # pull TRANSCO + DISCOM layers from gis.aptransco.gov.in → data/raw/live/* (India-only network!)
npm run sync:towers  # pull the ~114k transmission towers (400/220/132 kV) → data/raw/live/towers-*.json (~8 s)
npm run sync:network # pull the DISCOM 11 kV network (feeders, DTRs, AB switches) → data/raw/live/net-*
npm run build:ref    # RTGS shapefile library (OneDrive, RTGS_DIR) → public/data/ref/* — run locally, commit outputs
npm run dev          # Vite dev server → http://localhost:5173/ap-gis-grid/
npm run build:data   # ETL: data/raw/{gridmap/*.shp, generation.kml, geonames-ap.tsv, coastline-ap.geojson} → public/data/*
npm run build        # tsc --noEmit && vite build  (production)
npm run preview      # serve dist/ (use this to verify prod; dev HMR can be flaky for map state)
npm test             # Vitest run: ETL + lib + URL-contract unit tests + emitted-data integrity checks
npm run typecheck    # tsc --noEmit
npm run e2e          # Playwright smoke suite vs `vite preview` (run `npm run build` first; browsers in node_modules)
npm run e2e:install  # one-time: download the project-local headless Chromium
```

Run a single test file with `npx vitest run src/lib/graph.test.ts` (add `-t "<name>"` to filter by
test name). After ANY ETL or component change, run `npm run typecheck` (strict, `noUnusedLocals`).
**There is no ESLint/Prettier step** — the quality gates are `npm run typecheck` (strict;
`noUnusedLocals` + `noUnusedParameters`, so unused imports/params *fail* the build), `npm test`, and the
Playwright smoke suite `npm run e2e` (`e2e/*.spec.ts`; opens the app with `?e2e`, which exposes the map as
`window.__map`; runs as a **non-blocking** CI job in `deploy.yml`). `src/url/hash.test.ts` pins the v1
deep-link contract — URL v2 must keep decoding every fixture there.

## Architecture

```
gis.aptransco.gov.in ─(sync:live / sync:towers / sync:network, India-only)─▶ data/raw/live/*  ─┐
data/raw/{gridmap/*.shp, generation.kml, geonames-ap.tsv, coastline-ap.geojson, discom/…}  ───┼─(build:data ETL)─▶ public/data/*  ─▶ React + MapLibre shell ─▶ GitHub Pages
RTGS shapefile library (OneDrive) ─(build:ref, local)─▶ public/data/ref/*  [committed]          ┘   [committed]
```

`build:data` reads the shapefiles via the `shapefile` dep (build-time only). All source layers are
WGS84 (EPSG:4326) — no reprojection. `Transco.kml` is retained for reference but is **no longer a source**.

| Layer | Path | Notes |
|-------|------|-------|
| ETL | `scripts/build-data.mts` + `scripts/etl-lib.ts` | pure helpers in etl-lib (unit-tested); orchestration in build-data.mts |
| Data | `src/data/` | `resources.ts` (**the one lazy-asset loader** — see below), `fetch.ts` (worker-safe `fetchJson`/`dataUrl`/`HttpError`), `types.ts` (canonical types), `load.ts` (initial grid + gen/pg fetch), `selectors.ts`, `graph-data.ts` (memoised topology), `weather.ts`, `connectivity.ts` (TRANSCO→33 kV index), `network-search.ts` (11 kV / DTR types + decoders), `search-core.ts` + `search-client.ts` (places / network / DTR search engine, run in `workers/search.worker.ts`), `live-status.ts` |
| State | `src/state/` (one Zustand store from slices) + `src/url/` | see "Store slices" and "URL v2"; selection history (`back()`), lens + workspaceContext |
| Map | `src/map/` | see "Map engine" below: `MapPane.tsx` (the one map — `full` in the map lenses, embedded/hidden in Plan; ~160 lines of wiring), `engine.ts`, `registry/{types,core,overlays}.ts`, `interaction.ts`, `hooks.ts` (camera / measure / nearby / resize), `spec.ts` (`MapSpec` / `FeatureStateSpec` + conditional appliers), `layers.ts` / `weather-layers.ts` / `mis-layers.ts` (pure layer builders + specs), `layer-presets.ts` (per-workspace layer groups), `basemaps.ts`, `measure.ts`, `map-helpers.ts` (fly / fit / `sourceForId`), `testing/fake-map.ts` |
| Shell / UI | `src/App.tsx` + `src/shell/` + `src/components/` | see "Lenses (the shell)": `Header`, `LensTabs`, `MoreMenu`, `BottomSheet`, `MapLensChrome`, `PlanChrome`, `MapToolbar`; components SearchBar, DataTableSheet, Summary/DataQuality/Weather views, Measure/Nearby controls |
| Layers UI | `src/layers/` | see "Layer catalogue (the Layers drawer)" |
| Lenses | `src/lenses/` (`registry.ts` pure, `panels.tsx`, per-lens panels) + `src/workspaces/mis/` (the Plan lens body) | See "Lenses (the shell)" |
| Analytics libs | `src/lib/` | pure, unit-tested: `geo.ts`, `capacity.ts`, `dlr.ts`, `graph.ts`, `supply-security.ts`, `risk.ts`, `weather.ts`, `format.ts`, `export.ts` |
| Theme | `src/theme/palette.ts` + `src/index.css` | voltage palette (Okabe-Ito, CVD-safe) as both JS + CSS tokens |

The emitted `public/data/*` files are **committed** so CI/Pages builds don't need the raw sources.

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
also has ~24 structural/insulator fields that are currently empty (the Inspector shows any that get filled).
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
  toggles in the Layers drawer (Transmission group), minzoom 9 (400 kV 8), CP towers larger + ringed,
  labels (tower no.) from z14. A tower tap wins over the line beneath (listed under "Also here") and opens the Inspector with every
  attribute + a link to the line. `components/LineTowers.tsx` (a section of the line Inspector): count,
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

## Resource loader (`src/data/resources.ts`, Atlas 2.0 phase 1)

Every lazy asset goes through **one loader**: `defineResource<T>(name, {load(param, signal), refreshMs?})`
→ `res.ensure(param?)`, `res.peek()`, `res.refresh()`, and the hook `useResource(res, param | null)`
(`null` = disabled) → `{status, data, error}`. It de-dupes in-flight loads per key, retries transient
failures (network / 5xx / 429) twice with backoff, aborts a load once every signalled (hook) caller has
gone (un-signalled `ensure()` pins it), never makes errors sticky, and re-polls `refreshMs` resources while
subscribed by an **active** consumer and the tab is visible (keeping stale data on failure).
`useResourceSnapshot(res, param)` observes **passively** — no load, and it does NOT keep the refresh timer
alive (use it for opportunistic reads, e.g. DLR in the line Inspector). Current resources: `gridRes` (core grid;
the store mirrors it as `data`), `generationRes`, `powerGridRes` (`data/load.ts`), `weatherRes` (10-min
poll, awaits `gridRes` for circle points), `connectivity` (`transco-33kv.json`), `liveStatus` (15-min poll),
`spotWeather` (per cell), `refCatalog` + `overlayLayer` (`overlays/resources.ts`, per overlay id — the map
layer and the DISCOM GeoJSON download share one fetch), `placesTier` / `networkTier` (search worker).
**Add new lazy data as a resource** — don't hand-roll a module promise, and don't copy loaded data or its
status into the store. **Whoever draws/uses lazy data loads it** (`useResource(res, on ? "" : null)`);
store toggles and `applyUrl` only flip visibility flags.

## Store slices (`src/state/`, Atlas 2.0 phase 1)

One zustand store composed from slices: `slices/{core,selection,view,filters,ui,ctx,layers,url}.ts`, shapes
in `state/types.ts`. `useAppStore` is the flat legacy facade (= the store); `useOverlayStore`
(`overlays/store.ts`) is a facade over the nested **`layers`** slice (ex-overlay store: defs, enabled, status,
DISCOM sub-filter, focus, fitSignal — its `subscribe` fires only on `layers` changes). Named hooks
with `useShallow` in `state/hooks.ts` (`useGrid`, `useFilters`, `useSelection`, `useView`) — prefer them in
new/migrated code; call sites move over file by file. **One filter model**: `filters` (voltage, circuit,
circle, coast + layer visibility) is read by the map AND the data table (`passesSlice`/`sliceActive` in
`data/selectors.ts`; the table's chips drive the map; only its text search is local). **Persistence**:
`persist` stores only the overlay choices under the legacy key `apgg-overlays-v1`, in the legacy raw shape
`{enabled, discoms}` (old cached builds still read it); `layersStorage` never throws and skips no-op writes
(persist calls setItem on every update); `parseStoredLayers` sanitises (tested in `state/store.test.ts`).

## TRANSCO → 33 kV connectivity (`scripts/etl-connectivity.ts`, inferred)

`buildDiscom()` links the DISCOM network to the TRANSCO grid (pure helpers, `scripts/connectivity.test.ts`):
- **Feeder → source TRANSCO SS**: (a) `name` — the DISCOM's recorded source SS (APEPDCL `eht_ss_name`, APCPDCL
  `SUBSTN`) matched to a TRANSCO SS within 40 km by `normSsName` + `namesMatch` (prefix / 1-edit / consonant
  `skeleton` for transliteration variants like Narsapuram~Narasapuram) or `abbrevMatch` ("J R GUDEM" ~
  Jangareddygudem), voltage hint honoured, nearest wins; (b) `proximity` — a feeder end ≤ 1.5 km from a TRANSCO
  SS (APSPDCL records no source); (c) `feeder-group` — other runs of the same named feeder inherit.
  Recorded sources absent from TRANSCO's data (Gundlapadu, Abburu, Jindal…) fall to (b); the Inspector shows both.
- **Feeder → 33/11 kV SS served**: same-DISCOM SS within 300 m of the route (grid-indexed point-segment).
- Current coverage: APEPDCL 531/532 feeders, APCPDCL 462/462, 33/11 kV SS traced to TRANSCO 909/972 and 916/949;
  APSPDCL only 273/1,704 (its 33 kV map is partial — every DISCOM SS also gets `nearestTranscoSs`).
- Outputs: link props on `discom-lines`/`discom-ss` (`transcoSsId`, `transcoSs`, `linkMethod`, `servesSs*`,
  `feeders`, `nearestTranscoSs`); `transco-33kv.json` (lazy index for the detail panel: feeder tuples
  `[id,name,discom,km,method,ssIds]` per TRANSCO SS + `ss` lookup); `transco-33kv-connectivity.csv` (statewide,
  one row per feeder run); stats in `live-status.json → connectivity`.
- UI: `components/DiscomDownstream.tsx` in the TRANSCO substation detail (feeder list → served SS, Show on map,
  per-SS CSV/GeoJSON, statewide CSV link); selection sets the overlay store `focus` → amber highlight layers
  `ov-focus-lines`/`ov-focus-ss` (registry defs in `map/registry/overlays.ts`); the Inspector's "TRANSCO source" field links back to the SS.

## DISCOM 11 kV network + transformer search (`scripts/sync-network.mts`, `scripts/etl-network.ts`, lazy)

`npm run sync:network` (also run by `npm run update`, non-fatal) pulls from the open APEPDCL
(`Epdcl_11KV/Epdcl_11KV/MapServer`) and APSPDCL (`SPDCL/SPDCL_Network_11KV/MapServer`) services: 11 kV
feeders/lines, distribution transformers (DTRs) and APEPDCL AB switches → `data/raw/live/net-*`
(`net-lib.ts` `NET_LAYERS`; points grouped by feeder like towers; floor + >15 %-drop gates; `net-manifest.json`).
- **Privacy — allow-lists, never drop-lists** (`keep` per layer, see the header of `net-lib.ts`): HT consumer
  services are never pulled; `dtr_loc_name` (often a private person's name), `ht_scno`, remarks, device and
  employee ids are deliberately not kept. **Owner decision (2026-11-05): the AB-switch raw file and DTR
  `pole_no` (from the open GIS) stay published as they are** — don't re-raise.
- **ETL** (`buildNetwork` in build-data → `etl-network.ts`): `discom-11kv-lines.geojson` (lazy overlay,
  ≈ 20 MB raw / 3.1 MB gz — the biggest file; tiling it is Atlas 2.0 phase 4), `net-dtr-<shard>.json`
  (≈ 305k DTRs in ~380 shards: APEPDCL by the first 4 chars of the DTR code, APSPDCL by the first 2 of the
  serial) and `search-network.json` (the "network" search tier + upstream trace chains). Every 11 kV feeder is
  linked to its 33/11 kV SS (APEPDCL: recorded `sub_station_id`; APSPDCL: name within 5 km, else a run end
  ≤ 500 m), which the 33 kV connectivity already ties to a TRANSCO SS — giving the **inferred** trace
  TRANSCO SS → 33 kV feeder → 33/11 kV SS → 11 kV feeder → DTR.
- **UI**: the search worker (`data/search-core.ts` `SearchEngine`, hosted by `workers/search.worker.ts`,
  driven from `data/search-client.ts`) loads `search-network.json` on first search focus; a query that
  `looksLikeDtrCode` (≥ 4 chars, has a digit, no spaces) fetches only the matching DTR shard(s) — all parsed
  and ranked off the main thread, only the top hits cross back. Picking a
  result primes its item and selects its ref (`f11-…` / `dtr:<code>` / …) → the Inspector's `net` adapter (attributes +
  clickable trace, coverage caveat), which turns on / highlights / zooms the overlay. Coverage is partial (APSPDCL sparse; APCPDCL has no open
  11 kV data) — the UI says so.

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

## URL v2 (`src/url/`, Atlas 2.0 phase 2)

Everything has a URL, and browser Back / Forward work inside the app. `url/v2.ts` (pure, `v2.test.ts`):
`#@lng,lat,zoomz&v=2&lens=plan&sel=<ref>&lyr=gen,pg,wx,discom-lines,ref:districts,-ss&volt=…&circ=…&circle=…&coast=…&base=…&tbl=1&map=…&by=…&mf=…&tab=…&th=…`
— defaults omitted; `lens` = explore | field | plan (MIS) | storm; `lyr` lists only what differs from the **lens defaults**
(`-token` = a default switched off, e.g. `lyr=-wx` in Storm); entering a lens without `lyr` brings its defaults; MIS keys only in
Plan; `lyr` present ⇒ authoritative layer set (wins over the remembered overlays), absent ⇒ layers untouched.
- **History** (`historyMode`): selection, lens, circle and MIS drill (`mf`/`by`/`tab`) **push**; everything else
  (filters, layers, basemap, camera, theme) **replaces**, debounced 300 ms (`url/useUrlSync.ts`). Only `URL_INPUTS`
  re-serialise — never hover / measure. popstate / hashchange → `applyUrl` (a full state: omitted keys reset).
- **Camera**: MapPane writes the settled camera on every `moveend` (`setCamera`, rounded); a URL camera arrives as
  `cameraSignal` — jumped to on load (instead of the AP fit), eased to on Back. A link's camera wins over flying to
  its `sel`.
- **v1 links** (`#v=1&…`) decode through `url/hash.ts` (`parseHash`, pinned by `hash.test.ts`) → `fromV1`, then the
  app rewrites them to v2 in place. Header **Copy link** (`components/CopyLink.tsx`) copies the full view.

## Layer catalogue (the Layers drawer, Atlas 2.0 phase 3 PR 9)

`src/layers/catalogue.ts` (pure, `catalogue.test.ts`) = ONE list of every layer switch: `CatEntry {id, group, label,
swatch, minzoom, bytes, count, source, vintage, note, keywords, opacity}`, `id` = the layer token (`ss` / `ln` / `gen` /
`pg` / `wx` / overlay id — same as lens defaults + URL `lyr`). Built from `BUILTIN_ENTRIES` + the overlay defs (RTGS
join once `catalog.json` loads); 8 groups (Transmission, Distribution, Generation & interfaces, Weather & hazards,
Boundaries, Transport, Environment, Water); `withLiveCounts` fills counts from `live-status.json`; hand-entered file
sizes are checked against `public/data` (±25 %).
- **Store** (`slices/catalogue.ts`): `setLayer(token, on?)` (any layer, loads what it needs), `soloLayer(token)` (only
  that layer; again → restore the saved `LayerOn`; any other layer change ends solo), `layersOpen`. Opacity:
  `layers.opacity[id]` (0–1, transient) → `overlayOpacitySpec` / `radarOpacitySpec` (conditional paint writes; base
  opacities are declared on the layers so an untouched slider makes no write).
- **UI**: `MapToolbar` (top-left of the map: Layers · `FilterChips` voltage / circle / coast · Measure · Nearby;
  a scrolling strip on phones), `LayerDrawer` (tabs "On now" — legend keys + sub-switches from `details.tsx`, solo,
  remove, opacity, out-of-zoom hint — and "All layers" — grouped, searchable, Alt-click = solo; basemap footer;
  full-screen on phones; Escape closes), `MapLegend` (desktop, bottom-left: only layers on AND inside their zoom
  range). Plan's map shows the Layers button + drawer only (the MIS slicer scopes the analysis).

## Inspector (`src/inspector/`, Atlas 2.0 phase 2)

ONE detail view for every selectable thing (it replaced DetailPanel, the MIS Dossier, NetworkTracePanel and the
overlay tap popups). The selection (`selectedId`, URL `sel=`) is an **Inspector ref** (`refs.ts`): bare core /
plant / power-grid / DISCOM ids (`s-` `l-` `g-` `pl-` `ps-` `rs-` `bs-` `ds-` `dl-` `f11-`, so v1 links still open) or
typed `dtr:<code>` · `sec:<label>` · `tw:<kv>:<index>` · `ref:<layer>:<index>` (RTGS sources use `generateId`).
- **Adapters** (`adapters/*`, registry `inspect.ts`): `needs(ref)` (overlay layer / net item / gen / pg) ·
  `resolve(ref, ctx)` · `header` · `sections` · `locate` · `focus` (amber DISCOM highlight) · `geojson`. Sections are
  data — `fields | links | trace | callout | note | custom` with ids (overview, risk, weather, connectivity, supply,
  trace, downstream, towers, provenance) — unit-tested in `inspector.test.ts` on the real `public/data`. Adapters
  never fetch: `useInspected` (`useInspected.ts`) loads what `needs` asks through the resource loader (`netItemRes`
  resolves `net` refs in the search worker; a search pick primes it).
- `useInspectorSync()` (mounted once in App): switches the selected feature's layer on, shows its `focus`, and
  flies non-core refs once resolved (core/plant/PG flights stay in `useMapCamera`).
- `Inspector.tsx`: `variant="panel"` (Atlas right column / phone sheet) or `"inline"` (MIS); `extend` merges
  workspace sections by id (same id replaces, new ids follow the overview) — MIS passes `misInspector(model, …)`.
  Back breadcrumb = selection `history`; "Also here · N" / "What's here" = the `here` list from the last tap.

## Overlay catalog module (`src/overlays/`)

DISCOM + RTGS overlays live in a **self-contained module** rather than the per-overlay store/selection plumbing:
`catalog.ts` (defs + cartography `REF_STYLE`), `resources.ts` (`overlayLayer` / `refCatalog`), `store.ts`
(facade over the app store's `layers` slice: enabled/status, DISCOM sub-filter, per-device persistence in
localStorage `apgg-overlays-v1`; a URL `lyr=` list wins over it). Their map
layers are registry defs (`map/registry/overlays.ts`: polygons < lines < points, then the amber focus highlight;
towers in the `above-grid` band) — see "Map engine". UI: the Layers drawer (`src/layers/`, see "Layer catalogue").

## Map engine (`src/map/`, Atlas 2.0 phase 1)

Everything the map draws is a **registry `LayerDef`** (`registry/types.ts`): a source (`geojson` from state or a
resource, `computed` with a `key` → `setData` on change, `raster` → `setTiles` on change, or `ride` on another def's
source), its style layers, a z-**band**, `visible(s)`, and memoised pure `spec(s)` (filter / paint) and
`featureState(s)`. `registry/core.ts` (`mapRegistry`) lists them bottom → top over one `MapState` (`{app: store,
data, gen, pg, wx, preset}`): weather radar + cyclone fills, catalog overlays + focus highlight (`beneath`) · core
lines + MIS line theme (`grid`) · towers + MIS SS rings (`above-grid`) · SS dots/labels, wx-risk halo, plants, the
power-grid classes, cyclone track, focus pin (`top`).
- **`engine.ts` (`attachEngine`)** mounts defs (a hidden def isn't mounted until first shown; once mounted it is only
  hidden) and reconciles once per frame on map-relevant store changes (`MAP_INPUTS` in MapPane), passive resource
  loads, `styledata` and `idle` (`isStyleLoaded()` is false while any source loads). **Every write is conditional**
  (`applySpec` reads back; setLayoutProperty/moveLayer/setFilter emit `styledata`, so an unconditional write would
  loop) — a no-op reconcile makes zero writes (`engine.test.ts` + an e2e "quiet second"). A def whose memoised
  spec / feature-state objects and layer instances are unchanged is skipped without reading the map, so hover
  reconciles are cheap. Hover / selected / MIS classes are feature-state, diffed per (owner, source) and re-applied
  when a style reload replaces the source. **Z-order** = four empty band sentinels (`band-beneath` … `band-top`,
  top kept topmost even over the measure layers); layers are moved only when out of their band/listed order.
  `onStyleReload` re-adds the measure tool's layers after `setStyle`.
- **`interaction.ts`** — the ONE click/hover handler: defs declare `interaction {priority, layers, pad, hover,
  kind, pick → Inspector ref}` — tower 0 · core SS 10 · core line 20 · plant / power grid 30 · overlay points 40 ·
  lines 50 · fills 60 (outline-only polygons not tappable). The best exact hit is selected; everything in a 16 px box
  is the "What's here" list (`here` in the selection slice — "Also here" in the Inspector; with no exact hit one box
  hit is selected, several are listed; right-click lists without selecting). No popups. Suppressed while measure / nearby own the map (nearby-pick
  sets the origin instead). Note: towers don't sit exactly on the drawn core lines, so a tower tap selects nothing.
- **`hooks.ts`** — `useMapCamera` (fly-to, circle fit, MIS scope fit, overlay fitSignal, nearby fly),
  `useMeasure`, `useNearbyMarker`, `useMapResize` (debounced; MapLibre's `trackResize` is off).
- Add a layer = add a def (and its pure builder/spec + a test); never mutate the map from a component.

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
- **Lazy contract**: the initial grid load does NOT fetch `generation.geojson`. It is the
  `generationRes` resource: `MapPane` (and the Layers drawer / legend) `useResource` it while `filters.showGeneration`
  is on — so a manual toggle and a `gen=1` deep link behave the same; the MIS Interfaces tab loads it
  without switching the layer on. The map
  source/layers are mounted by the engine (`GENERATION` def in `map/registry/core.ts`) only once data arrives
  (re-mounted after a basemap style reload, same as the grid layers). Plants are NOT in the initial search index or the data table.
- **Not in `data.byId`**: plants live in a separate `generation.byId` (`generationRes`). The Inspector's `plant`
  adapter loads `generationRes` itself, so a deep-linked plant opens without the layer on. Plant `voltage` reuses the grid voltage palette;
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
- **Lazy contract**: the initial grid load does NOT fetch these. `powerGridRes` loads all four files
  (one `Promise.all`) while `filters.showPowerGrid` is on (toggle or `lyr=pg` deep link alike). Per-class visibility is `filters.pgClasses` (NOT in the URL hash —
  only the single `pg=1` key, like generation's `genTypes`). Layers are four engine defs
  (`PG_LINES` / `PG_SS` / `RAILWAY` / `BULKLOAD` in `map/registry/core.ts`), one per source.
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

- **Lazy contract**: same as generation/powergrid — `weatherRes` loads only while the overlay is on
  (`MapPane` / Layers drawer / legend) or the Weather monitor is open (`WeatherView`). URL **`lyr=wx`**
  (master only; `wxLayers` radar/cyclone sub-toggles are NOT in the hash, like `genTypes`). The load awaits
  `gridRes` for circle points, so a wx=1 deep link needs no special casing.
- **Auto-refresh**: `weatherRes.refreshMs` = 10 min, alive only while an active consumer is mounted
  (passive readers like the line Inspector's DLR don't count) and the tab is visible; refreshes keep stale data
  on screen. Never persisted.
- **Map layers** (engine defs `WX_RADAR` / `WX_CYCLONE_FILLS` / `WX_CYCLONE_LINES` / `WX_RISK` in
  `map/registry/core.ts`, builders in `weather-layers.ts`): radar raster + cyclone fills in the `beneath` band so the
  grid stays legible; track/positions/cone outline on top. A new radar frame swaps tiles in place (`setTiles`), a new
  fetch re-uploads the cyclone GeoJSON (`computed` source keyed on `fetchedAt`). Substations inside a forecast cone
  get an amber halo — the `wx-risk-substations` circle layer rides the core SS source with an id `in`-filter
  (`wxRiskSpec`, NOT feature-state). Visibility = `weatherOn(filters, layer)` (master × sub-toggle).
- **Weather monitor** (`WeatherView`, `weatherOpen` like `summaryOpen`, not in hash): cyclone alert
  cards (GDACS level colours + "N substations inside the forecast envelope" via `assetsInCone`),
  13-circle conditions grid, coastal sea state, 3-day outlook table, last-updated + manual refresh.
- **The SS Inspector** shows a "Weather now" line for a selected substation **only while the overlay is
  on** (`spotWeather` resource keyed by `spotCell` — one fetch per ~1 km cell).
- Palette: cyclone swaths use GDACS's semantic green/orange/red (`WX_ALERT_COLOR`), track is
  rose-900 `WX_TRACK_COLOR`, risk halo amber `WX_RISK_COLOR` — all outside the voltage palette.
  Everything is labelled **indicative** (model output, not IMD advisories) per the honesty convention.

## Measurement tool

A client-side **distance / area** measure tool (top-centre `MeasureControl` pill). All geodesy is in
`src/lib/geo.ts` (haversine length, spherical-excess area — no Turf/deps), unit-tested in `geo.test.ts`.

- **Controller**: `src/map/measure.ts` (`MeasureController`) owns a dedicated `src-measure` GeoJSON
  source + overlay layers (magenta — outside every other palette) and all click/move/dbl-click/keyboard
  handling. One instance per map, created by `useMeasure` (`map/hooks.ts`, full/Atlas mode only) once the
  map has loaded (MapPane keeps the loaded map in state, so the effect re-runs); `setMode(mode|null)`
  toggles it. `ensureLayers` is idempotent and re-run by the engine's `onStyleReload` (setStyle drops them).
- Click adds vertices, a dashed rubber-band tracks the cursor, **double-click / Enter** finishes,
  **Esc** clears (or exits if empty), **Backspace** undoes. Live readout published to the store
  (`measureMode` / `measureStats` — **transient, never in the URL hash**).
- While a mode is active, the interaction handler's hover/select early-returns (`clickSuppressed()`,
  which is true for **either** the measure tool or the nearest-SS tool) and `doubleClickZoom` is
  disabled, so clicks place points instead of selecting features / zooming.

## Lookup utilities (export · regional slice · nearest substation)

Three client-side conveniences for the MIS/lookup workflow — all pure-data + existing patterns, no new
deps, no backend.

- **Export & reporting** — `src/lib/export.ts` (pure CSV + GeoJSON builders, RFC-4180 escaping;
  unit-tested in `export.test.ts`). The `DataTableSheet` header has **CSV** + **GeoJSON** buttons that
  export the *currently-shown* rows of the active tab (respecting the text filter); the Inspector has a
  per-feature **GeoJSON** download (substation Point / line geometry from `linesFc`). `downloadText()`
  is the only impure helper (Blob + anchor; no-op outside a browser, so the builders stay testable).
- **Regional slice by circle** — `filters.circle: string | null` (in `FilterState`). The map toolbar's
  circle chip (`layers/FilterChips.tsx`, a `<select>`) (13 canonical circles from `meta.circles`) filters the **core** lines +
  substations (`gridSpec` ANDs `["==",["get","circle"],…]`) and `fitToCircle` (`useMapCamera`) zooms to the
  circle's SS bounds (back to `meta.bounds` when cleared). Deep-linkable: URL key **`circle`** (changing it pushes a history entry).
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
- **Lazy contract**: loaded into the **search worker** (`placesTier` resource in `data/search-client.ts`)
  on first **focus** of the search box; parsing and ranking happen in the worker and only the top 8 hits
  come back. A failed load is retried by the next focus. Never part of the initial payload.
- **Search-only — places are NOT map features**: no layer, no `byId`, no selection, no hash key.
  `SearchBar` appends up to 8 gazetteer hits under a "Places" divider (grid assets always rank
  first; rank ties break by population so Tirupati-the-city beats its namesake villages, and
  same-name villages disambiguate by district). Choosing one calls `setNearbyOrigin` with a
  type-based zoom (state 7 / district 9 / mandal 11 / city 12 / default 13) — `useMapCamera`'s
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
  rated (~99%)**; the rest (bare "UG Cable", "AL59" alloy) return null → UI shows nothing. The line Inspector
  shows it per line (≈ 610 MVA, with a per-circuit split for DC) + an honesty footnote; `SummaryView`
  shows the network total (≈ 300 GVA) with coverage. A row is rated for the circuits IT carries
  (`LineProps.circuits`, see "Circuit-km" below), so Ckt-1 + Ckt-2 rows of one corridor sum to 2 circuits. **Indicative only** — not a load-flow result;
  real ratings depend on ambient/conductor temperature, sag and bundle geometry.
- **Asset age** — `commissionYear()` / `ageYears()` / `formatAge()` in `src/lib/format.ts`
  (unit-tested in `format.test.ts`). Parses the year from the `commissioned` "Mon YYYY" string and
  derives age vs. `new Date().getFullYear()` (kept pure by passing the reference year in).
  The line Inspector appends "· 9 yrs" to the Commissioned field; the Network MIS adds the age bands, the
  commissioning histogram and the line-age map theme.

## Connectivity graph + power-flow + risk (pure analytics libs)

The topological criticality / N-1 islanding work that earlier docs flagged as *deferred* is now built.
All of it is **pure, side-effect-free, unit-tested** (node env) and **indicative only** — it runs on the
inferred geometric connectivity, never authoritative ratings or a real load-flow. `graph.ts` (via
`graph-data.ts`) drives the Network MIS N-1 screening and the map spotlight; `supply-security.ts` the MIS
radial-feed views; `risk.ts` the Inspector / Summary / Weather vulnerability read-outs; `dlr.ts` the
line Inspector's ambient-temperature derating (live — it is used). The DC load-flow and the three-axis risk
engine were retired (see the intro notes).

- **`src/lib/graph.ts`** — a multigraph over substation ids (parallel circuits are distinct edges, since
  N-1 line loss ≠ corridor loss). `buildGridGraph(substations, lines)`, then `connectedComponents()`,
  `feedDegree(ssId)` (distinct neighbours, not edge count), `singleFedSubstations()`, `bridgeLines()` +
  `articulationSubstations()` (one Tarjan low-link DFS), `lineOutageImpact(lineId)` (N-1: who is islanded
  when a bridge is out), `neighborhood(ssId, hops)` (k-hop ego net for the map spotlight).
- **`src/lib/supply-security.ts`** — **radial-feed / supply-security** screening on a CORRIDOR graph (one
  edge per node pair, carrying its circuit count — so a DC tower line is one corridor, unlike `graph.ts`'s
  per-circuit multigraph). Generation switchyards (line `externalEndpoints` of category Generation) are
  nodes; traction / HT consumers are leaves. Core = largest 2-edge-connected block; every other block hangs
  off it through corridor bridges (a "pocket"). Per node: `cls` `meshed | radial-dc | radial-sc |
  unconnected` (radial-sc = some corridor on the feed has ONE circuit → N-1 insecure; radial-dc = circuit
  N-1 OK, tower-line loss islands it), `depth`, `bottleneck` circuits, `radialKm`, `headId`, `path`.
  Also `pockets`, `cutImpacts` (bus outage at a cut-point SS → islanded SS), `openEnds` (lines with an
  unresolved far end — flagged as "data gap"), `interfaces` + `interfaceSecurity` (plants / RTSS / HT on one
  circuit, one SS, or ≥ 2 SS). Current data: 267 meshed · 75 radial-DC · 44 radial-SC · 3 unconnected.
- **`src/data/graph-data.ts`** — `graphAnalysis(data)` memoises the above per `GridData` instance
  (WeakMap) → `{graph, bridgeImpacts, articulationIds, singleFedIds, feedDegrees}`; `spotlightFor(...)`
  returns the SS/line ids to highlight for a selection.
- **`src/lib/dlr.ts`** — **dynamic line rating**: ambient-temperature derating of the `capacity.ts`
  nominal ampacity, `I(Ta)/I(Tref) = √((Tcond − Ta)/(Tcond − Tref))` (Tcond 75 °C, Tref 40 °C, cool-weather
  uprate capped 1.15 — no wind/solar data). `deratingFactor` / `deratedCapacityMva` / `formatDerating`.
- **`src/lib/risk.ts`** — single-axis **vulnerability** index `substationRisk()` (coastal band, redundancy
  via feed degree, age, voltage → 0–100 + factor list) + `riskTier()`.
## Lenses (the shell, Atlas 2.0 phase 3)

`LensId` = `explore | field | plan | storm` (store `lens`, `setLens`; URL `lens=`). **`src/lenses/registry.ts`** is
pure data (unit-tested in `registry.test.ts`): id, label, audience, `layout` (`map` | `split`), `defaults`
(layers switched on beyond the core grid: Field = 33 kV lines + SS + the three tower layers; Storm = wx + RTGS
`crz-boundary` + `cyclone-shelters`; 11 kV joins Field once tiled), `panelWidth`, `startHere` tips — plus the layer
token helpers (`switchLensLayers`, `encodeLayerDiff` / `decodeLayerDiff`, `lensOnlyOverlays`). A lens is a **preset,
never a filter**: switching keeps the selection and filters, turns the old lens's own defaults off and the new
one's on, and keeps anything switched on by hand (`state/layer-on.ts` maps the `filters.show*` + `layers.enabled`
switches to one `LayerOn`). Lens presets are not persisted as the viewer's overlay choice (`partializeLayers`).
- **Shell** (`App.tsx` + `src/shell/`): `Header` (brand · `LensTabs` · SearchBar in map lenses · Live badge · Copy link
  · `MoreMenu` — an ARIA menu with Network summary, Weather monitor, Data table, Data quality, About & sources).
  Map lenses: desktop docks the lens panel left of the map (`LensSidePanel`, collapsible, `apgg-lens-panel`) with map
  tools / Inspector / table pill floating over the map (`MapLensOverlays`); phone = search + tools on top and ONE
  `BottomSheet` (peek / half / full, pointer drag + snap, handle is a button) holding the Inspector (`variant="sheet"`),
  the nearby list or the lens panel. `map-helpers.framing` frames flights above the half-open sheet on phones.
- **Panels** (`lenses/panels.tsx`): Explore (`ExplorePanel` — Start here, network at a glance, layers + legend) and
  Field (`FieldPanel` — near me, trace via search, layers) are inline; Storm (`StormPanel`, the Weather monitor body
  in compact form — the full situation panel is phase 5) and Plan (`workspaces/mis/MisWorkspace.tsx`) are lazy.
  `StartHere` cards are dismissible per lens (`apgg-start-<lens>`).
- **Plan / map embedding**: `MapPane` renders the shared map in `full` (map lenses), `embedded` (split) or `hidden`
  (collapsed) modes; the collapse is `mapLayout` (`open|collapsed|atlas-only`). The map column keeps its place in
  App's tree, so the map is never re-created across lens switches. Desktop split is **drag-resizable**
  (`shell/PlanChrome.tsx` `PaneSplitter` + `useMapPaneWidth`, localStorage `dss-map-pane-w`, clamped to
  `[320, innerWidth−380]`); on a phone the map stacks above the MIS (42 dvh). `LENS_LAYER_PRESETS` (in
  `map/layer-presets.ts`) declares which overlay groups a lens's map may mount (all, today). An analysis view that needs
  overlay DATA without showing the layer calls `useResource(generationRes)` / `useResource(powerGridRes)`.
- **`workspaceContext`** (store) carries cross-workspace focus. URL-synced (only in the Plan lens, `lens=plan`): `misBy`
  (`by=`, default circle), `misFilters` (`mf=`, the drill path `dim:value~dim:value`), `misTab` (`tab=`),
  `misTheme` (`th=`; v1 `theme=`). Transient, never in the URL: `misMap` (thematic classes + scope ids for the map) and
  `fit` (`{key, bounds}` — `useMapCamera` fits once per new key).

- **Network MIS** (`workspaces/mis/`) — an analyst's view of the network built on the live GIS data
  (the old parquet-based MIS is dead: the PSP feed stopped at 2026-06-11).
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
  - **Supply security** (`supply-security.ts` folded into `SsRow.supply/openEnds/cutIslands` and
    `LineRow.corridorBridge/corridorCircuits`): `supply` pivot dimension, "Radial" breakdown column,
    `radialRows` (risk flags: single circuit, coastal < 25 km, feed ≥ 35 yrs, radial ≥ 50 km, ≥ 10 × 33/11 SS,
    data gap), `pocketRows` (ranked by 33/11 kV load at risk), `cutRows`, and `MapFocus` builders
    (`feedPathFocus` / `pocketFocus` / `cutFocus`). The **Radial feeds** tab (default) + **Radial feeds** map
    theme (red = single-circuit, orange = single-corridor). A `MapFocus` is transient workspace state that
    overrides the scope dimming + fit (chip in the scope bar clears it; re-scoping clears it).
  - **Search** (`MisSearch.tsx`, `/` to focus): circles/zones/divisions (→ drill), TRANSCO SS + lines
    (→ dossier + fly), DISCOM 33/11 kV SS (→ the TRANSCO SS that feeds it, via `transco-33kv.json`).
    Picking a core asset scrolls the dossier into view.
  - UI: `MisWorkspace.tsx` (sticky search + map-theme switch, drill breadcrumb, KPI tiles, breakdown, thematic tabs,
    register, provenance footer), `tables.tsx` (`Breakdown` pivot — click row = drill + auto-regroup via
    `nextDim`; `Register` — paginated SS/line lists, hover = map hover, click = dossier + fly), `themes.tsx`
    (Radial feeds · Asset age · N-1 exposure · 33 kV downstream · Conductors & rating · Generation & interfaces
    — the last one opens with the interface connection-security matrix),
    `inspector-ext.tsx` (MIS sections for the Inspector, which MIS renders inline where the dossier was: N-1 facts,
    supply-security box with "Show feed path" / bus-outage island, circuits with ages, corridor-risk callout),
    `charts.tsx` / `ui.tsx` (dependency-free SVG/HTML marks per the dataviz conventions; voltage palette for
    stacks, validated blue ordinal ramp for age). Every view has a CSV export.
  - Map (`map/mis-layers.ts`): `mis-line-theme` + `mis-ss-theme` ride the CORE sources via feature-state
    (`misC` class / `misV` value), filtered to the scope; themes = line age (ordinal ramp, reversed on
    dark/satellite), N-1 (status red/orange: bridges, cut-point / single-fed rings), 33 kV load
    (proportional circles ∝ √ 33/11 SS served). Out-of-scope features are dimmed through `spotlightSpec`
    (a selection spotlight, when armed, wins).
  - Pagination is the shared `usePager`/`PagerBar` in `components/Pager.tsx` (also used by the Atlas
    `DataTableSheet`).
  - **Voltage slicer + multi-value filters**: `ScopeFilter` is `{dim, values[]}` (OR within a dimension; hash
    `mf=voltage:400,220~circle:Kadapa`, old single-value links still decode). The voltage slicer (`VoltageSlicer`,
    Grafana-style multi-select) is kept OUT of the breadcrumb and always applied FIRST (`withSlicer`) — order
    matters for line-only/SS-only filters. Topology (radial / N-1) is never recomputed on a slice.
  - **Drill-down on every number** (`drill.ts`, pure; `DrillPanel.tsx`): every printed figure is a `MetricId`
    (`<DrillNum>` / `StatTile metric=` / `VoltageSegBar partMetric=`, via `DrillContext`) that resolves to its
    records (SS / lines / 33/11 kV SS / 33 kV feeders / interfaces), optionally narrowed to a breakdown group
    (`groupScope`). The panel lights the records on the map (`recordsFocus`), exports CSV and offers "Apply as
    filter" where `METRICS[id].asFilter` captures the set exactly. **`drill.test.ts` reconciles every metric
    against the figure it labels on the real `public/data`** — add new figures there when you add a metric.

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
- **MapLibre + Tailwind v4 CSS layering**: MapLibre's unlayered `.maplibregl-map { position: relative }`
  beats Tailwind's layered `.absolute`. Size the map container with `h-full w-full`, NOT `absolute inset-0`.
- **MapLibre paint expressions**: `["zoom"]` must be the TOP-LEVEL input of `interpolate`/`step`.
  To scale by feature-state, fold the factor into each interpolate stop output (see `layers.ts`
  `zoomInterp`), don't wrap the interpolate in `["*", …]`.
- Pin **maplibre-gl `^5`** (v6 is WebGL2/ESM-only breaking), **Tailwind v4** (class-based dark via
  `@custom-variant dark` in `index.css`), latest **@tanstack/react-table v8**.
- **Tailwind v4 toggle switches**: don't position a thumb with arbitrary `translate-x-[…]` — v4 maps
  it to the `translate` CSS prop and it collided with `left`. Use an inline `style={{transform}}`
  (see `layers/ui.tsx` `Switch`).
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

## Deploy

`.github/workflows/deploy.yml` publishes `dist/` to Pages on push to `main` (it runs `build:data` →
`npm test` → `build`); a parallel, non-blocking `e2e` job runs the Playwright smoke suite against the build
and uploads traces on failure. Vite `base` is `/ap-gis-grid/` (override via `BASE_PATH` env — `/` for a
user/org site, `/<repo>/` if renamed). Repo: Settings → Pages → Source = GitHub Actions.

## Design docs

In-repo design specs live under `docs/specs/`: **`2026-11-05-atlas-2-design.md`** (the current Atlas 2.0
revamp — lenses, platform core, phases, budgets; keep its progress table current) and
`2026-06-11-dss-revamp-design.md` (the earlier multi-workspace DSS shell, partly superseded). Read the relevant spec before reworking a feature it covers.

## Where non-repo artifacts live

Memory, plans, and transcripts are stored globally under `~/.claude/` (keyed by this project's
path), not in the repo — intentionally, so they aren't committed.
