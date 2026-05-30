#!/usr/bin/env node
/**
 * Inject build time into sidepanel.html.
 *
 * This is a standalone script instead of a package.json `node -e` snippet:
 * 1. The target directory can be changed by env var for parallel browser builds.
 * 2. Inputs, outputs, and failure messages are easier to read.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputDir = process.env.PAGE_CONTEXT_EXTENSION_OUT_DIR?.trim() || 'dist';
const buildTime = new Date().toISOString();
const htmlPath = resolve(__dirname, '..', outputDir, 'sidepanel.html');

const html = readFileSync(htmlPath, 'utf8');
const patchedHtml = html
  .replaceAll('%VITE_PAGE_CONTEXT_EXTENSION_BUILD_TIME%', buildTime)
  .replaceAll('__PAGE_CONTEXT_EXTENSION_BUILD_TIME__', buildTime);

if (patchedHtml === html) {
  // A Vite plugin may have already patched the placeholder.
  // Keep this idempotent: do not fail a second patch when the artifact is stable.
  console.warn(`Side-panel build time placeholder already patched: ${htmlPath}`);
  process.exit(0);
}

writeFileSync(htmlPath, patchedHtml);
console.log(`Patched side-panel build time html: ${buildTime} (${outputDir})`);
