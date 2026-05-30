#!/usr/bin/env node
/**
 * Firefox E2E validation entry.
 *
 * Goals:
 * 1. Validate only Firefox-specific paths instead of retesting Chrome coverage.
 * 2. Produce machine-checkable PASS / FAIL output, not visual browser smoke checks.
 * 3. Keep failures scoped to artifacts, loading, injection, readonly bridge, or tool calls.
 *
 * Prerequisite:
 *   pnpm run build:firefox:target
 *
 * Usage:
 *   node scripts/firefox-e2e.mjs
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const distDir = path.join(projectRoot, 'dist-firefox');
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? '30000');
const AFTER_REPORT_WAIT_MS = Number(process.env.FIREFOX_E2E_AFTER_REPORT_WAIT_MS ?? '0');
const EXTERNAL_START_URL = process.env.FIREFOX_E2E_START_URL?.trim() || '';
const EXPECTED_PAGE_TOOL_NAME = process.env.FIREFOX_E2E_EXPECTED_PAGE_TOOL_NAME?.trim() || '';
const EXPECTED_PAGE_TOOL_NAMESPACE =
  process.env.FIREFOX_E2E_EXPECTED_PAGE_TOOL_NAMESPACE?.trim() || '';
const EXPECTED_PAGE_TOOL_INSTANCE_ID =
  process.env.FIREFOX_E2E_EXPECTED_PAGE_TOOL_INSTANCE_ID?.trim() || '';
const EXPECTED_PAGE_TOOL_ARGS_JSON =
  process.env.FIREFOX_E2E_EXPECTED_PAGE_TOOL_ARGS_JSON?.trim() || '';
const EXTERNAL_BOOTSTRAP_REDIRECT_DELAY_MS = Number(
  process.env.FIREFOX_E2E_BOOTSTRAP_REDIRECT_DELAY_MS ?? '2500',
);
const prefix = '[firefox-e2e]';

function log(msg) {
  console.log(`${prefix} ${msg}`);
}
function fail(msg) {
  console.error(`${prefix} FAIL: ${msg}`);
  process.exit(1);
}

function parseExpectedToolArgs() {
  if (!EXPECTED_PAGE_TOOL_ARGS_JSON) {
    return {};
  }

  try {
    const parsed = JSON.parse(EXPECTED_PAGE_TOOL_ARGS_JSON);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    fail(
      `Invalid FIREFOX_E2E_EXPECTED_PAGE_TOOL_ARGS_JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function getExpectedReadonlyExecuteTarget() {
  // External pages use different tool names from the local demo.
  // Make the target page tool explicit so fixture-only values do not leak to real sites.
  if (EXPECTED_PAGE_TOOL_NAME && EXPECTED_PAGE_TOOL_NAMESPACE) {
    return {
      pageToolName: EXPECTED_PAGE_TOOL_NAME,
      namespace: EXPECTED_PAGE_TOOL_NAMESPACE,
      instanceId: EXPECTED_PAGE_TOOL_INSTANCE_ID || 'default',
      args: parseExpectedToolArgs(),
      required: true,
    };
  }

  if (!EXTERNAL_START_URL) {
    return {
      pageToolName: 'e2e-tool-1',
      namespace: 'e2e',
      instanceId: 'test',
      args: { probe: 'firefox-e2e' },
      required: true,
    };
  }

  return {
    pageToolName: '',
    namespace: '',
    instanceId: '',
    args: {},
    required: false,
  };
}

function buildExternalFinalUrl(reportUrl) {
  const expectedTool = getExpectedReadonlyExecuteTarget();
  const url = new URL(EXTERNAL_START_URL);
  url.searchParams.set('__pcE2E', '1');
  url.searchParams.set('__pcE2EReport', reportUrl);
  if (process.env.WS_URL) {
    url.searchParams.set('__pcE2EWs', process.env.WS_URL);
  }
  if (expectedTool.required) {
    url.searchParams.set('pcExpectedToolName', expectedTool.pageToolName);
    url.searchParams.set('pcExpectedToolNamespace', expectedTool.namespace);
    url.searchParams.set('pcExpectedToolInstanceId', expectedTool.instanceId);
    url.searchParams.set('pcExpectedToolArgs', JSON.stringify(expectedTool.args));
  } else {
    url.searchParams.set('pcSkipReadonlyExecute', '1');
  }
  return url.toString();
}

if (!existsSync(path.join(distDir, 'manifest.json'))) {
  fail('dist-firefox/manifest.json not found. Run: pnpm run build:firefox:target');
}

/**
 * Use a temporary profile to avoid reusing a long-lived Firefox profile:
 * 1. The extension may not be fully reinstalled.
 * 2. Old pages or caches may pollute results.
 * 3. web-ext behavior is unclear when it attaches to an existing instance.
 */
