import { expect, type Page } from "@playwright/test";

/** Open the app with the e2e map hook and wait until the core grid is drawn. */
export async function openApp(page: Page, hash = "") {
  await page.goto(`./?e2e${hash}`);
  await waitForGrid(page);
}

export async function waitForGrid(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const map = (window as unknown as { __map?: { getLayer(id: string): unknown; loaded(): boolean } }).__map;
          return !!map && !!map.getLayer("grid-lines-casing") && !!map.getLayer("grid-substations");
        }),
      { message: "core grid layers mounted" },
    )
    .toBe(true);
}

/** Is `layer` drawn from vector tiles in this build (`npm run build:tiles` ran before `build`)? */
export function isTiled(page: Page, layer: string) {
  return page.evaluate(async (id) => {
    try {
      const r = await fetch("./tiles/index.json");
      return r.ok && !!((await r.json()) as { layers: Record<string, unknown> }).layers[id];
    } catch {
      return false;
    }
  }, layer);
}

export function hasLayer(page: Page, id: string) {
  return page.evaluate((layerId) => {
    const map = (window as unknown as { __map?: { getLayer(id: string): unknown } }).__map;
    return !!map?.getLayer(layerId);
  }, id);
}

/** Open the Layers drawer (if it isn't) and return it. */
export async function openLayers(page: Page) {
  const drawer = page.getByRole("region", { name: "Layers", exact: true });
  if (!(await drawer.isVisible())) await page.getByRole("button", { name: /^Layers \d+ on$/ }).click();
  await expect(drawer).toBeVisible();
  return drawer;
}

/** Switch a layer from the drawer's "All layers" catalogue (`label` as the catalogue names it). */
export async function toggleLayer(page: Page, label: string) {
  const drawer = await openLayers(page);
  await drawer.getByRole("tab", { name: "All layers" }).click();
  await drawer.getByRole("switch", { name: `Toggle ${label}` }).click();
}

/**
 * Switch basemap and wait until the engine has re-mounted everything on the NEW style. setStyle
 * keeps the old style (and our layers) until the new style JSON arrives, so "grid layers exist"
 * alone can pass on the outgoing style; a new `band-top` sentinel instance proves the re-mount.
 */
export async function switchBasemap(page: Page, name: "Light" | "Dark" | "Satellite") {
  type W = { __map: { getLayer(id: string): unknown }; __oldTop?: unknown };
  await page.evaluate(() => {
    const w = window as unknown as W;
    w.__oldTop = w.__map.getLayer("band-top");
  });
  const drawer = await openLayers(page);
  await drawer.getByRole("group", { name: "Basemap" }).getByRole("button", { name, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`base=${name.toLowerCase()}`));
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const w = window as unknown as W;
          const top = w.__map.getLayer("band-top");
          return !!top && top !== w.__oldTop;
        }),
      { message: "engine re-mounted on the new style" },
    )
    .toBe(true);
  await waitForGrid(page);
}
