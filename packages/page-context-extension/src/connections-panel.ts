import { type ConnectionDescriptor, type ConnectionKind } from '@page-context/shared-protocol';
import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

import { ConnectionsController, getConnectionsStore } from './connections-controller';
import {
  DEFAULT_CONNECTION_ENDPOINTS,
  loadConnectionEndpoints,
  saveConnectionEndpoints,
  type ConnectionEndpointsConfig,
} from './connections-endpoints';
import { t } from './i18n';

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
      return t('pageTools');
    case 'main-world-host':
      return t('mainWorldHost');
    case 'agentation-main-world-host':
      return t('agentationMainWorldHost');
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
    const exampleValue = DEFAULT_CONNECTION_ENDPOINTS[input.field];

    return html`
      <section
        class="flex flex-col gap-2 p-3 min-w-0 ${validation || needsAttention
          ? 'bg-error/5'
          : input.descriptor && isHealthyConnection(input.descriptor)
            ? 'bg-success/5'
            : ''}"
      >
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="text-[10px] font-bold uppercase tracking-[0.18em] opacity-45">
              ${input.eyebrow}
            </div>
            <h3 class="text-sm font-bold leading-tight">${input.title}</h3>
          </div>
          <span class="text-[11px] opacity-50 whitespace-nowrap">
            ${input.descriptor?.status ?? input.emptyStatusLabel ?? t('notRegistered')}
          </span>
        </div>

        <label class="form-control flex flex-col gap-1">
          <span class="text-xs font-semibold opacity-70">${t('endpoint')}</span>
          <div class="join w-full">
            <input
              type="text"
              class="input input-sm input-bordered join-item min-w-0 flex-1 font-mono ${validation
                ? 'input-error'
                : ''}"
              .value=${input.value}
              placeholder=${input.placeholder}
              title=${input.helper}
              @input=${(event: Event) => {
                this.endpoints = {
                  ...this.endpoints,
                  [input.field]: (event.target as HTMLInputElement).value,
                };
              }}
            />
            <button
              type="button"
              class="btn btn-sm join-item border-base-300 bg-base-200 px-2 font-mono text-[10px] normal-case"
              title=${`${t('example')}: ${exampleValue}`}
              @click=${() => {
                this.endpoints = { ...this.endpoints, [input.field]: exampleValue };
              }}
            >
              ${t('useExample')}
            </button>
          </div>
          <div class="flex items-center gap-1 text-[10px] leading-relaxed opacity-60">
            <span class="font-semibold uppercase tracking-wide">${t('example')}</span>
            <code class="truncate rounded-sm bg-base-200 px-1.5 py-0.5 font-mono"
              >${exampleValue}</code
            >
          </div>
        </label>

        <div class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 text-[11px]">
          <span class="opacity-50">${t('check')}</span>
          <span class="opacity-70 leading-relaxed">${input.check}</span>
          <span class="opacity-50">${t('current')}</span>
          <span
            class="font-mono opacity-80 truncate"
            title=${input.descriptor?.endpoint ?? input.value}
          >
            ${input.descriptor?.endpoint ?? input.value}
          </span>
          ${statusReason
            ? html`
                <span class="opacity-50">${t('reason')}</span>
                <span class="opacity-70 break-words">${statusReason}</span>
              `
            : nothing}
          ${validation
            ? html`
                <span class="opacity-50">${t('input')}</span>
                <span class="text-error break-words">${validation}</span>
              `
            : nothing}
        </div>

        <p class="text-[11px] opacity-60 leading-relaxed" title=${input.helper}>${input.helper}</p>
        ${input.actions
          ? html`<div class="flex justify-end gap-2 text-xs">${input.actions}</div>`
          : nothing}
      </section>
    `;
  }

  private renderRow(descriptor: ConnectionDescriptor): TemplateResult {
    const reconnectEnabled = Boolean(descriptor.capabilities?.reconnect);
    const disconnectEnabled = Boolean(descriptor.capabilities?.disconnect);
    const needsAttention = isAttentionConnection(descriptor);

    return html`
      <div
        class="rounded-md border bg-base-100 px-3 py-3 shadow-sm flex flex-col gap-2 ${needsAttention
          ? 'border-error/50'
          : 'border-base-300'}"
      >
        <div class="grid grid-cols-[minmax(0,1.35fr)_auto] gap-2 items-start">
          <div class="min-w-0">
            <div class="text-sm font-semibold truncate">${descriptor.label}</div>
            <div class="text-xs opacity-60 truncate" title=${descriptor.id}>${descriptor.id}</div>
          </div>
          <span class="text-[11px] opacity-50">${descriptor.status}</span>
        </div>
        <div class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs">
          <span class="opacity-50">${t('endpoint')}</span>
          <span class="font-mono opacity-80 truncate" title=${descriptor.endpoint ?? ''}>
            ${descriptor.endpoint ?? '-'}
          </span>
          <span class="opacity-50">${t('updated')}</span>
          <span class="opacity-70">${formatUpdatedAt(descriptor.updatedAt)}</span>
          ${descriptor.statusReason
            ? html`
                <span class="opacity-50">${t('reason')}</span>
                <span class="opacity-70 break-words">${descriptor.statusReason}</span>
              `
            : nothing}
        </div>
        <div class="flex items-center justify-end gap-2">
          <button
            class="btn btn-xs btn-ghost h-6 min-h-0 px-2"
            ?disabled=${!reconnectEnabled}
            title=${reconnectEnabled ? t('retry') : t('disconnectNotSupported')}
            @click=${() => void this.handleAction(descriptor.id, 'reconnect')}
          >
            ${t('retry')}
          </button>
          <button
            class="btn btn-xs btn-ghost h-6 min-h-0 px-2"
            ?disabled=${!disconnectEnabled}
            title=${disconnectEnabled ? t('closeConnection') : t('disconnectNotSupported')}
            @click=${() => void this.handleAction(descriptor.id, 'disconnect')}
          >
            ${t('close')}
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
    const configured = Boolean(
      this.endpoints.opencodeBaseUrl && this.endpoints.bridgeBaseUrl && this.endpoints.bridgeWsUrl,
    );
    const readinessTitle =
      attentionCount > 0
        ? t('needsAttention')
        : configured
          ? t('readyToConnect')
          : t('configurationIncomplete');
    const readinessBody =
      attentionCount > 0
        ? t('needAttentionBody')
        : configured
          ? t('endpointsReadyBody')
          : t('needEndpointsBody');

    return html`
      <div class="tab-content active flex flex-col flex-1 min-h-0">
        <div class="border-b border-base-300 bg-base-200/40 p-3 shrink-0 flex flex-col gap-2">
          <section class="rounded-lg border border-base-300 bg-base-100 px-3 py-2.5 shadow-sm">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div class="flex min-w-0 items-center gap-2">
                <div class="min-w-0">
                  <div class="text-[10px] font-bold uppercase tracking-[0.16em] opacity-50">
                    ${t('setupTroubleshooting')}
                  </div>
                  <div class="truncate text-sm font-bold">${readinessTitle}</div>
                  <div class="truncate text-[11px] opacity-60" title=${readinessBody}>
                    ${readinessBody}
                  </div>
                </div>
              </div>
              <div class="flex items-center gap-1.5 text-xs">
                <span class="text-[11px] opacity-55 tabular-nums"
                  >${attentionCount > 0 ? t('blocked') : configured ? t('ready') : t('setup')} ·
                  ${healthyCount} ${t('healthyCount')} · ${attentionCount}
                  ${t('attentionCount')}</span
                >
                <button
                  class="tooltip tooltip-bottom btn btn-xs btn-ghost h-6 min-h-0 px-2"
                  data-tip="Refresh all descriptors and generate a copyable diagnosis report"
                  title="Refresh all descriptors and generate a copyable diagnosis report"
                  @click=${() => void this.handleRunDiagnosis()}
                >
                  ${t('diagnose')}
                </button>
                <button
                  class="tooltip tooltip-bottom btn btn-xs btn-ghost h-6 min-h-0 px-2"
                  data-tip="Copy the latest diagnosis report for issue reports or teammates"
                  title="Copy the latest diagnosis report for issue reports or teammates"
                  @click=${() => void this.handleCopyDiagnosis()}
                >
                  ${t('copy')}
                </button>
              </div>
            </div>
            ${this.diagnosisReport
              ? html`
                  <pre
                    class="mt-3 max-h-40 max-w-full overflow-auto rounded-md bg-base-300/60 p-3 text-[11px] leading-relaxed whitespace-pre-wrap break-words"
                  >
${this.diagnosisReport}</pre
                  >
                `
              : nothing}
          </section>

          <details
            class="rounded-md border border-base-300 bg-base-100 px-3 py-2 shadow-sm"
            ?open=${attentionCount > 0 || !configured}
          >
            <summary class="cursor-pointer select-none list-none">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="min-w-0">
                  <div class="flex items-center gap-2">
                    <span class="text-xs font-bold uppercase tracking-wide opacity-60"
                      >${t('endpointConfiguration')}</span
                    >
                  </div>
                  <p class="mt-1 text-xs opacity-60 leading-relaxed">
                    Edit endpoints only when local ports or remote bridge routes change.
                  </p>
                </div>
                <div class="flex items-center gap-2">
                  ${this.message
                    ? html`<span class="text-xs opacity-60" role="status">${this.message}</span>`
                    : nothing}
                  <span
                    class="details-chevron inline-flex h-6 w-6 items-center justify-center rounded-sm border border-base-300 bg-base-200 transition-transform duration-150"
                    aria-hidden="true"
                  >
                    <svg
                      class="h-3.5 w-3.5"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2.5"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </span>
                </div>
              </div>
            </summary>

            <div class="mt-3 flex flex-wrap items-center justify-between gap-2 mb-3">
              <div class="min-w-0">
                <p class="mt-1 text-xs opacity-60 leading-relaxed">
                  Edit only what changed. Status, failure reasons, and retry actions stay attached
                  to each endpoint.
                </p>
              </div>
            </div>

            <div
              class="rounded-md border border-base-300 bg-base-100 divide-y divide-base-200 overflow-hidden"
            >
              ${this.renderEndpointCard({
                eyebrow: 'OpenCode control plane',
                title: t('openCodeBaseUrl'),
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
                    class="btn btn-xs btn-ghost h-6 min-h-0 px-2"
                    @click=${() => void this.handleAction('opencode-http', 'reconnect')}
                  >
                    ${t('probeOpencode')}
                  </button>
                `,
              })}
              ${this.renderEndpointCard({
                eyebrow: 'Session MCP transport',
                title: t('bridgeBaseUrl'),
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
                title: t('bridgeDefaultWsUrl'),
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
                    class="btn btn-xs btn-ghost h-6 min-h-0 px-2"
                    @click=${() => void this.handleAction('bridge-default-ws', 'reconnect')}
                  >
                    ${t('reconnectWs')}
                  </button>
                `,
              })}
            </div>

            <div class="mt-3 flex items-center justify-between gap-2 border-t border-base-300 pt-3">
              <p class="text-xs opacity-60 leading-relaxed">${t('saveProbeHint')}</p>
              <button
                class="tooltip tooltip-bottom btn btn-sm btn-primary ${this.saving
                  ? 'loading'
                  : ''}"
                data-tip="Save endpoint values, probe OpenCode health, and reconnect the bridge WebSocket"
                title="Save endpoint values, probe OpenCode health, and reconnect the bridge WebSocket"
                ?disabled=${this.saving}
                @click=${() => void this.handleSaveEndpoints()}
              >
                ${t('saveProbe')}
              </button>
            </div>
          </details>
        </div>

        <div class="flex-1 p-3 flex flex-col gap-4">
          ${groups.length === 0
            ? html`
                <div class="rounded-lg border border-dashed border-base-300 p-6 text-center">
                  <div class="text-sm font-semibold">${t('noRuntimeSnapshots')}</div>
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
                      <span class="text-[11px] opacity-50">${group.descriptors.length}</span>
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
