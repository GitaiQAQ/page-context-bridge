import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    dedupe: ['@page-context/shared-protocol', '@page-context/builtin-tools'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      // Externalize only true npm packages and Node.js built-ins.
      // Workspace packages (@page-context/*) are bundled into the output.
      external: (id: string) => {
        if (id === 'ws' || id === 'zod' || id.startsWith('@modelcontextprotocol/')) return true;
        if (
          /^(node:)?(fs|path|url|http|https|stream|crypto|os|child_process|buffer|async_hooks|net|tls|perf_hooks)/.test(
            id,
          )
        )
          return true;
        return false;
      },
      input: 'src/index.ts',
      output: {
        format: 'es',
        entryFileNames: 'index.js',
        banner: `#!/usr/bin/env node\n// bundled by vite — source: packages/page-context-bridge-server/src/index.ts`,
      },
    },
  },
});
