/**
 * HTTP servers: SSE MCP server.
 * Multi-tenant: routes /{tenantId}/sse + /{tenantId}/message (legacy SSE)
 * and /{tenantId}/mcp (modern Streamable HTTP) to the correct tenant's registry.
 */

import { createServer, type Server as HttpServer } from 'http';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { log } from './mcp-registry.js';
import type { TenantManager } from './tenant-manager.js';
import { TenantManager as TM } from './tenant-manager.js';

const MCP_BOOTSTRAP_TOOL = '__page_context.bootstrap.tool';
const MCP_BOOTSTRAP_RESOURCE = '__page_context.bootstrap.resource';
const MCP_BOOTSTRAP_RESOURCE_URI = 'context://bootstrap/resource';
const MCP_BOOTSTRAP_PROMPT = '__page_context.bootstrap.prompt';
const DEBUG_ENDPOINTS_ENABLED = process.env.BRIDGE_DEBUG_ENDPOINTS === '1';

export function startSseServer(mcpHttpPort: number, manager: TenantManager): Promise<boolean> {
  return startSseServerWithHandle(mcpHttpPort, manager).then((started) => started.ok);
}

export interface StartedSseServer {
  ok: boolean;
  port: number;
  server: HttpServer;
  close(): Promise<void>;
}

export function startSseServerWithHandle(
  mcpHttpPort: number,
  manager: TenantManager,
): Promise<StartedSseServer> {
  return new Promise((resolve) => {
    const httpServer = createSseHttpServer(manager);
    let settled = false;

    httpServer.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        log(`ERROR: MCP HTTP port ${mcpHttpPort} is already in use.`);
      } else {
        log(
          'ERROR: MCP HTTP server failed:',
          error instanceof Error ? error.message : String(error),
        );
      }
      if (!settled) {
        settled = true;
        resolve({
          ok: false,
          port: mcpHttpPort,
          server: httpServer,
          close: () => closeHttpServer(httpServer),
        });
      }
    });

    httpServer.listen(mcpHttpPort, '0.0.0.0', () => {
      const address = httpServer.address();
      const actualPort = typeof address === 'object' && address ? address.port : mcpHttpPort;
      log(`MCP SSE server listening on http://0.0.0.0:${actualPort}`);
      if (!settled) {
        settled = true;
        resolve({
          ok: true,
          port: actualPort,
          server: httpServer,
          close: () => closeHttpServer(httpServer),
        });
      }
    });
  });
}

export function primeDynamicCapabilitiesForConnectedServer(mcpServer: McpServer): void {
  // The MCP SDK lazily initializes capabilities on the first registerTool/registerResource/registerPrompt call.
  // If that happens after transport connection, the SDK throws and leaves partial registration state internally,
  // which later turns into dirty-state errors such as "already registered".
  // Prime all three capabilities before connect so later dynamic changes only emit list_changed notifications.
  const bootstrapTool = mcpServer.registerTool(
    MCP_BOOTSTRAP_TOOL,
    {
      description: 'Bootstrap tool used to eagerly enable dynamic tool capability.',
      inputSchema: {},
    },
    async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
  );
  bootstrapTool.remove();

  const bootstrapResource = mcpServer.registerResource(
    MCP_BOOTSTRAP_RESOURCE,
    MCP_BOOTSTRAP_RESOURCE_URI,
    {
      title: 'Bootstrap Resource',
      description: 'Bootstrap resource used to eagerly enable dynamic resource capability.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: '{}',
        },
      ],
    }),
  );
  bootstrapResource.remove();

  const bootstrapPrompt = mcpServer.registerPrompt(
    MCP_BOOTSTRAP_PROMPT,
    {
      title: 'Bootstrap Prompt',
      description: 'Bootstrap prompt used to eagerly enable dynamic prompt capability.',
      argsSchema: {},
    },
    async () => ({
      description: 'Bootstrap prompt',
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: 'bootstrap',
          },
        },
      ],
    }),
  );
  bootstrapPrompt.remove();
}

