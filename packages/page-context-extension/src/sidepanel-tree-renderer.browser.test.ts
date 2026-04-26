import { describe, expect, it } from 'vitest';

import { filterBuiltins } from './sidepanel-tree-renderer';
import type { ToolTreeBuiltins } from './sidepanel-types';

describe('sidepanel builtin filtering', () => {
  it('keeps namespaced builtin/control tools discoverable via unified filter', () => {
    const builtins: ToolTreeBuiltins = {
      kind: 'builtins',
      totalTools: 3,
      enabledTools: 3,
      namespaces: [
        {
          kind: 'builtin-namespace',
          namespace: 'page',
          totalTools: 1,
          enabledTools: 1,
          instances: [
            {
              kind: 'builtin-instance',
              namespace: 'page',
              instanceId: 'default',
              totalTools: 1,
              enabledTools: 1,
              tools: [
                {
                  kind: 'builtin-tool',
                  namespace: 'page',
                  instanceId: 'default',
                  toolName: 'builtin.page.get_page_info',
                  label: 'get_page_info',
                  enabled: true,
                  readOnly: true,
                  bridgeControl: false,
                },
              ],
            },
          ],
        },
        {
          kind: 'builtin-namespace',
          namespace: 'extension',
          totalTools: 1,
          enabledTools: 1,
          instances: [
            {
              kind: 'builtin-instance',
              namespace: 'extension',
              instanceId: 'default',
              totalTools: 1,
              enabledTools: 1,
              tools: [
                {
                  kind: 'builtin-tool',
                  namespace: 'extension',
                  instanceId: 'default',
                  toolName: 'extension.get_runtime_status',
                  label: 'get_runtime_status',
                  enabled: true,
                  readOnly: true,
                  bridgeControl: true,
                },
              ],
            },
          ],
        },
        {
          kind: 'builtin-namespace',
          namespace: 'feedback',
          totalTools: 1,
          enabledTools: 1,
          instances: [
            {
              kind: 'builtin-instance',
              namespace: 'feedback',
              instanceId: 'default',
              totalTools: 1,
              enabledTools: 1,
              tools: [
                {
                  kind: 'builtin-tool',
                  namespace: 'feedback',
                  instanceId: 'default',
                  toolName: 'feedback.get_snapshot',
                  label: 'get_snapshot',
                  enabled: true,
                  readOnly: true,
                  bridgeControl: true,
                },
              ],
            },
          ],
        },
      ],
      tools: [
        {
          kind: 'builtin-tool',
          namespace: 'page',
          instanceId: 'default',
          toolName: 'builtin.page.get_page_info',
          label: 'get_page_info',
          enabled: true,
          readOnly: true,
          bridgeControl: false,
        },
        {
          kind: 'builtin-tool',
          namespace: 'extension',
          instanceId: 'default',
          toolName: 'extension.get_runtime_status',
          label: 'get_runtime_status',
          enabled: true,
          readOnly: true,
          bridgeControl: true,
        },
        {
          kind: 'builtin-tool',
          namespace: 'feedback',
          instanceId: 'default',
          toolName: 'feedback.get_snapshot',
          label: 'get_snapshot',
          enabled: true,
          readOnly: true,
          bridgeControl: true,
        },
      ],
    };

    const filtered = filterBuiltins(builtins, 'feedback.get_snapshot');
    expect(filtered.totalTools).toBe(1);
    expect(filtered.tools[0]?.toolName).toBe('feedback.get_snapshot');
    expect(filtered.namespaces.map((namespace) => namespace.namespace)).toEqual(['feedback']);
  });

  it('returns all builtin entries when query is empty', () => {
    const builtins: ToolTreeBuiltins = {
      kind: 'builtins',
      totalTools: 2,
      enabledTools: 2,
      namespaces: [
        {
          kind: 'builtin-namespace',
          namespace: 'page',
          totalTools: 1,
          enabledTools: 1,
          instances: [
            {
              kind: 'builtin-instance',
              namespace: 'page',
              instanceId: 'default',
              totalTools: 1,
              enabledTools: 1,
              tools: [
                {
                  kind: 'builtin-tool',
                  namespace: 'page',
                  instanceId: 'default',
                  toolName: 'builtin.page.navigate',
                  label: 'navigate',
                  enabled: true,
                  readOnly: false,
                  bridgeControl: false,
                },
              ],
            },
          ],
        },
        {
          kind: 'builtin-namespace',
          namespace: 'extension',
          totalTools: 1,
          enabledTools: 1,
          instances: [
            {
              kind: 'builtin-instance',
              namespace: 'extension',
              instanceId: 'default',
              totalTools: 1,
              enabledTools: 1,
              tools: [
                {
                  kind: 'builtin-tool',
                  namespace: 'extension',
                  instanceId: 'default',
                  toolName: 'extension.reconnect',
                  label: 'reconnect',
                  enabled: true,
                  readOnly: false,
                  bridgeControl: true,
                },
              ],
            },
          ],
        },
      ],
      tools: [
        {
          kind: 'builtin-tool',
          namespace: 'page',
          instanceId: 'default',
          toolName: 'builtin.page.navigate',
          label: 'navigate',
          enabled: true,
          readOnly: false,
          bridgeControl: false,
        },
        {
          kind: 'builtin-tool',
          namespace: 'extension',
          instanceId: 'default',
          toolName: 'extension.reconnect',
          label: 'reconnect',
          enabled: true,
          readOnly: false,
          bridgeControl: true,
        },
      ],
    };

    const filtered = filterBuiltins(builtins, '');
    expect(filtered.totalTools).toBe(2);
    expect(filtered.tools.map((tool) => tool.toolName)).toEqual([
      'builtin.page.navigate',
      'extension.reconnect',
    ]);
    expect(filtered.namespaces).toHaveLength(2);
  });
});
