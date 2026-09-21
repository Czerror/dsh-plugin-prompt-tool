# Web 客户端 UI 结构框架

> 适用范围：dsh-plugin-prompt-tool 的 src/client/ 结构、宿主 SlotRegistry 接入、工作台页面编排、客户端状态与 bridge 边界、共享交互和样式所有权。
> 本文描述当前实现，不是实施计划；与代码不一致时以代码为准。
> 相关代码：src/client/index.ts、src/client/app/、src/client/data/、src/client/features/、src/client/ui/、src/shared/bridge-contract.ts。

本文将已完成的 UI 重构结论固化为长期维护契约。preset、params、promptConfigs、variables、customTools、角色卡和子代理策略的存储及生成语义仍以现有 host/engine 文档为准；本文只说明客户端如何承载这些能力。

## 1. 定位与边界

客户端的产品边界是“位置、时机与受众可配置的提示词注入工作台”。工作台负责编辑、展示和提交配置，不重新定义引擎的九个官方插入点，也不把某一个预设能力提升为全局默认。

结构重构遵循以下原则：

- 宿主原子优先：标准按钮、模态框和布局能力优先复用 DSH 官方 primitive。
- 现有 seam 深化：继续使用 SlotRegistry、SettingsScope、official remote/sessions 和 loopback bridge。
- 领域文件归位：工作台壳、数据层、业务 feature、共享 UI 各自拥有清晰的变化原因。
- 最小抽象：不为单一实现创建 Button、Card、Tabs、router、状态库或 service/repository 多层包装。
- 确定性行为：页面顺序、slot 注册、保存保护、键盘操作和错误载荷均由契约测试锁定。

本层不做：

- 修改 DeepSeek Harness 源码、bundle 顺序或 profile 装配。
- 使用宿主 DOM 选择器、MutationObserver 或独立 React root。
- 引入 Tailwind、CSS-in-JS、第二套主题变量、Redux、Zustand、路由库或新的测试框架。
- 改变 preset.yml 的字段、优先级、空值语义、原子写盘和引擎运行时顺序。
- 将 PTC、首轮锚定、router-guide、Flash 路由等可选能力变成默认主线。

## 2. 分层与依赖方向

客户端固定为四层，根入口只做宿主适配：

    index.ts
      |
      +-- app/workbench + app/workspace
              |
              +-- features
              |      |
              |      +-- data
              |      +-- ui
              |
              +-- data + ui
                      |
                      +-- shared contract / React / DSH primitives

依赖规则如下：

| 层 | 责任 | 可以依赖 | 不应依赖 |
|---|---|---|---|
| index.ts | 声明 inject、构造宿主适配面、注册工作台 | app/workbench、data、shared | 具体页面、业务卡片、CSS 细节 |
| app/ | Slot owner、工作台壳、页面组合 | features、data、ui、官方 client API | host 内部实现、另一套导航/状态框架 |
| features/ | 单一业务领域的视图、瞬时状态和领域 helper | data、ui、自己的 CSS、官方 primitives | 其他 feature 的内部文件、slot 注册 |
| data/ | bridge、Fields、store facade、保存与纯逻辑 | shared contract、React hooks（仅 hook 文件） | React 业务视图、feature 组件 |
| ui/ | 只接收 props/callback 的共享呈现和交互 | React、同层 helper、官方 primitives、controls.module.css | store、bridge、data、features、宿主 DOM |
| shared/ | client/host 共用的字段、路径和载荷契约 | 标准 TypeScript | 任一具体 UI 实现 |

跨领域组合只发生在 app/workspace/pages/。feature 可以消费 data 和 ui，但不能通过 feature 之间的内部 import 形成环。相对 TypeScript import 保留显式 .ts/.tsx 扩展名，不新增 feature barrel。

## 3. 当前目录结构

以下树以当前源码为准；没有列出的目录不代表预留扩展点，新增目录必须先有真实 owner。

    src/client/
    ├─ index.ts
    ├─ locales.ts
    ├─ locales-cards.ts
    ├─ locales-params.ts
    ├─ locales-prompts.ts
    ├─ prompt-tool-types.ts
    ├─ app/
    │  ├─ workbench/
    │  │  ├─ FloatingTrigger.tsx
    │  │  ├─ floating-trigger-position.ts
    │  │  ├─ register-workbench.tsx
    │  │  ├─ SettingsTab.tsx
    │  │  ├─ Workbench.module.css
    │  │  ├─ WorkbenchOverlay.tsx
    │  │  ├─ workbench-face.ts
    │  │  └─ workspace-controller.ts
    │  └─ workspace/
    │     ├─ PromptWorkspace.module.css
    │     ├─ PromptWorkspace.tsx
    │     ├─ workspace-browse-state.ts
    │     ├─ WorkspaceFrame.tsx
    │     ├─ WorkspaceNavigation.tsx
    │     ├─ workspace-pages.ts
    │     └─ pages/
    │        ├─ ConfigListWithTemplates.tsx
    │        ├─ EngineLayersPanel.tsx
    │        ├─ layer-settings.module.css
    │        ├─ MainSessionPage.tsx
    │        └─ SubagentPage.tsx
    ├─ data/
    │  ├─ bridge-client.ts
    │  ├─ bridge-transport.ts
    │  ├─ dirty-state.ts
    │  ├─ host-api.ts
    │  ├─ import-files.ts
    │  ├─ instruction-drafts.ts
    │  ├─ instruction-policy.ts
    │  ├─ model-sync-notice.ts
    │  ├─ param-overrides.ts
    │  ├─ prompt-config-content.ts
    │  ├─ prompt-tool-fields.ts
    │  ├─ prompt-tool-view.ts
    │  ├─ save-queue.ts
    │  ├─ session-model-face.ts
    │  ├─ use-import-preview-flow.ts
    │  ├─ use-prompt-tool-fields.ts
    │  ├─ use-prompt-tool-store.ts
    │  └─ workspace-drafts.ts
    ├─ features/
    │  ├─ characters/
    │  │  ├─ character-card.ts
    │  │  ├─ characters.module.css
    │  │  └─ CharactersPage.tsx
    │  ├─ models/
    │  │  ├─ model-options.ts
    │  │  └─ ModelRouteCard.tsx
    │  ├─ modules/
    │  │  ├─ EngineModuleList.tsx
    │  │  └─ EngineParamFields.tsx
    │  ├─ persona/
    │  │  └─ PresetPersonaCard.tsx
    │  ├─ presets/
    │  │  ├─ presets.module.css
    │  │  ├─ PresetsPage.tsx
    │  │  └─ PresetSwitcher.tsx
    │  ├─ prompts/
    │  │  ├─ prompt-config-order.ts
    │  │  ├─ prompt-config-policy.ts
    │  │  ├─ prompts.module.css
    │  │  ├─ PromptConfigCard.tsx
    │  │  ├─ PromptConfigFields.tsx
    │  │  ├─ PromptConfigForm.tsx
    │  │  ├─ PromptConfigList.tsx
    │  │  ├─ PromptConfigsEditor.tsx
    │  │  ├─ textarea-resize.ts
    │  │  ├─ useTemplatePicker.ts
    │  │  └─ WorldBookDiagnosticsCard.tsx
    │  ├─ skills/
    │  │  ├─ skill-status.ts
    │  │  ├─ skills.module.css
    │  │  ├─ SkillRow.tsx
    │  │  └─ SkillsPage.tsx
    │  ├─ subagents/
    │  │  ├─ DelegationToolsCard.tsx
    │  │  ├─ subagent-policy-draft.ts
    │  │  ├─ subagents.module.css
    │  │  └─ SubagentToolPolicyCard.tsx
    │  └─ tools/
    │     ├─ custom-tool-parameters.ts
    │     ├─ CustomToolEditor.tsx
    │     ├─ CustomToolsCard.tsx
    │     ├─ tools.module.css
    │     ├─ ToolsPreviewPage.tsx
    │     ├─ tool-surface-request.ts
    │     └─ ToolSurfaceView.tsx
    └─ ui/
       ├─ anchored-popover-fit.ts
       ├─ anchored-popover.ts
       ├─ CollapsibleCard.tsx
       ├─ ConfirmDialog.tsx
       ├─ controls.module.css
       ├─ dialog-focus.ts
       ├─ DialogSurface.tsx
       ├─ EngineModuleCard.tsx
       ├─ FormField.tsx
       ├─ HintTooltip.module.css
       ├─ HintTooltip.tsx
       ├─ hint-tooltip-focus.ts
       ├─ hint-tooltip-position.ts
       ├─ ImportFileButton.tsx
       ├─ ImportPreviewCard.tsx
       ├─ LayerCard.tsx
       ├─ MenuSelect.tsx
       ├─ menu-focus.ts
       ├─ reveal-card.ts
       ├─ SettingInputRow.tsx
       ├─ StatusBadge.module.css
       ├─ StatusBadge.tsx
       ├─ StatusDot.module.css
       ├─ StatusDot.tsx
       ├─ tab-key.ts
       ├─ TagInput.tsx
       ├─ TemplatePicker.tsx
       └─ ToggleRow.tsx

