import type {
  ContextNamespaceDescriptor,
  ContextResourceDescriptor,
  ContextResourcePayload,
  ContextSkillDescriptor,
  ContextSkillPrompt,
  PageContextManifest,
  ToolSpec,
} from "@page-context/shared-protocol";

export type ToolInput = Record<string, unknown>;

export interface PageToolInstance {
  instanceId: string;
  listTools(): ToolSpec[];
  callTool(name: string, input?: ToolInput): unknown;
}

export interface PageToolNamespace {
  namespace: string;
  listInstances(): string[];
  getInstance(instanceId: string): PageToolInstance | undefined;
}

export interface PageContextBridgeLike {
  version: string;
  listNamespaces(): string[];
  getNamespace(namespace: string): PageToolNamespace | undefined;
  getScene(): string;
  listResources(): ContextResourceDescriptor[];
  readResource(id: string): ContextResourcePayload;
  listSkills(): ContextSkillDescriptor[];
  getSkill(id: string, input?: ToolInput): ContextSkillPrompt | undefined;
  getManifest(): PageContextManifest;
}

export interface PageContextBridgeHostSource {
  sourceId: string;
  bridge: PageContextBridgeLike;
  priority: number;
  tags: string[];
  registeredAt: string;
}

export interface PageContextBridgeHost {
  version: string;
  bridge: PageContextBridgeLike;
  registerSource(input: {
    sourceId: string;
    bridge: PageContextBridgeLike;
    priority?: number;
    tags?: string[];
  }): () => void;
  unregisterSource(sourceId: string): void;
  listSources(): PageContextBridgeHostSource[];
  listDiagnostics(): string[];
}

export interface UserscriptBridgeAdapter {
  adapterId: string;
  namespace: ContextNamespaceDescriptor;
  listInstances(): PageToolInstance[];
  listResources(): ContextResourceDescriptor[];
  readResource(id: string): ContextResourcePayload;
  listSkills(): ContextSkillDescriptor[];
  getSkill(id: string, input?: ToolInput): ContextSkillPrompt | undefined;
  getSceneHint?(): string | undefined;
}

export type UserscriptBridgeAdapterFactory = (win: Window, doc: Document) => UserscriptBridgeAdapter;
