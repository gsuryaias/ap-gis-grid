// Vite plugin (production builds only): the service worker + content-versioned data URLs
// (Atlas 2.0 phase 4 PR 13).
//
//  - `config`: hashes `public/data/**` + `public/tiles/index.json` (scripts/data-versions.ts) and defines
//    `__DATA_VERSIONS__`, so the app fetches `data/<file>?v=<hash>` (src/data/fetch.ts `dataUrl`).
//  - `generateBundle`: compiles `src/sw/sw.ts` to a classic IIFE `sw.js` with `__SW_BUILD__` (hash of the
//    hashed asset list + data versions — names the per-build caches), `__SW_PRECACHE__` (every
//    `assets/*` file) and `__DATA_VERSIONS__` injected, and emits it at the site root.
// Dev (`vite`) and tests never run it: URLs stay unversioned and no service worker is registered.
import { createHash } from "node:crypto";
import path from "node:path";
import { build, type Plugin } from "vite";
import type { DataVersions } from "../src/data/data-version.ts";
import { computeDataVersions } from "./data-versions.ts";

const PRECACHE = /^assets\/.+\.(js|css|woff2?|svg|png|webp)$/;

export function serviceWorker(): Plugin {
  let root = process.cwd();
  let versions: DataVersions = {};
  return {
    name: "apgg-service-worker",
    apply: "build",
    config(config) {
      root = path.resolve(config.root ?? process.cwd());
      const publicDir = path.resolve(root, typeof config.publicDir === "string" ? config.publicDir : "public");
      versions = computeDataVersions(publicDir);
      return { define: { __DATA_VERSIONS__: JSON.stringify(versions) } };
    },
    generateBundle: {
      order: "post",
      async handler(_options, bundle) {
        const precache = Object.keys(bundle).filter((f) => PRECACHE.test(f)).sort();
        const buildId = createHash("sha1").update(precache.join("\n")).update(JSON.stringify(versions)).digest("hex").slice(0, 10);
        const out = await build({
          configFile: false,
          root,
          publicDir: false,
          logLevel: "warn",
          define: {
            __SW_BUILD__: JSON.stringify(buildId),
            __SW_PRECACHE__: JSON.stringify(precache),
            __DATA_VERSIONS__: JSON.stringify(versions),
          },
          build: {
            write: false,
            target: "es2022",
            minify: true,
            emptyOutDir: false,
            lib: { entry: path.resolve(root, "src/sw/sw.ts"), formats: ["iife"], name: "apggSw", fileName: () => "sw.js" },
          },
        });
        const outputs = Array.isArray(out) ? out : [out];
        const chunk = outputs.flatMap((o) => ("output" in o ? o.output : [])).find((o) => o.type === "chunk");
        if (!chunk || chunk.type !== "chunk") throw new Error("service worker build produced no chunk");
        this.emitFile({
          type: "asset",
          fileName: "sw.js",
          source: `/* AP-TRANSCO Grid Atlas service worker — build ${buildId}. Generated from src/sw/sw.ts by scripts/vite-sw.ts. */\n${chunk.code}`,
        });
      },
    },
  };
}