共 107 个源文件：app 16、data 18、features 40、ui 28、顶层 5。生成目录 lib/ 不属于源码 owner，不手工编辑。客户端样式已按 owner 分开，PromptUi.module.css 不再存在。

## 4. 宿主接入与生命周期

### 4.1 入口装配

src/client/index.ts 的 inject 列表是：

    locale
    slots
    settingsScope
    uiWorkspace
    uiSession
    remote
    remote.agentPresets
    remote.session
    sessions

apply(ctx) 依次构造：

1. locale 字典注册：`ctx.effect(() => registerPromptToolLocale(ctx.locale))` 把 `src/client/locales.ts` 的 zh/en 字典注册进官方命名空间 `prompt-tool`；卸载/重挂由 effect 释放，不重复注册。随后 `ctx.locale.bind(LOCALE_NS)` 得到引用稳定的 `t`。
2. 连接世代重建：`ctx.on('connection/reset')` 触发一次 `bridgeCall('models', { refresh: true })`，让宿主重连后丢弃陈旧的模型目录缓存；失败静默，不阻塞启动。
3. prompt-tool SettingsScope transport，用于标准部署设置的 mirror、ensure 和 mutate。
4. PromptToolHostApi，封装目录选择、打开路径、预设切换和当前会话模型选择；`currentSessionId()` 经 `session-id-source.ts` 读 `ctx.uiSession.adapter.current` 的作用域绑定——官方在 `0.1.6-alpha.2` 删除了 `SessionListState.current`（当前选中会话已移出 Session Controller，`ISessions` 注释：navigation belongs to view owners），视图层的 selection 均为 private，作用域绑定是唯一公开读取路径。session-model-face 在这里**内联构造**为 `api.sessionModel` 字段（不单独成步），内部经 `remote.session.selectModel` 写回。
5. PromptToolWorkbenchFace：controller / api / settings / `t`。
6. registerWorkbenchSlots(ctx, face)，唯一负责 shell.overlay 悬浮入口与 settings.plugins.tab 的注册。

入口不直接导入页面、bridge endpoint 或业务卡片；需要新宿主能力时先扩展 data/host-api.ts 或 shared 契约。

### 4.2 Slot 契约

| 官方注册面 | id / key | 位置 | owner | 作用 |
|---|---|---|---|---|
| settings.plugins.tab | prompt-tool | order 40 | SettingsTab | 部署开关、AGENTS 写入/注入和默认预设 |
| shell.overlay | prompt-tool-workbench | order 50 | WorkbenchOverlay | 可拖动悬浮触发器 + body portal 抽屉 |

两处 slot 都使用 ctx.slots.inject() 等待官方槽位声明，再调用 ctx.slots.register()。返回的 disposer 在 register-workbench.tsx 中统一释放。不要添加第二个注册入口，也不要改变 id 或 inject face 的形状。

两处注册都声明 `locale: PROMPT_TOOL_NS`：slot 组件由此拿到框架注入的 typed `t` seat，同时把「渲染需要已安装的 locale face」写成显式契约（locale face 由官方 dsh-client-locale 在 boot 期经 renderer 安装）。列表项 label（设置 tab 标题）用 `() => face.t('tab.label')` thunk，宿主重读 label 时取当前语言。

### 4.2.1 文案归属（locale）

- 用户可见文案统一归 `prompt-tool` 命名空间：zh 常量是唯一事实源，键类型由它派生，en 用 `Record<Key, string>` 强制键集一致；`register` 用官方类型化形式一次注册两种语言。文本量大的 feature 按 `locales.ts` / `locales-params.ts` / `locales-prompts.ts` / `locales-cards.ts` 分区，注册时在 `locales.ts` 合并成同一命名空间，不注册第二套框架。
- 组件树很深，不逐层重建 i18n 上下文：入口组件用注入的 `t`，`PromptToolWorkbenchFace.t` 作为同一 bind 结果的稳定引用向下传递（页面与卡片按需加 `t` prop）。
- 渲染时才求值（`t('key', params)`），不做模块级缓存；语言切换由 renderer 订阅 locale revision 后整体重渲染跟进。
- 不进字典的内容：provider/model id、文件路径、用户内容、协议 code 与 bridge 错误码；动态拼接用 `{name}` 占位参数。
- 已迁移：工作台外壳与悬浮入口、设置页、六页外壳、引擎参数卡与模块列表（标签按 shared 键推导成 `param.<键>` 词条）、提示词配置与人设区、角色库页、子代理「工具与深度」模块卡与实例级工具策略、自定义工具卡、导入预览卡。子代理策略的档位显示名（首次启用写入 preset.yml 的 seed 值）属于用户可改内容，保持原值不入字典。
- 仍未迁移：`ui/` 控件的回退文案（`MenuSelect` / `TagInput` / `DialogSurface` / `EngineModuleCard`），以及 `features/models/**` 与 `data/**` 的状态提示（这两个目录属模型路由任务的文件边界）。`test/client/locale-contract.test.mjs` 的 `MIGRATED_UI_FILES` 是迁移范围的单一事实源；新增已迁移文件时必须同步登记，否则契约测试不会守卫它的文案。

### 4.3 悬浮入口与关闭行为

- `shell.overlay` 注册可拖动悬浮触发器：位置是纯客户端界面偏好（localStorage，`floating-trigger-position.ts`），窗口尺寸变化时按实际按钮尺寸夹回可见区；不读宿主 DOM 几何，也不再占用 `sidebar.footer.action` 做 `--pt-sidebar-edge` 探针。
- 拖动与单击以 4px 位移阈值区分：拖动结束吞掉尾随 click，单击与键盘仍开合；触发器打开 body portal 抽屉，抽屉与触发器分别用 fixed + z-index 1000 / 1100 置顶，不被宿主「对话/轨迹」顶部导航栏遮挡。
- 关闭支持 Escape、点击背板与按钮切换，焦点在触发器与抽屉之间转移；抽屉打开时触发 PromptWorkspace.store.load()，关闭保留实例状态。
- 官方右侧栏（`@deepseek-ai/dsh-client-ui-sidebar-right`）实测不适合本项目：已移除 tab type / keyed body 两段注册、`PromptToolTab` 与 `sidebarRightTabs` inject。
- 插件不持久化工作台开关：悬浮抽屉开关是内存态，刷新回落。

### 4.4 0.1.5 新能力采用面

- 采用：shell.overlay 可拖动悬浮入口、官方 Switch / Tag。
- 已满足、无需接入：`host-open-in-app`。`PromptToolHostApi.openPath` 走 `remote.session.openWorkspacePath`，其契约就是宿主交给原生打开器；官方 `ui-open-in-app` 客户端包不提供跨插件服务，只是会话头部的分割按钮。
- 不适用：`ctx.workspaceFiles` 只覆盖 workspace 根，插件的读写路径域是 DSH_HOME（预设、技能、角色卡）。
- 不采用：官方右侧栏（`ui-sidebar-right`）实测不适合本项目，已移除（决策见 §4.3）；`client-resources` 资源 tab 需要自建 provider 与第二个 tab 类型，而工作台已在抽屉内就地编辑这些文件，重复呈现没有收益。

## 5. 工作台与页面信息架构

### 5.1 可见入口

    settings.plugins.tab
      └─ 基础设置：部署开关 + 默认预设

    悬浮入口（shell.overlay 可拖动触发器，位置存插件 localStorage）
      └─ 完整工作台（body portal 抽屉）
          ├─ 主会话
          ├─ 子代理
          ├─ 工具预览
          ├─ 技能设置
          ├─ 预设配置
          └─ 角色管理

