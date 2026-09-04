# Engine 能力卡片框架可行性

> 结论：方案可行，且比当前三张聚合卡更贴合 preset.yml 的模块模型。
> 推荐采用“一项引擎能力一张卡、modules 决定卡片存在、params/moduleConfigs 决定卡片内容、依赖图负责连锁创建”。
> 依据：当前 engine/、src/host/manifest.ts、src/client/features/modules/EngineModuleList.tsx 与现有架构文档。

## 1. 提案要解决的问题

本方案只调整“模块列表”下的 UI 卡片归一方式，不重排 engine 运行时文件。六个官方
插入点仍作为页面筛选和主要展示分组：

    engine/
    ├─ pre-step/
    ├─ system-section/
    ├─ runtime-context/
    ├─ agent-request/
    ├─ llm-stream/
    └─ tool-pipeline/

目标行为是：

- 每个引擎能力对应一张唯一模块卡，例如 tool-bootstrap、context-gate、
  anchor-turn、deliberation-gate、cot-drip、code-presentation、tool-filter。
- tool-bootstrap 当前聚合的开关和字段移动到其真正所属的能力卡。
- preset.yml 已装配某能力时显示卡片；未装配时默认不创建。参数只表示配置，不代替
  模块装配。
- 用户从 UI 新建某能力时，一次事务写入该模块及必需依赖，重建后显示所有新增的
  唯一卡片。
- promptConfigs 仍是同一 seam 下的通用行为卡，不与引擎能力参数混写。

这里仍需区分官方运行 seam、engine module 和 UI card：它们可以关联，但不是同一个
持久化实体。

## 2. 可行性结论

| 方案部分 | 结论 | 原因 |
|---|---|---|
| 一项引擎能力一张卡 | 可行 | modules、参数桥和 Cordis row 已有稳定模块 ID |
| UI 按六个 seam 筛选或展示 | 可行 | promptConfigs 已有 layer；现有模块列表也已有 layerFilter |
| tool-bootstrap 字段拆归各能力卡 | 可行 | buildModuleConfigsFromParams 已给出参数到模块的确定映射 |
| preset.yml 的 modules 声明自动出现卡片 | 可行 | bootstrap 可返回当前 modules、params 和 moduleConfigs |
| UI 新建能力并连锁创建依赖卡 | 可行 | 现有 YAML Document 与原子写盘路径可复用 |
| engine 源码按六个 seam 物理拆目录 | 不建议 | 多个模块跨 seam、跨事件和跨 epoch；拆分会复制状态或增加转发层 |
| 每个模块只归属一个 seam | 不成立 | prompt-config-engine、context-gate、tool-bootstrap 等都拥有多个接入面 |
| 通用/能力设置切换 | 有条件可行 | 应作为 seam 面板的集合视图；两类字段仍由不同契约和 owner 保存 |
| 用 seam:模块名作为持久化 ID | 不建议 | seam 改名会破坏已有配置；模块 ID 和展示标签应独立 |

因此，按用户澄清后的目标实现，整体可行性高；主要新增工作是模块 catalog、当前预设
模块事实和一个原子“创建能力”写端点，而不是修改 engine 执行器。

### 2.1 卡片存在性的判定

卡片存在性必须以 preset.yml 解析出的有效 modules 为准，不能只用“参数是否非空”：

    cardExists(capability) =
      capability.providedBy.some(module => effectiveModules.includes(module))

原因：

- 模块即使没有 params，也可能使用组合行默认值正常运行。
- false、0 和空字符串在部分参数中是显式值，不能统一按 falsy 判断。
- params 可能残留为 dormant 配置；其模块未装配时不应假装正在运行。
- moduleConfigs 可能配置官方嵌套 row，而顶层 modules 使用的是组合文件键；例如
  bootstrap-filesystem 组合中才包含 str-replace-editor 行。

catalog 只登记有用户可编辑参数的 engine 能力；prompt-config-engine 等无编辑面的运行
模块即使已装配，也不必制造空卡片。subagentToolPolicy、customTools 等顶层领域继续用
现有专用卡，不进入这套存在性推断。

推荐 UI 状态：

