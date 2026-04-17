# Page Context Bridge: Capability Pipeline (Experimental Design)

## Goal

Expose the preset `skills + tools + resources` within the business project through the page object, standardize output to Agent via `Page Context Bridge -> MCP`, while combining `namespace` with enabled state to trim the capability set, reducing decision errors caused by massive skills.

The target flow is as follows:

`Business Project(skills + tools + resources) -> Page -> Bridge -> MCP -> Agent + Skills`

## Design Principles

1. **Page is the Source of Business Semantics**: The business project knows best about page state, routes, scenes, and local capabilities.
2. **Bridge is a Capability Compiler**: Bridge doesn't directly transport raw page objects, but compiles them into MCP-consumable `tool / resource / prompt`.
3. **Agent Only Sees Trimmed Capability Set**: Bridge narrows the exposure scope based on `tab / namespace / enabled tools`.
4. **Experiment First, Then Standardize**: Current implementation prioritizes validating path correctness, not introducing a complete task orchestration system at once.

## Current Experimental Model

The page exposes a unified object via `window.__pageContextBridge__` / `window.__pageContextTools__`, supporting:

- `listNamespaces()`
- `getNamespace(namespace)`
- `getScene()`
- `listResources()`
- `readResource(id)`
- `listSkills()`
- `getSkill(id, input?)`
- `getManifest()`

Where:

- `tools` still handles atomic actions and executable capabilities.
- `resources` handles read-only context.
- `skills` describes "for a certain goal, which resources to read, which tools are allowed, how to organize reasoning".

## Manifest Structure

Bridge and page share experimental types defined in `@page-context/shared-protocol`:

- `PageContextManifest`
- `ContextNamespaceDescriptor`
- `ContextResourceDescriptor`
- `ContextSkillDescriptor`
- `ContextSkillPrompt`

Manifest mainly includes:

- `app`: Business application identifier
- `route`: Current page route
- `scene`: Current scene identifier
- `namespaces`: Available business domains
- `resources`: Page readable context objects
- `skills`: Task-oriented skill descriptions

## Bridge Compilation Rules

Current bridge uses the following mapping:

- Page atomic tool -> MCP `tool`
- Page resource -> MCP `resource`
- Page skill -> MCP `prompt`

Specifically:

### 1. Tool Compilation

Page registered page tools are compiled as:

- `tab.<tabId>.<namespace>[.<instanceId>].<tool>`

This preserves page-internal namespace / instance semantics while avoiding cross-tab naming conflicts.

### 2. Resource Compilation

Page resources are compiled as fixed resources:

- Name: `tab.<tabId>.resource.<namespace>.<resourceId>`
- URI: `context://tab/<tabId>/resource/<namespace>/<resourceId>`

On `read`, bridge calls back extension, which then executes `readResource(id)` on the page.

### 3. Skill Compilation

Page skills are compiled as MCP `prompts`:

- Name: `tab.<tabId>.skill.<namespace>.<skillId>`
- Parameters: Current experiment only provides optional `goal`
- Returns: A structured prompt message

This way Agent can first read resources, then get skill prompt as needed, and finally execute with a few tools.

## Namespace Trimming

Current experimental version reuses the existing tool enablement system.

Trimming logic occurs on the extension side:

1. Read current tab's enable/disable configuration.
2. Filter page tools.
3. Use the same namespace enable state to filter in manifest:
   - `namespaces`
   - `resources`
   - `skills`
4. Further trim skill's `toolNames` to the currently actually enabled tool set.

This means:

- If a namespace is disabled, that namespace's skill/resource will no longer be exposed to MCP via bridge.
- Agent won't see trimmed skills, reducing incorrect decisions.

## Example Page Experimental Content

The example page currently provides:

- Namespace: `page` / `catalog` / `form` / `metrics` / `qa`
- Resource:
  - `page.summary`
  - `catalog.items`
  - `form.profile`
  - `metrics.logs`
  - `qa.suite`
- Skill:
  - `page.inspect-active-page`
  - `catalog.manage-items`
  - `form.update-profile`
  - `qa.run-smoke-suite`

These capabilities are compiled by bridge into MCP resources/prompts and work together with existing page tools.

## Why Skills are Compiled to Prompts, Not Directly to Tools

At the current stage, page skills are compiled to MCP prompts, not macro tools, because:

1. **Safer**: Let Agent "understand the skill" first, rather than directly executing complex flows.
2. **Easier to Debug**: Prompts can directly observe output content and trimming results.
3. **Better for Validating Effects**: First see if namespace trimming and skill recommendations are stable, then decide which skills to upgrade to macro tools.

Later, stable skills can be compiled into macro tools, such as:

- `qa.run-smoke-suite`
- `form.update-profile`
- `catalog.manage-items`

## Relationship with Agent/Skills

Recommended Agent execution flow:

1. Read `resource` to understand current scene/context.
2. Select the most appropriate skill prompt from MCP `prompt` list.
3. Narrow tool scope based on recommended `resourceIds/toolNames` in prompt.
4. Execute a few tools.
5. Read resource again to verify results if needed.

In other words:

- Business project page defines original skills.
- Bridge handles standardization and trimming.
- Agent makes decisions based on the trimmed capability set.

## Current Implementation Boundaries

Currently an **experimental feature**, not yet implemented:

- Page skill auto-upgrade to MCP macro tool
- Fine-grained dynamic switching for multiple scenes
- Independent skill weight ranker
- Incremental notification optimization for prompts/resources
- Long-term execution and recovery based on task graphs

## Future Suggestions

1. Add stronger metadata for `skill`: `priority`, `riskLevel`, `recommendedMode`.
2. Add `scene detector`, let page report more accurate scenes based on route/DOM state.
3. Compile high-value skills into macro tools, low-risk skills remain as prompts.
4. Add `skills/resources` debug view to sidepanel, directly verify bridge compilation results.
5. Combine with experimental tasks, upgrade long-flow skills to pollable tasks.

## Summary

This experimental implementation validates a key direction:

- Business projects can declare their own `skills + resources + tools` within the page
- Bridge can compile them into MCP standard objects
- Through namespace and enable state trimming, the capability scale faced by Agent can be significantly reduced

This lays the foundation for subsequently building the complete capability pipeline of "Business Project -> Page -> Bridge -> MCP -> Agent + Skills".
