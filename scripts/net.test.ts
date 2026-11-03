import { describe, expect, it } from "vitest";
import { feederLabel, kva, linkSpdcl, mergeParts, epSsIdIndex } from "./etl-network.ts";
import { groupPoints, lineDiff, NET_LAYERS, pickFields, serialiseGrouped, ungroupPoints } from "./net-lib.ts";

describe("privacy allow-lists", () => {
  it("never keeps personal / HT-consumer / surveyor fields", () => {
    const banned = ["dtr_loc_name", "ht_scno", "remarks", "ime_no", "created_by", "created_user", "last_edited_user", "test"];
    for (const l of NET_LAYERS) for (const b of banned) expect(l.keep).not.toContain(b);
    // No HT consumer layer is configured at all.
    expect(NET_LAYERS.some((l) => /ht/i.test(l.label) && !/11 kV/.test(l.label))).toBe(false);
  });

  it("pickFields keeps only allow-listed, non-null attributes (case-insensitive)", () => {
    expect(pickFields({ DTR_CODE: "05", dtr_loc_name: "SOMEONE HOUSE", ht_scno: "X", pole_no: null }, ["dtr_code", "pole_no"])).toEqual({ dtr_code: "05" });
  });
});

describe("grouped points", () => {
  const pts = [
    { lng: 80, lat: 16, props: { feeder_id: "F1", dtr_code: "002", cap: "25 KVA" } },
    { lng: 80.1, lat: 16, props: { feeder_id: "F1", dtr_code: "001", cap: "25 KVA" } },
    { lng: 81, lat: 17, props: { dtr_code: "900" } },
  ];
  it("round-trips through the serialised form", () => {
    const f = groupPoints(pts, "feeder_id", "dtr_code", { layer: "x", fetchedAt: "" });
    expect(f.groups.find((g) => g.key === "F1")!.attrs).toEqual({ cap: "25 KVA" });
    const back = ungroupPoints(JSON.parse(serialiseGrouped(f)));
    const key = (p: { lng: number; props: Record<string, unknown> }) => `${p.lng}|${JSON.stringify(Object.entries(p.props).sort())}`;
    expect(back.map(key).sort()).toEqual(pts.map(key).sort());
  });
  it("diffs serialised files line by line", () => {
    expect(lineDiff("a\nb\nc", "a\nc\nd")).toEqual({ added: 1, removed: 1 });
    expect(lineDiff(null, "a\nb").added).toBe(2);
  });
});

describe("11 kV ETL helpers", () => {
  it("merges 2-point spans through degree-2 nodes only", () => {
    const parts = [
      [[0, 0], [1, 0]],
      [[1, 0], [2, 0]],
      [[2, 0], [3, 0]],
      [[2, 0], [2, 1]], // branch at (2,0) → degree 3 there
    ];
    const merged = mergeParts(parts);
    expect(merged.length).toBe(3);
    expect(merged.some((m) => m.length === 3)).toBe(true); // (0,0)-(1,0)-(2,0)
  });
  it("labels, kVA and SS linking", () => {
    expect(feederLabel("11KV 11K.V.TIRUMALAPURAM")).toBe("11KV Tirumalapuram");
    expect(kva("100 KVA")).toBe(100);
    expect(kva("x")).toBeNull();
    const idx = epSsIdIndex([{ id: "ds-ep-1000-42-ss-10001611", discom: "APEPDCL", name: "Revidi", lng: 0, lat: 0 }]);
    expect(idx.get("10001611")).toBe("ds-ep-1000-42-ss-10001611");
    const ss = [
      { id: "a", discom: "APSPDCL", name: "Saipeta", lng: 80, lat: 16 },
      { id: "b", discom: "APSPDCL", name: "Other", lng: 80.001, lat: 16 },
    ];
    expect(linkSpdcl("Saipeta", [[[80.01, 16], [80.02, 16]]], ss)).toEqual({ id: "a", method: "name" });
    expect(linkSpdcl(null, [[[80.0012, 16], [80.03, 16]]], ss)).toEqual({ id: "b", method: "proximity" });
    expect(linkSpdcl(null, [[[81, 16], [81.1, 16]]], ss)).toBeNull();
  });
});
