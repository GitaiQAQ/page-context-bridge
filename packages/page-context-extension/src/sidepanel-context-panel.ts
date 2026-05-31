/**
 * Context manifest panel rendering module.
 * Provides pure render functions for namespace/resource/skill cards and diff panels.
 */

import { html, nothing, type TemplateResult } from 'lit';

import type {
  ContextNamespaceDescriptor,
  ContextResourceDescriptor,
  ContextSkillDescriptor,
  PageContextManifest,
} from '@page-context/shared-protocol';
import type {
  ContextFilterDebugItem,
  ContextManifestFilterDebug,
  ContextSkillToolTrimDebug,
} from './context-manifest-filter-debug';

import { buildContextManifestDiff } from './context-manifest-diff';
export { buildContextManifestDiff } from './context-manifest-diff';
import { formatJson } from './sidepanel-tree-renderer';

/**
 * Render the full context manifest panel (legacy inline template kept for compatibility).
 * The main entry has moved to renderContextTab(); this function remains only for fallback/tests.
 */
export function renderContextManifestPanel(
  rawManifest: PageContextManifest,
  effectiveManifest: PageContextManifest,
  tabId: number,
): TemplateResult {
  return html`
    <div class="context-app-value">${effectiveManifest.app}</div>
    <div class="context-scene-value">${effectiveManifest.scene}</div>
    <div class="context-tab-value">${tabId}</div>
    <div class="context-route-value">${effectiveManifest.route || '/'}</div>
    <div class="context-resources-list">
      ${effectiveManifest.resources.length > 0
        ? effectiveManifest.resources.map((resource) => renderContextResourceCard(resource))
        : html`<div class="flex flex-col items-center justify-center p-4 text-base-content/40">
            <p class="text-xs">This page does not expose any readable data yet.</p>
          </div>`}
    </div>
    <div class="context-skills-list">
      ${effectiveManifest.skills.length > 0
        ? effectiveManifest.skills.map((skill) => renderContextSkillCard(skill))
        : html`<div class="flex flex-col items-center justify-center p-4 text-base-content/40">
            <p class="text-xs">This page does not expose any runnable skills yet.</p>
          </div>`}
    </div>
  `;
}

/** Render the empty state panel shown when no manifest is available. */
export function renderContextEmptyPanel(
  message: string,
  currentTabId: number | null,
  isError: boolean,
): TemplateResult {
  return html`
    <div class="context-app-value">-</div>
    <div class="context-scene-value">-</div>
    <div class="context-tab-value">${currentTabId != null ? currentTabId : '-'}</div>
    <div class="context-route-value">-</div>
    <div class="context-resources-list">
      <div class="flex flex-col items-center justify-center p-4 text-base-content/40">
        <p class="text-xs">${message}</p>
      </div>
    </div>
    <div class="context-skills-list">
      <div class="flex flex-col items-center justify-center p-4 text-base-content/40">
        <p class="text-xs">${message}</p>
      </div>
    </div>
    <div
      class="context-manifest-status text-xs font-semibold ${isError ? 'text-error' : 'opacity-60'}"
    >
      ${message}
    </div>
    <pre class="context-manifest-output">
${isError ? formatJson({ error: message }) : '(manifest not loaded)'}</pre
    >
    <div class="context-diff-status text-xs font-semibold opacity-60">Idle</div>
    <div class="context-diff-output">
      <div class="border border-base-300 rounded-lg bg-base-100 p-2.5">
        <p class="text-xs opacity-60">(manifest diff not available)</p>
      </div>
    </div>
    <div class="context-resource-status text-xs font-semibold opacity-60">Idle</div>
    <pre class="context-resource-output">(select a data card to inspect its payload)</pre>
    <div class="context-skill-status text-xs font-semibold opacity-60">Idle</div>
    <pre class="context-skill-output">(select a skill card to preview its prompt)</pre>
  `;
}

