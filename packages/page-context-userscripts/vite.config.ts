import { createHash } from "node:crypto";
import { statSync } from "node:fs";
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
    scriptName: "React Inspector (Page Context Bridge)",
    description: "Expose read-only React runtime inspection bridge.",
    runAt: "document-idle",
  },
  {
    id: "apollo-client",
    entry: "src/entries/apollo-client.user.ts",
    fileName: "apollo-client.user.js",
    scriptName: "Apollo Client (Page Context Bridge)",
    description: "Expose read-only Apollo Client cache/query bridge.",
    runAt: "document-idle",
  },
  {
    id: "tanstack-query",
    entry: "src/entries/tanstack-query.user.ts",
    fileName: "tanstack-query.user.js",
    scriptName: "TanStack Query (Page Context Bridge)",
    description: "Expose read-only TanStack Query cache bridge.",
    runAt: "document-idle",
  },
  {
    id: "jotai-devtools",
    entry: "src/entries/jotai-devtools.user.ts",
    fileName: "jotai-devtools.user.js",
    scriptName: "Jotai Devtools (Page Context Bridge)",
    description: "Expose read-only Jotai dev store bridge.",
    runAt: "document-idle",
  },
  {
    id: "redux-devtools",
    entry: "src/entries/redux-devtools.user.ts",
    fileName: "redux-devtools.user.js",
    scriptName: "Redux DevTools Recorder (Page Context Bridge)",
    description: "Expose read-only Redux DevTools recorder bridge.",
    runAt: "document-start",
  },
];

function makeUserscriptBanner(entry: UserscriptBuildEntry, version: string): string {
  return `// ==UserScript==
// @name         ${entry.scriptName}
// @namespace    page-context.bridge
// @version      ${version}
// @description  ${entry.description}
// @match        *://*/*
// @grant        none
// @run-at       ${entry.runAt}
// ==/UserScript==`;
}

function formatVersionDate(filePath: string): string {
  const modifiedAt = statSync(filePath).mtime;
  const year = String(modifiedAt.getFullYear());
  const month = String(modifiedAt.getMonth() + 1).padStart(2, "0");
  const day = String(modifiedAt.getDate()).padStart(2, "0");
  return `${year}.${month}.${day}`;
}

function buildEntryHash(code: string): string {
  const sourceHash = createHash("sha256")
    .update(code)
    .digest("hex");
  return sourceHash.slice(0, 8);
}

function buildUserscriptVersion(entry: UserscriptBuildEntry, code: string): string {
  const entryPath = resolve(__dirname, entry.entry);
  const versionDate = formatVersionDate(entryPath);
  const entryHash = buildEntryHash(code);

  // Use the source entry file's modification date for human readability,
  // then append a generated-entry hash so repeated builds stay stable.
  return `${versionDate}.${entryHash}`;
}

export default defineConfig(({ mode }) => {
  const target = ENTRIES.find((entry) => entry.id === mode) ?? ENTRIES[0]!;
  const shouldEmptyOutDir = target.id === ENTRIES[0]!.id;

  return {
    plugins: [
      {
        name: "userscript-banner-version",
        apply: "build",
        generateBundle(_outputOptions, bundle) {
          const chunk = bundle[target.fileName];
          if (!chunk || chunk.type !== "chunk") {
            return;
          }

          const version = buildUserscriptVersion(target, chunk.code);
          chunk.code = `${makeUserscriptBanner(target, version)}\n${chunk.code}`;
        },
      },
    ],
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
        },
      },
    },
  };
});