| 模块状态 | 是否显示 | 编辑行为 |
|---|---|---|
| capability 的 provider 在 effectiveModules | 显示“已装配” | 编辑现有 params/moduleConfigs |
| module 缺失、只有 dormant params | 默认不显示；新建菜单可提示已有草稿 | 创建时复用草稿 |
| module 及参数都缺失 | 不显示 | 仅在新建菜单列出 |
| module 依赖缺失 | 显示“配置异常” | 禁止保存并提供补齐依赖动作 |
| preset 没有 modules 数组 | 不推断 | 显示“组合由 agent.cordis.yml/composition 管理”，能力 CRUD 只读 |

“在 preset.yml 设置对应引擎参数”应解释为完整声明：

    modules:
      - deliberation-gate
    params:
      deliberationGate: true

只有 params 而没有 modules 时，参数桥会生成候选行配置，但现有 applyModuleConfigs()
找不到目标 Cordis 行，不会让能力运行。UI 可以在新建菜单提示“发现 dormant 参数”，
但不能自动显示为已装配卡片。

### 2.2 空 modules 的现有兼容语义

当前 modules: [] 会被 loadCompositionText() 展开为 FALLBACK_MODULES，
appendPresetModules() 也会先补同一套骨架。因此“空即不创建”有两种含义：

- 仅指没有可选能力卡：保留 fallback，bootstrap 返回 effectiveModules，基础能力仍显示。
- 指真正零模块、零卡片：需要取消 fallback，并把既有 modules: [] 用户预设迁移为显式
  旧骨架；这是行为变化，不能夹在 UI 拆卡中完成。

推荐第一阶段保留兼容语义，并同时返回 declaredModules 与 effectiveModules。卡片按
effectiveModules 显示，编辑器可以标注模块来自显式声明还是 fallback。只有用户确认
要改变空预设语义时，再单独迁移 modules: []。

对于没有 modules 数组、直接声明 composition 或同目录 agent.cordis.yml 的官方格式
预设，无法从最终 Cordis row 可靠反推出原 composition module 键。第一版不解析猜测：
它们继续由原文件管理，不开放能力新建/删除；需要可视化编辑时先复制为插件管理的
modules 预设。

### 2.3 “多张卡片”的范围

本方案中的多张卡片，是一个 recipe 展开成多个不同的 composition module，每个能力
一张卡；不是同一个模块的多个实例。

当前 modules 是字符串清单，moduleConfigs 以 Cordis row id 为唯一键。同模块重复实例
无法拥有独立配置和状态，还可能重复注册 listener。支持同模块多实例需要 instanceId、
行 id 重写和状态隔离，首期明确排除。

## 3. 当前实现的约束

### 3.1 运行时模块是能力模块

- prompt-config-engine 是装配 facade：读取配置后同时接入 pre-step 和其余五个官方层。
- layers.mjs 在同一实现中接线 system-section、runtime-context、agent-request、llm-stream 和 tool-pipeline。
- context-gate 同时过滤 runtime context 与 agent/pre-step，并共享晋升状态。
- tool-bootstrap 监听 system-prompt/assemble、agent/request、session/event 和工具阶段；它还处理压缩后的工具集与渐进披露。
- code-presentation 在晋升和 compaction/end 时切换工具呈现。
- compaction-epoch 为多个模块提供共同的 epoch 状态。
- tool-config-engine、subagent-tool-policy、character-tools、world-book-tools 和 session-var-tools 是工具或作用域能力，不是提示词 seam 的子目录。

把这些文件按 layer 移动，会出现以下至少一种问题：

- 一个模块被复制到多个目录，状态和 disposer 可能各自运行一次。
- 跨层依赖改成相互导入，降低模块深度和维护局部性。
- 为保持旧路径增加只转发的浅模块，目录变多但接口没有变深。
- 组合文件的相对路径和 user preset 的 .engine 共享规则发生漂移。

### 3.2 组合与配置已有单一来源

