// Accessibility (WCAG 2.2 AA, axe-core) on each lens, the Layers drawer and the dialogs — serious
// and critical violations fail. The map canvas itself is excluded (a WebGL picture; its contents are
// reachable through search, the Inspector and the data table).
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { openApp, openLayers } from "./helpers.ts";

// Reduced motion: no colour transitions mid-flight when axe samples contrast.
test.use({ colorScheme: "light", reducedMotion: "reduce" });

async function violations(page: Page) {
  const r = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .exclude(".maplibregl-canvas-container")
    .analyze();
  return r.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

for (const lens of ["explore", "field", "plan", "storm"] as const) {
  test(`a11y: ${lens} lens`, async ({ page }) => {
    await openApp(page, lens === "explore" ? "" : `#v=2&lens=${lens}`);
    if (lens === "plan") await expect(page.getByText(/Radial feeds/).first()).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });
}

test("a11y: layers drawer, search results, glossary, shortcuts", async ({ page }) => {
  await openApp(page);
  await openLayers(page);
  expect(await violations(page)).toEqual([]);
  await page.keyboard.press("Escape");

  const box = page.getByRole("combobox", { name: /Search substations/ });
  await box.fill("kadapa");
  await expect(page.getByRole("listbox", { name: "Search results" })).toBeVisible();
  expect(await violations(page)).toEqual([]);
  await box.press("Escape");
  await box.press("Escape");

  await page.keyboard.press("g");
  const glossary = page.getByRole("dialog", { name: "Glossary" });
  await expect(glossary).toBeVisible();
  expect(await violations(page)).toEqual([]);
  // Esc closes the dialog and focus does not stay trapped behind it.
  await page.keyboard.press("Escape");
  await expect(glossary).toBeHidden();

  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  expect(await violations(page)).toEqual([]);
});