function createSseHttpServer(manager: TenantManager): HttpServer {
  // Composite key: "tenantId::sessionId"
  const transports = new Map<
    string,
    { transport: SSEServerTransport; server: McpServer; tenantId: string }
  >();

  // Streamable HTTP transports per (tenantId, mcp-session-id).
  // SDK requires a fresh transport per stateless request, OR stateful mode where
  // we keep the transport alive and route by Mcp-Session-Id header.
  // We use stateful mode — each tenant can have multiple concurrent MCP clients;
  // each gets its own mcp-session-id namespaced inside the tenant.
  const streamablePerTenant = new Map<
    string, // tenantId
    Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }> // mcpSessionId -> entry
  >();

  // After manager reclaims a tenant, close any remaining transports here.
  // The manager owns lifecycle decisions only and should not know HTTP-layer connection details.
  manager.onRemove((tenantId) => {
    const streamableSessions = streamablePerTenant.get(tenantId);
    if (streamableSessions) {
      for (const { transport } of streamableSessions.values()) {
        void transport.close().catch(() => {});
      }
      streamablePerTenant.delete(tenantId);
    }

    for (const [key, entry] of transports.entries()) {
      if (entry.tenantId !== tenantId) {
        continue;
      }
      void entry.transport.close().catch(() => {});
      transports.delete(key);
    }
  });

  async function handleStreamableRequest(
    tenantId: string,
    req: import('http').IncomingMessage,
    res: import('http').ServerResponse,
  ): Promise<void> {
    const tenant = manager.getOrCreate(tenantId);
    const sessionsForTenant = streamablePerTenant.get(tenantId) ?? new Map();
    streamablePerTenant.set(tenantId, sessionsForTenant);

    const mcpSessionId =
      (req.headers['mcp-session-id'] as string | undefined) ??
      (req.headers['Mcp-Session-Id'] as string | undefined);

    let entry = mcpSessionId ? sessionsForTenant.get(mcpSessionId) : undefined;

    if (!entry) {
      // Either initialization request (no session id yet) or unknown session id.
      // Create a new transport+server pair; SDK will assign session id on initialize.
      const mcpServer = new McpServer({ name: 'page-context-bridge', version: '0.2.0' });
      primeDynamicCapabilitiesForConnectedServer(mcpServer);
      tenant.registry.addServer(mcpServer);

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (sid: string) => {
          sessionsForTenant.set(sid, { transport, server: mcpServer });
          log(`[${tenantId}] MCP Streamable HTTP session initialized: ${sid}`);
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) sessionsForTenant.delete(sid);
        if (sessionsForTenant.size === 0) streamablePerTenant.delete(tenantId);
        tenant.registry.removeServer(mcpServer);
        manager.touch(tenantId);
      };

      await mcpServer.connect(transport);
      entry = { transport, server: mcpServer };
    }

    await entry.transport.handleRequest(req, res);
    manager.touch(tenantId);
  }

  return createServer(async (req, res) => {
    const rawUrl = req.url ?? '/';
    const urlPath = rawUrl.split('?')[0];

    if (DEBUG_ENDPOINTS_ENABLED && req.method === 'GET' && urlPath === '/__debug/tenants') {
      const tenants = manager.list().map((tenant) => ({
        id: tenant.id,
        createdAt: tenant.createdAt,
        lastActivityAt: tenant.lastActivityAt,
        hasExtension: tenant.extension !== null,
        serverCount: tenant.registry.getServerCount(),
      }));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ tenants }));
      return;
    }

    // POST /message?sessionId=xxx — SSE client uses relative path from endpoint event
    if (req.method === 'POST' && (urlPath === '/message' || urlPath === '/message')) {
      const session = new URL(rawUrl, 'http://localhost').searchParams.get('sessionId');
      if (!session) {
        res.writeHead(400).end('Missing sessionId');
        return;
      }

      // Find target session directly from registered transports to avoid TS tracking "declare before assign" branches.
      const entry = Array.from(transports.entries()).find(([key]) =>
        key.endsWith(`::${session}`),
      )?.[1];

      if (!entry) {
        res.writeHead(400).end('No active SSE session for this sessionId');
        return;
      }

      try {
        await entry.transport.handlePostMessage(req, res);
      } catch (error) {
        log(
          `[${entry.tenantId}] SSE POST error:`,
          error instanceof Error ? error.message : String(error),
        );
        if (!res.headersSent) {
          res.writeHead(500).end('Message handling failed');
        }
      }
      return;
    }

    const tenantId = TM.extractTenantId(urlPath);

    // Strip tenant prefix to get the actual endpoint
    const endpoint = urlPath.replace(new RegExp(`^/${escapeRegExp(tenantId)}/?`), '') || '/';

    if ((req.method === 'GET' && endpoint === '/sse') || endpoint === 'sse') {
      const tenant = manager.getOrCreate(tenantId);
      const mcpServer = new McpServer({ name: 'page-context-bridge', version: '0.2.0' });
      primeDynamicCapabilitiesForConnectedServer(mcpServer);
      tenant.registry.addServer(mcpServer);

      const transport = new SSEServerTransport('/message', res);
      transports.set(`${tenantId}::${transport.sessionId}`, {
        transport,
        server: mcpServer,
        tenantId,
      });

      transport.onclose = () => {
        transports.delete(`${tenantId}::${transport.sessionId}`);
        tenant.registry.removeServer(mcpServer);
        manager.touch(tenantId);
      };

      try {
        await mcpServer.connect(transport);
        log(`[${tenantId}] MCP SSE client connected (${transport.sessionId})`);
      } catch (error) {
        log(
          `[${tenantId}] SSE connect error:`,
          error instanceof Error ? error.message : String(error),
        );
      }
      return;
    }

    // Modern Streamable HTTP transport: /{tenantId}/mcp
    if (endpoint === '/mcp' || endpoint === 'mcp') {
      if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'DELETE') {
        res.writeHead(405).end('Method Not Allowed');
        return;
      }

      try {
        await handleStreamableRequest(tenantId, req, res);
      } catch (error) {
        log(
          `[${tenantId}] Streamable HTTP error:`,
          error instanceof Error ? error.message : String(error),
        );
        if (!res.headersSent) {
          res.writeHead(500).end('Streamable HTTP handling failed');
        }
      }
      return;
    }

    // Unknown route
    res.writeHead(404).end('Not Found');
  });
}

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
