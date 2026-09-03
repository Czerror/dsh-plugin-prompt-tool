# dsh-plugin-prompt-tool 工具契约、子代理工具策略与预设工具面计划

> 日期：2026-09-02
> 分支：`dev`
> 基线：`77c1a9e`（实现代码自 `e3433da` 后未变化）
> 状态：已实施并于 2026-09-03 完成复验修复（Wave 1-6 完成）
> 合并：旧 L2 计划已全部落地；本版本完整保留 `ececbd1` 版 PLAN.md 的全部未实施项，并在其上扩展子代理实例级工具策略。
> 参考：`D:\AI\GitHub\dsh-plugins@05c50f3`、`D:\AI\GitHub\deepseek-harness@4e84901`（DSH `0.1.2-alpha.4`）。

## 一、最终目标

本轮一次完成以下能力，不拆成互不兼容的临时版本：

1. **自定义工具标准化**
   - `customTools` 生成完整、合法的官方 ToolDefinition。
   - 参数和输出 Schema 经官方 `dsh-tools` 转换。
   - delegate 经真实 ToolRuntime 嵌套调度。
2. **主代理与子代理工具权限分离**
   - 主代理继续使用现有 `toolFilterAllow` / `toolFilterDeny`。
   - 子代理使用独立的实例级策略，不再复用主代理列表。
3. **每个子代理实例单独配置**
   - 每次 `subagent` / `subagent_fork` 调用独立解析角色、任务、工具档和附加工具。
   - 实际 toolFilter 在子代理创建窗口冻结并生效。
4. **按角色卡配置不同工具集**
   - UI 将角色卡 id 绑定到工具档。
   - 模型调用子代理时可选择已授权角色卡绑定。
5. **按任务类型动态切换工具集**
   - 支持显式 `task_type`。
   - 未显式声明时按有序正则规则确定性分类。
6. **模型可在调用子代理时自行扩大工具权限**
   - 模型可请求 `additional_tools`。
   - 扩权严格限制在用户配置的 ceiling 和 expansion allow-list 内。
   - 可配置人工批准；无批准通道时 fail closed。
7. **工具面可观测**
   - UI 展示当前主会话实际工具面。
   - UI 可预览每个子代理工具档和一次实例选择的最终工具集。
   - 已创建的本地子代理可查询实际工具面。

核心产品定义：

> `customTools` 是声明式工具构建器；`subagentToolPolicy` 是实例级工具授权策略；复杂能力仍通过 Cordis 模块接入。模型只能在用户给定的能力上限内选择和扩权，不能自行突破 Host、preset、provider 或 approval 边界。

## 二、明确排除

- 不修改 DeepSeek Harness 源码。
- 不把任意 JavaScript 代码嵌入 YAML。
- 不增加 `execute.kind: javascript` 或任意 npm import 逃生口。
- 不替换 `preset.yml → modules/moduleConfigs/params → agent.cordis.yml` 编译链。
- 不提供任意 `agent.cordis.yml` 通用编辑器。
- 不把 `customTools`、工具策略或预设行为源迁移到官方 `agentPresets` Remote。
- 不复制旧 `dsh-plugins/preset-builder` 的 `connection.api` / `agentPresets.mutate` 接口，也不新增通用 preset/plugin JSON mutation。
- 不让模型修改 ceiling、profile、角色绑定或任务规则。
- 不允许运行中的子代理热增权；实例工具集在创建时冻结。需要更高权限时创建新实例。
- 不承诺 ACP 等 `toolFilter: false` provider 支持实例工具策略；provider 不支持时 fail loud。
- 不为本轮增加 PTY、持久 stdin、数据库连接池、后台 Job、定时器或调度型自定义执行器。
- 不开放工具并发配置；未声明 `isConcurrencySafe` 时保持官方独占执行。
- 不增加跨标签页 revision fencing；出现真实并发覆盖问题后另立计划。

## 三、已确认事实

### 3.1 当前 customTools 不是合法的完整 ToolDefinition

`engine/tool-config-engine.mjs` 当前直接把配置 DSL 注册到 `ctx.tools.register()`：

- 有参数工具把 `{ text: { type: string, required: true } }` 原样暴露给模型，而不是 JSON Schema object。
- 无参数工具省略 `parameters`，真实 `ctx.tools.schemas()` 会报错。
- `output.schema` 也绕过官方 ValueSchemaSpec 转换。

已在隔离目录使用真实 `Context + SystemPrompt + ToolRuntime` 复现：

```text
tool "no_args" parameters must be lossless JSON before schema projection
```

现有 `makeCtx()` 测试只捕获“对象是否注册”，不足以证明工具能进入真实模型目录或通过真实输入/输出校验。

### 3.2 当前 delegate 绕过官方工具管线

当前 delegate 通过 `tools.get(name).execute()` 直接调用目标实现，绕过：

- 参数与输出校验；
- allow/deny/ask 和 approval；
- pre/execute/post waterfall；
- timeout policy；
- nested token、rootCallId 和 durable result；
- additionalContexts 与 concludesTurn。

### 3.3 当前主/子代理过滤实际上没有分离

现有参数桥把同一组：

