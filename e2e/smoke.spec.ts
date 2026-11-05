// Smoke suite — the user journeys every Atlas 2.0 PR must keep working. Phase-2/3 journeys that the
// current UI cannot do yet are declared with test.fixme so they flip on as the revamp lands.
import { expect, test } from "@playwright/test";
import { hasLayer, openApp, waitForGrid } from "./helpers.ts";

test("loads the network and draws the grid", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openApp(page);
  await expect(page.getByRole("heading", { name: /Grid Atlas/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test("search → select a substation → detail + deep link", async ({ page }) => {
  await openApp(page);
  const search = page.getByRole("textbox", { name: /Search substations/ });
  await search.fill("Vijayawada");
  const firstHit = page.getByRole("listbox").getByRole("option").first();
  await expect(firstHit).toBeVisible();
  await firstHit.getByRole("button").click();
  await expect(page).toHaveURL(/sel=/);
});

test("places + transformer search answer from the search worker, each file fetched once", async ({ page }) => {
  const data: string[] = [];
  page.on("request", (r) => {
    const m = /\/data\/([^?]+)/.exec(r.url());
    if (m) data.push(m[1]);
  });
  await openApp(page);
  const search = page.getByRole("textbox", { name: /Search substations/ });
  await search.click();
  await search.fill("Tirupati");
  const list = page.getByRole("listbox");
  await expect(list.getByText("Places")).toBeVisible();
  await expect(list.getByRole("option").filter({ hasText: /city/ }).first()).toBeVisible();
  expect(page.workers().length).toBeGreaterThan(0); // the tiers live in the worker

  // A DTR code fetches only its shard; picking it opens the trace card.
  await search.fill("034400109033");
  const dtr = list.getByRole("option").filter({ hasText: "034400109033" });
  await expect(dtr).toBeVisible();
  await dtr.getByRole("button").click();
  await expect(page.getByRole("heading", { name: "034400109033" })).toBeVisible();

  const counts = data.reduce<Record<string, number>>((a, f) => ((a[f] = (a[f] ?? 0) + 1), a), {});
  expect(counts["places.json"]).toBe(1);
  expect(counts["search-network.json"]).toBe(1);
  expect(Object.keys(counts).filter((f) => f.startsWith("net-dtr-"))).toEqual(["net-dtr-ep-0344.json"]);
});

test("33 kV overlay + downstream GeoJSON share one DISCOM download", async ({ page }) => {
  const data: string[] = [];
  page.on("request", (r) => {
    const m = /\/data\/([^?]+)/.exec(r.url());
    if (m) data.push(m[1]);
  });
  await openApp(page, "#v=1&sel=s-ss-132kv-chnd");
  await page.getByRole("switch", { name: "Toggle 33 kV lines" }).click();
  await expect.poll(() => data.filter((f) => f === "discom-lines.geojson").length).toBe(1);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "GeoJSON", exact: true }).first().click();
  await download;
  expect(data.filter((f) => f === "discom-lines.geojson")).toHaveLength(1);
  expect(data.filter((f) => f === "discom-ss.geojson")).toHaveLength(1);
});

test("generation overlay lazy-loads and survives a basemap switch", async ({ page }) => {
  await openApp(page);
  await page.getByRole("switch", { name: "Toggle generation plants" }).click();
  await expect.poll(() => hasLayer(page, "grid-generation")).toBe(true);
  await expect(page).toHaveURL(/gen=1/);

  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await expect(page).toHaveURL(/base=dark/);
  await waitForGrid(page);
  await expect.poll(() => hasLayer(page, "grid-generation")).toBe(true);
});

test("overlay choices saved by the old store (legacy localStorage shape) are restored", async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("seeded")) {
      localStorage.setItem("apgg-overlays-v1", JSON.stringify({ enabled: ["discom-ss"], discoms: ["APEPDCL"] }));
      sessionStorage.setItem("seeded", "1");
    }
  });
  await openApp(page);
  await expect.poll(() => hasLayer(page, "ov-discom-ss-circle")).toBe(true);
  // Still stored in the legacy raw shape (older cached builds can read it).
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("apgg-overlays-v1") ?? "null"));
  expect(stored).toEqual({ enabled: ["discom-ss"], discoms: ["APEPDCL"] });
});

test("data table and map share one filter model", async ({ page }) => {
  await openApp(page, "#v=1&tbl=1");
  const ssTab = page.getByRole("button", { name: /^Substations · / });
  const before = Number((await ssTab.innerText()).replace(/\D/g, ""));
  const sheet = page.getByRole("separator", { name: "Resize table" }).locator("..");
  await sheet.getByRole("button", { name: "400", exact: true }).click();
  // The table chip drives the shared filter: the URL (= map filter) drops 400 kV …
  await expect(page).toHaveURL(/volt=220(,|%2C)132/);
  // … and the table lists fewer substations.
  await expect.poll(async () => Number((await ssTab.innerText()).replace(/\D/g, ""))).toBeLessThan(before);
  await sheet.getByRole("button", { name: "Clear filters" }).click();
  await expect(page).not.toHaveURL(/volt=/);
  await expect.poll(async () => Number((await ssTab.innerText()).replace(/\D/g, ""))).toBe(before);
});

test("v1 deep link opens the Network MIS", async ({ page }) => {
  await page.goto("./?e2e#v=1&w=mis");
  const misTab = page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: /MIS/ });
  await expect(misTab).toHaveAttribute("aria-current", "page");
  await expect(page.getByText(/Radial feeds/).first()).toBeVisible();
});

test.fixme("browser Back clears a selection without leaving the app (URL v2, phase 2)", async ({ page }) => {
  await openApp(page, "#v=1&sel=s-placeholder");
  await page.goBack();
  await expect(page).toHaveURL(/ap-gis-grid/);
});
