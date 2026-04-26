/**
 * HTTP servers: SSE MCP server.
 * Multi-tenant: routes /{tenantId}/sse and /{tenantId}/message to the correct tenant's registry.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { join } from 'path';
import { fileURLToPath } from 'url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

import { log } from './mcp-registry.js';
import type { TenantManager } from './tenant-manager.js';
import { TenantManager as TM } from './tenant-manager.js';

const __dirname = join(fileURLToPath(import.meta.url), '..');

export function startSseServer(mcpHttpPort: number, manager: TenantManager): Promise<boolean> {
  return new Promise((resolve) => {
    // Composite key: "tenantId::sessionId"
    const transports = new Map<
      string,
      { transport: SSEServerTransport; server: McpServer; tenantId: string }
    >();

    const httpServer = createServer(async (req, res) => {
      const rawUrl = req.url ?? '/';
      const urlPath = rawUrl.split('?')[0];

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
        tenant.registry.addServer(mcpServer);
        tenant.registry.syncPageToolsToNewServer(mcpServer);

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

      // Unknown route
      res.writeHead(404).end('Not Found');
    });

    httpServer.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        log(`ERROR: MCP HTTP port ${mcpHttpPort} is already in use.`);
      } else {
        log(
          'ERROR: MCP HTTP server failed:',
          error instanceof Error ? error.message : String(error),
        );
      }
      resolve(false);
    });

    httpServer.listen(mcpHttpPort, '0.0.0.0', () => {
      log(`MCP SSE server listening on http://0.0.0.0:${mcpHttpPort}`);
      resolve(true);
    });
  });
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