```text
toolFilterAllow
toolFilterDeny
```

同时写给：

```text
主代理 tool-filter
子代理 delegation.toolFilter
```

`toolFilterSubagents` 只控制额外的 system-prompt assembly mask，但子代理的官方 `delegation.toolFilter` 已经使用主代理列表。因此当前“子代理同过滤”关闭并不等于子代理不受主代理列表影响。

### 3.4 官方已经提供正确的 per-child 授权 seam

DSH `SubagentStartRequest.toolFilter` 的契约是：

- provider 必须声明 `capabilities.toolFilter`；
- in-process provider 在子代理创建窗口调用 scoped `tools.restrict()`；
- 被过滤工具同时从 prompt 消失并拒绝执行；
- 未知工具名启动失败；
- `spawn` / `fork` 支持，ACP 不支持。

官方 `@deepseek-ai/dsh-tool-subagent` 当前只接受静态 `config.toolFilter`，模型参数没有 per-call toolFilter。因此本项目不能通过 config patch 实现实例级工具集，需要在 agent scope 注册一个同名 shadow 工具，并通过公开 `ctx.subagents` seam 创建子代理。

### 3.5 角色卡和任务分类已有可复用基础

- 角色卡库已有稳定 card id、名称、描述和 `/characters-list` 数据源。
- 角色卡写入后已走现有 preset rebuild 路径。
- `engine/classify-task.mjs` 已是任务分类单一来源，可扩展通用有序规则，不另建第二套正则分类器。

### 3.6 `ececbd1` 未实施项合并审计

截至 `77c1a9e`，`git diff e3433da..77c1a9e -- ':!PLAN.md'` 为空，因此 `ececbd1` 的四个 Wave 均仍未实施，必须完整进入现计划：

| `ececbd1` 未实施项 | 合并位置 | 状态 |
|---|---|---|
| ToolDefinition 参数/输出 Schema、真实 registry 测试、disposer | Wave 1、13.1 | 待实施 |
| delegate nested dispatch、结果映射、上下文/终止传播 | Wave 2、13.2 | 待实施 |
| 当前存活会话工具面、动态服务等待、只读 UI、稳定错误 | 9.4、Wave 3、Wave 5、13.5 | 待实施 |
| customTools 单一来源、生成物边界、旧客户端接口禁用、文档收口 | 本节、Wave 6、13.6 | 待实施 |
| `customTools.scope` 显式拒绝 | 10.4、Wave 1 | 待实施 |

合并原则：扩展后的子代理工具策略不能替代或弱化上述基础工作；每一项仍保留独立验收断言。

## 四、目标配置契约

新增 `preset.yml` 顶层领域段：

```yaml
subagentToolPolicy:
  defaultProfile: base

  # 用户定义的绝对能力上限；任何 profile、角色、任务和模型扩权都不能越界。
  ceiling:
    allow: [read, write, edit, glob, grep, bash, web_search]
    deny: [dangerous_tool]

  profiles:
    - id: base
      name: 基础
      allow: [read, glob, grep]
      deny: []
      modelSelectable: false

    - id: researcher
      name: 研究
      allow: [read, glob, grep, web_search]
      deny: [write, bash]
      modelSelectable: true

    - id: coder
      name: 编码
      allow: [read, write, edit, glob, grep, bash]
      deny: []
      modelSelectable: true

  characterBindings:
    - characterId: analyst
      profile: researcher
      modelSelectable: true

    - characterId: developer
      profile: coder
      modelSelectable: true

  taskRules:
    - id: research
      name: 资料研究
      pattern: '(research|调研|搜索|资料|文档)'
      profile: researcher
      order: 100
      modelSelectable: true

    - id: implementation
      name: 编码实现
      pattern: '(implement|build|实现|开发|修复)'
      profile: coder
      order: 200
      modelSelectable: true

  modelExpansion:
    enabled: true
    allow: [web_search, bash]
    maxAdditionalTools: 2
    requireApproval: true
```

约束：

- `defaultProfile` 必须存在。
- profile / task / character id 唯一。
- profile allow/deny、expansion allow 必须是 ceiling allow 的子集。
- ceiling deny 永远优先，不能通过任何 selector 或 additional_tools 恢复。
- `modelSelectable: false` 的 profile/角色/任务不进入模型工具 Schema enum。
- `modelExpansion.enabled: false` 时工具参数中完全不出现 `additional_tools`。
- `maxAdditionalTools` 为非负安全整数；0 等同关闭扩权参数。
- 任务正则在保存时编译验证，非法规则拒绝整次保存。
- 空 allow 是合法的零工具档；空 ceiling allow 非法。
- `subagentToolPolicy` 缺失时完全保持官方 delegation 行为。

`subagentToolPolicy` 是复杂领域配置，不塞入扁平 `params`；`params` 继续只承载现有基础引擎参数。

## 五、实例级解析算法

模型可见的扩展参数按策略动态生成：

```text
tool_profile      可选；只列出 modelSelectable profile
character_id      可选；只列出 modelSelectable character binding
task_type         可选；只列出 modelSelectable task rule
additional_tools  可选；只在 modelExpansion 开启时出现
restrict_tools    可选；模型始终可以进一步收紧本实例
```

