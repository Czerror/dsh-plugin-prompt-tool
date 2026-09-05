# Web 客户端 UI 结构框架

> 适用范围：dsh-plugin-prompt-tool 的 src/client/ 结构、宿主 SlotRegistry 接入、工作台页面编排、客户端状态与 bridge 边界、共享交互和样式所有权。
> 当前状态：Wave 0-9 已完成；本文是 2026-09-04 起的现行架构说明，不是实施计划。
> 相关代码：src/client/index.ts、src/client/app/、src/client/data/、src/client/features/、src/client/ui/、src/shared/bridge-contract.ts。

本文将已完成的 UI 重构结论固化为长期维护契约。preset、params、promptConfigs、variables、customTools、角色卡和子代理策略的存储及生成语义仍以现有 host/engine 文档为准；本文只说明客户端如何承载这些能力。

## 1. 定位与边界

客户端的产品边界是“位置、时机与受众可配置的提示词注入工作台”。工作台负责编辑、展示和提交配置，不重新定义引擎的六个官方插入点，也不把某一个预设能力提升为全局默认。

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
    ├─ prompt-tool-types.ts
    ├─ app/
    │  ├─ workbench/
    │  │  ├─ FloatingTrigger.tsx
    │  │  ├─ register-workbench.tsx
    │  │  ├─ SettingsTab.tsx
    │  │  ├─ SidebarGeometryProbe.tsx
    │  │  ├─ Workbench.module.css
    │  │  ├─ WorkbenchOverlay.tsx
    │  │  ├─ workbench-face.ts
    │  │  └─ workspace-controller.ts
    │  └─ workspace/
    │     ├─ PromptWorkspace.module.css
    │     ├─ PromptWorkspace.tsx
    │     ├─ WorkspaceFrame.tsx
    │     ├─ WorkspaceNavigation.tsx
    │     ├─ workspace-pages.ts
    │     └─ pages/
    │        ├─ ConfigListWithTemplates.tsx
    │        ├─ MainSessionPage.tsx
    │        ├─ ModelRouteStatus.tsx
    │        ├─ SubagentPage.tsx
    │        └─ model-route-status.ts
    ├─ data/
    │  ├─ bridge-client.ts
    │  ├─ bridge-transport.ts
    │  ├─ dirty-state.ts
    │  ├─ host-api.ts
    │  ├─ import-files.ts
    │  ├─ param-overrides.ts
    │  ├─ prompt-config-content.ts
    │  ├─ prompt-tool-fields.ts
    │  ├─ prompt-tool-view.ts
    │  ├─ save-queue.ts
    │  ├─ session-model-face.ts
    │  ├─ use-prompt-tool-fields.ts
    │  └─ use-prompt-tool-store.ts
    ├─ features/
    │  ├─ characters/
    │  │  ├─ character-card.ts
    │  │  ├─ characters.module.css
    │  │  └─ CharactersPage.tsx
    │  ├─ models/
    │  │  └─ ModelRouteCard.tsx
    │  ├─ modules/
    │  │  └─ EngineModuleList.tsx
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
    │  │  └─ useTemplatePicker.ts
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
    │     ├─ CustomToolEditor.tsx
    │     ├─ CustomToolsCard.tsx
    │     ├─ tools.module.css
    │     └─ ToolSurfaceView.tsx
    └─ ui/
       ├─ anchored-popover-fit.ts
       ├─ anchored-popover.ts
       ├─ CollapsibleCard.tsx
       ├─ controls.module.css
       ├─ dialog-focus.ts
       ├─ DialogSurface.tsx
       ├─ EngineModuleCard.tsx
       ├─ FormField.tsx
       ├─ ImportFileButton.tsx
       ├─ MenuSelect.tsx
       ├─ SettingInputRow.tsx
       ├─ tab-key.ts
       ├─ TagInput.tsx
       ├─ TemplatePicker.tsx
       └─ ToggleRow.tsx

生成目录 lib/ 不属于源码 owner，不手工编辑。客户端样式已按 owner 分开，PromptUi.module.css 不再存在。

## 4. 宿主接入与生命周期

### 4.1 入口装配