预设的 modules 清单决定装配哪些模块，moduleConfigs 以模块 ID 为键提供行级配置；
params/UI 参数优先于 moduleConfigs，moduleConfigs 再优先于行默认。该链路由
[docs/engine-reuse.md](docs/engine-reuse.md) 和 [docs/architecture-params.md](docs/architecture-params.md) 维护。

promptConfigs 则是另一套配置实体：每条配置声明 layer、strategy、order、audience
等字段，并由 prompt-config-engine 按声明注册。把 promptConfigs 的通用字段塞进
engine module card 会让两个来源互相覆盖。

### 3.3 当前代码已具备的基础

- appendPresetModules() 已能去重追加模块，并通过 withPresetDoc() 的 YAML Document
  写盘保留注释和未知字段；但它会为空清单补 fallback，且只会尾部追加，不能直接作为
  有顺序依赖的 recipe 实现。
- customTools 与 subagentToolPolicy 保存已经实现“内容变更 + 自动装配依赖模块 +
  一次 rebuild”的同类事务，可复用其路径，不需另造状态框架。
- buildModuleConfigsFromParams() 已是参数归属的可靠证据：
  - bootstrap*、promote*、stages、personaSectionsOnly、workspaceLine ->
    tool-bootstrap；
  - allowKinds、messageSources、deferredSources、instructionHint -> context-gate；
  - usePtcMode -> code-presentation；
  - anchorTurn* -> anchor-turn；
  - deliberation* -> deliberation-gate；
  - cotDrip* -> cot-drip；
  - toolFilter* -> tool-filter。
- 当前 bootstrap 已返回 presetParams，但没有返回原始 modules/moduleConfigs；要让 UI
  区分“模块已装配”和“仅有 dormant 参数”，需补这两个事实。

按当前参数桥，首批卡片可以确定为：

| UI 能力卡 | provider module / row | 主要展示层 | 当前参数 owner |
|---|---|---|---|
| tool-bootstrap | tool-bootstrap / tool-bootstrap | system-section | bootstrapMaxTokens、bootstrapTools、promote*、compactionTools、personaSectionsOnly、workspaceLine、phase1FirstCallInstruction、stages 与 stage* |
| context-gate | context-gate / context-gate | pre-step | allowKinds、messageSources、deferredSources、deferredGraceSteps、instructionHint |
| anchor-turn | anchor-turn / anchor-turn | pre-step | anchorTurn、anchorTurnText |
| code-presentation | code-presentation / code-presentation | tool-pipeline | usePtcMode |
| tool-filter | tool-filter / tool-filter | tool-pipeline | toolFilterAllow、toolFilterDeny、toolFilterSubagents |
| deliberation-gate | deliberation-gate / deliberation-gate | tool-pipeline | deliberationGate、deliberationMinChars、deliberationMaxGatesPerTurn |
| cot-drip | cot-drip / cot-drip | tool-pipeline | cotDrip、cotDripEvery、cotDripMaxPerTurn |
| str-replace-editor | bootstrap-filesystem 或 str-replace-editor / str-replace-editor | tool-pipeline | strReplaceEditorMaxOutputChars |

displayLayer 只决定 UI 归组。尤其 tool-bootstrap、context-gate、code-presentation 都有
多个 runtime surface，不能从表中反推唯一运行 seam。

## 4. 推荐的目标形态

### 4.1 engine 保持按能力组织

运行时代码继续保持能力导向的平面模块和共享子模块：

    engine/
    ├─ prompt-config-engine.mjs   # 六层提示词装配 facade
    ├─ layers.mjs                 # 非 pre-step 五层 adapter
    ├─ executor.mjs               # pre-step 执行
    ├─ context-gate.mjs           # 上下文/消息门控
    ├─ tool-bootstrap.mjs         # 工具目录与阶段相位
    ├─ code-presentation.mjs      # PTC 呈现
    ├─ compaction-epoch.mjs       # 共享 epoch 状态
    ├─ tool-*.mjs / *-tools.mjs   # 工具能力
    └─ compositions/

这里的 module interface 是能力配置和 disposer，而不是目录名。一个模块可以在多个
seam 安装 adapter；共享状态只保留一份。需要复用时先问删除测试：如果移除一个模块
会让复杂度散落到多个调用方，它就提供了足够的 depth，不应改成多个薄转发文件。