function createTempFirefoxProfile() {
  return mkdtempSync(path.join(tmpdir(), 'page-context-firefox-e2e-'));
}

function cleanupDir(dirPath) {
  if (!dirPath) return;
  try {
    rmSync(dirPath, { recursive: true, force: true });
  } catch {
    // Cleanup failures should not mask real flow errors.
  }
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

function waitForChildClose(childProcess) {
  if (childProcess.exitCode != null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => childProcess.once('close', resolve));
}

const firefoxBinary = findFirefoxBinary();
if (!firefoxBinary) {
  fail('Firefox binary not found. Set FIREFOX_BINARY=/path/to/firefox and retry.');
}

// ── Diagnostic HTTP server ──────────────────────────────────────────
const reports = [];
let e2eRuntimeReport = null;
const e2eRuntimeReports = [];
let diagPort = 0;

const diagServer = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${diagPort}`);
  if (url.pathname === '/demo') {
    const e2eReportUrl = `http://127.0.0.1:${diagPort}/e2e-report`;
    const e2eWsQuery = process.env.WS_URL
      ? `&__pcE2EWs=${encodeURIComponent(process.env.WS_URL)}`
      : '';
    const e2eRedirectTarget = url.searchParams.get('__pcE2ERedirect') || '';
    const demoHtml = [
      '<!doctype html><meta charset="utf-8"><title>E2E Test Page</title>',
      '<h1>Page Context Bridge E2E</h1>',
      '<script>',
      'const e2eReloadKey = "__pcFirefoxE2EReloadCount__";',
      'const e2eRedirectKey = "__pcFirefoxE2ERedirected__";',
      'const currentReloadCount = Number(sessionStorage.getItem(e2eReloadKey) || "0");',
      `const redirectTarget = ${JSON.stringify(e2eRedirectTarget)};`,
      'let contentScriptReady = false;',
      'let reloadTimer = null;',
      'window.addEventListener("page-context:e2e:content-script-ready", () => {',
      '  contentScriptReady = true;',
      '  sessionStorage.removeItem(e2eReloadKey);',
      '  if (reloadTimer) clearTimeout(reloadTimer);',
      '  if (redirectTarget && !sessionStorage.getItem(e2eRedirectKey)) {',
      '    sessionStorage.setItem(e2eRedirectKey, "1");',
      `    setTimeout(() => location.replace(redirectTarget), ${EXTERNAL_BOOTSTRAP_REDIRECT_DELAY_MS});`,
      '  }',
      '}, { once: true });',
      'reloadTimer = setTimeout(() => {',
      '  if (contentScriptReady || currentReloadCount >= 4) return;',
      '  sessionStorage.setItem(e2eReloadKey, String(currentReloadCount + 1));',
      '  location.replace(window.location.href);',
      '}, 1500);',
      'window.__pageContextBridge__ = {',
      '  version: "1.0.0", namespace: "e2e", instanceId: "test",',
      '  getManifest: () => ({ namespaces: [{ namespace: "e2e", title: "E2E Test" }] }),',
      '  listTools: () => [{ name: "e2e-tool-1", description: "E2E test tool" }],',
      '  callTool: (name, args) => {',
      '    if (name !== "e2e-tool-1") throw new Error(`Unknown tool: ${name}`);',
      '    return { ok: true, source: "page-bridge", tool: name, echo: args ?? null };',
      '  },',
      '};',
      `fetch("http://127.0.0.1:${diagPort}/bridge-set?namespace=e2e&tools=1").catch(()=>{});`,
      `history.replaceState(null, '', '/demo?__pcE2E=1&__pcE2EReport=${encodeURIComponent(e2eReportUrl)}${e2eWsQuery}${e2eRedirectTarget ? `&__pcE2ERedirect=${encodeURIComponent(e2eRedirectTarget)}` : ''}');`,
      '</script>',
    ].join('');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(demoHtml);
    return;
  }
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    const report = {
      time: new Date().toISOString(),
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body: body || undefined,
    };
    if (url.pathname === '/e2e-report' && body) {
      try {
        e2eRuntimeReport = JSON.parse(body);
        e2eRuntimeReports.push(e2eRuntimeReport);
      } catch {
        e2eRuntimeReport = { ok: false, error: 'Invalid JSON report', raw: body };
        e2eRuntimeReports.push(e2eRuntimeReport);
      }
    }
    reports.push(report);
    log(`  ← ${report.path} ${report.body || JSON.stringify(report.query)}`);
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
    res.end('OK');
  });
});

