# Page Context Bridge All-in-One 接入文档

这是一份可以直接复制给另一个 LLM 的接入文档，用于在**任意业务项目页面**里实现 `Page Context Bridge`，并让 bridge / MCP / agent 能标准化消费页面侧的 `tools + resources + skills`。

本文档目标不是解释当前仓库的内部实现细节，而是提供一份**面向接入方**的完整实施说明。

---

## 1. 目标

你要在业务页面里实现一个统一的页面能力对象：

- `window.__pageContextBridge__`

它用于向外暴露：

- 页面内原子工具 `tools`
- 只读上下文 `resources`
- 面向任务的技能描述 `skills`
- 页面级 manifest `manifest`

然后由 Page Context Bridge 把这些能力编译成标准 MCP 输出：

- 原子 tool -> MCP `tool`
- resource -> MCP `resource`
- skill -> MCP `prompt`

这样 Agent 不需要直接理解业务页面内部实现，只需要读 MCP 暴露出的标准能力。

---

## 2. 总体链路

目标链路如下：

`业务项目(skills + tools + resources) -> 页面 -> bridge -> mcp -> agent + skills`

职责分层：

- **业务项目页面**：声明真实业务语义
- **Page Context Bridge**：采集并标准化这些语义
- **MCP**：向 Agent 暴露标准对象
- **Agent**：基于裁剪后的能力集做推理和执行

---

## 3. 你必须实现的全局对象

页面必须暴露：

- `window.__pageContextBridge__`

推荐同时暴露：

- `window.__pageContextTools__`

两者可以指向同一个对象。

不要使用以下旧名字：

- `__pageDebugTools__`
- `__MCP_BRIDGE_TEST__`
- `__MCP_BRIDGE_DEMO__`

---

## 4. 最小接口定义

页面对象至少要实现这些方法：

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

namespace/instance/tool 结构：

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

## 5. 标准数据结构

请严格对齐以下结构：

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

## 6. 设计原则

### 6.1 tools 是原子动作

`tools` 应该只做清晰、可执行、边界明确的动作，例如：

- `catalog.primary.addItem`
- `form.profile.setProfile`
- `checkout.payment.submit`

不要把一个过于复杂的大流程直接塞成一个“黑盒工具”，除非它非常稳定且确实适合作为宏动作。

### 6.2 resources 是只读上下文

`resources` 用于暴露页面当前状态，不应该带副作用，例如：

- 当前表单值
- 当前列表项
- 页面摘要
- 当前路由场景
- 最近日志

### 6.3 skills 是策略描述，不是原子动作

`skills` 的作用是告诉 agent：

- 这个任务是什么
- 推荐读哪些 resources
- 允许用哪些 tools
- 应该如何组织推理

skill 当前阶段建议先编译成 MCP `prompt`，而不是直接变成宏工具。

---

## 7. 命名规范

### 7.1 namespace

namespace 应该按业务域划分，而不是按技术实现划分，例如：

- `catalog`
- `checkout`
- `profile`
- `analytics`
- `qa`

不推荐：

- `utils`
- `misc`
- `components`
- `service`

### 7.2 instance

同一个 namespace 下如果存在多个实体或上下文实例，用 `instanceId` 区分，例如：

- `catalog.primary`
- `catalog.secondary`
- `checkout.shipping`
- `checkout.payment`

### 7.3 tool name

tool 名称建议是动词短语或查询短语，例如：

- `getItems`
- `addItem`
- `removeItem`
- `setProfile`
- `submitOrder`

最终完整工具名会是：

- `namespace.instance.tool`
- 例如：`catalog.primary.getItems`

### 7.4 resource id

resource id 建议稳定、简洁、只表达“读取的对象”是什么，例如：

- `catalog.items`
- `form.profile`
- `checkout.summary`
- `page.summary`

### 7.5 skill id

skill id 建议表达明确任务意图，例如：

- `catalog.manage-items`
- `form.update-profile`
- `checkout.apply-coupon`
- `qa.run-smoke-suite`

---

## 8. 页面必须实现的行为

### 8.1 `listNamespaces()`

返回当前页面可用的 namespace 列表。

### 8.2 `getNamespace(namespace)`

返回某个 namespace 对应的实例集合与工具集合。

### 8.3 `getScene()`

返回当前页面场景，例如：

- `checkout-address`
- `checkout-payment`
- `catalog-list`
- `profile-edit`

scene 应该尽量贴近用户任务，而不是路由原文。

### 8.4 `listResources()`

返回当前页面所有可读 resource 的声明。

### 8.5 `readResource(id)`

根据资源 id 返回当前值。

要求：

- 返回结构必须包含 `id`
- 内容统一用 `text` 字段承载
- 如果是结构化数据，`text` 里放 JSON 字符串

### 8.6 `listSkills()`

返回当前页面所有技能描述。

### 8.7 `getSkill(id, input?)`

返回一个可直接给模型看的 prompt 文本。

这个 prompt 应至少包含：

- skill 标题
- 目标描述
- 推荐读取的资源
- 允许使用的工具
- 推理规则/执行约束

### 8.8 `getManifest()`

返回当前完整 manifest。

manifest 应该是对当前页面能力的统一快照。

---

## 9. 页面侧最小接入模板

可以直接参考下面模板：

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

    const goal = typeof input.goal === "string" && input.goal ? input.goal : "完成该业务任务"

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

## 10. skill 设计规范

每个 skill 应尽量包含以下信息：

- `id`
- `namespace`
- `title`
- `description`
- `intentTags`
- `resourceIds`
- `toolNames`
- `mode`

### 10.1 `mode` 建议值

- `analysis`
  - 偏分析/解释
  - 尽量只读