src/client/index.ts 的 inject 列表是：

    slots
    settingsScope
    uiWorkspace
    remote
    remote.agentPresets
    remote.session
    sessions

apply(ctx) 依次构造：

1. prompt-tool SettingsScope transport，用于标准部署设置的 mirror、ensure 和 mutate。
2. PromptToolHostApi，封装目录选择、打开路径、预设切换和当前会话模型选择。
3. session-model-face，读取官方 sessions projection，并经 remote.session.selectModel 写回。
4. PromptToolWorkspaceController 与 PromptToolWorkbenchFace。
5. registerWorkbenchSlots(ctx, face)，唯一负责三处 slot 注册。

入口不直接导入页面、bridge endpoint 或业务卡片；需要新宿主能力时先扩展 data/host-api.ts 或 shared 契约。

### 4.2 Slot 契约

| 官方 slot | id | order | owner | 作用 |
|---|---|---:|---|---|
| sidebar.footer.action | prompt-tool-floating-geometry | 40 | SidebarGeometryProbe | 仅提供侧栏轨道几何，不渲染第二个可见入口 |
| settings.plugins.tab | prompt-tool | 40 | SettingsTab | 部署开关、AGENTS 写入/注入和默认预设 |
| shell.overlay | prompt-tool-workbench | 50 | WorkbenchOverlay | 悬浮触发器、顶层抽屉和完整五页工作台 |

三处都使用 ctx.slots.inject() 等待官方槽位声明，再调用 ctx.slots.register()；返回的 disposer 在 register-workbench.tsx 中统一释放。不要添加第二个注册入口，也不要改变 id、order 或 inject face 的形状。

### 4.3 浮层、侧栏与关闭行为

- WorkbenchOverlay 将自己的 trigger 和 drawer 通过 body portal 挂载，避免被对话导航栏或 drawer overflow 截断。
- drawer 使用 fixed 高层定位、backdrop、Escape 和自身焦点恢复；关闭后焦点回到触发按钮。
- 打开工作台会发出本插件的面板激活事件，与仍在 DOM 中的其他面板保持互斥；事件处理只消费约定的自有事件，不查询宿主 class。
- SidebarGeometryProbe 从官方布局轨道读取 grid-template-columns 第一轨，写入 --pt-sidebar-edge；ResizeObserver、transitionend 和 window resize 共同覆盖折叠、拖拽和断点变化。
- probe 是 geometry-only occupant。禁止用宿主选择器、固定层级或条件折叠属性作为可见按钮锚点。

## 5. 工作台与页面信息架构

### 5.1 可见入口

    settings.plugins.tab
      └─ 基础设置：部署开关 + 默认预设

    shell.overlay
      └─ 完整工作台
          ├─ 主会话
          ├─ 子代理
          ├─ 技能设置
          ├─ 预设配置
          └─ 角色管理

settings tab 不复制工作台内容。完整工作台由 PromptWorkspace 创建 store、保存当前页，并在打开时触发一次 load；WorkspaceFrame 负责公共 header、导航、canvas、loading 和 notice。

预设的 roster、目录物化、复制、删除和默认值由本插件维护；官方 agentPresets 只用于会话预设切换及其与宿主默认值的双向同步。

### 5.2 页面 ID、顺序与组合

workspace-pages.ts 是页面元数据的唯一来源。默认页为 features，顺序不可变：

| id | 标题 | 主要组合 |
|---|---|---|
| features | 主会话 | ModelRouteStatus、主会话 ModelRouteCard、PromptConfigsEditor（通用/引擎能力双视图）、按能力拆分的 EngineModuleList、直接工具卡列表 |
| subagent | 子代理 | 子代理 ModelRouteStatus、ModelRouteCard、DelegationToolsCard、ToolSurfaceView、ConfigListWithTemplates |
| skills | 技能设置 | 目录与来源、状态筛选、SkillRow、目录引用/导入/排序 |
| presets | 预设配置 | 全局生成开关、AGENTS/生成目录设置、PresetSwitcher 与预设 CRUD |
| characters | 角色管理 | PNG/JSON 导入、角色卡库、应用/移除/删除与目录打开 |

主会话页中的卡片顺序是 UI 分组，不表示六个官方注入 seam 的运行顺序。六个插入点彼此独立，运行时顺序和参数语义见 [engine-reuse.md](engine-reuse.md)。

