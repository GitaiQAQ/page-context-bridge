import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  resolve: {
    dedupe: ["@page-context/shared-protocol"],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      external: (id: string) => {
        if (id === "react" || id === "react-dom" || id === "lit" || id.startsWith("@modelcontextprotocol/")) return true;
        if (/^(node:)?(fs|path|url|http|https|stream|crypto|os|child_process|buffer|async_hooks|net|tls|perf_hooks)/.test(id)) return true;
        return false;
      },
      input: "src/index.ts",
      output: {
        format: "es",
        entryFileNames: "index.js",
        banner: `// bundled by vite — source: packages/page-context-agentation/src/index.ts`,
      },
    },
  },
});
