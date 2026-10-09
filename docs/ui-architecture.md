# Web 客户端 UI 结构框架

> 适用范围：dsh-plugin-prompt-tool 的 src/client/ 结构、宿主 SlotRegistry 接入、工作台页面编排、客户端状态与 bridge 边界、共享交互和样式所有权。
> 本文描述当前实现，不是实施计划；与代码不一致时以代码为准。
> 相关代码：src/client/index.ts、src/client/app/、src/client/data/、src/client/features/、src/client/ui/、src/shared/bridge-contract.ts。

本文记录客户端维护契约。module.yml 的 rules、公共 params、variables、customTools、角色卡和子代理策略的存储及生成语义以 host/engine 文档为准；promptConfigs 仅保留运行时投影和指令文件视图，不再是普通规则的编辑源。

## 1. 定位与边界

客户端的产品边界是“位置、时机与受众可配置的提示词注入工作台”。工作台负责编辑、展示和提交配置，不重新定义引擎的九个官方插入点，也不把某一个预设能力提升为全局默认。

结构重构遵循以下原则：

- 控件由插件的 `ui/` 统一持有：遵循官方 `docs/ui-radius.zh.md` 与 `packages/client/ui-primitives/README.zh.md` 的用途、尺寸和共享原则，消费主题 alias 与 radius token；不运行时加载 Harness Client 包。业务页面不得复制控件外观，有意差异通过共享组件的 prop 表达。
- 现有 seam 深化：继续使用 SlotRegistry、ConfigForms、official remote/sessions 和 loopback bridge。
- 领域文件归位：工作台壳、数据层、业务 feature、共享 UI 各自拥有清晰的变化原因。
- 最小抽象：只维护实际使用的控件与交互，不复制完整组件库或新增路由、状态框架。
- 确定性行为：页面顺序、slot 注册、保存保护、键盘操作和错误载荷均由契约测试锁定。

本层不做：

- 修改 DeepSeek Harness 源码、bundle 顺序或 profile 装配。
- 使用宿主 DOM 选择器、MutationObserver 或独立 React root。
- 引入 Tailwind、CSS-in-JS、第二套主题变量、Redux、Zustand、路由库或新的测试框架。
- 改变 module.yml 的字段、优先级、空值语义、原子写盘和引擎运行时顺序。
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
                      +-- shared contract / React / 插件自有控件

依赖规则如下：

| 层 | 责任 | 可以依赖 | 不应依赖 |
|---|---|---|---|
| index.ts | 声明 inject、构造宿主适配面、注册工作台 | app/workbench、data、shared | 具体页面、业务卡片、CSS 细节 |
| app/ | Slot owner、工作台壳、页面组合 | features、data、ui、官方槽位类型与注入面 | host 内部实现、另一套导航/状态框架 |
| features/ | 单一业务领域的视图、瞬时状态和领域 helper | data、ui、自己的 CSS | 其他 feature 的内部文件、slot 注册 |
| data/ | bridge、Fields、store facade、保存与纯逻辑 | shared contract、React hooks（仅 hook 文件） | React 业务视图、feature 组件 |
| ui/ | 只接收 props/callback 的共享呈现和交互 | React、同层 helper、插件 CSS | store、bridge、data、features、宿主 DOM |
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
    │  ├─ prompt-config-order.ts
    │  ├─ prompt-config-content.ts
    │  ├─ prompt-tool-fields.ts
    │  ├─ prompt-tool-view.ts
    │  ├─ rule-drafts.ts
    │  ├─ save-queue.ts
    │  ├─ session-model-face.ts
    │  ├─ session-preset-face.ts
    │  ├─ use-import-preview-flow.ts
    │  ├─ use-module-config-order.ts
    │  ├─ use-prompt-tool-fields.ts
    │  ├─ use-prompt-tool-store.ts
    │  ├─ use-rule-editor.ts
    │  └─ workspace-drafts.ts
    ├─ features/
    │  ├─ characters/
    │  │  ├─ character-card.ts
    │  │  └─ CharactersPage.tsx
    │  ├─ models/
    │  │  ├─ model-options.ts
    │  │  └─ CurrentSessionModel.tsx
    │  ├─ modules/
    │  │  ├─ EngineModuleList.tsx
    │  │  ├─ EngineParamFields.tsx
    │  │  ├─ ModulesPage.tsx
    │  │  ├─ ModuleExportDialog.tsx
    │  │  ├─ ModuleSwitcher.tsx
    │  │  └─ modules.module.css
    │  ├─ persona/
    │  │  └─ ModulePersonaCard.tsx
    │  ├─ prompts/
    │  │  ├─ prompt-config-policy.ts
    │  │  ├─ prompts.module.css
    │  │  ├─ PromptConfigCard.tsx
    │  │  ├─ PromptConfigFields.tsx
    │  │  ├─ PromptConfigForm.tsx
    │  │  ├─ PromptConfigNavigation.tsx
    │  │  ├─ PromptConfigsEditor.tsx
    │  │  ├─ RuleCard.tsx
    │  │  ├─ RuleFields.tsx
    │  │  ├─ RuleJsonField.tsx
    │  │  ├─ rule-labels.ts
    │  │  ├─ rules.module.css
    │  │  ├─ RulesWorkspace.tsx
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
       ├─ MenuSelect.tsx
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

共享控件还包括 `ui/Button.tsx`、`Switch.tsx`、`Menu.tsx`、`icons.tsx` 和 `outside-pointer.ts`。生成目录 lib/ 不属于源码 owner，不手工编辑。客户端样式已按 owner 分开。

## 4. 宿主接入与生命周期

### 4.1 入口装配

src/client/index.ts 的 inject 列表是：

    locale
    slots
    configForms
    uiWorkspace
    uiSession
    remote
    remote.agentPresets
    remote.session
    sessions

apply(ctx) 依次构造：

CSS 构建模块只收集样式数据；`styles.ts` 在入口 `ctx.effect` 中安装插件样式，disposer 只移除本次创建的 style。factory 求值不写 DOM，卸载与重挂不会保留旧样式。

1. locale 字典注册：`ctx.effect(() => registerPromptToolLocale(ctx.locale))` 把 `src/client/locales.ts` 的 zh/en 字典注册进官方命名空间 `prompt-tool`；卸载/重挂由 effect 释放，不重复注册。随后 `ctx.locale.bind(LOCALE_NS)` 得到引用稳定的 `t`。
2. 连接世代重建：`ctx.on('connection/reset')` 触发一次 `bridgeCall('models', { refresh: true })`，让宿主重连后丢弃陈旧的模型目录缓存；失败静默，不阻塞启动。
3. prompt-tool ConfigForms transport：`configForms.get('prompt-tool')` 复用标准部署设置的镜像与写入队列；`mutate` 返回 false 必须显示保存失败，不推进保存基线。
4. PromptToolHostApi，提供目录选择、打开路径与当前会话模型等宿主适配。`currentSessionId()` 经 `session-id-source.ts` 读 `ctx.uiSession.adapter.current` 的作用域绑定；当前会话模型经 `session-model-face` 读取并通过官方 `selectModel` 写回。官方会话预设投影与模块编辑目标分离，工作台切换模块不调用官方预设切换，也不订阅预设跟随。
5. PromptToolWorkbenchFace：controller / api / settings / `t`。
6. registerWorkbenchSlots(ctx, face)，唯一负责 shell.overlay 悬浮入口与 settings.plugins.tab 的注册。

入口不直接导入页面、bridge endpoint 或业务卡片；需要新宿主能力时先扩展 data/host-api.ts 或 shared 契约。

### 4.2 Slot 契约

| 官方注册面 | id / key | 位置 | owner | 作用 |
|---|---|---|---|---|
| shell.overlay | prompt-tool-workbench | order 50 | WorkbenchOverlay | 可拖动悬浮触发器 + body portal 抽屉 |

slot 使用 ctx.slots.inject() 等待官方槽位声明，再调用 ctx.slots.register()。返回的 disposer 在 register-workbench.tsx 中释放。不要添加第二个注册入口，也不要改变 id 或 inject face 的形状。宿主设置面板的 `settings.plugins.tab` 分区已移除：模块运行总闸只在工作台模块页设置（`modules.globalSwitch`）。

两处注册都声明 `locale: PROMPT_TOOL_NS`：slot 组件由此拿到框架注入的 typed `t` seat，同时把「渲染需要已安装的 locale face」写成显式契约（locale face 由官方 dsh-client-locale 在 boot 期经 renderer 安装）。列表项 label（设置 tab 标题）用 `() => face.t('tab.label')` thunk，宿主重读 label 时取当前语言。

### 4.2.1 文案归属（locale）

