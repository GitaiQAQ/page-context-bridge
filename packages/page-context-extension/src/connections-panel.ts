import { type ConnectionDescriptor, type ConnectionKind } from '@page-context/shared-protocol';
import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

import './connection-status-badge';

import { ConnectionsController, getConnectionsStore } from './connections-controller';
import {
  loadConnectionEndpoints,
  saveConnectionEndpoints,
  type ConnectionEndpointsConfig,
} from './connections-endpoints';

function isUnsupportedConnectionsActionError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message;
  return (
    message.includes('Unhandled runtime method: connections.action') ||
    message.includes('Expected JSON-RPC response envelope')
  );
}

function connectionKindTitle(kind: ConnectionKind): string {
  switch (kind) {
    case 'bridge-default-ws':
      return 'Bridge Default WS';
    case 'opencode-http':
      return 'OpenCode HTTP';
    case 'opencode-bridge-ws':
      return 'OpenCode Bridge WS';
    case 'page-tools':
      return 'Page Tools';
    case 'main-world-host':
      return 'Main World Host';
    case 'agentation-main-world-host':
      return 'Agentation Main World Host';
    default:
      return kind;
  }
}

function connectionKindSubtitle(kind: ConnectionKind): string {
  switch (kind) {
    case 'bridge-default-ws':
      return 'Persistent control link to bridge; all remote tools become unavailable if disconnected.';
    case 'opencode-http':
      return 'Entry point for sidepanel to call OpenCode REST API for session creation and health checks.';
    case 'opencode-bridge-ws':
      return 'Each OpenCode session corresponds to one browser-to-bridge tenant link.';
    case 'page-tools':
      return 'Page-injected tool capabilities that determine whether OpenCode can read the page.';
    case 'main-world-host':
      return 'Main world bridge host for reading page context and executing page-side tools.';
    case 'agentation-main-world-host':
      return 'Agentation main world host for deeper page automation capabilities.';
    default:
      return '';
  }
}

const CONNECTION_KIND_ORDER: ConnectionKind[] = [
  'bridge-default-ws',
  'opencode-http',
  'opencode-bridge-ws',
  'page-tools',
  'main-world-host',
  'agentation-main-world-host',
];

function connectionKindRank(kind: ConnectionKind): number {
  const index = CONNECTION_KIND_ORDER.indexOf(kind);
  return index >= 0 ? index : CONNECTION_KIND_ORDER.length;
}

function isHealthyConnection(descriptor: ConnectionDescriptor): boolean {
  return descriptor.status === 'connected' || descriptor.status === 'reachable';
}

function isAttentionConnection(descriptor: ConnectionDescriptor): boolean {
  return descriptor.status === 'error' || descriptor.status === 'unreachable';
}

function formatUpdatedAt(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return 'unknown';
  }

  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

function shortEndpoint(endpoint: string | null): string {
  if (!endpoint) return '-';
  try {
    const parsed = new URL(endpoint);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return endpoint;
  }
}

function getWsRouteKey(endpoint: string | null): string | null {
  if (!endpoint) return null;
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return null;
    const pathname = parsed.pathname === '/default' ? '/' : parsed.pathname;
    return `${parsed.protocol}//${parsed.host}${pathname}`;
  } catch {
    return null;
  }
}

@customElement('connections-panel')
export class ConnectionsPanel extends LitElement {
  protected override createRenderRoot(): this {
    return this;
  }

  private readonly connections = new ConnectionsController(this);

  @state() private endpoints: ConnectionEndpointsConfig = {
    opencodeBaseUrl: 'http://localhost:4096',
    bridgeBaseUrl: 'http://localhost:22334',
    bridgeWsUrl: 'ws://127.0.0.1:22335/default',
  };
  @state() private saving = false;
  @state() private message = '';
  @state() private diagnosisReport = '';

  override connectedCallback(): void {
    super.connectedCallback();
    void this.loadEndpoints();
  }

  private async loadEndpoints(): Promise<void> {
    this.endpoints = await loadConnectionEndpoints();
  }

