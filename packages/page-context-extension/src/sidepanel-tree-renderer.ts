/**
 * Tool tree rendering — builds the collapsible tree HTML for the tools panel.
 * Uses daisyUI/Tailwind utility classes.
 */

import { html, nothing, type TemplateResult } from 'lit';
import type {
  ToolTreeBuiltinInstance,
  ToolTreeBuiltinNamespace,
  ToolTreeBuiltinTool,
  ToolTreeBuiltins,
  ToolTreeInstance,
  ToolTreeNamespace,
  ToolTreeTab,
  ToolTreeTool,
} from './sidepanel-types';

export function renderToolsEmpty(message: string): TemplateResult {
  return html`<div
    class="flex flex-col items-center justify-center h-full text-base-content/40 p-5"
  >
    <p class="text-xs">${message}</p>
  </div>`;
}

export function filterTab(tab: ToolTreeTab, query: string): ToolTreeTab | null {
  const namespaces = tab.namespaces
    .map((namespace) => filterNamespace(namespace, query))
    .filter((namespace): namespace is ToolTreeNamespace => namespace !== null);

  const selfMatches =
    !query ||
    [tab.title, tab.url, String(tab.tabId)].some((value) => value.toLowerCase().includes(query));
  if (!selfMatches && namespaces.length === 0) {
    return null;
  }

  return {
    ...tab,
    namespaces: selfMatches ? tab.namespaces : namespaces,
  };
}

export function filterBuiltins(builtins: ToolTreeBuiltins, query: string): ToolTreeBuiltins {
  const sourceNamespaces = normalizeBuiltinNamespaces(builtins);
  if (!query) {
    return {
      ...builtins,
      namespaces: sourceNamespaces,
      tools: sourceNamespaces.flatMap((namespace) =>
        namespace.instances.flatMap((instance) => instance.tools),
      ),
    };
  }
  const namespaces = sourceNamespaces
    .map((namespace) => filterBuiltinNamespace(namespace, query))
    .filter((namespace): namespace is ToolTreeBuiltinNamespace => namespace !== null);
  const tools = namespaces.flatMap((namespace) =>
    namespace.instances.flatMap((instance) => instance.tools),
  );
  return {
    ...builtins,
    namespaces,
    totalTools: tools.length,
    enabledTools: tools.filter((tool) => tool.enabled).length,
    tools,
  };
}

export function renderBuiltinsNode(builtins: ToolTreeBuiltins): TemplateResult {
  const namespaces = normalizeBuiltinNamespaces(builtins);
  return html`
    <details open>
      <summary>
        ${renderTreeRow({
          level: 'tab',
          checked: builtins.enabledTools === builtins.totalTools && builtins.totalTools > 0,
          indeterminate: builtins.enabledTools > 0 && builtins.enabledTools < builtins.totalTools,
          data: { root: 'builtin', scope: 'builtin', tabId: 'builtin-root' },
          label: 'Built-in Tools',
          subtitle: 'Extension provided tools',
          meta: `${builtins.enabledTools}/${builtins.totalTools} enabled`,
          badges: [html`<span class="badge badge-xs badge-primary">builtin</span>`],
        })}
      </summary>
      ${namespaces.map((namespace) => renderBuiltinNamespaceNode(namespace))}
    </details>
  `;
}

function normalizeBuiltinNamespaces(builtins: ToolTreeBuiltins): ToolTreeBuiltinNamespace[] {
  if (Array.isArray(builtins.namespaces) && builtins.namespaces.length > 0) {
    return builtins.namespaces;
  }
  // Compatible with old flat structure to avoid blank sidepanel during version transitions.
  const byNamespace = new Map<string, ToolTreeBuiltinTool[]>();
  for (const tool of builtins.tools ?? []) {
    // Extract semantic category from 3-segment names: builtin.<category>.<action>
    const parts = tool.toolName.split('.');
    const namespace =
      tool.namespace ||
      (parts.length >= 3 && parts[0] === 'builtin' ? parts[1] : parts[0]) ||
      'builtin';
    const normalizedTool = {
      ...tool,
      namespace,
      instanceId: tool.instanceId || 'default',
    };
    byNamespace.set(namespace, [...(byNamespace.get(namespace) ?? []), normalizedTool]);
  }
  return Array.from(byNamespace.entries())
    .map(([namespace, tools]) => ({
      kind: 'builtin-namespace' as const,
      namespace,
      totalTools: tools.length,
      enabledTools: tools.filter((item) => item.enabled).length,
      instances: [
        {
          kind: 'builtin-instance' as const,
          namespace,
          instanceId: 'default',
          totalTools: tools.length,
          enabledTools: tools.filter((item) => item.enabled).length,
          tools: tools.sort((left, right) => left.label.localeCompare(right.label)),
        },
      ],
    }))
    .sort((left, right) => left.namespace.localeCompare(right.namespace));
}

