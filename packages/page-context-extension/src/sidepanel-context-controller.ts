/**
 * Pure render function for the AI View tab, extracted from SidePanelApp.
 * Receives precomputed state and returns the page briefing OpenCode can inspect.
 */

import { html, type TemplateResult } from 'lit';
import { classMap } from 'lit/directives/class-map.js';
import { t, tf } from './i18n';

export interface RenderContextTabInput {
  active: boolean;
  // Page identity
  contextAppValue: string;
  contextSceneValue: string;
  contextTabValue: string;
  contextRouteValue: string;
  // Existing capability counts. This only reshapes manifest data without extra semantic inference.
  contextNamespaceCount: string;
  contextResourceCount: string;
  contextSkillCount: string;
  contextNamespacesListHtml: TemplateResult;
  // Resource/skill lists (pre-rendered HTML)
  contextResourcesListHtml: TemplateResult;
  contextSkillsListHtml: TemplateResult;
  // Raw manifest card
  manifestStatus: string;
  manifestStatusClass: string;
  manifestOutput: string;
  // Diff card
  diffStatus: string;
  diffStatusClass: string;
  diffOutput: TemplateResult;
  // Resource card
  resourceStatus: string;
  resourceStatusClass: string;
  resourceOutput: string;
  // Skill card
  skillStatus: string;
  skillStatusClass: string;
  skillOutput: string;
  // Callbacks
  onRefresh(): void;
  onResourceClick(event: Event): void;
  onSkillClick(event: Event): void;
}

/** Plural formatting: use singular when count is 1, otherwise plural. */
function pluralize(countText: string, singular: string, plural = `${singular}s`): string {
  return countText === '1' ? singular : plural;
}

/** Generate capability summary text: how many resources/skills/namespaces the Bridge currently sees. */
function buildCapabilityBriefing(input: RenderContextTabInput): string {
  return `OpenCode can see ${input.contextResourceCount} ${pluralize(input.contextResourceCount, 'data source')} and ${input.contextSkillCount} ${pluralize(input.contextSkillCount, 'guided workflow')} across ${input.contextNamespaceCount} ${pluralize(input.contextNamespaceCount, 'page area')}.`;
}

