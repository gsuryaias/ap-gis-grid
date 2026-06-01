# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

**AP-TRANSCO Grid Atlas** — a static, client-side GIS + MIS lookup for the AP-TRANSCO
transmission network (400 / 220 / 132 kV lines and substations), plus an optional **generation-plant
overlay** (energy-mix classified). No backend, no database, no API keys. Source data is a Google-Earth
KML; a build-time ETL turns it into clean static assets the browser loads. Deploys to GitHub Pages
(project site, base `/ap-gis-grid/`).

## Commands

```bash
npm run dev          # Vite dev server → http://localhost:5173/ap-gis-grid/
npm run build:data   # ETL: data/raw/Transco.kml → public/data/*.{geojson,json}
npm run build        # tsc --noEmit && vite build  (production)
npm run preview       # serve dist/ (use this to verify prod; dev HMR can be flaky for map state)
npm test             # Vitest: ETL helper unit tests + emitted-data integrity checks
npm run typecheck    # tsc --noEmit
```

After ANY ETL or component change, run `npm run typecheck` (strict, `noUnusedLocals`).

## Architecture

```
data/raw/Transco.kml    ─┐
data/raw/generation.kml ─┴(ETL)─▶ public/data/*.{geojson,json} ─▶ React + MapLibre app ─▶ GitHub Pages
```

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
- While a mode is active, `MapView`'s feature hover/select handlers early-return (`isMeasuring()`) and
  `doubleClickZoom` is disabled, so clicks place points instead of selecting features / zooming.

## Data decisions (don't regress these — they were validated against the real KML)

- **Folder path is authoritative** for voltage (400/220/132) and circuit (SC/DC). Line *names* only
  set review flags (`circuitAmbiguous`, `voltageMismatch`); 26% of names say "DC/SC".
- **IDs are synthetic** (`s-<ssCode-slug>`, `l-<seq>`), never bare names — 24 substations share a
  name with a different facility. Deep-link hash + selection key on these IDs.
- **Adjacency is geometric**: line endpoints snapped to nearest substation ≤ 500 m (~92% both ends).
  Shown as **inferred**, never authoritative. Don't switch to name-parsing (~51-65%).
- **Circuit-km** = route length × circuits (SC ×1, DC ×2), derived in the ETL.
- **Circle inference**: source records `Circle` only for 132 kV SS; 400/220 kV get the nearest
  circle-bearing SS's circle (`circleInferred: true`). Don't treat inferred circles as ground truth.

## Data quirks / what's NOT in the source

- **No MVA / transformer-capacity / thermal-rating data** in the KML. To add capacities, supply a
  sheet keyed by `SS_CODE` / line name and join it in the ETL. (The "MVA" substring hits in the KML
  are the place-name "Gadda**mva**ripalli".)
- `Transco-2.kml` is a 33-byte view-state duplicate of `Transco.kml` — ignore it.
- Counts are fixed: **500 substations parsed → 499 after dropping 1 exact-coord dup (Tadimarri); 715 lines.**
  The ETL validation gate fails the build if these drift.

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

Replace `data/raw/Transco.kml` (and/or `data/raw/generation.kml`) → `npm run build:data` → review
`public/data/data-quality.json` → commit + push (the GitHub Action re-runs ETL + tests + build and
redeploys). Both KMLs are processed by the one `build:data` run.

## Deploy

`.github/workflows/deploy.yml` publishes `dist/` to Pages on push to `main`. Vite `base` is
`/ap-gis-grid/` (override via `BASE_PATH` env — `/` for a user/org site, `/<repo>/` if renamed).
Repo: Settings → Pages → Source = GitHub Actions.

## Where non-repo artifacts live

Memory, plans, and transcripts are stored globally under `~/.claude/` (keyed by this project's
path), not in the repo — intentionally, so they aren't committed.
