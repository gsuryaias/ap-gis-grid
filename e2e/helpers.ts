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

export function hasLayer(page: Page, id: string) {
  return page.evaluate((layerId) => {
    const map = (window as unknown as { __map?: { getLayer(id: string): unknown } }).__map;
    return !!map?.getLayer(layerId);
  }, id);
}
