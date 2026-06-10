# AP Grid Decision Support System — revamp design

**Date:** 2026-06-11 · **Status:** Approved (design) · **Owner:** Praveen Chand

Evolves the AP-TRANSCO Grid Atlas from a GIS+MIS lookup into a static-first, research/production-grade
**decision support system (DSS)**, expandable horizontally (new workspaces) and vertically (deeper
analysis per workspace), at zero hosting cost and zero ops.

## Decisions log (settled during brainstorming)

| Question | Decision |
|---|---|
| Infrastructure envelope | **Static-first, supercharged** — GitHub Pages stays the only host; DuckDB-WASM, PMTiles, GitHub-Actions-scheduled ingestion. No backend. |
| Decision domains | **Network planning · Risk & resilience · Operational MIS** (asset management and socio-economic lenses are future verticals, not in scope now except where free). |
| Data acquisition | **Full pipeline** — CI-scheduled scraping/parsing of official public reports (Grid-India PSP, CEA, Vidyut Pravah) into committed time-series, plus clean keyless APIs. |
| Product form | **Multi-workspace DSS** — Atlas · Risk Room · Planning Studio · MIS Dashboards over one data core; the current app becomes the Atlas workspace, unchanged. |
| Architecture | **Approach A** — monorepo workspace shell; pipelines write to a dedicated `data` branch (never `main`). |

## Goals

1. Support real decisions in three domains: where to reinforce the network, what to harden or
   protect before a hazard, and how the system is performing over time.
2. Stay static: GitHub Pages + GitHub Actions are the entire infrastructure. All analytics run
   in the browser.
3. Make expansion cheap and safe: adding a workspace or a dataset must not touch existing code
   paths (manifest + registry contracts).
4. Preserve the existing Atlas exactly as shipped — including its load profile (new code is
   lazy/code-split) and its honesty convention (every derived number labelled indicative, now
   extended with data-freshness vintages).

## Non-goals

- No backend, database server, API keys requiring payment, or authenticated data sources.
- No real-time SCADA/EMS integration — daily/monthly official publications are the MIS heartbeat.
- No authoritative power-system studies: DC load flow and contingency screens are **indicative
  research aids**, never operational engineering outputs, and are labelled as such.
- No multi-user accounts/collaboration layer (single decision-maker; sharing = URLs + exports).

## Architecture overview

```
GitHub Actions (cron)                         GitHub Pages (static app)
┌──────────────────────────────┐              ┌──────────────────────────────────────┐
│ pipelines/*.mts              │              │ Workspace shell (hash router, w= key)│
│  fetch→parse→validate→append │              │ ┌────────┬─────────┬─────────┬─────┐ │
│        │                     │              │ │ Atlas  │ Risk    │ Planning│ MIS │ │
│        ▼                     │   raw URLs   │ │(as-is) │ Room    │ Studio  │     │ │
│ data branch:                 │─────────────▶│ └────────┴─────────┴─────────┴─────┘ │
│  timeseries/*.parquet        │              │ Shared: store slices · ⌘K palette ·  │
│  tiles/*.pmtiles             │              │ search · freshness badges            │
│  manifests/*.json            │              │ Engines (lazy): DuckDB-WASM · graph  │
└──────────────────────────────┘              │ worker (DC flow) · risk engine       │
                                              └──────────────────────────────────────┘
```

## 1. Workspace shell

- `BrandHeader` gains a workspace switcher: **Atlas · Risk Room · Planning Studio · MIS**.
- Each workspace is a lazy React chunk (`React.lazy` + Vite manual chunks). Atlas keeps its
  current bundle; new workspaces load on first entry only.
- Routing: the existing versioned URL hash gains a `w=` key (`atlas` default). Workspace-local
  state lives in per-workspace Zustand slices, registered lazily (same contract as the
  generation/powergrid overlays). Cross-workspace state (selection, basemap, theme) stays global,
  so "open this SS in the Risk Room" round-trips work.
- Shared chrome: search box, basemap/theme switch, and a **⌘K command palette** (assets, places,
  layer toggles, actions, workspace jumps). The palette indexes the same sources SearchBar uses.
