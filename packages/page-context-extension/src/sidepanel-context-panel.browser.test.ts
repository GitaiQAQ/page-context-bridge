import { render } from 'lit';
import { afterEach, describe, expect, it } from 'vitest';

import type { PageContextManifest } from '@page-context/shared-protocol';
import type { ContextManifestFilterDebug } from './context-manifest-filter-debug';
import { renderContextDiffPanel, renderContextManifestPanel } from './sidepanel-context-panel';

const exampleRawManifest: PageContextManifest = {
  version: '0.1.0',
  app: 'example',
  route: '/fixtures/catalog',
  scene: 'example-fixture',
  generatedAt: '2026-01-01T00:00:00.000Z',
  namespaces: [
    {
      namespace: 'catalog',
      title: 'Catalog',
      description: 'Catalog manipulation and seed fixtures',
      tags: ['mutation', 'items'],
    },
    {
      namespace: 'qa',
      title: 'QA',
      description: 'Smoke suite and fixture reset workflows',
      tags: ['macro', 'qa'],
    },
  ],
  resources: [
    {
      id: 'catalog.items',
      namespace: 'catalog',
      title: 'Catalog Items',
      description: 'Current item list and counts for the catalog fixture',
      mimeType: 'application/json',
      kind: 'json',
      tags: ['items'],
    },
    {
      id: 'qa.suite',
      namespace: 'qa',
      title: 'QA Suite Summary',
      description: 'Smoke suite summary and fixture state',
      mimeType: 'application/json',
      kind: 'json',
      tags: ['qa'],
    },
  ],
  skills: [
    {
      id: 'catalog.manage-items',
      namespace: 'catalog',
      title: 'Manage Catalog Items',
      description:
        'Inspect, add, remove, or seed catalog fixture items using instance-specific tools.',
      intentTags: ['catalog', 'items', 'mutation'],
      resourceIds: ['catalog.items'],
      toolNames: [
        'catalog.primary.getItems',
        'catalog.primary.addItem',
        'catalog.primary.removeItem',
        'catalog.secondary.seedItems',
      ],
      mode: 'mutation',
    },
    {
      id: 'qa.run-smoke-suite',
      namespace: 'qa',
      title: 'Run Smoke Suite',
      description: 'Execute the example smoke suite and interpret its results.',
      intentTags: ['qa', 'smoke', 'verify'],
      resourceIds: ['qa.suite'],
      toolNames: ['qa.smoke.runSuite', 'qa.smoke.resetFixture', 'get_console_logs'],
      mode: 'macro',
    },
  ],
};

const exampleEffectiveManifest: PageContextManifest = {
  ...exampleRawManifest,
  namespaces: [exampleRawManifest.namespaces[0]!],
  resources: [exampleRawManifest.resources[0]!],
  skills: [
    {
      ...exampleRawManifest.skills[0]!,
      toolNames: [
        'catalog.primary.getItems',
        'catalog.primary.addItem',
        'catalog.primary.removeItem',
      ],
    },
  ],
};

const exampleDebug: ContextManifestFilterDebug = {
  hiddenNamespaces: [{ id: 'qa', reason: 'namespace_disabled' }],
  hiddenResources: [{ id: 'qa.suite', reason: 'namespace_disabled' }],
  hiddenSkills: [{ id: 'qa.run-smoke-suite', reason: 'namespace_disabled' }],
  trimmedSkillTools: [
    {
      skillId: 'catalog.manage-items',
      removedTools: [{ id: 'catalog.secondary.seedItems', reason: 'page_tool_disabled' }],
    },
  ],
};

describe('sidepanel-context-panel', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders realistic manifest capabilities using example-style resources and skills', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);

    render(renderContextManifestPanel(exampleRawManifest, exampleEffectiveManifest, 12), host);

    const text = host.textContent ?? '';
    expect(text).toContain('example');
    expect(text).toContain('example-fixture');
    expect(text).toContain('/fixtures/catalog');
    expect(text).toContain('12');
    expect(text).toContain('Catalog Items');
    expect(text).toContain('application/json');
    expect(text).toContain('OpenCode can read this page data when it needs grounded evidence.');
    expect(text).toContain('Preview Data');
    expect(text).toContain('Manage Catalog Items');
    expect(text).toContain('mutation');
    expect(text).toContain('1 resource');
    expect(text).toContain('3 tools');
    expect(text).toContain('Preview Workflow');
  });

  it('renders diff output with concrete filter reasons and trimmed tools', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);

    render(
      renderContextDiffPanel(exampleRawManifest, exampleEffectiveManifest, exampleDebug),
      host,
    );

    const text = host.textContent ?? '';
    expect(text).toContain('Diff detected');
    expect(text).toContain('Namespaces');
    expect(text).toContain('Raw: 2 · Effective: 1');
    expect(text).toContain('qa');
    expect(text).toContain('disabled by namespace');
    expect(text).toContain('Skill Tool Trimming');
    expect(text).toContain('catalog.manage-items');
    expect(text).toContain('catalog.secondary.seedItems');
    expect(text).toContain('disabled by page tool filter');
    expect(text).toContain('Scene is unchanged.');
  });
});
