/**
 * Context manifest types and bridge method constants.
 */

import { FEEDBACK_METHODS } from "./feedback";

export const BRIDGE_METHODS = {
  sessionRegister: "session.register",
  sessionHeartbeat: "session.heartbeat",
  bridgeToolCall: "bridge.tool.call",
  bridgeToolsList: "bridge.tools.list",
  bridgeTabsList: "bridge.tabs.list",
  bridgePageEvent: "bridge.page.event",
  bridgePageToolsRegistered: "bridge.pageTools.registered",
  bridgePageToolsUnregistered: "bridge.pageTools.unregistered",
  bridgeBuiltinToolsUpdated: "bridge.builtinTools.updated",
  bridgeTabActivated: "bridge.tab.activated",
  bridgeTabUpdated: "bridge.tab.updated",
  extensionStatusGet: "extension.status.get",
  extensionReconnect: "extension.session.reconnect",
  extensionPageToolsGet: "extension.pageTools.get",
  extensionPageToolsTreeGet: "extension.pageTools.tree.get",
  extensionPageToolsDiscover: "extension.pageTools.discover",
  extensionPageToolsSetEnabled: "extension.pageTools.setEnabled",
  extensionContextManifestGet: "extension.context.manifest.get",
  extensionContextResourceRead: "extension.context.resource.read",
  extensionContextSkillGet: "extension.context.skill.get",
  extensionToolDebugCall: "extension.tool.debug.call",
  extensionToolExecute: "extension.tool.execute",
  extensionMainWorldHostEnsure: "extension.mainWorld.host.ensure",
  extensionPageEvent: "extension.page.event",
  extensionPageToolsRegister: "extension.pageTools.register",
  ...FEEDBACK_METHODS,
} as const;

export interface ContextNamespaceDescriptor {
  namespace: string;
  title: string;
  description?: string;
  tags?: string[];
}

export interface ContextResourceDescriptor {
  id: string;
  namespace: string;
  title: string;
  description?: string;
  mimeType?: string;
  kind?: "json" | "text";
  tags?: string[];
}

export interface ContextResourcePayload {
  id: string;
  mimeType?: string;
  text: string;
}

export interface ContextSkillDescriptor {
  id: string;
  namespace: string;
  title: string;
  description: string;
  intentTags?: string[];
  resourceIds?: string[];
  toolNames?: string[];
  mode?: "analysis" | "readonly" | "mutation" | "macro";
}

export interface ContextSkillPrompt {
  skill: ContextSkillDescriptor;
  text: string;
}

export interface PageContextManifest {
  version: string;
  app: string;
  route: string;
  scene: string;
  namespaces: ContextNamespaceDescriptor[];
  resources: ContextResourceDescriptor[];
  skills: ContextSkillDescriptor[];
  generatedAt: string;
}