### 4.2 UI 采用 seam 视图，不改变运行归属

UI 可以保留六层筛选，但把它定义为展示维度：

    全部
      ├─ pre-step
      ├─ system-section
      ├─ runtime-context
      ├─ agent-request
      ├─ llm-stream
      └─ tool-pipeline

每个 seam 面板内再提供二段模式切换：

    [通用设置] [引擎能力设置]

    通用设置
      └─ promptConfigs.filter(config.layer === 当前 seam)
         ├─ 行为卡 1
         ├─ 行为卡 2
         └─ ...按同 seam 的 order 排序

    引擎能力设置
      └─ ENGINE_CAPABILITIES.filter(item.displayLayer === 当前 seam)
         ├─ seam:capability-id
         └─ ...每个 capability id 只出现一次

这是层级面板的模式切换，不应在每张卡里重复放下拉框。只有两个互斥模式时使用
segmented control 比下拉菜单更直接，也能避免用户误以为“通用设置”和“能力设置”
是同一配置实体的两个字段页。

模块卡显示 UI displayLayer 与可选的多个 runtime surface 标签。跨 seam 模块只渲染一张卡，
不要为了每个标签复制卡片或重复保存动作。现有 EngineModuleCard 和
EngineModuleList 可以作为第一阶段的 adapter。

特别规则：

- tool-bootstrap 应标为“工具目录/相位控制”或“跨 seam 控制”，不能把 UI 标签当作
  system-section 的运行承诺。
- promptConfigs 继续由 PromptConfigsEditor 管理；layer/order/audience 属于配置卡，
  不由模块卡代写。
- 六个 seam 的展示顺序可以固定为产品顺序，但不表示 engine 的全局运行顺序。
- 模型路由、模板变量、自定义工具和子代理策略保持各自领域卡，不强行伪装成普通
  engine module。

### 4.3 “通用设置 / 引擎能力设置”只做集合分组

模式切换的最小状态是：

    viewMode = common | capability

common 展示当前 layer 下零到多条 PromptConfigDraft，继续使用现有字段能力矩阵和
同 seam 的 order。capability 展示 displayLayer 属于当前 seam 的零到多张唯一模块卡，
由每个模块自己的 typed editor 消费对应 params/moduleConfigs。

不要创建一个接受任意键的万能表单。不同模块的字段校验、空值语义、保存时机和
重建副作用不同；把它们塞进动态 key/value 表单会失去错误定位和类型契约。
如果只有一个模块使用某字段，就留在该模块卡片里，不新增共享 seam。

### 4.4 ID、排序和保存

- 模块持久化 ID 使用稳定键，如 tool-bootstrap、context-gate、code-presentation。
- prompt config ID 独立于模块 ID 和 layer；不要用 layer 前缀重命名已有配置。
- 展示标签可以写成“system-section:tool-bootstrap”或“工具目录 · tool-bootstrap”，
  但不把它作为文件名或配置键；冒号在 Windows 文件名中也不可用。
- order 只在同一官方 seam 内解释；跨 seam 的卡片排序只是 UI 排序。
- 保存仍走 params/moduleConfigs/promptConfigs 各自的现有 bridge 与 writer，不新增第二个状态源。

### 4.5 能力 catalog 与依赖链

需要一个静态、受版本控制的最小 catalog。它不是动态表单 DSL，只描述 UI 归属和创建
事务：

    interface EngineCapability {
      id: string
      providedBy: readonly string[]
      createModules: readonly string[]
      rowIds: readonly string[]
      displayLayer: EngineLayer
      runtimeSurfaces: readonly string[]
      requiresModules?: readonly string[]
      initialParams?: Readonly<Record<string, unknown>>
    }

示例：

    tool-bootstrap:
      providedBy: [tool-bootstrap]
      createModules: [tool-bootstrap]
      rowIds: [tool-bootstrap]
      displayLayer: system-section

    deliberation-gate:
      providedBy: [deliberation-gate]
      createModules: [deliberation-gate]
      rowIds: [deliberation-gate]
      displayLayer: tool-pipeline
      initialParams:
        deliberationGate: true

