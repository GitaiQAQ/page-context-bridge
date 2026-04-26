/**
 * Context manifest 面板渲染模块。
 * 提供 namespace / resource / skill 卡片组件和 diff 面板的纯渲染函数。
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
 * 渲染完整 context manifest 面板（旧版内联模板，保留兼容）。
 * 当前主入口已迁移至 renderContextTab()，此函数仅作降级/测试用途。
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

/** 渲染空状态面板（无 manifest 可用时显示占位内容） */
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

/** 渲染 manifest diff 面板（原始 vs 过滤后的差异对比） */
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

/** 渲染单个 diff 分类卡片（原始/有效计数 + 隐藏项列表） */
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

/** 渲染 skill 工具裁剪卡片（被过滤掉的推荐工具列表） */
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
 * 将过滤原因码转译为人类可读文案。
 * 统一出口，避免在 side-panel-app 和 panel 中各写一份。
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

/** 渲染 namespace 描述为紧凑的业务域卡片 */
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

/** 渲染 resource 描述为数据卡片（含 "Inspect Payload" 按钮） */
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
          Agents can inspect this payload directly from the current page state.
        </p>
        <div class="card-actions mt-1">
          <button
            class="btn btn-xs btn-primary"
            type="button"
            data-action="read-resource"
            data-resource-id="${resource.id}"
          >
            Inspect Payload
          </button>
        </div>
      </div>
    </div>
  `;
}

/** 渲染 skill 描述为工作流卡片（含 "Inspect Skill" 按钮） */
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
          Uses page-grounded context before the agent expands into tools or workflows.
        </p>
        <div class="card-actions mt-1">
          <button
            class="btn btn-xs btn-primary"
            type="button"
            data-action="preview-skill"
            data-skill-id="${skill.id}"
          >
            Inspect Skill
          </button>
        </div>
      </div>
    </div>
  `;
}
