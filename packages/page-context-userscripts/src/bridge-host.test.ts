import { beforeEach, describe, expect, it } from 'vitest';

import {
  PAGE_CONTEXT_BRIDGE_HOST_READY_EVENT,
  getOrCreatePageContextBridgeHost,
} from './bridge-host';
import type { PageContextBridgeLike } from './types';

describe('page context bridge host', () => {
  beforeEach(() => {
    delete window.__pageContextBridge__;
    delete window.__pageContextTools__;
    delete window.__pageContextBridgeHost__;
  });

  it('merges sources and resolves namespace conflicts by priority', () => {
    const host = getOrCreatePageContextBridgeHost(window, document);
    const lowPriorityBridge = createBridge('low', 'shared', 'low-value');
    const highPriorityBridge = createBridge('high', 'shared', 'high-value');

    host.registerSource({ sourceId: 'low', bridge: lowPriorityBridge, priority: 10 });
    host.registerSource({ sourceId: 'high', bridge: highPriorityBridge, priority: 100 });

    expect(window.__pageContextBridge__).toBe(host.bridge);
    expect(host.bridge.listNamespaces()).toEqual(['shared']);
    const value = JSON.parse(host.bridge.readResource('shared.summary').text) as {
      from: string;
      value: string;
    };
    expect(value).toEqual({ from: 'high', value: 'high-value' });
  });

  it('adopts existing bridge and removes adopted alias when same bridge is explicitly registered', () => {
    const foreignBridge = createBridge('foreign', 'foreign', 'foreign-value');
    window.__pageContextBridge__ = foreignBridge;

    const host = getOrCreatePageContextBridgeHost(window, document);
    expect(host.listSources().map((source) => source.sourceId)).toContain('adopted-window-bridge');

    host.registerSource({
      sourceId: 'page-runtime',
      bridge: foreignBridge,
      priority: 90,
      tags: ['page'],
    });
    expect(host.listSources().map((source) => source.sourceId)).toEqual(['page-runtime']);
  });

  it('dispatches host ready event for late page runtime registration', () => {
    const readyEvents: number[] = [];
    window.addEventListener(PAGE_CONTEXT_BRIDGE_HOST_READY_EVENT, () => {
      readyEvents.push(Date.now());
    });

    getOrCreatePageContextBridgeHost(window, document);
    expect(readyEvents.length).toBe(1);
  });
});

function createBridge(sourceId: string, namespace: string, value: string): PageContextBridgeLike {
  return {
    version: `${sourceId}/1.0.0`,
    listNamespaces: () => [namespace],
    getNamespace: (requestedNamespace: string) => {
      if (requestedNamespace !== namespace) {
        return undefined;
      }
      return {
        namespace,
        listInstances: () => ['primary'],
        getInstance: (instanceId: string) => {
          if (instanceId !== 'primary') {
            return undefined;
          }
          return {
            instanceId,
            listTools: () => [
              {
                name: 'inspect',
                description: 'inspect',
                inputSchema: { type: 'object', properties: {}, additionalProperties: false },
              },
            ],
            callTool: () => ({ ok: true, sourceId }),
          };
        },
      };
    },
    getScene: () => `${sourceId}-scene`,
    listResources: () => [
      {
        id: `${namespace}.summary`,
        namespace,
        title: 'Summary',
        mimeType: 'application/json',
        kind: 'json',
      },
    ],
    readResource: (id: string) => ({
      id,
      mimeType: 'application/json',
      text: JSON.stringify({ from: sourceId, value }),
    }),
    listSkills: () => [
      {
        id: `${namespace}.analyze`,
        namespace,
        title: 'Analyze',
        description: 'Analyze namespace',
        mode: 'analysis',
      },
    ],
    getSkill: (id: string) => ({
      skill: {
        id,
        namespace,
        title: 'Analyze',
        description: 'Analyze namespace',
        mode: 'analysis',
      },
      text: 'skill',
    }),
    getManifest: () => ({
      version: `${sourceId}/1.0.0`,
      app: sourceId,
      route: '/',
      scene: `${sourceId}-scene`,
      namespaces: [{ namespace, title: namespace }],
      resources: [
        {
          id: `${namespace}.summary`,
          namespace,
          title: 'Summary',
          mimeType: 'application/json',
          kind: 'json',
        },
      ],
      skills: [
        {
          id: `${namespace}.analyze`,
          namespace,
          title: 'Analyze',
          description: 'Analyze namespace',
          mode: 'analysis',
        },
      ],
      generatedAt: new Date().toISOString(),
    }),
  };
}
