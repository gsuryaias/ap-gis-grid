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

test("Field: save a circle for offline, then its 11 kV network draws from the pack with the network off", async ({ page, context }) => {
  test.setTimeout(240_000);
  await openApp(page, "#v=2&lens=field");
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker?.controller), { message: "service worker controls the page" }).toBe(true);

  const circle = page.getByLabel("Circle to save for offline use");
  await expect(circle).toBeVisible();
  await circle.selectOption("Vizianagaram");
  await page.getByRole("button", { name: "Save for offline" }).click();
  await expect(page.getByRole("progressbar", { name: /Saving Vizianagaram/ }).or(page.getByText(/Vizianagaram saved for offline/))).toBeVisible();
  await expect(page.getByText(/Vizianagaram saved for offline/)).toBeVisible({ timeout: 180_000 });
  const packs = page.getByRole("list", { name: "Saved offline packs" });
  await expect(packs.getByText("Vizianagaram")).toBeVisible();
  await expect(packs.getByText(/up to date/)).toBeVisible();
  const stored = await page.evaluate(async () => (await (await caches.open("offline")).keys()).map((r) => r.url));
  expect(stored.some((u) => /\/tiles\/discom-11kv-lines\/11\/\d+\/\d+\.pbf\?v=/.test(u))).toBe(true);
  expect(stored.some((u) => /\/tiles\/discom-11kv-lines\/rows\/0\.json\?v=/.test(u))).toBe(true);
  expect(stored.some((u) => /\/data\/lines\.geojson\?v=/.test(u))).toBe(true);

  // Airplane mode: open the circle at feeder zoom with 11 kV on — tiles come from the pack.
  const tiles: { ok: boolean; fromSw: boolean }[] = [];
  page.on("response", (r) => {
    if (r.url().includes("/tiles/discom-11kv-lines/")) tiles.push({ ok: r.ok(), fromSw: r.fromServiceWorker() });
  });
  await context.setOffline(true);
  try {
    await page.goto("./?e2e#@83.3392,18.5637,11.5z&v=2&lens=field&lyr=discom-11kv-lines");
    await waitForGrid(page);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const map = (window as unknown as { __map: { getLayer(id: string): unknown; queryRenderedFeatures(g?: unknown, o?: { layers: string[] }): unknown[] } }).__map;
          return map.getLayer("ov-discom-11kv-lines-line") ? map.queryRenderedFeatures(undefined, { layers: ["ov-discom-11kv-lines-line"] }).length : 0;
        }),
      )
      .toBeGreaterThan(0);
  } finally {
    await context.setOffline(false);
  }
  expect(tiles.length).toBeGreaterThan(0);
  expect(tiles.every((t) => t.ok && t.fromSw)).toBe(true);

  // Delete removes the pack and its cache.
  await page.goto("./?e2e#v=2&lens=field");
  await waitForGrid(page);
  await page.getByRole("button", { name: "Delete the Vizianagaram offline pack" }).click();
  await expect(page.getByRole("list", { name: "Saved offline packs" })).toHaveCount(0);
  expect(await page.evaluate(() => caches.has("offline"))).toBe(false);
});