- 用户可见文案统一归 `prompt-tool` 命名空间：zh 常量是唯一事实源，键类型由它派生，en 用 `Record<Key, string>` 强制键集一致；`register` 用官方类型化形式一次注册两种语言。文本量大的 feature 按 `locales.ts` / `locales-params.ts` / `locales-prompts.ts` / `locales-cards.ts` 分区，注册时在 `locales.ts` 合并成同一命名空间，不注册第二套框架。
- 组件树很深，不逐层重建 i18n 上下文：入口组件用注入的 `t`，`PromptToolWorkbenchFace.t` 作为同一 bind 结果的稳定引用向下传递（页面与卡片按需加 `t` prop）。
- 渲染时才求值（`t('key', params)`），不做模块级缓存；语言切换由 renderer 订阅 locale revision 后整体重渲染跟进。
- 不进字典的内容：provider/model id、文件路径、用户内容、协议 code 与 bridge 错误码；动态拼接用 `{name}` 占位参数。
- 已迁移：工作台外壳与悬浮入口、设置页、五页外壳、引擎参数卡与模块列表（标签按 shared 键推导成 `param.<键>` 词条）、提示词配置与人设区、模块页的角色卡素材区、子代理「工具与深度」模块卡与实例级工具策略、自定义工具卡、导入预览卡。子代理策略的档位显示名（首次启用写入 module.yml 的 seed 值）属于用户可改内容，保持原值不入字典。
- 仍未迁移：`ui/` 控件的回退文案（`MenuSelect` / `TagInput` / `DialogSurface`），以及 `features/models/**` 与 `data/**` 的状态提示（这两个目录属模型路由任务的文件边界）。

### 4.3 悬浮入口与关闭行为

- `shell.overlay` 注册可拖动悬浮触发器：位置是纯客户端界面偏好（localStorage，`floating-trigger-position.ts`），窗口尺寸变化时按实际按钮尺寸夹回可见区；不读宿主 DOM 几何，也不再占用 `sidebar.footer.action` 做 `--pt-sidebar-edge` 探针。
- 拖动与单击以 4px 位移阈值区分：拖动结束吞掉尾随 click，单击与键盘仍开合；触发器打开 body portal 抽屉，抽屉与触发器分别用 fixed + z-index 1000 / 1100 置顶，不被宿主「对话/轨迹」顶部导航栏遮挡。
- 关闭支持 Escape、点击背板与按钮切换，焦点在触发器与抽屉之间转移；抽屉打开时触发 PromptWorkspace.store.load()，关闭保留实例状态。
- 官方右侧栏（`@deepseek-ai/dsh-client-ui-sidebar-right`）实测不适合本项目：已移除 tab type / keyed body 两段注册、`PromptToolTab` 与 `sidebarRightTabs` inject。
- 插件不持久化工作台开关：悬浮抽屉开关是内存态，刷新回落。

### 4.4 0.1.5 新能力采用面

- 采用：shell.overlay 可拖动悬浮入口；Switch 与状态徽章由插件实现。
- 已满足、无需接入：`host-open-in-app`。`PromptToolHostApi.openPath` 走 `remote.session.openWorkspacePath`，其契约就是宿主交给原生打开器；官方 `ui-open-in-app` 客户端包不提供跨插件服务，只是会话头部的分割按钮。
- 不适用：`ctx.workspaceFiles` 只覆盖 workspace 根，插件的读写路径域是 DSH_HOME（预设、技能、角色卡）。
- 不采用：官方右侧栏（`ui-sidebar-right`）实测不适合本项目，已移除（决策见 §4.3）；`client-resources` 资源 tab 需要自建 provider 与第二个 tab 类型，而工作台已在抽屉内就地编辑这些文件，重复呈现没有收益。

## 5. 工作台与页面信息架构

### 5.1 可见入口

    settings.plugins.tab
      └─ 基础设置：模块运行总闸

    悬浮入口（shell.overlay 可拖动触发器，位置存插件 localStorage）
      └─ 完整工作台（body portal 抽屉）
          ├─ 主会话
          ├─ 子代理
          ├─ 工具预览
          ├─ 技能设置
          └─ 模块

settings tab 不复制工作台内容。完整工作台由 PromptWorkspace 创建 store、保存当前页，并在打开时触发一次 load；WorkspaceFrame 负责公共 header、导航、canvas、loading 和 notice。

模块的目录物化、复制、删除和参数由本插件维护；模块不进入官方 `agentPresets` 注册表，编辑目标不驱动官方会话预设切换。工具预览仍可只读官方 roster；默认值 `selectedDefault` / `defaultId` 不参与模块设置。

### 5.2 页面 ID、顺序与组合

workspace-pages.ts 是页面元数据的唯一来源。默认页为 features，顺序不可变：

| id | 标题 | 主要组合 |
|---|---|---|
| features | 主会话 | `RulesWorkspace` 展示模块规则；原指令文件卡置于规则与诊断卡之前。页面负责模板创建和受众视图，`EngineLayersPanel#engineLayerSlots` 提供卡内共享设置 |
| subagent | 子代理 | 同一 `RulesWorkspace` 和 `injectionPointSlots(audience: 'subagent')`，共用模块规则草稿与模板入口；显示同源指令文件卡及指令路径提示设置 |
| tools | 工具预览 | 顶置统一搜索；当前会话／所选预设两个可折叠分组，预设选择位于分组标题右侧；双列展开详情卡，680px 以下单列 |
| skills | 技能设置 | 技能根与资产卡（用户技能根、创建、复制导入、技能文件夹引用）、状态与来源筛选、单一列表的 SkillRow（三行摘要、文件编辑、调用策略开关、删除） |
| modules | 模块 | 统一模块列表（启用、新建、复制、导出、删除、打开目录、导入、并入与移除）及运行总闸；角色卡是导入来源 |

模块页 id 为 modules，所有来源导入后都成为普通模块，统一读取模块列表。卡体只承载名称、描述、id 与状态徽章，动作放卡脚；当前编辑模块及仍有依赖的模块由同一删除守卫保护。角色来源不维护第二份 charactersList 库存，不创建角色专属状态登记。

主会话与子代理的 `RulesWorkspace` 按受众展示当前编辑模块及所有已启用模块的规则卡，以模块 ID＋规则 ID 唯一定位并按配置序号统一排列；卡片标注所属模块，可就地编辑、复制、删除和启停。启用集合来自无参 `/module-config-order`，逐模块 `/rules` 读取正文，不从已访问过的草稿推测启用集合。当前编辑模块仍承载模板创建与本层共享设置；其他模块卡片不复用它的共享设置。

排序只在规则卡中呈现，模块页不另设排序区。卡内上下移动与拖拽可交换同插入点、位置与官方 order 档位中不同启用模块的可见规则，隐藏条目的槽位不变；工具栏不提供额外范围切换。排序走 `/module-config-order`，携带完整启用集合身份列表与版本，不限定当前模块；成功后刷新各模块规则版本，失败显示错误，卸载或编辑目标变化后丢弃迟到响应。排序不改规则正文或指令文件。

搜索卡片在宽屏按“搜索框 → 层筛选（缺省层／展示分组）→ 添加注入模板 → 启用／停用”的顺序保持同一行，批量按钮组位于最右侧，窄容器自然换行。新建只保留模板入口，不另放“新建规则”。批量启停仅变更当前受众、关键词和层筛选共同过滤出的规则启用状态，并立即通过既有规则事务提交；不修改隐藏规则的启用状态、指令文件或模板变量，保留服务端互斥校验，不自行选择互斥组赢家。从卡内字段移焦到批量按钮时跳过该次失焦保存，由批量操作统一提交，避免重复请求或先保存旧状态。只读、读取/保存中、无效字段、远端冲突和空结果时批量按钮禁用。

页面不再常驻“重新读取／校验规则／保存规则／已与模块同步”一行；卡内保存与失焦自动保存继续沿用规则事务，保存包含校验。批量操作按可见卡片所属模块分别提交。失败保留对应模块草稿并显示所属模块与就地错误，只在错误时提供重试与必要的丢弃确认；保存失败重试提交，读取失败或远端冲突重试读取。

预设人设卡（`features/persona/ModulePersonaCard.tsx`）编辑 module.yml 顶层 `persona` 段的四个可编辑项：`prefix`、`suffix`，以及 `complete`（独占）与 `includeRuntimeContext`（动态运行时上下文）两个开关（后者默认开启）。读写都走 `/persona`，写由 host 校验并原子写盘；`complete` 与提示词配置的「独占」互斥，由 bridge 在写盘前 fail loud。卡头 meta 区分「存在 persona 段」与「继承预设」——空对象 `{}` 也算存在，不等于有实际内容。四项均未改动时保存落成删除语义（不带 persona 写盘）；二次确认的移除入口只在 persona 段已存在时渲染。它只在主会话页出现，不在子代理页渲染。

