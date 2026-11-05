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
