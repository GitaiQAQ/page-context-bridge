/**
 * Context manifest panel rendering for the sidepanel.
 * Uses daisyUI/Tailwind utility classes with lit-html templates.
 */

import { html, nothing, type TemplateResult } from "lit";

import type { ContextResourceDescriptor, ContextSkillDescriptor, PageContextManifest } from "@page-context/shared-protocol";
import type { ContextFilterDebugItem, ContextManifestFilterDebug, ContextSkillToolTrimDebug } from "./context-manifest-filter-debug";

import { buildContextManifestDiff } from "./context-manifest-diff";
export { buildContextManifestDiff } from "./context-manifest-diff";
import { formatJson } from "./sidepanel-tree-renderer";

/**
 * Renders the complete context manifest panel content.
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
    <div class="context-route-value">${effectiveManifest.route || "/"}</div>
    <div class="context-resources-list">
      ${effectiveManifest.resources.length > 0
        ? effectiveManifest.resources.map((resource) => renderContextResourceCard(resource))
        : html`<div class="flex flex-col items-center justify-center p-4 text-base-content/40"><p class="text-xs">No resources declared.</p></div>`}
    </div>
    <div class="context-skills-list">
      ${effectiveManifest.skills.length > 0
        ? effectiveManifest.skills.map((skill) => renderContextSkillCard(skill))
        : html`<div class="flex flex-col items-center justify-center p-4 text-base-content/40"><p class="text-xs">No skills declared.</p></div>`}
    </div>
  `;
}

/**
 * Renders an empty state panel when no manifest is available.
 */
export function renderContextEmptyPanel(
  message: string,
  currentTabId: number | null,
  isError: boolean,
): TemplateResult {
  return html`
    <div class="context-app-value">-</div>
    <div class="context-scene-value">-</div>
    <div class="context-tab-value">${currentTabId != null ? currentTabId : "-"}</div>
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
    <div class="context-manifest-status text-xs font-semibold ${isError ? "text-error" : "opacity-60"}">${message}</div>
    <pre class="context-manifest-output">${isError ? formatJson({ error: message }) : "(manifest not loaded)"}</pre>
    <div class="context-diff-status text-xs font-semibold opacity-60">Idle</div>
    <div class="context-diff-output">
      <div class="border border-base-300 rounded-lg bg-base-100 p-2.5">
        <p class="text-xs opacity-60">(manifest diff not available)</p>
      </div>
    </div>
    <div class="context-resource-status text-xs font-semibold opacity-60">Idle</div>
    <pre class="context-resource-output">(select a resource to read)</pre>
    <div class="context-skill-status text-xs font-semibold opacity-60">Idle</div>
    <pre class="context-skill-output">(select a skill to render its prompt)</pre>
  `;
}

/**
 * Renders the context manifest diff panel.
 */
export function renderContextDiffPanel(
  rawManifest: PageContextManifest | null,
  effectiveManifest: PageContextManifest | null,
  debug: ContextManifestFilterDebug | null,
): TemplateResult {
  const diff = buildContextManifestDiff(rawManifest, effectiveManifest);
  const hasDiff = diff.hiddenNamespaces.length > 0 || diff.hiddenResources.length > 0 || diff.hiddenSkills.length > 0 || diff.sceneChanged;

  return html`
    <div class="context-diff-status text-xs font-semibold ${hasDiff ? "text-success" : "opacity-60"}">${hasDiff ? "Diff detected" : "No diff"}</div>
    <div class="context-diff-output">
      ${renderDiffCard("Namespaces", diff.rawNamespaces, diff.effectiveNamespaces, debug?.hiddenNamespaces ?? diff.hiddenNamespaces.map((id) => ({ id, reason: "unknown" })))}
      ${renderDiffCard("Resources", diff.rawResources, diff.effectiveResources, debug?.hiddenResources ?? diff.hiddenResources.map((id) => ({ id, reason: "unknown" })))}
      ${renderDiffCard("Skills", diff.rawSkills, diff.effectiveSkills, debug?.hiddenSkills ?? diff.hiddenSkills.map((id) => ({ id, reason: "unknown" })))}
      ${renderTrimmedToolsCard(debug)}
      <div class="border border-base-300 rounded-lg bg-base-100 p-2.5">
        <h4 class="text-xs font-bold mb-1">Scene</h4>
        <p class="text-xs opacity-70">${diff.sceneChanged ? "Scene changed between raw and effective manifest." : "Scene is unchanged."}</p>
      </div>
    </div>
  `;
}