### 5.2.1 创建入口与过滤的分工

工具栏的「添加注入模板」只包含九个插入点的模板入口，不按当前层筛选删减。能力模块和连锁组合放在对应层设置区的「添加本层能力」入口；组合以首个能力的主归属层为入口，其跨层装配行为仍由既有配方声明决定。自定义工具区内提供空白工具和工具模板创建，模板变量在自己的编辑区内添加，空资产仍保留创建入口。引擎参数与资产编辑器只内嵌在真实提示词配置卡中；当前受众没有该层实例时保持空状态，由用户显式插入模板创建，不自动生成设置卡或提示词规则。

**过滤与新建严格分离**：过滤下拉与搜索词只由用户手动改变，创建路径一律不写入过滤状态；新建提示词配置展开并定位到新卡，能力创建定位到当前实例卡内的本层设置区。配置锚点是配置 id，能力定位锚点是层设置区的层名，节点未就绪时按上限重试后静默退出。因此目标落在被筛掉的层或作用域时保持不可见，切到该层或「全部」即可见；同一能力重复创建仍会触发定位（信号带递增 token，不依赖 id 变化）。模板重复创建时分配唯一标识，不覆盖原配置。

模板直接返回 canonical `RuleDefinition`，创建与复制分配新的规则身份；注入动作不复制旧 `config.id`，由规则 ID＋动作 ID 派生运行身份。受众使用规则级 `if.scope`，固定系统注册的静态目标除外。工具模板浮层锚定实际点击入口，选中或 Escape 关闭后还焦；创建绑定发起模块，切换后不能重放。

主会话页中的卡片顺序是 UI 分组，不表示九个官方注入 seam 的运行顺序。九个插入点彼此独立，运行时顺序和参数语义见 [engine-reuse.md](engine-reuse.md)。

工具预览与工具编辑分离。`useCustomToolsEditor` 由主/子页面常驻调用，负责同一预设的读取、草稿与显式保存；创建直接消费动作并写共享草稿池，设置区只渲染其内容。连续创建不依赖卡片挂载，切页后已建立的草稿继续保留，不重放请求。加载或读取失败、预设不匹配和只读时拒绝创建并给出提示，不将空列表当读取成功。预览不隐藏自定义工具，不自动创建／恢复会话；当前会话读取冻结 generation，所选预设读取后续 generation，切换来源或刷新会丢弃旧请求响应。

样式参照官方 `ui-settings-plugin-inventory/PluginInventorySettingsTab`，不是可配置插件表单。卡头使用自有 `StatusBadge` 与 Chevron 图标，标记真实的「模型可见」；展开显示完整名称、来源视角、可见状态与描述。工具摘要没有插件配置启停或运行阶段，不显示虚构的「已启用／运行中」。搜索只在客户端过滤，并自动展开分组，不增加 bridge 请求。

工具预览的来源下拉展开时后台刷新目录，已有选项期间只更新 `aria-busy`，不插入挤动锚点的加载文案。分组标题和来源菜单保持挂载；来源变化只重置带来源身份的数据快照与详情列表，旧响应不覆盖新来源。加载期间保留已展开详情的高度，避免短暂收缩触发滚动；聚焦项被刷新移除时，菜单接续到可用项并使用 `preventScroll`，避免闪动、关闭或丢失键盘焦点。

公共参数由 `EngineParamFields` 按 `ENGINE_PARAM_DEFINITIONS` 与 `SHARED_PARAM_KEYS` 生成，能力存在性由实际模块事实决定。十个旧模型参数从 Fields、默认值、读回、loaded keys、保存和脏快照中排除；模块路由与采样只编辑 `request-params` 动作，当前会话选择独立走官方 `selectModel`。枚举使用 MenuSelect，列表使用 TagInput。

### 5.3 状态展示约定

- loading：保留已有数据；只有没有可展示数据时才显示骨架。
- saving：只禁用冲突动作，不冻结其他草稿输入。
- notice：配置保存/校验反馈位于操作区，字段错误用 aria-invalid/aria-describedby 关联；同一结果只由一个 live region 播报。
- destructive action：配置、能力、预设、角色库删除以及丢弃文件草稿使用 ConfirmDialog；取消先聚焦、请求中防重复提交，失败保留确认面，关闭后还焦。危险按钮统一为「描边染红」形态（`.pillButton[data-danger]`：透明底 + error 混色的文字与描边），确认按钮与取消按钮是同一个 `.pillButton` 胶囊（尺寸、圆角、字号一致），只以 `data-danger` 区分主次；所有删除入口共用该组件，外观不各走一套。
- 长路径与名称允许换行或在展开区提供完整可选择文本，不以原生 title 作为唯一读取入口。
- 配置操作区与列表共用 canvas 滚动根，sticky 高度由自身 ResizeObserver 测量；短视口退回普通流，焦点与定位避开操作区。
- 吸顶操作区自身不画背景：区内每一行都是不透明卡片（模块列表卡、过滤行卡），吸顶可读性由卡片提供；卡片之间的窄缝隙会透出滚动内容，这是不画底板的固有代价。

## 6. 状态与数据流

### 6.1 所有权

| 状态 | Owner | 生命周期/规则 |
|---|---|---|
| 工作台抽屉开关 | workspace-controller | 工作台实例内存态；刷新回落 |
| 当前顶层页 | PromptWorkspace | 工作台挂载期；不写 URL 或 localStorage |
| fields、meta、catalog | usePromptToolStore | 工作台挂载期；打开时重新同步 |
| 模块运行总闸 | 官方 ConfigForms | 规范键 modulesEnabled；关闭卸载贡献，不清盘 |
| 当前会话模型 | session-model-face | 官方 sessions projection 生命周期 |
| 模块编辑目标 | store + bridge 请求头 | 客户端编辑状态；通过 `x-module-id` 指定，不写部署设置，不决定启用集合 |
| filter、search、列表展开、页滚动 | workspace-browse-state | 工作台实例期，配置视图按页面/预设区分；异步资源就绪后一次恢复滚动 |
| 工具、人设、策略、原始 JSON/数字草稿 | store.editorDrafts / workspace-drafts | 按预设和字段身份保留；未存草稿或保存中阻止预设切换；改名迁移、删除清理对应字段 |
| 模块规则与条件/动作字段草稿 | rule-drafts + use-rule-editor | 每模块单一 owner、读取去重、稳定编辑 key；改名/删除保留 previousId；CAS 失败和请求期间的新编辑不丢失 |
| 指令文件正文草稿 | instruction-drafts | 与预设保存队列分离；按指令上下文（`contextId`）隔离，旧上下文迟到响应不覆盖当前视图 |
| 导入预览与提交阶段 | use-import-preview-flow | 每次 `run()` 独立生命周期；卸载结束等待、不悬挂 Promise |
| 创建意图、菜单、删除/导入确认、拖拽 | 对应 feature | 仍随页面卸载失效；不恢复或重放危险操作 |
| 保存队列、revision、草稿版本 | save-queue + store | 工作台挂载期 |
| 规则判定计数与配置计数（状态栏「X/Y 规则 · A/B 模块 · N 不可用」） | `/rule-diagnostics` 只读端点 + 局部 hook | 数据就绪后读一次；`revision`（模块 + 启用位）变化时重读，否则启停模块后计数停在旧值。**只有首次读取（模块列表尚未回来）才用「读取中」顶替计数**：重载期间计数照旧显示、加载由状态点变灰表达——切模块或启停模块不该让计数消失。规则数 = 已启用模块里启用/全部配置卡（同一次响应顺带下发的 `configs`，读取失败则整段缺席、只留模块段），模块数 = `meta.modules` 的启用/全部；判定计数按「模块+规则+通道」聚合，取每个动作的最终判定（不按动作拆分），身份上限 512，超出只累加已有身份并把丢弃次数作为 `dropped` 下发（该字段保留给外部消费者与后续 UI，当前工作台不渲染）；该段读取失败按 0 处理（不显示） |
| 大文本和角色卡原文件 | 文件通道/bridge | 不进入 settings descriptor |
| 技能调用策略 / 技能文件夹引用 | 技能文件（`SKILL.md` 的两个官方键）+ 插件状态文件（`$DSH_HOME/skills/.system/prompt-tool/skills.yml`，只存 `folders`） | 停用 = 改写该技能 frontmatter 的 `disable-model-invocation` / `user-invocable`（正文与其余字段逐字保留）；引用只登记路径。技能实体归官方各技能根所有，插件不搬迁。契约见 [skills-management.md](skills-management.md) |

不新增 React Context 来广播整个 store。页面通过 usePromptToolFields selector 订阅窄切片，叶子组件接收显式值与 callback。