固定选择优先级：

```text
显式 tool_profile
    > 显式 character_id 绑定
    > 显式 task_type
    > description + prompt 自动任务分类
    > defaultProfile
```

若同时传入多个 selector，按上述优先级取一个基础 profile，并在工具结果中回显被采用和被忽略的 selector，避免静默歧义。

有效工具集算法：

```text
presetAvailable = 当前 preset scope 可解析的继承工具名
baseAllow       = selectedProfile.allow
requestedAdd    = additional_tools
requestedDeny   = restrict_tools

validatedAdd = requestedAdd
  ∩ modelExpansion.allow
  ∩ ceiling.allow
  ∩ presetAvailable

effectiveAllow = (baseAllow ∪ validatedAdd)
  ∩ ceiling.allow
  ∩ presetAvailable
  - selectedProfile.deny
  - requestedDeny
  - ceiling.deny
```

最终传给官方 `SubagentStartRequest.toolFilter`：

```ts
{ allow: effectiveAllow }
```

规则：

- deny 永远优先。
- 不把父代理当前可见集当作 ceiling；用户可以明确配置“主代理不可见、特定子代理可见”的工具。
- ceiling 来自用户预设，是模型扩权的硬上限。
- Host sandbox、approval、工具自身 policy 和 provider capability 继续拥有最终权威。
- 子代理自身注册的报告/输出工具按官方 scope 语义保留，不由继承工具 allow-list错误删除。
- 实例创建后不热更新 effectiveAllow；UI 修改只影响后续实例。

## 六、运行时模块设计

### 通用工具架构不变量（继承 `ececbd1`）

自定义工具链保持：

```text
preset.yml customTools
        ↓ writePreset
custom-tools/*.yml
        ↓ tool-config-engine
官方 ToolDefinition
        ↓ ctx.tools registry
Agent 实际工具面
```

约束：

- `preset.yml` 仍是 customTools 唯一行为源；`custom-tools/*.yml` 与 `agent.cordis.yml` 都是生成物。
- 不增加第二个可编辑工具源或通用原始 YAML 写入入口。
- 保存 delegate 工具时，现有 `customToolModules()` 继续自动补齐 character-tools、world-book-tools 和 session-var-tools。
- 优先从运行中的 DSH 入口通过 `process.argv[1]` + `createRequire()` 解析同一份 `@deepseek-ai/dsh-tools`，复用 `defineTool()` 或官方 Schema 转换函数，避免 link/生成目录加载另一份 Host 依赖。
- 若隔离 smoke 证明运行时解析不可用，才把 Schema 转换移动到 host 侧物化阶段；host 侧仍调用官方转换器，不复制其实现。
- 自定义工具注册 disposer 继续归属 preset/agent scope，卸载时必须撤销。

实际工具面只从运行态读取：

```text
Host 全局工具
+ 当前 preset 工具
+ agent-scoped 工具与 restriction
+ 当前 presentation/filter 状态
= 当前会话实际工具面
```

不静态推导或挂载未激活预设，因为结果还受 Host bundle、Agent scope、tool-filter、bootstrap/stage 和 preset generation 影响。

### 6.1 深模块：subagent tool policy resolver

新增纯策略模块：

```text
engine/subagent-tool-policy-core.mjs
```

小接口：

```js
validateSubagentToolPolicy(rawPolicy, context)
compileSubagentToolPolicy(rawPolicy)
resolveSubagentToolPolicy(compiledPolicy, request, availableTools)
buildSubagentToolParameters(compiledPolicy)
```

该模块隐藏：

- 唯一性与引用校验；
- ceiling 子集校验；
- task regex 编译与稳定排序；
- selector 优先级；
- expansion/deny 合并；
- 模型可见 enum 生成；
- 预览与运行时结果同构。

Host bridge、运行时工具和测试都跨同一 seam，禁止在 UI、bridge、tool execute 中复制解析算法。

### 6.2 Agent-scoped shadow 工具

新增：

```text
engine/subagent-tool-policy.mjs
engine/compositions/source/local/subagent-tool-policy.yml
```

不删除官方 `delegation` / `delegation-ptc` 模块。新模块在使用该 preset 的每个 Agent scope 注册：

```text
subagent
subagent_fork
```

同名 agent-local 工具 shadow 预设层官方工具；官方工具仍提供：

- fallback；
- `list_subagent_models`；
- control/list-agents/send-message 等其他工具；
- 未启用策略预设的原行为。

生命周期：

- 监听该 preset generation 下的 `agent/created`；
- 在 `agent.ctx.effect` 注册同名工具；
- 主代理和子代理均可获得 shadow，是否对模型可见仍受 effective toolFilter 与 maxDepth 控制；
- Agent、preset generation 或插件卸载时自动释放；
- 不能注册到 Host 全局层；
- 两个不同 preset generation 的 policy 不得串用。

### 6.3 模型工具参数

保持官方参数并扩展：

