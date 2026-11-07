# Grid Atlas 2.0 — "One map, three missions" (design)

**Date:** 2026-11-05 · **Status:** Approved (design) · **Owner:** Praveen Chand
**Supersedes:** the workspace model of `2026-06-11-dss-revamp-design.md` (its static-first envelope still holds).

## Progress

| Phase | Scope | Status |
|---|---|---|
| 0 | Groundwork & hygiene (retire dormant code, e2e safety net, v1 hash contract, docs truth-up, baseline) | done — PR #14 |
| 1 | Platform core (resource loader, store slices, pure layer specs, sync engine) | done — PR 1 (resource loader + search worker) done, PR #15 · PR 2 (store slices) done, PR #16 · PR 3 (pure layer specs) PR #17 · PR 4 (engine for overlays) PR #18 · PR 5 (engine for everything + one interaction handler; MapPane 586 → 164 lines) PR #19 — **done** |
| 2 | Inspector adapters + URL v2 | **done** — PR 6 (Inspector adapters + What's here; DetailPanel / Dossier / NetworkTracePanel / popups deleted) PR #20 · PR 7 (URL v2: push/replace history, camera, `lyr=`, Copy link; v1 links rewritten) PR #21 |
| 3 | Lens shell, layer catalogue, omnisearch / ⌘K, trust & help layer | **done** — PR 8 (lens registry + shell: 4 lenses, header + ⋯ menu, docked lens panel, phone bottom sheet, Plan phone stack; `lyr` relative to lens defaults) PR #22 · PR 9 (layer catalogue drawer, zoom-aware legend, filter chips, solo, opacity) PR #23 · PR 10 (⌘K omnisearch: one combobox over assets, distribution, places, areas → Plan, layers, actions, lenses; SearchBar + MisSearch removed) PR #24 · PR 11 (trust & help: Indicative chips + method cards, glossary, `?` shortcuts, one Dialog with focus trap, one toast system, shared states, axe WCAG 2.2 AA in e2e) PR #25 |
| 4 | Vector-tile directories, service-worker rework, Field offline pack, ETL split | in progress — PR 13 (generated service worker: content-versioned data URLs, build-hash caches, precached assets, LRU caches by count + bytes, Range bypass, offline e2e); PR 12 (static vector tiles for 11 kV, towers, DISCOM 33 kV, RTGS ≥ 300 KB via tippecanoe in CI / Docker; sidecar shards for the Inspector; GeoJSON fallback; 11 kV feeder pick ≈ 30 KB gz shard + tiles, was 3.1 MB gz) |
| 5 | Storm / Field / Plan mission depth | planned |

## Baseline (2026-11-05, before the revamp)

Measured with Playwright against `vite preview` on localhost (no network latency, no gzip — raw bytes):

| Metric | Value |
|---|---|
| Time to core grid drawn | ≈ 2.3 s |
| Longest main-thread task during load | ≈ 400 ms |
| Initial data | 3.64 MB raw / ≈ 974 KB gz (`lines.geojson` = 94 %) |
| Shell JS | 1.50 MB raw / ≈ 433 KB gz (maplibre 285 KB gz) + CSS 18 KB gz |
| 11 kV feeder pick | whole `discom-11kv-lines.geojson`: 20.1 MB raw / 3.14 MB gz, parsed on the main thread |
| Lazy search indexes on first focus | `places.json` 471 KB gz + `search-network.json` 422 KB gz |
| `public/data` total | ≈ 80 MB, all GeoJSON / JSON (no tiles) |

Budgets the revamp is held to are listed under **Verification**.


## Context

The app has grown feature by feature: Atlas, then the Network MIS, live sync, DISCOM 33/11 kV, 11 kV and DTR
trace, towers, RTGS reference layers, weather and cyclones, and supply security. Each feature brought its own
panel, store, loader and map wiring. The result is powerful but hard to use:

- **About 57 switches** sit in one scrolling sidebar.
- There are **4 search boxes**, **3 voltage filters that aren't linked**, **4 kinds of detail view** (DetailPanel,
  MIS Dossier, NetworkTracePanel, MapLibre popups) and **2 summary dashboards** (Atlas Summary and MIS KPIs).
- Jargon is explained only in hover-only `title` text.
- **Browser Back leaves the app**, and the map view and overlays can't be shared by link.
- MIS has no phone layout.
- The 20 MB 11 kV GeoJSON loads whole to show one feeder.

Under the hood:

- 2 stores and about 7 lazy-load patterns.
- 2 separate mechanisms for re-adding layers after a style reload, plus 3 copies of the hover/click code.
- 80 MB of untiled GeoJSON, all parsed on the main thread.