  private groupDescriptors(): Array<{
    kind: ConnectionKind;
    title: string;
    subtitle: string;
    descriptors: ConnectionDescriptor[];
  }> {
    const groups = new Map<ConnectionKind, ConnectionDescriptor[]>();
    for (const descriptor of this.connections.descriptors) {
      // Endpoint status is consolidated in the config cards above; only runtime links are shown here.
      if (descriptor.kind === 'bridge-default-ws' || descriptor.kind === 'opencode-http') {
        continue;
      }
      const current = groups.get(descriptor.kind) ?? [];
      current.push(descriptor);
      groups.set(descriptor.kind, current);
    }

    return Array.from(groups.entries())
      .sort(([left], [right]) => connectionKindRank(left) - connectionKindRank(right))
      .map(([kind, descriptors]) => ({
        kind,
        title: connectionKindTitle(kind),
        subtitle: connectionKindSubtitle(kind),
        descriptors,
      }));
  }

  private async handleSaveEndpoints(): Promise<void> {
    this.saving = true;
    this.message = 'Saving endpoints...';
    try {
      // Save config first, ensuring user input becomes the source of truth.
      this.endpoints = await saveConnectionEndpoints(this.endpoints);
      this.dispatchEvent(
        new CustomEvent<ConnectionEndpointsConfig>('connections-endpoints-changed', {
          detail: this.endpoints,
          bubbles: true,
          composed: true,
        }),
      );
      try {
        // Newer background uses unified action to trigger reconnect/probe immediately.
        await Promise.all([
          getConnectionsStore().performAction('opencode-http', 'reconnect'),
          getConnectionsStore().performAction('bridge-default-ws', 'reconnect'),
        ]);
      } catch (error) {
        if (!isUnsupportedConnectionsActionError(error)) {
          throw error;
        }

        // Fallback for older background that may not support `connections.action`.
        // Degrades to snapshot refresh without misinterpreting success as failure.
        await getConnectionsStore().refresh();
      }
      this.message = 'Endpoints saved';
    } catch (error) {
      this.message = error instanceof Error ? error.message : String(error);
    } finally {
      this.saving = false;
    }
  }

  private async handleAction(
    descriptorId: string,
    action: 'reconnect' | 'disconnect',
  ): Promise<void> {
    try {
      this.message = action === 'reconnect' ? 'Reconnecting...' : 'Disconnecting...';
      await getConnectionsStore().performAction(descriptorId, action);
      this.message = '';
    } catch (error) {
      this.message = error instanceof Error ? error.message : String(error);
    }
  }

  private buildDiagnosisReport(): string {
    const descriptors = this.connections.descriptors;
    const lines: string[] = [];
    const healthy = descriptors.filter(isHealthyConnection);
    const attention = descriptors.filter(isAttentionConnection);
    const closed = descriptors.filter((descriptor) => descriptor.status === 'closed');
    const defaultBridge = descriptors.find((descriptor) => descriptor.kind === 'bridge-default-ws');
    const defaultBridgeRoute = getWsRouteKey(defaultBridge?.endpoint ?? null);
    const scopedWsMismatches = defaultBridgeRoute
      ? descriptors.filter(
          (descriptor) =>
            descriptor.kind === 'opencode-bridge-ws' &&
            getWsRouteKey(descriptor.endpoint) != null &&
            getWsRouteKey(descriptor.endpoint) !== defaultBridgeRoute,
        )
      : [];

    lines.push('Page Context Bridge connection diagnosis');
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push(`OpenCode Base URL: ${this.endpoints.opencodeBaseUrl}`);
    lines.push(`Bridge Base URL: ${this.endpoints.bridgeBaseUrl}`);
    lines.push(`Bridge Default WS URL: ${this.endpoints.bridgeWsUrl}`);
    lines.push(
      `Summary: ${healthy.length} healthy / ${attention.length} attention / ${closed.length} closed / ${descriptors.length} total`,
    );
    if (scopedWsMismatches.length > 0) {
      lines.push(
        `Warning: ${scopedWsMismatches.length} session-scoped extension WS endpoint(s) do not match the active default bridge route ${defaultBridgeRoute}. Reconnect those sessions after saving Settings so they use the same bridge host/path.`,
      );
    }
    lines.push('');

    if (descriptors.length === 0) {
      lines.push(
        'No connection descriptors are registered yet. Save endpoints or start an OpenCode session first.',
      );
      return lines.join('\n');
    }

    for (const descriptor of descriptors) {
      lines.push(`- [${descriptor.status}] ${descriptor.kind} :: ${descriptor.label}`);
      lines.push(`  id: ${descriptor.id}`);
      lines.push(`  endpoint: ${descriptor.endpoint ?? '-'}`);
      lines.push(`  updatedAt: ${descriptor.updatedAt}`);
      if (descriptor.statusReason) {
        lines.push(`  reason: ${descriptor.statusReason}`);
      }
      if (descriptor.meta && Object.keys(descriptor.meta).length > 0) {
        lines.push(`  meta: ${JSON.stringify(descriptor.meta)}`);
      }
    }

    return lines.join('\n');
  }