- **Freshness badges**: any view derived from pipeline data shows the dataset vintage (from its
  manifest) and an amber "stale" state when `lastSuccess` exceeds twice the refresh cadence.

## 2. Data platform

### Pipelines

New top-level `pipelines/` directory; each pipeline is a project-local `tsx` script with the shape
**fetch → parse → validate (hard asserts, like the ETL gates) → append/emit**. Pure parsing helpers
live beside the pipeline and are unit-tested against **committed fixture files** (a real saved copy
of each source document), so source-format drift is caught by tests, not in production.

| Source | Cadence | Content | Output |
|---|---|---|---|
| Grid-India (POSOCO) daily PSP report | daily | Regional + AP demand met, peak, energy, frequency profile, interchange | `timeseries/psp-daily.parquet` |
| Vidyut Pravah | daily | State demand/supply snapshot, price signal | `timeseries/vidyut-daily.parquet` |
| CEA monthly reports | monthly | Installed capacity + generation by fuel, AP + national | `timeseries/cea-monthly.parquet` |
| ERA5 / Open-Meteo climate normals | one-time/annual | Temperature/wind normals at circle centroids (DLR + hazard context) | `timeseries/climate-normals.parquet` |
| Copernicus DEM (GLO-30) | one-time | Low-lying coastal cells + slope → flood-proxy raster | `tiles/flood-proxy.pmtiles` |
| NASA FIRMS archive | annual | Fire-density climatology near line corridors | `tiles/fire-density.pmtiles` |
| WorldPop / GHSL | annual | Population & built-up density (demand proxy, siting, criticality) | `tiles/population.pmtiles` |
| WRI Global Power Plant DB | annual | Cross-check of the generation overlay (capacity MW fills a known gap) | `manifests/gppd-crosscheck.json` |
| IS 875 wind zones | one-time | Basic wind-speed zone polygons (digitised once, committed) | `manifests/wind-zones.geojson` (few simple polygons — geojson, not tiles) |

### Storage & delivery

- All outputs are committed to a dedicated **`data` branch** — `main` history stays clean. The app
  fetches via the branch's raw GitHub URLs (CORS-clean). Parquet appends are performed in CI with
  project-local DuckDB (dev-dep).
- Every dataset has a **manifest**: `{ id, schema, source, licence, attribution, cadence,
  vintage, lastSuccess, paths }`. Consumers read manifests only — never raw source URLs.

### Failure handling

- A failed pipeline run auto-opens (or updates) a labelled GitHub Issue with the parse error and
  a fixture-capture of the offending document. The app never breaks on missing/stale data — it
  renders the last good vintage with a stale badge (per-source degradation, like the weather stack).

## 3. Analytics engines (all lazy, all in-browser)

- **DuckDB-WASM** — loaded only inside MIS/Planning. Queries Parquet over HTTP range reads (no
  full downloads). Powers all time-series aggregation, seasonal decomposition inputs, and KPI
  computation. Cached per session.
- **Graph worker** — `src/lib/graph.ts` analytics move into a web worker. Adds **indicative DC
  load flow**: susceptance from voltage class + conductor + length (typical Ω/km per construction),
  PTDF-based screening. Upgrades N−1 from "who is islanded" to "who is islanded *and* which
  surviving lines exceed their (indicative) rating". Honesty label mandatory: assumed impedances,
  uniform dispatch assumptions, screening only.
- **Risk engine** — generalises `src/lib/risk.ts` to **hazard × vulnerability × criticality**:
  - *Hazard*: wind zones, flood proxy, fire/lightning climatology, live cyclone cones (existing).
  - *Vulnerability*: age, coastal band, redundancy (existing index).
  - *Criticality*: DC-flow betweenness + downstream population (WorldPop within served area proxy).
  - Output: per-asset score per hazard + combined, with factor breakdown (extends the existing
    `factors` pattern). Pure + unit-tested.

## 4. Workspaces

### Atlas (existing app — unchanged)
The reference map and lookup tool. No regressions; no new responsibilities beyond the shell chrome.

