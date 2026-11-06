// Smoke suite — the user journeys every Atlas 2.0 PR must keep working.
import { expect, test } from "@playwright/test";
import { hasLayer, openApp, openLayers, switchBasemap, toggleLayer } from "./helpers.ts";

test("loads the network and draws the grid", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openApp(page);
  await expect(page.getByRole("heading", { name: /Grid Atlas/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test("search → select a substation → detail + deep link", async ({ page }) => {
  await openApp(page);
  const search = page.getByRole("combobox", { name: /Search substations/ });
  await search.fill("Vijayawada");
  const firstHit = page.getByRole("listbox").getByRole("option").first();
  await expect(firstHit).toBeVisible();
  await firstHit.click();
  await expect(page).toHaveURL(/sel=/);
});

test("places + transformer search answer from the search worker, each file fetched once", async ({ page }) => {
  const data: string[] = [];
  page.on("request", (r) => {
    const m = /\/data\/([^?]+)/.exec(r.url());
    if (m) data.push(m[1]);
  });
  await openApp(page);
  const search = page.getByRole("combobox", { name: /Search substations/ });
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
  await dtr.click();
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
  await toggleLayer(page, "33 kV lines");
  await page.keyboard.press("Escape"); // close the drawer — the Inspector's buttons are what we test
  await expect.poll(() => data.filter((f) => f === "discom-lines.geojson").length).toBe(1);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "GeoJSON", exact: true }).first().click();
  await download;
  expect(data.filter((f) => f === "discom-lines.geojson")).toHaveLength(1);
  expect(data.filter((f) => f === "discom-ss.geojson")).toHaveLength(1);
});

test("generation overlay lazy-loads and survives a basemap switch", async ({ page }) => {
  await openApp(page);
  await toggleLayer(page, "Generation plants");
  await expect.poll(() => hasLayer(page, "grid-generation")).toBe(true);
  await expect(page).toHaveURL(/lyr=gen/);

  await switchBasemap(page, "Dark");
  await expect.poll(() => hasLayer(page, "grid-generation")).toBe(true);
});

test("circle + coastal slice filters are applied and survive a basemap switch", async ({ page }) => {
  await openApp(page, "#v=1&circle=Kadapa&coast=1");
  const ssFilter = () =>
    page.evaluate(() => {
      const map = (window as unknown as { __map?: { getFilter(id: string): unknown } }).__map;
      return JSON.stringify(map?.getFilter("grid-substations") ?? null);
    });
  await expect.poll(ssFilter).toContain('["==",["get","circle"],"Kadapa"]');
  await expect.poll(ssFilter).toContain('["<=",["get","coastalBand"],1]');

  await switchBasemap(page, "Dark");
  await expect.poll(ssFilter).toContain('["==",["get","circle"],"Kadapa"]');
});

test("MIS line-age theme writes feature-state and re-applies after a basemap switch", async ({ page }) => {
  await openApp(page, "#v=1&w=mis&theme=age");
  const themed = () =>
    page.evaluate(() => {
      type M = {
        getLayoutProperty(id: string, p: string): unknown;
        querySourceFeatures(src: string): { id?: string | number }[];
        getFeatureState(f: { source: string; id: string | number }): Record<string, unknown>;
      };
      const map = (window as unknown as { __map?: M }).__map;
      if (!map || map.getLayoutProperty("mis-line-theme", "visibility") !== "visible") return 0;
      return map
        .querySourceFeatures("src-lines")
        .filter((f) => f.id != null && map.getFeatureState({ source: "src-lines", id: f.id }).misC != null).length;
    });
  await expect.poll(themed).toBeGreaterThan(100);

  await switchBasemap(page, "Dark"); // Plan's map has the same Layers drawer
  await expect.poll(themed).toBeGreaterThan(100);
});

test("overlay engine: DISCOM beneath the grid, towers between lines and SS — also after a basemap switch", async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("seeded")) {
      localStorage.setItem("apgg-overlays-v1", JSON.stringify({ enabled: ["discom-lines", "towers-400kv"], discoms: [] }));
      sessionStorage.setItem("seeded", "1");
    }
  });
  await openApp(page);
  const stacked = () =>
    page.evaluate(() => {
      const map = (window as unknown as { __map?: { getLayersOrder(): string[] } }).__map;
      const o = map?.getLayersOrder() ?? [];
      const at = (id: string) => o.indexOf(id);
      const ids = ["ov-discom-lines-line", "grid-lines-casing", "grid-lines-dc", "ov-towers-400kv-circle", "grid-substations"];
      if (ids.some((id) => at(id) < 0)) return false;
      return ids.every((id, i) => i === 0 || at(ids[i - 1]) < at(id)) && o[o.length - 1] === "band-top";
    });
  await expect.poll(stacked, { timeout: 15_000 }).toBe(true);
  // The engine settles: once the map has gone idle, a quiet second brings no more map writes (an
  // unconditional write would re-trigger itself through `styledata` → reconcile forever).
  const writesInQuietSecond = () =>
    page.evaluate(
      () =>
        new Promise<string[]>((resolve) => {
          type M = Record<string, unknown> & { once(e: string, f: () => void): void; loaded(): boolean };
          const map = (window as unknown as { __map: M }).__map;
          const methods = ["setFilter", "setLayoutProperty", "setPaintProperty", "moveLayer", "addLayer", "addSource", "setFeatureState", "removeFeatureState"];
          const start = () =>
            setTimeout(() => {
              const writes: string[] = [];
              const orig = methods.map((m) => map[m]);
              methods.forEach((m, i) => {
                map[m] = (...a: unknown[]) => {
                  writes.push(`${m} ${JSON.stringify(a[0]).slice(0, 60)}`);
                  return (orig[i] as (...x: unknown[]) => unknown).apply(map, a);
                };
              });
              setTimeout(() => {
                methods.forEach((m, i) => (map[m] = orig[i]));
                resolve(writes);
              }, 1000);
            }, 300);
          if (map.loaded()) start();
          else map.once("idle", start);
        }),
    );
  expect(await writesInQuietSecond()).toEqual([]);

  await switchBasemap(page, "Dark");
  await expect.poll(stacked, { timeout: 15_000 }).toBe(true);
  expect(await writesInQuietSecond()).toEqual([]);
});

