/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// GitHub Pages project site is served from /<repo>/. Override with BASE_PATH for a
// user/org site ("/") or a different repo name.
const base = process.env.BASE_PATH ?? "/ap-gis-grid/";

export default defineConfig({
  base,
  plugins: [react(), tailwindcss()],
  build: {
    target: "es2022",
    sourcemap: false,
  },
  test: {
    environment: "node",
    include: ["scripts/**/*.test.ts", "src/**/*.test.ts"],
  },
});
