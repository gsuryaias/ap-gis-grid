// Fetch helpers shared by the resource loader (main thread) and the search worker. No React, no
// DOM-only APIs beyond fetch — this module must stay importable from a Worker.

/** HTTP failure with its status, so retry logic can tell 404 from 503. */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, statusText: string, what: string) {
    super(`Failed to load ${what}: ${status} ${statusText}`.trim());
    this.name = "HttpError";
    this.status = status;
  }
}

export const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

/** Retry network failures (fetch TypeError) and server-side HTTP errors; never 4xx or aborts. */
export function isTransient(e: unknown): boolean {
  if (isAbort(e)) return false;
  if (e instanceof HttpError) return e.status >= 500 || e.status === 429;
  return e instanceof TypeError;
}

export async function fetchJson<T>(url: string, signal?: AbortSignal, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, signal });
  if (!res.ok) throw new HttpError(res.status, res.statusText, url.split("/").pop() ?? url);
  return (await res.json()) as T;
}

/** Resolve a /data asset against the Vite base path (works on GitHub Pages project sites). */
export function dataUrl(file: string): string {
  return `${import.meta.env.BASE_URL}data/${file}`;
}