业务草稿不写 localStorage，不靠常驻五页保留。工具、人设与策略只确认提交快照，保存途中继续编辑仍待存；同预设重挂共享在途状态，策略卸载清除未发送队列。干净重挂重新读取远端事实，脏草稿优先保留。技能批量作用于当前结果中合法已选项，固定目标快照，完成后刷新磁盘事实并保留失败选择。

### 6.2 首屏读取与更新

    打开悬浮工作台抽屉
      -> PromptWorkspace.store.load()
      -> bridgeCall("bootstrap") 聚合 descriptor、meta、变量和 promptConfigs
      -> fieldsFromView() 合并 value/base 与 moduleParams
      -> useRuleEditor() 去重读取 /rules，建立正文、settings、variables 的 revisions 基线
      -> /models 按需加载并缓存模型目录
      -> page selector 订阅 fields 引用

bootstrap 是首屏聚合请求，不因筛选或输入字符增加 bridge 请求。模型目录保持惰性加载；技能筛选、状态筛选和搜索在客户端完成。技能写入后局部刷新 `/skills-list`，不重载预设或指令草稿；技能页仅提供“导入技能”和“引用文件夹”两个宿主目录选择按钮，不保留浏览器上传与手动路径输入。复制导入继续经过数据层的覆盖确认与写入流程，引用只登记目录；取消、选择器失败或离页后的迟到结果不提交。

同一 bootstrap 请求只解析一次模块目录，描述身份、参数、能力事实、变量与配置卡均来自该目录。未带目标请求头时，响应身份也投影实际默认目录，不从已退役的部署选择字段推断。

同一预设的后台刷新同时保护请求开始前已有的未保存提示词配置与模板变量草稿，以及请求期间新增的编辑。保存后同步元数据时，已确认写入的提示词定义不被暂时为空的生成快照覆盖。未填写名称的变量行只在写入载荷中清理，本地编辑行保留；预设身份切换仍按原保存与上下文边界处理。

### 6.3 纯逻辑与 facade

use-prompt-tool-store.ts 是唯一工作台 facade，负责把 ConfigForms mirror、typed bridge、字段快照、保存队列和 feature actions 组合成 React 可消费状态。可独立测试的逻辑放在以下模块：

| 模块 | 责任 |
|---|---|
| prompt-tool-fields.ts | Fields、默认值、字段级 helper |
| prompt-tool-view.ts | bootstrap/view 到 Fields 的 shape guard 与映射 |
| dirty-state.ts | snapshot、深比较和 reload 判定 |
| param-overrides.ts | params 的列表拆分、条件发送和读回 patch |
| rule-drafts.ts / use-rule-editor.ts | 规则单源、稳定身份、原始字段草稿、CAS、模块队列与互斥响应快照合并 |
| prompt-config-content.ts | AGENTS 文件卡（`params.file`）的正文提升与文件写回分流（`preset.md` 内容资产已随 `/module-content`、`/import-preset` 下线） |
| prompt-config-order.ts | 配置视图内的移动算法；普通列表与跨模块排序共同复用 |
| use-module-config-order.ts | 跨模块排序摘要、版本读写与请求生命周期；只由现有配置列表消费 |
| save-queue.ts | 串行保存任务的最小队列 |
| import-files.ts | 浏览器文件导入的纯读取辅助 |
| use-import-preview-flow.ts | 导入的预览→确认→提交流程状态机（预设包与角色卡共用） |
| workspace-drafts.ts | 按预设身份的跨页草稿池：人设、工具、策略与展开状态 |
| instruction-drafts.ts | 指令文件正文的独立草稿池与版本基线 |
| instruction-policy.ts | 指令策略的读写、默认值与单文件开关推导 |
| session-model-face.ts | 官方会话模型 projection 与选择动作 |
| session-preset-face.ts | 官方会话预设 projection `agentPreset` 与标题 projection `title` 的读取与订阅（当前会话真正运行的预设；标题只用于提示指名会话，缺失退回 id 短号） |

这些模块不重复实现页面渲染，也不把 feature 专属网络流程塞回通用 transport。

## 7. Bridge 契约与保存语义

### 7.1 单一来源

src/shared/bridge-contract.ts 同时拥有：

- 前缀 /api/prompt-tool/settings；
- BRIDGE_ENDPOINTS 路径表；
- BridgeRequestMap 请求体映射；
- BridgeValueMap 响应 value 映射；
- 请求/响应覆盖的编译期断言。

data/bridge-client.ts 提供泛型 bridgeCall(endpoint key, typed body, moduleId?) 和角色卡专用 bridgeUpload。可选 moduleId 只覆盖本次请求的 `x-module-id`，不改变工作台编辑目标；逐卡规则读写使用所属模块身份。业务组件不得拼接 /bootstrap、/module-delete 等原始路径。新增或改名端点必须同步 shared map、host 注册和契约测试。

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

1. 全局 settings 保存使用独立队列；公共参数、rules、能力创建/组合创建/移除共享模块保存队列；指令文件正文保持独立通道。
2. 请求使用保存时的 snapshot；成功后只更新该 snapshot 的 saved 基线。
3. 请求期间继续编辑时，当前 fields 与 saved snapshot 不同，dirty 保持为真。
4. 成功后的静默 load 留在预设队列内，且只在全局草稿版本未变化、其他通道无待存草稿、对应草稿仍等于请求快照时执行。
5. 普通规则通过 /rules 自动保存及显式提交，载荷携带 expectedModuleId、expectedRevisions 与 edits[{previousId, rule, settingsChanged?}]。正文编辑只拥有正文，状态改动显式校验 settings；新增、删除、改名也使用 settings 版本。非法 JSON／数字阻止提交，失败保留输入。
6. 参数空字符串/空数组沿用删除键语义；variables 的空字符串仍是合法占位值。详细参数规则见 [architecture-params.md](architecture-params.md)。
7. 模块写入携带 expectedModuleId，旧身份键只在输入边界兼容，双键冲突拒绝。读回失败的工具不降级为空列表供覆盖；跨模块旧草稿拒绝，切换等待保存队列。
8. 切换编辑模块先保存当前草稿，失败即取消切换并保留输入；成功后更新请求头目标并等待重读，不写 settings、不切换官方会话预设。首次加载或切换完成前，`loadedModuleRef` 拒绝依赖当前 Fields 的公共参数和模板变量写盘。逐卡规则事务使用独立模块草稿、显式请求身份与版本，在同一保存队列执行，不受另一编辑目标限制；工作台脏状态包含所有模块规则草稿。
9. 技能清单和策略均不进 settings：单端调用策略走 `/skill-policy`（`name/path/side/enabled/sessionId?`，服务器在同工作区重新校验身份；显式两端操作可用 `scope`），引用走 `/skills-folders`，清单走 `/skills-list`。快照保留 `complete`，空数组是权威空结果；调用声明和当前会话注册状态分别呈现。创建/导入走既有端点；删除提交 `name/path/sessionId?`，确认框与请求使用同一条目，用户根及显式引用根按服务器能力开放回收站删除。契约见 [skills-management.md](skills-management.md)。
10. 指令文件正文走独立草稿池（`data/instruction-drafts.ts`），模块保存与模块切换不带文件正文。焦点离开文件卡或折叠前提交 dirty 文件，成功只确认请求时快照，冲突/失败保留草稿并显示「重新读取」。会话或工作区切换建立新的指令上下文：旧上下文的迟到响应不覆盖当前视图，旧 `contextId` 保存由服务端 409 拒绝。
11. 指令负责人事实来自 `/bootstrap` 的 `instructions.owner.officialInstructions`：`true` 仅在观察到官方装配时出现，但读协调器观察结果的通道已删除、载荷恒为 `null`（见 [ADR-0009](adr/0009-instruction-owner-observed-only.md)），重建上报链前没有生产者。对规则来源不写 `false`——那是插件观察不到的否定事实，三态因此收敛为「观察到 / 未观察到」。文件可读与官方已装配都不能显示为该文件「已经注入」；官方未装配时插件不补建文件注入。
12. 不再提供「独立指令文件来源」总开关。文件卡启停仅写独立策略 `files[fileId].enabled`，默认放行；关闭只拦截后续官方注入，不撤回历史，重新开启不强制重放。策略不可读时禁用策略编辑，保留诊断；应答成功前不乐观显示已保存。名称与开关跨预设共享，位置、顺序、晋升、受众和模型范围不属于文件卡控制项。
13. bootstrap 与策略快照均读取完成后再应用，异步边界复核请求序号、会话与草稿状态。暂时离开工作区只暂停文件写资格，保留草稿与版本基线；返回并读取时，版本未变可继续保存，版本变化仍须解决冲突。
14. 列表保存按钮等待真实 `Promise<boolean>` 结果；文件或预设部分失败时不显示整体成功、不以静默重载清除错误。已经成功保存的文件立即更新其基线，不因后续失败回滚或丢失确认。
15. 配置排序走 typed `moduleConfigOrder` 端点，服务端校验身份集合与 revision，拒绝未知、重复身份及过期版本。顺序写回 `module.yml.configOrder`，客户端不提交正文、文件路径或序号；模块启用或停用均可保存自身排序，总闸关闭仍可改排序定义。
16. 模板变量内容与开关分别校验 variables／settings 版本。保存已提交但切片发布持续失败时，服务端 persisted 响应必须显示“已保存但未发布”，不能当成未写盘或直接清空草稿。存储完整性与恢复规则以 [后端框架](architecture-params.md) 为准。

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
| persona | module.yml 顶层 persona 段的编辑卡；prefix/suffix 与 complete 互斥校验，写盘经 host 校验与重建 |
| models | 当前预设的主/子代理模型路由卡；模型下拉展示完整目录并按服务商分组，选择模型时内部回写 provider + model，不提供独立服务商选择控件 |
| modules | 模块页管理；引擎能力身份、存在性判定及「本层引擎设置」内容装配；消费 `/bootstrap.moduleFacts`，其中 `subagentToolPolicyEnabled` 区分插件策略与宿主委派 |
| subagents | 委派工具、实例级工具策略草稿及策略解析预览；不重复嵌入工具面 |
| tools | 自定义工具编辑/保存、参数模板；独立工具预览页与只读工具面 |
| skills | 按官方六类技能根分组展示清单、来源与遮蔽判定、调用策略开关、宿主目录选择导入与引用、创建、回收站删除；契约见 [skills-management.md](skills-management.md) |
| modules | 模块页的模块列表：启停、编辑选择、新建/克隆、导入导出、复制/删除/打开（页面壳在 `features/modules/ModulesPage.tsx`） |
| characters | 角色来源解析／展示兼容；安装、库存、并入与删除统一归模块流程 |

