# Engine 能力卡片框架可行性

> 结论：方案可行。
> 推荐模型：一项引擎能力一张设置卡，一份 ToolSchema 一张工具卡；modules 决定可写引擎卡是否存在，params/moduleConfigs 决定其内容，recipe 负责连锁创建。
> 本方案只调整 UI 模块列表，不重排 engine/ 运行时文件。

## 1. 目标界面

模块列表继续使用六个官方 seam 作为展示分组：

    pre-step
    system-section
    runtime-context
    agent-request
    llm-stream
    tool-pipeline

每个 seam 下提供两种集合视图：

    [通用设置] [引擎能力设置]

    通用设置
      └─ 当前 seam 的 promptConfigs

    引擎能力设置
      ├─ 当前 seam 的引擎设置卡
      └─ tool-pipeline 额外包含预设工具卡

具体目标：

- tool-bootstrap 当前夹带的 anchor-turn 设置拆到独立 anchor-turn 卡。
- 当前“工具管线”聚合卡拆为 code-presentation、tool-filter、
  deliberation-gate、cot-drip 等独立设置卡。
- preset.yml 已装配某项可编辑引擎能力时，显示其唯一设置卡。
- 官方和用户预设都能按实际工具展开为 tool-pipeline 工具卡。
- UI 新建一个能力或 recipe 时，一次写入所需模块并生成一张或多张设置卡。
- 未装配的可选引擎能力默认不创建卡片。

## 2. 三类卡片与数据来源

三类卡片不能共用一套持久化判断：

| 卡片 | 存在性来源 | 内容来源 | 是否可写 |
|---|---|---|---|
| 通用行为卡 | promptConfigs | PromptConfigDraft | 按现有配置保存链 |
| 引擎设置卡 | 插件管理的 preset.yml.modules | params/moduleConfigs | 用户预设且已有 typed editor 时可写 |
| 预设工具卡 | ctx.tools.schemas(preset scope) | ToolSchema 的 name/description | 首期只读 |

核心规则：

- modules 表示能力装配；参数表示能力配置。参数非空不能代替 modules。
- false 和 0 可能是合法显式值；空字符串和空数组表示删键回落默认。不能用 truthy
  判断卡片是否存在。
- promptConfigs 的 layer/order/audience 继续由通用行为卡管理，不写进引擎设置卡。
- 一项设置只保留一个 owner，不在工具卡中复制 provider 或管线设置。

### 2.1 完整的 preset.yml 声明

手写预设要让 deliberation-gate 运行并出现设置卡，必须同时声明模块和参数：

    modules:
      - deliberation-gate
    params:
      deliberationGate: true

只有 params 没有 modules 时，buildModuleConfigsFromParams() 虽会生成候选行配置，
applyModuleConfigs() 却找不到 Cordis 行，能力不会运行。这种参数只能视为 dormant
草稿；新建该能力时可以复用，但不能显示为“已装配”。

### 2.2 modules: [] 的兼容语义

当前 modules: [] 不是零模块：

- loadCompositionText() 会展开 FALLBACK_MODULES。
- appendPresetModules() 也会先补同一套骨架。

因此“默认空即不创建”应解释为“不创建额外可选能力卡”，而不是改变现有空预设的
运行语义。若要让 modules: [] 真正代表零模块，需要单独迁移现有用户预设，不能夹在
本轮 UI 重构中。

### 2.3 多张卡片的含义

“连锁创建多张卡”指一个 recipe 展开多个不同模块，例如：

    phase-control-ptc
      -> context-gate
      -> tool-bootstrap
      -> code-presentation

每个模块生成一张唯一设置卡。首期不支持同一模块的多个实例；当前 modules 是字符串
清单，moduleConfigs 以 Cordis row id 为键，多实例需要 instanceId、行 id 重写和运行
状态隔离，是另一项架构改造。

## 3. 官方预设工具卡

官方预设可以准确展开工具卡，但数据源不是 pluginInventory。

### 3.1 正确的官方链路

Host 侧按用户选中的单个预设执行：

    const scope = await ctx.agentPresets.standingKeyFor(presetId)
    const tools = ctx.tools.schemas(scope)

然后只向客户端返回轻量投影：

    {
      presetId,
      tools: tools.map(({ name, description }) => ({ name, description }))
    }

一份 ToolSchema 对应一张工具卡：

    tool-pipeline
      ├─ read
      ├─ write
      ├─ edit
      ├─ glob
      ├─ grep
      ├─ pwsh
      ├─ web_search
      └─ ...

这样可以覆盖：

- DSH 随部署提供的 system preset；
- 用户自建 agent.cordis.yml preset；
- 本插件生成的 modules preset；
- 动态条件工具，例如只有 attachments 可用时才注册的 read_image；
- scope shadow、工具限制和 preset-specific 工具名。

### 3.2 复用现有 toolSurface

