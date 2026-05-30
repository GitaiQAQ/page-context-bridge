import { type ConnectionDescriptor, type ConnectionKind } from '@page-context/shared-protocol';
import { LitElement, html, nothing } from 'lit';
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

@customElement('connections-panel')
export class ConnectionsPanel extends LitElement {
  protected override createRenderRoot(): this {
    return this;
  }

  private readonly connections = new ConnectionsController(this);

  @state() private endpoints: ConnectionEndpointsConfig = {
    opencodeBaseUrl: 'http://localhost:4096',
    bridgeBaseUrl: 'http://localhost:22334',
  };
  @state() private saving = false;
  @state() private message = '';

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
    descriptors: ConnectionDescriptor[];
  }> {
    const groups = new Map<ConnectionKind, ConnectionDescriptor[]>();
    for (const descriptor of this.connections.descriptors) {
      const current = groups.get(descriptor.kind) ?? [];
      current.push(descriptor);
      groups.set(descriptor.kind, current);
    }

    return Array.from(groups.entries()).map(([kind, descriptors]) => ({
      kind,
      title: connectionKindTitle(kind),
      descriptors,
    }));
  }

  private async handleSaveEndpoints(): Promise<void> {
    this.saving = true;
    this.message = 'Saving endpoints...';
    try {
      // 先保存配置，确保用户输入先成为真相源。
      this.endpoints = await saveConnectionEndpoints(this.endpoints);
      this.dispatchEvent(
        new CustomEvent<ConnectionEndpointsConfig>('connections-endpoints-changed', {
          detail: this.endpoints,
          bubbles: true,
          composed: true,
        }),
      );
      try {
        // 新版 background 走统一 action，立刻触发重连/探活。
        await getConnectionsStore().performAction('opencode-http', 'reconnect');
      } catch (error) {
        if (!isUnsupportedConnectionsActionError(error)) {
          throw error;
        }

        // 兼容旧 background：它可能还没实现 `connections.action`。
        // 这里退化成刷新快照，但不把“保存成功”误判成失败。
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

  private renderRow(descriptor: ConnectionDescriptor) {
    const reconnectEnabled = Boolean(descriptor.capabilities?.reconnect);
    const disconnectEnabled = Boolean(descriptor.capabilities?.disconnect);

    return html`
      <div
        class="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1.8fr)_auto_auto_auto] gap-2 items-center rounded-lg border border-base-300 bg-base-100 px-3 py-2"
      >
        <div class="min-w-0">
          <div class="text-sm font-semibold truncate">${descriptor.label}</div>
          <div class="text-xs opacity-60 truncate" title=${descriptor.id}>${descriptor.id}</div>
        </div>
        <div class="text-xs font-mono opacity-70 truncate" title=${descriptor.endpoint ?? ''}>
          ${descriptor.endpoint ?? '-'}
        </div>
        <connection-status-badge connection-id=${descriptor.id}></connection-status-badge>
        <button
          class="btn btn-xs btn-outline"
          ?disabled=${!reconnectEnabled}
          @click=${() => void this.handleAction(descriptor.id, 'reconnect')}
        >
          Reconnect
        </button>
        <button
          class="btn btn-xs btn-outline"
          ?disabled=${!disconnectEnabled}
          @click=${() => void this.handleAction(descriptor.id, 'disconnect')}
        >
          Disconnect
        </button>
      </div>
    `;
  }

  override render() {
    const groups = this.groupDescriptors();

    return html`
      <div class="tab-content active flex flex-col flex-1 min-h-0">
        <div class="border-b border-base-300 bg-base-100 p-3 shrink-0">
          <div class="flex items-center gap-2 mb-2">
            <span class="text-xs font-bold uppercase tracking-wide opacity-60">Endpoints</span>
            ${this.message
              ? html`<span class="text-xs opacity-60">${this.message}</span>`
              : nothing}
          </div>
          <div class="grid grid-cols-1 gap-2 md:grid-cols-2">
            <label class="form-control flex flex-col gap-1">
              <span class="text-xs font-semibold opacity-70">OpenCode Base URL</span>
              <input
                type="text"
                class="input input-sm input-bordered font-mono"
                .value=${this.endpoints.opencodeBaseUrl}
                @input=${(event: Event) => {
                  this.endpoints = {
                    ...this.endpoints,
                    opencodeBaseUrl: (event.target as HTMLInputElement).value,
                  };
                }}
              />
            </label>
            <label class="form-control flex flex-col gap-1">
              <span class="text-xs font-semibold opacity-70">Bridge Base URL</span>
              <input
                type="text"
                class="input input-sm input-bordered font-mono"
                .value=${this.endpoints.bridgeBaseUrl}
                @input=${(event: Event) => {
                  this.endpoints = {
                    ...this.endpoints,
                    bridgeBaseUrl: (event.target as HTMLInputElement).value,
                  };
                }}
              />
            </label>
          </div>
          <div class="mt-2">
            <button
              class="btn btn-sm btn-primary ${this.saving ? 'loading' : ''}"
              ?disabled=${this.saving}
              @click=${() => void this.handleSaveEndpoints()}
            >
              Save Endpoints
            </button>
          </div>
        </div>

        <div class="flex-1 overflow-y-auto p-3 flex flex-col gap-4">
          ${groups.length === 0
            ? html`<div class="text-sm opacity-60">No connections registered.</div>`
            : repeat(
                groups,
                (group) => group.kind,
                (group) => html`
                  <section class="flex flex-col gap-2">
                    <div class="flex items-center gap-2">
                      <h3 class="text-xs font-bold uppercase tracking-wide opacity-60">
                        ${group.title}
                      </h3>
                      <span class="badge badge-ghost badge-xs">${group.descriptors.length}</span>
                    </div>
                    <div class="flex flex-col gap-2">
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
