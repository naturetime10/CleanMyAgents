import { defineConfig } from "electron-vite";

export default defineConfig({
  main: { build: { rollupOptions: { input: "src/main/index.ts" } } },
  preload: { build: { rollupOptions: { input: "src/preload/index.ts" } } },
  renderer: {
    root: "src/renderer",
    build: {
      rollupOptions: {
        input: {
          panel: "src/renderer/panel.html",
          island: "src/renderer/island.html",
        },
      },
    },
  },
});