test("map taps: hover + select a substation; a DISCOM point opens in the Inspector", async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("seeded")) {
      localStorage.setItem("apgg-overlays-v1", JSON.stringify({ enabled: ["discom-ss"], discoms: [] }));
      sessionStorage.setItem("seeded", "1");
    }
  });
  await openApp(page, "#v=1&circle=Vijayawada");
  await expect.poll(() => hasLayer(page, "ov-discom-ss-circle")).toBe(true);
  type P = { x: number; y: number; id: string } | null;
  /** Screen point of a rendered feature on `layer` with nothing from `avoid` within 12 px. */
  const findPoint = (layer: string, avoid: string[]) =>
    page.evaluate(
      ([layer, avoid]) => {
        type F = { id?: string | number; properties: Record<string, unknown>; geometry: { type: string; coordinates: [number, number] } };
        const map = (window as unknown as {
          __map: {
            queryRenderedFeatures(g?: unknown, o?: { layers: string[] }): F[];
            project(c: [number, number]): { x: number; y: number };
            getCanvas(): HTMLCanvasElement;
            getLayer(id: string): unknown;
            isMoving(): boolean;
          };
        }).__map;
        if (map.isMoving()) return null; // wait out the circle fit — screen points would go stale
        const avoidLayers = (avoid as string[]).filter((l) => map.getLayer(l));
        const rect = map.getCanvas().getBoundingClientRect();
        for (const f of map.queryRenderedFeatures(undefined, { layers: [layer as string] })) {
          if (f.geometry.type !== "Point") continue;
          const p = map.project(f.geometry.coordinates);
          // Only points where the map canvas itself is under the pointer (not a panel over it).
          if (document.elementFromPoint(rect.left + p.x, rect.top + p.y) !== map.getCanvas()) continue;
          const near = avoidLayers.length ? map.queryRenderedFeatures([[p.x - 12, p.y - 12], [p.x + 12, p.y + 12]], { layers: avoidLayers }) : [];
          if (!near.length) return { x: rect.left + p.x, y: rect.top + p.y, id: String(f.id ?? f.properties.id) };
        }
        return null;
      },
      [layer, avoid] as const,
    ) as Promise<P>;
  const core = ["grid-substations", "grid-lines-sc", "grid-lines-dc"];

  // A core substation wins a tap over the DISCOM points beneath it, so no need to avoid them.
  await expect.poll(async () => !!(await findPoint("grid-substations", []))).toBe(true);
  const ss = (await findPoint("grid-substations", []))!;
  await page.mouse.move(ss.x, ss.y);
  await expect
    .poll(() =>
      page.evaluate((id) => {
        const map = (window as unknown as { __map: { getFeatureState(f: { source: string; id: string }): { hover?: boolean } } }).__map;
        return !!map.getFeatureState({ source: "src-substations", id }).hover;
      }, ss.id),
    )
    .toBe(true);
  await page.mouse.click(ss.x, ss.y);
  await expect(page).toHaveURL(new RegExp(`sel=${ss.id}`));

  await expect.poll(async () => !!(await findPoint("ov-discom-ss-circle", core))).toBe(true);
  const ds = (await findPoint("ov-discom-ss-circle", core))!;
  await page.mouse.click(ds.x, ds.y);
  // DISCOM features are selectable like everything else: the Inspector shows it, the URL carries it.
  await expect(page).toHaveURL(/sel=ds-/);
  const inspector = page.getByRole("complementary", { name: "Feature details" });
  await expect(inspector.getByText(/33\/11 kV SS/).first()).toBeVisible();
  await expect(inspector.getByRole("heading")).toBeVisible();
});

