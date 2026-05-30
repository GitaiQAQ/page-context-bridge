/**
 * Page bridge call entrypoint.
 * This file keeps only protocol-level functions; backend owns the MAIN world access details.
 */

import {
  type ContextResourcePayload,
  type ContextSkillPrompt,
  type PageContextManifest,
} from '@page-context/shared-protocol';

import type { PageToolEntry } from '@page-context/tool-visibility';
import { selectedPageAccessBackend } from './bg-page-access-backend';

type JsonRecord = Record<string, unknown>;
const pageAccessBackend = selectedPageAccessBackend.backend;
/**
 * Expose probe results for observation/tests so Firefox paths are not mistaken for Chromium again.
 */
export const pageAccessBackendKind = selectedPageAccessBackend.kind;

export interface BuiltinToolResult {
  [key: string]: unknown;
}

export interface PageToolExecutionResult {
  ok: boolean;
  result?: BuiltinToolResult;
  error?: string;
}

export async function getRawPageContextManifest(
  tabId: number,
): Promise<PageContextManifest | null> {
  return await pageAccessBackend.getRawManifest(tabId);
}

export async function readPageContextResource(
  tabId: number,
  resourceId: string,
): Promise<ContextResourcePayload> {
  return await pageAccessBackend.readResource(tabId, resourceId);
}

export async function getPageContextSkill(
  tabId: number,
  skillId: string,
  input?: JsonRecord,
): Promise<ContextSkillPrompt | null> {
  return await pageAccessBackend.getSkill(tabId, skillId, input);
}

export async function discoverPageToolsInTab(tabId: number): Promise<PageToolEntry[]> {
  await pageAccessBackend.ensureBridgeHost(tabId);
  return await pageAccessBackend.discoverTools(tabId);
}

export async function executePageToolInTab(
  tabId: number,
  pageToolName: string,
  args: JsonRecord,
  namespace: string,
  instanceId?: string,
): Promise<PageToolExecutionResult> {
  return (await pageAccessBackend.executePageTool(
    tabId,
    pageToolName,
    args,
    namespace,
    instanceId,
  )) as PageToolExecutionResult;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