settings tab 不复制工作台内容。完整工作台由 PromptWorkspace 创建 store、保存当前页，并在打开时触发一次 load；WorkspaceFrame 负责公共 header、导航、canvas、loading 和 notice。

预设的 roster、目录物化、复制、删除和默认值由本插件维护；官方 agentPresets 只用于会话预设切换及其与宿主默认值的双向同步。

### 5.2 页面 ID、顺序与组合

workspace-pages.ts 是页面元数据的唯一来源。默认页为 features，顺序不可变：

| id | 标题 | 主要组合 |
|---|---|---|
| features | 主会话 | 页面只声明受众视图与创建编排（创建菜单、模板浮层、指令回调），层内装配全部由 `EngineLayersPanel#engineLayerSlots` 提供；列表里是提示词配置实例卡（每张卡内嵌本层引擎设置区）与工具栏，预设包导入预览在工具栏 |
| subagent | 子代理 | 同一 `engineLayerSlots(audience: 'subagent')`、顶部九层模板菜单与各层内创建入口、ConfigListWithTemplates（scope=subagent）；引擎设置同样嵌在该层实例卡内 |
| tools | 工具预览 | 顶置统一搜索；当前会话／所选预设两个可折叠分组，预设选择位于分组标题右侧；双列展开详情卡，680px 以下单列 |
| skills | 技能设置 | 技能根与资产卡（用户技能根、创建、复制导入、技能文件夹引用）、状态与来源筛选、按来源分组的 SkillRow（调用策略开关、删除） |
| presets | 预设配置 | 全局生成开关、AGENTS 路径与生成顺序设置、PresetSwitcher 与预设 CRUD |
| characters | 角色管理 | PNG/JSON/YAML 预览导入、角色卡库、应用/移除/删除与目录打开 |

预设人设卡（`features/persona/PresetPersonaCard.tsx`）编辑 preset.yml 顶层 `persona` 段的四个可编辑项：`prefix`、`suffix`，以及 `complete`（独占）与 `includeRuntimeContext`（动态运行时上下文）两个开关（后者默认开启）。读写都走 `/persona`，写由 host 校验并原子写盘；`complete` 与提示词配置的「独占」互斥，由 bridge 在写盘前 fail loud。卡头 meta 区分「存在 persona 段」与「继承预设」——空对象 `{}` 也算存在，不等于有实际内容。四项均未改动时保存落成删除语义（不带 persona 写盘）；二次确认的移除入口只在 persona 段已存在时渲染。它只在主会话页出现，不在子代理页渲染。

### 5.2.1 创建入口与过滤的分工

工具栏的「添加注入模板」只包含九个插入点的模板入口，不按当前层筛选删减。能力模块和连锁组合放在对应层设置区的「添加本层能力」入口；组合以首个能力的主归属层为入口，其跨层装配行为仍由既有配方声明决定。自定义工具区内提供空白工具和工具模板创建，模板变量在自己的编辑区内添加，空资产仍保留创建入口。引擎参数与资产编辑器只内嵌在真实提示词配置卡中；当前受众没有该层实例时保持空状态，由用户显式插入模板创建，不自动生成设置卡或提示词规则。

**过滤与新建严格分离**：过滤下拉与搜索词只由用户手动改变，创建路径一律不写入过滤状态；新建只做两件事——展开新卡并滚动定位到它（能力卡定位锚点是能力 id，配置卡锚点是配置 id，节点未就绪时按上限重试后静默退出）。因此目标卡落在被筛掉的层或作用域时保持不可见，切到该层或「全部」即可见；同一能力重复创建每次都重新展开（定位信号带递增 token，不依赖 id 变化）。模板重复创建时分配唯一标识，不覆盖原配置。

**新建即可见由受众代入保证**：子代理列表新建的配置写 `audience: subagent`，主会话列表新建的配置清除模板自带的「仅子代理」限制回落公用，二者都不改动过滤框。工具模板浮层锚定本次实际点击的层内按钮，和顶部模板入口分开保存锚点；选中或Escape关闭后回到原按钮。浮层初始焦点在定位可见帧设置，不落到仍隐藏的控件；空变量创建后焦点进入新增变量名输入。空白工具的id和模型可见名均不重复，创建绑定发起预设，切换后不能重放。子代理页复用同一套创建纪律。

主会话页中的卡片顺序是 UI 分组，不表示九个官方注入 seam 的运行顺序。九个插入点彼此独立，运行时顺序和参数语义见 [engine-reuse.md](engine-reuse.md)。

工具预览与工具编辑分离。`useCustomToolsEditor` 由主/子页面常驻调用，负责同一预设的读取、草稿与显式保存；创建直接消费动作并写共享草稿池，设置区只渲染其内容。连续创建不依赖卡片挂载，切页后已建立的草稿继续保留，不重放请求。加载或读取失败、预设不匹配和只读时拒绝创建并给出提示，不将空列表当读取成功。预览不隐藏自定义工具，不自动创建／恢复会话；当前会话读取冻结 generation，所选预设读取后续 generation，切换来源或刷新会丢弃旧请求响应。

样式参照官方 `ui-settings-plugin-inventory/PluginInventorySettingsTab`，不是可配置插件表单。卡头复用共享 `StatusBadge`（StatusDot + 官方 Tag）与官方 Chevron，标记真实的「模型可见」；展开显示完整名称、来源视角、可见状态与描述。工具摘要没有插件配置启停或运行阶段，不显示虚构的「已启用／运行中」。搜索只在客户端过滤，并自动展开分组，不增加 bridge 请求。

引擎字段由 `EngineParamFields` 按 `ENGINE_PARAM_DEFINITIONS` 生成，能力存在性仍由真实模块事实决定。普通参数不再在 JSX、默认值、读回、保存和快照中各抄一遍；枚举使用 MenuSelect，列表使用 TagInput，阶段保留结构化编辑。

### 5.3 状态展示约定

- loading：保留已有数据；只有没有可展示数据时才显示骨架。
- saving：只禁用冲突动作，不冻结其他草稿输入。
- notice：配置保存/校验反馈位于操作区，字段错误用 aria-invalid/aria-describedby 关联；同一结果只由一个 live region 播报。
- destructive action：配置、能力、预设、角色库删除以及丢弃文件草稿使用 ConfirmDialog；取消先聚焦、请求中防重复提交，失败保留确认面，关闭后还焦。危险按钮统一为「描边染红」形态（`.pillButton[data-danger]`：透明底 + error 混色的文字与描边），确认按钮与取消按钮是同一个 `.pillButton` 胶囊（尺寸、圆角、字号一致），只以 `data-danger` 区分主次；所有删除入口共用该组件，外观不各走一套。
- 长路径与名称允许换行或在展开区提供完整可选择文本，不以原生 title 作为唯一读取入口。
- 配置操作区与列表共用 canvas 滚动根，sticky 高度由自身 ResizeObserver 测量；短视口退回普通流，焦点与定位避开操作区。
- 吸顶操作区用系统Canvas作为不透明基底，其上叠宿主语义表面；第三方主题将背景设为透明/半透明或省略变量时，正文仍不会透出。

## 6. 状态与数据流

### 6.1 所有权

