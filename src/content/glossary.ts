// The glossary (Atlas 2.0 phase 3, PR 11) — one place for the network's jargon, searchable from ⌘K
// and linked from every method card. Plain data; keep entries short and concrete.

export interface GlossaryEntry {
  id: string;
  term: string;
  /** Other names people search for. */
  aka?: string[];
  text: string;
}

export const GLOSSARY: GlossaryEntry[] = [
  { id: "n-1", term: "N-1", aka: ["n minus one", "contingency"], text: "The network should keep supplying everyone after losing any ONE element (a line circuit, a transformer, a substation bus). Here it is screened on the inferred topology only." },
  { id: "bridge", term: "Bridge line", aka: ["radial line"], text: "A line circuit whose loss splits the network: the substations beyond it are islanded. The Atlas lists who would be cut off." },
  { id: "cut-point", term: "Cut point", aka: ["articulation point", "critical substation"], text: "A substation whose loss (a bus outage) splits the network into separate pieces." },
  { id: "single-fed", term: "Single-fed substation", text: "A substation connected to only one neighbouring substation — any outage on that feed disconnects it." },
  { id: "meshed", term: "Meshed", text: "Part of the network's 2-edge-connected core: every substation there has at least two independent routes in." },
  { id: "radial-sc", term: "Radial — single circuit", aka: ["radial-sc"], text: "Fed through a route with only one circuit somewhere on the way: one fault interrupts supply (N-1 insecure)." },
  { id: "radial-dc", term: "Radial — double circuit", aka: ["radial-dc"], text: "Fed through two circuits on ONE tower line: a circuit fault is covered, but losing the tower line (a collapse, a cyclone) islands it." },
  { id: "pocket", term: "Radial pocket", text: "A group of substations hanging off the meshed core through a single corridor; ranked by the 33/11 kV load behind it." },
  { id: "corridor", term: "Corridor", text: "One physical route between two substations, carrying one or more circuits (a double-circuit tower line is one corridor, two circuits)." },
  { id: "circuit", term: "SC / DC / DC-SC", aka: ["single circuit", "double circuit"], text: "SC: one circuit on single-circuit towers. DC: two circuits on double-circuit towers. DC/SC: double-circuit towers with only one circuit strung." },
  { id: "ckm", term: "Circuit-km vs route-km", aka: ["ckm", "route km"], text: "Route-km is the length of the physical route; circuit-km counts every circuit on it. A 10 km double-circuit line is 10 route-km and 20 ckm." },
  { id: "cerc-life", term: "Useful life (35 years)", aka: ["cerc"], text: "The Central Electricity Regulatory Commission's useful life for transmission lines and substations, used here as the ‘aged’ threshold." },
  { id: "dlr", term: "Dynamic line rating", aka: ["dlr", "derating"], text: "A line's current limit rises when the air is cool and falls when it is hot. The Atlas applies an ambient-temperature correction only (no wind or sun)." },
  { id: "warning-envelope", term: "Warning envelope", aka: ["exposed substations", "cyclone exposure"], text: "The Storm lens's exposure area: inside a cyclone's forecast cone or alert swath, PLUS the coast (under 25 km from the sea) within 150 km of the track. Impacts reach well beyond the cone edge, so the cone alone under-counts." },
  { id: "coastal-band", term: "Coastal band", text: "Distance to the coastline: 0 under 10 km, 1 10–25 km, 2 25–50 km, 3 over 50 km. Used for cyclone exposure screening." },
  { id: "inferred-link", term: "Inferred link", aka: ["name match", "proximity", "feeder group"], text: "A connection worked out from the data rather than recorded: by the source name the DISCOM recorded, by a feeder end lying close to a substation, or by another run of the same named feeder." },
  { id: "data-gap", term: "Data gap", aka: ["open end"], text: "A line end that is not within 1 km of any substation or facility in the data — usually a digitising gap, not a real dead end." },
  { id: "ss33", term: "33/11 kV substation", aka: ["discom substation"], text: "A DISCOM substation that steps 33 kV down to 11 kV for local distribution feeders." },
  { id: "dtr", term: "DTR", aka: ["distribution transformer"], text: "Distribution transformer — steps 11 kV down to 415 / 240 V for consumers. Search a DTR code to trace it up to the TRANSCO grid." },
  { id: "eht", term: "EHT substation", aka: ["transco substation"], text: "Extra-high-tension substation of AP-TRANSCO (400, 220 or 132 kV)." },
  { id: "pgcil", term: "POWERGRID (PGCIL)", aka: ["inter-state", "ists"], text: "The national transmission utility; its 765 / 400 kV inter-state grid links AP to the neighbouring states." },
  { id: "rtss", term: "Railway traction substation", aka: ["rtss"], text: "A substation feeding the railway's electric traction, supplied from the TRANSCO grid." },
  { id: "ht", term: "HT consumer", aka: ["bulk load"], text: "A high-tension (bulk) consumer supplied directly at transmission or sub-transmission voltage." },
  { id: "cp-tower", term: "Cut / angle point (CP)", aka: ["angle tower", "sp"], text: "A tower where the line changes direction (stronger, ringed on the map); SP towers are straight-line suspension towers." },
  { id: "forecast-cone", term: "Forecast cone", text: "The area the cyclone centre may pass through, widening with forecast time. Impacts reach well outside it — never treat ‘outside the cone’ as safe." },
  { id: "gdacs-alert", term: "GDACS alert level", text: "Green / orange / red humanitarian impact levels from the UN-EC Global Disaster Alert and Coordination System." },
  { id: "indicative", term: "Indicative", text: "Derived by the Atlas from public data with a stated rule — good for screening and planning conversations, not an operational or regulatory figure." },
];

export const GLOSSARY_BY_ID: Record<string, GlossaryEntry> = Object.fromEntries(GLOSSARY.map((g) => [g.id, g]));
