// URL v2 — everything has a URL (Atlas 2.0 phase 2). Pure codec + the history policy.
//
//   #@80.4012,15.9001,6.25z&v=2&lens=plan&sel=s-ss-132kv-chnd&lyr=gen,discom-lines,ref:districts,-ss
//    &volt=400,220&circ=DC&circle=Kadapa&coast=1&base=dark&tbl=1&map=collapsed&by=division&mf=…&tab=age&th=age
//
// - `@lng,lat,zoom z` — the camera (written on every settled move).
// - `lens` — explore (default) | plan (the Network MIS). field / storm decode to explore until phase 3.
// - `sel` — an Inspector ref (`inspector/refs.ts`).
// - `lyr` — layers that differ from the defaults: gen / pg / wx, catalog overlays (RTGS ones as
//   `ref:<id>`), and `-ss` / `-ln` for the core grid switched off. Present ⇒ authoritative (it wins
//   over the overlays this device remembers); absent ⇒ layers are left as they are.
// - MIS keys (by / mf / tab / th) are written only in the Plan lens.
// Defaults are omitted. v1 links (`#v=1&…`) decode through `decodeV1` (url/hash.ts) and are then
// rewritten to v2. `historyMode` decides push vs replace: navigation (selection, lens, circle, drill)
// pushes, so browser Back steps through it; everything else replaces.
import { CIRCUITS, VOLTAGES, type Circuit, type Voltage } from "../data/types.ts";
import { isValidRef } from "../inspector/refs.ts";
import { STATIC_OVERLAY_DEFS } from "../overlays/resources.ts";
import type { WorkspaceId } from "../workspaces/registry.ts";
import { parseHash as decodeV1, type HashState } from "./hash.ts";
import { defaultMapLayout, type MapLayout } from "./layout.ts";

export const URL_VERSION = 2;

export type Basemap = "light" | "dark" | "satellite";
export type Lens = "explore" | "field" | "plan" | "storm";

export interface Camera {
  lng: number;
  lat: number;
  zoom: number;
}

export interface UrlState {
  workspace: WorkspaceId;
  selectedId: string | null;
  camera: Camera | null;
  basemap: Basemap;
  voltages: Voltage[];
  circuits: Circuit[];
  circle: string | null;
  coastalBand: 0 | 1 | 2 | 3 | null;
  showSubstations: boolean;
  showLines: boolean;
  showGeneration: boolean;
  showPowerGrid: boolean;
  showWeather: boolean;
  /** Enabled catalog overlays (DISCOM / towers / RTGS ids), sorted. */
  overlays: string[];
  tableOpen: boolean;
  mapLayout: MapLayout;
  misBy: string | null;
  misFilters: string | null;
  misTab: string | null;
  misTheme: string | null;
}

/** The layer fields — all set when a URL carries `lyr`, all absent when it doesn't. */
export const LAYER_KEYS = ["showSubstations", "showLines", "showGeneration", "showPowerGrid", "showWeather", "overlays"] as const;

export const defaultUrlState = (): UrlState => ({
  workspace: "atlas",
  selectedId: null,
  camera: null,
  basemap: "light",
  voltages: [...VOLTAGES],
  circuits: [...CIRCUITS],
  circle: null,
  coastalBand: null,
  showSubstations: true,
  showLines: true,
  showGeneration: false,
  showPowerGrid: false,
  showWeather: false,
  overlays: [],
  tableOpen: false,
  mapLayout: "atlas-only",
  misBy: null,
  misFilters: null,
  misTab: null,
  misTheme: null,
});

const LENS_OF: Record<WorkspaceId, Lens> = { atlas: "explore", mis: "plan" };
const workspaceOfLens = (l: string | null): WorkspaceId => (l === "plan" ? "mis" : "atlas");
const TOKEN = /^[a-z0-9-]{1,24}$/;
const OVERLAY_ID = /^[a-z0-9-]{1,40}$/;

const round = (n: number, dp: number) => Number(n.toFixed(dp));
export const roundCamera = (c: Camera): Camera => ({ lng: round(c.lng, 4), lat: round(c.lat, 4), zoom: round(c.zoom, 2) });

