// The Layers drawer (Atlas 2.0 phase 3, PR 9) — replaces the old 57-switch sidebar.
//   Active     what is on: legend keys + sub-switches, opacity, solo, remove; a hint when a layer is
//              outside its zoom range.
//   Catalogue  every layer, grouped, searchable, with count · size · zoom range · vintage + source.
//              Alt-click (or the ◎ button) solos a layer: only it shows; solo it again to restore.
// The basemap sits in the footer. Desktop: a panel over the map's left edge; phone: full-screen.
import { useEffect, useMemo, useRef, useState } from "react";
import { EmptyState } from "../components/states.tsx";
import { useLiveStatus } from "../data/live-status.ts";
import { CloseIcon, MoonIcon, SatelliteIcon, SearchIcon, SpotlightIcon, SunIcon } from "../components/icons.tsx";
import { layerTokens } from "../lenses/registry.ts";
import { layerOnFrom } from "../state/layer-on.ts";
import { useAppStore, type Basemap } from "../state/store.ts";
import { CAT_GROUPS, catalogueEntries, entryMeta, inZoom, matchesQuery, withLiveCounts, type CatEntry } from "./catalogue.ts";
import { EntryDetail, hasDetail } from "./details.tsx";
import { Spinner, Switch, SwatchMark } from "./ui.tsx";

/** The catalogue entries + which are on — shared by the drawer, the toolbar count and the legend. */
export function useCatalogue() {
  const defs = useAppStore((s) => s.layers.defs);
  const live = useLiveStatus();
  const entries = useMemo(() => withLiveCounts(catalogueEntries(defs), live), [defs, live]);
  const filters = useAppStore((s) => s.filters);
  const enabled = useAppStore((s) => s.layers.enabled);
  const on = useMemo(() => layerTokens(layerOnFrom(filters, enabled)), [filters, enabled]);
  return { entries, on };
}

function OpacitySlider({ id, label }: { id: string; label: string }) {
  const value = useAppStore((s) => s.layers.opacity[id] ?? 1);
  const setOpacity = useAppStore((s) => s.layers.setOpacity);
  return (
    <label className="flex items-center gap-2 pt-1 text-[11px] text-ink-2">
      <span className="w-12 shrink-0">Opacity</span>
      <input
        type="range"
        min={10}
        max={100}
        step={5}
        value={Math.round(value * 100)}
        onChange={(e) => setOpacity(id, Number(e.target.value) / 100)}
        aria-label={`${label} opacity`}
        className="h-1 min-w-0 flex-1 accent-[var(--color-accent)]"
      />
      <span className="w-8 shrink-0 text-right tabular-nums">{Math.round(value * 100)}%</span>
    </label>
  );
}

function ActiveRow({ e }: { e: CatEntry }) {
  const zoom = useAppStore((s) => s.camera?.zoom ?? null);
  const status = useAppStore((s) => s.layers.status[e.id]);
  const error = useAppStore((s) => s.layers.errors[e.id]);
  const solo = useAppStore((s) => s.solo?.id === e.id);
  const setLayer = useAppStore((s) => s.setLayer);
  const soloLayer = useAppStore((s) => s.soloLayer);
  const visible = inZoom(e, zoom);
  return (
    <li className="border-b border-line/70 px-3 py-2 last:border-0">
      <div className="flex items-center gap-2">
        <SwatchMark s={e.swatch} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink" title={e.source}>
          {e.label}
        </span>
        {status === "loading" && <Spinner />}
        <button
          type="button"
          onClick={() => soloLayer(e.id)}
          aria-pressed={solo}
          aria-label={solo ? `Stop showing only ${e.label}` : `Show only ${e.label}`}
          title={solo ? "Restore the other layers" : "Show only this layer (Alt-click in the catalogue)"}
          className={`rounded-md p-1 ${solo ? "bg-accent/15 text-accent" : "text-ink-2 hover:bg-surface-2 hover:text-ink"}`}
        >
          <SpotlightIcon width={14} height={14} />
        </button>
        <button
          type="button"
          onClick={() => setLayer(e.id, false)}
          aria-label={`Remove ${e.label}`}
          title="Switch off"
          className="rounded-md p-1 text-ink-2 hover:bg-surface-2 hover:text-ink"
        >
          <CloseIcon width={14} height={14} />
        </button>
      </div>
      {!visible && <p className="pt-0.5 text-[11px] text-amber-700 dark:text-amber-300">Zoom in to see it (from zoom {e.minzoom}).</p>}
      {status === "error" && <p className="pt-0.5 text-[11px] text-red-600 dark:text-red-400">Couldn’t load: {error}</p>}
      {hasDetail(e.id) && (
        <div className="pl-[22px] pt-0.5">
          <EntryDetail entry={e} />
        </div>
      )}
      {e.opacity && <OpacitySlider id={e.id} label={e.label} />}
    </li>
  );
}

