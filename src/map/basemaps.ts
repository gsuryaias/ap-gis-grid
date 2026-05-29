import type { Basemap } from "../state/store.ts";

// CARTO basemaps are genuinely keyless and OSM-derived. Their style JSON carries no
// embedded attribution, so we MUST supply OSM + CARTO credit explicitly (mandatory).
const CARTO_ATTRIBUTION =
  '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors, ' +
  '© <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>';

export interface BasemapDef {
  styleUrl: string;
  attribution: string;
  /** Theme-dependent colours used by the grid overlay layers. */
  casing: string;
  hoverCasing: string;
  ssStroke: string;
  labelColor: string;
  labelHalo: string;
}

export const BASEMAPS: Record<Basemap, BasemapDef> = {
  light: {
    styleUrl: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
    attribution: CARTO_ATTRIBUTION,
    casing: "#ffffff",
    hoverCasing: "rgba(13,27,42,0.45)",
    ssStroke: "#ffffff",
    labelColor: "#0d1b2a",
    labelHalo: "#ffffff",
  },
  dark: {
    styleUrl: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
    attribution: CARTO_ATTRIBUTION,
    casing: "#0b1118",
    hoverCasing: "rgba(255,255,255,0.55)",
    ssStroke: "#0e1622",
    labelColor: "#eaf1f8",
    labelHalo: "#0b1118",
  },
};

/** Bright, non-voltage hue used for the selection halo (distinct under all CVD types). */
export const SELECT_HALO = "#ffe14d";
