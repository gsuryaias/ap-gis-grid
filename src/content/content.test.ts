// The trust-layer content holds together: unique ids, every method card complete and linked to
// glossary entries that exist.
import { describe, expect, it } from "vitest";
import { GLOSSARY, GLOSSARY_BY_ID } from "./glossary.ts";
import { METHODS } from "./methods.ts";

describe("trust content", () => {
  it("glossary ids are unique and every entry has text", () => {
    expect(new Set(GLOSSARY.map((g) => g.id)).size).toBe(GLOSSARY.length);
    for (const g of GLOSSARY) expect(g.text.length, g.id).toBeGreaterThan(30);
  });

  it("every method card is complete and links only to existing glossary entries", () => {
    for (const [id, m] of Object.entries(METHODS)) {
      expect(m.id).toBe(id);
      for (const k of ["title", "rule", "source", "vintage", "coverage", "caveat"] as const) expect(m[k].length, `${id}.${k}`).toBeGreaterThan(5);
      for (const t of m.terms) expect(GLOSSARY_BY_ID[t], `${id} → ${t}`).toBeDefined();
    }
  });
});
