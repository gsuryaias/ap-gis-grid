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
    chunkSizeWarningLimit: 1200, // maplibre-gl is ~285 kB gzipped in its own cached chunk
    rollupOptions: {
      output: {
        manualChunks: {
          maplibre: ["maplibre-gl"],
          vendor: ["react", "react-dom", "zustand", "@tanstack/react-table"],
        },
      },
    },
  },
  test: {
    environment: "node",
    include: ["scripts/**/*.test.ts", "src/**/*.test.ts"],
  },
});