| 状态 | Owner | 生命周期/规则 |
|---|---|---|
| 工作台抽屉开关 | workspace-controller | 工作台实例内存态；刷新回落 |
| 当前顶层页 | PromptWorkspace | 工作台挂载期；不写 URL 或 localStorage |
| fields、meta、catalog | usePromptToolStore | 工作台挂载期；打开时重新同步 |
| 标准设置值 | 官方 SettingsScope | 宿主 mirror 生命周期 |
| 当前会话模型 | session-model-face | 官方 sessions projection 生命周期 |
| filter、search、列表展开、页滚动 | workspace-browse-state | 工作台实例期，配置视图按页面/预设区分；异步资源就绪后一次恢复滚动 |
| 工具、人设、策略、原始 JSON/数字草稿 | store.editorDrafts / workspace-drafts | 按预设和字段身份保留；未存草稿或保存中阻止预设切换；改名迁移、删除清理对应字段 |
| 指令文件正文草稿 | instruction-drafts | 与预设保存队列分离；按指令上下文（`contextId`）隔离，旧上下文迟到响应不覆盖当前视图 |
| 导入预览与提交阶段 | use-import-preview-flow | 每次 `run()` 独立生命周期；卸载结束等待、不悬挂 Promise |
| 模型同步提示 | model-sync-notice | 纯函数，从保存结果推导提示，不持有状态 |
| 创建意图、菜单、删除/导入确认、拖拽 | 对应 feature | 仍随页面卸载失效；不恢复或重放危险操作 |
| 保存队列、revision、草稿版本 | save-queue + store | 工作台挂载期 |
| 大文本和角色卡原文件 | 文件通道/bridge | 不进入 settings descriptor |
| 技能调用策略 / 技能文件夹引用 | 技能文件（`SKILL.md` 的两个官方键）+ 插件状态文件（`$DSH_HOME/skills/.system/prompt-tool/skills.yml`，只存 `folders`） | 停用 = 改写该技能 frontmatter 的 `disable-model-invocation` / `user-invocable`（正文与其余字段逐字保留）；引用只登记路径。技能实体归官方各技能根所有，插件不搬迁。契约见 [skills-management.md](skills-management.md) |

不新增 React Context 来广播整个 store。页面通过 usePromptToolFields selector 订阅窄切片，叶子组件接收显式值与 callback。

业务草稿不写 localStorage，不靠常驻六页保留。工具、人设与策略只确认提交快照，保存途中继续编辑仍待存；同预设重挂共享在途状态，策略卸载清除未发送队列。干净重挂重新读取远端事实，脏草稿优先保留。技能批量作用于当前结果中合法已选项，固定目标快照，完成后刷新磁盘事实并保留失败选择。

### 6.2 首屏读取与更新

    打开悬浮工作台抽屉
      -> PromptWorkspace.store.load()
      -> bridgeCall("bootstrap") 聚合 descriptor、meta、变量和 promptConfigs
      -> fieldsFromView() 合并 value/base 与 presetParams
      -> /models 按需加载并缓存模型目录
      -> page selector 订阅 fields 引用

bootstrap 是首屏聚合请求，不因筛选或输入字符增加 bridge 请求。模型目录保持惰性加载；技能筛选、状态筛选和搜索在客户端完成。技能写入后局部刷新 `/skills-list`，不重载预设或指令草稿；两个技能导入入口统一经过数据层的覆盖确认与写入流程。

同一预设的后台刷新同时保护请求开始前已有的未保存提示词配置与模板变量草稿，以及请求期间新增的编辑。保存后同步元数据时，已确认写入的提示词定义不被暂时为空的生成快照覆盖。未填写名称的变量行只在写入载荷中清理，本地编辑行保留；预设身份切换仍按原保存与上下文边界处理。

### 6.3 纯逻辑与 facade

use-prompt-tool-store.ts 是唯一工作台 facade，负责把 SettingsScope mirror、typed bridge、字段快照、保存队列和 feature actions 组合成 React 可消费状态。可独立测试的逻辑放在以下模块：

| 模块 | 责任 |
|---|---|
| prompt-tool-fields.ts | Fields、StageDraft、默认值、字段级 helper |
| prompt-tool-view.ts | bootstrap/view 到 Fields 的 shape guard 与映射 |
| dirty-state.ts | snapshot、深比较、阶段草稿完整性和 reload 判定 |
| param-overrides.ts | params 的列表拆分、条件发送和读回 patch |
| prompt-config-content.ts | preset.md 内容资产的提升与剥离；AGENTS 文件卡（`params.file`）的正文提升与文件写回分流 |
| save-queue.ts | 串行保存任务的最小队列 |
| import-files.ts | 浏览器文件导入的纯读取辅助 |
| use-import-preview-flow.ts | 导入的预览→确认→提交流程状态机（预设包与角色卡共用） |
| workspace-drafts.ts | 按预设身份的跨页草稿池：人设、工具、策略与展开状态 |
| instruction-drafts.ts | 指令文件正文的独立草稿池与版本基线 |
| instruction-policy.ts | 指令策略的读写、默认值与单文件开关推导 |
| model-sync-notice.ts | 预设保存后的宿主默认模型同步提示推导 |
| session-model-face.ts | 官方会话模型 projection 与选择动作 |

这些模块不重复实现页面渲染，也不把 feature 专属网络流程塞回通用 transport。

## 7. Bridge 契约与保存语义

### 7.1 单一来源

src/shared/bridge-contract.ts 同时拥有：

- 前缀 /api/prompt-tool/settings；
- BRIDGE_ENDPOINTS 路径表；
- BridgeRequestMap 请求体映射；
- BridgeValueMap 响应 value 映射；
- 请求/响应覆盖的编译期断言。

data/bridge-client.ts 提供泛型 bridgeCall(endpoint key, typed body) 和角色卡专用 bridgeUpload。业务组件不得拼接 /bootstrap、/preset-delete 等原始路径。新增或改名端点必须同步 shared map、host 注册和契约测试。

### 7.2 传输层

bridge-transport.ts 只负责 HTTP/Blob 传输和结果 shape guard：

    成功：{ ok: true, value, ...可选扩展 }
    失败：{ ok: false, code?, message?, conflicts? }

技能导入同名时返回 `skills-overwrite-required` 与目录名单，由技能页复用 ConfirmDialog 等待用户选择。
确认后以 `overwrite` 名单重发原载荷；取消或页面卸载结束等待，不发覆盖请求。两个导入入口共用
`data/skill-import.ts` 的确认协议；该协议不使用内容版本或历史备份。

JSON bridge 的统一上限为 32 MiB；角色卡原始文件流独立限制为 64 MiB，避免 base64 膨胀。transport 不解析 feature 数据，也不拥有 Fields。

宿主尚未就绪或路由未注册时，HTTP 层可能返回空体或非 JSON 响应；transport 统一转成 `ok: false` 的可诊断桥接错误（含 HTTP 状态码），不把原生 `response.json()` 异常透传给 UI。

### 7.3 保存保护

1. 全局 settings 保存使用独立队列；参数与 promptConfigs 共享预设保存队列，跨通道严格串行。
2. 请求使用保存时的 snapshot；成功后只更新该 snapshot 的 saved 基线。
3. 请求期间继续编辑时，当前 fields 与 saved snapshot 不同，dirty 保持为真。
4. 成功后的静默 load 留在预设队列内，且只在全局草稿版本未变化、其他通道无待存草稿、对应草稿仍等于请求快照时执行；参数还要求没有未完成阶段草稿。
5. promptConfigs 自动保存使用 debounce；工具栏手动保存仍经过配置校验，模块列表不再提供未保存提示、放弃修改和浮动保存条。
6. 参数空字符串/空数组沿用删除键语义；variables 的空字符串仍是合法占位值。详细参数规则见 [architecture-params.md](architecture-params.md)。
7. 预设写入携带 `expectedPresetId`，读回失败的自定义工具不降级为空列表供覆盖；跨预设旧草稿被拒绝，切换等待参数保存队列。
8. 切换预设是事务：先保存当前预设草稿，保存未成功（失败/被拒）即取消切换并保留草稿；切换成功后等 settings 写入与随后的静默 load 完成才返回。切换或首次加载完成前，`loadedPresetRef` 拒绝参数、promptConfigs 与模板变量写盘——旧预设字段不会带新 `presetTemplate` 落盘；重新加载成功应用该预设数据后才恢复写入。
9. 技能清单和策略均不进 settings：单端调用策略走 `/skill-policy`（`name/path/side/enabled/sessionId?`，服务器在同工作区重新校验身份；显式两端操作可用 `scope`），引用走 `/skills-folders`，清单走 `/skills-list`。快照保留 `complete`，空数组是权威空结果；调用声明和当前会话注册状态分别呈现。创建/导入走既有端点；删除提交 `name/path/sessionId?`，确认框与请求使用同一条目，用户根及显式引用根按服务器能力开放回收站删除。契约见 [skills-management.md](skills-management.md)。
10. 指令文件正文走独立草稿池（`data/instruction-drafts.ts`），不与预设保存队列混用：预设 debounce 自动保存与预设切换一律不带文件正文；焦点离开指令文件卡（或列表「保存全部」）时提交 dirty 文件，成功只把请求时快照记为基线，冲突/失败保留草稿并显示「重新读取」。会话或工作区切换建立新的指令上下文（`instructions.context.contextId` 变化即新上下文）：旧上下文的迟到响应不覆盖当前视图，旧 `contextId` 的保存被服务端 409 拒绝。
11. 指令负责人事实来自 `/bootstrap` 的 `instructions.owner.officialInstructions`（服务端从 pre-step 协调器观察结果取，`null` = 尚未观察到，不当冲突处理）：`true` 时文件卡显示「官方指令行仍在 → 独立来源不注入」，不做「已生效」暗示。
12. 模块列表工具栏下的「独立指令文件来源」总开关复用 ToggleRow，只修改独立策略顶层 `enabled`，默认关闭；单文件开关不隐式开启总来源，也不改变官方负责人。策略不可读时禁用总开关；应答成功前不乐观显示已启用。
13. bootstrap 与策略快照均读取完成后再应用，异步边界复核请求序号、会话与草稿状态。暂时离开工作区只暂停文件写资格，保留草稿与版本基线；返回并读取时，版本未变可继续保存，版本变化仍须解决冲突。
14. 列表保存按钮等待真实 `Promise<boolean>` 结果；文件或预设部分失败时不显示整体成功、不以静默重载清除错误。已经成功保存的文件立即更新其基线，不因后续失败回滚或丢失确认。