/** Renders the complete Context Tab content. */
export function renderContextTab(input: RenderContextTabInput): TemplateResult {
  const capabilityBriefing = buildCapabilityBriefing(input);

  return html`
    <div class="tab-content ${classMap({ active: input.active })} flex flex-col flex-1 min-h-0">
      <div class="flex items-center gap-2 px-3 py-2 bg-base-100 border-b border-base-300 shrink-0">
        <div class="flex flex-col gap-0.5">
          <span class="text-xs font-bold uppercase tracking-[0.18em] opacity-60"
            >${t('whatAiSees')}</span
          >
          <span class="text-[11px] opacity-55">${t('aiViewSubtitle')}</span>
        </div>
        <button
          class="tooltip tooltip-bottom btn btn-xs btn-ghost ml-auto"
          data-tip=${t('reloadPageContext')}
          title=${t('reloadPageContext')}
          @click=${input.onRefresh}
        >
          ${t('refresh')}
        </button>
      </div>
      <div class="grid grid-cols-[minmax(240px,320px)_1fr] flex-1 min-h-0">
        <!-- Sidebar -->
        <div class="border-r border-base-300 bg-base-100 overflow-auto">
          <div class="border-b border-base-200 p-3">
            <div class="text-xs font-bold uppercase tracking-wide opacity-50 mb-2">
              ${t('currentPage')}
            </div>
            <div class="grid grid-cols-2 gap-2">
              <div class="stat bg-base-200 rounded-lg p-2">
                <div class="stat-title text-[10px]">${t('app')}</div>
                <div class="stat-value text-sm font-bold">${input.contextAppValue}</div>
              </div>
              <div class="stat bg-base-200 rounded-lg p-2">
                <div class="stat-title text-[10px]">${t('scene')}</div>
                <div class="stat-value text-sm font-bold">${input.contextSceneValue}</div>
              </div>
              <div class="stat bg-base-200 rounded-lg p-2">
                <div class="stat-title text-[10px]">${t('tab')}</div>
                <div class="stat-value text-sm font-bold">${input.contextTabValue}</div>
              </div>
              <div class="stat bg-base-200 rounded-lg p-2">
                <div class="stat-title text-[10px]">${t('route')}</div>
                <div class="stat-value text-sm font-bold">${input.contextRouteValue}</div>
              </div>
            </div>
          </div>
          <div class="border-b border-base-200 p-3">
            <div class="flex items-center justify-between mb-2">
              <div class="text-xs font-bold uppercase tracking-wide opacity-50">
                ${t('aiBriefing')}
              </div>
              <span class="text-[11px] opacity-50">${input.manifestStatus}</span>
            </div>
            <div class="text-[11px] opacity-55 mb-2">${capabilityBriefing}</div>
            <div class="grid grid-cols-3 gap-2">
              <div class="rounded-lg border border-base-300 bg-base-200 px-2 py-2">
                <div class="text-[10px] uppercase tracking-wide opacity-50">${t('namespaces')}</div>
                <div class="text-sm font-bold">${input.contextNamespaceCount}</div>
              </div>
              <div class="rounded-lg border border-base-300 bg-base-200 px-2 py-2">
                <div class="text-[10px] uppercase tracking-wide opacity-50">${t('data')}</div>
                <div class="text-sm font-bold">${input.contextResourceCount}</div>
              </div>
              <div class="rounded-lg border border-base-300 bg-base-200 px-2 py-2">
                <div class="text-[10px] uppercase tracking-wide opacity-50">${t('skills')}</div>
                <div class="text-sm font-bold">${input.contextSkillCount}</div>
              </div>
            </div>
          </div>
          <div class="border-b border-base-200 p-3">
            <div class="text-xs font-bold uppercase tracking-wide opacity-50 mb-1">
              ${t('pageAreas')}
            </div>
            <div class="text-[11px] opacity-55 mb-2">${t('functionalAreasExposed')}</div>
            <div id="contextNamespacesList">${input.contextNamespacesListHtml}</div>
          </div>
          <div class="border-b border-base-200 p-3">
            <div class="text-xs font-bold uppercase tracking-wide opacity-50 mb-1">
              ${t('readableData')}
            </div>
            <div class="text-[11px] opacity-55 mb-2">${t('structuredPageData')}</div>
            <div id="contextResourcesList" @click=${input.onResourceClick}>
              ${input.contextResourcesListHtml}
            </div>
          </div>
          <div class="p-3">
            <div class="text-xs font-bold uppercase tracking-wide opacity-50 mb-1">
              ${t('guidedWorkflows')}
            </div>
            <div class="text-[11px] opacity-55 mb-2">${t('taskRecipesProvided')}</div>
            <div id="contextSkillsList" @click=${input.onSkillClick}>
              ${input.contextSkillsListHtml}
            </div>
          </div>
        </div>
        <!-- Main -->
        <div class="bg-base-200 overflow-auto p-3 flex flex-col gap-3">
          <div class="card bg-base-100 border border-base-300 shadow-sm">
            <div class="card-body p-3 gap-2">
              <div class="flex items-center justify-between gap-2">
                <div>
                  <div class="font-bold text-sm">${t('beforeOpenCodeActs')}</div>
                  <p class="text-[11px] opacity-55">${t('aiUnderstandPage')}</p>
                </div>
                <div class="max-w-[18rem] truncate text-right text-[11px] opacity-50">
                  ${input.contextAppValue} · ${input.contextSceneValue} · ${t('tab')}
                  ${input.contextTabValue}
                </div>
              </div>
              <div class="rounded-lg border border-base-300 bg-base-200 px-3 py-2">
                <div class="text-sm font-semibold">${capabilityBriefing}</div>
                <div class="text-xs opacity-60 mt-1">
                  ${tf('browserRouteMapped', {
                    route: input.contextRouteValue,
                    app: input.contextAppValue,
                    scene: input.contextSceneValue,
                  })}
                </div>
              </div>
              <div class="grid grid-cols-2 gap-2">
                <div class="rounded-lg border border-base-300 bg-base-100 px-3 py-2">
                  <div class="text-[10px] uppercase tracking-wide opacity-50">
                    ${t('pageBriefing')}
                  </div>
                  <div class="text-sm font-semibold ${input.manifestStatusClass}">
                    ${input.manifestStatus}
                  </div>
                </div>
                <div class="rounded-lg border border-base-300 bg-base-100 px-3 py-2">
                  <div class="text-[10px] uppercase tracking-wide opacity-50">
                    ${t('safetyFilters')}
                  </div>
                  <div class="text-sm font-semibold ${input.diffStatusClass}">
                    ${input.diffStatus}
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div class="card bg-base-100 border border-base-300 shadow-sm">
            <div class="card-body p-3 gap-1">
              <div class="flex items-center justify-between">
                <span class="font-bold text-sm">${t('hiddenFromAi')}</span>
                <span class="text-xs font-semibold ${input.diffStatusClass}"
                  >${input.diffStatus}</span
                >
              </div>
              <p class="text-[11px] opacity-55">${t('hiddenItemsExplanation')}</p>
              <div id="contextDiffOutput" class="flex flex-col gap-2">${input.diffOutput}</div>
            </div>
          </div>
          <div class="card bg-base-100 border border-base-300 shadow-sm">
            <div class="card-body p-3 gap-1">
              <div class="flex items-center justify-between">
                <span class="font-bold text-sm">${t('developerPayload')}</span>
                <span class="text-xs font-semibold ${input.manifestStatusClass}"
                  >${input.manifestStatus}</span
                >
              </div>
              <p class="text-[11px] opacity-55">${t('developerPayloadDescription')}</p>
              <pre
                class="bg-base-200 rounded-lg p-2 text-xs font-mono whitespace-pre-wrap break-words overflow-auto"
              >
${input.manifestOutput}</pre
              >
            </div>
          </div>
          <div class="card bg-base-100 border border-base-300 shadow-sm">
            <div class="card-body p-3 gap-1">
              <div class="flex items-center justify-between">
                <span class="font-bold text-sm">${t('selectedDataPreview')}</span>
                <span class="text-xs font-semibold ${input.resourceStatusClass}"
                  >${input.resourceStatus}</span
                >
              </div>
              <pre
                class="bg-base-200 rounded-lg p-2 text-xs font-mono whitespace-pre-wrap break-words overflow-auto"
              >
${input.resourceOutput}</pre
              >
            </div>
          </div>
          <div class="card bg-base-100 border border-base-300 shadow-sm">
            <div class="card-body p-3 gap-1">
              <div class="flex items-center justify-between">
                <span class="font-bold text-sm">${t('selectedWorkflowPrompt')}</span>
                <span class="text-xs font-semibold ${input.skillStatusClass}"
                  >${input.skillStatus}</span
                >
              </div>
              <p class="text-[11px] opacity-55">${t('workflowPromptDescription')}</p>
              <pre
                class="bg-base-200 rounded-lg p-2 text-xs font-mono whitespace-pre-wrap break-words overflow-auto"
              >
${input.skillOutput}</pre
              >
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}