业务 feature 直接使用 data/bridge-client.ts 的 endpoint key；共享控件从 ui/导入。跨 feature 组合由 app/workspace/pages/完成，不在 feature 内建立第二个工作台。

## 9. 共享 UI 与可访问性

### 9.1 共享形态

ui/ 只接收 props/callback，当前真实共享 seam 包括：

- FormField：以非交互的字段名称和 `aria-labelledby` 关联控件，维护说明与错误关联；MenuSelect 转发 id 与 ARIA 到真实触发器，hint 可内联或使用 HintTooltip。名称及名称旁的空白不会聚焦编辑框或打开下拉，控件内部点击和键盘操作保持有效。
- SettingInputRow、ToggleRow、TagInput：设置和字段编辑形态；ToggleRow 使用自有 Switch，保留 role、aria-checked 与键盘行为。
- ImportPreviewCard：导入预览卡，展示服务端同源转换报告与有损信息（warning/info/被排除条目各自滚动容器）；预设包与角色卡 JSON 两处入口共用。
- reveal-card.ts：创建后的滚动定位与重试，层设置区与配置卡共用。
- MenuSelect：封装自有 Menu 的单选控件；触发器直接使用共享 `Button shape="pill" variant="outline"`，与“添加注入模板”“刷新”具有相同描边、字号、留白、悬停与禁用态，不另写一套胶囊外观。支持连续选项的 `group` 分组标题；标准设置使用36px，模块卡内与列表过滤行使用28px，浮层统一portal。
- SearchInput：主会话、子代理、技能设置、工具预览共用官方 plugin-inventory 搜索形态；自带图标、H36/R12、13px/20px、左右36/34px留位、主题描边与焦点环，查询不会改变宽度，不套用配置编辑框的内容估宽。`inline` 仅表达同行伸缩布局。
- 列表过滤行：主会话、子代理与技能页的多组件区域共用 `.listFilterRow` 卡片（10px 14px内边距、0.5px描边、R12、`bg-layer-3`），搜索与筛选、胶囊操作在同一行，空间不足时换行。工具预览只有独立搜索框，不额外包卡；卡片属于页面组合而不是SearchInput。
- CollapsibleCard、EngineModuleCard：具体可复用的折叠/模块卡形态，不是万能 Card。
- StatusDot：6px实心状态点与3px柔和静态光晕，含success/neutral/danger/warning，语义由相邻文字表达，不使用循环动画。
- StatusBadge：StatusDot 与自有胶囊；tone 同时驱动两者颜色，技能卡、工具预览、模块「已启用」与角色卡「已导入当前模块」共用。模块徽章由实际 `enabled` 且可用驱动，与卡脚开关同步；当前编辑目标仍由边框标记，不冒充启用状态。
- 状态徽章与内部Tag均不参与flex收缩，短状态文字保持单行；模块/角色标题承担剩余宽度并允许换行，长名称不把「使用中」挤成竖排胶囊。
- 卡体（`.moduleCardBody`，位于 `ui/controls.module.css`）只承载内容，没有点击语义；模块卡与角色卡共用同一形态，动作一律放卡脚（`.moduleCardFooter`）。需要整块可点的控件不要复用卡体。
- ImportFileButton：隐藏原生 file input 的导入入口。
- TemplatePicker、DialogSurface：模板和预设操作的 portal 浮层；ConfirmDialog 复用 DialogSurface 的警告对话、初始焦点与还焦能力。确认按钮沿用 `.pillButton[data-danger]`，取消按钮的 ref 承载初始焦点与 busy 还焦。
- anchored-popover.ts / anchored-popover-fit.ts：锚点位置和窄视口适配。
- hint-tooltip-focus.ts / hint-tooltip-position.ts：HintTooltip 的键盘读取与视口翻转定位。
- Menu 在定位完成的可见帧聚焦首个可用项，统一处理上下键、Home/End、Escape/Tab、禁用项及焦点恢复。
- tab-key.ts、dialog-focus.ts：纯键盘索引及弹窗焦点行为。

普通单行输入统一使用 `TextInput`，搜索统一使用 `SearchInput`，操作按钮统一使用 `Button`，下拉单选统一使用 `MenuSelect`，二态开关统一使用 `Switch`。组件只接收原生属性、props 与 callback；尺寸、圆角、禁用、焦点与危险态归共享层，feature CSS 仅持有业务排列，不再把输入样式类传给下拉或搜索。正文与 JSON 使用全宽共享 textarea 样式；TagInput 的内嵌输入、文件选择、radio，以及折叠和导航控件保留各自语义。Tag 的外观直接归 StatusBadge。

官方共享库是宿主功能包的控件通道；本插件保留既有独立打包边界，在自身 `ui/` 提供唯一共享入口，不从宿主源码路径导入或复制到各业务页。

fieldset 禁用时 MenuSelect 同时拒绝 portal 中的选择。Tooltip 的键盘说明绑定实际聚焦目标，Escape 关闭说明。

菜单失焦通过relatedTarget识别自己的触发器/portal条目，跨React portal的焦点归属在下一帧复核；不在focusout微任务中先卸载菜单，以免真实鼠标的click丢失。该回归使用原生pointer按下/抬起，不能仅用element.click代替。

规则卡直接复用 `CollapsibleCard` 的原卡壳、标题与 SVG 折叠箭头，受控展开只扩展现有组件。卡头操作区与展开按钮互为兄弟；原 `dragHandle` 的 `⋮⋮`、上移、下移和总开关同排。拖拽按钮保持 28px、8px 圆角与原悬停色，支持上下方向键，搜索或保存期间禁用排序。粗指针目标为 44px。数字和 JSON 原文由草稿池跨折叠/切页保留；指令卡自身 portal 内的焦点移动不视为离卡写盘。卡内的条件卡与动作卡折叠状态同样归草稿池（`store.editorDrafts.expanded`，键 = 模块 + 规则草稿键 + 路径）。

技能卡复用 `configCard/configToggle/configForm`，收起摘要固定三行：名称与状态、单行描述、来源路径与弱化优先级文字。描述、名称和路径超长省略；技能不按来源分组，单一列表按来源优先级再技能名排序，来源只由来源筛选器与卡片上的来源路径承载，可调用状态保留绿色圆点与胶囊。展开区不重复名称、描述和路径，从调用开关开始；开关组没有胶囊边框或背景，模型/用户名称位于各自开关上方。底部操作按保存、重新读取、删除排列；删除靠右，窄容器自动换行而不压缩按钮。可编辑来源展开后惰性读取描述与 Markdown 正文，正文输入排除 YAML frontmatter 和头部后的分隔空行；显式保存携带完整文件版本，服务端保留原有名称、调用策略、注释与未知字段。读取失败禁用未加载的编辑器，保存失败保留草稿，重新读取脏草稿需确认。草稿与展开状态按会话和文件身份保存在工作台，跨折叠、筛选及切页保留，隐藏区域不进入键盘顺序。

