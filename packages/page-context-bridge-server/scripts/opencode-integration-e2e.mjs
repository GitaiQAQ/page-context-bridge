#!/usr/bin/env node

import net from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PREFIX = '[E2E]';
const BRIDGE_PORT = Number.parseInt(process.env.BRIDGE_PORT || '22334', 10);
const OPENCODE_PORT = Number.parseInt(process.env.OPENCODE_PORT || '4096', 10);
const BRIDGE_BASE_URL = `http://127.0.0.1:${BRIDGE_PORT}`;
const OPENCODE_BASE_URL = `http://127.0.0.1:${OPENCODE_PORT}`;
const DEBUG_ENDPOINTS_ENABLED = process.env.BRIDGE_DEBUG_ENDPOINTS === '1';
const IDLE_WAIT_MS = Number.parseInt(process.env.BRIDGE_IDLE_WAIT_MS || '0', 10);

function log(message, payload) {
  if (payload === undefined) {
    console.log(`${PREFIX} ${message}`);
    return;
  }
  console.log(`${PREFIX} ${message}: ${JSON.stringify(payload)}`);
}

function skip(message) {
  console.log(`${PREFIX} SKIP ${message}`);
  process.exit(0);
}

function fail(step, payload) {
  console.error(`${PREFIX} FAIL ${step}`);
  if (payload !== undefined) {
    console.error(JSON.stringify(payload, null, 2));
  }
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPortListening(port, host = '127.0.0.1', timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    const done = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function requestJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const rawText = await response.text();
  const json = rawText ? JSON.parse(rawText) : undefined;

  if (!response.ok) {
    throw {
      status: response.status,
      statusText: response.statusText,
      body: json ?? rawText,
      url,
    };
  }

  return json;
}

async function waitFor(check, timeoutMs, intervalMs, step) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;

  while (Date.now() < deadline) {
    try {
      lastValue = await check();
      if (lastValue) {
        return lastValue;
      }
    } catch (error) {
      lastValue = error;
    }
    await sleep(intervalMs);
  }

  throw new Error(`${step} timed out after ${timeoutMs}ms: ${JSON.stringify(lastValue)}`);
}

function hasPageContextTool(toolName) {
  return (
    toolName.startsWith('__page_context.') ||
    toolName.startsWith('page.') ||
    toolName.startsWith('builtin.page.') ||
    toolName.includes('.page.')
  );
}

async function main() {
  const bridgeReady = await isPortListening(BRIDGE_PORT);
  const opencodeReady = await isPortListening(OPENCODE_PORT);
  if (!bridgeReady || !opencodeReady) {
    skip(`bridge:${BRIDGE_PORT} or opencode:${OPENCODE_PORT} is not listening on 127.0.0.1`);
  }

  let currentStep = 'bootstrap';
  let sessionId = '';
  let sessionDeleted = false;
  let client = null;
  let transport = null;

  try {
    currentStep = 'create-session';
    const session = await requestJson(`${OPENCODE_BASE_URL}/session`, {
      method: 'POST',
      body: {},
    });
    sessionId = session?.id;
    if (!sessionId) {
      fail(currentStep, session);
    }
    const mcpName = `page-context-${sessionId}`;
    const bridgeMcpUrl = `${BRIDGE_BASE_URL}/${encodeURIComponent(sessionId)}/mcp`;
    log('created session', { sessionId });

    currentStep = 'register-mcp';
    // opencode `GET /mcp` only returns static config and omits runtime additions;
    // `POST /mcp` returns the full current MCP set, including dynamic entries and target status.
    const mcpStatus = await requestJson(`${OPENCODE_BASE_URL}/mcp`, {
      method: 'POST',
      body: {
        name: mcpName,
        config: {
          type: 'remote',
          url: bridgeMcpUrl,
          enabled: true,
        },
      },
    });

    currentStep = 'verify-opencode-mcp-connected';
    const mcpEntry = mcpStatus?.[mcpName];
    if (!mcpEntry || mcpEntry.status !== 'connected') {
      fail(currentStep, { mcpName, mcpEntry, mcpStatus });
    }
    log('opencode reports bridge mcp connected', mcpEntry);

    currentStep = 'connect-bridge-mcp-client';
    transport = new StreamableHTTPClientTransport(new URL(bridgeMcpUrl));
    client = new Client({ name: 'opencode-integration-e2e', version: '1.0.0' });
    await client.connect(transport);

    currentStep = 'list-tools';
    const toolsResult = await client.listTools();
    const toolNames = toolsResult.tools.map((tool) => tool.name);
    const pageContextTools = toolNames.filter(hasPageContextTool);
    if (pageContextTools.length === 0) {
      fail(currentStep, { toolNames });
    }
    log('discovered page-context tools', pageContextTools);

    if (DEBUG_ENDPOINTS_ENABLED) {
      currentStep = 'debug-tenant-visible';
      const tenants = await requestJson(`${BRIDGE_BASE_URL}/__debug/tenants`, {
        method: 'GET',
      });
      if (!tenants?.tenants?.some((tenant) => tenant.id === sessionId)) {
        fail(currentStep, tenants);
      }
      log(
        'bridge sees tenant',
        tenants.tenants.find((t) => t.id === sessionId),
      );
    }

    // Note: this E2E does not verify idle cleanup. opencode MCP has a global lifecycle;
    // deleting a session does not make opencode proactively close the streamable HTTP connection,
    // so the bridge tenant keeps serverCount > 0 and is not reclaimed.
    // Idle cleanup is covered by tenant-manager.idle.test.ts.
    if (IDLE_WAIT_MS > 0) {
      log('idle cleanup wait skipped intentionally', {
        reason: 'opencode does not close the streamable HTTP transport on session delete',
        BRIDGE_IDLE_WAIT_MS: process.env.BRIDGE_IDLE_WAIT_MS ?? '0',
      });
    }

    if (!sessionDeleted) {
      currentStep = 'delete-session';
      await requestJson(`${OPENCODE_BASE_URL}/session/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
      });
      sessionDeleted = true;
    }

    console.log(`${PREFIX} ALL OK`);
  } catch (error) {
    fail(currentStep, error);
  } finally {
    if (client) {
      await client.close().catch(() => undefined);
    }
    if (transport) {
      await transport.close().catch(() => undefined);
    }
    if (sessionId && !sessionDeleted) {
      await requestJson(`${OPENCODE_BASE_URL}/session/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
      }).catch(() => undefined);
    }
  }
}

void main();
