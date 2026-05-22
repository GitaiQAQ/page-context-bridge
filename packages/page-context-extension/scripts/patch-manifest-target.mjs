#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const target =
  process.env.PAGE_CONTEXT_EXTENSION_BROWSER_TARGET === 'firefox' ? 'firefox' : 'chromium';
const manifestPath = resolve(__dirname, '..', 'dist', 'manifest.json');

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const permissions = Array.isArray(manifest.permissions) ? [...manifest.permissions] : [];
const background =
  manifest.background && typeof manifest.background === 'object' ? manifest.background : {};
const backgroundScripts = Array.isArray(background.scripts) ? background.scripts : [];
const backgroundScript =
  typeof background.service_worker === 'string'
    ? background.service_worker
    : typeof backgroundScripts[0] === 'string'
      ? backgroundScripts[0]
      : 'src/background.js';

if (target === 'firefox') {
  manifest.permissions = permissions.filter((p) => p !== 'sidePanel' && p !== 'debugger');
  delete manifest.side_panel;
  // Firefox uses sidebar_action instead of Chrome's side_panel
  manifest.sidebar_action = {
    default_panel: 'sidepanel.html',
    default_icon: 'icons/icon128.png',
    default_title: 'Page Context Bridge',
  };
  manifest.devtools_page = 'devtools.html';
  manifest.background = { scripts: [backgroundScript], persistent: true };
  manifest.browser_specific_settings = {
    gecko: { id: 'page-context-bridge@example.com', strict_min_version: '121.0' },
  };
  // Firefox MV3 default CSP is `default-src 'self'` which blocks WebSocket connections
  // to external hosts. Allow ws:// and wss:// via connect-src.
  manifest.content_security_policy = {
    extension_pages:
      "script-src 'self'; object-src 'self'; connect-src 'self' ws: wss: http: https:;",
  };
} else {
  manifest.permissions = permissions.includes('sidePanel')
    ? permissions
    : [...permissions, 'sidePanel'];
  manifest.permissions = manifest.permissions.includes('debugger')
    ? manifest.permissions
    : [...manifest.permissions, 'debugger'];
  manifest.side_panel = manifest.side_panel ?? { default_path: 'sidepanel.html' };
  manifest.background = {
    ...background,
    service_worker: backgroundScript,
    type: background.type ?? 'module',
  };
  delete manifest.background.scripts;
  delete manifest.devtools_page;
  delete manifest.browser_specific_settings;
  delete manifest.content_security_policy;
}

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log('Patched manifest target:', target);