function filterBuiltinNamespace(
  namespace: ToolTreeBuiltinNamespace,
  query: string,
): ToolTreeBuiltinNamespace | null {
  const instances = namespace.instances
    .map((instance) => filterBuiltinInstance(instance, query))
    .filter((instance): instance is ToolTreeBuiltinInstance => instance !== null);
  const selfMatches = !query || namespace.namespace.toLowerCase().includes(query);
  if (!selfMatches && instances.length === 0) {
    return null;
  }
  const finalInstances = selfMatches ? namespace.instances : instances;
  return {
    ...namespace,
    instances: finalInstances,
    totalTools: finalInstances.reduce((sum, item) => sum + item.totalTools, 0),
    enabledTools: finalInstances.reduce((sum, item) => sum + item.enabledTools, 0),
  };
}

function filterBuiltinInstance(
  instance: ToolTreeBuiltinInstance,
  query: string,
): ToolTreeBuiltinInstance | null {
  const tools = instance.tools.filter((tool) => matchesBuiltinTool(tool, query));
  const selfMatches = !query || instance.instanceId.toLowerCase().includes(query);
  if (!selfMatches && tools.length === 0) {
    return null;
  }
  const finalTools = selfMatches ? instance.tools : tools;
  return {
    ...instance,
    tools: finalTools,
    totalTools: finalTools.length,
    enabledTools: finalTools.filter((tool) => tool.enabled).length,
  };
}

function matchesBuiltinTool(tool: ToolTreeBuiltinTool, query: string): boolean {
  if (!query) {
    return true;
  }
  return [tool.namespace, tool.instanceId, tool.label, tool.toolName, tool.description ?? ''].some(
    (value) => value.toLowerCase().includes(query),
  );
}

function renderBuiltinNamespaceNode(namespace: ToolTreeBuiltinNamespace): TemplateResult {
  return html`
    <details open>
      <summary>
        ${renderTreeRow({
          level: 'namespace',
          checked: namespace.enabledTools === namespace.totalTools && namespace.totalTools > 0,
          indeterminate:
            namespace.enabledTools > 0 && namespace.enabledTools < namespace.totalTools,
          toggleDisabled: namespace.instances.every((instance) =>
            instance.tools.every((tool) => isBridgeControlBuiltinTool(tool)),
          ),
          data: {
            root: 'builtin',
            scope: 'builtin',
            tabId: 'builtin-root',
            namespace: namespace.namespace,
          },
          label: namespace.namespace,
          subtitle: 'Builtin namespace',
          meta: `${namespace.enabledTools}/${namespace.totalTools} enabled`,
          badges: [html`<span class="badge badge-xs badge-secondary">namespace</span>`],
        })}
      </summary>
      ${namespace.instances.map((instance) => renderBuiltinInstanceNode(instance))}
    </details>
  `;
}

function renderBuiltinInstanceNode(instance: ToolTreeBuiltinInstance): TemplateResult {
  return html`
    <details open>
      <summary>
        ${renderTreeRow({
          level: 'instance',
          checked: instance.enabledTools === instance.totalTools && instance.totalTools > 0,
          indeterminate: instance.enabledTools > 0 && instance.enabledTools < instance.totalTools,
          toggleDisabled: instance.tools.every((tool) => isBridgeControlBuiltinTool(tool)),
          data: {
            root: 'builtin',
            scope: 'builtin',
            tabId: 'builtin-root',
            namespace: instance.namespace,
            instanceId: instance.instanceId,
          },
          label: instance.instanceId,
          subtitle: instance.instanceId === 'default' ? 'Default instance' : 'Builtin instance',
          meta: `${instance.enabledTools}/${instance.totalTools} enabled`,
          badges: [html`<span class="badge badge-xs badge-accent">instance</span>`],
        })}
      </summary>
      ${instance.tools.map((tool) => renderBuiltinToolNode(tool))}
    </details>
  `;
}