/** Fragment-safe encoding that leaves `, : ~ @` readable. */
const enc = (v: string) => encodeURIComponent(v).replace(/%2C/gi, ",").replace(/%3A/gi, ":").replace(/%40/g, "@");

const overlayToken = (id: string) => (STATIC_OVERLAY_DEFS[id] ? id : `ref:${id}`);

export function encodeUrl(s: UrlState): string {
  const parts: string[] = [];
  if (s.camera) {
    const c = roundCamera(s.camera);
    parts.push(`@${c.lng},${c.lat},${c.zoom}z`);
  }
  const kv = (k: string, v: string) => parts.push(`${k}=${enc(v)}`);
  kv("v", String(URL_VERSION));
  if (s.workspace !== "atlas") kv("lens", LENS_OF[s.workspace]);
  if (s.selectedId) kv("sel", s.selectedId);
  const lyr = [
    ...(s.showGeneration ? ["gen"] : []),
    ...(s.showPowerGrid ? ["pg"] : []),
    ...(s.showWeather ? ["wx"] : []),
    ...[...s.overlays].sort().map(overlayToken),
    ...(s.showSubstations ? [] : ["-ss"]),
    ...(s.showLines ? [] : ["-ln"]),
  ];
  if (lyr.length) kv("lyr", lyr.join(","));
  if (s.voltages.length !== VOLTAGES.length) kv("volt", VOLTAGES.filter((v) => s.voltages.includes(v)).join(","));
  if (s.circuits.length !== CIRCUITS.length) kv("circ", CIRCUITS.filter((c) => s.circuits.includes(c)).join(","));
  if (s.circle) kv("circle", s.circle);
  if (s.coastalBand != null) kv("coast", String(s.coastalBand));
  if (s.basemap !== "light") kv("base", s.basemap);
  if (s.tableOpen) kv("tbl", "1");
  if (s.workspace === "mis") {
    if (s.mapLayout !== "atlas-only" && s.mapLayout !== defaultMapLayout()) kv("map", s.mapLayout);
    if (s.misBy && s.misBy !== "circle") kv("by", s.misBy);
    if (s.misFilters) kv("mf", s.misFilters);
    if (s.misTab && s.misTab !== "radial") kv("tab", s.misTab);
    if (s.misTheme && s.misTheme !== "voltage") kv("th", s.misTheme);
  }
  return `#${parts.join("&")}`;
}

function parseCamera(tok: string): Camera | null {
  const m = /^@(-?\d{1,3}(?:\.\d+)?),(-?\d{1,2}(?:\.\d+)?),(\d{1,2}(?:\.\d+)?)z$/.exec(tok);
  if (!m) return null;
  const [lng, lat, zoom] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return Math.abs(lng) <= 180 && Math.abs(lat) <= 85 && zoom <= 22 ? { lng, lat, zoom } : null;
}

function params(raw: string): { camera: Camera | null; p: Map<string, string> } {
  const p = new Map<string, string>();
  let camera: Camera | null = null;
  for (const part of raw.split("&")) {
    if (!part) continue;
    if (part.startsWith("@")) {
      camera = parseCamera(part);
      continue;
    }
    const i = part.indexOf("=");
    const k = i < 0 ? part : part.slice(0, i);
    try {
      p.set(k, i < 0 ? "" : decodeURIComponent(part.slice(i + 1).replace(/\+/g, " ")));
    } catch {
      /* malformed escape — ignore the key */
    }
  }
  return { camera, p };
}

