# Engine 模块分组框架可行性

> 结论：有条件可行。
> 推荐采用“按 seam 展示、按能力实现、按契约保存”，不把 engine 运行时代码机械移动到六个注入点目录。
> 依据：当前 engine/、src/host/manifest.ts、src/client/features/modules/EngineModuleList.tsx 与现有架构文档。

## 1. 提案要解决的问题

原始设想是按六个官方注入点组织模块与设置界面：

    engine/
    ├─ system-section/
    ├─ runtime-context/
    ├─ pre-step/
    ├─ agent-request/
    ├─ llm-stream/
    └─ tool-pipeline/

UI 侧希望每张模块卡通过下拉切换“通用设置”和“引擎能力设置”，并用类似
system-section:引擎名的唯一名称区分卡片。

这个方向同时混合了三种不同对象：

1. 官方运行 seam：提示词或工具实际接入宿主的位置。
2. engine module：实现一组运行时行为的模块。
3. UI card：编辑 params、moduleConfigs 或 promptConfigs 的呈现适配器。

三者可以关联，但不能当成同一个目录和同一个持久化实体。

## 2. 可行性结论

| 方案部分 | 结论 | 原因 |
|---|---|---|
| UI 按六个 seam 筛选或展示 | 可行 | promptConfigs 已有 layer；现有模块列表也已有 layerFilter |
| engine 源码按六个 seam 物理拆目录 | 不建议 | 多个模块跨 seam、跨事件和跨 epoch；拆分会复制状态或增加转发层 |
| 每个模块只归属一个 seam | 不成立 | prompt-config-engine、context-gate、tool-bootstrap 等都拥有多个接入面 |
| 通用/能力设置切换 | 有条件可行 | 应作为 seam 面板的集合视图；两类字段仍由不同契约和 owner 保存 |
| 用 seam:模块名作为持久化 ID | 不建议 | seam 改名会破坏已有配置；模块 ID 和展示标签应独立 |
| 把 tool-bootstrap 放进 system-section 模块 | 不成立 | 它控制工具目录、晋升和压缩相位，不是一个 system-section 提示词配置 |

因此，整套方案按原样落地的可行性较低；作为 UI 信息架构的改造方向可直接采用。

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
      └─ MODULE_UI_META.filter(item.displayLayer === 当前 seam)
         ├─ seam:module-id
         └─ ...每个 moduleId 只出现一次

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
- 展示标签可以写成“工具目录 · tool-bootstrap”，但不把标签作为配置键。
- order 只在同一官方 seam 内解释；跨 seam 的卡片排序只是 UI 排序。
- 保存仍走 params/moduleConfigs/promptConfigs 各自的现有 bridge 与 writer，不新增第二个状态源。

## 5. 落地顺序

### 阶段一：只改展示

在现有 features/modules/EngineModuleList.tsx 上补一份最小静态元数据：

    const MODULE_UI_META = {
      "tool-bootstrap": {
        displayLayer: "system-section",
        runtimeSurfaces: ["system-prompt/assemble", "agent/request", "session/event"],
      },
      "context-gate": {
        displayLayer: "pre-step",
        runtimeSurfaces: ["agent/pre-step", "system-prompt/assemble", "session/event"],
      },
    }

元数据只用于过滤、徽章和分组，不参与 engine 装配。验收保持现有
module card、prompt config ordering、bridge 和 preset 生成测试全通过。

### 阶段二：拆卡片内的编辑面

把当前卡片内部明确分为：

- 通用呈现：折叠、状态、说明和 surface 筛选。
- 能力编辑：模块已有的参数控件，继续调用现有 store action。

先处理 tool-bootstrap、context-gate 和工具管线三组真实卡片。不要同时移动
engine 文件、修改组合路径或改写参数键。

### 阶段三：只有出现第二个 adapter 才抽接口

若同一能力需要 Web UI 与 TUI 或多个预设共用，才抽一个小的 module interface
或纯 editor helper。接口应隐藏校验、参数转换和保存队列；调用方只知道提交结果
和错误。单一调用方不提前建 catalog、registry 或动态表单。

### 阶段四：验证

至少覆盖：

- layer filter 只影响显示，不改变 modules/promptConfigs 生成结果；
- 同一跨 seam 模块不会重复注册或重复保存；
- params > moduleConfigs > 行默认优先级不变；
- 空字符串、空数组、variables 空占位值的语义不变；
- 保存期间继续编辑不会被旧响应覆盖；
- 主会话、子代理和 compaction/end 的行为保持一致。

## 6. 最终判断

采用“六层作为 UI 视图 + 能力模块保持现有运行结构”是可行且风险最低的路径。
按六层重排 engine 物理目录、把所有独立设置塞进 system-section 卡片、或用
seam:模块名替代现有 ID，都不应作为本轮重构目标。

相关长期契约：

- [docs/ui-architecture.md](docs/ui-architecture.md)：客户端页面、模块卡、状态和 UI 边界。
- [docs/engine-reuse.md](docs/engine-reuse.md)：engine module、六个 seam、epoch 和组合复用。
- [docs/architecture-params.md](docs/architecture-params.md)：params/moduleConfigs/promptConfigs 的保存与优先级。
