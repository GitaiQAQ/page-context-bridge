/**
 * OpenCode HTTP 探活 driver。
 *
 * 设计选择：
 * - 默认后台 30s 周期探活，Connections tab 不开也能看到真实状态
 * - UI 的 Reconnect 动作会触发一次立即探活，避免改完 endpoint 还要等下个周期
 */

import { getConnectionRegistry } from './bg-connection-registry';
import { loadConnectionEndpoints } from './connections-endpoints';

export const OPENCODE_HTTP_DESCRIPTOR_ID = 'opencode-http';

const OPENCODE_HTTP_POLL_INTERVAL_MS = 30_000;

function buildHealthUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/global/health`;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

async function upsertOpencodeHttpDescriptor(
  status: 'reachable' | 'unreachable',
  statusReason?: string | null,
): Promise<void> {
  const registry = getConnectionRegistry();
  const endpoints = await loadConnectionEndpoints();
  const endpoint = buildHealthUrl(endpoints.opencodeBaseUrl);
  const current = registry.get(OPENCODE_HTTP_DESCRIPTOR_ID);

  if (current) {
    registry.update(OPENCODE_HTTP_DESCRIPTOR_ID, {
      endpoint,
      status,
      statusReason: statusReason ?? null,
      capabilities: {
        reconnect: true,
        disconnect: false,
      },
      meta: {
        opencodeBaseUrl: endpoints.opencodeBaseUrl,
      },
    });
    return;
  }

  registry.register({
    id: OPENCODE_HTTP_DESCRIPTOR_ID,
    kind: 'opencode-http',
    label: 'OpenCode HTTP Health',
    endpoint,
    status,
    statusReason: statusReason ?? null,
    capabilities: {
      reconnect: true,
      disconnect: false,
    },
    meta: {
      opencodeBaseUrl: endpoints.opencodeBaseUrl,
    },
  });
}

export function createOpencodeHttpConnectionDriver() {
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const probe = async (): Promise<void> => {
    const endpoints = await loadConnectionEndpoints();
    const healthUrl = buildHealthUrl(endpoints.opencodeBaseUrl);

    try {
      const response = await fetch(healthUrl, { method: 'GET' });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      await upsertOpencodeHttpDescriptor('reachable', 'health-ok');
    } catch (error) {
      await upsertOpencodeHttpDescriptor(
        'unreachable',
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  return {
    async start(): Promise<void> {
      await upsertOpencodeHttpDescriptor('unreachable', 'probing');
      await probe();
      if (pollTimer) {
        return;
      }
      pollTimer = setInterval(() => {
        void probe();
      }, OPENCODE_HTTP_POLL_INTERVAL_MS);
    },

    async probeNow(): Promise<void> {
      await probe();
    },
  };
}
