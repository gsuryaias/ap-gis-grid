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

export const ENERGY_LABEL: Record<EnergyType, string> = {
  Thermal: "Thermal",
  Gas: "Gas",
  Hydro: "Hydro",
  Solar: "Solar",
  Wind: "Wind",
  Other: "Other / N.A.",
};
