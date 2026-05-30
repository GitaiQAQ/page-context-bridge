/**
 * Pure render function for the Context Tab, extracted from SidePanelApp.
 * Receives precomputed state and returns the full Page Capabilities panel template.
 */

import { html, type TemplateResult } from 'lit';
import { classMap } from 'lit/directives/class-map.js';

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
  return `Bridge sees ${input.contextResourceCount} ${pluralize(input.contextResourceCount, 'data resource')} and ${input.contextSkillCount} ${pluralize(input.contextSkillCount, 'runnable skill')} across ${input.contextNamespaceCount} ${pluralize(input.contextNamespaceCount, 'namespace')}.`;
}

/** Renders the complete Context Tab content. */
export function renderContextTab(input: RenderContextTabInput): TemplateResult {
  const capabilityBriefing = buildCapabilityBriefing(input);

  return html`
    <div class="tab-content ${classMap({ active: input.active })} flex flex-col flex-1 min-h-0">
      <div class="flex items-center gap-2 px-3 py-2 bg-base-100 border-b border-base-300 shrink-0">
        <div class="flex flex-col gap-0.5">
          <span class="text-xs font-bold uppercase tracking-[0.18em] opacity-60"
            >Page Capabilities</span
          >
          <span class="text-[11px] opacity-55"
            >Operational briefing for what this page can expose to the bridge right now</span
          >
        </div>
        <button class="btn btn-xs btn-ghost ml-auto" @click=${input.onRefresh}>Refresh</button>
      </div>
      <div class="grid grid-cols-[minmax(240px,320px)_1fr] flex-1 min-h-0">
        <!-- Sidebar -->
        <div class="border-r border-base-300 bg-base-100 overflow-auto">
          <div class="border-b border-base-200 p-3">
            <div class="text-xs font-bold uppercase tracking-wide opacity-50 mb-2">
              Page Identity
            </div>
            <div class="grid grid-cols-2 gap-2">
              <div class="stat bg-base-200 rounded-lg p-2">
                <div class="stat-title text-[10px]">App</div>
                <div class="stat-value text-sm font-bold">${input.contextAppValue}</div>
              </div>
              <div class="stat bg-base-200 rounded-lg p-2">
                <div class="stat-title text-[10px]">Scene</div>
                <div class="stat-value text-sm font-bold">${input.contextSceneValue}</div>
              </div>
              <div class="stat bg-base-200 rounded-lg p-2">
                <div class="stat-title text-[10px]">Tab</div>
                <div class="stat-value text-sm font-bold">${input.contextTabValue}</div>
              </div>
              <div class="stat bg-base-200 rounded-lg p-2">
                <div class="stat-title text-[10px]">Route</div>
                <div class="stat-value text-sm font-bold">${input.contextRouteValue}</div>
              </div>
            </div>
          </div>
          <div class="border-b border-base-200 p-3">
            <div class="flex items-center justify-between mb-2">
              <div class="text-xs font-bold uppercase tracking-wide opacity-50">
                Exposure Snapshot
              </div>
              <span class="badge badge-ghost badge-xs">${input.manifestStatus}</span>
            </div>
            <div class="text-[11px] opacity-55 mb-2">${capabilityBriefing}</div>
            <div class="grid grid-cols-3 gap-2">
              <div class="rounded-lg border border-base-300 bg-base-200 px-2 py-2">
                <div class="text-[10px] uppercase tracking-wide opacity-50">Namespaces</div>
                <div class="text-sm font-bold">${input.contextNamespaceCount}</div>
              </div>
              <div class="rounded-lg border border-base-300 bg-base-200 px-2 py-2">
                <div class="text-[10px] uppercase tracking-wide opacity-50">Data</div>
                <div class="text-sm font-bold">${input.contextResourceCount}</div>
              </div>
              <div class="rounded-lg border border-base-300 bg-base-200 px-2 py-2">
                <div class="text-[10px] uppercase tracking-wide opacity-50">Skills</div>
                <div class="text-sm font-bold">${input.contextSkillCount}</div>
              </div>
            </div>
          </div>
          <div class="border-b border-base-200 p-3">
            <div class="text-xs font-bold uppercase tracking-wide opacity-50 mb-1">
              Business Domains
            </div>
            <div class="text-[11px] opacity-55 mb-2">
              Namespace groups the page has declared for agent-visible work.
            </div>
            <div id="contextNamespacesList">${input.contextNamespacesListHtml}</div>
          </div>
          <div class="border-b border-base-200 p-3">
            <div class="text-xs font-bold uppercase tracking-wide opacity-50 mb-1">
              Available Data
            </div>
            <div class="text-[11px] opacity-55 mb-2">
              Structured payloads the page currently allows the bridge to read.
            </div>
            <div id="contextResourcesList" @click=${input.onResourceClick}>
              ${input.contextResourcesListHtml}
            </div>
          </div>
          <div class="p-3">
            <div class="text-xs font-bold uppercase tracking-wide opacity-50 mb-1">
              Available Workflows
            </div>
            <div class="text-[11px] opacity-55 mb-2">
              Promptable actions grounded in this page's current data and tool surface.
            </div>
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
                  <div class="font-bold text-sm">Agent Briefing</div>
                  <p class="text-[11px] opacity-55">
                    Concrete summary of what an agent can inspect or invoke on this page.
                  </p>
                </div>
                <div class="flex gap-1.5 flex-wrap justify-end">
                  <span class="badge badge-ghost badge-sm">${input.contextAppValue}</span>
                  <span class="badge badge-ghost badge-sm">${input.contextSceneValue}</span>
                  <span class="badge badge-outline badge-sm">tab ${input.contextTabValue}</span>
                </div>
              </div>
              <div class="rounded-lg border border-base-300 bg-base-200 px-3 py-2">
                <div class="text-sm font-semibold">${capabilityBriefing}</div>
                <div class="text-xs opacity-60 mt-1">
                  Route ${input.contextRouteValue} is currently mapped to app
                  <strong>${input.contextAppValue}</strong> in scene
                  <strong>${input.contextSceneValue}</strong>.
                </div>
              </div>
              <div class="grid grid-cols-2 gap-2">
                <div class="rounded-lg border border-base-300 bg-base-100 px-3 py-2">
                  <div class="text-[10px] uppercase tracking-wide opacity-50">Manifest Status</div>
                  <div class="text-sm font-semibold ${input.manifestStatusClass}">
                    ${input.manifestStatus}
                  </div>
                </div>
                <div class="rounded-lg border border-base-300 bg-base-100 px-3 py-2">
                  <div class="text-[10px] uppercase tracking-wide opacity-50">Filter Result</div>
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
                <span class="font-bold text-sm">Capability Filters</span>
                <span class="text-xs font-semibold ${input.diffStatusClass}"
                  >${input.diffStatus}</span
                >
              </div>
              <p class="text-[11px] opacity-55">
                Anything declared by the page but removed before agent exposure shows up here with
                the filter reason.
              </p>
              <div id="contextDiffOutput" class="flex flex-col gap-2">${input.diffOutput}</div>
            </div>
          </div>
          <div class="card bg-base-100 border border-base-300 shadow-sm">
            <div class="card-body p-3 gap-1">
              <div class="flex items-center justify-between">
                <span class="font-bold text-sm">Raw Manifest</span>
                <span class="text-xs font-semibold ${input.manifestStatusClass}"
                  >${input.manifestStatus}</span
                >
              </div>
              <p class="text-[11px] opacity-55">
                Low-level manifest payload from the current tab. Useful for debugging, not the
                primary reading view.
              </p>
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
                <span class="font-bold text-sm">Selected Data Payload</span>
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
                <span class="font-bold text-sm">Selected Skill Prompt</span>
                <span class="text-xs font-semibold ${input.skillStatusClass}"
                  >${input.skillStatus}</span
                >
              </div>
              <p class="text-[11px] opacity-55">
                Preview the exact prompt contract exposed by the page before an agent consumes it.
              </p>
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
