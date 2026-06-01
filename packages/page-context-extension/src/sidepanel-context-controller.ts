/**
 * Pure render function for the AI View tab, extracted from SidePanelApp.
 * Receives precomputed state and returns the page briefing OpenCode can inspect.
 */

import { html, type TemplateResult } from 'lit';
import { classMap } from 'lit/directives/class-map.js';
import { renderIcon } from './icons';
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

function renderCodeBlock(content: string): TemplateResult {
  return html`
    <pre
      class="max-h-80 overflow-auto rounded-box bg-base-200 p-3 font-mono text-xs whitespace-pre-wrap break-words"
    >
${content}</pre
    >
  `;
}

/** Renders the complete Context Tab content. */
export function renderContextTab(input: RenderContextTabInput): TemplateResult {
  const capabilityBriefing = buildCapabilityBriefing(input);

  return html`
    <div class="pcb-tab-panel ${classMap({ active: input.active })} flex flex-col flex-1 min-h-0">
      <div class="flex items-center gap-2 px-3 py-2 bg-base-100 border-b border-base-300 shrink-0">
        <div class="flex flex-col gap-0.5">
          <span class="text-xs font-bold uppercase tracking-[0.18em] opacity-60"
            >${t('whatAiSees')}</span
          >
          <span class="text-[11px] opacity-55">${t('aiViewSubtitle')}</span>
        </div>
        <button
          class="tooltip tooltip-bottom btn btn-xs btn-ghost ml-auto gap-1"
          data-tip=${t('reloadPageContext')}
          title=${t('reloadPageContext')}
          @click=${input.onRefresh}
        >
          ${renderIcon('refreshCw', 'h-3 w-3')} ${t('refresh')}
        </button>
      </div>
      <div class="flex-1 min-h-0 overflow-auto bg-base-200 p-3">
        <div class="mx-auto flex max-w-5xl flex-col gap-3">
          <section class="card border border-base-300 bg-base-100 shadow-sm">
            <div class="card-body gap-3 p-4">
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div class="min-w-0">
                  <div class="text-[11px] font-bold uppercase tracking-wide opacity-50">
                    ${t('aiBriefing')}
                  </div>
                  <h3 class="mt-1 text-base font-bold">${t('beforeOpenCodeActs')}</h3>
                  <p class="mt-1 text-sm leading-relaxed opacity-75">${capabilityBriefing}</p>
                </div>
                <div class="flex flex-wrap justify-end gap-1.5 text-xs">
                  <span class="badge badge-outline">${input.contextAppValue}</span>
                  <span class="badge badge-outline">${input.contextSceneValue}</span>
                  <span class="badge badge-outline">${t('tab')} ${input.contextTabValue}</span>
                </div>
              </div>

              <div
                class="stats stats-horizontal w-full border border-base-300 bg-base-100 shadow-none"
              >
                <div class="stat px-3 py-2">
                  <div class="stat-title text-[10px] uppercase tracking-wide">
                    ${t('pageAreas')}
                  </div>
                  <div class="stat-value text-lg font-bold">${input.contextNamespaceCount}</div>
                </div>
                <div class="stat px-3 py-2">
                  <div class="stat-title text-[10px] uppercase tracking-wide">
                    ${t('readableData')}
                  </div>
                  <div class="stat-value text-lg font-bold">${input.contextResourceCount}</div>
                </div>
                <div class="stat px-3 py-2">
                  <div class="stat-title text-[10px] uppercase tracking-wide">
                    ${t('guidedWorkflows')}
                  </div>
                  <div class="stat-value text-lg font-bold">${input.contextSkillCount}</div>
                </div>
              </div>

              <div class="alert border border-base-300 bg-base-200/60 py-2 text-xs">
                <span>
                  ${tf('browserRouteMapped', {
                    route: input.contextRouteValue,
                    app: input.contextAppValue,
                    scene: input.contextSceneValue,
                  })}
                </span>
              </div>
            </div>
          </section>

          <section class="grid grid-cols-1 gap-3 xl:grid-cols-3">
            <div class="card border border-base-300 bg-base-100 shadow-sm">
              <div class="card-body gap-2 p-3">
                <div>
                  <h3 class="text-sm font-bold">${t('pageAreas')}</h3>
                  <p class="text-[11px] opacity-55">${t('functionalAreasExposed')}</p>
                </div>
                <div id="contextNamespacesList" class="min-h-0">
                  ${input.contextNamespacesListHtml}
                </div>
              </div>
            </div>

            <div class="card border border-base-300 bg-base-100 shadow-sm">
              <div class="card-body gap-2 p-3">
                <div>
                  <h3 class="text-sm font-bold">${t('readableData')}</h3>
                  <p class="text-[11px] opacity-55">${t('structuredPageData')}</p>
                </div>
                <div id="contextResourcesList" class="min-h-0" @click=${input.onResourceClick}>
                  ${input.contextResourcesListHtml}
                </div>
              </div>
            </div>

            <div class="card border border-base-300 bg-base-100 shadow-sm">
              <div class="card-body gap-2 p-3">
                <div>
                  <h3 class="text-sm font-bold">${t('guidedWorkflows')}</h3>
                  <p class="text-[11px] opacity-55">${t('taskRecipesProvided')}</p>
                </div>
                <div id="contextSkillsList" class="min-h-0" @click=${input.onSkillClick}>
                  ${input.contextSkillsListHtml}
                </div>
              </div>
            </div>
          </section>

          <section class="card border border-base-300 bg-base-100 shadow-sm">
            <div class="card-body gap-2 p-3">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 class="text-sm font-bold">${t('selectedDataPreview')}</h3>
                  <p class="text-[11px] opacity-55">${t('workflowPromptDescription')}</p>
                </div>
                <div class="flex gap-2 text-xs">
                  <span class="font-semibold ${input.resourceStatusClass}"
                    >${input.resourceStatus}</span
                  >
                  <span class="font-semibold ${input.skillStatusClass}">${input.skillStatus}</span>
                </div>
              </div>
              <div class="grid grid-cols-1 gap-2 xl:grid-cols-2">
                <div>
                  <div class="mb-1 text-[11px] font-bold uppercase tracking-wide opacity-50">
                    ${t('readableData')}
                  </div>
                  ${renderCodeBlock(input.resourceOutput)}
                </div>
                <div>
                  <div class="mb-1 text-[11px] font-bold uppercase tracking-wide opacity-50">
                    ${t('selectedWorkflowPrompt')}
                  </div>
                  ${renderCodeBlock(input.skillOutput)}
                </div>
              </div>
            </div>
          </section>

          <section class="flex flex-col gap-2">
            <details class="collapse collapse-arrow border border-base-300 bg-base-100 shadow-sm">
              <summary class="collapse-title min-h-0 px-3 py-2 text-sm font-bold">
                <span>${t('hiddenFromAi')}</span>
                <span class="ml-2 text-xs font-semibold ${input.diffStatusClass}">
                  ${input.diffStatus}
                </span>
              </summary>
              <div class="collapse-content px-3 pb-3">
                <p class="mb-2 text-[11px] opacity-55">${t('hiddenItemsExplanation')}</p>
                <div id="contextDiffOutput" class="flex flex-col gap-2">${input.diffOutput}</div>
              </div>
            </details>

            <details class="collapse collapse-arrow border border-base-300 bg-base-100 shadow-sm">
              <summary class="collapse-title min-h-0 px-3 py-2 text-sm font-bold">
                <span>${t('developerPayload')}</span>
                <span class="ml-2 text-xs font-semibold ${input.manifestStatusClass}">
                  ${input.manifestStatus}
                </span>
              </summary>
              <div class="collapse-content px-3 pb-3">
                <p class="mb-2 text-[11px] opacity-55">${t('developerPayloadDescription')}</p>
                ${renderCodeBlock(input.manifestOutput)}
              </div>
            </details>
          </section>
        </div>
      </div>
    </div>
  `;
}