function CatalogueRow({ e, on }: { e: CatEntry; on: boolean }) {
  const status = useAppStore((s) => s.layers.status[e.id]);
  const solo = useAppStore((s) => s.solo?.id === e.id);
  const setLayer = useAppStore((s) => s.setLayer);
  const soloLayer = useAppStore((s) => s.soloLayer);
  const meta = entryMeta(e);
  return (
    <li className="flex items-center gap-2 px-3 py-1.5">
      <SwatchMark s={e.swatch} />
      <span className="min-w-0 flex-1" title={[e.source, e.vintage && `vintage ${e.vintage}`, e.note].filter(Boolean).join(" · ")}>
        <span className="block truncate text-sm text-ink">
          {e.label}
          {solo && <span className="ml-1.5 rounded bg-accent/15 px-1 text-[10px] font-semibold text-accent">SOLO</span>}
        </span>
        {meta && <span className="block truncate text-[11px] text-ink-2">{meta}</span>}
      </span>
      {status === "loading" && <Spinner />}
      <Switch
        checked={on}
        onChange={(ev) => (ev.altKey ? soloLayer(e.id) : setLayer(e.id))}
        label={`Toggle ${e.label}`}
      />
    </li>
  );
}

function BasemapPicker() {
  const basemap = useAppStore((s) => s.basemap);
  const setBasemap = useAppStore((s) => s.setBasemap);
  const options = [
    { id: "light", icon: SunIcon, label: "Light" },
    { id: "dark", icon: MoonIcon, label: "Dark" },
    { id: "satellite", icon: SatelliteIcon, label: "Satellite" },
  ] as const;
  return (
    <div className="grid grid-cols-3 gap-1.5" role="group" aria-label="Basemap">
      {options.map(({ id, icon: Icon, label }) => (
        <button
          key={id}
          type="button"
          onClick={() => setBasemap(id as Basemap)}
          aria-pressed={basemap === id}
          className={`flex items-center justify-center gap-1.5 rounded-lg border px-1 py-1.5 text-[11px] font-medium ${
            basemap === id ? "border-accent bg-surface-3 text-ink" : "border-line text-ink-2 hover:bg-surface-2"
          }`}
        >
          <Icon width={14} height={14} />
          {label}
        </button>
      ))}
    </div>
  );
}

