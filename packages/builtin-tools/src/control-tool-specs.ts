/**
 * 通过复用 provider 的 register 逻辑收集 bridge control tool 规格。
 *
 * 这样 extension 侧的可见性/树模型可以直接和 provider 保持一致，
 * 不需要再维护一份重复常量。
 */

import {
  ExtensionControlBridgeProvider,
  type ExtensionControlBridgeRpc,
} from "./extension-control-bridge-provider.js";
import {
  FeedbackControlBridgeProvider,
  type FeedbackControlBridgeRpc,
} from "./feedback-control-bridge-provider.js";

export interface BridgeControlToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  // 用显式标记区分 bridge 控制工具，避免影响普通 builtin 的启停语义。
  _bridgeControlTool: true;
}

export function collectBridgeControlToolSpecs(): BridgeControlToolSpec[] {
  const specsByName = new Map<string, BridgeControlToolSpec>();
  collectFromExtensionControlProvider(specsByName);
  collectFromFeedbackControlProvider(specsByName);
  return Array.from(specsByName.values()).sort((left, right) => left.name.localeCompare(right.name));
}

function collectFromExtensionControlProvider(specsByName: Map<string, BridgeControlToolSpec>): void {
  const provider = new ExtensionControlBridgeProvider({ includeLegacyAliases: false });
  const noopRpc = createNoopRpc<ExtensionControlBridgeRpc>();

  provider.registerOnBridge(
    (name, schema) => {
      addControlToolSpec(specsByName, name, schema);
      return { remove: () => undefined };
    },
    noopRpc,
  );
}

function collectFromFeedbackControlProvider(specsByName: Map<string, BridgeControlToolSpec>): void {
  const provider = new FeedbackControlBridgeProvider({ includeLegacyAliases: false });
  const noopRpc = createNoopRpc<FeedbackControlBridgeRpc>();

  provider.registerOnBridge(
    (name, schema) => {
      addControlToolSpec(specsByName, name, schema);
      return { remove: () => undefined };
    },
    noopRpc,
  );
}

function addControlToolSpec(
  specsByName: Map<string, BridgeControlToolSpec>,
  name: string,
  schema: { description: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> },
): void {
  // Only include canonical namespace names to avoid duplicate legacy aliases in sidepanel/tool-tree.
  if (!name.includes(".")) {
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
  return new Proxy({}, {
    get: () => async () => ({}),
  }) as TRpc;
}
