import { expect, test } from "@playwright/test";
import { openApp } from "./helpers.ts";

test("phone: map + search usable, the lens panel peeks in a bottom sheet", async ({ page }) => {
  await openApp(page);
  await expect(page.getByRole("combobox", { name: /Search substations/ })).toBeVisible();
  const sheet = page.getByRole("region", { name: "Explore panel" });
  await expect(sheet).toHaveAttribute("data-snap", "peek");
  // At peek only the title row shows — the panel body is inert.
  await expect(page.getByRole("switch", { name: "Toggle generation plants" })).toBeHidden();

  const handle = sheet.getByRole("button", { name: /Resize panel/ });
  await handle.click();
  await expect(sheet).toHaveAttribute("data-snap", "half");
  await expect(page.getByText("Network at a glance")).toBeVisible();

  // Drag the handle up past the middle → snaps to full (once the snap animation has settled).
  await expect
    .poll(() => sheet.evaluate((el: HTMLElement) => Math.abs(el.getBoundingClientRect().height - parseFloat(el.style.height)) < 1))
    .toBe(true);
  const box = (await handle.boundingBox())!;
  const vh = page.viewportSize()!.height;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, vh * 0.12, { steps: 12 });
  await page.mouse.up();
  await expect(sheet).toHaveAttribute("data-snap", "full");
});

test("phone: a selection opens the Inspector in the sheet; lens tabs switch lens", async ({ page }) => {
  await openApp(page, "#v=2&sel=s-ss-132kv-chnd");
  const sheet = page.getByRole("region", { name: "Details" });
  await expect(sheet).toHaveAttribute("data-snap", "half");
  await expect(sheet.getByRole("heading", { name: "CHANDODU" })).toBeVisible();
  await page.getByRole("navigation", { name: "Lens" }).getByRole("button", { name: /Plan/ }).click();
  await expect(page).toHaveURL(/lens=plan/);
  await expect(page.getByText(/Radial feeds/).first()).toBeVisible();
});

test("phone: the Layers drawer opens full-screen from the toolbar and closes", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: /^Layers \d+ on$/ }).click();
  const drawer = page.getByRole("region", { name: "Layers", exact: true });
  await expect(drawer).toBeVisible();
  const box = (await drawer.boundingBox())!;
  expect(box.width).toBeGreaterThan(page.viewportSize()!.width - 2);
  await drawer.getByRole("button", { name: "Close layers" }).click();
  await expect(drawer).toBeHidden();
});
