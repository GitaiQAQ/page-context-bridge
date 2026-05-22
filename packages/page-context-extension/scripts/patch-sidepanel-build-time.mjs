#!/usr/bin/env node
/**
 * 给 sidepanel.html 注入构建时间。
 *
 * 这里单独拆成脚本而不是继续用 package.json 里的 `node -e`：
 * 1. 目标目录可以通过环境变量切换，适合并行构建不同浏览器产物。
 * 2. 逻辑有明确输入输出，失败信息也更容易读。
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
  // Vite 插件阶段可能已经把占位符补掉了。
  // 这里保持幂等：只要产物存在且内容已稳定，就不要因为“二次补丁”失败。
  console.warn(`Side-panel build time placeholder already patched: ${htmlPath}`);
  process.exit(0);
}

writeFileSync(htmlPath, patchedHtml);
console.log(`Patched side-panel build time html: ${buildTime} (${outputDir})`);
