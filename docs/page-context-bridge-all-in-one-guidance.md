# Page Context Bridge All-in-One Integration Guide

This is an integration guide that can be directly copied to another LLM for implementing `Page Context Bridge` in **any business project page**, enabling bridge / MCP / agent to standardize consumption of page-side `tools + resources + skills`.

The goal of this document is not to explain the internal implementation details of the current repository, but to provide a **complete implementation guide for integrators**.

---

## 1. Goal

You need to implement a unified page capability object in the business page:

- `window.__pageContextBridge__`

It is used to expose:

- Atomic tools `tools` within the page
- Read-only context `resources`
- Task-oriented skill descriptions `skills`
- Page-level manifest `manifest`

Then Page Context Bridge compiles these capabilities into standard MCP output:

- Atomic tool -> MCP `tool`
- resource -> MCP `resource`
- skill -> MCP `prompt`

This way, the Agent doesn't need to directly understand the business page's internal implementation, it only needs to read the standard capabilities exposed by MCP.

---

## 2. Overall Flow

The target flow is as follows:

`Business Project(skills + tools + resources) -> Page -> Bridge -> MCP -> Agent + Skills`

Responsibility layers:

- **Business Project Page**: Declares real business semantics
- **Page Context Bridge**: Collects and standardizes these semantics
- **MCP**: Exposes standard objects to Agent
- **Agent**: Performs inference and execution based on the trimmed capability set

---

## 3. Global Object You Must Implement

The page must expose:

- `window.__pageContextBridge__`

It is also recommended to expose:

- `window.__pageContextTools__`

Both can point to the same object.

Do not use the following old names:

- `__pageDebugTools__`
- `__MCP_BRIDGE_TEST__`
- `__MCP_BRIDGE_DEMO__`

---

## 4. Minimum Interface Definition

The page object must implement at least these methods:

```ts
interface PageContextBridge {
  version: string
  listNamespaces(): string[]
  getNamespace(namespace: string): ToolNamespace | undefined

  getScene(): string
  listResources(): ContextResourceDescriptor[]
  readResource(id: string): ContextResourcePayload

  listSkills(): ContextSkillDescriptor[]
  getSkill(id: string, input?: Record<string, unknown>): ContextSkillPrompt | undefined

  getManifest(): PageContextManifest
}
```

namespace/instance/tool structure:

```ts
interface ToolNamespace {
  namespace: string
  listInstances(): string[]
  getInstance(instanceId: string): ToolInstance | undefined
}

interface ToolInstance {
  instanceId: string
  listTools(): PageToolDescriptor[]
  callTool(name: string, input?: Record<string, unknown>): unknown
}
```

---

## 5. Standard Data Structures

Please strictly align with the following structures:

```ts
interface ContextNamespaceDescriptor {
  namespace: string
  title: string
  description?: string
  tags?: string[]
}

interface ContextResourceDescriptor {
  id: string
  namespace: string
  title: string
  description?: string
  mimeType?: string
  kind?: "json" | "text"
  tags?: string[]
}

interface ContextResourcePayload {
  id: string
  mimeType?: string
  text: string
}

interface ContextSkillDescriptor {
  id: string
  namespace: string
  title: string
  description: string
  intentTags?: string[]
  resourceIds?: string[]
  toolNames?: string[]
  mode?: "analysis" | "readonly" | "mutation" | "macro"
}

interface ContextSkillPrompt {
  skill: ContextSkillDescriptor
  text: string
}

interface PageContextManifest {
  version: string
  app: string
  route: string
  scene: string
  namespaces: ContextNamespaceDescriptor[]
  resources: ContextResourceDescriptor[]
  skills: ContextSkillDescriptor[]
  generatedAt: string
}
```

---

## 6. Design Principles

### 6.1 Tools are Atomic Actions

`tools` should only perform clear, executable, well-bounded actions, such as:

- `catalog.primary.addItem`
- `form.profile.setProfile`
- `checkout.payment.submit`

Do not stuff an overly complex large process directly into a "black box tool", unless it is very stable and indeed suitable as a macro action.