```text
description
prompt
provider?            spawn 工具保留；fork 不开放
model?               spawn 工具保留；fork 不开放
reasoning_effort?     spawn 工具保留；fork 不开放
run_in_background?
tool_profile?
character_id?
task_type?
additional_tools?
restrict_tools?
```

参数 enum 和 maxItems 由 compiled policy 生成。未开启的能力不出现在 Schema 中，而不是运行时收到后忽略。

### 6.4 子代理启动

运行时只调用公开 seam：

- foreground one-shot：`ctx.subagents.start(provider, request)`；
- continuable background：`ctx.subagents.startContinuable({ provider, label, request })`；
- one-shot background 仅在未来显式启用对应 provider 时接入 `ctx.jobs`，本轮内置 spawn/fork 继续 continuable；
- request 携带 `toolFilter`、`agentOptions`、`maxDepth`、`parent` 和 `signal`。

必须保持官方当前行为：

- spawn 允许 provider/model/reasoning effort 选择并做 LLM route preflight；
- fork 固定继承父路由，保持 KV Cache 语义；
- `run_in_background` 默认与现有 continuable 工具一致；
- foreground run 始终在 finally 中 dispose；
- provider 不支持 toolFilter 时启动前失败；
- maxDepth 继续由官方 subagent runtime 校验。

### 6.5 模型扩权批准

当 `additional_tools` 非空：

1. 校验数量、enum、ceiling、presetAvailable。
2. `requireApproval: true` 时调用 approval seam。
3. approval reason 明确列出：
   - parent session；
   - selected profile；
   - character/task selector；
   - 请求增加的工具；
   - 最终 effective allow。
4. 无 approval 服务、拒绝或取消时不创建子代理。
5. `requireApproval: false` 表示用户已通过 preset 预授权 expansion allow-list；仍不能越过 ceiling。

选择 `modelSelectable` profile/角色/任务属于预授权，不重复 approval；只有 `additional_tools` 触发扩权批准。

### 6.6 结果与审计

工具结果保留官方 foreground/background 结果，并增加小型策略摘要：

```json
{
  "kind": "continuable",
  "subagentId": "session-...",
  "policy": {
    "profile": "researcher",
    "characterId": "analyst",
    "taskType": "research",
    "additionalTools": ["web_search"],
    "effectiveTools": ["read", "glob", "grep", "web_search"]
  }
}
```

要求：

- 不输出参数 Schema、prompt、角色卡正文或 secrets。
- 摘要作为父会话 durable tool result 保存，供复盘和 UI 展示。
- 实际本地子代理工具面仍以 `ctx.tools.schemas(childAgent)` 为权威。

## 七、角色卡与任务规则

### 7.1 角色卡绑定

角色卡 JSON、`converted.yml` 和记忆文件保持不变。工具档绑定存储在当前 preset 的 `subagentToolPolicy.characterBindings`，因为相同角色卡在不同 preset 可以拥有不同权限。

UI 使用现有角色卡列表：

```text
角色卡          工具档       模型可选择
分析师 analyst   researcher   是
开发者 developer coder        是
```

本轮角色绑定只决定工具 profile，不自动改变角色卡导入、persona 或世界书语义。需要 per-child persona 时继续使用官方 persona/config-card 能力，避免把角色卡转换规则复制进工具策略模块。

### 7.2 任务类型

扩展 `engine/classify-task.mjs`，在保留现有 `createTaskClassifier()` 的同时增加通用有序规则分类：

```js
createOrderedTaskClassifier(rules)
```

规则：

- order 升序，同 order 按数组顺序；
- 首个匹配获胜；
- 输入固定为 `description + "\n" + prompt`；
- 显式 `task_type` 优先于自动分类；
- 无匹配回落 defaultProfile；
- regex 不使用全局 `g` 状态；
- 非法 pattern 保存时拒绝。

## 八、UI 完整实现

新增：

```text
src/client/SubagentToolPolicyCard.tsx
```

挂在现有“工具管线 → 委派”区域，包含五部分。

### 8.1 策略总览

- 启用/停用实例级策略；
- defaultProfile；
- ceiling allow/deny；
- 当前策略校验状态；
- “既有子代理不变，仅影响新实例”提示。

### 8.2 工具档编辑器

每个 profile 卡支持：

- id、名称；
- allow/deny；
- modelSelectable；
- 复制、删除、排序；
- 当前工具目录勾选；
- 手工 TagInput 兼容暂未挂载的第三方工具。

删除被 default、角色或任务引用的 profile 必须拒绝并列出引用位置。

### 8.3 角色卡绑定

- 从现有角色卡库选择；
- 选择 profile；
- modelSelectable 开关；
- 同一 characterId 不得重复；
- 角色卡删除后显示失效绑定，保存前要求删除或改绑。

### 8.4 任务规则

- id、名称、pattern、order、profile；
- modelSelectable 开关；
- 即时正则校验；
- 提供一段测试文本并展示匹配结果；
- 不在客户端复制最终分类逻辑，测试请求调用 Host 预览 seam。

### 8.5 模型扩权与实例预览

扩权设置：

- enabled；
- expansion allow；
- maxAdditionalTools；
- requireApproval。

实例预览输入：

