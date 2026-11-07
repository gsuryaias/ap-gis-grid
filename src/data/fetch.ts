// Fetch helpers shared by the resource loader (main thread) and the search worker. No React, no
// DOM-only APIs beyond fetch — this module must stay importable from a Worker.
import { versionQuery, type DataVersions } from "./data-version.ts";

/** Injected by `scripts/vite-sw.ts` in production builds (absent in dev / tests ⇒ unversioned URLs). */
declare const __DATA_VERSIONS__: DataVersions | undefined;

/** Content versions of the site's data files in this build (see data-version.ts). */
export const DATA_VERSIONS: DataVersions = typeof __DATA_VERSIONS__ === "object" && __DATA_VERSIONS__ ? __DATA_VERSIONS__ : {};

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

/** `?v=<content hash>` for a /data file in a production build, else "". */
export const dataQuery = (file: string): string => versionQuery(`data/${file}`, DATA_VERSIONS);

/**
 * Resolve a /data asset against the Vite base path (works on GitHub Pages project sites), with its
 * content version — so a deploy that changes a file changes its URL.
 */
export function dataUrl(file: string): string {
  return `${import.meta.env.BASE_URL}data/${file}${file ? dataQuery(file) : ""}`;
}
