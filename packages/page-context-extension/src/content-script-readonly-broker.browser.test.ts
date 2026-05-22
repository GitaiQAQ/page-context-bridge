import { afterEach, describe, expect, it } from 'vitest';

import {
  PAGE_CONTEXT_READONLY_REQUEST_EVENT,
  dispatchReadonlyBrokerResponse,
  parseReadonlyBrokerRequest,
  requestReadonlyFromMainWorld,
  runReadonlyBrokerRequest,
} from './content-script-readonly-broker';

type BridgeWindow = Window & {
  __pageContextBridge__?: Record<string, unknown>;
  __pageContextTools__?: Record<string, unknown>;
};

describe('content-script-readonly-broker', () => {
  afterEach(() => {
    const win = window as BridgeWindow;
    Reflect.deleteProperty(win, '__pageContextBridge__');
    Reflect.deleteProperty(win, '__pageContextTools__');
  });

  it('reads manifest from __pageContextBridge__', async () => {
    (window as BridgeWindow).__pageContextBridge__ = {
      getManifest: () => ({
        version: '1.0.0',
        app: 'demo',
        route: '/demo',
        scene: 'demo',
        namespaces: [],
        resources: [],
        skills: [],
        generatedAt: '2026-05-14T00:00:00.000Z',
      }),
    };

    const response = await runReadonlyBrokerRequest(window, {
      requestId: 'r-1',
      method: 'context.manifest.get',
    });

    expect(response).toEqual({
      requestId: 'r-1',
      ok: true,
      result: {
        version: '1.0.0',
        app: 'demo',
        route: '/demo',
        scene: 'demo',
        namespaces: [],
        resources: [],
        skills: [],
        generatedAt: '2026-05-14T00:00:00.000Z',
      },
    });
  });

  it('returns structured error when resourceId is missing', async () => {
    const response = await runReadonlyBrokerRequest(window, {
      requestId: 'r-2',
      method: 'context.resource.read',
      params: {},
    });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error).toContain('resourceId is required');
    }
  });

  it('falls back to __pageContextTools__ and passes array input through to getSkill()', async () => {
    const getSkill = (id: string, input?: Record<string, unknown>) => ({
      skill: {
        id,
        namespace: 'workspace',
        title: 'workspace skill',
        description: 'demo',
      },
      text: JSON.stringify(input ?? {}),
    });
    (window as BridgeWindow).__pageContextTools__ = { getSkill };

    const response = await runReadonlyBrokerRequest(window, {
      requestId: 'r-3',
      method: 'context.skill.get',
      params: {
        skillId: 'skill-1',
        input: ['non-object'],
      },
    });

    expect(response).toEqual({
      requestId: 'r-3',
      ok: true,
      result: {
        skill: {
          id: 'skill-1',
          namespace: 'workspace',
          title: 'workspace skill',
          description: 'demo',
        },
        text: '["non-object"]',
      },
    });
  });

  it('completes request/response roundtrip via window events', async () => {
    const win = window as BridgeWindow;
    win.__pageContextBridge__ = {
      readResource: (resourceId: string) => ({
        id: resourceId,
        mimeType: 'text/plain',
        text: 'hello',
      }),
    };

    // main-world helper 的最薄职责：收到 request 事件后读取 bridge，再回发 response。
    const onRequest = async (event: Event) => {
      const detail = parseReadonlyBrokerRequest((event as CustomEvent<unknown>).detail);
      if (!detail) {
        return;
      }
      const response = await runReadonlyBrokerRequest(window, detail);
      dispatchReadonlyBrokerResponse(window, response);
    };
    window.addEventListener(PAGE_CONTEXT_READONLY_REQUEST_EVENT, onRequest as EventListener);

    try {
      const result = await requestReadonlyFromMainWorld<{ id: string; text: string }>(
        window,
        'context.resource.read',
        { resourceId: 'res-1' },
        500,
      );
      expect(result).toEqual({
        id: 'res-1',
        mimeType: 'text/plain',
        text: 'hello',
      });
    } finally {
      window.removeEventListener(PAGE_CONTEXT_READONLY_REQUEST_EVENT, onRequest as EventListener);
    }
  });

  it('discovers versioned bridge tools with namespace metadata', async () => {
    (window as BridgeWindow).__pageContextBridge__ = {
      version: '1.0.0',
      getManifest: () => ({
        version: '1.0.0',
        app: 'demo',
        route: '/demo',
        scene: 'demo',
        namespaces: [
          {
            namespace: 'workspace',
            title: 'Workspace',
            description: 'Workspace namespace',
          },
        ],
        resources: [],
        skills: [],
        generatedAt: '2026-05-16T00:00:00.000Z',
      }),
      listNamespaces: () => ['workspace'],
      getNamespace: (namespace: string) => {
        if (namespace !== 'workspace') {
          return undefined;
        }
        return {
          listInstances: () => ['default'],
          getInstance: (instanceId: string) => {
            if (instanceId !== 'default') {
              return undefined;
            }
            return {
              listTools: () => [{ name: 'workspace.page.echo', description: 'Echo tool' }],
            };
          },
        };
      },
    };

    const response = await runReadonlyBrokerRequest(window, {
      requestId: 'r-discover-1',
      method: 'page.tools.discover',
    });

    expect(response).toEqual({
      requestId: 'r-discover-1',
      ok: true,
      result: [
        {
          namespace: 'workspace',
          namespaceTitle: 'Workspace',
          namespaceDescription: 'Workspace namespace',
          instanceId: 'default',
          tools: [{ name: 'workspace.page.echo', description: 'Echo tool' }],
        },
      ],
    });
  });

  it('discovers legacy bridge tools through request/response events', async () => {
    const win = window as BridgeWindow;
    win.__pageContextTools__ = {
      namespace: 'legacy',
      instanceId: 'root',
      listTools: () => [{ name: 'legacy.page.read', description: 'Read legacy page' }],
    };

    const onRequest = async (event: Event) => {
      const detail = parseReadonlyBrokerRequest((event as CustomEvent<unknown>).detail);
      if (!detail) {
        return;
      }
      const response = await runReadonlyBrokerRequest(window, detail);
      dispatchReadonlyBrokerResponse(window, response);
    };
    window.addEventListener(PAGE_CONTEXT_READONLY_REQUEST_EVENT, onRequest as EventListener);

    try {
      const result = await requestReadonlyFromMainWorld(
        window,
        'page.tools.discover',
        undefined,
        500,
      );
      expect(result).toEqual([
        {
          namespace: 'legacy',
          namespaceTitle: undefined,
          namespaceDescription: undefined,
          instanceId: 'root',
          tools: [{ name: 'legacy.page.read', description: 'Read legacy page' }],
        },
      ]);
    } finally {
      window.removeEventListener(PAGE_CONTEXT_READONLY_REQUEST_EVENT, onRequest as EventListener);
    }
  });

  it('executes versioned bridge tools through selected namespace instance', async () => {
    const callTool = async (name: string, args: Record<string, unknown>) => ({
      name,
      echoed: args,
      source: 'versioned',
    });
    (window as BridgeWindow).__pageContextBridge__ = {
      version: '1.0.0',
      listNamespaces: () => ['workspace'],
      getNamespace: (namespace: string) => {
        if (namespace !== 'workspace') {
          return undefined;
        }
        return {
          listInstances: () => ['first', 'second'],
          getInstance: (instanceId: string) => {
            if (instanceId !== 'second') {
              return undefined;
            }
            return { callTool };
          },
        };
      },
    };

    const response = await runReadonlyBrokerRequest(window, {
      requestId: 'r-execute-1',
      method: 'page.tool.execute',
      params: {
        pageToolName: 'workspace.page.echo',
        args: { message: 'hello' },
        namespace: 'workspace',
        instanceId: 'second',
      },
    });

    expect(response).toEqual({
      requestId: 'r-execute-1',
      ok: true,
      result: {
        ok: true,
        result: {
          name: 'workspace.page.echo',
          echoed: { message: 'hello' },
          source: 'versioned',
        },
      },
    });
  });

  it('parses readonly broker requests from JSON event detail strings', () => {
    expect(
      parseReadonlyBrokerRequest(
        JSON.stringify({
          requestId: 'req-1',
          method: 'page.tools.discover',
        }),
      ),
    ).toEqual({
      requestId: 'req-1',
      method: 'page.tools.discover',
    });
  });

  it('executes versioned bridge tools through first instance when instanceId is omitted', async () => {
    (window as BridgeWindow).__pageContextBridge__ = {
      version: '1.0.0',
      listNamespaces: () => ['workspace'],
      getNamespace: () => ({
        listInstances: () => ['first', 'second'],
        getInstance: (instanceId: string) => ({
          callTool: (name: string, args: Record<string, unknown>) => ({ name, args, instanceId }),
        }),
      }),
    };

    const response = await runReadonlyBrokerRequest(window, {
      requestId: 'r-execute-1b',
      method: 'page.tool.execute',
      params: {
        pageToolName: 'workspace.page.echo',
        args: { message: 'hello' },
        namespace: 'workspace',
      },
    });

    expect(response).toEqual({
      requestId: 'r-execute-1b',
      ok: true,
      result: {
        ok: true,
        result: {
          name: 'workspace.page.echo',
          args: { message: 'hello' },
          instanceId: 'first',
        },
      },
    });
  });

  it('executes legacy bridge tools through callTool()', async () => {
    (window as BridgeWindow).__pageContextTools__ = {
      callTool: (name: string, args: Record<string, unknown>) => ({ name, args, source: 'legacy' }),
    };

    const response = await runReadonlyBrokerRequest(window, {
      requestId: 'r-execute-2',
      method: 'page.tool.execute',
      params: {
        pageToolName: 'legacy.page.echo',
        args: { ok: true },
        namespace: 'legacy',
      },
    });

    expect(response).toEqual({
      requestId: 'r-execute-2',
      ok: true,
      result: {
        ok: true,
        result: { name: 'legacy.page.echo', args: { ok: true }, source: 'legacy' },
      },
    });
  });

  it('returns execution result error when namespace does not exist', async () => {
    (window as BridgeWindow).__pageContextBridge__ = {
      version: '1.0.0',
      listNamespaces: () => ['workspace'],
      getNamespace: () => undefined,
    };

    const response = await runReadonlyBrokerRequest(window, {
      requestId: 'r-execute-3',
      method: 'page.tool.execute',
      params: {
        pageToolName: 'missing.page.echo',
        args: {},
        namespace: 'missing',
      },
    });

    expect(response).toEqual({
      requestId: 'r-execute-3',
      ok: true,
      result: { ok: false, error: 'Namespace not found: missing' },
    });
  });

  it('returns execution result error when instance does not exist', async () => {
    (window as BridgeWindow).__pageContextBridge__ = {
      version: '1.0.0',
      listNamespaces: () => ['workspace'],
      getNamespace: () => ({
        listInstances: () => ['default'],
        getInstance: () => undefined,
      }),
    };

    const response = await runReadonlyBrokerRequest(window, {
      requestId: 'r-execute-4',
      method: 'page.tool.execute',
      params: {
        pageToolName: 'workspace.page.echo',
        args: {},
        namespace: 'workspace',
        instanceId: 'missing-instance',
      },
    });

    expect(response).toEqual({
      requestId: 'r-execute-4',
      ok: true,
      result: { ok: false, error: 'Instance not found: missing-instance' },
    });
  });

  it('returns execution result error when tool throws', async () => {
    (window as BridgeWindow).__pageContextBridge__ = {
      version: '1.0.0',
      listNamespaces: () => ['workspace'],
      getNamespace: () => ({
        listInstances: () => ['default'],
        getInstance: () => ({
          callTool: () => {
            throw new Error('tool failed');
          },
        }),
      }),
    };

    const response = await runReadonlyBrokerRequest(window, {
      requestId: 'r-execute-5',
      method: 'page.tool.execute',
      params: {
        pageToolName: 'workspace.page.fail',
        args: {},
        namespace: 'workspace',
      },
    });

    expect(response).toEqual({
      requestId: 'r-execute-5',
      ok: true,
      result: {
        ok: false,
        error: 'instance(workspace).callTool(workspace.page.fail) failed: tool failed',
      },
    });
  });
});
