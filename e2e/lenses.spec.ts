// Lens shell (Atlas 2.0 phase 3): every lens loads over the one map, a lens switch keeps the
// selection and swaps the lens's default layers, and Back steps between lenses.
import { expect, test } from "@playwright/test";
import { hasLayer, openApp } from "./helpers.ts";

const lensTab = (page: import("@playwright/test").Page, name: string) =>
  page.getByRole("navigation", { name: "Lens" }).getByRole("button", { name: new RegExp(name) });

test("each lens loads its panel over the same map", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openApp(page);
  // Tag the map instance: the same object must still be there after every lens switch.
  await page.evaluate(() => ((window as unknown as { __map: { __tag?: number } }).__map.__tag = 42));
  await expect(page.getByRole("complementary", { name: "Explore panel" })).toBeVisible();
  await expect(page.getByText("Network at a glance")).toBeVisible();

  await lensTab(page, "Field").click();
  await expect(page).toHaveURL(/lens=field/);
  await expect(page.getByRole("complementary", { name: "Field panel" }).getByRole("button", { name: /near me/ })).toBeVisible();
  await expect.poll(() => hasLayer(page, "ov-discom-lines-line")).toBe(true);

  await lensTab(page, "Storm").click();
  await expect(page).toHaveURL(/lens=storm/);
  await expect(page.getByRole("complementary", { name: "Storm panel" }).getByText("Situation")).toBeVisible();
  await expect.poll(() => hasLayer(page, "ov-cyclone-shelters-circle")).toBe(true);

  await lensTab(page, "Plan").click();
  await expect(page).toHaveURL(/lens=plan/);
  await expect(page.getByText(/Radial feeds/).first()).toBeVisible();

  // One map the whole time.
  expect(await page.evaluate(() => (window as unknown as { __map: { __tag?: number } }).__map.__tag)).toBe(42);
  expect(errors).toEqual([]);
});

test("switching lens keeps the selection; the old lens's layers go, Back returns", async ({ page }) => {
  await openApp(page, "#v=2&sel=s-ss-132kv-chnd");
  const inspector = page.getByRole("complementary", { name: "Feature details" });
  await expect(inspector.getByRole("heading", { name: "CHANDODU" })).toBeVisible();

  await lensTab(page, "Field").click();
  await expect(page).toHaveURL(/lens=field&sel=s-ss-132kv-chnd/);
  await expect(page).not.toHaveURL(/lyr=/); // exactly the Field defaults
  await expect(inspector.getByRole("heading", { name: "CHANDODU" })).toBeVisible();
  await expect.poll(() => hasLayer(page, "ov-discom-ss-circle")).toBe(true);

  await page.goBack();
  await expect(page).not.toHaveURL(/lens=/);
  await expect(lensTab(page, "Explore")).toHaveAttribute("aria-current", "page");
  // Field's preset overlays are switched off again (the layer stays mounted, hidden).
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __map: { getLayoutProperty(l: string, p: string): unknown } }).__map.getLayoutProperty("ov-discom-ss-circle", "visibility")),
    )
    .toBe("none");
});

test("a lens link with `lyr` overrides the lens defaults", async ({ page }) => {
  await openApp(page, "#v=2&lens=field&lyr=-towers-400kv,-towers-220kv,-towers-132kv");
  await expect.poll(() => hasLayer(page, "ov-discom-lines-line")).toBe(true);
  expect(await hasLayer(page, "ov-towers-400kv-circle")).toBe(false);
});

test("the ⋯ menu is a keyboard-operable menu that opens the dashboards", async ({ page }) => {
  await openApp(page);
  const more = page.getByRole("button", { name: "More" });
  await more.click();
  const menu = page.getByRole("menu", { name: "More" });
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(more).toBeFocused();
  await more.click();
  await menu.getByRole("menuitem", { name: /Network summary/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});