test("right-click lists what's here; picking an entry opens it", async ({ page }) => {
  await openApp(page, "#v=1&circle=Vijayawada");
  const find = () => page.evaluate(() => {
    type F = { geometry: { coordinates: [number, number] } };
    const map = (window as unknown as {
      __map: { queryRenderedFeatures(g?: unknown, o?: { layers: string[] }): F[]; project(c: [number, number]): { x: number; y: number }; getCanvas(): HTMLCanvasElement; isMoving(): boolean };
    }).__map;
    if (map.isMoving()) return null;
    const rect = map.getCanvas().getBoundingClientRect();
    for (const f of map.queryRenderedFeatures(undefined, { layers: ["grid-substations"] })) {
      const p = map.project(f.geometry.coordinates);
      if (document.elementFromPoint(rect.left + p.x, rect.top + p.y) === map.getCanvas()) return { x: rect.left + p.x, y: rect.top + p.y };
    }
    return null;
  });
  await expect.poll(async () => !!(await find())).toBe(true);
  const ss = await find();
  await page.mouse.click(ss!.x, ss!.y, { button: "right" });
  const list = page.getByRole("complementary", { name: "What's here" });
  await expect(list).toBeVisible();
  await list.getByRole("button", { name: /TRANSCO substation/ }).first().click();
  await expect(page).toHaveURL(/sel=s-/);
  await expect(page.getByRole("complementary", { name: "Feature details" })).toBeVisible();
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

test("v1 deep link opens the Network MIS (the Plan lens)", async ({ page }) => {
  await page.goto("./?e2e#v=1&w=mis");
  const planTab = page.getByRole("navigation", { name: "Lens" }).getByRole("button", { name: /Plan/ });
  await expect(planTab).toHaveAttribute("aria-current", "page");
  await expect(page).toHaveURL(/lens=plan/);
  await expect(page.getByText(/Radial feeds/).first()).toBeVisible();
});

test("browser Back / Forward step through selections without leaving the app (URL v2)", async ({ page }) => {
  await openApp(page);
  await expect(page).toHaveURL(/#@[\d.]+,[\d.]+,[\d.]+z&v=2/); // the camera is in the URL
  const search = page.getByRole("combobox", { name: /Search substations/ });
  await search.fill("Vijayawada");
  await page.getByRole("listbox").getByRole("option").first().click();
  await expect(page).toHaveURL(/sel=s-/);
  const inspector = page.getByRole("complementary", { name: "Feature details" });
  await expect(inspector).toBeVisible();

  await page.goBack();
  await expect(page).not.toHaveURL(/sel=/);
  await expect(page).toHaveURL(/\/ap-gis-grid\/\?e2e#/);
  await expect(inspector).toBeHidden();

  await page.goForward();
  await expect(page).toHaveURL(/sel=s-/);
  await expect(inspector).toBeVisible();
});

test("a v1 link is rewritten to v2; a v2 link restores camera + layers", async ({ page }) => {
  await openApp(page, "#v=1&sel=s-ss-132kv-chnd&gen=1&base=dark");
  await expect(page).toHaveURL(/v=2&sel=s-ss-132kv-chnd&lyr=gen.*base=dark/);
  await expect(page.getByRole("complementary", { name: "Feature details" }).getByRole("heading", { name: "CHANDODU" })).toBeVisible();

  await page.goto("./?e2e#@80.6,16.5,10z&v=2&lyr=discom-ss");
  await page.reload();
  await expect.poll(() => hasLayer(page, "ov-discom-ss-circle")).toBe(true);
  const cam = await page.evaluate(() => {
    const m = (window as unknown as { __map: { getCenter(): { lng: number; lat: number }; getZoom(): number } }).__map;
    return { lng: m.getCenter().lng, lat: m.getCenter().lat, zoom: m.getZoom() };
  });
  expect(cam.lng).toBeCloseTo(80.6, 2);
  expect(cam.lat).toBeCloseTo(16.5, 2);
  expect(cam.zoom).toBeCloseTo(10, 1);
});

test("layers drawer: search the catalogue, Alt-click solo + restore, opacity, zoom-aware legend", async ({ page }) => {
  await openApp(page, "#@80.6,16.5,7z&v=2");
  const drawer = await openLayers(page);
  await drawer.getByRole("tab", { name: "All layers" }).click();
  await drawer.getByRole("textbox", { name: "Find a layer" }).fill("towers");
  await expect(drawer.getByRole("switch")).toHaveCount(3);

  // Switch 132 kV towers on: it is listed as on, but the legend leaves it out below zoom 9.
  await drawer.getByRole("switch", { name: "Toggle 132 kV towers" }).click();
  await expect(page).toHaveURL(/lyr=towers-132kv/);
  const legend = page.getByRole("region", { name: "Legend" });
  await expect(legend.getByText("Transmission grid")).toBeVisible();
  await expect(legend.getByText("132 kV towers")).toHaveCount(0);

  // Alt-click solos: only the towers; the same again restores the grid.
  await drawer.getByRole("switch", { name: "Toggle 132 kV towers" }).click({ modifiers: ["Alt"] });
  await expect(page).toHaveURL(/lyr=towers-132kv,-ss,-ln/);
  await expect(drawer.getByText("Showing only 132 kV towers")).toBeVisible();
  await drawer.getByRole("button", { name: "Restore layers" }).click();
  await expect(page).toHaveURL(/lyr=towers-132kv(&|$)/);

  // Opacity reaches the map paint.
  await drawer.getByRole("tab", { name: /On now/ }).click();
  await expect.poll(() => hasLayer(page, "ov-towers-132kv-circle")).toBe(true);
  await drawer.getByRole("slider", { name: "132 kV towers opacity" }).fill("50");
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __map: { getPaintProperty(l: string, p: string): unknown } }).__map.getPaintProperty("ov-towers-132kv-circle", "circle-opacity")),
    )
    .toBe(0.475);
});

