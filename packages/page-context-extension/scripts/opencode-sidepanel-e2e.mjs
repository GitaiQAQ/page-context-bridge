#!/usr/bin/env node
/**
 * OpenCode sidepanel multi-session real Chromium validation.
 *
 * Goals:
 * 1. Validate Connect / New Session / restore / stale cleanup with the real Chromium artifact.
 * 2. Emit key state as machine-readable JSON instead of relying on screenshots only.
 * 3. Cover only the most fragile browser paths; Story 2 LLM calls keep manual evidence.
 *
 * Unix style:
 * - This script only drives the browser and reads state.
 * - Session management, bridge logic, and the opencode API stay in their own systems.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(extensionRoot, '..', '..');
const distDir = path.join(extensionRoot, 'dist-chromium');
const chromeBinary =
  process.env.CHROMIUM_BINARY?.trim() ||
  path.join(
    os.homedir(),
    'Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  );

const opencodeBaseUrl = process.env.OPENCODE_BASE_URL?.trim() || 'http://127.0.0.1:4096';
const bridgeBaseUrl = process.env.BRIDGE_BASE_URL?.trim() || 'http://127.0.0.1:22334';
const screenshotPrefix =
  process.env.OPENCODE_SIDEPANEL_E2E_SCREENSHOT_PREFIX?.trim() || '/tmp/opencode-sidepanel-e2e';

function log(message, payload) {
  if (payload === undefined) {
    console.log(`[opencode-sidepanel-e2e] ${message}`);
    return;
  }
  console.log(`[opencode-sidepanel-e2e] ${message}: ${JSON.stringify(payload)}`);
}

function fail(message, payload) {
  if (payload === undefined) {
    throw new Error(message);
  }
  throw new Error(`${message}: ${JSON.stringify(payload)}`);
}

function assert(condition, message, payload) {
  if (!condition) {
    fail(message, payload);
  }
}

async function waitForServiceWorker(context, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const worker = context
      .serviceWorkers()
      .find((entry) => entry.url().startsWith('chrome-extension://'));
    if (worker) {
      return worker;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fail('extension service worker did not appear in time');
}

async function rpcRequest(page, method, params) {
  return await page.evaluate(
    async ({ method, params }) => {
      const response = await chrome.runtime.sendMessage({
        jsonrpc: '2.0',
        id: `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        method,
        params,
      });
      if (!response || response.jsonrpc !== '2.0') {
        throw new Error('Expected JSON-RPC response envelope');
      }
      if ('error' in response) {
        throw new Error(response.error?.message || 'Unknown runtime RPC error');
      }
      return response.result;
    },
    { method, params },
  );
}

async function storageGet(page, key) {
  return await page.evaluate(async (storageKey) => await chrome.storage.local.get(storageKey), key);
}

async function storageClear(worker) {
  await worker.evaluate(async () => {
    await chrome.storage.local.clear();
  });
}

async function listOpenCodeSessions() {
  const response = await fetch(`${opencodeBaseUrl}/session`);
  if (!response.ok) {
    fail('failed to list opencode sessions', {
      status: response.status,
      statusText: response.statusText,
    });
  }
  return await response.json();
}

async function deleteOpenCodeSession(sessionId) {
  const response = await fetch(`${opencodeBaseUrl}/session/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  });
  if (!response.ok && response.status !== 404) {
    fail('failed to delete opencode session', {
      sessionId,
      status: response.status,
      statusText: response.statusText,
    });
  }
}

async function getActiveTabBinding(worker) {
  return await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id || !tab.windowId) {
      throw new Error('No active tab binding found');
    }
    return {
      tabId: tab.id,
      windowId: tab.windowId,
      url: tab.url ?? '',
    };
  });
}

async function openSidepanel(context, extensionId, binding) {
  const page = await context.newPage();
  await page.goto(
    `chrome-extension://${extensionId}/sidepanel.html?boundTabId=${binding.tabId}&windowId=${binding.windowId}`,
    { waitUntil: 'domcontentloaded' },
  );
  return page;
}

async function openOpenCodeTab(page) {
  await page.locator('[title="OpenCode"]').click();
  await page.locator('text=OpenCode Base URL').waitFor({ state: 'visible' });
}

async function setInputValue(page, placeholder, value) {
  const input = page.locator(`input[placeholder="${placeholder}"]`);
  await input.fill('');
  await input.fill(value);
}

async function readSessionButtons(page) {
  return await page.locator('button[title^="ws://"]').evaluateAll((nodes) =>
    nodes.map((node) => ({
      sessionId: node.textContent?.trim() || '',
      wsUrl: node.getAttribute('title') || '',
      selected: node.className.includes('btn-primary'),
    })),
  );
}

async function waitForSessionCount(page, expectedCount) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const count = await page.locator('button[title^="ws://"]').count();
    if (count >= expectedCount) {
      return;
    }
    await delay(250);
  }
  fail(`Timed out waiting for at least ${expectedCount} session buttons`);
}

async function getIframeState(page) {
  return await page.locator('iframe[data-session-id]').evaluateAll((nodes) =>
    nodes.map((node) => ({
      sessionId: node.getAttribute('data-session-id') || '',
      src: node.getAttribute('src') || '',
      visible:
        node.parentElement?.classList.contains('active') ||
        window.getComputedStyle(node.parentElement ?? node).display !== 'none',
    })),
  );
}

function attachMcpPostTracker(page) {
  const requests = [];
  page.on('request', (request) => {
    if (request.url() === `${opencodeBaseUrl}/mcp` && request.method() === 'POST') {
      requests.push({
        method: request.method(),
        postData: request.postData() || '',
      });
    }
  });
  return requests;
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function takeScreenshot(page, suffix) {
  const target = `${screenshotPrefix}-${suffix}.png`;
  await page.screenshot({ path: target, fullPage: true });
  return target;
}

async function main() {
  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-sidepanel-e2e-'));
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    executablePath: chromeBinary,
    args: [
      `--disable-extensions-except=${distDir}`,
      `--load-extension=${distDir}`,
      '--window-size=1440,960',
    ],
  });

  const createdSessions = [];

  try {
    const worker = await waitForServiceWorker(context);
    const extensionId = new URL(worker.url()).host;
    log('extension loaded', { extensionId, chromeBinary });

    await storageClear(worker);

    const examplePage = await context.newPage();
    await examplePage.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await examplePage.bringToFront();

    const binding = await getActiveTabBinding(worker);
    log('active tab binding', binding);

    const story1Page = await openSidepanel(context, extensionId, binding);
    const story1McpPosts = attachMcpPostTracker(story1Page);
    await openOpenCodeTab(story1Page);
    await setInputValue(story1Page, 'http://localhost:4096', opencodeBaseUrl);
    await setInputValue(story1Page, 'http://localhost:22334', bridgeBaseUrl);

    await story1Page.getByRole('button', { name: 'Connect', exact: true }).click();
    await story1Page
      .locator('iframe[data-session-id]')
      .waitFor({ state: 'visible', timeout: 30_000 });

    const story1Frames = await getIframeState(story1Page);
    const story1ActiveFrame = story1Frames.find((frame) => frame.visible) ?? story1Frames[0];
    assert(story1ActiveFrame?.sessionId, 'Story 1 did not produce an active iframe', story1Frames);
    const sessionAlpha = story1ActiveFrame.sessionId;
    createdSessions.push(sessionAlpha);

    const story1Status = await rpcRequest(story1Page, 'extension.status.get', {
      sessionId: sessionAlpha,
    });
    assert(story1Status.connected === true, 'Story 1 scoped ws is not connected', story1Status);
    assert(
      story1Status.scopedSessions?.[0]?.wsUrl === `ws://127.0.0.1:22335/?tenantId=${sessionAlpha}`,
      'Story 1 ws url mismatch',
      story1Status,
    );
    assert(story1McpPosts.length >= 1, 'Story 1 did not POST /mcp during connect', story1McpPosts);
    assert(
      story1ActiveFrame.src.includes(`/session/${sessionAlpha}`),
      'Story 1 iframe src mismatch',
      story1ActiveFrame,
    );
    const story1Screenshot = await takeScreenshot(story1Page, 'story1-connect');

    await story1Page.getByRole('button', { name: 'New Session', exact: true }).click();
    await waitForSessionCount(story1Page, 2);
    const story3Buttons = await readSessionButtons(story1Page);
    assert(
      story3Buttons.length >= 2,
      'Story 3 did not keep two session buttons alive',
      story3Buttons,
    );

    const scopedAfterNew = await rpcRequest(story1Page, 'extension.status.get', {});
    const twoScopedSessions = scopedAfterNew.scopedSessions ?? [];
    assert(
      twoScopedSessions.length >= 2,
      'Story 3 did not keep two scoped ws sessions',
      scopedAfterNew,
    );

    const bridgeSessionIdsBefore = Object.fromEntries(
      twoScopedSessions.map((entry) => [entry.tenantId, entry.bridgeSessionId]),
    );
    const sessionBeta =
      story3Buttons.map((entry) => entry.sessionId).find((entry) => entry !== sessionAlpha) || '';
    assert(sessionBeta, 'Story 3 failed to create a second distinct session', story3Buttons);
    createdSessions.push(sessionBeta);

    await story1Page.getByRole('button', { name: sessionAlpha, exact: true }).click();
    await story1Page.getByRole('button', { name: sessionBeta, exact: true }).click();

    const scopedAfterSwitch = await rpcRequest(story1Page, 'extension.status.get', {});
    const bridgeSessionIdsAfter = Object.fromEntries(
      (scopedAfterSwitch.scopedSessions ?? []).map((entry) => [
        entry.tenantId,
        entry.bridgeSessionId,
      ]),
    );
    assert(
      bridgeSessionIdsAfter[sessionAlpha] === bridgeSessionIdsBefore[sessionAlpha] &&
        bridgeSessionIdsAfter[sessionBeta] === bridgeSessionIdsBefore[sessionBeta],
      'Story 3 switched sessions but bridgeSessionId changed unexpectedly',
      {
        before: bridgeSessionIdsBefore,
        after: bridgeSessionIdsAfter,
      },
    );
    const story3Screenshot = await takeScreenshot(story1Page, 'story3-two-sessions');

    const lastSessionId = sessionBeta;
    await story1Page.close();

    const story4Page = await openSidepanel(context, extensionId, binding);
    const story4McpPosts = attachMcpPostTracker(story4Page);
    await openOpenCodeTab(story4Page);
    await story4Page
      .locator(`iframe[data-session-id="${lastSessionId}"]`)
      .waitFor({ state: 'visible', timeout: 30_000 });
    await delay(2_000);

    const story4Storage = await storageGet(story4Page, 'opencode.config.v1');
    const story4Status = await rpcRequest(story4Page, 'extension.status.get', {
      sessionId: lastSessionId,
    });
    assert(
      story4McpPosts.length === 0,
      'Story 4 restore unexpectedly re-registered MCP',
      story4McpPosts,
    );
    assert(
      story4Storage['opencode.config.v1']?.lastSessionId === lastSessionId,
      'Story 4 lastSessionId was not restored',
      story4Storage,
    );
    assert(story4Status.connected === true, 'Story 4 restored ws is not connected', story4Status);
    const story4Screenshot = await takeScreenshot(story4Page, 'story4-restore');

    await deleteOpenCodeSession(lastSessionId);
    await delay(1_000);
    await story4Page.close();

    const story5Page = await openSidepanel(context, extensionId, binding);
    await openOpenCodeTab(story5Page);
    await story5Page
      .locator('text=Cleared saved state')
      .waitFor({ state: 'visible', timeout: 30_000 });
    await delay(1_000);

    const story5Storage = await storageGet(story5Page, 'opencode.config.v1');
    const story5Runtime = await rpcRequest(story5Page, 'extension.status.get', {});
    const story5Iframes = await getIframeState(story5Page);
    const story5SessionButtons = await readSessionButtons(story5Page);
    assert(
      !('opencode.config.v1' in story5Storage),
      'Story 5 stale restore did not clear storage',
      story5Storage,
    );
    assert(
      story5Iframes.length === 0,
      'Story 5 still renders iframe for stale session',
      story5Iframes,
    );
    assert(
      !story5SessionButtons.some((entry) => entry.sessionId === lastSessionId),
      'Story 5 still shows stale session button',
      story5SessionButtons,
    );
    assert(
      !(story5Runtime.scopedSessions ?? []).some((entry) => entry.tenantId === lastSessionId),
      'Story 5 background still retains stale scoped session',
      story5Runtime,
    );
    const story5Screenshot = await takeScreenshot(story5Page, 'story5-stale');

    const output = {
      story1: {
        sessionId: sessionAlpha,
        status: story1Status,
        iframe: story1ActiveFrame,
        mcpPostCount: story1McpPosts.length,
        screenshot: story1Screenshot,
      },
      story3: {
        sessions: [sessionAlpha, sessionBeta],
        bridgeSessionIdsBefore,
        bridgeSessionIdsAfter,
        screenshot: story3Screenshot,
      },
      story4: {
        lastSessionId,
        storage: story4Storage,
        status: story4Status,
        mcpPostCountAfterReopen: story4McpPosts.length,
        screenshot: story4Screenshot,
      },
      story5: {
        storage: story5Storage,
        runtime: story5Runtime,
        screenshot: story5Screenshot,
      },
    };

    console.log(JSON.stringify(output, null, 2));
  } finally {
    for (const sessionId of createdSessions) {
      await deleteOpenCodeSession(sessionId).catch(() => undefined);
    }
    await context.close().catch(() => undefined);
    await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

await main();