- tool（subagent / subagent_fork）；
- description / prompt；
- tool_profile；
- character_id；
- task_type；
- additional_tools；
- restrict_tools。

预览输出：

- selector 命中路径；
- selected profile；
- ceiling；
- 增加/移除工具；
- effective tools；
- 是否会触发 approval；
- provider capability 错误。

UI 预览只读，不创建子代理。

## 九、Bridge 与存储

新增端点：

```text
/subagent-tool-policy          GET/POST
/subagent-tool-policy-preview  POST
/tool-surface                  POST
```

### 9.1 policy 读写

- 数据源为激活预设 `preset.yml` 顶层 `subagentToolPolicy`。
- 使用 YAML Document API 保留注释和未知字段。
- POST 先经统一 resolver 校验，再原子写盘并触发 `rebuildPreset()`。
- 空策略删除顶层键并移除 `subagent-tool-policy` 模块。
- 非空策略自动追加模块且去重。
- 不把策略写入全局 Settings。

### 9.2 policy 物化

`writePreset()` 生成：

```text
<user-preset>/subagent-tools/policy.yml
```

并复制/保证 `.engine/subagent-tool-policy*.mjs` 可解析。

`SUBSTANTIVE_PRESET_KEYS` 增加 `subagentToolPolicy`；copy/import/export/duplicate 保留该段。

### 9.3 预览

Host 预览和 runtime execute 使用同一个 `resolveSubagentToolPolicy()`。

预览请求只接受策略 selector 和测试文本，不接受任意文件路径。响应不包含角色卡正文、promptConfigs 或 secrets。

### 9.4 工具面

`/tool-surface` 是只读运行态端点：

- Host 侧通过动态 `ctx.inject(['agents', 'tools'], callback)` 等待服务，不扩大 `src/index.ts` 静态 inject。
- 请求只接受 session id；校验类型、长度和当前是否存在存活 Agent。
- 支持当前主会话和当前本地子代理；未知、冷态或远程子代理返回稳定错误，不自动 resume。
- 从目标 Agent scope 调用 `ctx.tools.schemas(agent)`，响应只返回 `{ name, description }`；不返回完整参数 Schema、大文本、角色卡正文或 secrets。
- 不挂载或激活其他预设，也不静态估算未运行预设的最终工具面。
- Client 从官方 sessions snapshot 获取当前 session id，不把 session id 持久化进 settings。
- 无当前会话时显示明确空态；保存或重建后提示既有会话/子代理保留原 generation 和创建时冻结的工具集。
- 搜索仅在客户端过滤，不因输入文字增加请求频率。
- 当前主会话的只读工具列表放在 `CustomToolsModuleCard`；子代理 profile/实例预览和已运行 child 工具面放在 `SubagentToolPolicyCard`，两处使用同一响应契约。
- 保留 loopback、Host、Origin 和 body-size guard；服务未就绪返回稳定错误码。

## 十、兼容与迁移

### 10.1 未启用策略的预设

完全保持现状：

- 继续使用官方 `@deepseek-ai/dsh-tool-subagent`；
- 原 `toolFilterAllow/Deny` 参数桥行为不变；
- 不注册 agent-scoped shadow；
- 不生成 policy 文件。

### 10.2 首次启用策略

UI 提供一次性初始化：

- default profile 从现有 `toolFilterAllow/Deny` 复制；
- ceiling 初始值取当前工具面中允许用户勾选的工具；
- 用户确认后才写入；
- 不自动删除主代理 `toolFilterAllow/Deny`；
- 策略启用后，参数桥不再把主代理列表写入 delegation.toolFilter，避免双重过滤。

### 10.3 `toolFilterSubagents`

- 策略未启用：保留旧行为。
- 策略启用：该参数不参与子代理授权，并在 UI 标记 deprecated。
- 新策略稳定后另立迁移删除计划，不在本轮静默改写历史 preset。

### 10.4 customTools.scope

仍按上一版计划处理：当前 UI 和 runtime 未实现该字段，出现时显式拒绝，不与本次 subagent policy 混为一套作用域系统。

## 十一、实施 Wave

### Wave 1：Custom ToolDefinition 标准化（P0）

修改：

- `engine/tool-config-engine.mjs`
- `test/engine/tool-config-engine.test.mjs`

任务：

1. 从运行中的 DSH 入口通过 `process.argv[1]` + `createRequire()` 解析同一份 `@deepseek-ai/dsh-tools`，确保与 Host 同实例。
2. `compileTool()` 使用 `defineTool()` 或官方转换函数构造完整 ToolDefinition：
   - `parameters: def.parameters ?? {}` 转为标准 JSON Schema object；
   - `output.schema` 经 ValueSchemaSpec 转换；
   - 保留 JSON renderer、timeoutMs、approval 与 execute 分发。
