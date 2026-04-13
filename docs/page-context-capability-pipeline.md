# Page Context Bridge: Capability Pipeline（实验性设计）

## 目标

把业务项目内预设的 `skills + tools + resources` 通过页面对象暴露出来，经由 `Page Context Bridge -> MCP` 标准化输出给 Agent，同时结合 `namespace` 与启用状态裁剪能力集，减少海量技能带来的决策错误。

目标链路如下：

`业务项目(skills + tools + resources) -> 页面 -> bridge -> mcp -> agent + skills`

## 设计原则

1. **页面是业务语义源头**：业务项目最了解页面状态、路由、场景和局部能力。
2. **bridge 是能力编译器**：bridge 不直接搬运原始页面对象，而是把它编译成 MCP 可消费的 `tool / resource / prompt`。
3. **Agent 只看裁剪后的能力集**：由 bridge 根据 `tab / namespace / enabled tools` 收窄暴露范围。
4. **先实验，再标准化**：当前实现优先验证路径正确性，不一次引入完整任务编排系统。

## 当前实验性模型

页面通过 `window.__pageContextBridge__` / `window.__pageContextTools__` 暴露统一对象，支持：

- `listNamespaces()`
- `getNamespace(namespace)`
- `getScene()`
- `listResources()`
- `readResource(id)`
- `listSkills()`
- `getSkill(id, input?)`
- `getManifest()`

其中：

- `tools` 仍然负责原子动作和可执行能力。
- `resources` 负责只读上下文。
- `skills` 负责描述“针对某一目标推荐读哪些资源、允许哪些工具、如何组织推理”。

## Manifest 结构

Bridge 和页面共用 `@page-context/shared-protocol` 中定义的实验性类型：

- `PageContextManifest`
- `ContextNamespaceDescriptor`
- `ContextResourceDescriptor`
- `ContextSkillDescriptor`
- `ContextSkillPrompt`

Manifest 主要包含：

- `app`：业务应用标识
- `route`：当前页面路由
- `scene`：当前场景标识
- `namespaces`：可用业务域
- `resources`：页面可读上下文对象
- `skills`：面向任务的技能描述

## Bridge 编译规则

当前 bridge 采用如下映射：

- 页面原子 tool -> MCP `tool`
- 页面 resource -> MCP `resource`
- 页面 skill -> MCP `prompt`

具体表现为：

### 1. Tool 编译

页面注册的 page tools 会被编译为：

- `tab.<tabId>.<namespace>[.<instanceId>].<tool>`

这样既保留页面内 namespace / instance 语义，又避免跨 tab 命名冲突。

### 2. Resource 编译

页面 resource 会被编译为固定资源：

- 名称：`tab.<tabId>.resource.<namespace>.<resourceId>`
- URI：`context://tab/<tabId>/resource/<namespace>/<resourceId>`

在 `read` 时由 bridge 回调 extension，再由 extension 到页面执行 `readResource(id)`。

### 3. Skill 编译

页面 skill 会被编译为 MCP `prompt`：

- 名称：`tab.<tabId>.skill.<namespace>.<skillId>`
- 参数：当前实验只提供可选 `goal`
- 返回：一条结构化 prompt message

这样 Agent 可以先读取资源，再按需取 skill prompt，最后结合少量工具执行。

## Namespace 裁剪

当前实验版复用现有的工具启用体系。

裁剪逻辑发生在 extension 侧：

1. 读取当前 tab 的启用/禁用配置。
2. 过滤 page tools。
3. 用同一套 namespace 启用状态过滤 manifest 内的：
   - `namespaces`
   - `resources`
   - `skills`
4. 进一步把 skill 的 `toolNames` 裁剪为当前真正启用的工具集合。

这意味着：

- 如果某个 namespace 被关闭，该 namespace 的 skill/resource 不会再经 bridge 暴露给 MCP。
- Agent 不会看到被裁掉的技能，从而减少错误决策。

## Example 页面实验内容

示例页当前提供：

- Namespace：`page` / `catalog` / `form` / `metrics` / `qa`
- Resource：
  - `page.summary`
  - `catalog.items`
  - `form.profile`
  - `metrics.logs`
  - `qa.suite`
- Skill：
  - `page.inspect-active-page`
  - `catalog.manage-items`
  - `form.update-profile`
  - `qa.run-smoke-suite`

这些能力会被 bridge 编译成 MCP resources/prompts，并与已有 page tools 一起工作。

## 为什么 skill 编译成 prompt，而不是直接变成 tool

当前阶段把页面 skill 编译为 MCP prompt，而不是宏工具，原因是：

1. **更安全**：先让 Agent“理解技能”，而不是直接执行复杂流程。
2. **更容易调试**：prompt 可以直接观察输出内容和裁剪结果。
3. **更适合验证效果**：先看 namespace 裁剪和 skill 推荐是否稳定，再决定哪些 skill 升级成宏工具。

后续可以把稳定 skill 再编译成宏工具，例如：

- `qa.run-smoke-suite`
- `form.update-profile`
- `catalog.manage-items`

## 与 Agent/Skills 的关系

推荐的 Agent 执行流：

1. 读 `resource` 了解当前 scene/context。
2. 从 MCP `prompt` 列表中选择最合适的 skill prompt。
3. 根据 prompt 中推荐的 `resourceIds/toolNames` 收窄工具范围。
4. 执行少量 tool。
5. 需要时再读 resource 校验结果。

也就是说：

- 页面业务项目定义原始 skill。
- Bridge 负责标准化和裁剪。
- Agent 负责基于裁剪后的能力集进行决策。

## 当前实现边界

当前是**实验性特性**，还没有做到：

- 页面 skill 自动升级为 MCP macro tool
- 多 scene 细粒度动态切换
- 独立的 skill 权重排序器
- prompt/resource 的增量通知优化
- 基于任务图的长期执行与恢复

## 后续建议

1. 为 `skill` 增加更强的元数据：`priority`、`riskLevel`、`recommendedMode`。
2. 增加 `scene detector`，让页面根据路由/DOM 状态报告更准确的 scene。
3. 把高价值 skill 编译成宏工具，低风险 skill 保持 prompt 形式。
4. 给 sidepanel 增加 `skills/resources` 调试视图，直接验证 bridge 编译结果。
5. 结合 experimental tasks，把长流程 skill 升级为可轮询 task。

## 总结

这套实验性实现验证了一个关键方向：

- 业务项目可以在页面内声明自己的 `skills + resources + tools`
- Bridge 可以把它们编译成 MCP 标准对象
- 通过 namespace 和启用状态裁剪，可以显著减少 Agent 面对的能力规模

这为后续构建“业务项目 -> 页面 -> bridge -> mcp -> agent + skills”的完整能力流水线打下了基础。
