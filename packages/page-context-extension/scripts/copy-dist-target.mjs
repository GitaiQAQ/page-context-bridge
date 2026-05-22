#!/usr/bin/env node
import { cpSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const target = process.argv[2];

if (target !== 'chromium' && target !== 'firefox') {
  console.error('[copy-dist-target] Usage: node scripts/copy-dist-target.mjs <chromium|firefox>');
  process.exit(1);
}

const sourceDir = path.join(projectRoot, 'dist');
const targetDir = path.join(projectRoot, `dist-${target}`);

if (!existsSync(path.join(sourceDir, 'manifest.json'))) {
  console.error(`[copy-dist-target] Missing ${path.join(sourceDir, 'manifest.json')}`);
  process.exit(1);
}

rmSync(targetDir, { recursive: true, force: true });
cpSync(sourceDir, targetDir, { recursive: true });
console.log(`[copy-dist-target] Copied dist -> dist-${target}`);