function decodeV2(p: Map<string, string>, camera: Camera | null): Partial<UrlState> {
  const d = defaultUrlState();
  const out: Partial<UrlState> = {};
  const workspace = workspaceOfLens(p.get("lens") ?? null);
  out.workspace = workspace;
  const sel = p.get("sel");
  out.selectedId = sel && isValidRef(sel) ? sel : null;
  if (camera) out.camera = camera;

  const base = p.get("base");
  out.basemap = base === "dark" || base === "satellite" ? base : "light";

  const volt = p.get("volt");
  const vs = volt ? volt.split(",").map(Number).filter((n): n is Voltage => (VOLTAGES as number[]).includes(n)) : [];
  out.voltages = vs.length ? vs : d.voltages;
  const circ = p.get("circ");
  const cs = circ ? circ.split(",").filter((c): c is Circuit => (CIRCUITS as string[]).includes(c)) : [];
  out.circuits = cs.length ? cs : d.circuits;

  const circle = p.get("circle");
  out.circle = circle && circle.length <= 40 ? circle : null;
  const coast = Number(p.get("coast") ?? NaN);
  out.coastalBand = coast === 0 || coast === 1 || coast === 2 || coast === 3 ? coast : null;
  out.tableOpen = p.get("tbl") === "1";

  const lyr = p.get("lyr");
  if (lyr != null) {
    const toks = lyr.split(",").filter(Boolean);
    out.showGeneration = toks.includes("gen");
    out.showPowerGrid = toks.includes("pg");
    out.showWeather = toks.includes("wx");
    out.showSubstations = !toks.includes("-ss");
    out.showLines = !toks.includes("-ln");
    out.overlays = [
      ...new Set(
        toks
          .filter((t) => !["gen", "pg", "wx", "-ss", "-ln"].includes(t))
          .map((t) => t.replace(/^ref:/, ""))
          .filter((t) => OVERLAY_ID.test(t)),
      ),
    ].sort();
  }

  if (workspace === "mis") {
    const map = p.get("map");
    out.mapLayout = map === "open" || map === "collapsed" ? map : defaultMapLayout();
    const by = p.get("by");
    out.misBy = by && TOKEN.test(by) ? by : null;
    const mf = p.get("mf");
    out.misFilters = mf && mf.length <= 400 ? mf : null;
    const tab = p.get("tab");
    out.misTab = tab && TOKEN.test(tab) ? tab : null;
    const th = p.get("th");
    out.misTheme = th && TOKEN.test(th) ? th : null;
  } else {
    out.mapLayout = "atlas-only";
    out.misBy = out.misFilters = out.misTab = out.misTheme = null;
  }
  return out;
}

/** A v1 decode, in v2 terms. v1 links never carried catalog overlays, so they leave those alone. */
export function fromV1(h: Partial<HashState>): Partial<UrlState> {
  const out: Partial<UrlState> = {};
  const copy = <K extends keyof HashState & keyof UrlState>(k: K) => {
    if (h[k] !== undefined) (out as Record<string, unknown>)[k] = h[k];
  };
  (
    ["workspace", "selectedId", "basemap", "voltages", "circuits", "circle", "coastalBand", "showSubstations", "showLines", "showGeneration", "showPowerGrid", "showWeather", "tableOpen", "mapLayout", "misBy", "misFilters", "misTab", "misTheme"] as const
  ).forEach(copy);
  if (out.workspace && out.mapLayout === undefined) out.mapLayout = out.workspace === "atlas" ? "atlas-only" : defaultMapLayout();
  return out;
}

/** Decode any app URL fragment: v2, v1 (converted) or empty / unknown (→ {}). */
export function decodeUrl(hash: string): Partial<UrlState> {
  const raw = hash.replace(/^#/, "");
  if (!raw) return {};
  const { camera, p } = params(raw);
  const v = p.get("v");
  if (v === String(URL_VERSION)) return decodeV2(p, camera);
  if (v === "1") return fromV1(decodeV1(`#${raw}`));
  return {};
}

/** Navigation pushes a history entry (Back undoes it); view tweaks replace the current one. */
const PUSH_KEYS: (keyof UrlState)[] = ["workspace", "selectedId", "circle", "misFilters", "misBy", "misTab"];

export function historyMode(prev: UrlState, next: UrlState): "push" | "replace" | "none" {
  if (encodeUrl(prev) === encodeUrl(next)) return "none";
  return PUSH_KEYS.some((k) => prev[k] !== next[k]) ? "push" : "replace";
}
