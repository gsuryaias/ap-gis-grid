import type { EnergyType, Voltage } from "../data/types.ts";

// Okabe-Ito derived, colour-vision-deficiency safe. Mirrors the --color-v* CSS tokens.
// Colour is paired with redundant line WIDTH + DASH in the map so it survives CVD/greyscale.
export const VOLTAGE_COLOR: Record<Voltage, string> = {
  400: "#d55e00", // vermillion
  220: "#0072b2", // blue
  132: "#009e73", // green
};

export const VOLTAGE_LABEL: Record<Voltage, string> = {
  400: "400 kV",
  220: "220 kV",
  132: "132 kV",
};

export const CIRCUIT_LABEL: Record<string, string> = {
  SC: "Single circuit",
  DC: "Double circuit",
};

// Energy-mix palette for the generation overlay. Deliberately distinct hues from the voltage
// palette (orange/blue/green) so plant markers read as a separate layer, and mutually
// distinguishable under common CVD types. Intuitive mapping where possible (sun=gold, water=blue).
export const ENERGY_COLOR: Record<EnergyType, string> = {
  Thermal: "#5a4a42", // coal — graphite brown
  Gas: "#d264b6", // magenta
  Hydro: "#1f78b4", // water blue
  Solar: "#f5a700", // sun gold
  Wind: "#56b4e9", // sky cyan
  Other: "#9aa0a6", // grey (unclassified / source null)
};

// POWERGRID (PGCIL) overlay — a single rose hue for ALL features (lines + substations),
// regardless of voltage, so the inter-state grid reads as one distinct layer. Deliberately
// distinct from the voltage palette (orange/blue/green), the energy palette, and the magenta
// measure tool. HALO is the lighter ring tint for substation strokes / legend swatch ring.
export const POWERGRID_COLOR = "#e11d48"; // rose-600
export const POWERGRID_HALO = "#fda4af"; // rose-300

// Two more classes that ride inside the same "Power grid" overlay group. Restrained, mutually
// distinct hues that don't clash with the voltage palette (orange/blue/green), the energy
// palette, the rose PowerGrid, or the magenta measure tool. Loads (not backbone) → drawn smaller.
export const RAILWAY_COLOR = "#7c3aed"; // violet-600 (railway-traction RTSS)
export const BULKLOAD_COLOR = "#0d9488"; // teal-600 (bulk-load / HT consumer)

// Live-weather overlay. Cyclone alert swatches use GDACS's own semantic green/orange/red
// (universally understood for hazard levels); the track line is a dark maroon outside every
// other palette, and at-risk substations get an amber warning halo.
export const WX_ALERT_COLOR: Record<string, string> = {
  Green: "#16a34a",
  Orange: "#f59e0b",
  Red: "#dc2626",
};
export const WX_TRACK_COLOR = "#881337"; // rose-900 — cyclone track + positions
export const WX_RISK_COLOR = "#f59e0b"; // amber-500 — substations inside a forecast cone

export const ENERGY_LABEL: Record<EnergyType, string> = {
  Thermal: "Thermal",
  Gas: "Gas",
  Hydro: "Hydro",
  Solar: "Solar",
  Wind: "Wind",
  Other: "Other / N.A.",
};