/**
 * Renders a diff card showing comparison between raw and effective counts.
 */
function renderDiffCard(title: string, rawCount: number, effectiveCount: number, hiddenItems: Array<{ id: string; reason: string }>): TemplateResult {
  return html`
    <div class="border border-base-300 rounded-lg bg-base-100 p-2.5">
      <h4 class="text-xs font-bold mb-1">${title}</h4>
      <p class="text-xs opacity-70">Raw: ${rawCount} · Effective: ${effectiveCount}</p>
      ${hiddenItems.length > 0
        ? html`<ul class="mt-1.5 pl-4 text-xs opacity-70 list-disc">${hiddenItems.map((item) => html`<li class="break-words"><strong>${item.id}</strong> · ${formatReason(item.reason)}</li>`)}</ul>`
        : html`<p class="text-xs opacity-50 mt-1">No hidden items.</p>`}
    </div>
  `;
}

/**
 * Renders a card showing trimmed skill tools information.
 */
function renderTrimmedToolsCard(debug: ContextManifestFilterDebug | null): TemplateResult {
  const trimmed: ContextSkillToolTrimDebug[] = debug?.trimmedSkillTools ?? [];
  return html`
    <div class="border border-base-300 rounded-lg bg-base-100 p-2.5">
      <h4 class="text-xs font-bold mb-1">Skill Tool Trimming</h4>
      ${trimmed.length > 0
        ? html`<ul class="mt-1.5 pl-4 text-xs opacity-70 list-disc">${trimmed.flatMap((entry: ContextSkillToolTrimDebug) => entry.removedTools.map((item: ContextFilterDebugItem) => html`<li class="break-words"><strong>${entry.skillId}</strong> · ${item.id} · ${formatReason(item.reason)}</li>`))}</ul>`
        : html`<p class="text-xs opacity-50 mt-1">No skill tool recommendations were trimmed.</p>`}
    </div>
  `;
}

/**
 * Formats a filter reason into human-readable text.
 */
function formatReason(reason: string): string {
  switch (reason) {
    case "namespace_disabled":
      return "disabled by namespace";
    case "builtin_tool_disabled":
      return "disabled by built-in tool filter";
    case "page_tool_disabled":
      return "disabled by page tool filter";
    case "scene_filtered":
      return "filtered by scene";
    default:
      return "unknown reason";
  }
}

/**
 * Renders a resource descriptor as a card component.
 */
export function renderContextResourceCard(resource: ContextResourceDescriptor): TemplateResult {
  return html`
    <div class="card card-compact bg-base-100 border border-base-300 shadow-sm mb-2">
      <div class="card-body p-2.5 gap-1">
        <div class="card-title text-xs font-bold">${resource.title}</div>
        <p class="text-xs opacity-60 break-words">${resource.description ?? resource.id}</p>
        <div class="flex gap-1.5 flex-wrap">
          <span class="badge badge-xs badge-primary">${resource.namespace}</span>
          <span class="badge badge-xs badge-ghost">${resource.kind ?? "resource"}</span>
        </div>
        <div class="card-actions mt-1">
          <button class="btn btn-xs btn-primary" type="button" data-action="read-resource" data-resource-id="${resource.id}">Read Resource</button>
        </div>
      </div>
    </div>
  `;
}

/**
 * Renders a skill descriptor as a card component.
 */
export function renderContextSkillCard(skill: ContextSkillDescriptor): TemplateResult {
  return html`
    <div class="card card-compact bg-base-100 border border-base-300 shadow-sm mb-2">
      <div class="card-body p-2.5 gap-1">
        <div class="card-title text-xs font-bold">${skill.title}</div>
        <p class="text-xs opacity-60 break-words">${skill.description}</p>
        <div class="flex gap-1.5 flex-wrap">
          <span class="badge badge-xs badge-primary">${skill.namespace}</span>
          <span class="badge badge-xs badge-ghost">${skill.mode ?? "analysis"}</span>
        </div>
        <div class="card-actions mt-1">
          <button class="btn btn-xs btn-primary" type="button" data-action="preview-skill" data-skill-id="${skill.id}">Preview Prompt</button>
        </div>
      </div>
    </div>
  `;
}