模块卡内的选择器、开关及小型文本/数字输入使用紧凑尺寸；大文本和 JSON 编辑器保留 `field-sizing: content`、手动纵向缩放与现有自动测高，不随紧凑控件一起压缩。

规则卡复用原 `PromptConfigNavigation`，基础身份常驻，"规则 / JSON / 设置"同级（条件与动作合并到同一面板：分处两个页签时看不出条件与动作的对应关系）。宽屏左侧导航，容器宽度不超过 620px 时变为上方 tabs；组件自身 ResizeObserver 同时驱动视觉布局与 ARIA 方向，避免跨 CSS Modules 的命名容器失配。

「规则」面板按**条件作用域**组织，与引擎的展开语义同构（`engine/branch.mjs#expandActions`）：规则级 `if` 是一张可折叠的条件卡，它管住的 `then` 节点在一段竖线作用域内各自成卡——动作卡（卡头是类型 + 执行层 + 正文首行）与**分支卡**（节点 `{if, then, else}`，卡头是「当 ⟨条件⟩ → ⟨动作⟩」，卡内可继续嵌套）。分支节点因此是可视编辑的一等语法，不再落到"未知动作 + 裸 JSON"（旧行为会让动作类型下拉收到 `undefined` 并在渲染期抛错，整棵插件树卸载）。每张卡默认收起，卡头单行省略给出「条件 → 动作」一览，展开才编辑；`×` 删除整张卡，图标取官方 IconClose 复制件、与 TagInput 的 chip 删除同形态；↑↓ 只在同一作用域内换位。规则级 `else` 用同一段竖线作用域呈现，为空时只留「添加否则分支」。新增动作在**整条规则**范围内分配唯一 id（引擎拒绝重复 id）。

动作的生效条件是**路径合取**：根到该动作路径上所有 `if` 取「且」、`else` 侧取「¬if」，因此不存在「第 i 个条件配第 i 个动作」；卡头提示逐字给出完整生效条件。注册制层（`system-section` / `runtime-context`）没有逐轮求值时机，引擎拒绝带条件的动作，这些层的添加行禁用分支入口并说明原因；作用域带条件时可选动作按 `supportsWhen`（event 生命周期）过滤。JSON 面板的结构门槛同样按「动作要有 `id` + `kind`、分支要有 `then` 数组」递归判定，不把分支判成非法 JSON。普通面板保持挂载，非活动面板使用 hidden 排除键盘焦点，设置首次进入才挂载。面板 `aria-label` 是页签文字的唯一来源，不在面板内重复标题。说明使用 HintTooltip，错误保留就地提示。

九层表单直接从基础字段开始，不在字段上方重复展示层名、通用作用说明和层的内部技术详情；实际字段的帮助说明及错误提示保持就地可用。

身份与动作字段按内容宽度排列并自然换行，不设固定 200–240px 列。互斥组输入和开关作为一个相邻单元，均属于规则顶层。启用同组卡时发送 `activateRuleId`，服务端原子关闭同模块同组的其它规则；客户端接受整份响应快照，同时保留请求期间的新编辑，不按排序选择赢家。

共享控件的尺寸按用途明确选择：

| 控件 | 紧凑 | 标准 | 宽度与形状 |
|---|---|---|---|
| `TextInput` | H28 / R8，12px/18px | H32 / R12，14px/22px | `config` 默认紧凑；原生 `field-sizing: content` 按实际内容收紧，最小 6ch 加内边距、最大 15rem；数字由共享层统一 96px |
| `TextInput` 路径 | `compact` 显式选择 | 默认 H32 / R12 | `directory` 最大 460px，可收缩到父级宽度 |
| `SearchInput` | 不缩成配置编辑框 | H36 / R12 | 独立使用全宽；`inline` 在复合行伸缩，预留搜索图标与原生清空位置；粗指针H44 |
| `Button` | `size="sm"` H28 / R8 | `size="md"` H36 / R12 | `shape="pill"` 显式保留胶囊；`icon` 提供方形命中范围，危险态不改变几何 |
| `MenuSelect` | `compact` 对应 Button sm H28 | 对应 Button md H36 | 与胶囊按钮共用4px文字图标间距；按当前文本贴合，最大18rem，窄容器可收缩 |
| `Switch` | 可见轨道 36×20、滑块 16×16 | 同一外观 | 轨道与点击区域分离，页面行高不能拉高轨道；开启/关闭配色遵循官方主题 token |

普通圆角使用 `--dsw-radius-sm/md`，兼容未定义 token 的宿主时回退 8/12px；明确的胶囊使用 `999px` 并配 `corner-shape: round`。下拉切换选项时宽度随当前文字改变，不使用最长选项或字符数量估宽；展开菜单独立容纳完整选项。输入不设置 `maxLength`，超长值仍可完整编辑。字段名称不参与控件宽度与点击范围。粗指针输入、按钮和选择器的实际边框至少 H44，开关命中区域至少 44×44 且可见轨道仍为 36×20；菜单原始 pointer 落点在边框外时不打开。

工作台五页以顶部 Tab 标识当前页面，内容区不再重复页名、页面概述或附加摘要。跨页导航聚焦活动 tabpanel，Tab 键导航仍聚焦页签；页面命名由 `aria-labelledby` 关联页签提供。配置卡和能力卡展开后直接显示编辑内容，不额外重复卡名或 ID；基础信息控件保留完整名称与 ID 的编辑能力。

`request-params` 编辑调用字段，字符串清空删除 patch 键，数字清空删除键而 0 保留。未知动作或嵌套扩展可在 JSON 中编辑，服务端编译失败保留完整输入；改规则级 `layer` 会改「动作未声明 `config.layer` 时」的运行通道（动作自带 `config.layer` 时只改展示分组与筛选），不清除动作数据。

动态判断只在 `rule.if` 编辑；条件树支持 all、any、not、notAny，转换组合保留叶子与未完成字段。普通注入动作不显示旧 audience/modelScope/promotion/subject/match，request-params 不显示旧 audience/modelScope。存量字段仍留在完整 JSON，客户端不静默删键或把条件提升到同卡其它动作；非中性旧 gate 由引擎拒绝。唯一例外是固定 system-section 的 complete/suppressRuntimeContext 注册，其 audience 是静态目标而非动态条件。

主会话与子代理共用 `RuleCard`，每卡就是一条真实规则，不再存在模块级“编辑行为规则”二级编辑器。最外层折叠保留，收起只显示卡头，展开才挂载导航和表单；折叠前提交可保存草稿，非法输入保留供重开继续编辑。设置只承载共享参数与资产。原 `PromptConfigCard` 继续拥有指令文件编辑，主会话中置顶，子代理不显示重复文件卡。页面顺序不建立跨插入点的全局执行顺序。

`EngineLayersPanel#engineLayerSlots({ store, t, viewFilter, audience, keyword, … })` 是唯一的层装配入口，返回 `beforeCards`（页面级诊断卡与不占布局的定位 effect）以及 `renderLayerSettings`、`hasLayerSettings` 和 `matchesLayerSettings`。两个页面声明受众视图、创建编排并持有工具草稿所有者，不手写层名判断或重复资产布局。能力参数和资产编辑器由实例卡内的层设置区承载；共享 `EngineModuleCard` 只为模型、人设与子代理参数提供折叠形态。

`LayerSettingsContent` 的参数、装配能力与资产都按共享契约派生：`layerParamCards` 只列当前层实际装配且拥有通用参数的组，`layerAssembledCapabilities` 列出该层已装配能力，资产按 `displayLayer` 归位并复用各自专用编辑器、草稿池与写端点。模型参数不重复生成通用控件。创建本层能力复用 `EngineCapabilityCreateMenu`，提示词模板仍从原九层模板菜单创建。无可编辑设置的层不生成设置页签，无实例不生成兜底卡。设置视图首次进入才挂载，卡片保持展开时切换视图不丢输入；外层折叠卸载视图，草稿仍由工作台持有。

选中某个注入层且该层没有内容时，列表给「该层还没有内容」的空状态与新增入口，不自动创建九张空卡、也不谎称「无匹配」；`world-book` 是策略筛选而非层，保持原有的「无匹配 + 清除筛选」提示。

本层设置由 `app/workspace/pages/layer-settings.module.css` 拥有，参数与资产使用平面小节和细分隔线，不叠加分类边框、内缩或分类级折叠。能力创建保留既有入口；模块模型覆盖只在规则动作编辑。人设、官方当前会话模型、委派和变量通过原编辑器的 embedded 呈现复用草稿与保存逻辑，独立使用时保持原折叠形态。