3. 若运行时同实例解析经隔离 smoke 证明不可用，将转换移动到 host 物化阶段；仍复用官方转换器，不复制实现。
4. 保留现有输入校验、description 双花括号消毒和非法单条 warn-and-skip 语义。
5. `customTools.scope` 存在时明确报“不支持”，该条按既有 warn-and-skip 处理。
6. 增加真实 registry 契约测试：
   - 有参数工具生成标准 JSON Schema；
   - 无参数工具生成空 object Schema；
   - output required / array / oneOf 转换正确；
   - 非法参数在执行前失败且实现不运行；
   - 非法成功输出被 registry 拒绝；
   - `ctx.tools.schemas()` 不抛错；
   - `ctx.tools.execute()` 可完成真实调用；
   - disposer 撤销后工具从对应 scope 消失。

验收门：Wave 1 未通过前不进入 delegate、策略或 UI 工作。

### Wave 2：delegate 统一走 ToolRuntime（P0）

修改：

- `engine/tool-config-engine.mjs`
- `test/engine/tool-config-engine.test.mjs`

任务：

1. 删除 `tools.get(...).execute(...)` 与伪造 `minimalExec`。
2. 使用 `ctx.tools.execute()` 发起 nested dispatch，携带稳定派生的 callId、rootCallId、`parent = run.token`、agent、arguments 和 signal；禁止 `Date.now()` 生成调用身份。
3. 保留完整引用、部分字符串插值和固定值的现有 args 映射语义。
4. 从标准 ToolExecutionResult 映射外层 `{ ok, value?, error? }`，不泄漏内部执行对象。
5. 将 nested additionalContexts 逐项交给 `run.deferContext()`；nested success 标记 concludesTurn 时调用 `run.concludeTurn()`。
6. 增加确定性测试：
   - 目标参数非法时由真实 registry 拒绝；
   - pre/post hook 可观察 nested call；
   - approval、deny、timeout 不被绕过；
   - AbortSignal 到达目标工具；
   - rootCallId / parent token 关系正确；
   - additionalContexts / concludesTurn 传播；
   - 代码中不再直接调用目标 ToolDefinition 的 `.execute()`。

### Wave 3：Policy resolver 与物化链（P0/P1）

新增/修改：

- `engine/subagent-tool-policy-core.mjs`
- `engine/classify-task.mjs`
- `src/host/manifest.ts`
- `src/host/write-preset.ts`
- `src/runtime/settings-bridge.ts`
- `src/shared/bridge-contract.ts`
- `engine/compositions/source/local/subagent-tool-policy.yml`
- `scripts/rebuild-composition.mjs`
- 对应 host/engine/shared tests

任务：

1. 实现策略 schema、编译、解析和模型参数生成。
2. 新增顶层 `PresetSpec.subagentToolPolicy`。
3. 新增 policy GET/POST/preview endpoints。
4. 物化 policy 文件和 engine 模块。
5. 策略启用时停止把主代理 filter 写入 delegation.toolFilter。
6. 实现 `/tool-surface`：动态等待 agents/tools、校验 live session、按 Agent scope 返回 name/description 摘要和稳定错误。
7. 保持未启用预设零行为变化。

### Wave 4：Agent-scoped subagent shadow（P1）

新增/修改：

- `engine/subagent-tool-policy.mjs`
- `engine/compositions/source/local/subagent-tool-policy.yml`
- `test/engine/subagent-tool-policy.test.mjs`
- `test/host/composition-modules.test.mjs`
- `test/presets/*` 中需要的集成测试

任务：

1. 为当前 preset generation 的每个 Agent 注册 subagent/subagent_fork shadow。
2. 按实例 selector 解析 effective toolFilter。
3. 实现 spawn/fork、foreground/continuable、模型路由和 maxDepth parity。
4. 实现 expansion approval。
5. 输出 durable policy summary。
6. 验证两个 preset generation、主/子代理、compaction 和 disposer 不串状态。

### Wave 5：完整 UI（P1）

新增/修改：

- `src/client/SubagentToolPolicyCard.tsx`
- `src/client/CustomToolsModuleCard.tsx`
- `src/client/EngineModuleCards.tsx`
- `src/client/prompt-tool-bridge.ts`
- `src/client/prompt-tool-types.ts`
- `src/client/prompt-tool-store.ts`
- `src/client/index.ts`
- `src/client/PromptUi.module.css`
- `test/client/no-host-dom.test.mjs`
- 现有 slot/client contract tests

任务：

1. 策略、profile、ceiling 编辑。
2. 角色卡绑定。
3. 任务规则与测试。
4. 模型扩权配置。
5. 实例解析预览。
6. `CustomToolsModuleCard` 增加当前主会话只读工具面：总数、名称、描述、刷新、搜索和无会话空态。
7. `SubagentToolPolicyCard` 增加 profile/实例预览和当前本地 child 实际工具面。
8. 当前 session id 只从官方 sessions snapshot 读取，不写 settings；搜索只在客户端执行。
9. 保存或重建后提示既有会话保留原 generation、既有 child 保留创建时工具集。

### Wave 6：文档、迁移与全量验收（P2）

修改：

- `README.md`
- `docs/architecture-params.md`
- `docs/engine-reuse.md`
- `PLAN.md`
- `preset.yml` 示例
- 受影响模板与迁移脚本

任务：

