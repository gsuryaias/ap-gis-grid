// Storm situation (Atlas 2.0 phase 5 PR 15) against a mocked GDACS cyclone making landfall near
// Kakinada: the panel shows the warning envelope, supply exposure, downstream 33/11 kV and the
// circle board; the map halos the envelope; print media shows only the briefing. Open-Meteo and
// RainViewer are cut off, so the test is hermetic and the circles without a forecast read
// "No information" (never "Clear").
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { openApp } from "./helpers.ts";

const box = (x0: number, y0: number, x1: number, y1: number) => [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]];

async function mockCyclone(page: Page) {
  await page.route(/open-meteo\.com|rainviewer\.com/, (r) => r.abort());
  await page.route(/gdacs\.org\/gdacsapi\/api\/events\/geteventlist/, (r) =>
    r.fulfill({
      json: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [84.5, 15] },
            properties: {
              eventid: 1000999,
              name: "Testcyclone",
              eventname: "Testcyclone",
              alertlevel: "Red",
              iscurrent: "true",
              country: "India",
              fromdate: "2026-11-05T00:00:00",
              todate: "2026-11-08T00:00:00",
              severitydata: { severitytext: "Severe cyclonic storm" },
              url: { geometry: "https://www.gdacs.org/fixture/geometry", report: "https://www.gdacs.org/fixture/report" },
            },
          },
        ],
      },
    }),
  );
  await page.route(/gdacs\.org\/fixture\/geometry/, (r) =>
    r.fulfill({
      json: {
        type: "FeatureCollection",
        features: [
          { type: "Feature", properties: { Class: "Poly_Cones" }, geometry: { type: "Polygon", coordinates: box(81.9, 16.6, 82.6, 17.3) } },
          { type: "Feature", properties: { Class: "Line_Line_0" }, geometry: { type: "LineString", coordinates: [[85, 14.5], [82.25, 16.95], [81.5, 17.6]] } },
          { type: "Feature", properties: { Class: "Point_Centroid" }, geometry: { type: "Point", coordinates: [84.5, 15] } },
        ],
      },
    }),
  );
}

test.use({ reducedMotion: "reduce" });

test("the Storm lens screens the network against an active cyclone", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await mockCyclone(page);
  await openApp(page, "#v=2&lens=storm");
  const panel = page.getByRole("complementary", { name: "Storm panel" });

  await expect(panel.getByText(/1 active system · \d+ substations in the warning envelope/)).toBeVisible();
  await expect(panel.getByText("Testcyclone")).toBeVisible();
  await expect(panel.getByRole("list", { name: "Substations in the warning envelope" }).getByRole("listitem").first()).toBeVisible();
  await expect(panel.getByText(/Radial pockets · \d+/)).toBeVisible();
  await expect(panel.getByText(/\d+ 33\/11 kV SS · \d+ 33 kV feeders/)).toBeVisible();

  const board = panel.getByRole("list", { name: "Circle status" });
  await expect(board.getByRole("listitem").first()).toContainText("Warning");
  await expect(board).toContainText("No information");
  await expect(board).not.toContainText("Clear");

  // The populated panel passes WCAG 2.2 AA (serious + critical), dark-on-tint status chips included.
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .include('[aria-label="Storm panel"]')
    .analyze();
  expect(axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes[0]?.target}`)).toEqual([]);

  // The map halo follows the envelope.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const map = (window as unknown as { __map: { getFilter(id: string): unknown } }).__map;
        const f = map.getFilter("wx-risk-substations") as [string, unknown, [string, string[]]] | undefined;
        return f?.[2]?.[1]?.length ?? 0;
      }),
    )
    .toBeGreaterThan(5);

  // A row selects the substation in the Inspector.
  const first = panel.getByRole("list", { name: "Substations in the warning envelope" }).getByRole("button").first();
  const ssName = (await first.locator("span").first().textContent())!.trim();
  await first.click();
  await expect(page.getByRole("complementary", { name: "Feature details" }).getByRole("heading", { name: ssName })).toBeVisible();

  // Print media shows the briefing alone.
  await page.emulateMedia({ media: "print" });
  const sheet = page.locator(".print-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("heading", { name: "AP-TRANSCO Storm briefing" })).toBeVisible();
  await expect(sheet).toContainText("Testcyclone");
  await expect(sheet).toContainText(ssName);
  await expect(page.locator("#root")).toBeHidden();
  await page.emulateMedia({ media: "screen" });
  await expect(sheet).toBeHidden();
  expect(errors).toEqual([]);
});
