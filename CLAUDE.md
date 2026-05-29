# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

**AP-TRANSCO Grid Atlas** — a static, client-side GIS + MIS lookup for the AP-TRANSCO
transmission network (400 / 220 / 132 kV lines and substations). No backend, no database, no API
keys. Source data is a Google-Earth KML; a build-time ETL turns it into clean static assets the
browser loads. Deploys to GitHub Pages (project site, base `/ap-gis-grid/`).

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
data/raw/Transco.kml ─(ETL)─▶ public/data/*.{geojson,json} ─▶ React + MapLibre app ─▶ GitHub Pages
```

| Layer | Path | Notes |
|-------|------|-------|
| ETL | `scripts/build-data.mts` + `scripts/etl-lib.ts` | pure helpers in etl-lib (unit-tested); orchestration in build-data.mts |
| Data | `src/data/` | `types.ts` (canonical types), `load.ts` (fetch via `import.meta.env.BASE_URL`), `selectors.ts` |
| State | `src/state/store.ts` (Zustand) + `src/url/` | versioned URL-hash sync, selection history (`back()`) |
| Map | `src/map/` | `MapView.tsx`, `layers.ts` (paint), `basemaps.ts` (CARTO) |
| UI | `src/components/` | SearchBar, DetailPanel, DataTableSheet, SummaryView, DataQualityView, ControlPanel |
| Theme | `src/theme/palette.ts` + `src/index.css` | voltage palette (Okabe-Ito, CVD-safe) as both JS + CSS tokens |

The emitted `public/data/*` files are **committed** so CI/Pages builds don't need the KML.

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
- **Verify on `npm run preview`, not dev** — HMR can desync map/store state while editing.

## Updating the network data

Replace `data/raw/Transco.kml` → `npm run build:data` → review `public/data/data-quality.json`
→ commit + push (the GitHub Action re-runs ETL + tests + build and redeploys).

## Deploy

`.github/workflows/deploy.yml` publishes `dist/` to Pages on push to `main`. Vite `base` is
`/ap-gis-grid/` (override via `BASE_PATH` env — `/` for a user/org site, `/<repo>/` if renamed).
Repo: Settings → Pages → Source = GitHub Actions.

## Where non-repo artifacts live

Memory, plans, and transcripts are stored globally under `~/.claude/` (keyed by this project's
path), not in the repo — intentionally, so they aren't committed.
