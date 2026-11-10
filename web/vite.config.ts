// The page, built into web/dist; the cockpit server (src/serve.ts) serves it.
//   npm run build        once
//   npm run dev:web      rebuild on every change (reload the page to see it)
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [svelte()],
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 2000, target: "es2022" },
});
