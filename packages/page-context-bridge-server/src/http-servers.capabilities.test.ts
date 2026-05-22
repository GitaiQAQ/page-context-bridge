import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { primeDynamicCapabilitiesForConnectedServer } from './http-servers.js';

async function createConnectedServer() {
  const server = new McpServer({ name: 'page-context-bridge-test', version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await clientTransport.start();
  return { server, clientTransport };
}

describe('http-servers capability priming', () => {
  const cleanupTasks: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanupTasks.length > 0) {
      await cleanupTasks.pop()?.();
    }
  });

  it('shows why connected servers must prime resource capability before dynamic registration', async () => {
    const { server, clientTransport } = await createConnectedServer();
    cleanupTasks.push(async () => {
      await server.close();
      await clientTransport.close();
    });

    expect(() =>
      server.registerResource(
        'tab.1.resource.page.page-summary',
        'context://tab/1/resource/page/page.summary',
        {
          title: 'Page Summary',
          description: 'summary',
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
      ),
    ).toThrowError('Cannot register capabilities after connecting to transport');
  });

  it('primes tool/resource/prompt capabilities before connect so later dynamic registration stays valid', async () => {
    const server = new McpServer({ name: 'page-context-bridge-test', version: '0.0.1' });
    primeDynamicCapabilitiesForConnectedServer(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await clientTransport.start();
    cleanupTasks.push(async () => {
      await server.close();
      await clientTransport.close();
    });

    expect(() =>
      server.registerResource(
        'tab.1.resource.page.page-summary',
        'context://tab/1/resource/page/page.summary',
        {
          title: 'Page Summary',
          description: 'summary',
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
      ),
    ).not.toThrow();

    expect(() =>
      server.registerPrompt(
        'tab.1.skill.page.page-inspect',
        {
          title: 'Inspect Page',
          description: 'inspect',
          argsSchema: {},
        },
        async () => ({
          description: 'inspect',
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: 'inspect page',
              },
            },
          ],
        }),
      ),
    ).not.toThrow();
  });
});
