// A Cache API cache with an LRU budget by entry count AND bytes (Atlas 2.0 phase 4 PR 13).
//
// The Cache API keeps no access times or sizes, so each bounded cache keeps a small index
// (url → [bytes, lastUsed]) in memory, persisted as one JSON entry in the `sw-meta` cache (debounced —
// the worker can be stopped at any moment, so the index is rebuilt against `keys()` on the next
// start: entries it doesn't know are oldest, with their size read from the body). Reads never wait
// for the index; puts and trims run one at a time, after the response has gone to the page.
import { evictionPlan, tooBigToCache, type Limits } from "./policy.ts";

/** The slice of the Cache API this module uses (so tests can pass an in-memory fake). */
export interface CacheLike {
  match(req: RequestInfo | URL): Promise<Response | undefined>;
  put(req: RequestInfo | URL, res: Response): Promise<void>;
  delete(req: RequestInfo | URL): Promise<boolean>;
  keys(): Promise<readonly Request[]>;
}
export interface CacheStorageLike {
  open(name: string): Promise<CacheLike>;
}

/** Opaque (no-CORS) bodies can't be measured — count them at a typical tile size. */
export const OPAQUE_BYTES = 64 * 1024;

export async function responseBytes(res: Response): Promise<number> {
  if (res.type === "opaque") return OPAQUE_BYTES;
  try {
    return (await res.clone().blob()).size;
  } catch {
    return 0;
  }
}

type Index = Map<string, { b: number; t: number }>;

export interface BoundedCacheOptions {
  /** Cache holding the persisted indexes. */
  metaCache: string;
  /** Absolute URL the index is stored under in `metaCache`. */
  metaKey: string;
  now?: () => number;
  /** Debounce of the index save (ms). */
  saveDelayMs?: number;
}

export class BoundedCache {
  private index?: Promise<Index>;
  private chain: Promise<unknown> = Promise.resolve();
  private saving: Promise<void> | null = null;
  private readonly now: () => number;
  private readonly saveDelayMs: number;

  constructor(
    private readonly storage: CacheStorageLike,
    readonly name: string,
    readonly limits: Limits,
    private readonly opts: BoundedCacheOptions,
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.saveDelayMs = opts.saveDelayMs ?? 3000;
  }

  private open(): Promise<CacheLike> {
    return this.storage.open(this.name);
  }

  private load(): Promise<Index> {
    return (this.index ??= this.readIndex());
  }

  private async readIndex(): Promise<Index> {
    const [c, meta] = await Promise.all([this.open(), this.storage.open(this.opts.metaCache)]);
    let saved: Record<string, [number, number]> = {};
    try {
      const r = await meta.match(this.opts.metaKey);
      if (r) saved = (await r.json()) as Record<string, [number, number]>;
    } catch {
      /* corrupt / missing index — rebuilt below */
    }
    const idx: Index = new Map();
    for (const req of await c.keys()) {
      const s = saved[req.url];
      if (s) idx.set(req.url, { b: s[0], t: s[1] });
      else {
        const r = await c.match(req);
        idx.set(req.url, { b: r ? await responseBytes(r) : 0, t: 0 });
      }
    }
    return idx;
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.chain.then(job, job);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private scheduleSave(): void {
    if (this.saving) return;
    this.saving = new Promise<void>((resolve) => {
      setTimeout(() => {
        this.saving = null;
        this.writeIndex().then(resolve, () => resolve());
      }, this.saveDelayMs);
    });
  }

  private async writeIndex(): Promise<void> {
    const idx = await this.load();
    const body: Record<string, [number, number]> = {};
    for (const [url, e] of idx) body[url] = [e.b, e.t];
    const meta = await this.storage.open(this.opts.metaCache);
    await meta.put(this.opts.metaKey, new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }));
  }

  /** A cached response (and mark it used). Never waits for the index. */
  async match(req: Request | string): Promise<Response | undefined> {
    const hit = await (await this.open()).match(req);
    if (hit) {
      const url = typeof req === "string" ? req : req.url;
      void this.load().then((idx) => {
        const e = idx.get(url);
        if (e) {
          e.t = this.now();
          this.scheduleSave();
        }
      });
    }
    return hit;
  }

  /** Store a response (pass a clone you don't otherwise read), then trim to budget. */
  put(req: Request | string, res: Response): Promise<void> {
    const url = typeof req === "string" ? req : req.url;
    return this.enqueue(async () => {
      const bytes = await responseBytes(res);
      if (tooBigToCache(bytes, this.limits)) return;
      const c = await this.open();
      await c.put(req, res);
      const idx = await this.load();
      idx.set(url, { b: bytes, t: this.now() });
      const drop = evictionPlan([...idx].map(([u, e]) => ({ url: u, bytes: e.b, t: e.t })), this.limits);
      for (const u of drop) {
        idx.delete(u);
        await c.delete(u);
      }
      this.scheduleSave();
    });
  }

  /** Delete every entry whose URL matches (e.g. superseded content versions). */
  purge(pred: (url: string) => boolean): Promise<number> {
    return this.enqueue(async () => {
      const c = await this.open();
      const idx = await this.load();
      let n = 0;
      for (const req of await c.keys()) {
        if (!pred(req.url)) continue;
        await c.delete(req);
        idx.delete(req.url);
        n++;
      }
      if (n) this.scheduleSave();
      return n;
    });
  }

  /** Entry count and bytes (from the index). */
  async usage(): Promise<{ entries: number; bytes: number }> {
    const idx = await this.load();
    let bytes = 0;
    for (const e of idx.values()) bytes += e.b;
    return { entries: idx.size, bytes };
  }

  /** Resolves once queued puts / trims and the pending index save are done — for `waitUntil`. */
  async idle(): Promise<void> {
    await this.chain;
    if (this.saving) await this.saving;
  }
}
