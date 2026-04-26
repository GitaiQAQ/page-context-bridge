import { html, render } from 'lit';
import { afterEach, describe, expect, it } from 'vitest';

import { renderContextTab } from './sidepanel-context-controller';
import {
  renderContextNamespaceCard,
  renderContextResourceCard,
  renderContextSkillCard,
} from './sidepanel-context-panel';

describe('renderContextTab', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders a concrete page capabilities summary instead of abstract manifest-only wording', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);

    render(
      renderContextTab({
        active: true,
        contextAppValue: 'crm',
        contextSceneValue: 'lead_detail',
        contextTabValue: '12',
        contextRouteValue: '/lead/42',
        contextNamespaceCount: '3',
        contextResourceCount: '4',
        contextSkillCount: '2',
        contextNamespacesListHtml: html`<div>namespace-card</div>`,
        contextResourcesListHtml: html`<div>resource-card</div>`,
        contextSkillsListHtml: html`<div>skill-card</div>`,
        manifestStatus: 'Loaded',
        manifestStatusClass: 'text-success',
        manifestOutput: '{}',
        diffStatus: 'No diff',
        diffStatusClass: 'opacity-60',
        diffOutput: html`<div>diff</div>`,
        resourceStatus: 'Idle',
        resourceStatusClass: 'opacity-60',
        resourceOutput: 'payload',
        skillStatus: 'Idle',
        skillStatusClass: 'opacity-60',
        skillOutput: 'prompt',
        onRefresh: () => undefined,
        onResourceClick: () => undefined,
        onSkillClick: () => undefined,
      }),
      host,
    );

    const text = host.textContent ?? '';
    expect(text).toContain('Page Capabilities');
    expect(text).toContain(
      'Operational briefing for what this page can expose to the bridge right now',
    );
    expect(text).toContain('Agent Briefing');
    expect(text).toContain('Page Identity');
    expect(text).toContain('Exposure Snapshot');
    expect(text).toContain('Business Domains');
    expect(text).toContain('Available Data');
    expect(text).toContain('Available Workflows');
    expect(text).toContain(
      'Bridge sees 4 data resources and 2 runnable skills across 3 namespaces.',
    );
    expect(text).toContain('Capability Filters');
    expect(text).toContain('Raw Manifest');
    expect(text).toContain('3');
    expect(text).toContain('4');
    expect(text).toContain('2');
  });

  it('renders namespace, resource, and skill cards with concrete capability metadata', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);

    render(
      html`
        ${renderContextNamespaceCard({
          namespace: 'catalog',
          title: 'Catalog',
          description: 'Catalog manipulation and seed fixtures',
          tags: ['mutation', 'items'],
        })}
        ${renderContextResourceCard({
          id: 'catalog.items',
          namespace: 'catalog',
          title: 'Catalog Items',
          description: 'Current item list and counts for the catalog fixture',
          kind: 'json',
          mimeType: 'application/json',
          tags: ['items'],
        })}
        ${renderContextSkillCard({
          id: 'catalog.manage',
          namespace: 'catalog',
          title: 'Manage Catalog Items',
          description: 'Review and update the current catalog fixture safely.',
          intentTags: ['mutation', 'review'],
          resourceIds: ['catalog.items'],
          toolNames: ['catalog.list', 'catalog.update'],
          mode: 'mutation',
        })}
      `,
      host,
    );

    const text = host.textContent ?? '';
    expect(text).toContain('Catalog');
    expect(text).toContain('Catalog manipulation and seed fixtures');
    expect(text).toContain('mutation');
    expect(text).toContain('Catalog Items');
    expect(text).toContain('application/json');
    expect(text).toContain('Agents can inspect this payload directly from the current page state.');
    expect(text).toContain('Inspect Payload');
    expect(text).toContain('Manage Catalog Items');
    expect(text).toContain('1 resource');
    expect(text).toContain('2 tools');
    expect(text).toContain(
      'Uses page-grounded context before the agent expands into tools or workflows.',
    );
    expect(text).toContain('Inspect Skill');
  });
});
