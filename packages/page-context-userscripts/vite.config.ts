import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");

interface UserscriptBuildEntry {
  id: string;
  entry: string;
  fileName: string;
  scriptName: string;
  description: string;
  runAt: "document-start" | "document-idle";
}

const ENTRIES: UserscriptBuildEntry[] = [
  {
    id: "react-inspector",
    entry: "src/entries/react-inspector.user.ts",
    fileName: "react-inspector.user.js",
    scriptName: "Page Context React Inspector Bridge",
    description: "Expose read-only React runtime inspection bridge.",
    runAt: "document-idle",
  },
  {
    id: "apollo-client",
    entry: "src/entries/apollo-client.user.ts",
    fileName: "apollo-client.user.js",
    scriptName: "Page Context Apollo Client Bridge",
    description: "Expose read-only Apollo Client cache/query bridge.",
    runAt: "document-idle",
  },
  {
    id: "tanstack-query",
    entry: "src/entries/tanstack-query.user.ts",
    fileName: "tanstack-query.user.js",
    scriptName: "Page Context TanStack Query Bridge",
    description: "Expose read-only TanStack Query cache bridge.",
    runAt: "document-idle",
  },
  {
    id: "jotai-devtools",
    entry: "src/entries/jotai-devtools.user.ts",
    fileName: "jotai-devtools.user.js",
    scriptName: "Page Context Jotai Devtools Bridge",
    description: "Expose read-only Jotai dev store bridge.",
    runAt: "document-idle",
  },
  {
    id: "redux-devtools",
    entry: "src/entries/redux-devtools.user.ts",
    fileName: "redux-devtools.user.js",
    scriptName: "Page Context Redux DevTools Recorder",
    description: "Expose read-only Redux DevTools recorder bridge.",
    runAt: "document-start",
  },
];

function makeUserscriptBanner(entry: UserscriptBuildEntry): string {
  return `// ==UserScript==
// @name         ${entry.scriptName}
// @namespace    page-context.bridge
// @version      0.0.1
// @description  ${entry.description}
// @match        *://*/*
// @grant        none
// @run-at       ${entry.runAt}
// ==/UserScript==`;
}

export default defineConfig(({ mode }) => {
  const target = ENTRIES.find((entry) => entry.id === mode) ?? ENTRIES[0]!;
  const shouldEmptyOutDir = target.id === ENTRIES[0]!.id;

  return {
    build: {
      outDir: "dist",
      emptyOutDir: shouldEmptyOutDir,
      minify: false,
      sourcemap: false,
      rollupOptions: {
        input: resolve(__dirname, target.entry),
        output: {
          format: "iife",
          name: "PageContextUserscriptBridge",
          entryFileNames: target.fileName,
          banner: makeUserscriptBanner(target),
        },
      },
    },
  };
});
