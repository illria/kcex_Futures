import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const webRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: webRoot,
  server: {
    host: "127.0.0.1",
    port: 6666,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:6667",
        ws: true,
      },
    },
  },
  build: {
    outDir: resolve(webRoot, "../../dist/web"),
    emptyOutDir: true,
  },
});