### 7.4 导入预览与提交

预设与角色卡的文件读取、上传、预览、确认和结果共用 `data/use-import-preview-flow.ts`；`ui/ImportDialog.tsx` 只接 props/callback，业务入口注入各自的处理器。原始上传仅写暂存区，所有大小的 PNG/JSON/YAML 和预设 ZIP／文件夹都先预览，确认后才更新目标。协议和边界见 [资产交换](asset-transfer.md)。

阶段与「按钮可用」是两件事：

| 阶段 | 含义 | 界面行为 |
|---|---|---|
| idle | 无在途导入 | 选择文件／文件夹 |
| reading | 正在读取／预览（可能是重新预览） | 卡片保留上一次内容；换文件才清空旧预览 |
| confirming | 有 `ready` 预览或顺序组候选，等待用户决定 | 确认与取消可用且可键盘聚焦；只有确实禁用的动作变灰（候选未选组时确认禁用） |
| submitting | 已提交，等待服务端结果 | 确认与取消禁用；成功后刷新事实 |
| stale | 来源或目标版本改变 | 保留所选来源，必须重新预览 |
| error | 读取／预览／提交失败 | 就地错误与重试入口，不自动覆盖 |
| complete | 提交完成 | 显示结果；列表刷新失败单独重试，不重复安装 |

失败与失效分支：

| 触发 | 行为 |
|---|---|
| 需要选类型／顺序组 | 只呈现真实候选，确认不可用；选择后重新预览，旧 ready 作废 |
| 预览响应迟到 | 按请求序号丢弃，不覆盖较新的来源或选择 |
| 提交返回 stale（previewRevision 不符） | 保留来源与选择，旧确认失效，提供“重新预览” |
| 提交非过期失败 | 保留文件与预览：再次确认即重试，取消才跳过该文件 |
| 目标预设切换、页面卸载 | 结束等待、让迟到响应失效，不继续写下一个文件；不悬挂 Promise |

同一份预览只提交一次，读取与提交期间拒绝重复操作。角色卡逐张排队，“跳过这张”与“结束本次导入”分开；卸载释放暂存来源，不提交后续项。同名默认另存，覆盖使用现有 ConfirmDialog。导出范围是互斥单选：完整 ZIP／仅定义 YAML；显示资源清单、缺失依赖与需明确决定的历史记忆项。弹窗复用 DialogSurface 焦点逻辑，宽预览只增加 size 修饰，不建立第二套浮层系统。

## 8. 业务 Feature

feature 只拥有自己的视图、瞬时状态、领域纯 helper 和 CSS：

| feature | 责任边界 |
|---|---|
| prompts | 六层配置卡、字段策略、排序、模板插入、变量编辑和内容配置；世界书只读诊断卡 |
| persona | preset.yml 顶层 persona 段的编辑卡；prefix/suffix 与 complete 互斥校验，写盘经 host 校验与重建 |
| models | 当前预设的主/子代理模型路由卡；模型下拉展示完整目录并按服务商分组，选择模型时内部回写 provider + model，不提供独立服务商选择控件 |
| modules | 引擎能力身份、存在性判定与「本层引擎设置」内容装配（`LayerSettingsContent`：参数分组、已装配能力的装配状态与移除、按层归属的资产编辑器）；消费 `/bootstrap.moduleFacts`（显式模块及仍在运行的历史策略兼容装配），卡片壳 ui/EngineModuleCard.tsx 现在只服务资产编辑器 |
| subagents | 委派工具、实例级工具策略草稿及策略解析预览；不重复嵌入工具面 |
| tools | 自定义工具编辑/保存、参数模板；独立工具预览页与只读工具面 |
| skills | 按官方六类技能根分组展示清单、来源与遮蔽判定、调用策略开关、技能文件夹引用、创建与两种复制导入、回收站删除；契约见 [skills-management.md](skills-management.md) |
| presets | 预设生成开关、路径、切换、导入导出、复制/删除/打开 |
| characters | SillyTavern PNG/JSON 导入、角色卡库存、应用/移除/删除 |

业务 feature 直接使用 data/bridge-client.ts 的 endpoint key；共享控件从 ui/导入。跨 feature 组合由 app/workspace/pages/完成，不在 feature 内建立第二个工作台。

## 9. 共享 UI 与可访问性

### 9.1 共享形态

ui/ 只接收 props/callback，当前真实共享 seam 包括：

- FormField：label/id、说明与错误关联；MenuSelect转发id到真实触发器，hint可内联或使用HintTooltip。
- SettingInputRow、ToggleRow、TagInput：设置和字段编辑形态；ToggleRow 的开关使用官方 Switch。
- ImportPreviewCard：导入预览卡，展示服务端同源转换报告与有损信息（warning/info/被排除条目各自滚动容器）；预设包与角色卡 JSON 两处入口共用。
- reveal-card.ts：创建后的「展开并定位到新卡」纯逻辑，能力卡与配置卡共用。
- MenuSelect：直接封装官方 Menu 的单选胶囊；支持连续选项的 `group` 分组标题。标准设置使用 36px，模块卡内使用 28px 紧凑形态，浮层统一 portal。
- CollapsibleCard、EngineModuleCard：具体可复用的折叠/模块卡形态，不是万能 Card。
- StatusDot：6px实心状态点与3px柔和静态光晕，含success/neutral/danger/warning，语义由相邻文字表达，不使用循环动画。
- StatusBadge：只读状态徽章，StatusDot + 官方 Tag 胶囊；tone 同时驱动两者颜色，技能卡、工具预览、预设「使用中」与角色卡「已导入当前预设」共用。
- 状态徽章与内部Tag均不参与flex收缩，短状态文字保持单行；预设/角色标题承担剩余宽度并允许换行，长名称不把「使用中」挤成竖排胶囊。
- ImportFileButton：隐藏原生 file input 的导入入口。
- TemplatePicker、DialogSurface：模板和预设操作的portal浮层；ConfirmDialog复用DialogSurface的警告对话、初始焦点与还焦能力，不叠加第二套焦点陷阱。ConfirmDialog 的两个按钮是同一个本地胶囊 `.pillButton`（确认按钮加 `data-danger`）：官方 Button 没有 danger 变体，`<Button data-danger>` 不会染红，且取消按钮需要原生 ref 承载初始焦点与 busy 还焦，因此这一对按钮不包官方 Button。
- anchored-popover.ts / anchored-popover-fit.ts：锚点位置和窄视口适配。
- hint-tooltip-focus.ts / hint-tooltip-position.ts：HintTooltip 的键盘读取与视口翻转定位。
- menu-focus.ts：菜单浮层的首项焦点补位（官方 portal 先隐藏后定位，需在定位帧补焦点）。
- tab-key.ts、dialog-focus.ts：纯键盘索引及弹窗焦点行为。

单行 input 与 textarea 继续使用原生元素；下拉单选统一使用官方 Menu，经 MenuSelect 保持触发器、浮层和 ARIA 一致。新按钮优先使用官方 Button/Pill/icon primitive，不创建本地 Button wrapper。

