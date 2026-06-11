import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  appType: "custom", // server.mjs owns routing; vite serves modules + HMR
  optimizeDeps: {
    // pre-bundle so dep discovery doesn't full-reload the page mid-session
    include: ["three", "three/addons/utils/BufferGeometryUtils.js"],
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        explore: resolve(import.meta.dirname, "explore.html"),
      },
    },
  },
});