catalog 需要契约测试保证：

- capability id 唯一；providedBy/createModules 和 rowIds 的对应关系无歧义；
- 每个参数控件只出现在一张能力卡，且现有参数桥仍能命中对应 row；
- providedBy/createModules 可以从现有 source/local 或 library 解析；
- requiresModules 无环且引用已知模块。

参数控件继续由专用 typed card 明确拥有，不必为了 catalog 再复制一份完整 paramKeys
清单。只有实际需要用它做覆盖率校验时，再将参数归属提升为 shared 常量。

### 4.6 能力与 recipe 分离

硬依赖和一键组合不是一回事：

- requiresModules：缺少就不能正确装配的硬依赖。
- recipe：产品提供的一键组合，按稳定顺序创建多张不同能力卡。

context-gate、tool-bootstrap、code-presentation 可以独立装配；它们是推荐组合，不应
互相声明为硬依赖。连锁创建使用单独的静态 recipe：

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

这些名称和初始值是产品选项示例，正式实现只保留确有用户工作流的 recipe。recipe
展开后不写入 preset.yml；最终真相仍只有 modules、params 和 moduleConfigs。

### 4.7 新建能力的原子事务

UI 不应先保存参数、再追加模块、再逐个创建卡片。新增一个受控 bridge 操作，一次提交
capabilityId 或 recipeId：

    POST engine-capability
    { action: "create", capabilityId: "deliberation-gate" }

    POST engine-capability
    { action: "create-recipe", recipeId: "phase-control-ptc" }

host 侧执行：

1. 从服务端 catalog/recipe 解析白名单项，忽略客户端提供的 module/param 任意值。
2. 要求当前 preset 有 modules 数组；官方/不透明 composition 返回稳定只读错误。
3. 展开 recipe 与 requiresModules 的拓扑顺序并检查当前 preset modules。
4. 在内存 YAML Document 中按约束位置插入缺失 modules，并只写明确的 initialParams。
5. 用候选 Document 的 PresetSpec 运行 renderComposition()/assertCompositionArray()；
   校验通过后才原子替换 preset.yml。
6. 只触发一次 rebuildPreset()。
7. bootstrap 重载后，UI 由新的 modules 事实自然渲染所有连锁新增卡片。

例如用户新建 deliberation-gate 时追加一项并出现一张卡；选择 phase-control-ptc
recipe 时一次追加三项，重载后出现三张卡。重复创建应幂等，不重复 modules，也不覆盖
用户已有参数。

“删除能力”不要和第一版一起做。模块可能被其他能力、提示词策略或预设组合依赖；
等 catalog 有反向依赖检查和明确的 dormant-param 保留策略后再加入。

withPresetDoc() 当前会在 mutate 返回后立即写盘，无法承担“落盘前渲染校验”。实现 recipe
时应抽取它内部已有的 parseDocument + atomicWriteTextFile 模式，增加一个接受 validate
回调的最小 helper，而不是先写坏文件再回滚。

需要同步配置的相位链必须由 recipe 一次写入。例如 context-gate、tool-bootstrap、
code-presentation 共用 promoteOn/includeSubagents 时，应写一致的 moduleConfigs，
并保持显式 modules 顺序；不能依赖目录排序或并发插件加载顺序。

## 5. 落地顺序

### 阶段一：建立模块事实和 catalog

把最小 catalog 放在 host/client 可共用的 shared 模块，并让 bootstrap 返回当前
preset 的 declaredModules、effectiveModules 和所需 moduleConfigs 摘要。不要从 params
非空反推模块存在，也不要把任意行配置暴露给客户端。

    const LAYER_VIEW_ORDER = [
      "pre-step",
      "system-section",
      "runtime-context",
      "agent-request",
      "llm-stream",
      "tool-pipeline",
    ]

    const ENGINE_CAPABILITIES = {
      "tool-bootstrap": {
        providedBy: ["tool-bootstrap"],
        createModules: ["tool-bootstrap"],
        rowIds: ["tool-bootstrap"],
        displayLayer: "system-section",
        runtimeSurfaces: ["system-prompt/assemble", "agent/request", "session/event"],
      },
      "context-gate": {
        providedBy: ["context-gate"],
        createModules: ["context-gate"],
        rowIds: ["context-gate"],
        displayLayer: "pre-step",
        runtimeSurfaces: ["agent/pre-step", "system-prompt/assemble", "session/event"],
      },
    }