export function renderTabNode(tab: ToolTreeTab): TemplateResult {
  return html`
    <details open>
      <summary>
        ${renderTreeRow({
          level: 'tab',
          checked: tab.enabledTools === tab.totalTools && tab.totalTools > 0,
          indeterminate: tab.enabledTools > 0 && tab.enabledTools < tab.totalTools,
          data: { root: 'page', scope: 'tab', tabId: String(tab.tabId) },
          label: tab.title,
          subtitle: tab.url ? tab.url : '',
          meta: `${tab.enabledTools}/${tab.totalTools} enabled`,
          badges: [
            tab.active ? html`<span class="badge badge-xs badge-success">active</span>` : nothing,
            html`<span class="badge badge-xs badge-ghost">tab ${tab.tabId}</span>`,
          ],
        })}
      </summary>
      ${tab.namespaces.map((namespace) => renderNamespaceNode(namespace))}
    </details>
  `;
}

function filterNamespace(namespace: ToolTreeNamespace, query: string): ToolTreeNamespace | null {
  const instances = namespace.instances
    .map((instance) => filterInstance(instance, query))
    .filter((instance): instance is ToolTreeInstance => instance !== null);

  const selfMatches = !query || namespace.namespace.toLowerCase().includes(query);
  if (!selfMatches && instances.length === 0) {
    return null;
  }

  return {
    ...namespace,
    instances: selfMatches ? namespace.instances : instances,
  };
}

function filterInstance(instance: ToolTreeInstance, query: string): ToolTreeInstance | null {
  const tools = instance.tools.filter((tool) => matchesTool(tool, query));
  const selfMatches = !query || instance.instanceId.toLowerCase().includes(query);
  if (!selfMatches && tools.length === 0) {
    return null;
  }

  return {
    ...instance,
    tools: selfMatches ? instance.tools : tools,
  };
}

function matchesTool(tool: ToolTreeTool, query: string): boolean {
  if (!query) {
    return true;
  }
  return [tool.toolName, tool.label, tool.description ?? ''].some((value) =>
    value.toLowerCase().includes(query),
  );
}

function renderNamespaceNode(namespace: ToolTreeNamespace): TemplateResult {
  return html`
    <details open>
      <summary>
        ${renderTreeRow({
          level: 'namespace',
          checked: namespace.enabledTools === namespace.totalTools && namespace.totalTools > 0,
          indeterminate:
            namespace.enabledTools > 0 && namespace.enabledTools < namespace.totalTools,
          data: {
            root: 'page',
            scope: 'namespace',
            tabId: String(namespace.tabId),
            namespace: namespace.namespace,
          },
          label: namespace.namespace,
          subtitle: 'Namespace',
          meta: `${namespace.enabledTools}/${namespace.totalTools} enabled`,
          badges: [html`<span class="badge badge-xs badge-secondary">namespace</span>`],
        })}
      </summary>
      ${namespace.instances.map((instance) => renderInstanceNode(instance))}
    </details>
  `;
}

function renderInstanceNode(instance: ToolTreeInstance): TemplateResult {
  return html`
    <details open>
      <summary>
        ${renderTreeRow({
          level: 'instance',
          checked: instance.enabledTools === instance.totalTools && instance.totalTools > 0,
          indeterminate: instance.enabledTools > 0 && instance.enabledTools < instance.totalTools,
          data: {
            root: 'page',
            scope: 'instance',
            tabId: String(instance.tabId),
            namespace: instance.namespace,
            instanceId: instance.instanceId,
          },
          label: instance.instanceId,
          subtitle: instance.instanceId === 'default' ? 'Default instance' : 'Instance',
          meta: `${instance.enabledTools}/${instance.totalTools} enabled`,
          badges: [html`<span class="badge badge-xs badge-accent">instance</span>`],
        })}
      </summary>
      ${instance.tools.map((tool) => renderToolNode(tool))}
    </details>
  `;
}

function renderBuiltinToolNode(tool: ToolTreeBuiltinTool): TemplateResult {
  const bridgeControl = isBridgeControlBuiltinTool(tool);
  const subtitle = bridgeControl
    ? `${tool.description ? tool.description : tool.toolName} (Bridge/MCP control tool, display only)`
    : tool.description
      ? tool.description
      : tool.toolName;
  return renderTreeRow({
    level: 'tool',
    checked: tool.enabled,
    indeterminate: false,
    toggleDisabled: bridgeControl,
    data: { root: 'builtin', scope: 'builtin', tabId: 'builtin-root', toolName: tool.toolName },
    label: tool.label,
    subtitle,
    meta: tool.toolName,
    badges: [
      bridgeControl ? html`<span class="badge badge-xs badge-info">bridge</span>` : nothing,
      tool.readOnly ? html`<span class="badge badge-xs badge-success">readonly</span>` : nothing,
    ],
    actions: bridgeControl
      ? undefined
      : renderTestButton({
          root: 'builtin',
          toolName: tool.toolName,
          label: tool.label,
          inputSchema: tool.inputSchema,
        }),
  });
}