  private async handleRunDiagnosis(): Promise<void> {
    this.message = 'Running diagnosis...';
    await getConnectionsStore().refresh();
    this.diagnosisReport = this.buildDiagnosisReport();
    const attentionCount = this.connections.descriptors.filter(isAttentionConnection).length;
    this.message =
      attentionCount > 0 ? `Diagnosis found ${attentionCount} issue(s)` : 'Diagnosis looks healthy';
  }

  private async handleCopyDiagnosis(): Promise<void> {
    const report = this.diagnosisReport || this.buildDiagnosisReport();
    this.diagnosisReport = report;
    try {
      await navigator.clipboard.writeText(report);
      this.message = 'Diagnosis copied';
    } catch (error) {
      this.message = error instanceof Error ? error.message : String(error);
    }
  }

  private getEndpointValidation(value: string, protocols: string[]): string | null {
    try {
      const parsed = new URL(value);
      return protocols.includes(parsed.protocol)
        ? null
        : `Expected protocol: ${protocols.join(' / ')}`;
    } catch {
      return 'Invalid URL format';
    }
  }

  private renderEndpointCard(input: {
    title: string;
    eyebrow: string;
    value: string;
    field: keyof ConnectionEndpointsConfig;
    placeholder: string;
    helper: string;
    check: string;
    protocols: string[];
    descriptor?: ConnectionDescriptor | null;
    emptyStatusLabel?: string;
    actions?: TemplateResult;
  }): TemplateResult {
    const validation = this.getEndpointValidation(input.value, input.protocols);
    const needsAttention = Boolean(input.descriptor && isAttentionConnection(input.descriptor));
    const statusReason = input.descriptor?.statusReason;

    return html`
      <section
        class="rounded-2xl border bg-base-100 p-3 shadow-sm flex flex-col gap-3 min-w-0 ${validation ||
        needsAttention
          ? 'border-error/50'
          : input.descriptor && isHealthyConnection(input.descriptor)
            ? 'border-success/40'
            : 'border-base-300'}"
      >
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="text-[10px] font-bold uppercase tracking-[0.18em] opacity-50">
              ${input.eyebrow}
            </div>
            <h3 class="text-sm font-bold leading-tight">${input.title}</h3>
          </div>
          ${input.descriptor
            ? html`<connection-status-badge
                connection-id=${input.descriptor.id}
              ></connection-status-badge>`
            : html`<span class="badge badge-outline badge-sm"
                >${input.emptyStatusLabel ?? 'Not registered'}</span
              >`}
        </div>

        <label class="form-control flex flex-col gap-1">
          <span class="text-xs font-semibold opacity-70">Endpoint</span>
          <input
            type="text"
            class="input input-sm input-bordered font-mono ${validation ? 'input-error' : ''}"
            .value=${input.value}
            placeholder=${input.placeholder}
            @input=${(event: Event) => {
              this.endpoints = {
                ...this.endpoints,
                [input.field]: (event.target as HTMLInputElement).value,
              };
            }}
          />
        </label>

        <div class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs">
          <span class="opacity-50">Check</span>
          <span class="opacity-70 leading-relaxed">${input.check}</span>
          <span class="opacity-50">Current</span>
          <span
            class="font-mono opacity-80 truncate"
            title=${input.descriptor?.endpoint ?? input.value}
          >
            ${input.descriptor?.endpoint ?? input.value}
          </span>
          ${statusReason
            ? html`
                <span class="opacity-50">Reason</span>
                <span class="opacity-70 break-words">${statusReason}</span>
              `
            : nothing}
          ${validation
            ? html`
                <span class="opacity-50">Input</span>
                <span class="text-error break-words">${validation}</span>
              `
            : nothing}
        </div>

        <p class="text-xs opacity-60 leading-relaxed">${input.helper}</p>
        ${input.actions
          ? html`<div class="flex justify-end gap-2">${input.actions}</div>`
          : nothing}
      </section>
    `;
  }

