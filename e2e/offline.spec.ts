// Service worker (Atlas 2.0 phase 4 PR 13): data URLs carry their content version, the worker
// serves them from its cache, and a reload with the network off still opens the map.
import { expect, test } from "@playwright/test";
import { openApp, waitForGrid } from "./helpers.ts";

test("data is content-versioned and served by the service worker — the map reopens offline", async ({ page, context }) => {
  await openApp(page);
  // The first visit installs the worker; it claims this tab once activated.
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker?.controller), { message: "service worker controls the page" }).toBe(true);
  const sw = await page.evaluate(() => fetch("./sw.js").then((r) => r.text()));
  expect(sw).toMatch(/build [0-9a-f]{10}/);

  // Online reload: everything now goes through the worker (and lands in its caches).
  const data: { url: string; fromSw: boolean }[] = [];
  page.on("response", (r) => {
    if (/\/data\/[^/]+\.(geo)?json/.test(r.url())) data.push({ url: r.url(), fromSw: r.fromServiceWorker() });
  });
  await page.reload();
  await waitForGrid(page);
  const lines = data.find((d) => d.url.includes("/data/lines.geojson"));
  expect(lines?.url).toMatch(/lines\.geojson\?v=[0-9a-f]{10}$/);
  expect(lines?.fromSw).toBe(true);
  const live = data.find((d) => d.url.includes("/data/live-status.json"));
  if (live) expect(live.url).not.toContain("?v="); // polled for new deploys — never versioned

  // Offline reload: shell, assets and data all come from the worker's caches.
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await context.setOffline(true);
  try {
    await page.reload();
    await waitForGrid(page);
    await expect(page.getByRole("heading", { name: /Grid Atlas/ })).toBeVisible();
    // Really offline (also for the worker's own fetches): an uncached URL fails.
    expect(await page.evaluate(() => fetch(`./data/meta.json?probe=${Date.now()}`).then(() => "online", () => "offline"))).toBe("offline");
  } finally {
    await context.setOffline(false);
  }
  expect(errors).toEqual([]);
});