test("filter chips drive the shared filter (map + URL)", async ({ page }) => {
  await openApp(page);
  await page.getByRole("group", { name: "Filters" }).getByRole("button", { name: "400" }).click();
  await expect(page).toHaveURL(/volt=220(,|%2C)132/);
  await page.getByRole("combobox", { name: "Filter by AP-TRANSCO circle" }).selectOption("Kadapa");
  await expect(page).toHaveURL(/circle=Kadapa/);
  await page.getByRole("group", { name: "Filters" }).getByRole("button", { name: "Clear" }).click();
  await expect(page).not.toHaveURL(/volt=|circle=/);
});

test("⌘K omnisearch: palette when empty, layers / actions / areas by name, keyboard pick", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("ControlOrMeta+k");
  const box = page.getByRole("combobox", { name: /Search substations/ });
  await expect(box).toBeFocused();
  const list = page.getByRole("listbox", { name: "Search results" });
  // Empty → the command palette: actions and the other lenses.
  await expect(list.getByRole("group", { name: "Lenses" }).getByRole("option", { name: /Storm lens/ })).toBeVisible();

  // A layer by name, picked with the keyboard: it switches on.
  await box.fill("towers");
  await expect(list.getByRole("group").first()).toHaveAttribute("aria-label", "Layers");
  await box.press("Enter");
  await expect(page).toHaveURL(/lyr=towers-400kv/);

  // An action.
  await box.focus();
  await box.fill("dark basemap");
  await list.getByRole("option", { name: /Dark basemap/ }).click();
  await expect(page).toHaveURL(/base=dark/);

  // An area drills into Plan.
  await box.focus();
  await box.fill("kadapa");
  await list.getByRole("group", { name: "Areas" }).getByRole("option").first().click();
  await expect(page).toHaveURL(/lens=plan.*mf=circle:Kadapa/);
  await expect(page.getByRole("navigation", { name: "Drill path" }).getByText("Kadapa")).toBeVisible();
});

test("trust layer: an Indicative chip opens its method card; its glossary link opens the glossary at that term", async ({ page }) => {
  await openApp(page, "#v=2&sel=s-ss-132kv-chnd");
  const inspector = page.getByRole("complementary", { name: "Feature details" });
  await inspector.getByRole("button", { name: /how “Vulnerability screening score” is worked out/ }).click();
  const card = page.getByRole("dialog", { name: "Vulnerability screening score" });
  await expect(card.getByText("How it is worked out")).toBeVisible();
  await card.getByRole("button", { name: "Single-fed substation" }).click();
  const glossary = page.getByRole("dialog", { name: "Glossary" });
  await expect(glossary).toBeVisible();
  await expect(glossary.locator("#gl-single-fed")).toHaveClass(/bg-accent/);
});

test("one toast system + dialogs trap focus and close on Escape", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openApp(page);
  await page.getByRole("button", { name: "Copy link" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Link to this view copied." })).toBeVisible();

  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: /Network summary/ }).click();
  const dialog = page.getByRole("dialog", { name: "Network summary" });
  await expect(dialog).toBeVisible();
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "More" })).toBeFocused();
});