  private renderJourneyStep(input: {
    index: number;
    title: string;
    body: string;
    descriptor?: ConnectionDescriptor | null;
    complete?: boolean;
  }): TemplateResult {
    const complete =
      input.complete ?? (input.descriptor ? isHealthyConnection(input.descriptor) : false);
    const blocked = input.descriptor ? isAttentionConnection(input.descriptor) : false;
    return html`
      <div class="flex gap-3 rounded-xl bg-base-200/60 px-3 py-2">
        <div
          class="w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0 ${complete
            ? 'bg-success text-success-content'
            : blocked
              ? 'bg-error text-error-content'
              : 'bg-base-300 text-base-content/70'}"
        >
          ${complete ? '✓' : input.index}
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 min-w-0">
            <span class="text-sm font-semibold truncate">${input.title}</span>
            ${input.descriptor
              ? html`<connection-status-badge
                  connection-id=${input.descriptor.id}
                ></connection-status-badge>`
              : nothing}
          </div>
          <p class="text-xs opacity-60 leading-relaxed">${input.body}</p>
        </div>
      </div>
    `;
  }

  private renderRow(descriptor: ConnectionDescriptor): TemplateResult {
    const reconnectEnabled = Boolean(descriptor.capabilities?.reconnect);
    const disconnectEnabled = Boolean(descriptor.capabilities?.disconnect);
    const needsAttention = isAttentionConnection(descriptor);

    return html`
      <div
        class="rounded-xl border bg-base-100 px-3 py-3 shadow-sm flex flex-col gap-2 ${needsAttention
          ? 'border-error/50'
          : 'border-base-300'}"
      >
        <div class="grid grid-cols-[minmax(0,1.35fr)_auto] gap-2 items-start">
          <div class="min-w-0">
            <div class="text-sm font-semibold truncate">${descriptor.label}</div>
            <div class="text-xs opacity-60 truncate" title=${descriptor.id}>${descriptor.id}</div>
          </div>
          <connection-status-badge connection-id=${descriptor.id}></connection-status-badge>
        </div>
        <div class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs">
          <span class="opacity-50">Endpoint</span>
          <span class="font-mono opacity-80 truncate" title=${descriptor.endpoint ?? ''}>
            ${descriptor.endpoint ?? '-'}
          </span>
          <span class="opacity-50">Updated</span>
          <span class="opacity-70">${formatUpdatedAt(descriptor.updatedAt)}</span>
          ${descriptor.statusReason
            ? html`
                <span class="opacity-50">Reason</span>
                <span class="opacity-70 break-words">${descriptor.statusReason}</span>
              `
            : nothing}
        </div>
        <div class="flex items-center justify-end gap-2">
          <button
            class="btn btn-xs btn-outline"
            ?disabled=${!reconnectEnabled}
            title=${reconnectEnabled ? 'Retry this connection' : 'Reconnect is not supported'}
            @click=${() => void this.handleAction(descriptor.id, 'reconnect')}
          >
            Retry
          </button>
          <button
            class="btn btn-xs btn-ghost"
            ?disabled=${!disconnectEnabled}
            title=${disconnectEnabled ? 'Close this connection' : 'Disconnect is not supported'}
            @click=${() => void this.handleAction(descriptor.id, 'disconnect')}
          >
            Close
          </button>
        </div>
      </div>
    `;
  }

