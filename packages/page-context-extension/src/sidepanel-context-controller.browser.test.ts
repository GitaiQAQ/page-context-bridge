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

  it('renders a concrete AI view summary instead of abstract manifest-only wording', () => {
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
    expect(text).toContain('What AI sees');
    expect(text).toContain('Preview the page context OpenCode receives before it starts working');
    expect(text).toContain('Before OpenCode acts');
    expect(text).toContain('Current Page');
    expect(text).toContain('AI Briefing');
    expect(text).toContain('Page Areas');
    expect(text).toContain('Readable Data');
    expect(text).toContain('Guided Workflows');
    expect(text).toContain(
      'OpenCode can see 4 data sources and 2 guided workflows across 3 page areas.',
    );
    expect(text).toContain('Hidden from AI');
    expect(text).toContain('Developer payload');
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
    expect(text).toContain('OpenCode can read this page data when it needs grounded evidence.');
    expect(text).toContain('Preview Data');
    expect(text).toContain('Manage Catalog Items');
    expect(text).toContain('1 resource');
    expect(text).toContain('2 tools');
    expect(text).toContain(
      'A page-provided recipe that helps OpenCode choose the right data and tools.',
    );
    expect(text).toContain('Preview Workflow');
  });
});