export function LayerDrawer({ phone = false }: { phone?: boolean }) {
  const open = useAppStore((s) => s.layersOpen);
  const toggle = useAppStore((s) => s.toggleLayersDrawer);
  const loadCatalog = useAppStore((s) => s.layers.loadCatalog);
  const catalogStatus = useAppStore((s) => s.layers.catalogStatus);
  const solo = useAppStore((s) => s.solo);
  const soloLayer = useAppStore((s) => s.soloLayer);
  const { entries, on } = useCatalogue();
  const [tab, setTab] = useState<"active" | "catalogue">("active");
  const [q, setQ] = useState("");
  const closeRef = useRef<HTMLButtonElement>(null);

  // The RTGS reference layers join the catalogue once it is browsed.
  useEffect(() => {
    if (open && tab === "catalogue") loadCatalog();
  }, [open, tab, loadCatalog]);
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && toggle(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, toggle]);

  if (!open) return null;
  const active = entries.filter((e) => on.has(e.id));
  const shown = entries.filter((e) => matchesQuery(e, q));

  return (
    <section
      aria-label="Layers"
      className={
        phone
          ? "pointer-events-auto absolute inset-0 z-40 flex flex-col bg-surface"
          : "pointer-events-auto absolute left-3 top-[52px] z-30 flex max-h-[calc(100%-64px)] w-[340px] max-w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface/97 shadow-[var(--shadow-panel)] backdrop-blur"
      }
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <div role="tablist" aria-label="Layers view" className="flex flex-1 gap-0.5 rounded-lg bg-surface-2 p-0.5">
          {(
            [
              ["active", `On now · ${active.length}`],
              ["catalogue", "All layers"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`flex-1 rounded-md px-2 py-1 text-xs font-medium ${tab === id ? "bg-surface text-ink shadow-sm" : "text-ink-2 hover:text-ink"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <button ref={closeRef} type="button" onClick={() => toggle(false)} aria-label="Close layers" className="rounded-md p-1 text-ink-2 hover:bg-surface-2 hover:text-ink">
          <CloseIcon width={16} height={16} />
        </button>
      </header>

      {solo && (
        <div className="flex shrink-0 items-center gap-2 border-b border-line bg-accent/10 px-3 py-1.5 text-xs text-ink">
          <span className="flex-1 truncate">Showing only {entries.find((e) => e.id === solo.id)?.label ?? solo.id}</span>
          <button type="button" onClick={() => soloLayer(solo.id)} className="font-medium text-accent hover:underline">
            Restore layers
          </button>
        </div>
      )}

      {tab === "active" ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {active.length ? (
            <ul>{active.map((e) => <ActiveRow key={e.id} e={e} />)}</ul>
          ) : (
            <EmptyState>Nothing is switched on. Pick layers under “All layers”.</EmptyState>
          )}
          <button type="button" onClick={() => setTab("catalogue")} className="mx-3 mb-3 mt-1 text-xs font-medium text-accent hover:underline">
            + Add layers
          </button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 px-3 pb-1 pt-2">
            <label className="flex items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5 focus-within:border-accent">
              <SearchIcon width={14} height={14} className="shrink-0 text-ink-2" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Find a layer — towers, flood, forest…"
                aria-label="Find a layer"
                className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-2/70"
              />
            </label>
            <p className="pt-1 text-[10.5px] text-ink-2">Alt-click a switch to show only that layer.</p>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2">
            {CAT_GROUPS.map((g) => {
              const items = shown.filter((e) => e.group === g);
              if (!items.length) return null;
              return (
                <section key={g} aria-label={g}>
                  <h3 className="sticky top-0 z-10 bg-surface/95 px-3 pb-0.5 pt-2 text-[10.5px] font-semibold uppercase tracking-wide text-ink-2 backdrop-blur">{g}</h3>
                  <ul>
                    {items.map((e) => (
                      <CatalogueRow key={e.id} e={e} on={on.has(e.id)} />
                    ))}
                  </ul>
                </section>
              );
            })}
            {catalogStatus === "loading" && (
              <p className="flex items-center gap-2 px-3 py-2 text-xs text-ink-2">
                <Spinner /> Loading the reference-layer catalogue…
              </p>
            )}
            {catalogStatus === "error" && <p className="px-3 py-2 text-xs text-red-600 dark:text-red-400">Couldn’t load the reference-layer catalogue.</p>}
            {!shown.length && <EmptyState>No layer matches “{q}”.</EmptyState>}
            {catalogStatus === "ready" && (
              <p className="px-3 pt-2 text-[10.5px] leading-snug text-ink-2">
                Boundaries, transport, environment, water and hazards: RTGS (AP Real-Time Governance Society) GIS library, simplified for
                the web — indicative, not survey-grade.
              </p>
            )}
          </div>
        </div>
      )}

      <footer className="shrink-0 border-t border-line px-3 py-2">
        <BasemapPicker />
      </footer>
    </section>
  );
}