Menu显式启用autoFocus；已发布0.1.6-alpha.1的portal先隐藏后定位，因此menu-focus只通过调用方自己传入的首项label ref，在定位帧补首项焦点。fieldset禁用时MenuSelect同时拒绝portal中的选择。Tooltip兼容官方函数控件，键盘说明绑定实际聚焦目标，Escape关闭说明。

菜单失焦通过relatedTarget识别自己的触发器/portal条目，跨React portal的焦点归属在下一帧复核；不在focusout微任务中先卸载菜单，以免真实鼠标的click丢失。该回归使用原生pointer按下/抬起，不能仅用element.click代替。

卡头自然增高，compact纯开关卡用静态标题；操作区与展开按钮互为兄弟。多项低频操作收进Menu，保留上移/下移点击及键盘替代。层内排序限于同一插入点和当前策略/受众集合，搜索时暂停排序。数字和JSON错误原文跨折叠/切页保留，原生输入允许粘贴；指令卡自己的portal焦点移动不视为离卡写盘。

模块卡内的选择器、开关及小型文本/数字输入使用紧凑尺寸；大文本和 JSON 编辑器保留 `field-sizing: content`、手动纵向缩放与现有自动测高，不随紧凑控件一起压缩。

promptConfigs 模块卡展开区按基础信息、注入规则、作用范围、本条规则的行为、条件需要的内容、本层共享设置和可用的高级元数据分区；短字段使用卡片容器网格，分区间距 24px，字段间距 16/24px。高级元数据和共享设置使用原生 details；共享区以中性背景和作用域说明区分。字段说明使用 HintTooltip。各层策略、匹配对象、正文/变量/来源开关、局部参数枚举由 `/meta.layerContracts` 提供，和保存及引擎校验同源；完整映射见 [九层官方契约](injection-point-contracts.md)。

代理请求卡直接编辑官方六个调用字段，正文不属于该层；模型流和工具链仅在替换/拦截行为下显示相关文本；子代理结束卡选择仅记录或向主会话注入文本。正文与未知字段不因隐藏而删除。身份新值只允许引擎支持的 plugin。切层依据完整矩阵清理不适用的通用字段与匹配对象，并将不支持的策略回落为固定文本。

「注入规则」分区内的**条件判定**块只在引擎放行的层渲染（读 `/meta` 的 `layerFieldPolicies.subject|match`）：`subject` 下拉含「层缺省」（空值即不写该字段，由层决定匹配对象），`match` 提供主键/副键集合、组合逻辑四选一，以及区分大小写、整词两个开关；键的匹配方式是**三态**（自动 / 强制正则 / 强制字面）而非开关——做成开关会把用户手写的 `useRegex: false` 在编辑后静默改成自动识别。切换注入层时清空目标层不支持的 `subject`/`match`：引擎对这些层声明该字段直接 fail loud（整个预设无法挂载），顺手清掉是唯一安全的层切换语义。没有有效键的 `match` 不落盘（引擎要求至少一个非空键），只填逻辑或开关的半成品不会写进配置；手写的坏卡可以在表单里「切层再切回」清掉。

主会话与子代理列表只显示真实的**提示词配置实例卡**，统一使用 `PromptConfigCard`，同一层可以有多张。每张卡的表单里有一个默认折叠的「本层引擎设置」区（`form.layerSettings.label`），展开后就是该层的参数分组、已装配能力清单与该层归属的资产编辑器。例如子代理启动层参数内嵌在「子代理通用守则 · 子代理启动层 · 固定文本」实例卡中，不另外生成「子代理启动层配置」卡。列表顶部/底部只保留不承载引擎参数的入口：工具栏（九层模板菜单、校验与保存）与 world-book 视图下的只读诊断卡。这一顺序不建立跨插入点的全局执行顺序，`anchor-turn` 的实际 hook 同样不受展示影响。

`EngineLayersPanel#engineLayerSlots({ store, t, viewFilter, audience, keyword, … })` 是唯一的层装配入口，返回 `beforeCards` / `commonCards` / `moduleCards`（只含页面级提示与定位锚）以及 `renderLayerSettings`、`hasLayerSettings` 和 `matchesLayerSettings`；两个页面声明受众视图、创建编排并持有工具草稿所有者，不手写层名判断或重复资产布局。

`LayerSettingsContent` 的三段内容都按共享契约派生、不硬编码层名：`layerParamCards` 取主归属层等于该层、且**确实装配**的能力组与不依赖装配的专用编辑组（"确实装配"同时包含 `modules` 声明与参数/行配置隐含补齐两条来源，见 [architecture-params.md](architecture-params.md)，因此不显示假入口），并排除已有专属编辑器的组——`main-model` / `subagent-model` 由模型路由卡承载，不再同时渲染一份通用控件（同一批字段只留一个编辑入口）；`layerAssembledCapabilities` 列出该层已装配能力，每项带二次确认的移除入口（只读预设下不提供）；资产编辑器（`persona` / `variables` / `main-model` / `subagent-model` / `subagent-tools` / `custom-tools` / `subagent-tool-policy`）按同一 `displayLayer` 归位，复用各自专用编辑器、草稿池与写端点。设置区顶部是本层创建入口：`EngineCapabilityCreateMenu`（添加本层能力）与页面注入的「插入本层模板」（`data-layer-insert-template`，与顶部九层模板菜单共用同一个浮层与按层过滤，未注入回调时不渲染）。该层**没有任何可编辑设置**时不渲染设置区；没有真实实例时，即使存在引擎参数或资产编辑器，也不生成独立卡或兜底容器。设置区默认折叠、展开才挂载内容；参数与资产仍走各自既有保存端点。

选中某个注入层且该层没有内容时，列表给「该层还没有内容」的空状态与新增入口，不自动创建九张空卡、也不谎称「无匹配」；`world-book` 是策略筛选而非层，保持原有的「无匹配 + 清除筛选」提示。

本层设置的样式由 `app/workspace/pages/layer-settings.module.css` 拥有：根节点占满外层配置网格，分组使用具名标题与轻边界。参数网格在大于640px的设置容器中显示双列短控件，文本、列表和阶段配置整行；小于等于640px单列，不依赖浏览器窗口宽度。控件类型通过既有渲染器的呈现属性表达，不复制参数定义。已有主功能开关及子代理参与开关的能力按同一DOM顺序放入具名字段组：主开关在左、子代理在右，窄容器保留相邻关系；数值和文本在其后沿原顺序显示。配对复用模块的enabled/includeSubagents绑定，工具呈现沿已有usePtcMode主开关；不改字段集合、值或独立保存，不靠CSS order调整视觉顺序。数字使用等宽数字，说明自然换行，搜索hidden状态始终优先于布局。能力名称与移除动作独立对齐，移除按钮名称包含目标能力；资产沿用专用标题。阶段工具输入的DOM标识同样包含实例身份，草稿键和保存入口保持原样。

同名引擎参数允许多处渲染（同层每张实例卡内各有一份本层设置区）：它们绑定同一 `store.fields[键]` 与同一草稿键，一次修改只提交一次保存；`EngineParamField` 的 `instanceId` 带上「层 + 卡身份」，同层多卡的 DOM id、aria 关联互不冲突，不引入第二份状态、同步服务或事件总线。未完成的数字输入与字段错误也属于这份共享草稿：`store.getDraftRevision` / `subscribeDrafts` / `publishDrafts` 是既有 `subscribeFields` 同一模式的窄广播，参数控件订阅它后，一个渲染点里的半成品输入或错误提示立即出现在其他渲染点（含跨层的相关设置），真实重渲染同步由 `module-policy-smoke` 用真实 Edge 覆盖（同层两张实例卡之间切换编辑、错误态同步、一次失焦只保存一次）。工具栏提供插入点层级与策略筛选、九层模板菜单和提示词配置操作；列表筛选只影响展示，不按插入点分区块。能力与提示词配置保留各自保存、排序和删除语义。

world-book 视图只隐藏工具栏之外的列表主体之外的附加提示，不再有独立的模块卡容器需要隐藏；能力参数与资产编辑器都在实例卡的设置区里，随卡一起折叠，折叠时不渲染内容（同层120张卡不会因此多出成百上千控件）。能力与工具在本层设置内创建，模板从工具栏入口插入；创建不改动层级筛选与搜索词。只读预设（system或关闭writePreset）下创建和资产编辑禁用，移除入口不渲染，折叠按钮仍可使用。