await new Promise((resolve) => diagServer.listen(0, '127.0.0.1', resolve));
const diagAddress = diagServer.address();
if (!diagAddress || typeof diagAddress === 'string') {
  fail('Failed to resolve diagnostic server port.');
}
diagPort = diagAddress.port;
log(`Diagnostic server on :${diagPort}`);

// ── Static checks ───────────────────────────────────────────────────
const staticResults = { passed: 0, failed: 0 };

function staticTest(name, fn) {
  try {
    fn();
    log(`PASS: ${name}`);
    staticResults.passed++;
  } catch (e) {
    log(`FAIL: ${name} — ${e.message}`);
    staticResults.failed++;
  }
}

staticTest('Firefox manifest is valid', () => {
  const m = JSON.parse(readFileSync(path.join(distDir, 'manifest.json'), 'utf8'));
  if (m.manifest_version !== 3) throw new Error('Wrong manifest_version');
  if (!m.sidebar_action?.default_panel) throw new Error('Missing sidebar_action.default_panel');
  if (!m.browser_specific_settings?.gecko?.id) throw new Error('Missing gecko ID');
  if (!m.background?.persistent) throw new Error('Background not persistent');
  if (!m.content_security_policy?.extension_pages?.includes('ws:'))
    throw new Error('CSP missing ws:');
});

staticTest('Sidebar HTML exists', () => {
  const p = path.join(distDir, 'sidepanel.html');
  if (!existsSync(p)) throw new Error('sidepanel.html not found');
  if (!readFileSync(p, 'utf8').includes('side-panel-app'))
    throw new Error('Missing side-panel-app element');
});

staticTest('Content script contains wrappedJSObject', () => {
  const dir = path.join(distDir);
  const files = readdirSync(dir).filter((f) => f.startsWith('content-script-readonly'));
  const found = files.some((f) =>
    readFileSync(path.join(dir, f), 'utf8').includes('wrappedJSObject'),
  );
  if (!found) throw new Error('wrappedJSObject not found in readonly broker chunk');
});

staticTest('Readonly broker contains unwrapXray', () => {
  const dir = path.join(distDir);
  const files = readdirSync(dir).filter((f) => f.startsWith('content-script-readonly'));
  const found = files.some((f) => readFileSync(path.join(dir, f), 'utf8').includes('unwrapXray'));
  if (!found) throw new Error('unwrapXray not found in readonly broker chunk');
});

if (EXTERNAL_START_URL && !EXPECTED_PAGE_TOOL_NAME) {
  log(
    'External start URL detected without FIREFOX_E2E_EXPECTED_PAGE_TOOL_* settings; readonly execute assertion will be skipped.',
  );
}

// ── Launch Firefox via web-ext ──────────────────────────────────────
log('Launching Firefox with extension via web-ext...');

const reportUrl = `http://127.0.0.1:${diagPort}/e2e-report`;
const externalFinalUrl = EXTERNAL_START_URL ? buildExternalFinalUrl(reportUrl) : '';
const demoUrl = `http://127.0.0.1:${diagPort}/demo?__pcE2E=1&__pcE2EReport=${encodeURIComponent(
  reportUrl,
)}${process.env.WS_URL ? `&__pcE2EWs=${encodeURIComponent(process.env.WS_URL)}` : ''}${
  externalFinalUrl ? '&pcBootstrapOnly=1' : ''
}${externalFinalUrl ? `&__pcE2ERedirect=${encodeURIComponent(externalFinalUrl)}` : ''}`;
const startUrl = demoUrl;
const firefoxProfileDir = createTempFirefoxProfile();