function renderToolNode(tool: ToolTreeTool): TemplateResult {
  return renderTreeRow({
    level: 'tool',
    checked: tool.enabled,
    indeterminate: false,
    data: {
      root: 'page',
      scope: 'tool',
      tabId: String(tool.tabId),
      namespace: tool.namespace,
      instanceId: tool.instanceId,
      toolName: tool.toolName,
    },
    label: tool.label,
    subtitle: tool.description ? tool.description : tool.toolName,
    meta: tool.toolName,
    badges: [
      tool.readOnly ? html`<span class="badge badge-xs badge-success">readonly</span>` : nothing,
    ],
    actions: renderTestButton({
      root: 'page',
      toolName: tool.toolName,
      label: tool.label,
      tabId: tool.tabId,
      inputSchema: tool.inputSchema,
    }),
  });
}

const INDENT_CLASS: Record<string, string> = {
  tab: '',
  namespace: 'tree-indent-1',
  instance: 'tree-indent-2',
  tool: 'tree-indent-3',
};

function renderTreeRow(input: {
  level: 'tab' | 'namespace' | 'instance' | 'tool';
  checked: boolean;
  indeterminate: boolean;
  toggleDisabled?: boolean;
  data: Record<string, string>;
  label: string;
  subtitle: string;
  meta: string;
  badges: (TemplateResult | typeof nothing)[];
  actions?: TemplateResult;
}): TemplateResult {
  const indent = INDENT_CLASS[input.level];

  return html`
    <div
      class="flex items-start gap-2 px-3 py-2 border-b border-base-200 bg-base-100 hover:bg-base-200/50 ${indent}"
    >
      <input
        type="checkbox"
        class="checkbox checkbox-xs checkbox-primary mt-0.5 shrink-0"
        .checked=${input.checked}
        .disabled=${Boolean(input.toggleDisabled)}
        data-indeterminate=${input.indeterminate ? 'true' : 'false'}
        data-root=${input.data.root ?? nothing}
        data-scope=${input.data.scope ?? nothing}
        data-tab-id=${input.data.tabId ?? nothing}
        data-namespace=${input.data.namespace ?? nothing}
        data-instance-id=${input.data.instanceId ?? nothing}
        data-tool-name=${input.data.toolName ?? nothing}
      />
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-1.5 flex-wrap text-xs font-semibold">
          ${input.label}<span class="badge badge-xs badge-ghost">${input.meta}</span>${input.badges}
        </div>
        ${input.subtitle
          ? html`<div class="mt-0.5 text-xs opacity-60 break-all leading-snug">
              ${input.subtitle}
            </div>`
          : nothing}
      </div>
      ${input.actions
        ? html`<div class="flex items-center gap-1.5 ml-auto shrink-0">${input.actions}</div>`
        : nothing}
    </div>
  `;
}

function isBridgeControlBuiltinTool(tool: ToolTreeBuiltinTool): boolean {
  if (tool.bridgeControl === true) {
    return true;
  }
  return tool.toolName.startsWith('extension.') || tool.toolName.startsWith('feedback.');
}

function renderTestButton(input: {
  root: 'builtin' | 'page';
  toolName: string;
  label: string;
  tabId?: number;
  inputSchema?: Record<string, unknown>;
}): TemplateResult {
  return html`
    <button
      type="button"
      class="btn btn-xs btn-outline btn-primary rounded-full"
      data-action="test-tool"
      data-root=${input.root}
      data-tool-name=${input.toolName}
      data-label=${input.label}
      data-schema=${JSON.stringify(input.inputSchema ?? {})}
      data-tab-id=${input.tabId != null ? String(input.tabId) : nothing}
    >
      Test
    </button>
  `;
}

export function createArgsTemplate(schema?: Record<string, unknown>): string {
  if (!schema || typeof schema !== 'object') {
    return '{}';
  }

  const properties =
    (schema.properties as Record<string, { type?: string; default?: unknown }> | undefined) ?? {};
  const required = new Set((schema.required as string[] | undefined) ?? []);
  const template: Record<string, unknown> = {};

  for (const [key, property] of Object.entries(properties)) {
    if (!required.has(key) && property.default === undefined) {
      continue;
    }
    if (property.default !== undefined) {
      template[key] = property.default;
      continue;
    }
    switch (property.type) {
      case 'number':
      case 'integer':
        template[key] = 0;
        break;
      case 'boolean':
        template[key] = false;
        break;
      case 'array':
        template[key] = [];
        break;
      case 'object':
        template[key] = {};
        break;
      default:
        template[key] = '';
        break;
    }
  }

  return formatJson(template);
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function safeParseJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