  override render() {
    const groups = this.groupDescriptors();
    const descriptors = this.connections.descriptors;
    const healthyCount = descriptors.filter(isHealthyConnection).length;
    const attentionCount = descriptors.filter(isAttentionConnection).length;
    const bridgeDescriptor = descriptors.find(
      (descriptor) => descriptor.kind === 'bridge-default-ws',
    );
    const opencodeHttpDescriptor = descriptors.find(
      (descriptor) => descriptor.kind === 'opencode-http',
    );
    const scopedSessionCount = descriptors.filter(
      (descriptor) => descriptor.kind === 'opencode-bridge-ws',
    ).length;

    return html`
      <div class="tab-content active flex flex-col flex-1 min-h-0">
        <div class="border-b border-base-300 bg-base-200/40 p-3 shrink-0 flex flex-col gap-3">
          <section
            class="rounded-2xl border border-base-300 bg-gradient-to-br from-base-100 to-base-200/80 p-4 shadow-sm"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <p class="text-xs font-bold uppercase tracking-[0.18em] opacity-50">
                  Connection cockpit
                </p>
                <h2 class="text-lg font-bold leading-tight">Connection Cockpit</h2>
                <p class="text-xs opacity-60 mt-1 leading-relaxed">
                  Configure OpenCode and bridge here, and use unified status to check whether page
                  capabilities are actually connected to AI.
                </p>
              </div>
              <div class="stats stats-vertical shadow bg-base-100 border border-base-300 shrink-0">
                <div class="stat py-2 px-3">
                  <div class="stat-title text-[10px]">Healthy</div>
                  <div class="stat-value text-lg text-success">${healthyCount}</div>
                </div>
                <div class="stat py-2 px-3">
                  <div class="stat-title text-[10px]">Attention</div>
                  <div
                    class="stat-value text-lg ${attentionCount > 0 ? 'text-error' : 'opacity-60'}"
                  >
                    ${attentionCount}
                  </div>
                </div>
              </div>
            </div>
            <div class="grid grid-cols-1 gap-2 mt-3 md:grid-cols-2">
              ${this.renderJourneyStep({
                index: 1,
                title: 'Endpoint config',
                body: 'Maintain OpenCode Base, Bridge MCP Base, and Bridge Default WS here; this is the single source of truth for configuration.',
                complete: Boolean(
                  this.endpoints.opencodeBaseUrl &&
                  this.endpoints.bridgeBaseUrl &&
                  this.endpoints.bridgeWsUrl,
                ),
              })}
              ${this.renderJourneyStep({
                index: 2,
                title: 'Bridge control plane',
                body: 'Ensure the extension persistent WS is online, otherwise scoped sessions cannot route tool requests back to the browser.',
                descriptor: bridgeDescriptor,
              })}
              ${this.renderJourneyStep({
                index: 3,
                title: 'OpenCode endpoint',
                body: 'Ensure OpenCode REST is reachable so Connect/New Session can create sessions and register MCP.',
                descriptor: opencodeHttpDescriptor,
              })}
              ${this.renderJourneyStep({
                index: 4,
                title: 'Session MCP links',
                body: `${scopedSessionCount} OpenCode session link${scopedSessionCount === 1 ? '' : 's'}. Each should be independently connected.`,
                complete: scopedSessionCount > 0,
              })}
            </div>
            <div class="mt-3 flex flex-wrap items-center justify-between gap-2">
              <p class="text-xs opacity-60 leading-relaxed">
                When "OpenCode cannot call page tools", run diagnosis first, then copy the report to
                collaborators.
              </p>
              <div class="flex items-center gap-2">
                <button
                  class="btn btn-xs btn-outline"
                  @click=${() => void this.handleRunDiagnosis()}
                >
                  Run diagnosis
                </button>
                <button
                  class="btn btn-xs btn-ghost"
                  @click=${() => void this.handleCopyDiagnosis()}
                >
                  Copy report
                </button>
              </div>
            </div>
            ${this.diagnosisReport
              ? html`
                  <pre
                    class="mt-3 max-h-40 rounded-xl bg-base-300/60 p-3 text-[11px] leading-relaxed whitespace-pre-wrap"
                  >
${this.diagnosisReport}</pre
                  >
                `
              : nothing}
          </section>

          <section class="rounded-2xl border border-base-300 bg-base-100 p-3 shadow-sm">
            <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
              <div class="min-w-0">
                <div class="flex items-center gap-2">
                  <span class="text-xs font-bold uppercase tracking-wide opacity-60"
                    >Endpoint config</span
                  >
                  <span class="badge badge-outline badge-xs">single source of truth</span>
                </div>
                <p class="mt-1 text-xs opacity-60 leading-relaxed">
                  Configuration, status checks, failure reasons, and usage instructions are
                  consolidated in their respective cards; other panels consume these results.
                </p>
              </div>
              ${this.message
                ? html`<span class="text-xs opacity-60" role="status">${this.message}</span>`
                : nothing}
            </div>

            <div class="grid grid-cols-1 gap-3 xl:grid-cols-3">
              ${this.renderEndpointCard({
                eyebrow: 'OpenCode control plane',
                title: 'OpenCode Base URL',
                field: 'opencodeBaseUrl',
                value: this.endpoints.opencodeBaseUrl,
                placeholder: 'http://localhost:4096',
                protocols: ['http:', 'https:'],
                check:
                  'After saving, probes /global/health; Connect/New Session uses this to create sessions and register MCP.',
                helper:
                  'If unreachable, the OpenCode workspace will stall at Resolving session or MCP registration will fail.',
                descriptor: opencodeHttpDescriptor,
                actions: html`
                  <button
                    class="btn btn-xs btn-outline"
                    @click=${() => void this.handleAction('opencode-http', 'reconnect')}
                  >
                    Probe OpenCode
                  </button>
                `,
              })}
              ${this.renderEndpointCard({
                eyebrow: 'Session MCP transport',
                title: 'Bridge Base URL',
                field: 'bridgeBaseUrl',
                value: this.endpoints.bridgeBaseUrl,
                placeholder: 'http://localhost:22334',
                protocols: ['http:', 'https:'],
                check: `OpenCode MCP registration uses ${shortEndpoint(this.endpoints.bridgeBaseUrl)}/{sessionId}/mcp.`,
                helper: `This is the HTTP entry point for OpenCode to access each session's MCP server; it does not handle the persistent browser WS.`,
                emptyStatusLabel: 'Used on registration',
              })}
              ${this.renderEndpointCard({
                eyebrow: 'Browser bridge control link',
                title: 'Bridge Default WS URL',
                field: 'bridgeWsUrl',
                value: this.endpoints.bridgeWsUrl,
                placeholder: 'ws://127.0.0.1:22335/default',
                protocols: ['ws:', 'wss:'],
                check:
                  'The extension background uses this to establish a persistent default WS; when creating/restoring an OpenCode session, the extension automatically derives a session-scoped WS and appends tenantId.',
                helper:
                  'OpenCode itself does not connect to this WS; it only connects to /{sessionId}/mcp under the Bridge Base URL. For remote deployment, fill in the actual bridge WS route, e.g. ws://host:22335/project-path.',
                descriptor: bridgeDescriptor,
                actions: html`
                  <button
                    class="btn btn-xs btn-outline"
                    @click=${() => void this.handleAction('bridge-default-ws', 'reconnect')}
                  >
                    Reconnect WS
                  </button>
                `,
              })}
            </div>

            <div class="mt-3 flex items-center justify-between gap-2 border-t border-base-300 pt-3">
              <p class="text-xs opacity-60 leading-relaxed">
                Save & Probe stores all three endpoints, then immediately checks OpenCode health and
                reconnects Bridge Default WS.
              </p>
              <button
                class="btn btn-sm btn-primary ${this.saving ? 'loading' : ''}"
                ?disabled=${this.saving}
                @click=${() => void this.handleSaveEndpoints()}
              >
                Save & Probe
              </button>
            </div>
          </section>
        </div>

        <div class="flex-1 p-3 flex flex-col gap-4">
          ${groups.length === 0
            ? html`
                <div class="rounded-2xl border border-dashed border-base-300 p-6 text-center">
                  <div class="text-sm font-semibold">No session/page runtime snapshots yet</div>
                  <p class="text-xs opacity-60 mt-1">
                    Endpoint status is shown in the cards above; after clicking Connect in OpenCode,
                    session and page capability links will appear here.
                  </p>
                </div>
              `
            : repeat(
                groups,
                (group) => group.kind,
                (group) => html`
                  <section class="flex flex-col gap-2">
                    <div class="flex items-start justify-between gap-2">
                      <div>
                        <h3 class="text-xs font-bold uppercase tracking-wide opacity-60">
                          ${group.title}
                        </h3>
                        ${group.subtitle
                          ? html`<p class="text-xs opacity-50 leading-relaxed">
                              ${group.subtitle}
                            </p>`
                          : nothing}
                      </div>
                      <span class="badge badge-ghost badge-xs">${group.descriptors.length}</span>
                    </div>
                    <div class="grid grid-cols-1 gap-2 xl:grid-cols-2">
                      ${group.descriptors.map((descriptor) => this.renderRow(descriptor))}
                    </div>
                  </section>
                `,
              )}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'connections-panel': ConnectionsPanel;
  }
}
