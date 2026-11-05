import { beforeAll, describe, expect, it, vi } from "vitest";
import { defineResource, HttpError, isTransient, retryTiming } from "./resources.ts";

beforeAll(() => {
  retryTiming.baseMs = 0;
});

let n = 0;
const uniq = (s: string) => `${s}-${++n}`;
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("resource loader", () => {
  it("de-dupes concurrent loads and caches the result", async () => {
    const load = vi.fn(async (p: string) => `v:${p}`);
    const r = defineResource(uniq("dedupe"), { load });
    const [a, b] = await Promise.all([r.ensure("x"), r.ensure("x")]);
    expect(a).toBe("v:x");
    expect(b).toBe("v:x");
    await r.ensure("x");
    expect(load).toHaveBeenCalledTimes(1);
    expect(r.peek("x")).toBe("v:x");
    expect(r.snapshot("x").status).toBe("ready");
    // a different param is a different key
    await r.ensure("y");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("retries transient failures, then succeeds", async () => {
    let calls = 0;
    const r = defineResource(uniq("retry"), {
      load: async () => {
        calls++;
        if (calls < 3) throw new TypeError("network down");
        return 42;
      },
    });
    await expect(r.ensure()).resolves.toBe(42);
    expect(calls).toBe(3);
  });

  it("does not retry a 404, and the error is not sticky", async () => {
    let calls = 0;
    let fail = true;
    const r = defineResource(uniq("404"), {
      load: async () => {
        calls++;
        if (fail) throw new HttpError(404, "Not Found", "x.json");
        return "ok";
      },
    });
    await expect(r.ensure()).rejects.toThrow(/404/);
    expect(calls).toBe(1);
    expect(r.snapshot().status).toBe("error");
    expect(r.snapshot().error).toMatch(/404/);
    fail = false;
    await expect(r.ensure()).resolves.toBe("ok");
    expect(r.snapshot().status).toBe("ready");
  });

  it("gives up after the retry budget", async () => {
    const load = vi.fn(async () => {
      throw new HttpError(503, "Unavailable", "x.json");
    });
    const r = defineResource(uniq("budget"), { load, retries: 2 });
    await expect(r.ensure()).rejects.toThrow(/503/);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("aborts when every signalled caller has gone, and restarts cleanly", async () => {
    let seen: AbortSignal | null = null;
    let loads = 0;
    const r = defineResource(uniq("abort"), {
      load: (_p, signal) => {
        loads++;
        seen = signal;
        return new Promise<string>((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
          if (loads > 1) resolve("second");
        });
      },
    });
    const a = new AbortController();
    const b = new AbortController();
    const pa = r.ensure("", { signal: a.signal }).catch((e: unknown) => e);
    r.ensure("", { signal: b.signal }).catch(() => undefined);
    a.abort();
    expect(seen!.aborted).toBe(false); // b still wants it
    b.abort();
    expect(seen!.aborted).toBe(true);
    expect(r.snapshot().status).toBe("idle"); // reset synchronously
    expect(await pa).toBeInstanceOf(DOMException);
    // A caller arriving right after (StrictMode remount) starts a fresh load.
    await expect(r.ensure()).resolves.toBe("second");
    expect(loads).toBe(2);
  });

  it("an un-signalled caller pins the load against aborts", async () => {
    let signal: AbortSignal | null = null;
    let resolve!: (v: number) => void;
    const r = defineResource(uniq("pin"), {
      load: (_p, s) => {
        signal = s;
        return new Promise<number>((res) => (resolve = res));
      },
    });
    const pinned = r.ensure();
    const ac = new AbortController();
    r.ensure("", { signal: ac.signal }).catch(() => undefined);
    ac.abort();
    expect(signal!.aborted).toBe(false);
    resolve(7);
    await expect(pinned).resolves.toBe(7);
  });

  it("notifies subscribers and refresh keeps stale data on failure", async () => {
    let v = 1;
    let fail = false;
    const r = defineResource(uniq("refresh"), {
      load: async () => {
        if (fail) throw new HttpError(404, "gone", "x");
        return v;
      },
    });
    const seen: string[] = [];
    const off = r.subscribe("", () => seen.push(r.snapshot().status));
    await r.ensure();
    expect(seen).toEqual(["loading", "ready"]);
    v = 2;
    await r.refresh();
    expect(r.peek()).toBe(2);
    fail = true;
    await r.refresh().catch(() => undefined);
    await tick();
    expect(r.peek()).toBe(2);
    expect(r.snapshot().status).toBe("ready");
    off();
  });

  it("re-polls only while an active (non-passive) subscriber is attached", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {});
    try {
      let v = 0;
      const load = vi.fn(async () => ++v);
      const r = defineResource(uniq("poll"), { load, refreshMs: 1000 });
      await r.ensure();
      // A passive observer alone never starts the timer.
      const offPassive = r.subscribe("", () => undefined, { passive: true });
      await vi.advanceTimersByTimeAsync(3500);
      expect(load).toHaveBeenCalledTimes(1);
      // An active one does…
      const offActive = r.subscribe("", () => undefined);
      await vi.advanceTimersByTimeAsync(2500);
      expect(load).toHaveBeenCalledTimes(3);
      // …and the timer stops with the last active subscriber, even if passive ones remain.
      offActive();
      await vi.advanceTimersByTimeAsync(3000);
      expect(load).toHaveBeenCalledTimes(3);
      offPassive();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("refuses duplicate names", () => {
    const name = uniq("dup");
    defineResource(name, { load: async () => 1 });
    expect(() => defineResource(name, { load: async () => 1 })).toThrow(/twice/);
  });

  it("classifies transient errors", () => {
    expect(isTransient(new TypeError("fetch failed"))).toBe(true);
    expect(isTransient(new HttpError(502, "", "x"))).toBe(true);
    expect(isTransient(new HttpError(429, "", "x"))).toBe(true);
    expect(isTransient(new HttpError(404, "", "x"))).toBe(false);
    expect(isTransient(new DOMException("x", "AbortError"))).toBe(false);
    expect(isTransient(new SyntaxError("bad json"))).toBe(false);
  });
});