### Risk Room
- Hazard layer stack (wind zones, flood proxy, fire density, live radar/cyclones) with per-layer
  opacity and the asset overlay on top.
- **Scenario selector**: cyclone-category presets shift the assumed wind field; asset registers
  re-rank live.
- Ranked at-risk registers per hazard and combined (risk engine), single-fed assets flagged;
  existing storm mode embeds here.
- **Briefing pack export**: CSV + GeoJSON + a print-styled HTML summary page (assets at risk,
  ranked actions, data vintages) — the artefact to take into a meeting.

### Planning Studio
- **Load-growth scenarios**: per-circle CAGR sliders vs corridor headroom (capacity.ts + DC flow);
  map shows corridors crossing configurable utilisation thresholds by horizon year.
- **What-if sandbox**: add hypothetical lines/SS (sandbox edges in the graph worker); see flow
  redistribution, N−1 deltas, and which existing constraints relax. Sandbox state is exportable
  as JSON, never persisted server-side.
- **Siting screens**: population/built-up density vs distance-to-132 kV+ — where demand is far
  from supply; candidate areas ranked, exportable.

### MIS Dashboards
- Daily AP demand/energy vs Southern Region and national context (PSP series); peak-met trends;
  frequency-band compliance.
- Energy-mix evolution (CEA series) vs the static generation overlay.
- Seasonal patterns + anomaly flags (z-scores against day-of-year baselines).
- KPI cards vs national benchmarks, each with vintage badges.
- Charting: **ECharts**, lazy-loaded inside the MIS chunk only (never in Atlas).

## 5. Expandability contract

- **Horizontal** (new workspace): one folder under `src/workspaces/<id>/` + one registry entry
  `{ id, label, icon, lazyChunk, requiredManifests }`. The shell renders the switcher, routes the
  hash, and gates on manifest availability. Nothing else changes.
- **Vertical** (deeper analysis): one new pipeline + manifest; consumers bind to the manifest id.
  Replacing a scraper, upgrading a model, or re-sourcing a dataset never touches UI code.
- Engines are workspace-agnostic modules with explicit init contracts (DuckDB, graph worker,
  risk engine) — any future workspace may adopt any engine.

## 6. Quality & testing

- Pure analytics libs: unit-tested (existing Vitest regime).
- Pipeline parsers: unit-tested against committed fixtures; validation gates fail CI loudly.
- Emitted-data integrity tests per manifest (schema + row-count lower bounds), mirroring the
  existing `etl.test.ts` pattern.
- Strict typecheck (`noUnusedLocals`) everywhere, including `pipelines/`.
- Verification on `npm run preview` (repo convention); workspace chunks asserted not to leak into
  the Atlas entry bundle (bundle-size check in CI).

## 7. Milestones (each independently shippable)

| # | Deliverable | Unlocks |
|---|---|---|
| M1 | Workspace shell, hash `w=` routing, code-split, switcher (Atlas untouched) | The frame |
| M2 | `data` branch + Grid-India PSP pipeline + manifests + freshness badges | The data heartbeat |
| M3 | MIS v1 — DuckDB-WASM + demand/generation dashboards (PSP + Vidyut + CEA) | Operational MIS |
| M4 | Risk Room v1 — hazard stack (wind/flood/fire) + generalised risk engine + briefing exports | Risk & resilience |
| M5 | Graph worker + DC load flow + Planning Studio v1 (headroom + what-if) | Network planning |
| M6 | Siting layers (WorldPop/GHSL), ⌘K palette, polish, docs | Horizontal/vertical proof |

## Risks & mitigations

- **Source-format drift** (PSP/CEA documents change layout) → fixture-tested parsers, CI Issues on
  failure, stale-not-broken UI behaviour.
- **Bundle growth** → hard code-splitting per workspace + CI bundle check; heavy engines lazy.
- **Indicative analytics over-trusted** → the honesty convention is a hard requirement on every
  derived readout (label + method note + vintage), as in the existing app.
- **Licence hygiene** → manifests carry licence + attribution; the footer aggregates attributions
  per loaded dataset (extends the existing pattern).