The owner wants one integrated product serving **field/O&M engineers (phone)**, **planners and management
(desktop)** and **control-room / disaster ops**. Every existing feature stays reachable, but the UI should feel
uncluttered. They approved a **deep re-architecture**, staying **public and static** on GitHub Pages.

**Decisions taken**

- **Primary user:** an integrated product for all three groups.
- **Scope:** deep re-architecture.
- **Hosting:** stays public and static.
- **Pain point:** too many buttons and toggles, while keeping every feature available.
- **Privacy:** keep the AB-switch and DTR pole data as they are.
- **Dormant code:** retire all of it, archived on a branch.

## North star and design principles

Drawn from the research (sources in Appendix A):

1. **One map, task "lenses", one inspector.** This follows Esri Experience Builder's section views and the
   advice to give each audience a cut-down product.
   - A lens is a preset of layers, a side panel, KPIs and a legend.
   - Everything else stays one keystroke away (⌘K) or in the layer catalogue. Nothing is removed, only
     moved behind a lens.
2. **Search first, map second.** PG&E's PSPS lesson is that "is my SS or feeder affected?" should be answered
   by a search result, not by reading the map. There will be one omnisearch over everything.
3. **Progressive disclosure.**
   - The legend shows only layers that are visible now and inside their zoom range (the ArcGIS
     `respectLayerVisibility` pattern).
   - The catalogue holds the other 50 or so layers.
   - Alt-click solos a layer (Felt).
4. **Phones get a cut-down product, not a squeezed desktop.**
   - A bottom sheet with peek, half and full heights (Material / iOS detents).
   - Tapping the map lists everything there ("What's here").
5. **Critical caveats up front and specific** (UK OSR guidance; Our World in Data "About this data"; Electricity Maps
   `isEstimated`).
   - Every derived number carries an *Indicative* tag that opens its method, source, vintage and coverage.
   - One glossary that also works on touch.
6. **Everything has a URL.** Lens, view, layers and selection, with real Back and Forward
   (the geo.admin `layers=` pattern).

## Target experience

### The shell (desktop)

```
┌ Header: AP-TRANSCO Grid Atlas │ [Explore][Field][Plan][Storm]  ⌘K search………  Live● ⓘ ⋯ ┐
├──────────┬─────────────────────────────────────────────────────────┬──────────────────┤
│ Lens     │                     MAP (always)                        │ Inspector         │
│ panel    │   map tools: measure · nearby · what's-here · share     │ (one component,   │
│ (per     │                                                         │  tabbed sections) │
│  lens)   │   Active-layers legend (bottom-left, only what's on)    │                   │
├──────────┴───────────── optional bottom drawer: Data table / MIS register ───────────────┤
```

On a phone the map runs full screen, with search and lens chips on top, and the lens panel and Inspector in one
bottom sheet with peek, half and full heights.

### The four lenses

Each lens is a registry entry. The shell stays agnostic, as today's `workspaces/registry.ts` is.

| Lens | Primary user | Default layers | Lens panel | Absorbs today's |
|---|---|---|---|---|
| **Explore** (default) | Everyone | Core grid, labels | Network at a glance (KPIs), quick filters (voltage, circle, coast), "Start here" cards | Atlas sidebar and Summary modal |
| **Field** | O&M on phones | Grid, towers (z≥9), 33/11 kV, 11 kV feeders (tiled), satellite toggle | Near me (locate), trace from DTR or feeder up to TRANSCO SS, "Navigate here" (geo: / Google Maps link), offline pack per circle | Nearby, NetworkTracePanel, towers popups, measure |
| **Plan** | Planners, management | Grid with the MIS theme (Radial / Age / N-1 / 33 kV load / Conductors / Interfaces) | The full MIS: pivot, drill, KPIs, register, drill-panel, CSV export | Network MIS workspace, DataQuality view, Atlas Summary resilience block |
| **Storm** | Control room | Grid, cyclone track, cone and swaths, radar, coastal bands, CRZ, cyclone shelters, flood extent | "Situation": active systems, then SS in the warning area (cone plus the coastal band, not just the cone edge), then radial pockets and cut points exposed, then downstream 33/11 kV SS and feeders at risk, then 13-circle conditions, sea state and 3-day outlook; printable briefing | WeatherView modal, weather overlay, DetailPanel "weather now" |

Lenses never hide features: a lens only picks the default layers and the panel. The full layer catalogue and
⌘K work in every lens, and switching lens keeps the current selection and filters.

### Cross-cutting UX components