catalog 只用于展示、参数归属校验和受控创建，不取代 manifest 的 modules 装配。

当前 getEngineMeta().layers 对集合调用 sort()，得到的是字母序，不能作为上述产品
顺序的依据。正式实现前应让引擎 meta 返回显式顺序，并继续由它作为客户端唯一来源；
不要在 host、client 和文档分别维护三份顺序常量。

### 阶段二：拆分现有聚合卡

把当前卡片内部明确分为：

- 通用呈现：折叠、状态、说明和 surface 筛选。
- 能力编辑：模块已有的参数控件，继续调用现有 store action。

把 EngineModuleList 当前三张聚合卡拆成真实能力卡，并按上面的参数归属移动控件：

- tool-bootstrap；
- context-gate；
- anchor-turn；
- code-presentation；
- tool-filter；
- deliberation-gate；
- cot-drip。

只显示当前 modules 已装配的卡。不要同时移动 engine 文件、修改组合路径或改写参数键。

### 阶段三：新建能力

增加“新建引擎能力”菜单和原子 bridge 端点。菜单列出未装配能力和少量显式 recipe；
创建后由 bootstrap 事实驱动一张或多张卡片出现。专用 JSX 编辑器继续保留，不生成
万能 key/value 表单。

### 阶段四：视图分组

确认一能力一张卡与新建事务稳定后，再加入每个 seam 的“通用设置 / 引擎能力设置”
二段视图。这样交互重排不会与持久化改造混在一个提交。

### 阶段五：验证

至少覆盖：

- layer filter 只影响显示，不改变 modules/promptConfigs 生成结果；
- 同一跨 seam 模块不会重复注册或重复保存；
- 无 modules 声明的参数不误显示为已装配能力；
- 新建依赖链只写一次 preset.yml、只触发一次 rebuild，重复创建幂等；
- recipe 不写入 preset.yml，不形成第二套运行状态；
- 新建只写 initialParams，不覆盖已有 params/moduleConfigs；
- recipe 失败时 preset.yml 保持原样；
- declaredModules/effectiveModules 正确覆盖 modules: [] fallback；
- composition module key、Cordis row id 和 UI capability id 不混用；
- 无 modules 数组的官方/不透明 composition 保持只读；
- params > moduleConfigs > 行默认优先级不变；
- 空字符串、空数组、variables 空占位值的语义不变；
- 保存期间继续编辑不会被旧响应覆盖；
- 主会话、子代理和 compaction/end 的行为保持一致。

官方 agent preset 使用 standing composition：文件和 UI 卡片可立即更新，但已有内容的
当前会话不会热插拔新模块。新能力对新会话生效；空会话可继续走官方 agentPresets
重组。UI 保存成功文案必须说明这一点。

## 6. 最终判断

采用“一能力一张 UI 卡 + modules 决定存在 + catalog 连锁创建 + 能力模块保持现有
运行结构”是可行且风险最低的路径。现有 appendPresetModules、withPresetDoc、
buildModuleConfigsFromParams 和 rebuild 回调已经覆盖大部分基础设施。

关键修正是：模块卡不能由参数非空推断存在；连锁创建必须由服务端 catalog 在一次
原子事务中完成；modules: [] 的 fallback 与新会话生效语义必须显式展示。按六层重排
engine 物理目录、同模块多实例或用 seam:模块名替代现有 ID，仍不属于本方案。

相关长期契约：

- [docs/ui-architecture.md](docs/ui-architecture.md)：客户端页面、模块卡、状态和 UI 边界。
- [docs/engine-reuse.md](docs/engine-reuse.md)：engine module、六个 seam、epoch 和组合复用。
- [docs/architecture-params.md](docs/architecture-params.md)：params/moduleConfigs/promptConfigs 的保存与优先级。