共享参数短控件按内容宽度排列并自然换行，文本和列表整行；类型由现有渲染属性表达，不复制参数定义。已有主开关与子代理参与开关保留具名字段组和 DOM 顺序，数字使用等宽数字。说明可换行，hidden 优先于布局；控件 DOM 身份包含实例，草稿键与保存入口仍共享。

同名引擎参数允许多处渲染（同层每张实例卡内各有一份本层设置区）：它们绑定同一 `store.fields[键]` 与同一草稿键，一次修改只提交一次保存；`EngineParamField` 的 `instanceId` 带上「层 + 卡身份」，同层多卡的 DOM id、aria 关联互不冲突，不引入第二份状态、同步服务或事件总线。未完成的数字输入与字段错误也属于这份共享草稿：`store.getDraftRevision` / `subscribeDrafts` / `publishDrafts` 是既有 `subscribeFields` 同一模式的窄广播，参数控件订阅它后，一个渲染点里的半成品输入或错误提示立即出现在其他渲染点（含跨层的相关设置），真实重渲染同步由 `module-policy-smoke` 用真实 Edge 覆盖（同层两张实例卡之间切换编辑、错误态同步、一次失焦只保存一次）。工具栏提供插入点层级与策略筛选、九层模板菜单和提示词配置操作；列表筛选只影响展示，不按插入点分区块。能力与提示词配置保留各自保存、排序和删除语义。

world-book 视图只隐藏工具栏之外的列表主体之外的附加提示，不再有独立的模块卡容器需要隐藏；能力参数与资产编辑器都在实例卡的设置区里，随卡一起折叠，折叠时不渲染内容（同层120张卡不会因此多出成百上千控件）。能力与工具在本层设置内创建，模板从工具栏入口插入；创建不改动层级筛选与搜索词。只读预设（system 或关闭 modulesEnabled）下创建和资产编辑禁用，移除入口不渲染，折叠按钮仍可使用。

工具栏提供九层模板创建，其他创建操作内置对应层设置；过滤与受众规则见 §5.2.1。主会话与子代理均显示本会话上下文中的指令文件卡，共用同一文件正文草稿、版本、读取状态与逐文件开关；子代理页不探测另一份文件集合，也不创建独立正文副本。

展开指令卡后，「本层设置」提供当前编辑模块的 `instructionHint`（指令路径提示）开关。`injectionPointSlots.renderInstructionSettings` 只装配既有 `EngineParamField`，沿 `persistParamOverrides` 保存；不依赖普通 pre-step 规则卡存在。各文件卡与两页显示同一模块参数，控件标明模块作用范围，模块总闸关闭或模块不可编辑时禁用。指令正文仍只允许原文件正文编辑，普通注入参数继续锁定，文件级启停仍写独立策略。

世界书是提示词策略筛选，不承载引擎设置（只读诊断卡只在 `world-book` 视图显示）；自定义工具编辑器按 `custom-tools` 编辑组归位到 tool-pipeline 层。配置卡及设置内容可随筛选和折叠卸载，未保存资产与字段草稿由既有共享草稿池保留；工具读取与创建由页面所有者承载，保存失败保留原输入。

搜索统一覆盖「中文名 + 技术键」，且只影响展示：规则按自身定义及层设置匹配，真实层装配通过既有 `matchesEditorGroup` 与分组标题判定设置匹配，匹配时保留同层承载实例，展开后隐藏未命中的组。没有实例的层不会因为设置命中而生成卡片。批量启停作用于当前可见规则集合；旧快捷参数的 `fieldSources` 不再锁定规则或排除其编辑能力。清空搜索恢复原列表，不创建配置或保存。

变量卡的输入、启停、删除和失焦保存受模块可写性约束，状态写入既有草稿键。模块模型参数属于规则动作，当前会话的 `selectModel` 单独按官方 selectable 决定可用性。

子代理工具策略（`subagent-tool-policy`）是模块类型能力：在能力菜单里创建，编辑器住在 tool-pipeline 层的层设置区资产分区里（`data-layer-asset="subagent-tool-policy"`），用「移除能力」入口移除。该编辑器只有**一个启用开关**：打开复用共享可用骨架并立即落盘；关闭删除顶层策略段并保留模块声明，同时把编辑区置为 `fieldset[disabled]` 只读。引擎仅在策略文件确实不存在时降级为官方委派行为，现存损坏文件仍报错。移除能力时模块声明与顶层段一起移除。历史“段在、声明不在”预设保留既有授权装配，装配清单如实列出它；保存或显式创建会补齐模块声明，不覆盖已有授权。子代理页排除「仅主对话」能力：它们的参数与装配条目不进本页设置区。能力卡的组织方式见前端实现（待 UI 重构时补充）。

策略编辑器在焦点离开编辑区时自动保存，没有保存按钮。标签输入的失焦提交先更新最新草稿，再生成保存快照；保存成功只确认对应快照，期间新编辑仍保持待存。再次失焦时若旧请求未完成，只保留最新待存快照并串行提交；失败保留草稿供下一次失焦重试。切换预设或卸载会使旧读取、保存响应及未发送队列失效。

层设置区展示当前预设实际装配的能力（`modules` 声明、参数与行配置隐含补齐、以及实际运行的历史子代理策略），按主归属层分组：清单里每项是能力 id 与「移除能力」入口（二次确认），没有「编辑行为」这类编辑目标选择器；能力自身的参数在同一设置区的参数分组里编辑，新能力从本层创建入口添加。`modules: []` 不展开默认骨架，官方组合行不生成插件能力条目。二次确认移除是完整移除：模块声明、该能力的显式参数与行配置（拥有顶层段的能力连数据段）一起删除，成功后重建一次并刷新模块事实。

子代理页的筛选值与变更回调一起传到提示词列表；能力卡按同一层级过滤，工具管线包含子代理工具策略等本层能力。模板创建与列表展开共用页面持有的创建 ID，子组件不维护第二份无入口 picker。创建不改变筛选或搜索值。

指令文件（AGENTS.md / CLAUDE.md 及其 .local 变体）复用 `PromptConfigCard` 呈现在配置列表中，卡头显示文件路径、启停与读取／保存状态，不显示普通配置的位置、策略或受众标记，不提供移动、复制与删除配置菜单。展开后复用 `PromptConfigForm` 的正文编辑，只留正文输入；ID／名称／注入层基础身份区与「内容」分区标题都不渲染（卡头与页签已给出身份和分区名，编辑器不再重复名称、路径与策略说明），上方没有身份区可分隔，导航改用 `.configNavigationFlat` 去掉分区横线与顶部留白；注入规则、作用范围、高级消息元数据与层设置同样隐藏；这些行为归官方指令来源所有。名称与启停写入 `$DSH_HOME/.prompt-tool/instructions.yml`，正文写文件草稿，**焦点离开卡片即自动写回原文件**（没有单独的保存按钮；版本冲突时保留草稿并显示「重新读取」）。文件卡不参与普通配置的层内排序；现有文件授权、上下文白名单、版本校验与读取失败保护继续生效。

「指令提示」统一使用 `strategy: placeholder` 与 `fill: instruction-hint`，不提供独立旧策略或保存时转换。模块级 `instructionHint` 继续默认关闭，启用时在逐文件过滤后转换符合条件的官方消息，不做逐文件全文／提示模式。默认组合为 `promoteOn: either`、`includeSubagents: true`：主会话与子代理首请求保留全文，首次工具调用或助手消息后转为路径提示；成功压缩后重新经历全文与晋升。转换只影响待注入消息，不改已入历史的正文；其他启用模块的转换设置独立生效。指令文件正文与策略分别由原文件和独立策略文件持有，官方内容无法可靠分段时原样放行并诊断；开关不表示停止文件读取或删除历史。客户端直接消费当前插件下发的完整层元数据，不为旧宿主补字段；bootstrap 返回前使用空加载快照。**层清单有两份，用途不同**：`layerOrder` / `layers` 是九层，供视图筛选、层卡片组织与规则级 `layer`；`injectionLayers` 是可注入的八层（九层去掉没有注入通道的 `tool-pipeline`），只给注入动作的 `config.layer` 下拉（`RuleFields` 按 `:config` 前缀取它，其余 layer 下拉仍取九层）。两份清单同源于引擎 `LAYER_DEFINITIONS`，客户端不另写一份层表。

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
- 提示词排序同时提供 pointer drag 与上移/下移键盘替代；边界按钮有明确 aria-label。技能列表跟随官方来源与会话裁决，不提供自定义注册顺序。
- reduced-motion 下关闭平移和过渡；focus-visible 必须清晰。
- 外层抽屉和工作台壳使用overflow: clip；程序化定位只滚动canvas，不能把页头和导航滚出固定面板。

### 9.4 模块参数命名与说明

