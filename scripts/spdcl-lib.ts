/** Pure helpers for scripts/import-spdcl-11kv.mts (unit-tested in spdcl.test.ts). */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { Position } from "geojson";

/** Truncated GeoServer export: no closing </kml>, or an exception report at the tail. */
export function isTruncated(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const n = Math.min(size, 8192);
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, size - n);
    const tail = buf.toString("utf8");
    return !/<\/kml>\s*$/.test(tail) || tail.includes("ServiceException");
  } finally {
    closeSync(fd);
  }
}

/**
 * Pole tree → as few polylines as possible: walk down from each root and keep extending through the
 * first child; every other child at a branch starts a new part at the branch pole. Parts ≈ leaves,
 * not edges-between-branches (a feeder with many 1-span DTR laterals stays a handful of long lines).
 */
export function chainTree<T extends { x: number; y: number }>(edges: Array<[T, T]>): Position[][] {
  const kids = new Map<T, T[]>();
  const hasParent = new Set<T>();
  for (const [q, c] of edges) {
    (kids.get(q) ?? kids.set(q, []).get(q)!).push(c);
    hasParent.add(c);
  }
  const pos = (p: T): Position => [p.x, p.y];
  const out: Position[][] = [];
  const seen = new Set<T>();
  const walk = (start: T[]) => {
    const stack: T[][] = [start];
    while (stack.length) {
      const path = stack.pop()!;
      let cur = path[path.length - 1];
      for (;;) {
        seen.add(cur);
        const ks = (kids.get(cur) ?? []).filter((k) => !seen.has(k));
        if (!ks.length) break;
        for (const k of ks.slice(1)) stack.push([cur, k]);
        path.push(ks[0]);
        cur = ks[0];
      }
      if (path.length >= 2) out.push(path.map(pos));
    }
  };
  for (const q of kids.keys()) if (!hasParent.has(q) && !seen.has(q)) walk([q]);
  for (const q of kids.keys()) if (!seen.has(q)) walk([q]); // cycles (bad back-links), if any
  return out;
}

