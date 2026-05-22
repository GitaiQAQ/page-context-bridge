#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

function fail(message) {
  console.error(`[target-artifacts-smoke] FAIL: ${message}`);
  process.exit(1);
}

function readManifest(target) {
  const artifactDir = path.join(projectRoot, `dist-${target}`);
  const manifestPath = path.join(artifactDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    fail(`Missing ${manifestPath}. Run pnpm run build:targets first.`);
  }
  return {
    artifactDir,
    manifestPath,
    manifest: JSON.parse(readFileSync(manifestPath, 'utf8')),
  };
}

function assertCommonFiles(target, artifactDir) {
  for (const fileName of ['manifest.json', 'sidepanel.html', 'popup.html', 'src/background.js']) {
    const filePath = path.join(artifactDir, fileName);
    if (!existsSync(filePath)) {
      fail(`${target} artifact missing ${filePath}`);
    }
  }
}

function assertChromiumArtifact() {
  const { artifactDir, manifest } = readManifest('chromium');
  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  assertCommonFiles('chromium', artifactDir);

  const errors = [];
  if (manifest.manifest_version !== 3) errors.push('manifest_version must be 3');
  if (!permissions.includes('sidePanel')) errors.push('permissions must include sidePanel');
  if (!permissions.includes('debugger')) errors.push('permissions must include debugger');
  if (!manifest.side_panel?.default_path) errors.push('side_panel.default_path is required');
  if (manifest.devtools_page != null)
    errors.push('chromium artifact must not include devtools_page');
  if (manifest.browser_specific_settings != null) {
    errors.push('chromium artifact must not include browser_specific_settings');
  }
  if (!manifest.background?.service_worker) {
    errors.push('chromium artifact must use background.service_worker');
  }
  if (manifest.background?.scripts != null) {
    errors.push('chromium artifact must not include background.scripts');
  }
  if (errors.length > 0) {
    fail(`Chromium artifact sanity failed:\n${errors.map((error) => `  - ${error}`).join('\n')}`);
  }
  console.log('[target-artifacts-smoke] PASS: dist-chromium manifest is Chromium target.');
}

function assertFirefoxArtifact() {
  const { artifactDir, manifest } = readManifest('firefox');
  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  assertCommonFiles('firefox', artifactDir);

  const errors = [];
  if (manifest.manifest_version !== 3) errors.push('manifest_version must be 3');
  if (permissions.includes('sidePanel')) errors.push('permissions must not include sidePanel');
  if (permissions.includes('debugger')) errors.push('permissions must not include debugger');
  if (manifest.side_panel != null) errors.push('firefox artifact must not include side_panel');
  if (manifest.devtools_page !== 'devtools.html') {
    errors.push('firefox artifact must include devtools_page: devtools.html');
  }
  if (!existsSync(path.join(artifactDir, 'devtools.html'))) {
    errors.push('firefox artifact must include devtools.html');
  }
  if (!manifest.browser_specific_settings?.gecko?.id) {
    errors.push('firefox artifact must include browser_specific_settings.gecko.id');
  }
  if (!Array.isArray(manifest.background?.scripts) || manifest.background.scripts.length === 0) {
    errors.push('firefox artifact must use background.scripts');
  }
  if (manifest.background?.service_worker != null) {
    errors.push('firefox artifact must not include background.service_worker');
  }
  if (!manifest.sidebar_action?.default_panel && !manifest.sidebar_action?.default_path) {
    errors.push('firefox artifact must include sidebar_action.default_panel');
  }
  if (errors.length > 0) {
    fail(`Firefox artifact sanity failed:\n${errors.map((error) => `  - ${error}`).join('\n')}`);
  }
  console.log('[target-artifacts-smoke] PASS: dist-firefox manifest is Firefox target.');
}

assertChromiumArtifact();
assertFirefoxArtifact();
console.log(
  '[target-artifacts-smoke] PASS: both browser artifacts are present and target-specific.',
);
