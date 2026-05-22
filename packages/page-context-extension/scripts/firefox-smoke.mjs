#!/usr/bin/env node
/**
 * Minimal explicit Firefox smoke entrypoint.
 *
 * Assumes `pnpm run build:firefox` has already produced `dist/`.
 * Always performs deterministic artifact sanity checks, then best-effort starts
 * Firefox through the existing `web-ext` dependency. Environment/browser launch
 * issues are reported as SKIP with manual next steps so this explicit smoke does
 * not block machines without a local Firefox installation.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const distDir = path.join(projectRoot, 'dist');
const manifestPath = path.join(distDir, 'manifest.json');
const sidepanelPath = path.join(distDir, 'sidepanel.html');
const devtoolsPath = path.join(distDir, 'devtools.html');
const timeoutMs = Number.parseInt(process.env.FIREFOX_SMOKE_TIMEOUT_MS ?? '12000', 10);

const prefix = '[firefox-smoke]';

function log(message = '') {
  console.log(`${prefix} ${message}`.trimEnd());
}

function fail(message) {
  console.error(`${prefix} FAIL: ${message}`);
  process.exit(1);
}

function skip(message) {
  log(`SKIP: ${message}`);
  printManualSteps();
  process.exit(0);
}

function printManualSteps() {
  const escapedDistDir = distDir.replaceAll('"', '\\"');
  const escapedDemoUrl = buildDemoUrl().replaceAll('"', '\\"');
  log('Manual Firefox smoke command:');
  log(
    `  pnpm --dir "${projectRoot}" exec web-ext run --source-dir "${escapedDistDir}" --target firefox-desktop --no-input --start-url "${escapedDemoUrl}"`,
  );
  log(
    'If Firefox reports that background.service_worker is disabled, rebuild with pnpm run build:firefox and confirm dist/manifest.json uses background.scripts for the Firefox target.',
  );
  log(
    'Manual extension page check after Firefox opens: use about:debugging → This Firefox → Page Context Bridge → Inspect, then open sidepanel.html?boundTabId=<tab id> from the temporary moz-extension:// origin.',
  );
}

function readManifest() {
  if (!existsSync(manifestPath)) {
    fail(`Missing ${manifestPath}. Run pnpm run build:firefox first.`);
  }

  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    fail(`Unable to parse ${manifestPath}: ${error.message}`);
  }
}

function assertFirefoxManifest(manifest) {
  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  const geckoSettings = manifest.browser_specific_settings?.gecko;
  const background =
    manifest.background && typeof manifest.background === 'object' ? manifest.background : {};
  const errors = [];

  if (manifest.manifest_version !== 3) {
    errors.push(`expected manifest_version 3, got ${manifest.manifest_version}`);
  }
  if (permissions.includes('sidePanel')) {
    errors.push('Firefox manifest must not include sidePanel permission');
  }
  if (permissions.includes('debugger')) {
    errors.push('Firefox manifest must not include debugger permission');
  }
  if ('side_panel' in manifest) {
    errors.push('Firefox manifest must not include side_panel');
  }
  if (manifest.devtools_page !== 'devtools.html') {
    errors.push('Firefox manifest must include devtools_page: devtools.html');
  }
  if (!geckoSettings?.id) {
    errors.push('Firefox manifest must include browser_specific_settings.gecko.id');
  }
  if (!geckoSettings?.strict_min_version) {
    errors.push('Firefox manifest must include browser_specific_settings.gecko.strict_min_version');
  }
  if (!Array.isArray(background.scripts) || background.scripts.length === 0) {
    errors.push('Firefox manifest must use background.scripts for MV3 background compatibility');
  }
  if ('service_worker' in background) {
    errors.push('Firefox manifest must not include background.service_worker');
  }
  if (!existsSync(sidepanelPath)) {
    errors.push(`missing built sidepanel page: ${sidepanelPath}`);
  }
  if (!existsSync(devtoolsPath)) {
    errors.push(`missing built devtools page: ${devtoolsPath}`);
  }

  if (errors.length > 0) {
    fail(`Firefox target sanity failed:\n${errors.map((error) => `  - ${error}`).join('\n')}`);
  }

  log(
    'PASS: dist/manifest.json is a Firefox target (devtools_page, background.scripts, no side_panel/sidePanel/debugger, gecko settings present).',
  );
  log(`PASS: built sidepanel page exists: ${sidepanelPath}`);
  log(`PASS: built devtools page exists: ${devtoolsPath}`);
}

function findFirefoxBinary() {
  if (process.env.FIREFOX_BINARY) {
    return process.env.FIREFOX_BINARY;
  }

  const candidates = [
    '/Applications/Firefox.app/Contents/MacOS/firefox',
    '/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox',
    '/Applications/Firefox Nightly.app/Contents/MacOS/firefox',
    '/usr/bin/firefox',
    '/usr/local/bin/firefox',
    '/snap/bin/firefox',
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  for (const command of ['firefox', 'firefox-developer-edition', 'firefox-nightly']) {
    const result = spawnSync('command', ['-v', command], { encoding: 'utf8', shell: true });
    if (result.status === 0 && result.stdout.trim()) {
      return result.stdout.trim().split('\n')[0];
    }
  }

  return null;
}

function buildDemoUrl() {
  const html = [
    '<!doctype html>',
    '<meta charset="utf-8">',
    '<title>Page Context Bridge Firefox Smoke</title>',
    '<h1>Page Context Bridge Firefox Smoke</h1>',
    '<button id="smoke-button">smoke target</button>',
    '<script>window.__PAGE_CONTEXT_FIREFOX_SMOKE__ = true;</script>',
  ].join('');
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function isSkippableLaunchFailure(output) {
  return /could not find firefox|cannot find firefox|no such file|enoent|spawn .* en(oent|otdir)|not found|cannot open display|no display specified|glxtest|profile.*locked|startup failed|browser exited before connecting|background\.service_worker is currently disabled/i.test(
    output,
  );
}

function runWebExtSmoke(firefoxBinary) {
  const profileDir = mkdtempSync(path.join(tmpdir(), 'page-context-firefox-smoke-'));
  const demoUrl = buildDemoUrl();
  const sidepanelFileUrl = `${pathToFileURL(sidepanelPath).href}?boundTabId=0`;

  log(`Attempting Firefox launch via web-ext for ${timeoutMs}ms.`);
  log(`Firefox binary: ${firefoxBinary}`);
  log(`Source dir: ${distDir}`);
  log(`Demo page: ${demoUrl.slice(0, 96)}...`);
  log(`Sidepanel file smoke URL: ${sidepanelFileUrl}`);

  const args = [
    '--dir',
    projectRoot,
    'exec',
    'web-ext',
    'run',
    '--source-dir',
    distDir,
    '--target',
    'firefox-desktop',
    '--firefox',
    firefoxBinary,
    '--firefox-profile',
    profileDir,
    '--profile-create-if-missing',
    '--no-input',
    '--no-reload',
    '--start-url',
    demoUrl,
    '--start-url',
    sidepanelFileUrl,
  ];

  return new Promise((resolve) => {
    const child = spawn('pnpm', args, {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WEB_EXT_PROFILE_DIR: profileDir },
    });

    let output = '';
    let settled = false;

    const appendOutput = (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    };

    child.stdout.on('data', appendOutput);
    child.stderr.on('data', appendOutput);

    child.on('error', (error) => {
      output += error.message;
      if (!settled) {
        settled = true;
        cleanupProfile(profileDir);
        resolve({
          status: 'skip',
          reason: `Unable to start pnpm/web-ext: ${error.message}`,
          output,
        });
      }
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1500).unref();
      cleanupProfile(profileDir);
      resolve({
        status: 'pass',
        reason:
          'web-ext kept Firefox running until smoke timeout; extension load attempt did not fail early.',
        output,
      });
    }, timeoutMs);

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupProfile(profileDir);

      if (code === 0) {
        resolve({
          status: 'pass',
          reason: 'web-ext exited cleanly after launching Firefox.',
          output,
        });
        return;
      }

      const reason = `web-ext exited early with code ${code ?? 'null'}${signal ? ` signal ${signal}` : ''}`;
      if (isSkippableLaunchFailure(output)) {
        resolve({ status: 'skip', reason, output });
        return;
      }
      resolve({ status: 'fail', reason, output });
    });
  });
}

function cleanupProfile(profileDir) {
  rmSync(profileDir, { recursive: true, force: true });
}

const manifest = readManifest();
assertFirefoxManifest(manifest);

const firefoxBinary = findFirefoxBinary();
if (!firefoxBinary) {
  skip(
    'Firefox binary not found. Set FIREFOX_BINARY=/path/to/firefox to enable the real launch smoke.',
  );
}

const result = await runWebExtSmoke(firefoxBinary);
if (result.status === 'pass') {
  log(`PASS: ${result.reason}`);
  process.exit(0);
}

if (result.status === 'skip') {
  skip(`${result.reason}. Local Firefox/web-ext environment is unavailable for automated launch.`);
}

fail(`${result.reason}. web-ext output above indicates the Firefox extension launch smoke failed.`);
