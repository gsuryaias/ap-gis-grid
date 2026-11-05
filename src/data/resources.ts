// One resource loader for every lazy asset (Atlas 2.0 phase 1). Replaces the ad-hoc
// "module promise + listeners + catch-resets" patterns that each lazy feature grew on its own.
//
//   const thing = defineResource<T>("thing", { load: (param, signal) => fetchJson(url, signal) });
//   thing.ensure(param?)            → Promise<T>  (de-duped: one request in flight per key)
//   thing.peek(param?)              → T | undefined
//   useResource(thing, param|null)  → { data, status, error }  (null param = disabled)
//
// Semantics:
// - De-dupe: concurrent ensure() calls for one key share a single load.
// - Retry: transient failures (network errors, HTTP 5xx / 429) retry twice with backoff; 4xx don't.
// - Abort: a load started only by signalled callers (hooks) aborts when every one of them has gone
//   away — the key drops back to idle, so a later caller starts fresh. Un-signalled ensure() pins it.
// - Errors are not sticky: the next ensure() after a failure tries again.
// - refreshMs: while anything is subscribed, the resource re-loads on that cadence (only while the
//   tab is visible); a refresh keeps the old data on screen and keeps it on failure.
// The loaded data lives here, outside React/Zustand — stores hold only what they derive from it.
import { useEffect, useSyncExternalStore } from "react";
import { isAbort, isTransient } from "./fetch.ts";

export { dataUrl, fetchJson, HttpError, isTransient } from "./fetch.ts";

export type ResStatus = "idle" | "loading" | "ready" | "error";

export interface ResSnapshot<T> {
  status: ResStatus;
  data: T | undefined;
  error: string | null;
}

export interface ResourceOptions<T> {
  load: (param: string, signal: AbortSignal) => Promise<T>;
  /** Background re-load cadence while subscribed (visible tab only). */
  refreshMs?: number;
  /** Retries for transient failures (default 2). */
  retries?: number;
}

export interface Resource<T> {
  readonly name: string;
  ensure(param?: string, opts?: { signal?: AbortSignal }): Promise<T>;
  peek(param?: string): T | undefined;
  snapshot(param?: string): ResSnapshot<T>;
  subscribe(param: string, fn: () => void): () => void;
  /** Re-load now, keeping current data visible (used by refresh timers and "Refresh" buttons). */
  refresh(param?: string): Promise<T | undefined>;
}

/** Test hook: backoff delays are scaled by this (tests set 0). */
export const retryTiming = { baseMs: 400 };

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

interface Entry<T> {
  snap: ResSnapshot<T>;
  promise: Promise<T> | null;
  controller: AbortController | null;
  /** Signalled waiters still interested in the in-flight load. */
  refs: number;
  /** An un-signalled caller is waiting — the load must not be aborted. */
  pinned: boolean;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
}

const registry = new Map<string, Resource<unknown>>();

export function defineResource<T>(name: string, opts: ResourceOptions<T>): Resource<T> {
  if (registry.has(name)) throw new Error(`resource "${name}" defined twice`);
  const entries = new Map<string, Entry<T>>();
  const retries = opts.retries ?? 2;

  const entry = (param: string): Entry<T> => {
    let e = entries.get(param);
    if (!e) {
      e = { snap: { status: "idle", data: undefined, error: null }, promise: null, controller: null, refs: 0, pinned: false, listeners: new Set(), timer: null };
      entries.set(param, e);
    }
    return e;
  };

  const publish = (e: Entry<T>, patch: Partial<ResSnapshot<T>>) => {
    e.snap = { ...e.snap, ...patch };
    e.listeners.forEach((l) => l());
  };

  async function loadWithRetry(param: string, signal: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await opts.load(param, signal);
      } catch (err) {
        if (attempt >= retries || signal.aborted || !isTransient(err)) throw err;
        await sleep(retryTiming.baseMs * 2 ** attempt, signal);
      }
    }
  }

  function start(param: string, e: Entry<T>, background: boolean): Promise<T> {
    const controller = new AbortController();
    e.controller = controller;
    if (!background) publish(e, { status: "loading", error: null });
    const p = loadWithRetry(param, controller.signal).then(
      (data) => {
        if (e.controller === controller) {
          e.promise = null;
          e.controller = null;
          e.pinned = false;
          e.refs = 0;
          publish(e, { status: "ready", data, error: null });
        }
        return data;
      },
      (err: unknown) => {
        if (e.controller === controller) {
          e.promise = null;
          e.controller = null;
          e.pinned = false;
          e.refs = 0;
          if (isAbort(err)) publish(e, { status: e.snap.data !== undefined ? "ready" : "idle" });
          else if (background && e.snap.data !== undefined) publish(e, { status: "ready" }); // keep stale data
          else publish(e, { status: "error", error: err instanceof Error ? err.message : String(err) });
        }
        throw err;
      },
    );
    e.promise = p;
    return p;
  }

  function attach(e: Entry<T>, signal: AbortSignal | undefined) {
    if (!signal) {
      e.pinned = true;
      return;
    }
    e.refs++;
    signal.addEventListener(
      "abort",
      () => {
        e.refs--;
        if (e.refs > 0 || e.pinned || !e.controller) return;
        // Nobody wants it any more: cancel, and reset synchronously so a caller arriving in the
        // same tick (React StrictMode remount) starts a fresh load instead of joining a dead one.
        const c = e.controller;
        e.controller = null;
        e.promise = null;
        e.refs = 0;
        c.abort();
        publish(e, { status: e.snap.data !== undefined ? "ready" : "idle" });
      },
      { once: true },
    );
  }

  const res: Resource<T> = {
    name,
    ensure(param = "", o) {
      const e = entry(param);
      if (e.snap.status === "ready") return Promise.resolve(e.snap.data as T);
      if (o?.signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
      const p = e.promise ?? start(param, e, false);
      attach(e, o?.signal);
      return p;
    },
    peek: (param = "") => entries.get(param)?.snap.data,
    snapshot: (param = "") => entry(param).snap,
    subscribe(param, fn) {
      const e = entry(param);
      e.listeners.add(fn);
      if (opts.refreshMs && !e.timer && typeof window !== "undefined") {
        e.timer = setInterval(() => {
          if (typeof document === "undefined" || document.visibilityState === "visible") void res.refresh(param).catch(() => undefined);
        }, opts.refreshMs);
      }
      return () => {
        e.listeners.delete(fn);
        if (!e.listeners.size && e.timer) {
          clearInterval(e.timer);
          e.timer = null;
        }
      };
    },
    refresh(param = "") {
      const e = entry(param);
      if (e.promise) return e.promise;
      const p = start(param, e, e.snap.data !== undefined);
      e.pinned = true;
      return p;
    },
  };
  registry.set(name, res as Resource<unknown>);
  return res;
}

const IDLE: ResSnapshot<never> = { status: "idle", data: undefined, error: null };
const noop = () => () => undefined;

/**
 * Subscribe a component to a resource and load it while mounted. `param === null` disables it
 * (no fetch, idle snapshot). Unmounting before the load finishes aborts it if nobody else waits.
 */
export function useResource<T>(res: Resource<T>, param: string | null = ""): ResSnapshot<T> {
  const snap = useSyncExternalStore(
    param === null ? noop : (fn) => res.subscribe(param, fn),
    () => (param === null ? (IDLE as ResSnapshot<T>) : res.snapshot(param)),
  );
  useEffect(() => {
    if (param === null) return;
    const ac = new AbortController();
    res.ensure(param, { signal: ac.signal }).catch(() => undefined); // status carries the error
    return () => ac.abort();
  }, [res, param]);
  return snap;
}
