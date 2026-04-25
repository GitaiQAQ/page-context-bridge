/**
 * Context Tab render function for the side panel.
 * Extracts the inline Context Tab template from SidePanelApp into a pure render function.
 */

import { html, type TemplateResult } from "lit";
import { classMap } from "lit/directives/class-map.js";

export interface RenderContextTabInput {
  active: boolean;
  // Manifest summary fields
  contextAppValue: string;
  contextSceneValue: string;
  contextTabValue: string;
  contextRouteValue: string;
  // Resource/skill lists (pre-rendered HTML)
  contextResourcesListHtml: TemplateResult;
  contextSkillsListHtml: TemplateResult;
  // Manifest card
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

/** Renders the complete Context Tab content. */
export function renderContextTab(input: RenderContextTabInput): TemplateResult {
  return html`
    <div class="tab-content ${classMap({ active: input.active })} flex flex-col flex-1 min-h-0">
      <div class="flex items-center gap-2 px-3 py-2 bg-base-100 border-b border-base-300 shrink-0">
        <span class="text-xs font-bold uppercase tracking-wide opacity-60">Capability Context</span>
        <button class="btn btn-xs btn-ghost ml-auto" @click=${input.onRefresh}>Refresh</button>
      </div>
      <div class="grid grid-cols-[minmax(240px,320px)_1fr] flex-1 min-h-0">
        <!-- Sidebar -->
        <div class="border-r border-base-300 bg-base-100 overflow-auto">
          <div class="border-b border-base-200 p-3">
            <div class="text-xs font-bold uppercase tracking-wide opacity-50 mb-2">Manifest Summary</div>
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
            <div class="text-xs font-bold uppercase tracking-wide opacity-50 mb-2">Resources</div>
            <div id="contextResourcesList" @click=${input.onResourceClick}>
              ${input.contextResourcesListHtml}
            </div>
          </div>
          <div class="p-3">
            <div class="text-xs font-bold uppercase tracking-wide opacity-50 mb-2">Skills</div>
            <div id="contextSkillsList" @click=${input.onSkillClick}>
              ${input.contextSkillsListHtml}
            </div>
          </div>
        </div>
        <!-- Main -->
        <div class="bg-base-200 overflow-auto p-3 flex flex-col gap-3">
          <div class="card bg-base-100 border border-base-300 shadow-sm">
            <div class="card-body p-3 gap-1">
              <div class="flex items-center justify-between">
                <span class="font-bold text-sm">Manifest</span>
                <span class="text-xs font-semibold ${input.manifestStatusClass}">${input.manifestStatus}</span>
              </div>
              <pre class="bg-base-200 rounded-lg p-2 text-xs font-mono whitespace-pre-wrap break-words overflow-auto">${input.manifestOutput}</pre>
            </div>
          </div>
          <div class="card bg-base-100 border border-base-300 shadow-sm">
            <div class="card-body p-3 gap-1">
              <div class="flex items-center justify-between">
                <span class="font-bold text-sm">Namespace / Scene Diff</span>
                <span class="text-xs font-semibold ${input.diffStatusClass}">${input.diffStatus}</span>
              </div>
              <div id="contextDiffOutput" class="flex flex-col gap-2">
                ${input.diffOutput}
              </div>
            </div>
          </div>
          <div class="card bg-base-100 border border-base-300 shadow-sm">
            <div class="card-body p-3 gap-1">
              <div class="flex items-center justify-between">
                <span class="font-bold text-sm">Selected Resource</span>
                <span class="text-xs font-semibold ${input.resourceStatusClass}">${input.resourceStatus}</span>
              </div>
              <pre class="bg-base-200 rounded-lg p-2 text-xs font-mono whitespace-pre-wrap break-words overflow-auto">${input.resourceOutput}</pre>
            </div>
          </div>
          <div class="card bg-base-100 border border-base-300 shadow-sm">
            <div class="card-body p-3 gap-1">
              <div class="flex items-center justify-between">
                <span class="font-bold text-sm">Selected Skill Prompt</span>
                <span class="text-xs font-semibold ${input.skillStatusClass}">${input.skillStatus}</span>
              </div>
              <pre class="bg-base-200 rounded-lg p-2 text-xs font-mono whitespace-pre-wrap break-words overflow-auto">${input.skillOutput}</pre>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}