- 可见参数名使用简洁简体中文，优先采用 2-6 字的领域名称；不在标签中显示内部键名、英文枚举或括号实现说明。
- 内部键和值、bridge 载荷和 module.yml 保持英文契约；下拉选项通过中文映射展示，未知旧值仍回显原值，不能因汉化丢失编辑能力。
- 布尔参数使用正向短名称，例如「独占」「互斥」「动态运行时上下文」；名称位于开关上方，与输入框和选择框保持相同字段节奏。
- 字段说明统一经 `ui/HintTooltip.tsx`。组件只复用宿主 Tooltip 的视觉 token、内边距、圆角、字号与淡入效果，不调用宿主 Tooltip 的定位实现。
- HintTooltip 通过 `body` portal 与 `position: fixed` 定位：鼠标悬停延迟 500ms 后在指针附近显示并随指针移动；键盘聚焦即时读取控件 `getBoundingClientRect()`，紧邻控件显示（鼠标点击产生的聚焦不锁定说明，失焦后回到悬停延迟）；视口边缘自动翻转或收敛。
- `HintTooltip.module.css` 使用宿主 `--dsw-alias-tooltip-bg` 和静态前景 token，并与宿主尺寸一致；背景混入工作台底色以降低透明度。业务组件不得再使用原生 `title` 或自制 `data-tip` 伪元素。
- 字段错误、只读警告、保存状态和空状态不是帮助说明，继续就地显示，不藏入 Tooltip。
- 系统提示段动作保留显式参数；module.yml 顶层人设通过原 persona 编辑器保存（见 §5.2），不复制进动作正文。字段按内容宽度排列，窄容器自然换行。

## 10. 样式所有权

样式使用 CSS Modules 和 DSH 语义 token，当前 owner 为：

    app/workbench/Workbench.module.css
    app/workspace/PromptWorkspace.module.css
    ui/controls.module.css
    ui/HintTooltip.module.css
    ui/StatusBadge.module.css
    ui/StatusDot.module.css
    features/modules/modules.module.css
    features/prompts/prompts.module.css
    features/prompts/rules.module.css
    app/workspace/pages/layer-settings.module.css
    features/skills/skills.module.css
    features/subagents/subagents.module.css
    features/tools/tools.module.css

约束：

- 组件移动时同步移动其独占 selector；共享 selector 必须对应稳定的真实共享形态。
- 主题颜色只使用 `--dsw-alias-*`；普通控件圆角复用官方 `--dsw-radius-*`，字体、间距和动效由插件共享层持有，不复制宿主静态色板，不写 :root 主题。窗口 chrome 避让继续消费官方布局公开的 `--dsh-*` 几何变量，不读取宿主 DOM。
- 整条窗口标题栏由宿主持有：抽屉层与模态遮罩通过 `--dsh-frame-chrome-top` 从标题栏下沿开始绘制，抽屉阴影裁剪在该层内；内容不再重复累加标题栏高度。全屏时该值归零，Web 未定义时回退 0，安全区和 macOS 行内避让保留。
- feature CSS 不选择宿主 class、id 或页面结构。
- 中性平面边框使用 0.5px；高层浮层用 alias 颜色组合自有阴影。悬浮入口抽屉/触发器使用 body portal 的 1000 / 1100 层级，不叠加无意义的中性 border。
- 圆形和胶囊与 corner-shape: round 配对。
- 动画提供 prefers-reduced-motion 分支；不新增组件专用全局滚动条规则。
- 页面级垂直节奏只有一档：主会话根容器 `.page`（features/prompts）与子代理根容器 `.section`（ui/controls）同为 12px；工具栏到首张卡之间不插入空的公共配置或模块列表容器，避免空 flex 子项叠加间距。
- 不为减少文件数把不相关领域重新合并，也不先复制旧 selector 再长期双写。

## 11. 性能与行为不变量

- useSyncExternalStore 的 snapshot 在值未变时复用引用；usePromptToolFields selector 只通知真正变化的 fields。
- 不把 store 放进 Context 触发整树广播；只在有实测收益时保留 memo 和稳定 callback。
- 首屏使用一次 bootstrap 聚合；模型目录惰性加载并缓存。
- filter/search 只在客户端运行；不引入虚拟列表、dynamic import 或 code splitting 来解决尚未出现的规模问题。
- UI 分组不建立九个插入点的全局执行顺序；配置序号控制对应插入点、位置内的次序，官方定位 `order` 独立保留。
- order 的官方刻度只出现在 `system-section` 与 `runtime-context` 两层。数字输入与「插入到官方位置…」共用同一 NumberField 草稿和接受值路径；选择快捷位置同时更新数字、清除该字段错误，不改其他草稿。区段之前使用 `from - 1`，全部之后使用 `max(to) + 1`，避免同值按名称排序导致位置不符。边界来自 bridge 的 `meta.officialOrders`；缺席或空表时只保留数字输入。其余层只显示层内顺序说明。
- 规则卡最外层折叠保留；内部使用条件、动作、JSON、设置导航。隐藏面板不进入 Tab 顺序，错误状态在页签提示；窄容器使用上方 tabs 和自然换行的紧凑字段，宽屏侧栏贴合文案宽度。
- 当前会话模型始终读取官方 sessions projection，切换始终走 official session.selectModel。
- 未启用的可选模块保持 opt-in；生成结果、preset 优先级和 bridge 载荷不得因 UI 重构改变。

## 12. 测试与验证

### 12.1 契约测试

四条 seam 的覆盖位置（定义与准入见 [AGENTS.md](../AGENTS.md#测试)）：

| seam | 覆盖位置 |
|---|---|
| 引擎注入行为（插入点 / 时机 / 次数 / 受众） | `test/engine/*.test.mjs` |
| 写盘产物语义 | `test/host/write-module.test.mjs`、`test/host/module-*.test.mjs`、`test/host/module-storage.test.mjs` |
| bridge 端点载荷 | `test/shared/bridge-contract.test.mjs`、`test/client/bridge-client.test.mjs`、`test/host/settings-bridge.test.mjs`、`test/host/*-bridge.test.mjs` |
| 安全与拒绝路径 | `test/host/instructions-policy.test.mjs`、`test/host/instruction-scope-guard.test.mjs`、`test/host/skill-policy.test.mjs`、`test/host/module-package-import.test.mjs`、`test/host/characters-protection.test.mjs`、`test/host/wave1-safety.test.mjs`、`test/host/text-file.test.mjs`、`test/engine/config-whitelist.test.mjs` |

**安全边界的守护位置**：指令文件读写（授权、上下文白名单、内容版本冲突、读取失败）、导入回滚、路径穿越、大小上限、桥端点安全面、晋升门控与 epoch 这些不变量，由上面「安全与拒绝路径」一栏的文件覆盖；改动它们需要独立授权，不得顺带删减。

不再引入 Jest、Vitest、jsdom 或 happy-dom：客户端渲染与交互不再由渲染断言覆盖，改为人工核对加 §12.2 的命令门禁。

### 12.2 验证命令

所有测试从临时 cwd 执行：

    $Repo = 'D:\AI\GitHub\dsh-plugin-prompt-tool'
    Set-Location 'D:\AI\workspase\_temp'

    pnpm --dir $Repo typecheck
    pnpm --dir $Repo lint
    pnpm --dir $Repo test
    pnpm --dir $Repo build
    git -C $Repo diff --check

测试从临时 cwd 与临时 DSH_HOME 执行，不接触当前运行中的 DSH 服务。

本文只列 seam 级覆盖，不在文档里复制易变的用例名录。

## 13. 维护清单

新增客户端能力时按以下顺序检查：

1. 先确定 owner：宿主适配放 index/data，跨页组合放 app，单领域行为放 feature，共享呈现放 ui。
2. 若涉及 bridge，先修改 src/shared/bridge-contract.ts，再同步 host 注册、client 调用和契约测试。
3. 若涉及 Fields、参数或保存，先核对 [architecture-params.md](architecture-params.md) 的空值、优先级和写盘语义。
4. 若涉及引擎层或插入点，核对 [engine-reuse.md](engine-reuse.md)，不要用 UI 顺序推导运行时顺序。
5. 若涉及 SillyTavern、角色卡或世界书，遵循 [SillyTavern.md](SillyTavern.md) 的转换契约。
6. 新 selector 必须有明确 CSS owner；新交互必须同时考虑键盘、焦点、错误和 reduced-motion。
7. 新增或改造面向用户的文案时，同步更新 zh/en 两份字典；改动结构、接线或发布面时，按 §12.1 的 seam 表跑对应契约测试。
8. 完成 typecheck、lint、test、build 和 diff --check 后再提交；不要停止或重启当前 DSH 服务。

本文是客户端结构的长期权威文档；本地 `.scratch/plan/` 跟踪当前计划与验收，稳定结论沉淀回本文及对应领域文档。