/** Render the manifest diff panel comparing raw vs filtered data. */
export function renderContextDiffPanel(
  rawManifest: PageContextManifest | null,
  effectiveManifest: PageContextManifest | null,
  debug: ContextManifestFilterDebug | null,
): TemplateResult {
  const diff = buildContextManifestDiff(rawManifest, effectiveManifest);
  const hasDiff =
    diff.hiddenNamespaces.length > 0 ||
    diff.hiddenResources.length > 0 ||
    diff.hiddenSkills.length > 0 ||
    diff.sceneChanged;

  return html`
    <div
      class="context-diff-status text-xs font-semibold ${hasDiff ? 'text-success' : 'opacity-60'}"
    >
      ${hasDiff ? 'Diff detected' : 'No diff'}
    </div>
    <div class="context-diff-output">
      ${renderDiffCard(
        'Namespaces',
        diff.rawNamespaces,
        diff.effectiveNamespaces,
        debug?.hiddenNamespaces ?? diff.hiddenNamespaces.map((id) => ({ id, reason: 'unknown' })),
      )}
      ${renderDiffCard(
        'Resources',
        diff.rawResources,
        diff.effectiveResources,
        debug?.hiddenResources ?? diff.hiddenResources.map((id) => ({ id, reason: 'unknown' })),
      )}
      ${renderDiffCard(
        'Skills',
        diff.rawSkills,
        diff.effectiveSkills,
        debug?.hiddenSkills ?? diff.hiddenSkills.map((id) => ({ id, reason: 'unknown' })),
      )}
      ${renderTrimmedToolsCard(debug)}
      <div class="border border-base-300 rounded-lg bg-base-100 p-2.5">
        <h4 class="text-xs font-bold mb-1">Scene</h4>
        <p class="text-xs opacity-70">
          ${diff.sceneChanged
            ? 'Scene changed between raw and effective manifest.'
            : 'Scene is unchanged.'}
        </p>
      </div>
    </div>
  `;
}

/** Render one diff category card with raw/effective counts and hidden items. */
function renderDiffCard(
  title: string,
  rawCount: number,
  effectiveCount: number,
  hiddenItems: Array<{ id: string; reason: string }>,
): TemplateResult {
  return html`
    <div class="border border-base-300 rounded-lg bg-base-100 p-2.5">
      <h4 class="text-xs font-bold mb-1">${title}</h4>
      <p class="text-xs opacity-70">Raw: ${rawCount} · Effective: ${effectiveCount}</p>
      ${hiddenItems.length > 0
        ? html`<ul class="mt-1.5 pl-4 text-xs opacity-70 list-disc">
            ${hiddenItems.map(
              (item) =>
                html`<li class="break-words">
                  <strong>${item.id}</strong> · ${formatReason(item.reason)}
                </li>`,
            )}
          </ul>`
        : html`<p class="text-xs opacity-50 mt-1">No hidden items.</p>`}
    </div>
  `;
}

/** Render the skill tool trimming card for filtered-out recommended tools. */
function renderTrimmedToolsCard(debug: ContextManifestFilterDebug | null): TemplateResult {
  const trimmed: ContextSkillToolTrimDebug[] = debug?.trimmedSkillTools ?? [];
  return html`
    <div class="border border-base-300 rounded-lg bg-base-100 p-2.5">
      <h4 class="text-xs font-bold mb-1">Skill Tool Trimming</h4>
      ${trimmed.length > 0
        ? html`<ul class="mt-1.5 pl-4 text-xs opacity-70 list-disc">
            ${trimmed.flatMap((entry: ContextSkillToolTrimDebug) =>
              entry.removedTools.map(
                (item: ContextFilterDebugItem) =>
                  html`<li class="break-words">
                    <strong>${entry.skillId}</strong> · ${item.id} · ${formatReason(item.reason)}
                  </li>`,
              ),
            )}
          </ul>`
        : html`<p class="text-xs opacity-50 mt-1">No skill tool recommendations were trimmed.</p>`}
    </div>
  `;
}

/**
 * Translate filter reason codes to human-readable text.
 * Keep one shared exit so side-panel-app and panel do not duplicate it.
 */
export function formatReason(reason: string): string {
  switch (reason) {
    case 'namespace_disabled':
      return 'disabled by namespace';
    case 'builtin_tool_disabled':
      return 'disabled by built-in tool filter';
    case 'page_tool_disabled':
      return 'disabled by page tool filter';
    case 'scene_filtered':
      return 'filtered by scene';
    default:
      return 'unknown reason';
  }
}