### 5.3 状态展示约定

- loading：保留已有数据；只有没有可展示数据时才显示骨架。
- saving：只禁用冲突动作，不冻结其他草稿输入。
- notice：工作台公共状态使用 role=status；字段校验贴近字段显示。
- destructive action：先进入局部确认状态，再执行删除；确认过程中保持焦点可达。
- 长路径、模型名和预设名使用单行省略，完整值通过 title 或可读描述保留。

## 6. 状态与数据流

### 6.1 所有权

| 状态 | Owner | 生命周期/规则 |
|---|---|---|
| 工作台 open | PromptToolWorkspaceController | client 插件生命周期；无 React 依赖 |
| 当前顶层页 | PromptWorkspace | 工作台挂载期；不写 URL 或 localStorage |
| fields、meta、providers、catalog | usePromptToolStore | 工作台挂载期；打开时重新同步 |
| 标准设置值 | 官方 SettingsScope | 宿主 mirror 生命周期 |
| 当前会话模型 | session-model-face | 官方 sessions projection 生命周期 |
| filter、search、展开、确认 | 对应 feature | 页面或 feature 局部生命周期 |
| 保存队列、revision、草稿版本 | save-queue + store | 工作台挂载期 |
| 大文本和角色卡原文件 | 文件通道/bridge | 不进入 settings descriptor |

不新增 React Context 来广播整个 store。页面通过 usePromptToolFields selector 订阅窄切片，叶子组件接收显式值与 callback。

### 6.2 首屏读取与更新

    打开 shell.overlay
      -> PromptWorkspace.store.load()
      -> bridgeCall("bootstrap") 聚合 descriptor、meta、变量和 promptConfigs
      -> fieldsFromView() 合并 value/base 与 presetParams
      -> /models 按需加载并缓存模型目录
      -> page selector 订阅 fields 引用

bootstrap 是首屏聚合请求，不因筛选或输入字符增加 bridge 请求。模型目录保持惰性加载；技能筛选、状态筛选和搜索在客户端完成。

### 6.3 纯逻辑与 facade

use-prompt-tool-store.ts 是唯一工作台 facade，负责把 SettingsScope mirror、typed bridge、字段快照、保存队列和 feature actions 组合成 React 可消费状态。可独立测试的逻辑放在以下模块：

| 模块 | 责任 |
|---|---|
| prompt-tool-fields.ts | Fields、StageDraft、默认值、字段级 helper |
| prompt-tool-view.ts | bootstrap/view 到 Fields 的 shape guard 与映射 |
| dirty-state.ts | snapshot、深比较、阶段草稿完整性和 reload 判定 |
| param-overrides.ts | params 的列表拆分、条件发送和读回 patch |
| prompt-config-content.ts | preset.md/AGENTS.md 内容资产的提升与剥离 |
| save-queue.ts | 串行保存任务的最小队列 |
| import-files.ts | 浏览器文件导入的纯读取辅助 |
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
    失败：{ ok: false, code?, message? }

JSON bridge 的统一上限为 32 MiB；角色卡接近上限时走原始文件流，避免 base64 膨胀。transport 不解析 feature 数据，也不拥有 Fields。

### 7.3 保存保护

1. 参数、设置和配置保存进入串行队列，避免失焦/自动保存并发覆盖。
2. 请求使用保存时的 snapshot；成功后只更新该 snapshot 的 saved 基线。
3. 请求期间继续编辑时，当前 fields 与 saved snapshot 不同，dirty 保持为真。
4. 成功后的静默 load 只有在草稿版本未变化且没有未完成阶段草稿时才应用。
5. promptConfigs 自动保存使用 debounce；手动保存仍经过配置校验。
6. 参数空字符串/空数组沿用删除键语义；variables 的空字符串仍是合法占位值。详细参数规则见 [architecture-params.md](architecture-params.md)。

## 8. 业务 Feature

feature 只拥有自己的视图、瞬时状态、领域纯 helper 和 CSS：

