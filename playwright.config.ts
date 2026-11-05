// Playwright smoke suite — runs against the PRODUCTION build (`vite preview`), never the dev server
// (HMR can desync map/store state; see CLAUDE.md). Browsers live in node_modules
// (PLAYWRIGHT_BROWSERS_PATH=0, set by the npm scripts) — nothing is installed globally.
import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;
const BASE = `http://localhost:${PORT}/ap-gis-grid/`;

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 20_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: BASE,
    trace: "retain-on-failure",
    // MapLibre needs WebGL; SwiftShader gives a software GL in headless Chromium.
    launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] }, testIgnore: /mobile\.spec\.ts/ },
    { name: "phone", use: { ...devices["Pixel 7"] }, testMatch: /mobile\.spec\.ts/ },
  ],
  webServer: {
    command: `npx vite preview --port ${PORT} --strictPort`,
    url: BASE,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