1. 固化配置契约和授权上限。
2. 说明“实例创建时冻结”。
3. 说明 provider capability 差异。
4. 更新旧 filter 迁移说明。
5. 记录 customTools 使用官方 Schema DSL、delegate 经官方工具管线、`customTools.scope` 暂不支持。
6. 记录工具面预览只代表当前运行会话，不代表未挂载预设。
7. 明确不引入旧 `connection.api` / `dsh-client-runtime`，不新增通用 preset/plugin mutation。
8. 同步受影响模板注释、测试数和提交记录。

## 十二、文件级变更矩阵

| 文件 | 责任 | 验证 |
|---|---|---|
| `engine/tool-config-engine.mjs` | 标准 ToolDefinition、delegate nested dispatch、显式拒绝 scope | 真实 ToolRuntime tests |
| `test/engine/tool-config-engine.test.mjs` | schemas/execute/output/disposer/nested pipeline 契约 | Node test runner |
| `engine/subagent-tool-policy-core.mjs` | 策略校验、编译、解析、参数 Schema | pure resolver tests |
| `engine/subagent-tool-policy.mjs` | agent-scoped shadow、subagent start、approval | integration tests |
| `engine/classify-task.mjs` | 通用有序任务规则 | deterministic classifier tests |
| `engine/compositions/source/local/subagent-tool-policy.yml` | opt-in runtime 行 | composition tests |
| `src/host/manifest.ts` | PresetSpec、参数桥分流、模块自动装配 | param/module contract tests |
| `src/host/write-preset.ts` | policy 文件与 engine 物化 | temp DSH_HOME tests |
| `src/shared/bridge-contract.ts` | policy/preview/tool-surface endpoints | shared contract tests |
| `src/runtime/settings-bridge.ts` | 受控读写、预览、实际工具面 | guard/error/rebuild tests |
| `src/client/SubagentToolPolicyCard.tsx` | 策略、实例预览和本地 child 工具面 | client contract tests |
| `src/client/CustomToolsModuleCard.tsx` | 当前主会话工具面、搜索、刷新和空态 | no-host-DOM/client tests |
| `src/client/EngineModuleCards.tsx` | 委派区装配 | render tests |
| `src/client/index.ts` | 从官方 sessions snapshot 提供当前会话上下文 | client bundle contract |
| `src/client/prompt-tool-*` | transport、types、store | typecheck/client tests |
| `test/client/no-host-dom.test.mjs` | 所有 UI 只走 SlotRegistry，不读取宿主 DOM | Node test runner |
| `scripts/rebuild-composition.mjs` | local module 清单/校验 | rebuild tests |
| `README.md` / `docs/*` | 长期契约 | diff check |

## 十三、验收标准

### 13.1 Custom tools

- [ ] 无参数工具可进入 `ctx.tools.schemas()`。
- [ ] parameters/output 均为标准 JSON Schema，output required / array / oneOf 语义正确。
- [ ] 非法参数在执行前产生标准工具错误，工具实现不被调用。
- [ ] 非法成功输出被 registry 拒绝。
- [ ] 工具 disposer 随 preset/agent scope 生命周期撤销。
- [ ] delegate 不直接调用目标 execute。
- [ ] nested dispatch 经过完整 policy/hook/timeout/approval 管线。
- [ ] rootCallId / parent token、AbortSignal、additionalContexts 和 concludesTurn 正确传播。
- [ ] delegate 完整引用、部分插值和固定值映射行为不变。

### 13.2 策略解析

- [ ] selector 优先级固定且测试覆盖。
- [ ] task rules 按 order/数组顺序确定性匹配。
- [ ] profile、角色、任务引用错误保存失败。
- [ ] ceiling deny 永远不可恢复。
- [ ] 模型不可选择 modelSelectable=false 条目。
- [ ] additional_tools 不能越过 expansion allow、ceiling 或 maxAdditionalTools。
- [ ] restrict_tools 只能收紧。

### 13.3 实例级权限

- [ ] 同一 parent 连续创建两个子代理可获得不同工具集。
- [ ] role binding 能选择不同 profile。
- [ ] explicit task_type 与自动 task rule 均能切换 profile。
- [ ] 模型扩权在允许范围内成功，越界拒绝。
- [ ] requireApproval=true 时批准前不创建子代理。
- [ ] 无 approval 服务 fail closed。
- [ ] 被隐藏工具不出现在 child prompt，也拒绝执行。
- [ ] 主代理工具面不因子代理策略改变。
- [ ] 子代理可比主代理拥有更多工具，但不能超过用户 ceiling。
- [ ] 实例创建后 UI 改策略不改变已运行 child。

### 13.4 Provider 与生命周期

- [ ] spawn/fork 支持 foreground 和 continuable。
- [ ] fork 保持父模型路由和继承上下文语义。
- [ ] ACP/remote provider 无 toolFilter capability 时 fail loud。
- [ ] maxDepth 继续生效。
- [ ] Agent dispose 后 shadow 工具与实例状态清理。
- [ ] 两个 preset generation 的 policy 不串用。
- [ ] compaction 不改变实例冻结的 toolFilter。
- [ ] 冷恢复 continuable child 保持创建时工具限制。

### 13.5 UI 与 Bridge