| feature | 责任边界 |
|---|---|
| prompts | 六层配置卡、字段策略、排序、模板插入、变量编辑和内容配置 |
| models | 当前预设的主/子代理模型路由卡；模型下拉展示完整目录并按服务商分组，选择模型时内部回写 provider + model，不提供独立服务商选择控件 |
| modules | 引擎能力列表与层级筛选；一项显式装配能力一张卡，存在性由 `/bootstrap.moduleFacts.declaredModules` 决定，卡片形态由 ui/EngineModuleCard.tsx 提供 |
| subagents | 委派工具、实例级工具策略草稿、策略预览和工具面入口 |
| tools | 自定义工具编辑/保存、参数模板和存活 Agent 工具面 |
| skills | 技能目录引用/导入、状态筛选、排序、开关、修复和打开目录 |
| presets | 预设生成开关、路径、切换、导入导出、复制/删除/打开 |
| characters | SillyTavern PNG/JSON 导入、角色卡库存、应用/移除/删除 |

业务 feature 直接使用 data/bridge-client.ts 的 endpoint key；共享控件从 ui/导入。跨 feature 组合由 app/workspace/pages/完成，不在 feature 内建立第二个工作台。

## 9. 共享 UI 与可访问性

### 9.1 共享形态

ui/ 只接收 props/callback，当前真实共享 seam 包括：

- FormField：label、hint、error 与 aria-describedby 配对。
- SettingInputRow、ToggleRow、TagInput：设置和字段编辑形态。
- MenuSelect：直接封装官方 Menu 的单选胶囊；支持连续选项的 `group` 分组标题。标准设置使用 36px，模块卡内使用 28px 紧凑形态，浮层统一 portal。
- CollapsibleCard、EngineModuleCard：具体可复用的折叠/模块卡形态，不是万能 Card。
- ImportFileButton：隐藏原生 file input 的导入入口。
- TemplatePicker、DialogSurface：模板和预设操作的 portal 浮层。
- anchored-popover.ts / anchored-popover-fit.ts：锚点位置和窄视口适配。
- tab-key.ts、dialog-focus.ts：纯键盘索引及弹窗焦点行为。

单行 input 与 textarea 继续使用原生元素；下拉单选统一使用官方 Menu，经 MenuSelect 保持触发器、浮层和 ARIA 一致。新按钮优先使用官方 Button/Pill/icon primitive，不创建本地 Button wrapper。

模块卡内的选择器、开关及小型文本/数字输入使用紧凑尺寸；大文本和 JSON 编辑器保留 `field-sizing: content`、手动纵向缩放与现有自动测高，不随紧凑控件一起压缩。

主会话模块列表提供两个互斥 sibling view：`general` 展示当前 seam 的 promptConfigs，`capability` 展示模型路由、引擎能力卡和 tool-pipeline 工具卡。`layerFilter` 在两个 view 间保持独立；view 切换不改变 dirty 快照、参数保存队列或模块事实。

引擎能力卡只展示当前预设 `modules` 显式声明的能力；`modules: []` 不展开默认骨架，官方组合行不生成插件能力卡。可编辑卡提供局部二次确认删除，删除只移除模块声明并保留 dormant 参数，成功后重建一次并刷新模块事实。

`ToolSurfaceView` 的 `sessionId` 分支表示当前存活 Agent；`presetId` 分支表示官方预设后续 generation 的只读能力。预设分支只在能力视图显式挂载时请求，不在 bootstrap 遍历所有预设。

### 9.2 Tabs

所有 tablist 遵循自动激活模式：

- 当前 tab 的 tabIndex 为 0，其余为 -1（roving tabIndex）。
- ArrowLeft/ArrowRight 循环移动；Home/End 跳到首尾。
- 选择后把 DOM 焦点移到新 tab。
- tab 拥有稳定 id 与 aria-controls；panel 使用 role=tabpanel 和 aria-labelledby。
- nextTabIndex() 保持无 DOM 的纯索引算法，并由 Node test 覆盖空列表、无效索引和非导航键。

### 9.3 Dialog、表单与排序

- DialogSurface/TemplatePicker 使用 body portal、backdrop、Escape、首控件聚焦、Tab/Shift+Tab 循环、关闭后焦点恢复、role=dialog 和 aria-modal。
- 弹窗只操作自己的 ref，不查询宿主页面结构。
- 数值输入在提交点解析，草稿期保留字符串，避免输入中间态跳动。
- 提示词、技能和阶段排序同时提供 pointer drag 与上移/下移键盘替代；边界按钮有明确 aria-label。
- reduced-motion 下关闭平移和过渡；focus-visible 必须清晰。

