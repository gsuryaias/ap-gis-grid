import type { Voltage } from "../data/types.ts";

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