- [ ] UI 可编辑 ceiling、profiles、角色绑定、任务规则和扩权。
- [ ] UI 可预览一次实例解析结果。
- [ ] `/tool-surface` 只返回当前存活的本地主/子代理实际可见工具，不挂载、激活或恢复其他预设/会话。
- [ ] 工具面响应只含 name/description，不含完整 Schema、大文本、角色卡正文或 secrets。
- [ ] 无当前会话、未知 session、冷态/远程 child 和服务未就绪均有稳定错误或明确空态。
- [ ] Client 从官方 sessions snapshot 取当前 session id，不持久化；搜索仅客户端过滤，不增加请求频率。
- [ ] 保存/重建提示既有 session generation 与既有 child 工具集不变。
- [ ] 所有写入先验证后原子写盘并重建。
- [ ] 不把策略或角色卡正文写入全局 Settings。
- [ ] SlotRegistry/no-host-DOM 约束继续通过。

### 13.6 回归边界

- [ ] 未声明 `subagentToolPolicy` 的预设生成物与当前基线一致。
- [ ] 官方 delegation control/workflow/ralph 工具不回归。
- [ ] `preset.yml` 仍是 customTools 单一来源，`agent.cordis.yml` / `custom-tools/*.yml` 仍是生成物。
- [ ] 保存 delegate 工具继续自动补齐 character/world-book/session-var 模块。
- [ ] 不引入旧 `connection.api` / `dsh-client-runtime`，不新增通用 preset/plugin mutation。
- [ ] customTools、角色卡、世界书和 session_var 现有功能不回归。
- [ ] 不停止或重启运行中的 DSH，不修改真实用户 `~/.dsh`；测试只使用临时 DSH_HOME。

## 十四、验证命令

所有测试 cwd 固定为 `D:\AI\workspase\_temp`：

```pwsh
$Repo = 'D:\AI\GitHub\dsh-plugin-prompt-tool'
Set-Location 'D:\AI\workspase\_temp'

pnpm --dir $Repo typecheck
pnpm --dir $Repo lint
pnpm --dir $Repo test
pnpm --dir $Repo build
```

开发循环可先运行：

```pwsh
node --test "$Repo/test/engine/tool-config-engine.test.mjs"
node --test "$Repo/test/engine/subagent-tool-policy.test.mjs"
node --test "$Repo/test/host/settings-bridge.test.mjs"
node --test "$Repo/test/host/write-preset.test.mjs"
node --test "$Repo/test/shared/bridge-contract.test.mjs"
node --test "$Repo/test/client/no-host-dom.test.mjs"
```

最终仍运行完整 `pnpm --dir $Repo test`。

## 十五、中断条件

- 无法在生成 `.engine` 中解析与 Host 相同的 `dsh-tools`：先用隔离 smoke 复核；确认运行时解析不可行后改为 host 侧调用官方转换器完成物化。若两条路径都不能复用官方转换器，停止 Wave 1，不复制其实现。
- nested dispatch 无法完整传播上下文或终止语义：关闭 delegate 模板并停止 Wave 2，不退回直接调用目标 execute。
- 工具面端点若必须挂载未激活预设才能回答：取消静态预估，只保留当前存活会话视图。
- Agent scope 无法安全 shadow 官方 subagent 工具：停止 Wave 4，不退回全局重复注册，也不修改 Host。
- provider 不能在创建窗口应用 toolFilter：该 provider 不开放实例策略，不做 prompt-only 假过滤。
- expansion approval 无法在 child 创建前完成：关闭 additional_tools，不先创建后补批准。
- 冷恢复无法保持 toolFilter：continuable 路径不得发布，先修持久语义。
- UI 预览与 runtime resolver 产生不同结果：禁止发布，删除重复算法并统一 seam。
- 任一 Wave 破坏未启用策略预设的生成结果：停止后续 Wave，先恢复零行为变化。

## 十六、执行记录

- [x] 旧 L2 计划全部落地。
- [x] 分析 `dsh-plugins` 工具与预设实现。
- [x] 对照 DSH `0.1.2-alpha.4` ToolDefinition 与 SubagentStartRequest。
- [x] 复现 customTools Schema 问题。
- [x] 确认官方 static tool-subagent 不支持 per-call toolFilter。
- [x] 确认 agent-local tool 可 shadow preset/global 同名工具。
- [x] 对照 `ececbd1` 与现版本：确认实现文件未变化，并将旧计划全部未实施项逐项合并。
- [x] Wave 1：Custom ToolDefinition 标准化。（dea7496）
- [x] Wave 2：delegate 统一走 ToolRuntime。（dea7496）
- [x] Wave 3：Policy resolver 与物化链。（dea7496 / 1868a05）
- [x] Wave 4：Agent-scoped subagent shadow。（1868a05）
- [x] Wave 5：完整 UI。（bdb2006）
- [x] Wave 6：文档、迁移与全量验收。
- [x] 2026-09-03 复验修复：官方子代理 API、scope 隔离、策略停用/物化、完整 UI 与真实契约测试。
- [x] 完整 typecheck / lint / test / build。（typecheck/lint 通过；461 tests 全部通过）
- [x] 提交并推送 `origin/dev`。