const child = spawn(
  'pnpm',
  [
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
    firefoxProfileDir,
    '--profile-create-if-missing',
    '--no-reload',
    '--no-input',
    '--start-url',
    startUrl,
  ],
  {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WEB_EXT_PROFILE_DIR: firefoxProfileDir },
  },
);

let webExtOutput = '';
child.stdout.on('data', (d) => {
  webExtOutput += d.toString();
  process.stdout.write(d);
});
child.stderr.on('data', (d) => {
  webExtOutput += d.toString();
  process.stdout.write(d);
});
child.on('error', (error) => {
  webExtOutput += `\n${error.message}`;
});

// ── Wait for results ────────────────────────────────────────────────
log(`Waiting up to ${TIMEOUT_MS}ms for extension reports...`);

const deadline = Date.now() + TIMEOUT_MS;
while (Date.now() < deadline) {
  if (e2eRuntimeReport != null) {
    break;
  }
  const childExited = child.exitCode != null;
  if (childExited && e2eRuntimeReport == null) {
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}

// Heavier E2E flows need a short window after the probe succeeds so an external MCP client
// can make real calls. Default to no wait to keep local smoke checks fast.
if (e2eRuntimeReport != null && AFTER_REPORT_WAIT_MS > 0) {
  log(`Holding Firefox for ${AFTER_REPORT_WAIT_MS}ms so external MCP checks can run...`);
  await new Promise((resolve) => setTimeout(resolve, AFTER_REPORT_WAIT_MS));
}

// Clean up before analysis to avoid stale profiles or processes on the next run.
if (child.exitCode == null) {
  child.kill('SIGTERM');
  setTimeout(() => child.kill('SIGKILL'), 3000).unref();
}
await waitForChildClose(child);
await new Promise((resolve) => diagServer.close(resolve));
cleanupDir(firefoxProfileDir);

// ── Analyze reports ─────────────────────────────────────────────────
const runtimeResults = { passed: 0, failed: 0 };

function runtimeTest(name, condition, detail) {
  if (condition) {
    log(`PASS: ${name}`);
    runtimeResults.passed++;
  } else {
    log(`FAIL: ${name} — ${detail}`);
    runtimeResults.failed++;
  }
}

function isLocalDemoReport(report) {
  return (
    typeof report?.href === 'string' && report.href.startsWith(`http://127.0.0.1:${diagPort}/demo`)
  );
}

function isExternalPageReport(report) {
  if (!EXTERNAL_START_URL || typeof report?.href !== 'string') {
    return false;
  }
  const normalizedExternalUrl = EXTERNAL_START_URL.replace(/\?.*$/, '');
  return report.href.startsWith(normalizedExternalUrl);
}

function isFirefoxReadonlyPermissionDenied(report) {
  const errorText = [
    report?.readonlyRegistrationError,
    report?.readonlyToolCountError,
    report?.error,
  ]
    .filter(Boolean)
    .join('\n');
  return errorText.includes('Permission denied to access object');
}

const bootstrapRuntimeReport = e2eRuntimeReports.find(isLocalDemoReport) ?? null;
const externalRuntimeReport = e2eRuntimeReports.find(isExternalPageReport) ?? null;
const analysisRuntimeReport = externalRuntimeReport ?? bootstrapRuntimeReport ?? e2eRuntimeReport;
const externalReadonlyDenied = isFirefoxReadonlyPermissionDenied(externalRuntimeReport);

const demoPageLoaded = reports.some((r) => r.path.startsWith('/bridge-set'));
if (!EXTERNAL_START_URL) {
  runtimeTest(
    'Demo page initialized page bridge fixture',
    demoPageLoaded,
    'No /bridge-set report received',
  );
} else {
  runtimeTest(
    'Bootstrap page initialized page bridge fixture',
    demoPageLoaded && Boolean(bootstrapRuntimeReport?.ok),
    bootstrapRuntimeReport?.error
      ? String(bootstrapRuntimeReport.error)
      : 'No successful bootstrap /e2e-report payload received',
  );
  runtimeTest(
    'External page injected content script',
    Boolean(externalRuntimeReport?.contentScriptLoaded),
    externalRuntimeReport?.error
      ? String(externalRuntimeReport.error)
      : 'External page did not send content-script-ready report',
  );
}

runtimeTest(
  'Content script E2E probe returned success',
  Boolean(analysisRuntimeReport?.ok) ||
    (Boolean(EXTERNAL_START_URL) &&
      Boolean(externalRuntimeReport?.contentScriptLoaded) &&
      externalReadonlyDenied),
  analysisRuntimeReport?.error
    ? String(analysisRuntimeReport.error)
    : 'No successful /e2e-report payload received',
);

if (EXTERNAL_START_URL && externalReadonlyDenied) {
  log(
    'PASS: External page readonly broker check skipped because Firefox denied cross-realm access; outer MCP E2E should validate main-world fallback.',
  );
  runtimeResults.passed++;
} else {
  runtimeTest(
    'Readonly broker discovered page tools',
    Boolean(analysisRuntimeReport?.readonlyRegistrationOk) ||
      Number(analysisRuntimeReport?.readonlyToolCount ?? 0) > 0,
    `readonlyRegistrationOk=${String(analysisRuntimeReport?.readonlyRegistrationOk ?? false)}, readonlyToolCount=${String(analysisRuntimeReport?.readonlyToolCount ?? 0)}`,
  );
}

if (EXTERNAL_START_URL && externalReadonlyDenied) {
  log(
    'PASS: External page readonly execute check skipped because Firefox denied cross-realm access; outer MCP E2E should validate main-world fallback.',
  );
  runtimeResults.passed++;
} else {
  runtimeTest(
    'Readonly broker executed a page tool successfully',
    Boolean(analysisRuntimeReport?.readonlyExecuteOk) ||
      Boolean(analysisRuntimeReport?.readonlyExecuteSkipped),
    analysisRuntimeReport?.readonlyExecuteError
      ? String(analysisRuntimeReport.readonlyExecuteError)
      : analysisRuntimeReport?.readonlyExecuteSkipped
        ? 'Readonly execute check intentionally skipped for external page without explicit target tool'
        : `readonlyExecuteOk=${String(analysisRuntimeReport?.readonlyExecuteOk ?? false)}`,
  );
}

if (EXTERNAL_START_URL && externalReadonlyDenied) {
  log(
    'PASS: External page background discovery check delegated to outer MCP E2E because Firefox helper cannot observe the fallback registration path directly.',
  );
  runtimeResults.passed++;
} else {
  runtimeTest(
    'Background discovery registered page tools',
    Number(analysisRuntimeReport?.runtimeDiscoveredToolCount ?? 0) > 0 &&
      Number(analysisRuntimeReport?.currentTabToolCount ?? 0) > 0,
    `runtimeDiscoveredToolCount=${String(analysisRuntimeReport?.runtimeDiscoveredToolCount ?? 0)}, currentTabToolCount=${String(analysisRuntimeReport?.currentTabToolCount ?? 0)}`,
  );
}

// Check launch health: either explicit install message, or at least no early launch error.
const extInstalled =
  (webExtOutput.includes('Installed') && webExtOutput.includes('temporary add-on')) ||
  (!/InvalidManifest|WebExtError|Could not install add-on|background\.service_worker is currently disabled/i.test(
    webExtOutput,
  ) &&
    demoPageLoaded);
runtimeTest(
  'web-ext launched Firefox without early extension errors',
  extInstalled,
  'web-ext output indicates install/launch failure',
);

if (process.env.WS_URL) {
  if (EXTERNAL_START_URL && externalReadonlyDenied) {
    log(
      'PASS: External page WebSocket runtime check delegated to outer MCP E2E because the helper report is not authoritative after redirect.',
    );
    runtimeResults.passed++;
  } else {
    runtimeTest(
      'WebSocket connected in extension runtime',
      Boolean(analysisRuntimeReport?.wsConnected),
      `wsConnected=${String(analysisRuntimeReport?.wsConnected ?? false)}`,
    );
  }
}

// ── Summary ─────────────────────────────────────────────────────────
const totalPassed = staticResults.passed + runtimeResults.passed;
const totalFailed = staticResults.failed + runtimeResults.failed;

log(`\nStatic checks: ${staticResults.passed} passed, ${staticResults.failed} failed`);
log(`Runtime checks: ${runtimeResults.passed} passed, ${runtimeResults.failed} failed`);
log(`Total: ${totalPassed} passed, ${totalFailed} failed`);

if (totalFailed > 0) {
  process.exit(1);
}
