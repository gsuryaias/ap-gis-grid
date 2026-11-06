// Method cards — what sits behind every "Indicative" chip (Atlas 2.0 phase 3, PR 11). The UK OSR /
// Our World in Data pattern: say up front what a derived number is, how it was made, from what,
// how old it is and how much it covers — and that it is not an operational figure. Pure data.

export type MethodId = "capacity" | "dlr" | "age" | "connectivity" | "supply" | "n1" | "coastal" | "risk" | "weather" | "trace";

export interface MethodCard {
  id: MethodId;
  title: string;
  /** How the figure is derived, in one or two sentences. */
  rule: string;
  source: string;
  vintage: string;
  coverage: string;
  /** What it is NOT. */
  caveat: string;
  /** Glossary ids worth reading next. */
  terms: string[];
}

export const METHODS: Record<MethodId, MethodCard> = {
  capacity: {
    id: "capacity",
    title: "Indicative thermal capacity",
    rule: "Nominal ampacity of the line's conductor (ACSR Panther 480 A, Zebra 735 A, Moose 800 A …) × bundle (twin ×2, quad ×4) → √3 · kV · A per circuit, × the circuits the row carries.",
    source: "Conductor names in the AP-TRANSCO GIS line layers; standard Indian ACSR ratings.",
    vintage: "Re-derived on every data build.",
    coverage: "≈ 99 % of line rows; bare cable / alloy conductor names are left unrated.",
    caveat: "Not a load-flow result or a utility rating — real limits depend on conductor temperature, sag and clearances.",
    terms: ["ckm", "circuit", "dlr"],
  },
  dlr: {
    id: "dlr",
    title: "Ambient derating (dynamic line rating)",
    rule: "Scales the nominal ampacity by √((75 − Tₐ)/(75 − 40)) using the live air temperature at the nearest circle centre; cool-weather uprating capped at ×1.15.",
    source: "Open-Meteo current temperature; conductor rating as above.",
    vintage: "Live (refreshed every 10 minutes while weather is on).",
    coverage: "Every rated line; temperature only — no wind, sun or conductor sensors.",
    caveat: "Indicative only; not a real-time thermal rating.",
    terms: ["dlr"],
  },
  age: {
    id: "age",
    title: "Asset age",
    rule: "Current year − the commissioning year recorded on the line. Fleet ages are circuit-km weighted; “≥ 35 yrs” uses the CERC useful life.",
    source: "Commissioning dates in the AP-TRANSCO GIS line layers.",
    vintage: "As recorded in the GIS (synced weekly).",
    coverage: "Lines with a real commissioning date (the 1899 placeholder is treated as unknown). Substations carry no date.",
    caveat: "A recorded date, not an inspected condition.",
    terms: ["cerc-life", "ckm"],
  },
  connectivity: {
    id: "connectivity",
    title: "Inferred connectivity",
    rule: "A line end is joined to the substation whose surveyed compound it falls inside, or within 1 km of its edge; other ends snap to generation, railway, POWERGRID or HT facilities within 500 m.",
    source: "Line and substation geometry from the AP-TRANSCO GIS (Gridmap).",
    vintage: "Re-derived on every data build.",
    coverage: "≈ 95 % of lines connect at both ends; the rest are flagged as data gaps.",
    caveat: "Geometric, not the utility's switching diagram — bus sections and open points are unknown.",
    terms: ["inferred-link", "data-gap"],
  },
  n1: {
    id: "n1",
    title: "N-1 screening",
    rule: "On the inferred multigraph (each circuit an edge): a bridge line islands substations if it trips; a cut-point substation splits the network if it is lost.",
    source: "Inferred connectivity (above).",
    vintage: "Re-derived on every data build.",
    coverage: "Transmission (400 / 220 / 132 kV) only; no ratings, so overloads are not modelled.",
    caveat: "Topology only — not a contingency study with flows.",
    terms: ["n-1", "bridge", "cut-point", "single-fed"],
  },
  supply: {
    id: "supply",
    title: "Supply security (radial feeds)",
    rule: "On a corridor graph (one edge per route, carrying its circuit count) the 2-edge-connected core is ‘meshed’; everything hanging off it by a corridor bridge is radial — single-circuit (N-1 insecure) or double-circuit on one tower line.",
    source: "Inferred connectivity + circuit types from the GIS.",
    vintage: "Re-derived on every data build.",
    coverage: "TRANSCO grid incl. generation switchyards; traction / HT consumers as leaves.",
    caveat: "Indicative — normally-open points and bus arrangements are unknown.",
    terms: ["meshed", "radial-sc", "radial-dc", "pocket", "corridor"],
  },
  coastal: {
    id: "coastal",
    title: "Coastal exposure band",
    rule: "Distance from each asset to the AP coastline: band 0 < 10 km, 1 10–25 km, 2 25–50 km, 3 > 50 km.",
    source: "AP coastline polygon + asset geometry.",
    vintage: "Re-derived on every data build.",
    coverage: "Every substation and line.",
    caveat: "Distance only — not elevation, surge or wind-zone modelling.",
    terms: ["coastal-band"],
  },
  risk: {
    id: "risk",
    title: "Vulnerability screening score",
    rule: "0–100 from coastal band, inferred redundancy (feed degree), asset age where known and voltage; tiers low / moderate / elevated / high.",
    source: "Coastal band, inferred connectivity, GIS attributes.",
    vintage: "Re-derived on every data build.",
    coverage: "Every TRANSCO substation (substation age is unknown in the source).",
    caveat: "A screening aid to sort a list — not a hazard or reliability model.",
    terms: ["coastal-band", "single-fed"],
  },
  weather: {
    id: "weather",
    title: "Live weather and cyclones",
    rule: "Model conditions at the 13 circle centres, offshore sea state, composite rain radar and the GDACS cyclone track / forecast cone; substations inside a cone are haloed.",
    source: "Open-Meteo (forecast + marine), RainViewer (radar), GDACS (UN / EC JRC).",
    vintage: "Live; weather refreshes every 10 minutes, radar is the latest past frame.",
    coverage: "Bay of Bengal / Arabian Sea systems; radar to zoom 7.",
    caveat: "Third-party model output — always check IMD advisories before acting.",
    terms: ["forecast-cone", "gdacs-alert"],
  },
  trace: {
    id: "trace",
    title: "Distribution trace (DTR → TRANSCO)",
    rule: "11 kV feeder → its 33/11 kV substation (recorded id, else name within 5 km, else a run end ≤ 500 m) → the 33 kV feeder serving it (within 300 m) → the feeder's source TRANSCO SS (recorded name, else an end ≤ 1.5 km).",
    source: "APEPDCL / APSPDCL / APCPDCL open GIS layers (APCPDCL 33 kV from its own export).",
    vintage: "Synced from the DISCOM GIS (weekly).",
    coverage: "APEPDCL near-complete; APSPDCL partial; APCPDCL has no open 11 kV or transformer data.",
    caveat: "Spatially inferred — a step can be wrong or missing; confirm with the DISCOM.",
    terms: ["dtr", "inferred-link", "ss33"],
  },
};