### 6.2 Resources are Read-only Context

`resources` are used to expose the current page state and should not have side effects, such as:

- Current form values
- Current list items
- Page summary
- Current route scene
- Recent logs

### 6.3 Skills are Strategy Descriptions, Not Atomic Actions

The purpose of `skills` is to tell the agent:

- What this task is
- Which resources are recommended to read
- Which tools are allowed
- How to organize reasoning

At the current stage, skills should be compiled into MCP `prompts`, not directly turned into macro tools.

---

## 7. Naming Conventions

### 7.1 Namespace

Namespace should be divided by business domain, not by technical implementation, for example:

- `catalog`
- `checkout`
- `profile`
- `analytics`
- `qa`

Not recommended:

- `utils`
- `misc`
- `components`
- `service`

### 7.2 Instance

If multiple entities or context instances exist under the same namespace, use `instanceId` to distinguish, for example:

- `catalog.primary`
- `catalog.secondary`
- `checkout.shipping`
- `checkout.payment`

### 7.3 Tool Name

Tool names should be verb phrases or query phrases, for example:

- `getItems`
- `addItem`
- `removeItem`
- `setProfile`
- `submitOrder`

The final complete tool name will be:

- `namespace.instance.tool`
- Example: `catalog.primary.getItems`

### 7.4 Resource ID

Resource ID should be stable, concise, and only express "what is being read", for example:

- `catalog.items`
- `form.profile`
- `checkout.summary`
- `page.summary`

### 7.5 Skill ID

Skill ID should express clear task intent, for example:

- `catalog.manage-items`
- `form.update-profile`
- `checkout.apply-coupon`
- `qa.run-smoke-suite`

---

## 8. Behaviors the Page Must Implement

### 8.1 `listNamespaces()`

Returns the list of available namespaces on the current page.

### 8.2 `getNamespace(namespace)`

Returns the instance collection and tool collection for a namespace.

### 8.3 `getScene()`

Returns the current page scene, for example:

- `checkout-address`
- `checkout-payment`
- `catalog-list`
- `profile-edit`

Scene should be as close to user tasks as possible, not the raw route text.

### 8.4 `listResources()`

Returns declarations of all readable resources on the current page.

### 8.5 `readResource(id)`

Returns the current value based on resource ID.

Requirements:

- Return structure must include `id`
- Content is carried in the `text` field
- If it's structured data, put JSON string in `text`

### 8.6 `listSkills()`

Returns all skill descriptions on the current page.

### 8.7 `getSkill(id, input?)`

Returns a prompt text that can be directly read by the model.

This prompt should at least include:

- Skill title
- Goal description
- Recommended resources to read
- Allowed tools
- Reasoning rules / execution constraints

### 8.8 `getManifest()`

Returns the current complete manifest.

Manifest should be a unified snapshot of the current page's capabilities.

---

## 9. Minimal Page Integration Template

You can directly refer to the following template:

```ts
const pageContextBridge = {
  version: "0.1.0",

  listNamespaces() {
    return ["catalog", "form", "qa"]
  },

  getNamespace(namespace) {
    const namespaces = {
      catalog: {
        namespace: "catalog",
        listInstances: () => ["primary"],
        getInstance: (instanceId) => {
          if (instanceId !== "primary") return undefined
          return {
            instanceId: "primary",
            listTools: () => [
              {
                name: "getItems",
                description: "List catalog items",
                inputSchema: { type: "object", properties: {} },
              },
              {
                name: "addItem",
                description: "Add a catalog item",
                inputSchema: {
                  type: "object",
                  properties: { text: { type: "string" } },
                  required: ["text"],
                },
              },
            ],
            callTool(name, input = {}) {
              switch (name) {
                case "getItems":
                  return { items: getCatalogItems() }
                case "addItem":
                  return addCatalogItem(String(input.text ?? ""))
                default:
                  throw new Error(`Unknown tool: ${name}`)
              }
            },
          }
        },
      },
    }

    return namespaces[namespace]
  },

  getScene() {
    return detectSceneFromRouteAndDom()
  },

  listResources() {
    return [
      {
        id: "catalog.items",
        namespace: "catalog",
        title: "Catalog Items",
        description: "Current catalog items",
        mimeType: "application/json",
        kind: "json",
      },
    ]
  },

  readResource(id) {
    switch (id) {
      case "catalog.items":
        return {
          id,
          mimeType: "application/json",
          text: JSON.stringify({ items: getCatalogItems() }, null, 2),
        }
      default:
        throw new Error(`Unknown resource: ${id}`)
    }
  },

  listSkills() {
    return [
      {
        id: "catalog.manage-items",
        namespace: "catalog",
        title: "Manage Catalog Items",
        description: "Inspect or update catalog items",
        intentTags: ["catalog", "items", "mutation"],
        resourceIds: ["catalog.items"],
        toolNames: ["catalog.primary.getItems", "catalog.primary.addItem"],
        mode: "mutation",
      },
    ]
  },

  getSkill(id, input = {}) {
    const skill = this.listSkills().find((entry) => entry.id === id)
    if (!skill) return undefined

    const goal = typeof input.goal === "string" && input.goal ? input.goal : "Complete this business task"

    return {
      skill,
      text: [
        `You are using the Page Context Bridge skill '${skill.title}'.`,
        `Goal: ${goal}`,
        `Namespace: ${skill.namespace}`,
        `Description: ${skill.description}`,
        `Recommended resources: ${(skill.resourceIds ?? []).join(", ") || "(none)"}`,
        `Allowed tools: ${(skill.toolNames ?? []).join(", ") || "(none)"}`,
        "Rules:",
        "1. Read resources first.",
        "2. Only use allowed tools.",
        "3. Keep the plan minimal.",
      ].join("\n"),
    }
  },

  getManifest() {
    return {
      version: "0.1.0",
      app: "business-app",
      route: window.location.pathname,
      scene: this.getScene(),
      namespaces: [
        { namespace: "catalog", title: "Catalog", description: "Catalog operations" },
      ],
      resources: this.listResources(),
      skills: this.listSkills(),
      generatedAt: new Date().toISOString(),
    }
  },
}

window.__pageContextBridge__ = pageContextBridge
window.__pageContextTools__ = pageContextBridge
```

---

## 10. Skill Design Specification

Each skill should include the following information as much as possible:

- `id`
- `namespace`
- `title`
- `description`
- `intentTags`
- `resourceIds`
- `toolNames`
- `mode`

### 10.1 `mode` Suggested Values

- `analysis`
  - Analysis / interpretation oriented
  - Read-only as much as possible
- `readonly`
  - Strictly read-only
- `mutation`
  - Has state modifications
- `macro`
  - Can be considered as a candidate macro flow

### 10.2 toolNames Must Be Precise

Skills should only list **tools truly needed for this task**, do not stuff all tools from the entire namespace.

Correct:

- `form.update-profile` only lists `form.profile.getProfile`, `form.profile.setProfile`, `fill_input`

Incorrect:

- Putting all tools under `form.*` in

---

## 11. Resource Design Specification

Resources should satisfy:

- Read-only
- Easy to cache
- Stable structure
- Clear purpose

Recommended to output first:

- Page summary
- Current business object summary
- Form snapshot
- Recent logs
- List data summary

Not recommended to blindly stuff super large DOM or super large raw state tree into a single resource.

---

## 12. Scene Design Specification

`scene` is an important basis for capability trimming.

It is recommended that scene satisfies:

- User task oriented, not low-level technical state
- Fine enough, but not so fragmented that each small component has its own scene

Recommended examples:

- `catalog-list`
- `catalog-detail`
- `checkout-address`
- `checkout-payment`
- `profile-edit`

Not recommended:

- `page-1`
- `component-ready`
- `state-3`

---

## 13. Namespace Trimming Requirements

Your implementation must support namespace trimming by default.

This means:

- Page capabilities can be many, but capabilities exposed to the agent must be trimmable
- If a namespace is not in the current scene, or is configured off, its corresponding:
  - skill
  - resource
  - tool
  should all be filterable

Do not directly expose all capabilities to the agent and rely on prompt constraints.

---

## 14. What Not to Do When Integrating

### Don't Do This

- Don't only expose `tools`, completely omit `resources/skills`
- Don't stuff all business logic into a giant `runEverything()` tool
- Don't use vague namespaces, like `common`, `misc`
- Don't let `skill.toolNames` contain a bunch of unrelated tools
- Don't output unstable manifests with frequently changing field names
- Don't continue using the old name `__pageDebugTools__`

### Should Do This

- Organize namespaces by business domain
- Use resources to express page state
- Use skills to express task semantics
- Use tools to express atomic actions
- Make manifest stable, enumerable, and debuggable

---

## 15. Delivery Standard

After implementation is complete, the page should at least satisfy:

1. `window.__pageContextBridge__` exists
2. `getManifest()` returns a complete object
3. `listResources()/readResource()` works properly
4. `listSkills()/getSkill()` works properly
5. `getNamespace().getInstance().listTools()/callTool()` works properly
6. `toolNames` in skill matches actual callable tools
7. `resourceIds` in manifest matches actual resources
8. Namespace semantics are clear, non-technical naming

---

## 16. Self-check List

After completion, at least check the following items yourself:

- [ ] `window.__pageContextBridge__` is injected
- [ ] `listNamespaces()` returns namespaces matching business domains
- [ ] `getScene()` returns current task scene
- [ ] `listResources()` returns resource declarations
- [ ] `readResource(id)` can return JSON/text content
- [ ] `listSkills()` returns skill declarations
- [ ] `getSkill(id)` returns readable prompt
- [ ] `getManifest()` returns complete snapshot
- [ ] Same-name tools under same namespace with multiple instances can be correctly routed
- [ ] Skill only lists necessary tools, does not expose redundant tools
- [ ] After disabling a namespace, corresponding resources/skills/tools can be trimmed

---

## 17. Directly Executable Instructions for Another LLM

You can directly copy the following to another model:

```text
Please implement Page Context Bridge integration in the current business page.

Goals:
1. Expose window.__pageContextBridge__ on the page (can also assign to window.__pageContextTools__).
2. Implement the following methods:
   - listNamespaces()
   - getNamespace(namespace)
   - getScene()
   - listResources()
   - readResource(id)
   - listSkills()
   - getSkill(id, input?)
   - getManifest()
3. Data structures must include:
   - PageContextManifest
   - ContextNamespaceDescriptor
   - ContextResourceDescriptor
   - ContextResourcePayload
   - ContextSkillDescriptor
   - ContextSkillPrompt
4. Namespace must be divided by business domain, do not use technical naming like misc/common/utils.
5. Skill only describes tasks, do not stuff all tools in.
6. Resource is read-only, content is returned via text; structured content should return JSON string.
7. Must support multiple instances under same namespace.
8. Output minimal but complete page implementation code, and provide an actual example result of getManifest().

Constraints:
- Do not use old name __pageDebugTools__.
- Do not only implement tools, must also implement resources and skills.
- Do not introduce naming coupled with Chrome DevTools semantics.
- Prioritize reusing existing business state, routing, and DOM information to build scene/resource/skill.
```

---

## 18. Reference Points Aligned with Current Repository Implementation

If you need to compare with the current repository, you can refer to:

- Design documentation: `docs/page-context-capability-pipeline.md`
- Shared protocol types: `packages/shared-protocol/src/index.ts`
- Page example implementation: `packages/page-context-extension/src/example-page-core.ts`

---

## 19. One-sentence Summary

You are not "adding a few more tools to the page", you are doing:

- **Page Business Capability Declaration**
- **Standard Input Compilable by Bridge**
- **Context Capability Layer Understandable, Trimmable, and Dispatchable by Agent**

If you strictly follow this document, the page can smoothly integrate with Page Context Bridge.