浏览器不能直接调用 standingKeyFor() 或 tools.schemas()。最小实现不是再造工具扫描器，
而是扩展现有 toolSurface 请求：

    type ToolSurfaceRequest =
      | { sessionId: string }
      | { presetId: string }

    type ToolSurfaceValue = {
      source: "session" | "preset"
      tools: Array<{ name: string; description: string }>
    }

- sessionId 分支保持现状：读取存活 Agent 的实际工具面。
- presetId 分支动态等待 agentPresets + tools，调用 standingKeyFor() 后读取该预设 scope。
- 请求只接受已发现的 preset id，不接受文件路径或任意模块名。
- 失败继续使用统一 bridge 错误载荷。

### 3.3 挂载与生命周期

standingKeyFor() 会真实挂载所选 preset 的 standing composition，但不会创建 agent、
session 或 turn。它会按 agent.cordis.yml 文件戳发现变更，并为后续会话建立最新
generation。

因此：

- 只在用户进入所选预设的引擎能力视图时懒加载。
- 不在 bootstrap 中遍历并挂载全部预设。
- 不轮询，不在每次输入或失焦保存后刷新。
- recipe 创建完成后允许刷新一次工具卡。
- 同一预设频繁重建会留下旧 standing generation，当前官方实现只在整棵树卸载时回收；
  必须控制刷新次数。
- 已有会话继续使用其旧 generation；工具卡预览表示该 preset 后续新会话使用的最新
  generation。

当前会话工具面与预设工具预览必须标明来源，不能互相覆盖。

### 3.4 PTC 语义

tools.schemas(scope) 返回该 scope 的有效工具能力，并在 PTC/both 模式包含 run_code。
PTC 的模型直连 wire 只发送 run_code，其他工具通过生成 SDK 被 run_code 间接调用。

因此这些卡片应命名为“预设工具能力”，不要标成“模型直连工具”。PTC 预设仍展示底层
工具卡，并额外显示 run_code；呈现模式另行标注。

### 3.5 pluginInventory 的作用

官方 pluginInventory/list 只返回压平插件行：

    entryId / moduleName / enabled / condition / fiberPhase

它适合展示插件启停、条件门和 Fiber 状态，但没有 ToolSchema，也没有可靠的
plugin-row -> tools 归属关系。不能用 moduleName 前缀或静态 knownTools 猜工具。

本方案可选地用 pluginInventory 补充诊断信息，但工具卡必须来自 tools.schemas(scope)。

## 4. 引擎设置卡归一

按当前 buildModuleConfigsFromParams()，首批设置卡可以直接拆分：

| 设置卡 | composition module / row | 主要展示层 | 参数 owner |
|---|---|---|---|
| tool-bootstrap | tool-bootstrap / tool-bootstrap | system-section | bootstrapMaxTokens、bootstrapTools、promote*、compactionTools、personaSectionsOnly、workspaceLine、phase1FirstCallInstruction、stages、stage* |
| context-gate | context-gate / context-gate | pre-step | allowKinds、messageSources、deferredSources、deferredGraceSteps、instructionHint |
| anchor-turn | anchor-turn / anchor-turn | pre-step | anchorTurn、anchorTurnText |
| code-presentation | code-presentation / code-presentation | tool-pipeline | usePtcMode |
| tool-filter | tool-filter / tool-filter | tool-pipeline | toolFilterAllow、toolFilterDeny、toolFilterSubagents |
| deliberation-gate | deliberation-gate / deliberation-gate | tool-pipeline | deliberationGate、deliberationMinChars、deliberationMaxGatesPerTurn |
| cot-drip | cot-drip / cot-drip | tool-pipeline | cotDrip、cotDripEvery、cotDripMaxPerTurn |
| str-replace-editor | bootstrap-filesystem 或 str-replace-editor / str-replace-editor | tool-pipeline | strReplaceEditorMaxOutputChars |

displayLayer 只决定 UI 归组。tool-bootstrap、context-gate 和 code-presentation 都跨越
多个 runtime surface，不能用展示层推导唯一运行 seam。

模型路由、模板变量、自定义工具和 subagentToolPolicy 保持现有专用领域卡，不强行
塞进通用引擎卡。

## 5. 能力 catalog 与 recipe

### 5.1 最小 catalog

catalog 只管理可编辑引擎设置卡，不管理官方 ToolSchema：

    interface EngineCapability {
      id: string
      moduleKeys: readonly string[]
      rowIds: readonly string[]
      displayLayer: EngineLayer
      runtimeSurfaces: readonly string[]
      requiresModules?: readonly string[]
      initialParams?: Readonly<Record<string, unknown>>
    }

约束：

- capability id 唯一。
- 每个参数控件只属于一张设置卡。
- moduleKeys 可以从 source/local 或 library 解析。
- rowIds 必须能命中候选组合。
- requiresModules 只表示硬依赖，且无环。
- 专用 typed editor 继续显式编写，不生成万能 key/value 表单。

### 5.2 recipe 不是持久化实体

