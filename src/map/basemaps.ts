import type { StyleSpecification } from "maplibre-gl";
import type { Basemap } from "../state/store.ts";

// Reuse CARTO's public glyph server so the substation label (symbol) layer renders on the
// satellite raster style too (a raster style ships no glyphs of its own).
const GLYPHS = "https://tiles.basemaps.cartocdn.com/fonts/{fontstack}/{range}.pbf";

// Esri World Imagery — keyless XYZ (note {z}/{y}/{x} order). Attribution is mandatory and is
// surfaced via the raster source's `attribution` field. Fine for internal / non-commercial use.
const SATELLITE_STYLE: StyleSpecification = {
  version: 8,
  glyphs: GLYPHS,
  sources: {
    "esri-imagery": {
      type: "raster",
      tiles: ["https://server.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
      tileSize: 256,
      maxzoom: 19,
      attribution: "Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    },
  },
  layers: [{ id: "esri-imagery", type: "raster", source: "esri-imagery" }],
};

export interface BasemapDef {
  /** A CARTO style URL (vector) or an inline style object (satellite raster). */
  style: string | StyleSpecification;
  /** Theme-dependent colours used by the grid overlay layers. */
  casing: string;
  hoverCasing: string;
  ssStroke: string;
  labelColor: string;
  labelHalo: string;
}

export const BASEMAPS: Record<Basemap, BasemapDef> = {
  light: {
    // CARTO Positron — keyless, OSM-derived; the GL style embeds OSM + CARTO attribution.
    style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
    casing: "#ffffff",
    hoverCasing: "rgba(13,27,42,0.45)",
    ssStroke: "#ffffff",
    labelColor: "#0d1b2a",
    labelHalo: "#ffffff",
  },
  dark: {
    style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
    casing: "#0b1118",
    hoverCasing: "rgba(255,255,255,0.55)",
    ssStroke: "#0e1622",
    labelColor: "#eaf1f8",
    labelHalo: "#0b1118",
  },
  satellite: {
    style: SATELLITE_STYLE,
    // Dark halo so the voltage-coloured lines stay legible over varied imagery.
    casing: "rgba(0,0,0,0.6)",
    hoverCasing: "rgba(255,255,255,0.85)",
    ssStroke: "#ffffff",
    labelColor: "#ffffff",
    labelHalo: "rgba(0,0,0,0.85)",
  },
};

/** Bright, non-voltage hue used for the selection halo (distinct under all CVD types). */
export const SELECT_HALO = "#ffe14d";