工具栏提供九层模板创建，其他创建操作内置对应层设置；过滤与受众规则见 §5.2.1。指令文件卡属于主会话概念，只在 `scope=main`（或缺省）时下发，子代理页不渲染，避免同一指令文件出现两个编辑入口。

世界书是提示词策略筛选，不承载引擎设置（只读诊断卡只在 `world-book` 视图显示）；自定义工具编辑器按 `custom-tools` 编辑组归位到 tool-pipeline 层。配置卡及设置内容可随筛选和折叠卸载，未保存资产与字段草稿由既有共享草稿池保留；工具读取与创建由页面所有者承载，保存失败保留原输入。

搜索统一覆盖「中文名 + 技术键」，且只影响展示：配置实例使用 `matchesConfigKeyword`；真实层装配通过既有 `matchesEditorGroup` 与分组标题判定设置匹配，匹配时保留同层承载实例，展开后隐藏未命中的组。没有实例的层不会因为设置命中而生成卡片。批量启停仍只作用原配置搜索集合，并排除 host 标记的受管投影，不把仅因设置命中而保留的卡算进写范围。清空搜索恢复原列表，不创建配置或保存。

变量卡的输入、启停、删除和失焦保存受真实预设可写性约束；折叠按钮继续可用，React 状态立即更新并记入既有草稿键。模型资产的预设参数同样只读，但当前会话的 `selectModel` 仍单独按官方 selectable 决定可用性。

子代理工具策略（`subagent-tool-policy`）是模块类型能力：在能力菜单里创建，编辑器住在 tool-pipeline 层的层设置区资产分区里（`data-layer-asset="subagent-tool-policy"`），用「移除能力」入口移除。该编辑器只有**一个启用开关**：打开复用共享可用骨架并立即落盘；关闭删除顶层策略段并保留模块声明，同时把编辑区置为 `fieldset[disabled]` 只读。引擎仅在策略文件确实不存在时降级为官方委派行为，现存损坏文件仍报错。移除能力时模块声明与顶层段一起移除。历史“段在、声明不在”预设保留既有授权装配，装配清单如实列出它；保存或显式创建会补齐模块声明，不覆盖已有授权。子代理页排除「仅主对话」能力——不提供创建 `tool-filter`，它的参数与装配条目也不进本页设置区，并在模块区上方提示子代理工具面应走「subagent-tool-policy」能力。

策略编辑器在焦点离开编辑区时自动保存，没有保存按钮。标签输入的失焦提交先更新最新草稿，再生成保存快照；保存成功只确认对应快照，期间新编辑仍保持待存。再次失焦时若旧请求未完成，只保留最新待存快照并串行提交；失败保留草稿供下一次失焦重试。切换预设或卸载会使旧读取、保存响应及未发送队列失效。

层设置区展示当前预设实际装配的能力（`modules` 声明、参数与行配置隐含补齐、以及实际运行的历史子代理策略），按主归属层分组：清单里每项是能力 id 与「移除能力」入口（二次确认），没有「编辑行为」这类编辑目标选择器；能力自身的参数在同一设置区的参数分组里编辑，新能力从本层创建入口添加。`modules: []` 不展开默认骨架，官方组合行不生成插件能力条目。二次确认移除是完整移除：模块声明、该能力的显式参数与行配置（拥有顶层段的能力连数据段）一起删除，成功后重建一次并刷新模块事实。

子代理页的筛选值与变更回调一起传到提示词列表；能力卡按同一层级过滤，工具管线包含子代理工具策略等本层能力。模板创建与列表展开共用页面持有的创建 ID，子组件不维护第二份无入口 picker。创建不改变筛选或搜索值。

指令文件（AGENTS.md / CLAUDE.md 及其 .local 变体）不走独立卡片：探测到的每个文件用**普通配置卡**（与 `example-pre-step` 同一个 PromptConfigCard）呈现在配置列表里，头部照常显示层级/策略/位置，层级筛选、批量启停、层内移动沿用列表既有语义，不新增置顶卡片或层卡入口。展开后复用 `PromptConfigForm` 的**同一套分区与字段**（基础信息 / 注入规则 / 作用范围 / 内容 / 策略参数 / 高级元数据），不存在第二套指令文件表单：来源固定的绑定项（标识、注入层、内容策略、填充来源、配置类型、消息角色、合并方式、去重方式、来源类型、消息形式）置灰只读，可写项为名称、顺序、拼接位置、晋升范围、消息受众、模型范围，写入 `$DSH_HOME/.prompt-tool/instructions.yml`；正文写文件草稿，**焦点离开卡片即自动写回原文件**（没有单独的保存按钮；版本冲突时保留草稿并显示「重新读取」），绑定保持与官方 agent-instructions 等价（pre-step、真实用户消息之后、会话去重、随子代理晋升）。

「指令提示」在通用提示词配置表单中归入 `placeholder` 动态填充的 `instruction-hint` 来源，不单列内容策略。已有独立策略条目以同一表单呈现，编辑时提交统一的 `strategy + fill`，不批量重写用户预设；引擎解析器和指令文件独立正文／策略所有权不变。

`ToolSurfaceView` 的 `sessionId` 分支表示当前存活 Agent；`presetId` 分支表示官方预设后续 generation 的只读能力。工具预览保持独立只读页面，只有用户显式打开时请求，不因主会话模块列表的筛选或渲染遍历所有预设。

### 9.2 Tabs

所有 tablist 遵循自动激活模式：

- 当前 tab 的 tabIndex 为 0，其余为 -1（roving tabIndex）。
- ArrowLeft/ArrowRight 循环移动；Home/End 跳到首尾。
- 选择后把 DOM 焦点移到新 tab。
- tab 拥有稳定 id 与 aria-controls；panel 使用 role=tabpanel 和 aria-labelledby。
- nextTabIndex() 保持无 DOM 的纯索引算法，并由 Node test 覆盖空列表、无效索引和非导航键。

### 9.3 Dialog、表单与排序

- DialogSurface/TemplatePicker 使用 body portal、backdrop、Escape、首控件聚焦、Tab/Shift+Tab 循环、关闭后焦点恢复、role=dialog 和 aria-modal。
- 工作台抽屉（shell.overlay，role=dialog + aria-modal）在抽屉内提供首尾 Tab 循环，复用 dialog-focus 的 `FOCUSABLE` / `nextDialogFocusIndex`；焦点位于 body portal 弹窗内时由弹窗自身循环接管，抽屉不拦截。
- 弹窗只操作自己的 ref，不查询宿主页面结构。
- 数值输入在提交点解析，草稿期保留字符串，避免输入中间态跳动。
- 提示词和阶段排序同时提供 pointer drag 与上移/下移键盘替代；边界按钮有明确 aria-label。技能列表跟随官方来源与会话裁决，不提供自定义注册顺序。
- reduced-motion 下关闭平移和过渡；focus-visible 必须清晰。
- 外层抽屉和工作台壳使用overflow: clip；程序化定位只滚动canvas，不能把页头和导航滚出固定面板。

### 9.4 模块参数命名与说明

- 可见参数名使用简洁简体中文，优先采用 2-6 字的领域名称；不在标签中显示内部键名、英文枚举或括号实现说明。
- 内部键和值、bridge 载荷和 preset.yml 保持英文契约；下拉选项通过中文映射展示，未知旧值仍回显原值，不能因汉化丢失编辑能力。
- 布尔参数使用正向短名称，例如「独占」「互斥」「动态运行时上下文」；名称位于开关上方，与输入框和选择框保持相同字段节奏。
- 字段说明统一经 `ui/HintTooltip.tsx`。组件只复用宿主 Tooltip 的视觉 token、内边距、圆角、字号与淡入效果，不调用宿主 Tooltip 的定位实现。
- HintTooltip 通过 `body` portal 与 `position: fixed` 定位：鼠标悬停延迟 500ms 后在指针附近显示并随指针移动；键盘聚焦即时读取控件 `getBoundingClientRect()`，紧邻控件显示（鼠标点击产生的聚焦不锁定说明，失焦后回到悬停延迟）；视口边缘自动翻转或收敛。
- `HintTooltip.module.css` 使用宿主 `--dsw-alias-tooltip-bg` 和静态前景 token，并与宿主尺寸一致；背景混入工作台底色以降低透明度。业务组件不得再使用原生 `title` 或自制 `data-tip` 伪元素。
- 字段错误、只读警告、保存状态和空状态不是帮助说明，继续就地显示，不藏入 Tooltip。
- 系统提示段配置卡保留「段名」「独占」「动态抑制」三个字段；人设内容不在这张卡上编辑，改由主会话页的预设人设卡承载 preset.yml 顶层 `persona` 段（见 §5.2）。字段各占三格，720px 以上保持同一行，620px 以下改为单列。

