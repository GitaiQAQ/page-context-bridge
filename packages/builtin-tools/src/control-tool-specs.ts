/**
 * Collect bridge control tool specifications by reusing provider register logic.
 *
 * This allows extension-side visibility/tree model to stay consistent with the provider,
 * avoiding the need to maintain redundant constants.
 */

import {
  ExtensionControlBridgeProvider,
  type ExtensionControlBridgeRpc,
} from './extension-control-bridge-provider.js';
import {
  FeedbackControlBridgeProvider,
  type FeedbackControlBridgeRpc,
} from './feedback-control-bridge-provider.js';

export interface BridgeControlToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  // Use explicit marking to distinguish bridge control tools, avoiding impact on normal builtin start/stop semantics.
  _bridgeControlTool: true;
}

export function collectBridgeControlToolSpecs(): BridgeControlToolSpec[] {
  const specsByName = new Map<string, BridgeControlToolSpec>();
  collectFromExtensionControlProvider(specsByName);
  collectFromFeedbackControlProvider(specsByName);
  return Array.from(specsByName.values()).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

function collectFromExtensionControlProvider(
  specsByName: Map<string, BridgeControlToolSpec>,
): void {
  const provider = new ExtensionControlBridgeProvider();
  const noopRpc = createNoopRpc<ExtensionControlBridgeRpc>();

  provider.registerOnBridge((name, schema) => {
    addControlToolSpec(specsByName, name, schema);
    return { remove: () => undefined };
  }, noopRpc);
}

function collectFromFeedbackControlProvider(specsByName: Map<string, BridgeControlToolSpec>): void {
  const provider = new FeedbackControlBridgeProvider();
  const noopRpc = createNoopRpc<FeedbackControlBridgeRpc>();

  provider.registerOnBridge((name, schema) => {
    addControlToolSpec(specsByName, name, schema);
    return { remove: () => undefined };
  }, noopRpc);
}

function addControlToolSpec(
  specsByName: Map<string, BridgeControlToolSpec>,
  name: string,
  schema: {
    description: string;
    inputSchema: Record<string, unknown>;
    annotations?: Record<string, unknown>;
  },
): void {
  // Only converge canonical namespace names to avoid duplicate legacy alias items in sidepanel/tool-tree.
  if (!name.includes('.')) {
    return;
  }
  if (specsByName.has(name)) {
    return;
  }

  specsByName.set(name, {
    name,
    description: schema.description,
    inputSchema: schema.inputSchema,
    annotations: schema.annotations,
    _bridgeControlTool: true,
  });
}

function createNoopRpc<TRpc>(): TRpc {
  return new Proxy(
    {},
    {
      get: () => async () => ({}),
    },
  ) as TRpc;
}