- `readonly`
  - 严格只读
- `mutation`
  - 有状态修改
- `macro`
  - 可视为候选宏流程

### 10.2 toolNames 必须精准

skill 里只应该列出**本任务真正需要的工具**，不要把整个 namespace 的所有工具都塞进去。

正确：

- `form.update-profile` 只列 `form.profile.getProfile`、`form.profile.setProfile`、`fill_input`

错误：

- 把 `form.*` 下所有工具都放进去

---

## 11. resource 设计规范

resource 应该满足：

- 只读
- 易缓存
- 结构稳定
- 有明确用途

推荐优先输出：

- 页面摘要
- 当前业务对象摘要
- 表单快照
- 最近日志
- 列表数据摘要

不建议把超大 DOM、超大原始状态树无脑塞进单个 resource。

---

## 12. scene 设计规范

`scene` 是能力裁剪的重要依据。

建议 scene 满足：

- 面向用户任务，而不是底层技术状态
- 足够细，但不要碎到每个小组件一个 scene

推荐示例：

- `catalog-list`
- `catalog-detail`
- `checkout-address`
- `checkout-payment`
- `profile-edit`

不推荐：

- `page-1`
- `component-ready`
- `state-3`

---

## 13. namespace 裁剪要求

你的实现必须默认支持 namespace 裁剪。

这意味着：

- 页面能力可以很多，但对外暴露给 agent 的能力必须可裁剪
- 如果某个 namespace 不在当前场景中，或者被配置关闭，它对应的：
  - skill
  - resource
  - tool
  应该都能被过滤

不要把全部能力直接暴露给 agent 再靠提示词约束。

---

## 14. 接入时不要做的事

### 不要这样做

- 不要只暴露 `tools`，完全不暴露 `resources/skills`
- 不要把页面所有业务逻辑都塞进一个巨大的 `runEverything()` 工具
- 不要用模糊 namespace，比如 `common`、`misc`
- 不要让 `skill.toolNames` 包含一大坨无关工具
- 不要输出不稳定、会频繁变化字段名的 manifest
- 不要继续使用旧名字 `__pageDebugTools__`

### 应该这样做

- 用业务域组织 namespace
- 用 resource 表达页面状态
- 用 skill 表达任务语义
- 用 tool 表达原子动作
- 让 manifest 稳定、可枚举、可调试

---

## 15. 交付标准

实现完成后，页面应至少满足：

1. `window.__pageContextBridge__` 存在
2. `getManifest()` 返回完整对象
3. `listResources()/readResource()` 可正常工作
4. `listSkills()/getSkill()` 可正常工作
5. `getNamespace().getInstance().listTools()/callTool()` 可正常工作
6. skill 中的 `toolNames` 与实际可调用工具一致
7. manifest 中的 `resourceIds` 与实际资源一致
8. namespace 语义清晰，非技术性命名

---

## 16. 自测清单

你完成后，至少自行检查下面这些项：

- [ ] `window.__pageContextBridge__` 已注入
- [ ] `listNamespaces()` 返回符合业务域的 namespace
- [ ] `getScene()` 返回当前任务场景
- [ ] `listResources()` 返回资源声明
- [ ] `readResource(id)` 能返回 JSON/text 内容
- [ ] `listSkills()` 返回技能声明
- [ ] `getSkill(id)` 返回可读 prompt
- [ ] `getManifest()` 返回完整快照
- [ ] 同 namespace 多 instance 的同名工具可以正确路由
- [ ] skill 只列出必要工具，不暴露冗余工具
- [ ] 关闭某 namespace 后，对应资源/技能/工具可被裁剪

---

## 17. 给另一个 LLM 的可直接执行指令

你可以把下面这段直接复制给另一个模型：

```text
请在当前业务页面实现 Page Context Bridge 接入。

目标：
1. 在页面上暴露 window.__pageContextBridge__（可同时赋值给 window.__pageContextTools__）。
2. 实现以下方法：
   - listNamespaces()
   - getNamespace(namespace)
   - getScene()
   - listResources()
   - readResource(id)
   - listSkills()
   - getSkill(id, input?)
   - getManifest()
3. 数据结构必须包含：
   - PageContextManifest
   - ContextNamespaceDescriptor
   - ContextResourceDescriptor
   - ContextResourcePayload
   - ContextSkillDescriptor
   - ContextSkillPrompt
4. namespace 必须按业务域划分，不要使用 misc/common/utils 这类技术性命名。
5. skill 只描述任务，不要把所有工具都塞进去。
6. resource 只读，内容统一通过 text 返回；结构化内容请返回 JSON 字符串。
7. 同 namespace 多 instance 的场景必须支持。
8. 输出最小但完整的页面实现代码，并给出一个 getManifest() 的实际示例结果。

约束：
- 不要使用旧名字 __pageDebugTools__。
- 不要只实现 tools，必须同时实现 resources 和 skills。
- 不要引入与 Chrome DevTools 语义耦合的命名。
- 优先复用现有业务状态、路由和 DOM 信息来构建 scene/resource/skill。
```

---

## 18. 与当前仓库实现对齐的参考点

如果需要对照当前仓库，可参考：

- 设计说明：`docs/page-context-capability-pipeline.md`
- 共享协议类型：`packages/shared-protocol/src/index.ts`
- 页面示例实现：`packages/chrome-mcp-extension/src/example-page-core.ts`

---

## 19. 一句话总结

你不是在做“给页面多加几个工具”，而是在做：

- **页面业务能力声明**
- **可被 bridge 编译的标准输入**
- **能被 agent 理解、裁剪、调度的上下文能力层**

如果你严格按这份文档做，页面就能平滑接入 Page Context Bridge。 
