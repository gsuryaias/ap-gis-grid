// Field mission (Atlas 2.0 phase 5 PR 16): the trace runs up AND down, every feature has
// Navigate links (Google Maps / the phone's maps app / copy coordinates), and the Field panel's
// presets switch satellite, towers and 11 kV with one tap each.
import { expect, test } from "@playwright/test";
import { hasLayer, openApp } from "./helpers.ts";

const SS33 = "ds-ep-3000-185-ss-1000445"; // Arasavalli 33/11 kV SS (APEPDCL)

test("a 33/11 kV substation traces down to its 11 kV feeders, which trace down to transformers", async ({ page }) => {
  await openApp(page, `#v=2&lens=field&sel=${SS33}`);
  const inspector = page.getByRole("complementary", { name: "Feature details" });
  await expect(inspector.getByRole("heading", { name: /Arasavalli/ })).toBeVisible();

  // Up: the supply path to the TRANSCO SS; down: its 11 kV feeders, listed and counted.
  await expect(inspector.getByText("TRANSCO substation")).toBeVisible();
  await expect(inspector.getByText(/^Feeds · 11 kV feeders · \d+/)).toBeVisible();
  await expect(inspector.getByText(/^\d+ feeders$/)).toBeVisible();

  // Navigate bar (Field lens): directions to the substation's point.
  const directions = inspector.getByRole("link", { name: "Directions" });
  await expect(directions).toHaveAttribute("href", /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=18\.\d+,83\.\d+/);
  await expect(inspector.getByRole("link", { name: /Maps app|Apple Maps/ })).toHaveAttribute("href", /^(geo:|https:\/\/maps\.apple\.com)/);
  await expect(inspector.getByRole("button", { name: /Copy coordinates/ })).toBeVisible();

  // Down a level: the feeder carries transformers; its trace links back up to the substation.
  await inspector.getByRole("button", { name: /11KV Arasavalli/ }).first().click();
  await expect(inspector.getByText("11 kV feeder ·", { exact: false }).first()).toBeVisible();
  await expect(inspector.getByText(/^\d+ transformers/)).toBeVisible();
  await expect(inspector.getByRole("link", { name: "Directions" })).toHaveAttribute("href", /destination=18\.\d+,83\.\d+/);
  await expect.poll(() => hasLayer(page, "ov-discom-11kv-lines-line")).toBe(true);
});

test("a 33 kV feeder lists the 33/11 kV substations it serves", async ({ page }) => {
  await openApp(page, `#v=2&lens=field&sel=${SS33}`);
  const inspector = page.getByRole("complementary", { name: "Feature details" });
  await inspector.getByRole("button", { name: /^33KV/ }).first().click(); // the supply path's 33 kV feeder
  await expect(inspector.getByText(/^Feeds · 33\/11 kV substations · \d+/)).toBeVisible();
  await expect(inspector.getByText(/^\d+ served$/)).toBeVisible();
});

test("outside Field the header carries one small directions link", async ({ page }) => {
  await openApp(page, "#v=2&sel=s-ss-132kv-chnd");
  const inspector = page.getByRole("complementary", { name: "Feature details" });
  await expect(inspector.getByRole("link", { name: "Directions in Google Maps" })).toHaveAttribute("href", /google\.com\/maps\/dir/);
  await expect(inspector.getByRole("link", { name: "Directions", exact: true })).toHaveCount(0);
});

test("Field presets: satellite, towers and 11 kV are one tap each", async ({ page }) => {
  await openApp(page, "#v=2&lens=field");
  const panel = page.getByRole("complementary", { name: "Field panel" });
  const sat = panel.getByRole("switch", { name: /Satellite imagery/ });
  const towers = panel.getByRole("switch", { name: /Transmission towers/ });
  const f11 = panel.getByRole("switch", { name: /11 kV feeders/ });
  await expect(sat).toHaveAttribute("aria-checked", "false");
  await expect(towers).toHaveAttribute("aria-checked", "true"); // Field defaults
  await expect(f11).toHaveAttribute("aria-checked", "true");

  await sat.click();
  await expect(sat).toHaveAttribute("aria-checked", "true");
  await expect(page).toHaveURL(/base=satellite/);
  await sat.click();
  await expect(page).not.toHaveURL(/base=satellite/);

  await towers.click();
  await expect(towers).toHaveAttribute("aria-checked", "false");
  await expect(page).toHaveURL(/lyr=[^&]*-towers-400kv/);
  await f11.click();
  await expect(f11).toHaveAttribute("aria-checked", "false");
  await expect(page).toHaveURL(/-discom-11kv-lines/);
});
