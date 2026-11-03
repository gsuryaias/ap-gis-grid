import { describe, expect, it } from "vitest";
import {
  buildWebTowers,
  canonicalCpSp,
  diffTowers,
  groupTowers,
  naturalCompare,
  normLineName,
  serialiseTowers,
  towerKeys,
  ungroupTowers,
  type TowerPoint,
} from "./towers-lib.ts";

const t = (line: string | null, no: string, extra: Record<string, unknown> = {}, lng = 80, lat = 16): TowerPoint => ({
  lng,
  lat,
  props: { ...(line ? { line_name: line } : {}), tower_number: no, circle: "Guntur", tower_type: "P+0", cp_sp: "SP", ...extra },
});

const pts = [
  t("L1", "10", { tower_type: "S+0", cp_sp: "Cp" }, 80.2),
  t("L1", "2", {}, 80.1),
  t("L1", "1", { cp_sp: "CP" }, 80.0),
  t("L2  ", "1", { circle: "Ongole", span: 0.3 }),
  t(null, "X"),
];
const meta = { layer: "towers-132kv", voltage: 132, fetchedAt: "2026-11-03T00:00:00Z" };

describe("grouped tower storage", () => {
  const f = groupTowers(pts, meta);

  it("stores shared attributes once per line and varying ones per tower", () => {
    const l1 = f.lines.find((l) => l.line_name === "L1")!;
    expect(l1.attrs).toEqual({ circle: "Guntur" });
    expect(f.cols[0]).toBe("tower_number");
    expect(f.cols).toContain("tower_type");
    expect(f.count).toBe(5);
    // natural order within a line: 1, 2, 10
    expect(f.towers.filter((r) => r[0] === f.lines.indexOf(l1)).map((r) => r[3])).toEqual(["1", "2", "10"]);
  });

  it("round-trips losslessly (including nameless towers)", () => {
    const back = JSON.parse(serialiseTowers(f));
    const a = towerKeys(ungroupTowers(back));
    const b = towerKeys(pts.map((p) => ({ ...p, props: { ...p.props, line_name: (p.props.line_name as string | undefined)?.trim() } })));
    expect(diffTowers(b, a)).toEqual({ added: 0, removed: 0, modified: 0 });
  });

  it("detects added / removed / modified towers", () => {
    const prev = towerKeys(pts);
    const next = towerKeys([...pts.slice(0, 3).map((p, i) => (i === 0 ? { ...p, lat: 17 } : p)), t("L3", "1")]);
    expect(diffTowers(prev, next)).toEqual({ added: 1, removed: 2, modified: 1 });
  });
});

describe("web output", () => {
  it("dictionary-encodes columns, matches lines and summarises per line", () => {
    const raw = groupTowers(pts, meta);
    const ids = new Map([[normLineName("L1"), ["l-0001"]]]);
    const { web, stats, matchedLines, matchedTowers } = buildWebTowers(raw, ids, "now");
    expect(matchedLines).toBe(1);
    expect(matchedTowers).toBe(3);
    const typeCol = web.cols.indexOf("tower_type");
    expect(web.dicts[typeCol]).toEqual(["P+0", "S+0"]);
    expect(stats.get("l-0001")).toEqual({ n: 3, cp: 2, sp: 1, types: [["P+0", 2], ["S+0", 1]] });
  });

  it("helpers", () => {
    expect(canonicalCpSp("Cp")).toBe("CP");
    expect(canonicalCpSp("CPP")).toBe("CP");
    expect(canonicalCpSp("boom")).toBe("Boom");
    expect(canonicalCpSp(null)).toBeNull();
    expect(naturalCompare("T-9", "T-10")).toBeLessThan(0);
    expect(normLineName(" 132KV  A- B ")).toBe("132kv a- b");
  });
});