- **Omnisearch and command palette (⌘K, `/`).** One input and one engine across:
  - TRANSCO SS and lines, plants, PGCIL, RTSS, HT
  - DISCOM 33/11 kV SS and feeders, 11 kV feeders, DTR codes
  - places
  - circles, zones and divisions (which drill into Plan)
  - layers ("towers", "flood"), which toggle them
  - actions ("export lines CSV", "share view", "dark basemap", "glossary")
  - lenses

  Results are grouped and keyboard-navigable as an ARIA combobox. Indexes parse in a worker. It replaces SearchBar,
  MisSearch and the network search; the table and drill-panel filters stay, as local list filters.
- **Layer catalogue drawer** (replaces the 57-switch sidebar).
  - **Active** shows what's on, with its legend, opacity, solo and remove.
  - **Catalogue** is grouped: Transmission, Distribution, Generation and interfaces, Weather and hazards,
    Boundaries, Transport, Environment, Water. It has a search filter and shows each layer's size, zoom range
    and source/vintage.
  - Mutually exclusive groups for themes.
  - The basemap sits in the drawer footer.
- **Global filter bar** with voltage, circle and coast. It is shared by the map, data table, Plan pivot (today's
  VoltageSlicer) and Storm counts, and appears as compact chips under the search box.
- **Unified Inspector** for any feature, built from adapters that return sections:
  - Overview
  - Connectivity / trace
  - Supply security
  - Downstream 33/11 kV
  - Towers
  - Weather now
  - Risk & age
  - Exports (CSV/GeoJSON)
  - Provenance

  It replaces DetailPanel, the Dossier, NetworkTracePanel and the overlay popups, keeps a breadcrumb
  history and is deep-linkable.
- **What's here.** A tap or right-click runs `queryRenderedFeatures` on a ~16 px box and lists every feature
  there, which solves thin-line taps on phones. With one hit it opens the Inspector directly.
- **Trust layer.**
  - `<Indicative method="capacity">` chips open a method card: rule, source, vintage, coverage and
    a link to the glossary.
  - `/glossary`, with entries such as N-1, bridge, cut point, radial-SC/DC, ckm vs route-km, coastal band,
    inferred link methods and DLR.
  - Explanations that work on touch: popovers, not `title`.
- **Share and export.** Copy link with the full view, print or PDF a lens (Storm briefing, Plan KPI page) using
  print CSS, plus the existing CSV/GeoJSON exports.
- **Help.** A first-run "Start here" card per lens (dismissible), a shortcut sheet (`?`), and empty, loading
  and error states built from shared components, with a single toast system for errors and the "data updated"
  notice.
- **Accessibility to WCAG 2.2 AA.** Focus trap and Escape in every dialog and sheet, combobox semantics,
  keyboard-reachable table rows, and a "list view" alternative for map features (the data table).

## Target architecture

```
ETL (build:data, split per domain) ─┬─▶ public/data/core/*.json|geojson   (analytics core: SS, lines, meta, indexes)
                                     └─▶ CI: tippecanoe ─▶ public/tiles/<layer>/{z}/{x}/{y}.pbf (display-only heavy layers)
Browser:  resources (one loader, worker parse) → store slices → LayerRegistry + MapSync engine → MapLibre
                                                     ↘ URL v2 (pushState/replaceState)        ↘ Inspector adapters
          lens registry (Explore/Field/Plan/Storm) → shell (header · lens panel · map · inspector · drawer)
```

