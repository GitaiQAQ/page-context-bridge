#!/usr/bin/env node
/**
 * Chromium + bridge server + MCP client 真正端到端验证。
 *
 * 目标：
 * 1. 启动 bridge server（SSE + WebSocket）。
 * 2. 启动真实 Chromium 扩展验证脚本，并让扩展连上 bridge server。
 * 3. 使用真实 MCP SSE client 枚举并调用页面工具。
 * 4. 用明确的 PASS / FAIL 证明“页面数据已被 MCP 消费”。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bridgeServerRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(bridgeServerRoot, '..', '..');
const extensionRoot = path.resolve(workspaceRoot, 'packages/page-context-extension');
const chromiumE2EScript = path.join(extensionRoot, 'scripts/chromium-e2e.mjs');
const prefix = '[chromium-mcp-e2e]';
const EXTERNAL_START_URL = process.env.CHROMIUM_E2E_START_URL?.trim() || '';
const EXPECTED_TOOL_SUFFIX = process.env.CHROMIUM_MCP_EXPECTED_TOOL_SUFFIX?.trim() || '.e2e-tool-1';
const TOOL_ARGS_JSON =
  process.env.CHROMIUM_MCP_TOOL_ARGS_JSON?.trim() || '{"probe":"chromium-mcp-e2e"}';
const EXPECTED_RESULT_TEXT = process.env.CHROMIUM_MCP_EXPECTED_RESULT_TEXT?.trim() || '';
const EXPECTED_RESULT_JSON = process.env.CHROMIUM_MCP_EXPECTED_RESULT_JSON?.trim() || '';
const REMOTE_EXT_WS_URL = process.env.PAGE_CONTEXT_EXT_WS_URL?.trim() || '';
const REMOTE_MCP_SSE_URL = process.env.PAGE_CONTEXT_MCP_SSE_URL?.trim() || '';

function log(message) {
  console.log(`${prefix} ${message}`);
}

function fail(message) {
  console.error(`${prefix} FAIL: ${message}`);
  process.exit(1);
}

function parseJsonEnv(name, rawValue, fallbackValue) {
  if (!rawValue) {
    return fallbackValue;
  }

  try {
    return JSON.parse(rawValue);
  } catch (error) {
    fail(`${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function assertJsonContains(actual, expected, trace = 'result') {
  // 这里同样使用“子集断言”。
  // 重点是验证页面数据确实进了 MCP，不把断言绑死在无关字段上。
  if (typeof expected === 'string') {
    if (typeof actual !== 'string' || !actual.includes(expected)) {
      throw new Error(`${trace} expected to include "${expected}", got ${JSON.stringify(actual)}`);
    }
    return;
  }

  if (typeof expected === 'number' || typeof expected === 'boolean' || expected == null) {
    if (actual !== expected) {
      throw new Error(
        `${trace} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      );
    }
    return;
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      throw new Error(`${trace} expected array, got ${JSON.stringify(actual)}`);
    }
    if (actual.length < expected.length) {
      throw new Error(`${trace} expected at least ${expected.length} items, got ${actual.length}`);
    }
    for (let index = 0; index < expected.length; index += 1) {
      assertJsonContains(actual[index], expected[index], `${trace}[${index}]`);
    }
    return;
  }

  if (!isPlainObject(expected) || !isPlainObject(actual)) {
    throw new Error(`${trace} expected object-compatible value, got ${JSON.stringify(actual)}`);
  }

  for (const [key, expectedValue] of Object.entries(expected)) {
    if (!(key in actual)) {
      throw new Error(`${trace}.${key} is missing`);
    }
    assertJsonContains(actual[key], expectedValue, `${trace}.${key}`);
  }
}

function createLineForwarder(prefixLabel, sink, collector) {
  return (chunk) => {
    const text = chunk.toString();
    collector.push(text);
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      sink(`${prefixLabel} ${line}`);
    }
  };
}

function extractTextContent(payload) {
  return payload.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
}

function parseTextResponse(payload) {
  const text = extractTextContent(payload);
  return {
    text,
    json: JSON.parse(text),
  };
}

async function callJsonTool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const { text, json } = parseTextResponse(result);
  return { text, json };
}

async function callPageToolUntilReady(client, name, args, timeoutMs = 20_000) {
  // 远端 tenant 可能残留旧注册。
  // 这里和 Firefox 版本保持一致：只有拿到“可用结果”才算真正 ready。
  const deadline = Date.now() + timeoutMs;
  let lastText = '';

  while (Date.now() < deadline) {
    const result = await client.callTool({ name, arguments: args });
    const text = extractTextContent(result);
    lastText = text;

    if (!result.isError && !text.startsWith('Error:')) {
      return { result, text };
    }

    if (text.includes('disabled by preferences')) {
      return { result, text };
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    `MCP page tool did not become ready in time: ${lastText || '(empty error payload)'}`,
  );
}

function isToolNotFoundError(message) {
  return (
    /Tool .* not found/.test(message) ||
    (message.includes(' tool ') && message.includes('not found'))
  );
}

function waitForChildExit(child, name) {
  if (!child) {
    return Promise.resolve({ code: null, signal: null });
  }
  if (child.exitCode != null || child.signalCode != null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    child.once('error', (error) => {
      reject(new Error(`${name} failed to start: ${error.message}`));
    });
    child.once('exit', (code, signal) => {
      resolve({ code, signal });
    });
  });
}

async function terminateChild(child, name) {
  if (!child || child.exitCode != null) {
    return;
  }
  child.kill('SIGTERM');
  const result = await Promise.race([
    waitForChildExit(child, name),
    new Promise((resolve) => setTimeout(() => resolve(null), 5_000)),
  ]);
  if (result == null && child.exitCode == null) {
    child.kill('SIGKILL');
    await waitForChildExit(child, name).catch(() => undefined);
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Unable to resolve ephemeral port'));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.once('error', reject);
  });
}

async function waitForTcpPort(port, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connected = await new Promise((resolve) => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      const done = (value) => {
        socket.destroy();
        resolve(value);
      };
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
      socket.setTimeout(800, () => done(false));
    });
    if (connected) {
      log(`Port ready: ${label} -> ${port}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not listen on port ${port} within ${timeoutMs}ms`);
}

async function waitForPageTool(client, suffix, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastToolNames = [];
  while (Date.now() < deadline) {
    const toolsResult = await client.listTools().catch(() => null);
    const toolNames = toolsResult?.tools?.map((tool) => tool.name) ?? [];
    lastToolNames = toolNames;
    const match = toolNames.find((name) => name.endsWith(suffix));
    if (match) {
      return { toolName: match, toolNames };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Timed out waiting for MCP page tool "*${suffix}". Last tools: ${lastToolNames.join(', ') || '(none)'}`,
  );
}

function parseRegisteredPageToolName(registeredToolName) {
  const match = /^tab\.(\d+)\.(.+)$/.exec(registeredToolName);
  if (!match) {
    throw new Error(`Unexpected registered page tool name: ${registeredToolName}`);
  }
  const actualToolName = match[2];
  const segments = actualToolName.split('.');
  return {
    tabId: Number(match[1]),
    actualToolName,
    namespace: segments[0] ?? '',
    instanceId: segments[1] ?? 'default',
    leafToolName: segments.at(-1) ?? actualToolName,
  };
}

function inferReadonlyTargetFromToolSuffix(toolSuffix) {
  const normalized = toolSuffix.startsWith('.') ? toolSuffix.slice(1) : toolSuffix;
  const segments = normalized.split('.').filter(Boolean);
  if (segments.length < 2) {
    return null;
  }

  if (segments.length === 2) {
    return {
      namespace: segments[0],
      instanceId: 'default',
      pageToolName: segments[1],
    };
  }

  return {
    namespace: segments[0],
    instanceId: segments.slice(1, -1).join('.'),
    pageToolName: segments.at(-1),
  };
}

async function collectExtensionDebugSnapshot(client, startUrl) {
  const snapshot = {
    runtimeStatus: null,
    toolTree: null,
    tabs: [],
    manifestDebugByTab: [],
  };

  try {
    snapshot.runtimeStatus = (await callJsonTool(client, 'extension.get_runtime_status')).json;
  } catch (error) {
    snapshot.runtimeStatus = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    const rawToolTree = (await callJsonTool(client, 'extension.get_tool_tree')).json;
    snapshot.toolTree = {
      totalTools: rawToolTree?.totalTools ?? null,
      enabledTools: rawToolTree?.enabledTools ?? null,
      tabs: Array.isArray(rawToolTree?.tabs)
        ? rawToolTree.tabs.map((tab) => ({
            tabId: tab?.tabId ?? null,
            url: tab?.url ?? null,
            totalTools: tab?.totalTools ?? null,
            enabledTools: tab?.enabledTools ?? null,
          }))
        : [],
    };
  } catch (error) {
    snapshot.toolTree = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const tabs = Array.isArray(snapshot.toolTree?.tabs) ? snapshot.toolTree.tabs : [];
  try {
    const listedTabs = await callJsonTool(client, 'list_tabs');
    snapshot.tabs = Array.isArray(listedTabs.json) ? listedTabs.json : [];
  } catch (error) {
    snapshot.tabs = [
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
    ];
  }

  const candidateTabs = tabs.length > 0 ? tabs : snapshot.tabs;
  const targetTabs = candidateTabs.filter((tab) => {
    if (!tab || typeof tab !== 'object') {
      return false;
    }
    if (typeof startUrl !== 'string' || !startUrl) {
      return typeof (tab.tabId ?? tab.id) === 'number';
    }
    return typeof tab.url === 'string' && tab.url.includes(startUrl.replace(/\?.*$/, ''));
  });

  for (const tab of targetTabs) {
    const tabId = typeof tab?.tabId === 'number' ? tab.tabId : tab?.id;
    if (typeof tabId !== 'number') {
      continue;
    }
    try {
      const manifestDebug = await callJsonTool(client, 'extension.get_context_manifest_debug', {
        tabId,
      });
      snapshot.manifestDebugByTab.push({
        tabId,
        url: tab.url,
        manifestDebug: {
          manifestPresent: Boolean(manifestDebug.json?.manifest),
          rawManifestPresent: Boolean(manifestDebug.json?.rawManifest),
          namespaceCount: Array.isArray(manifestDebug.json?.manifest?.namespaces)
            ? manifestDebug.json.manifest.namespaces.length
            : 0,
          rawNamespaceCount: Array.isArray(manifestDebug.json?.rawManifest?.namespaces)
            ? manifestDebug.json.rawManifest.namespaces.length
            : 0,
          debug: manifestDebug.json?.debug ?? null,
        },
      });
    } catch (error) {
      snapshot.manifestDebugByTab.push({
        tabId,
        url: tab.url,
        manifestDebug: {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  return snapshot;
}

async function main() {
  if (!existsSync(chromiumE2EScript)) {
    fail(`Missing Chromium E2E script: ${chromiumE2EScript}`);
  }

  const toolArgs = parseJsonEnv('CHROMIUM_MCP_TOOL_ARGS_JSON', TOOL_ARGS_JSON, {
    probe: 'chromium-mcp-e2e',
  });
  const expectedResultJson = parseJsonEnv(
    'CHROMIUM_MCP_EXPECTED_RESULT_JSON',
    EXPECTED_RESULT_JSON,
    null,
  );
  const expectedResultMarkers = EXPECTED_RESULT_TEXT.split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const inferredReadonlyTarget = inferReadonlyTargetFromToolSuffix(EXPECTED_TOOL_SUFFIX);
  const useRemoteBridge = Boolean(REMOTE_EXT_WS_URL || REMOTE_MCP_SSE_URL);
  if (useRemoteBridge && (!REMOTE_EXT_WS_URL || !REMOTE_MCP_SSE_URL)) {
    fail('PAGE_CONTEXT_EXT_WS_URL and PAGE_CONTEXT_MCP_SSE_URL must be provided together.');
  }

  const tenantId = `chromium-e2e-${Date.now().toString(36)}`;
  const mcpHttpPort = useRemoteBridge ? 0 : await getFreePort();
  const extWsPort = useRemoteBridge ? 0 : await getFreePort();
  const wsUrl = REMOTE_EXT_WS_URL || `ws://127.0.0.1:${extWsPort}/${tenantId}`;
  const sseUrl = REMOTE_MCP_SSE_URL || `http://127.0.0.1:${mcpHttpPort}/${tenantId}/sse`;
  const serverOutput = [];
  const chromiumOutput = [];
  let bridgeServerChild = null;
  let chromiumChild = null;
  let transport = null;
  let client = null;

  try {
    log('Building Chromium extension artifact before full MCP E2E...');
    const buildChild = spawn('pnpm', ['run', 'build:chromium:target'], {
      cwd: extensionRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    buildChild.stdout.on('data', createLineForwarder('[build]', log, []));
    buildChild.stderr.on('data', createLineForwarder('[build]', log, []));
    const buildResult = await waitForChildExit(buildChild, 'extension build');
    if (buildResult.code !== 0) {
      throw new Error(`Extension build failed with code ${String(buildResult.code)}`);
    }

    if (useRemoteBridge) {
      log(`Using remote bridge endpoints: WS ${wsUrl} | SSE ${sseUrl}`);
    } else {
      log(`Starting bridge server: SSE ${mcpHttpPort}, WS ${extWsPort}, tenant ${tenantId}`);
      bridgeServerChild = spawn('pnpm', ['exec', 'tsx', 'src/index.ts'], {
        cwd: bridgeServerRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          MCP_HTTP_PORT: String(mcpHttpPort),
          EXT_WS_PORT: String(extWsPort),
          TENANT_ID: tenantId,
        },
      });
      bridgeServerChild.stdout.on('data', createLineForwarder('[bridge]', log, serverOutput));
      bridgeServerChild.stderr.on('data', createLineForwarder('[bridge]', log, serverOutput));

      await waitForTcpPort(mcpHttpPort, 'bridge SSE');
      await waitForTcpPort(extWsPort, 'bridge WebSocket');
    }

    log(`Starting Chromium extension E2E against ${wsUrl}`);
    chromiumChild = spawn('node', ['scripts/chromium-e2e.mjs'], {
      cwd: extensionRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        WS_URL: wsUrl,
        CHROMIUM_E2E_START_URL: EXTERNAL_START_URL || process.env.CHROMIUM_E2E_START_URL,
        CHROMIUM_E2E_EXPECTED_PAGE_TOOL_NAME:
          process.env.CHROMIUM_E2E_EXPECTED_PAGE_TOOL_NAME ??
          inferredReadonlyTarget?.pageToolName ??
          '',
        CHROMIUM_E2E_EXPECTED_PAGE_TOOL_NAMESPACE:
          process.env.CHROMIUM_E2E_EXPECTED_PAGE_TOOL_NAMESPACE ??
          inferredReadonlyTarget?.namespace ??
          '',
        CHROMIUM_E2E_EXPECTED_PAGE_TOOL_INSTANCE_ID:
          process.env.CHROMIUM_E2E_EXPECTED_PAGE_TOOL_INSTANCE_ID ??
          inferredReadonlyTarget?.instanceId ??
          '',
        CHROMIUM_E2E_EXPECTED_PAGE_TOOL_ARGS_JSON:
          process.env.CHROMIUM_E2E_EXPECTED_PAGE_TOOL_ARGS_JSON ?? JSON.stringify(toolArgs),
        E2E_TIMEOUT_MS: process.env.E2E_TIMEOUT_MS ?? '45000',
        CHROMIUM_E2E_AFTER_REPORT_WAIT_MS: process.env.CHROMIUM_E2E_AFTER_REPORT_WAIT_MS ?? '20000',
      },
    });
    chromiumChild.stdout.on('data', createLineForwarder('[chromium]', log, chromiumOutput));
    chromiumChild.stderr.on('data', createLineForwarder('[chromium]', log, chromiumOutput));

    transport = new SSEClientTransport(new URL(sseUrl));
    client = new Client({ name: 'chromium-mcp-e2e-client', version: '1.0.0' });
    await client.connect(transport);
    log(`Connected MCP client to ${sseUrl}`);

    let toolDiscovery;
    try {
      toolDiscovery = await waitForPageTool(client, EXPECTED_TOOL_SUFFIX);
    } catch (error) {
      const debugSnapshot = await collectExtensionDebugSnapshot(client, EXTERNAL_START_URL);
      throw new Error(
        `${
          error instanceof Error ? error.message : String(error)
        }\nExtension debug snapshot:\n${JSON.stringify(debugSnapshot, null, 2)}`,
      );
    }

    const { toolName, toolNames } = toolDiscovery;
    log(`Discovered MCP page tool: ${toolName}`);
    log(`Current MCP tools: ${toolNames.join(', ')}`);
    let activeToolName = toolName;
    let routedPageTool = parseRegisteredPageToolName(activeToolName);
    let callResult;
    let callText;

    while (true) {
      try {
        ({ result: callResult, text: callText } = await callPageToolUntilReady(
          client,
          activeToolName,
          toolArgs,
          8_000,
        ));
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!isToolNotFoundError(message)) {
          throw error;
        }
        const rediscovered = await waitForPageTool(client, EXPECTED_TOOL_SUFFIX, 10_000);
        if (rediscovered.toolName !== activeToolName) {
          log(`Refreshed stale MCP page tool: ${activeToolName} -> ${rediscovered.toolName}`);
        }
        activeToolName = rediscovered.toolName;
        routedPageTool = parseRegisteredPageToolName(activeToolName);
      }
    }

    if (
      (callResult.isError || callText.startsWith('Error:')) &&
      callText.includes('disabled by preferences')
    ) {
      const enableResult = await client.callTool({
        name: 'extension.set_tools_enabled',
        arguments: {
          updates: [
            {
              root: 'page',
              tabId: routedPageTool.tabId,
              namespace: routedPageTool.namespace,
              enabled: true,
            },
            {
              root: 'page',
              tabId: routedPageTool.tabId,
              namespace: routedPageTool.namespace,
              instanceId: routedPageTool.instanceId,
              enabled: true,
            },
            {
              root: 'page',
              tabId: routedPageTool.tabId,
              namespace: routedPageTool.namespace,
              instanceId: routedPageTool.instanceId,
              toolName: routedPageTool.actualToolName,
              enabled: true,
            },
            {
              root: 'page',
              tabId: routedPageTool.tabId,
              namespace: routedPageTool.namespace,
              instanceId: routedPageTool.instanceId,
              toolName: routedPageTool.leafToolName,
              enabled: true,
            },
          ],
        },
      });
      const { text: enableText } = parseTextResponse(enableResult);
      log(`Enabled page tool through extension.set_tools_enabled: ${enableText}`);
      while (true) {
        try {
          ({ result: callResult, text: callText } = await callPageToolUntilReady(
            client,
            activeToolName,
            toolArgs,
            8_000,
          ));
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!isToolNotFoundError(message)) {
            throw error;
          }
          const rediscovered = await waitForPageTool(client, EXPECTED_TOOL_SUFFIX, 10_000);
          if (rediscovered.toolName !== activeToolName) {
            log(
              `Refreshed stale MCP page tool after enabling: ${activeToolName} -> ${rediscovered.toolName}`,
            );
          }
          activeToolName = rediscovered.toolName;
          routedPageTool = parseRegisteredPageToolName(activeToolName);
        }
      }
    }

    if (callResult.isError) {
      throw new Error(`MCP call returned error payload: ${callText}`);
    }

    if (expectedResultJson != null) {
      const parsedResult = parseTextResponse(callResult).json;
      assertJsonContains(parsedResult, expectedResultJson);
    } else if (expectedResultMarkers.length > 0) {
      for (const marker of expectedResultMarkers) {
        if (!callText.includes(marker)) {
          throw new Error(
            `MCP call result does not contain expected marker "${marker}": ${callText}`,
          );
        }
      }
    } else {
      if (!callText.includes('page-bridge')) {
        throw new Error(`MCP call result does not contain page-bridge marker: ${callText}`);
      }
      if (!callText.includes('e2e-tool-1')) {
        throw new Error(`MCP call result does not contain tool name: ${callText}`);
      }
      if (!callText.includes('chromium-mcp-e2e')) {
        throw new Error(`MCP call result does not contain echoed probe args: ${callText}`);
      }
    }
    log('PASS: real MCP client successfully consumed Chromium page tool data.');

    const chromiumResult = await waitForChildExit(chromiumChild, 'chromium-e2e');
    if (chromiumResult.code !== 0) {
      log(
        `Chromium helper exited with code ${String(chromiumResult.code)}${chromiumResult.signal ? ` signal ${chromiumResult.signal}` : ''}; keeping MCP call success as source of truth.`,
      );
      return;
    }
    log('PASS: Chromium extension E2E finished successfully with MCP chain enabled.');
  } finally {
    if (client && typeof client.close === 'function') {
      await client.close().catch(() => undefined);
    }
    if (transport && typeof transport.close === 'function') {
      await transport.close().catch(() => undefined);
    }
    await terminateChild(chromiumChild, 'chromium-e2e');
    await terminateChild(bridgeServerChild, 'bridge-server');
  }
}

await main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