## 10. 样式所有权

样式使用 CSS Modules 和 DSH 语义 token，当前 owner 为：

    app/workbench/Workbench.module.css
    app/workspace/PromptWorkspace.module.css
    ui/controls.module.css
    ui/HintTooltip.module.css
    ui/StatusBadge.module.css
    ui/StatusDot.module.css
    features/characters/characters.module.css
    features/presets/presets.module.css
    features/prompts/prompts.module.css
    features/skills/skills.module.css
    features/subagents/subagents.module.css
    features/tools/tools.module.css

约束：

- 组件移动时同步移动其独占 selector；共享 selector 必须对应稳定的真实共享形态。
- 使用 --dsw-* / --dsw-alias-* 语义 token，不复制静态色板，不写 :root 主题。
- feature CSS 不选择宿主 class、id 或页面结构。
- 中性平面边框使用 0.5px；高层浮层使用 DSH elevation token：悬浮入口抽屉/触发器用 body portal 的 1000 / 1100 固定层级，不叠加无意义的中性 border。
- 圆形和胶囊与 corner-shape: round 配对。
- 动画提供 prefers-reduced-motion 分支；不新增组件专用全局滚动条规则。
- 不为减少文件数把不相关领域重新合并，也不先复制旧 selector 再长期双写。

## 11. 性能与行为不变量

- useSyncExternalStore 的 snapshot 在值未变时复用引用；usePromptToolFields selector 只通知真正变化的 fields。
- 不把 store 放进 Context 触发整树广播；只在有实测收益时保留 memo 和稳定 callback。
- 首屏使用一次 bootstrap 聚合；模型目录惰性加载并缓存。
- filter/search 只在客户端运行；不引入虚拟列表、dynamic import 或 code splitting 来解决尚未出现的规模问题。
- UI 分组不建立六个插入点的全局执行顺序；order 只在同一官方 seam 内解释。
- 当前会话模型始终读取官方 sessions projection，切换始终走 official session.selectModel。
- 未启用的可选模块保持 opt-in；生成结果、preset 优先级和 bridge 载荷不得因 UI 重构改变。

## 12. 测试与验证

### 12.1 契约测试

客户端测试平铺在 test/client/*.test.mjs（34 个文件），另有 test/host-publish-contract.test.mjs 与 test/shared/bridge-contract.test.mjs 覆盖发布与共享契约。按**改了什么**找要跑的测试：

| 改动类型 | 必跑测试 |
|---|---|
| 目录、依赖方向、入口边界、无宿主 DOM 禁令 | client-structure-contract |
| slot 注册、抽屉接线、模板浮层锚点、弹窗焦点 | client-wiring-contract |
| 客户端 slot 面、0.1.5 版本声明、bundle facade | host-publish-contract |
| 桥接路径、端点映射、统一载荷 | bridge-client + test/shared/bridge-contract |
| Fields、快照、空值、保存队列、阶段草稿 | editor-state + prompt-tool-view + param-overrides |
| 提示词配置内容资产、排序、表单分区 | prompt-config-content + prompt-config-order + prompt-config-form-layout |
| 指令文件正文与策略 | instruction-drafts + instruction-save-flow |
| 导入预览生命周期与顺序组 | import-smoke（真实 Edge + 真实文件输入） |
| 菜单、下拉、模板浮层的键盘与 ARIA | menu-select + tab-key + hint-tooltip |
| 模型选项与宿主默认同步提示 | model-options + model-sync-notice + session-model-face |
| 悬浮入口位置与拖动判定 | floating-trigger-position |
| 锚点浮层几何与窄视口适配 | anchored-popover |
| 技能状态筛选、徽章与来源分组 | skill-status |
| 技能状态文件、清单扫描、调用策略写入与资产入口 | skills-management（host 侧契约文档；测试见 `test/host/skills-*.test.mjs`） |
| 子代理策略草稿 | subagent-policy-draft |
| 过滤与新建严格分离（§5.2.1 规则） | scope-create-separation |
| 层设置区（参数分组、装配清单、资产归属）与统一搜索 | engine-module-cards + prompt-config-scale |
| 工具预览、自定义工具编辑与只读边界 | tools-preview + custom-tool-editor + import-smoke |
| 同层多实例规模、切层/受众草稿保持与统一搜索 | prompt-config-scale + engine-module-cards |
| 受管配置字段的来源绑定与只读回显 | prompt-config-form-layout + host/managed-config-fields |
| 184 卡保存往返与注释/未知键保真 | host/preset-configs-scale |
| 中文文案覆盖与字典键完整性 | locale-contract |
| CSS Modules、token、0.5px、reduced-motion、全局污染 | style-ownership |
| 六页导航、草稿跨页、配置筛选与保存反馈 | ui-v2-page-smoke（真实 Edge） |
| 能力创建与子代理策略卡的真实交互 | module-policy-smoke（真实 Edge） |
| 真实 CSS 解析下的呈现 | real-css-smoke（真实 Edge） |

**NEVER-TOUCH 边界**：指令文件读写（授权、上下文白名单、内容版本冲突、读取失败）、导入预览与回滚、路径穿越、大小上限、桥端点安全面、晋升门控与 epoch、子代理策略、子进程脚手架文件，这些测试整文件不参与任何合并或表驱动压缩，改动它们需要独立授权。

交互 DOM 行为由纯 helper、静态契约和隔离浏览器 smoke 共同覆盖，不新增 Jest、Vitest、jsdom 或 happy-dom。结构类契约保持源码/目录断言形式而非渲染断言——它们的价值就是低成本快速守卫禁令。

### 12.2 验证命令

所有测试从临时 cwd 执行：

    $Repo = 'D:\AI\GitHub\dsh-plugin-prompt-tool'
    Set-Location 'D:\AI\workspase\_temp'

    pnpm --dir $Repo typecheck
    pnpm --dir $Repo lint
    pnpm --dir $Repo test
    pnpm --dir $Repo build
    git -C $Repo diff --check

浏览器 smoke 使用隔离 DSH_HOME 和随机端口，不接触当前运行中的 DSH 服务；覆盖悬浮入口开关、抽屉置顶、六页切换、明暗主题、窄宽度、reduced-motion、预设/配置/技能/角色卡高风险流程。

本文只列与结构契约相关的必跑项，完整清单以 test/client/ 目录为准，不在文档里复制易变的文件名录。

## 13. 维护清单

新增客户端能力时按以下顺序检查：

1. 先确定 owner：宿主适配放 index/data，跨页组合放 app，单领域行为放 feature，共享呈现放 ui。
2. 若涉及 bridge，先修改 src/shared/bridge-contract.ts，再同步 host 注册、client 调用和契约测试。
3. 若涉及 Fields、参数或保存，先核对 [architecture-params.md](architecture-params.md) 的空值、优先级和写盘语义。
4. 若涉及引擎层或插入点，核对 [engine-reuse.md](engine-reuse.md)，不要用 UI 顺序推导运行时顺序。
5. 若涉及 SillyTavern、角色卡或世界书，遵循 [SillyTavern.md](SillyTavern.md) 的转换契约。
6. 新 selector 必须有明确 CSS owner；新交互必须同时考虑键盘、焦点、错误和 reduced-motion。
7. 新增或改造面向用户的文案时，同步更新 `MIGRATED_UI_FILES` 与 zh/en 两份字典；改动结构、接线或发布面时，按 §12.1 的索引表跑对应契约测试。
8. 完成 typecheck、lint、test、build 和 diff --check 后再提交；不要停止或重启当前 DSH 服务。

本文是客户端结构的长期权威文档；根目录 [PLAN.md](../PLAN.md) 只跟踪当前计划与验收状态，实施后的稳定结论沉淀回本文及对应领域文档。