**Heavy layers as static vector-tile directories, not PMTiles.** The research found that the GitHub Pages / Fastly
CDN can serve range requests sliced from gzip-encoded copies, which breaks PMTiles intermittently (DocGerd/sail_command#27).
Static `z/x/y.pbf` directories need no range requests and cache per tile in the service worker, which also makes a
**per-circle offline pack** possible for the Field lens.

- **Build:** run tippecanoe in `deploy.yml`, installed with apt on the runner, so nothing is installed globally on the
  owner's machine. Use `--no-tile-compression` so Pages' own gzip doesn't double-encode, plus
  `-zg --drop-densest-as-needed`.
- **Not committed:** tiles are built in CI. Locally, `npm run build:tiles` uses Docker if it's present; otherwise the
  registry falls back to the existing GeoJSON for that layer, so dev always works.
- **Candidates for tiling:**
  - 11 kV lines (20 MB)
  - towers ×3 (10 MB)
  - DISCOM lines and SS (5.7 MB)
  - RTGS reference layers (17 MB)

  Core `lines.geojson` and `substations.geojson` stay GeoJSON, because the analytics need full geometry and
  attributes.
- **Attributes still come from JSON.** The Inspector fetches the full attribute row from the existing per-layer
  JSON or shards by id. Tiles carry only id, class and label fields.

### Platform core (code-grounded design)

**1. Layer registry and sync engine** (`src/map/registry/{types,core,overlays}.ts`, `src/map/engine.ts`)

```ts
type Band = "beneath" | "grid" | "above-grid" | "top";
type SourceSpec =
  | { kind: "geojson"; resource: ResKey; promoteId?: string }
  | { kind: "geojson-url"; url: string }                       // MapLibre's worker parses (11 kV until tiled)
  | { kind: "vector"; tiles: string; sourceLayer: string; promoteId?: string; fallback?: SourceSpec }
  | { kind: "raster"; tiles: (s: Root) => string[] | null; maxzoom: number }
  | { kind: "computed"; derive: (s: Root) => FeatureCollection; key: (s: Root) => unknown }
  | { kind: "ride"; on: string };                              // reuse another def's source
interface LayerDef {
  id; group; label; source: SourceSpec; band: Band; layers(ctx): LayerSpecification[];
  visible(s): boolean; filter?(s); paint?(s); featureState?(s);
  interaction?: { layers: string[]; priority: number; adapter: InspectorKind };
  legend?: LegendSpec; minzoom?; approxBytes; hashId?; lenses?: LensId[];
  provenance: { source; vintage?; method?: MethodId };
}
```

- **Generalise the existing sync loop.** `attachEngine(map, getDefs)` builds on the `sync()` loop in `overlays/map.ts`:
  - one `reconcile()` per animation frame, triggered by store changes, `styledata` and `idle`;
  - a `WeakMap` record of the last value written per def, so the engine **writes only when a value differs**.
    This is essential: `applyMisTheme`, `applySpotlight`, `applyFilters` and `addWeatherLayers` all write
    unconditionally today and would loop.
- **After a style reload,** a missing source clears its def's record, so the def is re-added and its values
  re-applied.
- **Z-order** comes from four empty "sentinel" layers, one per band, which replaces the `moveLayer` reordering.
- **Feature-state** is diffed per (source, key). One mechanism covers hover, selected and the MIS themes.
- **One click/hover handler,** in priority order: tower > core SS > core line > plant/PG > DISCOM pt > DISCOM
  line > fills. It replaces the 3 copied bindings in `MapPane.tsx` and every popup in `overlays/map.ts`.
- **How the existing layers map onto it:**
  - The core grid's `applyFilters` and `applySpotlight` become pure `filter`/`paint` functions.
  - Generation and the 3 power-grid classes become defs.
  - Radar becomes a `raster` def (setTiles when the URL fingerprint changes), cyclone a `computed` def, and the
    `wx-risk` halo a `ride` def on the core SS source.
  - The MIS themes ride the core sources through `featureState`.
  - DISCOM, ref and tower layers are built from `OverlayDef`; ref defs are dynamic once `catalog.json` loads.
- **Stays imperative:** `MeasureController` (behind an `engine.onStyleReload` hook), the nearby `Marker`,
  camera commands (a one-shot camera queue) and toggling interaction handlers.
  **Target: `MapPane.tsx` under 200 lines.**

**2. One resource loader** (`src/data/resources.ts`) plus a worker (`src/workers/data.worker.ts`)

- **API:** `ensure(key, {signal})` and `useResource(key)`.
- **Behaviour:** de-dupes in-flight requests, retries twice with backoff, aborts when nothing references the
  request any more, and supports `refreshMs` with a visibility gate. That replaces the weather timer and the
  live-status poll.
- **Keys** can take parameters: `dtr:<shard>`, `spot:<cell>`, `overlay:<id>`.
- **Where loaded data lives:** the data stays in a module Map; the store keeps only `{status, version, error}`.
- **What it replaces:** all ~7 lazy-load patterns (gen/pg/wx/places status, overlay status and data, catalog,
  network-search promise and listeners, DTR shard Map, `connectivity.ts`, live-status, the spot-weather cache).
  It also **removes the duplicate DISCOM fetch** in `connectivity.ts`.
- **Worker:** parses JSON, runs `decodeTowers`, and builds and queries the search indexes (`places.json`,
  `search-network.json`). It returns only the top N results.

**3. Store slices** (`src/state/slices/*`, named hooks in `src/state/hooks.ts` with `useShallow`)

- **The slices:**
  - `resources`
  - `selection`: `{ref: FeatureRef{layer,id}, hover, history}`, which absorbs `netFocus`
  - `view`: lens, mapLayout, basemap, camera, spotlight
  - `layers`: enabled, discoms, defs, focus, merged in from `overlays/store.ts`
  - `filters`: voltages, circuits, circle, coast, show, genTypes, wxLayers, scope. **One filter model**, read by the
    map, `DataTableSheet` (today it keeps its own copy), the Plan slicer and Storm.
  - `ui`: panels, plus `tool: measure-line|measure-area|nearby|null`
  - `ctx`: MIS state
- **No big-bang migration:** `useAppStore` and `useOverlayStore` become facades, and the 172 call sites move over
  file by file.
- **Persistence:** `persist` under the legacy key `apgg-overlays-v1`, with a custom `getItem` that wraps the old
  raw shape and a `migrate` step. A URL `lyr=` value wins over localStorage.

**4. URL v2** (`src/url/v2.ts`, `useUrlSync`)

- **Format:** `#@80.40,15.90,6.2z&v=2&lens=plan&sel=ss:s-xyz&lyr=generation,discom-lines,ref:districts,-ss&volt=400,220&circle=Vijayawada&coast=1&base=dark&by=…&mf=…&tab=…&th=…`
  - `lyr` lists only layers that differ from the lens defaults.
  - MIS keys are written only in the Plan lens.
- **History policy:**
  - `pushState` on selection, lens, drill action (once per action) or circle changes.
  - A 300 ms debounced `replaceState` otherwise. The camera is written only on `moveend` from the user.
  - `popstate` applies the state with `fromHistory`, so **Back works inside the app**.
- **Old links:** the current `parseHash` becomes `decodeV1`, so every v1 link still opens. The app then does one
  `replaceState` to the v2 form.
- **Less work per change:** re-serialise only when the URL-relevant slice changes, not on hover or measure updates.

**5. Inspector adapters** (`src/inspector/{types.ts, adapters/*.ts, Inspector.tsx}`)

- Each adapter provides `match / resolve / header / sections / locate`.
- Sections are plain data: `fields | trace | actions | custom`, with ids overview, connectivity, supply,
  downstream, towers, weather, exports and provenance.
- **Adapters:**
  - `core-ss`: absorbs DetailPanel, `DiscomDownstream`, the weather-now line, and the MIS `SupplyBox` as a lens
    extension, so the Dossier disappears.
  - `core-line`, with `LineTowers`.
  - `plant`.
  - `pg` ×3.
  - `discom-ss`, `f33`, `f11` and `dtr`, using a `trace` section built from today's `chain`. This absorbs
    NetworkTracePanel.
  - `tower`.
  - `ref`, which absorbs `popupHtml` as data with no HTML escaping.
- Because sections are data, they can be unit-tested.

## Phased delivery

Each phase is one or more PRs on a `feat/atlas2-*` branch that leave the app working, typecheck clean and tests
green. The order is foundation, then the visible UX, then depth.

### Phase 0 — Groundwork and hygiene (2 PRs)

**Retire dormant code** after cutting `archive/dormant-2026-11` from `main`. Remove:
- `src/lib/dcflow.ts`, `src/lib/risk-engine.ts` and their tests
- `public/data/wind-zones.geojson`
- `src/data/manifests.ts`, `components/FreshnessBadge.tsx` and `MethodCard.tsx`
- the `map/MapView.tsx` shim
- `pipelines/` and `.github/workflows/pipelines.yml`
- the `pipelines*` npm scripts
- the dependencies `@duckdb/duckdb-wasm`, `echarts`, `@duckdb/node-api`, `xlsx`, `node-html-parser` and `undici`,
  after grepping to confirm each is used only by pipelines

Keep `dlr.ts`; it is live in DetailPanel. The remote `data` branch is **left alone**, and deleting it is a separate,
explicit step.

**Safety net:**
- Add `@playwright/test` as a devDependency, `e2e/smoke.spec.ts` against `vite preview` (Chromium with
  swiftshader, plus a `window.__map` hook behind `?e2e`) and a non-blocking CI job.
- Add v1 hash fixture tests.

**Small fixes:**
- Correct the `DISCOM11_DEF.bytes` value (it says 3.1 MB; the file is 20 MB).
- Make the header title "Grid Atlas", not "DSS".
- Write the design doc `docs/specs/2026-11-05-atlas-2-design.md`, a polished version of this plan.
- Bring `CLAUDE.md` up to date: document the 11 kV, DTR and network-search features and `sync-network.mts`; note
  that dlr is live; correct the MapView and manifests notes; drop the dormant sections.

**Record a performance baseline** (initial gz payload, time to interactive, cost of an 11 kV pick) in the spec.

### Phase 1 — Platform core (5 PRs, from the design above)

1. **Resource loader and worker.** Migrate connectivity, network search, DTR shards, live status, places and spot
   weather. This removes the duplicate DISCOM fetch.
2. **Store slices** behind facades, with `persist` on the legacy key. The gen, pg and wx statuses move to
   `resources`. `DataTableSheet` reads the shared `filters`.
3. **Pure spec functions.** Rewrite `applyFilters`, `applySpotlight`, `applyMisTheme` and the weather functions
   as pure `spec(state)` functions, with unit tests.
4. **Engine for overlays only:** it replaces `attachOverlays.sync`, with identical behaviour.
5. **Engine for core, generation, power grid, weather and MIS.** Delete the `mount*`/`bind*` functions, use the
   single interaction handler, and slim MapPane down.

### Phase 2 — Inspector and URL v2 (2 PRs)

6. **Inspector adapters.** Delete DetailPanel, Dossier, NetworkTracePanel and the overlay popups; add the "What's
   here" multi-hit list.
7. **URL v2,** with push and replace, the camera and `lyr=`, plus a "Copy link" action.

### Phase 3 — The new shell UX (4 PRs; this is where the "too many buttons" problem goes away)

8. **Lens registry and shell.**
   - `src/lenses/registry.ts` replaces `workspaces/registry.ts`. Each lens has an id, label, icon, defaultLayers,
     a Panel (lazy) and `startHere`. Explore and Field are inline; Plan (the MIS chunk) and Storm are lazy.
   - Header: title, lens tabs, ⌘K, Live badge, a ⓘ/glossary button and an overflow menu (Quality, About,
     Shortcuts).
   - Desktop: lens panel, map, Inspector. Phone: a bottom sheet with peek, half and full heights, using pointer
     drag with snap points, no new dependency.
   - Plan keeps the resizable split (`PaneSplitter`) and gets a phone layout of stacked cards.
   - *As built (PR 8):* `src/lenses/registry.ts` is pure data (panels in `lenses/panels.tsx`); the MIS code stays in
     `workspaces/mis/`. Field's defaults leave out 11 kV feeders until they are tiled (phase 4); Storm's leave out
     the 2024 flood extent (a past event, one click away in the layer list). `lyr` is encoded relative to the lens
     defaults (Explore / Plan preset only the core grid, so every phase-2 link keeps its meaning), and lens presets
     are not persisted as the viewer's overlay choice. Search stays `SearchBar` (in the header on desktop) until
     PR 10, and the lens panels reuse the current layer list until PR 9.
   - *As built (PR 9):* `src/layers/` — pure `catalogue.ts` + `LayerDrawer` / `MapLegend` / `FilterChips`; the map
     toolbar holds Layers, the filter chips and Measure / Nearby (which moved off the top-centre). Opacity is offered for
     the catalog overlays and the radar (the core grid's opacity already carries the spotlight / scope dimming). The
     Plan pivot keeps its own voltage slicer for now (it scopes the analysis, not just the map); unifying it with the
     global chips is left to the Plan mission (phase 5).
   - *As built (PR 10):* the palette is the header search box itself (focused by ⌘K / `/`), not a separate modal —
     one input, one result list. Glossary entries join ⌘K in PR 11. Plants and the POWERGRID classes are loaded on
     first search focus (≈ 145 KB gz) so they are findable without switching their layers on.
   - *As built (PR 11):* method cards + glossary are data (`src/content/`); the accent colour was darkened (light) /
     lightened (dark) with a separate on-accent text colour to pass WCAG AA contrast; axe (serious + critical) gates each
     lens in e2e. The on-demand dialogs were code-split to keep the shell under the 450 KB gz budget (≈ 441 KB).
9. **Layer catalogue drawer and active-layers legend.**
   - It replaces `MapLayerPanel`, `layer-controls.tsx` and `OverlaySections.tsx`, and is rendered from the
     registry: groups, search, size, zoom and vintage, solo with Alt-click, and opacity.
   - The global filter bar (voltage, circle, coast chips) sits under search.
10. **Omnisearch and ⌘K palette.**
    - It replaces SearchBar, MisSearch and the network-search UI, and is an ARIA combobox.
    - Result groups: Assets, Distribution, Places, Areas (circle/zone/division drill into Plan), Layers, Actions
      and Lenses.
    - It warns about partial coverage in the results.
11. **Trust and help layer.**
    - `<Indicative>` chips and method cards: capacity, age, inferred connectivity, supply security, coastal band,
      DLR and the weather sources.
    - A glossary (`src/content/glossary.ts`, also searchable from ⌘K).
    - A "Start here" card per lens, the `?` shortcut sheet, one toast system (errors, "data updated", copied
      link), and shared empty, loading and error states.
    - An accessibility pass: focus trap and Escape in all dialogs, keyboard-reachable table rows.

### Phase 4 — Data delivery and offline (3 PRs)

12. **Vector-tile directories in CI.**
    - `scripts/build-tiles.mts` drives tippecanoe: install it with apt in `deploy.yml` (or build it from source
      and cache it), run it with `--no-tile-compression -zg --drop-densest-as-needed`, and write to
      `public/tiles/<layer>/` (git-ignored).
    - Order: 11 kV, then towers, then DISCOM, then `ref/`.
    - Attribute sidecars by id for the Inspector, e.g. `discom-11kv-attrs.json`.
    - Fly-to bounds come from the sidecars, not from clipped tile geometry.
    - The registry falls back to GeoJSON when tiles are missing in local dev.
13. **Service-worker rework.**
    - Build-hash `VERSION`, injected by Vite.
    - Bounded data and tile caches (LRU by count and bytes).
    - Network-first for `meta.json`/`live-status.json`, so the first view after a deploy is fresh.
      *(Done instead by content-versioning every data URL — `?v=<hash>`, cache-first — so meta and the files it
      describes can never disagree; only `live-status.json` stays unversioned and network-first.)*
    - Bypass any request with a Range header.
14. **Field offline pack.** "Save circle for offline" pre-fetches that circle's tiles from z9 to z15, plus its
    sidecar rows, into the tile cache, and shows progress and the size.

Split `scripts/build-data.mts` (1,706 lines) into per-domain modules (`etl-core`, `etl-overlays`, `etl-places`,
`etl-towers`) in the same phase.

### Phase 5 — Mission depth (3 PRs)

15. **Storm situation panel.** It uses only live engines (risk-engine is retired, as decided).
    - Active GDACS systems.
    - SS in the warning envelope: cone ∪ (coastal band ≤ 1 ∧ within N km of the track). This answers the NHC
      lesson that people outside the cone think they're safe.
    - Exposed radial pockets and cut points (`supply-security.ts`).
    - Downstream 33/11 kV SS and feeders at risk (`transco-33kv.json`).
    - 13-circle conditions, sea state and the 3-day outlook.
    - Status uses the FEMA-style grey for "no information".
    - A **printable briefing** (print CSS, timestamp, sources).
16. **Field mission.**
    - Near me, with the 6 nearest SS and a compass bearing.
    - "Navigate" deep links (`geo:` and Google Maps).
    - Trace up and down from DTR or feeder to the TRANSCO SS.
    - Satellite plus towers presets, and big touch targets.
17. **Plan mission.**
    - The MIS folds in the Atlas Summary resilience and coast blocks and DataQuality as tabs, so there are no
      duplicate dashboards.
    - A one-page printable KPI report per scope.
    - Every number is drillable (the existing `drill.ts`).

## Critical files

- **Replaced:**
  - `src/map/MapPane.tsx`, `src/map/layers.ts`, `src/map/mis-layers.ts`, `src/map/weather-layers.ts`,
    `src/overlays/map.ts`
  - `src/state/store.ts`, `src/overlays/store.ts`, `src/url/hash.ts`, `src/url/useHashSync.ts`
  - `src/App.tsx`, `src/components/{DetailPanel,NetworkTracePanel,SearchBar,MapLayerPanel,layer-controls,OverlaySections,SummaryView,WeatherView,DataQualityView,BrandHeader}.tsx`
  - `src/workspaces/{registry.ts,mis/MisSearch.tsx,mis/Dossier.tsx}`
  - `public/sw.js`, `.github/workflows/deploy.yml`
- **Reused as-is (pure, tested):**
  - `src/lib/{geo,graph,supply-security,capacity,dlr,format,export,weather,risk}.ts`
  - `src/data/graph-data.ts`, `src/data/network-search.ts` (logic), `src/overlays/towers.ts` (`decodeTowers`)
  - `src/workspaces/mis/{model,drill,tables,themes,charts,ui}.ts(x)`
  - `components/Pager.tsx`, `DiscomDownstream.tsx`, `LineTowers.tsx` (become Inspector sections)
  - `map/measure.ts`

## Verification

- **Every PR:** `npm run typecheck`, `npm test` (the existing ~243 cases minus the retired ones, plus the new ones
  below), `npm run build`, and `npm run e2e` (Playwright smoke).
- **New unit tests:**
  - v1 to v2 decoding fixtures, v2 round-trip, and push-vs-replace classification
  - the loader's de-dupe, retry and abort (mocked fetch)
  - the engine against a fake map: a second `reconcile` makes **zero writes**, layers are re-added after
    `setStyle`, and sentinel order holds
  - registry invariants: unique ids and hash ids, and every interactive def has an adapter and provenance
  - Inspector sections from fixture data
  - migration of the legacy localStorage value
- **Playwright smoke:**
  1. Load; the map reaches idle.
  2. ⌘K, search for a substation and select it; the Inspector appears and the URL has `sel`.
  3. **Back** clears the selection and you're still in the app.
  4. Enable 33 kV and the layer exists; switch basemap and the layers survive.
  5. A v1 deep link opens.
  6. Each lens loads.
  7. Phone viewport: the bottom sheet snaps.
  8. Accessibility checks (`@axe-core/playwright`) on each lens.
- **Performance budgets**, checked in the spec and the e2e run:
  - initial data under 1 MB gz (unchanged or better)
  - shell JS under 450 KB gz
  - an 11 kV feeder pick downloads under 300 KB after tiling (today 3.1 MB gz)
  - no main-thread JSON parse longer than 50 ms
- **Manual:** run `npm run preview` (not dev, per CLAUDE.md) at phone and desktop widths in light, dark and
  satellite, and use the Field offline pack in airplane mode.

## Out of scope and constraints kept

- No backend, login or paid APIs; the site stays public and static.
- No new map stack: MapLibre stays on `^5`.
- AB-switch and DTR pole data stay as they are (owner decision).
- Never import HT-consumer services (memory rule).
- Never bypass the token-protected GIS folders.
- All tooling is project-local; tippecanoe runs only in CI or Docker.

## Appendix A — research sources (spot-check before citing externally)

- **Audience views, layer groups and mobile:**
  - Esri Experience Builder views: https://gis.ncsd.sc.gov/arcgis/help/en/experience-builder/latest/configure-widgets/view-navigation-widget.htm
  - Esri layer groups: https://community.esri.com/t5/experience-builder-tips-and-tricks/five-ways-to-handle-groups-of-layers/ba-p/1343821
  - Esri Dashboards on phones: https://doc.arcgis.com/en/dashboards/latest/reference/dashboards-on-your-smartphone.htm
- **Utility and energy maps:**
  - PG&E PSPS address lookup: https://psps.ss.pge.com/
  - Open Infrastructure Map: https://wiki.openstreetmap.org/wiki/Open_Infrastructure_Map
  - EIA Energy Atlas: https://www.eia.gov/todayinenergy/detail.php?id=45697
- **Map UX patterns:**
  - Felt shortcuts (⌘K, solo): https://help.felt.com/getting-started/keyboard-shortcuts
  - ArcGIS Legend visibility: https://developers.arcgis.com/javascript/latest/api-reference/esri-widgets-Legend.html
  - MapLibre `queryRenderedFeatures`: https://maplibre.org/maplibre-gl-js/docs/API/type-aliases/QueryRenderedFeaturesOptions/
  - Material bottom sheet: https://developer.android.com/reference/com/google/android/material/bottomsheet/BottomSheetBehavior
  - Apple Maps HIG: https://developer.apple.com/design/human-interface-guidelines/maps
  - geo.admin URL state: https://docs.geo.admin.ch/map-viewer/url-parameters.html
- **Static tiles on GitHub Pages:**
  - PMTiles: https://docs.protomaps.com/pmtiles/
  - GitHub Pages range and gzip issue: https://github.com/DocGerd/sail_command/issues/27
  - GitHub Pages limits: https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits
  - tippecanoe: https://github.com/felt/tippecanoe
- **Storm and disaster operations:**
  - TPSODL Cyclone Arnab restoration: https://odishabytes.com/tpsodl-restores-power-to-over-17-lakh-consumers-in-southern-odisha-after-cyclone-arnab/amp/
  - FPL restoration-time map: https://fpl.com/storm/pdf/milton-etr-map-10-12.pdf
  - FEMA lifelines: https://www.fema.gov/lifelines
  - NHC cone graphic: https://news.miami.edu/stories/2024/02/cone-of-uncertainty-graphic-to-feature-more-information.html
- **Trust and caveats:**
  - UK OSR dashboard guidance: https://osr.statisticsauthority.gov.uk/guidance/regulatory-guidance-dashboards/pages/4
  - Official statistics in development: https://osr.statisticsauthority.gov.uk/policies/official-statistics-policies/official-statistics-in-development
  - Our World in Data "About this data": https://ourworldindata.org/grapher/annual-scholarly-publications-on-artificial-intelligence
  - Electricity Maps estimation flags: https://app.electricitymaps.com/docs/concepts/estimations
