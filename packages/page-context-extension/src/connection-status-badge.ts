import { LitElement, html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { ConnectionsController } from './connections-controller';

function connectionStatusLabel(status?: string): string {
  switch (status) {
    case 'connected':
      return 'Connected';
    case 'connecting':
      return 'Connecting';
    case 'reachable':
      return 'Reachable';
    case 'unreachable':
      return 'Unreachable';
    case 'error':
      return 'Error';
    case 'closed':
      return 'Closed';
    default:
      return 'Unknown';
  }
}

function connectionStatusBadgeClass(status?: string): string {
  switch (status) {
    case 'connected':
    case 'reachable':
      return 'badge badge-success badge-sm';
    case 'connecting':
      return 'badge badge-warning badge-sm';
    case 'error':
    case 'unreachable':
      return 'badge badge-error badge-sm';
    case 'closed':
      return 'badge badge-ghost badge-sm';
    default:
      return 'badge badge-outline badge-sm';
  }
}

@customElement('connection-status-badge')
export class ConnectionStatusBadge extends LitElement {
  /**
   * Do not create a shadow root; reuse Tailwind / DaisyUI styles already injected by the sidepanel.
   */
  protected override createRenderRoot(): this {
    return this;
  }

  @property({ type: String, attribute: 'connection-id' })
  accessor connectionId = '';

  private readonly connections = new ConnectionsController(this);

  override render() {
    if (!this.connectionId) {
      return nothing;
    }

    const descriptor = this.connections.getDescriptor(this.connectionId);
    const label = connectionStatusLabel(descriptor?.status);
    const reason = descriptor?.statusReason?.trim();
    return html`
      <span
        class=${connectionStatusBadgeClass(descriptor?.status)}
        title=${reason ? `${label} · ${reason}` : label}
      >
        ${label}
      </span>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'connection-status-badge': ConnectionStatusBadge;
  }
}
