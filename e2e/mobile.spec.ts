import { expect, test } from "@playwright/test";
import { openApp } from "./helpers.ts";

test("phone: map + search usable, layers collapsed by default", async ({ page }) => {
  await openApp(page);
  await expect(page.getByRole("textbox", { name: /Search substations/ })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Toggle generation plants" })).toBeHidden();
});