## 10. 样式所有权

样式使用 CSS Modules 和 DSH 语义 token，当前 owner 为：

    app/workbench/Workbench.module.css
    app/workspace/PromptWorkspace.module.css
    ui/controls.module.css
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
- 中性平面边框使用 0.5px；高层浮层使用 DSH elevation token，z-index 由 workbench CSS 集中管理，不叠加无意义的中性 border。
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

客户端测试仍按 test/client/*.test.mjs 平铺维护，重点包括：

- structure-baseline、feature-boundary、ui-boundary：目录、依赖方向和入口边界；
- slot-workbench-contract、no-host-dom：slot id/order、portal、disposer 和无宿主 DOM 操作；
- bridge-client 与 test/shared/bridge-contract：前缀、端点映射、统一载荷和 bootstrap 聚合；
- prompt-tool-view、dirty-state、param-overrides、save-queue、session-model-face：映射、快照、空值、队列和引用稳定；
- tab-key、workspace-navigation、dialog-focus、anchored-popover：键盘、ARIA、焦点和锚点行为；
- style-ownership：CSS Modules、token、0.5px、reduced-motion 和全局污染边界；
- prompt-config-order、skill-status、subagent-policy-draft、model-route-status：领域纯逻辑。

交互 DOM 行为由纯 helper、静态契约和隔离浏览器 smoke 共同覆盖，不新增 Jest、Vitest、jsdom 或 happy-dom。

### 12.2 验证命令

所有测试从临时 cwd 执行：

    $Repo = 'D:\AI\GitHub\dsh-plugin-prompt-tool'
    Set-Location 'D:\AI\workspase\_temp'

    pnpm --dir $Repo typecheck
    pnpm --dir $Repo lint
    pnpm --dir $Repo test
    pnpm --dir $Repo build
    git -C $Repo diff --check

浏览器 smoke 使用隔离 DSH_HOME 和随机端口，不接触当前运行中的 DSH 服务；覆盖侧栏折叠/拉伸、drawer Escape/焦点、五页切换、明暗主题、窄宽度、reduced-motion、预设/配置/技能/角色卡高风险流程。

### 12.3 已完成记录

- Wave 0-9 于 2026-09-04 完成，结构重构、模型状态和顶层锚定浮层已验收。
- typecheck、lint、test、build 均已通过；后续改动以当前命令重新取得测试数量，不在本文固定易变的计数。
- Edge 隔离 smoke 已验证新建预设浮层的 body parent、fixed 定位、层级、按钮锚定和滚动跟随，且无 console/page error。
- Archify 1440×900 与 2048×1320 明暗图的 containment、captures、showcase 均通过；自动收据 visualReview=pending 仍表示需要人工查看截图，不等同于渲染失败。

## 13. 维护清单

新增客户端能力时按以下顺序检查：

1. 先确定 owner：宿主适配放 index/data，跨页组合放 app，单领域行为放 feature，共享呈现放 ui。
2. 若涉及 bridge，先修改 src/shared/bridge-contract.ts，再同步 host 注册、client 调用和契约测试。
3. 若涉及 Fields、参数或保存，先核对 [architecture-params.md](architecture-params.md) 的空值、优先级和写盘语义。
4. 若涉及引擎层或插入点，核对 [engine-reuse.md](engine-reuse.md)，不要用 UI 顺序推导运行时顺序。
5. 若涉及 SillyTavern、角色卡或世界书，遵循 [SillyTavern.md](SillyTavern.md) 的转换契约。
6. 新 selector 必须有明确 CSS owner；新交互必须同时考虑键盘、焦点、错误和 reduced-motion。
7. 完成 typecheck、lint、test、build 和 diff --check 后再提交；不要停止或重启当前 DSH 服务。

本文是客户端结构的长期权威文档；根目录 [PLAN.md](../PLAN.md) 仅跟踪当前引擎能力卡重构，完成后将状态沉淀回本文及对应领域文档。
