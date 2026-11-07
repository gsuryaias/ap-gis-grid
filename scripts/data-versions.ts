// Content hashes of the site's data files (Atlas 2.0 phase 4 PR 13) → `DataVersions`, injected into the
// production bundle and the service worker by `scripts/vite-sw.ts`. Contract: src/data/data-version.ts.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { UNVERSIONED, versionKey, type DataVersions } from "../src/data/data-version.ts";

const sha = (b: Buffer | string) => createHash("sha1").update(b).digest("hex");

/** Site-relative paths of every versioned file under `publicDir` (data/** + tiles/index.json), sorted. */
export function versionedFiles(publicDir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const d of readdirSync(path.join(publicDir, rel), { withFileTypes: true })) {
      if (d.name.startsWith(".")) continue;
      const p = `${rel}/${d.name}`;
      if (d.isDirectory()) walk(p);
      else if (!UNVERSIONED.has(p)) out.push(p);
    }
  };
  if (existsSync(path.join(publicDir, "data"))) walk("data");
  if (existsSync(path.join(publicDir, "tiles/index.json"))) out.push("tiles/index.json");
  return out.sort();
}

/** `versionKey` → 10-hex content hash (a group's hash covers every member's name + content). */
export function computeDataVersions(publicDir: string): DataVersions {
  const groups = new Map<string, string[]>();
  for (const f of versionedFiles(publicDir)) {
    const k = versionKey(f);
    const parts = groups.get(k) ?? [];
    parts.push(`${f}:${sha(readFileSync(path.join(publicDir, f)))}`);
    groups.set(k, parts);
  }
  return Object.fromEntries([...groups].map(([k, parts]) => [k, sha(parts.join("\n")).slice(0, 10)]));
}