/** Render a namespace descriptor as a compact domain card. */
export function renderContextNamespaceCard(namespace: ContextNamespaceDescriptor): TemplateResult {
  const tags = namespace.tags ?? [];

  return html`
    <div class="card card-compact bg-base-100 border border-base-300 shadow-sm mb-2">
      <div class="card-body p-2.5 gap-1">
        <div class="flex items-start justify-between gap-2">
          <div class="card-title text-xs font-bold">${namespace.title}</div>
          <span class="badge badge-xs badge-primary">${namespace.namespace}</span>
        </div>
        <p class="text-xs opacity-60 break-words">
          ${namespace.description ?? `Declared namespace ${namespace.namespace}.`}
        </p>
        ${tags.length > 0
          ? html`<div class="flex gap-1 flex-wrap mt-0.5">
              ${tags.map((tag) => html`<span class="badge badge-xs badge-ghost">${tag}</span>`)}
            </div>`
          : nothing}
      </div>
    </div>
  `;
}

/** Render a resource descriptor as a data card with a preview button. */
export function renderContextResourceCard(resource: ContextResourceDescriptor): TemplateResult {
  const tags = resource.tags ?? [];

  return html`
    <div class="card card-compact bg-base-100 border border-base-300 shadow-sm mb-2">
      <div class="card-body p-2.5 gap-1">
        <div class="card-title text-xs font-bold">${resource.title}</div>
        <p class="text-xs opacity-60 break-words">${resource.description ?? resource.id}</p>
        <div class="flex gap-1.5 flex-wrap">
          <span class="badge badge-xs badge-primary">${resource.namespace}</span>
          <span class="badge badge-xs badge-ghost">${resource.kind ?? 'resource'}</span>
          ${resource.mimeType
            ? html`<span class="badge badge-xs badge-outline">${resource.mimeType}</span>`
            : nothing}
        </div>
        ${tags.length > 0
          ? html`<div class="flex gap-1 flex-wrap mt-0.5">
              ${tags.map((tag) => html`<span class="badge badge-xs badge-ghost">${tag}</span>`)}
            </div>`
          : nothing}
        <p class="text-[11px] opacity-55">
          OpenCode can read this page data when it needs grounded evidence.
        </p>
        <div class="card-actions mt-1">
          <button
            class="tooltip tooltip-bottom btn btn-xs btn-primary"
            type="button"
            data-tip="Preview the exact text or JSON OpenCode would receive from this data source"
            data-action="read-resource"
            data-resource-id="${resource.id}"
            title="Preview the exact text or JSON OpenCode would receive from this data source"
          >
            Preview Data
          </button>
        </div>
      </div>
    </div>
  `;
}

/** Render a skill descriptor as a workflow card with a preview button. */
export function renderContextSkillCard(skill: ContextSkillDescriptor): TemplateResult {
  const intentTags = skill.intentTags ?? [];
  const linkedResourceCount = skill.resourceIds?.length ?? 0;
  const linkedToolCount = skill.toolNames?.length ?? 0;

  return html`
    <div class="card card-compact bg-base-100 border border-base-300 shadow-sm mb-2">
      <div class="card-body p-2.5 gap-1">
        <div class="card-title text-xs font-bold">${skill.title}</div>
        <p class="text-xs opacity-60 break-words">${skill.description}</p>
        <div class="flex gap-1.5 flex-wrap">
          <span class="badge badge-xs badge-primary">${skill.namespace}</span>
          <span class="badge badge-xs badge-ghost">${skill.mode ?? 'analysis'}</span>
          <span class="badge badge-xs badge-outline">
            ${linkedResourceCount} ${linkedResourceCount === 1 ? 'resource' : 'resources'}
          </span>
          <span class="badge badge-xs badge-outline">
            ${linkedToolCount} ${linkedToolCount === 1 ? 'tool' : 'tools'}
          </span>
        </div>
        ${intentTags.length > 0
          ? html`<div class="flex gap-1 flex-wrap mt-0.5">
              ${intentTags.map(
                (tag) => html`<span class="badge badge-xs badge-ghost">${tag}</span>`,
              )}
            </div>`
          : nothing}
        <p class="text-[11px] opacity-55">
          A page-provided recipe that helps OpenCode choose the right data and tools.
        </p>
        <div class="card-actions mt-1">
          <button
            class="tooltip tooltip-bottom btn btn-xs btn-primary"
            type="button"
            data-tip="Preview the workflow instructions before OpenCode uses them"
            data-action="preview-skill"
            data-skill-id="${skill.id}"
            title="Preview the workflow instructions before OpenCode uses them"
          >
            Preview Workflow
          </button>
        </div>
      </div>
    </div>
  `;
}
