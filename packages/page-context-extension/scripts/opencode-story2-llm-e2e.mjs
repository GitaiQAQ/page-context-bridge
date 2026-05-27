#!/usr/bin/env node
/**
 * Story 2: 在 sidepanel iframe 里让 OpenCode 真实调用 builtin.page.get_page_info。
 *
 * 约束：
 * 1. 必须走真实 Chromium 扩展 + 真实 opencode iframe。
 * 2. 只验证“模型能在当前 active tab 上拿到页面信息”这一件事。
 * 3. 默认使用上次人工验证过的 deepseek:deepseek-v4-pro，避免把时间浪费在 provider 噪音上。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(__dirname, '..');
const distDir = path.join(extensionRoot, 'dist-chromium');
const chromeBinary =
  process.env.CHROMIUM_BINARY?.trim() ||
  path.join(
    os.homedir(),
    'Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  );

const opencodeBaseUrl = process.env.OPENCODE_BASE_URL?.trim() || 'http://127.0.0.1:4096';
const bridgeBaseUrl = process.env.BRIDGE_BASE_URL?.trim() || 'http://127.0.0.1:22334';
const modelKey = process.env.OPENCODE_STORY2_MODEL_KEY?.trim() || 'deepseek:deepseek-v4-pro';
const promptText =
  process.env.OPENCODE_STORY2_PROMPT?.trim() ||
  'Use builtin.page.get_page_info exactly once on the current active tab. Return only minified JSON like {"title":"...","url":"..."}.';
const expectedTitle = process.env.OPENCODE_STORY2_EXPECTED_TITLE?.trim() || 'Example Domain';
const expectedUrl = process.env.OPENCODE_STORY2_EXPECTED_URL?.trim() || 'https://example.com/';
const screenshotPath =
  process.env.OPENCODE_STORY2_SCREENSHOT?.trim() || '/tmp/opencode-story2-llm.png';

function fail(message, payload) {
  if (payload === undefined) {
    throw new Error(message);
  }
  throw new Error(`${message}: ${JSON.stringify(payload)}`);
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
    await delay(250);
  }
  fail('extension service worker did not appear');
}

async function main() {
  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-story2-e2e-'));
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    executablePath: chromeBinary,
    args: [
      `--disable-extensions-except=${distDir}`,
      `--load-extension=${distDir}`,
      '--window-size=1440,960',
    ],
  });

  try {
    const worker = await waitForServiceWorker(context);
    await worker.evaluate(async () => {
      await chrome.storage.local.clear();
    });

    const extensionId = new URL(worker.url()).host;
    const targetPage = await context.newPage();
    await targetPage.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await targetPage.bringToFront();

    const binding = await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id || !tab.windowId) {
        throw new Error('No active tab binding found');
      }
      return {
        tabId: tab.id,
        windowId: tab.windowId,
      };
    });

    const panel = await context.newPage();
    await panel.goto(
      `chrome-extension://${extensionId}/sidepanel.html?boundTabId=${binding.tabId}&windowId=${binding.windowId}`,
      { waitUntil: 'domcontentloaded' },
    );

    await panel.locator('[title="OpenCode"]').click();
    await panel.locator('text=OpenCode Base URL').waitFor({ state: 'visible' });
    await panel.locator('input[placeholder="http://localhost:4096"]').fill(opencodeBaseUrl);
    await panel.locator('input[placeholder="http://localhost:22334"]').fill(bridgeBaseUrl);
    await panel.getByRole('button', { name: 'Connect', exact: true }).click();

    const iframe = panel.locator('iframe[data-session-id]').first();
    await iframe.waitFor({ state: 'visible', timeout: 30_000 });
    const sessionId = (await iframe.getAttribute('data-session-id')) || '';
    if (!sessionId) {
      fail('iframe does not expose session id');
    }

    const frame = await iframe.elementHandle().then((handle) => handle.contentFrame());
    await frame.waitForLoadState('domcontentloaded');

    // 等 iframe 壳稳定后再切模型，避免点在未挂载完的占位节点上。
    await frame
      .getByRole('button', { name: /Claude|DeepSeek|GPT|Gemini|Kimi|GLM/i })
      .first()
      .waitFor({
        state: 'visible',
        timeout: 30_000,
      });
    await frame
      .getByRole('button', { name: /Claude|DeepSeek|GPT|Gemini|Kimi|GLM/i })
      .first()
      .click();
    await frame.locator(`button[data-key="${modelKey}"]`).click({ timeout: 30_000 });

    const textbox = frame.getByRole('textbox', {
      name: 'Ask anything, / for commands, @ for context...',
    });
    await textbox.click();
    await panel.keyboard.type(promptText, { delay: 10 });
    await frame.getByRole('button', { name: '发送' }).click();

    const deadline = Date.now() + 180_000;
    let finalBodyText = '';
    while (Date.now() < deadline) {
      finalBodyText = await frame.locator('body').innerText();
      if (finalBodyText.includes(expectedTitle) && finalBodyText.includes(expectedUrl)) {
        break;
      }
      await delay(1_000);
    }

    if (!finalBodyText.includes(expectedTitle) || !finalBodyText.includes(expectedUrl)) {
      fail('Story 2 did not surface expected page info in time', {
        sessionId,
        expectedTitle,
        expectedUrl,
        bodyText: finalBodyText.slice(-4000),
      });
    }

    await panel.screenshot({ path: screenshotPath, fullPage: true });

    const match = finalBodyText.match(/\{"title":"[^"]+","url":"[^"]+"\}/);
    const result = {
      sessionId,
      modelKey,
      screenshot: screenshotPath,
      matchedJson: match?.[0] ?? null,
      tailText: finalBodyText.slice(-1500),
    };

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await context.close().catch(() => undefined);
    await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

await main();
