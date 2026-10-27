import { defineConfig } from "vite";

const crossOriginIsolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  root: "src",
  define: {
    // fast-json-stringify (via graphql-jit) reads process.versions.node at
    // module load, which throws in the browser and in workers.
    "process.versions.node": JSON.stringify("22.0.0"),
  },
  server: {
    headers: crossOriginIsolationHeaders,
  },
  preview: {
    headers: crossOriginIsolationHeaders,
  },
  build: {
    outDir: "../public",
    emptyOutDir: true,
  },
});