硬依赖与一键组合分开：

    const ENGINE_RECIPES = {
      "phase-control": {
        capabilities: ["context-gate", "tool-bootstrap"],
      },
      "phase-control-ptc": {
        capabilities: ["context-gate", "tool-bootstrap", "code-presentation"],
        initialParams: { usePtcMode: true },
      },
      "deliberation": {
        capabilities: ["deliberation-gate", "cot-drip"],
        initialParams: { deliberationGate: true, cotDrip: true },
      },
    }

context-gate、tool-bootstrap 和 code-presentation 可以独立装配，所以它们是 recipe
组合，不是相互硬依赖。recipe 展开后不写入 preset.yml；最终事实仍是 modules、
params 和 moduleConfigs。

只保留有真实用户工作流的 recipe，不为未来组合预建 registry。

## 6. UI 新建能力

UI 不应先保存参数、再逐个追加模块。扩展现有 bridge 或增加一个受控端点，一次只提交
capabilityId 或 recipeId：

    { action: "create", capabilityId: "deliberation-gate" }
    { action: "create-recipe", recipeId: "phase-control-ptc" }

Host 事务：

1. 从服务端 catalog/recipe 解析白名单项，忽略客户端提供的任意模块路径或参数对象。
2. 要求目标是本插件支持写入的 user preset；system preset 先复制再编辑。
3. 展开 recipe 和硬依赖，得到有序且去重的 moduleKeys。
4. 在内存 YAML Document 中插入缺失 modules，只写明确的 initialParams。
5. 用候选 PresetSpec 执行 renderComposition() 和 assertCompositionArray()，并确认
   rowIds 存在。
6. 校验通过后原子替换 preset.yml，只触发一次 rebuildPreset()。
7. 重载设置卡；若用户正在查看工具卡，最多刷新一次 preset toolSurface。

重复创建保持幂等，不重复 modules，不覆盖已有 params/moduleConfigs。

现有 withPresetDoc() 会在 mutate 返回后立即写盘，不能承担落盘前组合校验。实现时只需
复用其 parseDocument + atomicWriteTextFile 模式，增加一个带 validate 回调的最小 helper。

第一版不做删除能力。删除需要反向依赖检查和 dormant 参数保留规则，不能和创建路径
共用一个未经证明的对称操作。

## 7. 实施顺序

### 阶段一：官方工具卡

- 扩展 toolSurface 支持 presetId。
- Host 按需执行 standingKeyFor() + tools.schemas(scope)。
- tool-pipeline 一份 ToolSchema 渲染一张只读工具卡。
- 保留 sessionId 分支，并明确“当前会话”与“预设后续 generation”。

### 阶段二：拆分设置卡

- bootstrap 返回写入所需的 declaredModules/sourceMode。
- 将 EngineModuleList 当前聚合卡按第 4 节拆分。
- modules 决定设置卡存在，params/moduleConfigs 继续走现有保存链。

### 阶段三：新建与 recipe

- 增加最小 shared catalog。
- 实现候选组合预校验和原子写入。
- 新建菜单只列未装配能力及少量 recipe。

### 阶段四：视图收口

- 每个 seam 使用“通用设置 / 引擎能力设置”二段控件。
- 通用侧复用 PromptConfigList。
- 能力侧组合设置卡；tool-pipeline 另加入工具卡。

## 8. 验证

至少覆盖：

- system/user/官方格式预设都能按 ToolSchema 展开工具卡。
- preset 工具读取只挂载用户明确展开的一个预设，不遍历或轮询。
- 动态工具、scope restriction、shadow 与 run_code 由 tools.schemas(scope) 如实反映。
- pluginInventory 行不会被误当成 ToolSchema。
- 一份 ToolSchema 只生成一张工具卡；未知工具不被隐藏。
- modules 决定设置卡存在；params-only 不误显示为已装配。
- modules: [] 的 FALLBACK_MODULES 语义不变。
- 每个参数控件只有一个设置卡 owner。
- recipe 一次写盘、一次 rebuild，重复创建幂等。
- 候选校验失败时 preset.yml 保持原样。
- params > moduleConfigs > 行默认优先级不变。
- 空字符串、空数组、false、0 和 variables 空占位语义不变。
- 主会话、子代理与 compaction/end 行为不变。
- 已有会话不热切换，新会话使用最新 generation。

## 9. 最终判断

用户澄清后的完整方案可行：

1. 引擎设置按能力拆成唯一卡片。
2. 官方预设通过 standingKeyFor() + tools.schemas(scope) 展开 tool-pipeline 工具卡。
3. modules/params/moduleConfigs 保持既有持久化职责。
4. recipe 只作为原子创建宏，不形成第二套 engine 状态。

不采用的部分只有：按六层移动 engine 文件、根据参数 truthy 推断模块存在、静态猜测
provider 对应的工具、同模块多实例，以及未做依赖检查的删除操作。

相关长期契约：

- [docs/ui-architecture.md](docs/ui-architecture.md)
- [docs/engine-reuse.md](docs/engine-reuse.md)
- [docs/architecture-params.md](docs/architecture-params.md)
