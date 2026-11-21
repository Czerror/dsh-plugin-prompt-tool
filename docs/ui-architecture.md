# Web 客户端 UI 结构框架

宿主能力下拉提供独立“回退时重开已完成待办”（`session-rewind-todos`），选择后为布尔 `value: true`，内置卡默认开启。保存版本诊断沿 `host:session-rewind-todos` 与现有 HintTooltip 展示；不新增待办编辑器或状态库。标记已提交但待办失败时显示逐目标原因，沿既有“仅重试失败目标”补写待办。

会话输入区 `conversation.input.right` 的回退菜单提供“回退一次”和“回退上一轮”，使用槽的真实 `sessionId` 与公开输入动作；复用共享 Button、Menu、HintTooltip 及中英文词条。预览固定边界后提交，busy 同时禁用两项。部分成功列出逐目标结果，“仅重试失败目标”沿原边界重新授权，已提交目标不重复执行。

空白且未修改的草稿通过 `captureInsertion` / `insertText` 版本校验回填，随后持久化，不自动提交。新草稿、引用、附件、会话切换或提交锁定时保留原草稿，提供只读回退文本；历史已提交而回填失败分别报告。回退槽由 `app/register-rewind.tsx` 持有接线和瞬时结果 owner；迟到文本、失败与重试凭据按原会话保存并通知重挂视图，回到原会话即可取回，插件释放清空，不写持久草稿库。提交响应丢失或失败目标重试后首次确认成功仍保留文本；同一标记已回填则不重复插入。Conversation 适配只包装公开 binding snapshot 实际返回的 assembler 实例，核对构造身份、原型方法与实例可扩展性；已有第三方实例覆盖不接管。即时 append、替窗重放和向前分页统一解释标记，原事件源保持。插件卸载后的环境不支持完整回退展示，需恢复解释器，不能把卸载当历史撤销。

回退适配的普通按序追加沿原生增量路径，保持宿主的帧调度与历史节点身份；回退标记、乱序、替窗、分页及标记后同轮续写才进行必要的过滤重放，新一轮恢复增量。回复结算同步清除同次尝试的瞬时缓存，防止后续回放复活已结算片段；会话作用域释放时移除本插件的方法覆盖和历史缓存，保留后来第三方的覆盖，插件卸载只处理仍在场的适配器。服务端适配在同一 Session 的最后一个 Agent 释放时撤销；历史回退标记首次读取后仅扫描新增事件，没有标记时直接使用原生消息结果。

宿主能力统一沿规则草稿、保存版本与 `host:<capability>` 诊断展示；选项、初始值及诊断通道由 `data/host-control-policy.ts` 持有。布尔能力使用 `value: true`，Hook 决定透传使用 `provider-hook-decisions` 对象中的 `claude-code` / `codex`。开启仅表示配置意图，不保证 early 接缝或真实 caller 就绪；运行行为、默认值和重启条件见[引擎指南](engine-reuse.md)。界面不另建能力正文、待办编辑器或状态库。

> 适用范围：dsh-plugin-prompt-tool 的 src/client/ 结构、宿主 SlotRegistry 接入、工作台页面编排、客户端状态与 bridge 边界、共享交互和样式所有权。
> 本文描述当前实现，不是实施计划；与代码不一致时以代码为准。
> 相关代码：src/client/index.ts、src/client/app/、src/client/data/、src/client/features/、src/client/ui/、src/shared/bridge-contract.ts。

本文记录客户端维护契约。module.yml 的 rules、公共 params、variables、customTools 和角色卡的存储及生成语义以 host/engine 文档为准；promptConfigs 仅保留运行时投影和指令文件视图，不再是普通规则的编辑源。

## 1. 定位与边界

客户端的产品边界是“位置、时机与受众可配置的提示词注入工作台”。工作台负责编辑、展示和提交配置，不重新定义引擎的九个官方插入点，也不把某一个预设能力提升为全局默认。

结构重构遵循以下原则：

- 控件由插件的 `ui/` 统一持有：遵循官方 `docs/ui-radius.zh.md` 与 `packages/client/ui-primitives/README.zh.md` 的用途、尺寸和共享原则，消费主题 alias 与 radius token；不运行时加载 Harness Client 包。业务页面不得复制控件外观，有意差异通过共享组件的 prop 表达。
- 现有 seam 深化：继续使用 SlotRegistry、ConfigForms、official remote/sessions 和 loopback bridge。
- 领域文件归位：工作台壳、数据层、业务 feature、共享 UI 各自拥有清晰的变化原因。
- 最小抽象：只维护实际使用的控件与交互，不复制完整组件库或新增路由、状态框架。
- 确定性行为：保存保护和错误载荷由核心测试验证，键盘、焦点与布局按需在真实浏览器验收。

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
| data/ | bridge、Fields、store facade、保存与纯逻辑 | shared contract、React hooks（仅 hook 文件）、纯 engine `.mjs`（无宿主 import；如 `rule-facts` / `audience`） | React 业务视图、feature 组件 |
| ui/ | 只接收 props/callback 的共享呈现和交互 | React、同层 helper、插件 CSS | store、bridge、data、features、宿主 DOM |
| shared/ | client/host 共用的字段、路径和载荷契约 | 标准 TypeScript | 任一具体 UI 实现 |

跨领域组合只发生在 app/workspace/pages/。feature 可以消费 data 和 ui，但不能通过 feature 之间的内部 import 形成环。相对 TypeScript import 保留显式 .ts/.tsx 扩展名，不新增 feature barrel。

## 3. 当前目录结构

源码路径与分层职责如下，具体文件以仓库为准：

| 路径 | 维护入口 |
|---|---|
| `src/client/index.ts` | 宿主适配、样式与 locale 生命周期、数据 owner 装配 |
| `app/workbench/` | 原生工作台入口、可见性与会话绑定 |
| `app/workspace/` | 工作台壳、页面元数据与跨领域组合 |
| `app/register-rewind.tsx` | 会话回退槽及瞬时结果 owner |
| `data/` | bridge、保存队列、字段与领域草稿、store 端口 |
| `features/` | 模块、规则、人设、模型与工具视图 |
| `ui/` | 共享控件、焦点、定位和交互 helper |
| `locales*.ts` | 同一命名空间的中英文词条 |
| `src/shared/bridge-contract.ts` | client/host 共用载荷契约 |

生成目录 `lib/` 不属于源码 owner，不手工编辑；样式归属见[样式所有权](#10-样式所有权)。

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
4. PromptToolHostApi，提供目录选择、打开路径与当前会话模型等宿主适配。`currentSessionId()` 经 `session-id-source.ts` 读 `ctx.uiSession.adapter.current` 的作用域绑定；当前会话模型经 `session-model-face` 读取并通过官方 `selectModel` 写回。官方会话预设投影与模块主语分离：模块主语由每次读写自己声明，不存在「切换模块」这个动作，因此不调用官方预设切换，也不订阅预设跟随。
5. 创建唯一工作台数据 owner、可见入口状态与手动诊断 owner；数据组件只返回 null，不生成 DOM，未打开工作台时不读取完整编辑数据。
6. registerWorkbenchSlots(ctx, face) 注册左侧主面板、右侧工作台和会话分页；face 只提供翻译与工作台渲染函数。主入口另外通过 `shell.overlay` 挂载无 DOM 的数据 owner，该槽不提供悬浮 UI。

入口不直接导入业务卡片；宿主业务能力由 data/host-api.ts 适配。导航交给官方槽位，不拦截宿主 DOM 点击或使用跨插件私有面板事件。

### 4.2 Slot 契约

| 官方注册面 | id / key | 位置 | owner | 作用 |
|---|---|---|---|---|
| main + sidebar.panellist | prompt-tool | 侧栏 order 60 | register-workbench | 左侧原生导航与完整主面板成对注册 |
| conversation.view | prompt-tool-workbench | order 20 | register-workbench | 当前会话的提示词工具分页 |
| sidebar.right.pane.tab / .title | prompt-tool | keyed | register-workbench | sidebarRightTabs 注册的右侧工作台及标题 |
| shell.overlay | prompt-tool-data | 无可见内容 | NativeWorkspaceData | 唯一插件级数据 owner；不渲染 DOM、图标或抽屉 |

slot 使用 ctx.slots.inject() 等待声明，再调用 ctx.slots.register()。右侧服务通过 ctx.inject 动态等待，其注册与释放归注入上下文；晚到不阻塞另外两个入口。左侧导航与 main 使用同 key，由宿主选择主面板。模块运行总闸只在画布模块侧栏设置，不另设 settings tab。

入口声明 `locale: PROMPT_TOOL_NS`，组件在渲染时取当前语言，不缓存模块级文案。

### 4.2.1 文案归属（locale）

- 用户可见文案统一归 `prompt-tool` 命名空间：zh 常量是唯一事实源，键类型由它派生，en 用 `Record<Key, string>` 强制键集一致；`register` 用官方类型化形式一次注册两种语言。文本量大的 feature 按 `locales.ts` / `locales-params.ts` / `locales-prompts.ts` / `locales-cards.ts` 分区，注册时在 `locales.ts` 合并成同一命名空间，不注册第二套框架。
- 组件树很深，不逐层重建 i18n 上下文：入口组件用注入的 `t`，同一 bind 结果以稳定引用向下传递（页面与卡片按需加 `t` prop）。
- 渲染时才求值（`t('key', params)`），不做模块级缓存；语言切换由 renderer 订阅 locale revision 后整体重渲染跟进。
- 不进字典的内容：provider/model id、文件路径、用户内容、协议 code 与 bridge 错误码；动态拼接用 `{name}` 占位参数。
- 工作台外壳、三个原生入口、模块列表、手动诊断、参数、规则、自定义工具及导入预览使用同一 locale。参数标签按共享键生成 `param.<键>` 词条。用户定义的规则和模块名称保留原值。
- 回退文案和数据层状态提示仍需按实际调用核对，不以目录归属推定词条已迁移。

### 4.3 入口与关闭行为

- 左侧栏由宿主选择同 key 的主面板；会话分页使用槽位传入的真实 sessionId。
- 右侧工作台使用官方 tab 注册，读取 `useTabInfo().tab.visible`，不能用 signal 未中止或组件仍挂载替代可见性。
- NativeWorkspace 将宿主可见性与 document 可见性合并，隐藏时卸载编辑视图；草稿与保存应答保留在独立数据 owner 中。
- 三个入口共享辅助面板、筛选、选中节点、画布视角和滚动位置。统一画布不按主会话/子代理分页面或浏览 key；受众归规则条件及动作声明，各 Slot 不另建编辑 owner。会话分页与右侧槽位直接使用宿主传入的会话，主面板可沿用宿主最后选中的会话。指令文件编辑器按操作会话持有文件版本和草稿，策略沿用工作台共享的版本与队列。页面刷新会释放内存草稿。
- 关闭入口或切页不自动诊断。诊断侧栏提供唯一“诊断一次”动作：规则诊断与当前会话上下文诊断各请求一次；无会话只读规则，并提示上下文不可用。在途不叠发、不补刷、不自动重试。

### 4.4 宿主能力采用面

- 采用：main、sidebar.panellist、conversation.view 和官方右侧工作台；Switch 与状态徽章由插件实现。
- 已满足、无需接入：`host-open-in-app`。`PromptToolHostApi.openPath` 走 `remote.session.openWorkspacePath`，其契约就是宿主交给原生打开器；官方 `ui-open-in-app` 客户端包不提供跨插件服务，只是会话头部的分割按钮。
- 不适用：`ctx.workspaceFiles` 只覆盖 workspace 根，插件的读写路径域是 DSH_HOME（模块）。
- 不采用：`client-resources` 资源 tab 需要自建 provider 与第二个 tab 类型，而工作台已可就地编辑这些文件，重复呈现没有收益。

## 5. 工作台与页面信息架构

### 5.1 可见入口

    左侧主面板 / 右侧工作台 / 会话分页
      └─ 共享草稿与统一画布
          ├─ 左侧模块、诊断、规则或动作条件库
          ├─ 右侧节点属性、指令文件、库条目详情或模块层设置
          └─ 按需打开完整 JSON、规则设置及模板选择

模块运行总闸位于模块侧栏。诊断侧栏显示规则与当前会话的上下文诊断，定位节点后可用“诊断”返回原记录。数据 store 由 WorkspaceStoreOwner 持有，PromptWorkspace 消费其快照，WorkspaceFrame 负责入口外壳。模块内容按显式目标编辑（见 §7.1.1）。

模块的目录物化、复制、删除和参数由本插件维护；模块不进入官方 `agentPresets` 注册表，编辑目标不驱动官方会话预设切换。工具预览及其专用 roster、会话预设投影已移除；默认值 `selectedDefault` / `defaultId` 不参与模块设置。

### 5.2 画布导航、模块与规则

三个入口共用统一画布。左上按钮依次为模块、规则、动作条件库、隐藏、诊断。左栏只通过侧栏控制按钮收起。选择规则或节点、点击画布空白时保留左栏；窄屏可在列表内连续选规则，手动收起后查看所选规则。模块侧栏按名称或 ID 搜索。点击卡片名称打开模块规则，卡内开关单独控制启停。“更多”收纳改名、复制、导出、打开目录和删除。模块被引用或有依赖时由同一删除守卫拦截。各来源导入后统一作为模块读取。

规则列表默认展示参与装配的规则，也可切到全部模块或浏览指定模块。每条规则占一行，左侧名称打开画布，右侧箭头调整顺序。适用的跨模块互斥规则在行内选择赢家。顶栏显示所属模块、规则名和保存状态，规则开关作用于当前规则。规则身份由模块 ID 与规则 ID 共同确定。装配顺序来自 `/module-config-order`，按显式模块读取已声明的 `/rules`。打开规则复用定向读取。

节点库按条件和动作分组，可跨组搜索。点击条目在右栏查看说明和选择目标，明确添加或拖入合法目标才新增节点。条件组和分支通过子节点导航逐级打开，节点删除位于属性栏底部。受众由规则条件和动作声明表达，`else` 表示整体 `if` 的否定。模板保留原受众，原有独立规则各自保留。

底栏提供缩放、适配全图、键盘操作与连线图例。聚焦画布可用方向键平移，聚焦节点时方向键移动节点。打开属性或文件编辑器后，画布基于面板占用后的实际可见空间定位节点或文件卡，尽量保留用户缩放。320 px 首次进入使用可读的局部视角。画布宽度不超过 480 px 时，显式适配会收起覆盖式右栏，保留左栏，并在剩余可见区域显示全图。

选中规则节点时强调全部直接相连的线，包括刚添加并选中的节点。最多八条线同时显示短暂的定向光带，保留条件、成立、否则及同一执行点次序的颜色和线型。切换节点时重新播放，系统减少动态效果时保留静态高亮。指令文件卡独立于规则连线，随画布平移和缩放。

模块改名只修改 `module.yml.name`，使用显式主语与完整定义版本。版本冲突先重新读取，再由用户确认保存。空白模块初始显示名称为“默认模块”，服务端分配 `blank`、`blank-2` 等目录 ID。模块侧栏独立新建或克隆保持未启用。

行内上下箭头交换当前规则与同插入点、同位置的上一条或下一条可见规则，其他条目的排序槽位保持原位。没有可移动目标时，对应方向禁用。`system-section`／`runtime-context` 的卡可跨官方档位排序，官方 order 决定装配初始槽位，先后由 `configOrder` 覆盖（见 `docs/engine-reuse.md` 的「提示词配置插入点与顺序」）。排序走 `/module-config-order`，携带完整启用集合的身份列表和版本。读取或保存期间禁用上下移动。成功后刷新规则版本，失败时显示错误并自动重读一次。页面卸载或装配集合变化后丢弃迟到响应。

规则侧栏常显搜索、范围分段按钮、规则类型下拉框和批量启停。范围切换和层筛选直接作用于列表。批量启停仅变更当前关键词和层筛选共同过滤出的规则启用状态，并立即通过既有规则事务提交；不修改隐藏规则的启用状态、指令文件或模板变量，保留服务端互斥校验，不自行选择互斥组赢家。世界书筛选使用同一份 `ruleFacts.contextActivation`，包含嵌套分支里的 context activation 动作。从卡内字段移焦到批量按钮时跳过该次失焦保存，由批量操作统一提交，避免重复请求或先保存旧状态。只读、读取/保存中、无效字段、远端冲突和空结果时批量按钮禁用。

页面不再常驻“重新读取／校验规则／保存规则／已与模块同步”一行；卡内保存与自动保存沿用规则事务，保存包含校验。规则文本和字段草稿只在离开编辑区或显式保存时提交，输入和停顿不提交；选项和开关立即提交。嵌套菜单通过局部提交通知复用同一卡的事务，启用互斥规则仍单独使用 `activateRuleId`。无效字段、未完成 JSON 与输入法组合中的文本留在草稿，不落盘也不自动删除；新建规则与空规则不因后台读取或保存失败消失。批量操作按可见卡片所属模块分别提交。失败保留对应模块草稿并显示所属模块与就地错误，只在错误时提供重试与必要的丢弃确认。恢复方式由规则编辑器的 `retryKind` / `retry()` 决定，页面不自行猜测：版本冲突后阻止旧版本再次提交，先读取；读失败仍保持读恢复。共享引用（`shared-alias`）与版本冲突同列——先让用户解除引用再重新读取，不重放那一次写。远端内容变化进入 `remote`，保留本地输入，必须显式处理冲突；普通保存失败可以重试提交，已保存但待发布只执行 `refreshOnly`。

宿主能力（`host-control`）的有序选项、切换初始值与诊断通道由 `data/host-control-policy.ts` 统一拥有。能力切换返回新动作并直接清理该动作的 `value` 草稿子树，保留兄弟字段与其他动作草稿；同能力重选不重置值或草稿，未知能力保留原回显与既有读取额度兜底。字段草稿清理复用数据层实现，`RuleFields` 保留既有导出。特殊额度控件和保存时机继续由字段编辑与规则编辑器负责；规则卡仍拥有动作遍历、已保存版本及主语过滤，策略不读取运行状态或触发保存。普通能力扩展只补策略与文案，不在三个消费者另加能力名单，也不将编辑初始值作为引擎运行真值。

人设由普通规则的 `kind: persona` 动作声明，参与规则的来源、启停、条件、受众和排序。`RuleSteps` 通过动作目录提供人设添加入口，`features/prompts/ModulePersonaCard.tsx` 只渲染该动作的受控字段；启用模块的命中人设按既有规则顺序分别拼接 prefix/suffix。统一画布沿普通规则事实展示。

人设字段复用 FormField、MenuSelect 和通用正文输入样式。prefix/suffix 分别选择省略或自定义，省略时正文只读；显式空串阻止继承但不清除其他命中规则的正文。complete/includeRuntimeContext 保留省略、true、false 三态，受众可限定主会话、子代理或两者。所有字段只调用规则动作的 onChange，展开状态、保存、重新读取与发布重试由所属规则卡统一管理。

人设正文唯一归属 `module.yml.rules`，读写沿 `/rules` 的逐规则 CAS 与保存队列；没有顶层 persona 正文、独立来源版本或第二套草稿。旧格式拒绝并提示手工重建，不自动迁移。完整装配预检布尔冲突与同受众 complete 冲突，失败保持旧配装；全部失配或事实不可用时回官方。普通保存只确认 persisted；切片失败或同步重试失败返回的 publicationPending 仍显示恢复入口，refreshOnly 不重写正文。后台运行失败不显示在卡片或其它工作台 UI。这些是状态与交互契约，不代表已完成浏览器实测。

模块启停控制其规则是否参与运行时装配。启用加入本模块贡献，停用撤回后续贡献，保留模块定义、配置和资产。

### 5.2.1 创建入口与过滤的分工

“添加注入模板”通过可搜索的原生对话框选择模板与目标模块。模板列表包含九个插入点的入口，独立于当前层筛选。能力模块与连锁组合在对应层设置中创建；组合以首个能力的主归属层为入口，其跨层装配沿既有配方声明执行。

能力编辑使用显式 `modules` 声明（`facts.declaredModules`），由共享能力目录确定编辑组和显示层。`effectiveModules` 包含全局参数派生能力。规则列表为已声明能力提供右侧层设置入口。明确未声明 `rules` 节时无需读取正文；已声明但未读或读取失败时保持相应状态。筛选与搜索只影响展示，创建后按显式模块及规则身份选中新规则。重复使用模板时仍分配唯一标识。

已启用模块显式声明 `customTools` 且没有工具链规则时，也可从规则列表直接打开工具链设置。显式空清单提供创建入口。只读模块可浏览，模板从画布中的常驻对话框打开，只有选定模块后才读取其工具草稿。

模板直接返回 canonical `RuleDefinition`，创建与复制分配新的规则身份；注入动作不复制旧 `config.id`，由规则 ID＋动作 ID 派生运行身份。受众使用规则级 `if.scope`，固定系统注册的静态目标除外。模板创建绑定选择时捕获的显式 `moduleId`，切换后不能重放；不依赖规则卡 owner、启用状态或先读 `/rules`。

模板目标候选来自用户目录内有效、可写的模块，未启用模块也可选；系统模板、损坏定义与只读目录拒绝。选择模板只复制解析后的规则对象，直接按显式目标调用 `/rules` 的 `createRule`，不保存模板文件引用。缺少 `rules` 的空白模块按空基线在目标锁内完成首写。仅“添加注入模板 → 新建空白模块”在规则成功提交后启用本次新模块，并刷新模块事实；新规则仍为 `enabled: false`，不自动执行。选择已有未启用模块时不改变其启用状态，模块侧栏单独新建或克隆也仍保持关闭。层与搜索过滤由用户控制。

异步创建按最新模块事实验证目标；成功克隆得到的本次新建身份可以直接首写，仍由服务端执行主语、用户目录与可写校验。目录已创建但模板写入失败时保留 `moduleId` 供重试，不提前启用；规则已提交但模块启用失败时明确提示在模块侧栏启用，不以重放创建作为重试。列表刷新失败与保存失败区分显示。模块目录事实刷新不因无关字段草稿正在输入而丢弃，字段本身仍保留原有版本保护。

`module.yml` 与切片提交成功即确认 `persisted`，运行发布在后台合并；切片发布失败仍保留 `persisted/publicationPending`（重试规则见 §7.3）。

模板持久化成功但本地已有未保存规则时，保留本地输入及远端完整响应，返回 `localConflict` 单独提示“模板已保存，先处理规则冲突”，保留原选中规则，也不伪报创建失败引导重复写入。

画布中的分组是 UI 分组，不表示九个官方注入 seam 的运行顺序。九个插入点彼此独立，运行时顺序和参数语义见 [engine-reuse.md](engine-reuse.md)。

`useCustomToolsEditor` 按显式模块维护读取、草稿与保存。右栏直接选择一个工具并编辑字段，空白工具和工具模板从同一设置入口创建。工具模板插入走 `tools-editor` 的读守卫：已读草稿直接插入，未读时按模块读一次，失败写 `draft.error`。加载或读取失败、模块不匹配和只读时拒绝创建并给出提示。工具启停、复制、删除确认及保存沿用原事务，切换入口保留共享草稿。

公共参数由 `EngineParamFields` 按 `ENGINE_PARAM_DEFINITIONS` 与 `SHARED_PARAM_KEYS` 生成，能力存在性来自实际模块事实。字段声明可限定受众；PTC 主会话与子代理分别编辑自己的模式，共享能力开关仍属于同一模块。Git Bash 路径、超时与输出上限、指令提示时机、子代理参与和模板正文也沿用此参数链。模块模型字段写 `layerSettings`，装配期生成受众限定的 request-params 规则。也可编辑显式请求动作。当前会话模型独立走官方 selectModel。枚举使用 MenuSelect，列表使用 TagInput。

### 5.3 状态展示约定

- loading：保留已有数据；只有没有可展示数据时才显示骨架。
- saving：只禁用冲突动作，不冻结其他草稿输入。
- notice：配置保存/校验反馈位于操作区，字段错误用 aria-invalid/aria-describedby 关联；同一结果只由一个 live region 播报。
- destructive action：配置、能力、模块删除以及丢弃文件草稿使用 ConfirmDialog；取消先聚焦、请求中防重复提交，失败保留确认面，关闭后还焦。危险按钮复用共享描边式危险态。
- 长路径与名称允许换行或在展开区提供完整可选择文本，不以原生 title 作为唯一读取入口。
- 配置操作区与列表共用 canvas 滚动根，sticky 高度由自身 ResizeObserver 测量；短视口退回普通流，焦点与定位避开操作区。
- 吸顶操作区自身不画背景：区内每一行都是不透明卡片（模块列表卡、过滤行卡），吸顶可读性由卡片提供；卡片之间的窄缝隙会透出滚动内容，这是不画底板的固有代价。

## 6. 状态与数据流

### 6.1 所有权

| 状态 | Owner | 生命周期/规则 |
|---|---|---|
| 可见入口与会话绑定 | native-workspace-state | 只登记实际可见入口，隐藏右侧 tab 不改变操作会话 |
| 当前顶层页与浏览状态 | native-workspace-state | 同会话跨入口共享；不写 URL 或 localStorage |
| fields、meta、catalog | WorkspaceStoreOwner + usePromptToolStore | 一个插件级 store，非每会话一份；视图卸载保留，有效入口恢复时同步。模块草稿共用，指令正文仍按原 contextId 隔离；浏览状态按会话保存 |
| 模块运行总闸 | 官方 ConfigForms | 规范键 modulesEnabled；关闭卸载贡献，不清盘 |
| 当前会话模型 | session-model-face | 官方 sessions projection 生命周期 |
| 模块编辑目标 | 每次调用声明（bridge 请求头） | 不是客户端会话状态；读与写都由 `x-module-id` 定位目录，写端点另用载荷 `expectedModuleId` 做一致性校验（不选路径），缺声明即无目标，不写部署设置、不决定启用集合 |
| TUI 会话主语 | `/prompt-tool` 命令的用户显式声明 | `module <模块id>` 记在**发起命令的 Agent** 上，内存态、不持久化、不跨会话共享；单条命令的 `module <模块id> …` 前缀覆盖并成为新主语，既不带主语又未声明过即拒绝；插件不猜目标，`src/runtime/tui.ts` 的 `sessionSubjects` 是唯一持有处 |
| filter、search、列表展开、页滚动 | workspace-browse-state | 工作台实例期，配置视图按页面/预设区分；异步资源就绪后一次恢复滚动 |
| 两级变量草稿 | module-variables + 现有变量编辑卡 | 按模块ID+scope隔离；同名覆盖来源来自 effective 快照，迟到响应只回原草稿 |
| 模块参数与全局参数 | param-editor | 工作台内共享 ParamsPort；条目、有效基线、已存键、读取去重与保存应答归同一 owner，原始数字/JSON 输入仍在 workspace-drafts |
| 人设动作 | RuleSteps + ModulePersonaCard + rule-drafts | 正文、受众与三态字段归属普通规则；复用规则身份、CAS、保存与发布重试 |
| 工具、规则动作、原始 JSON/数字草稿 | store.editorDrafts / workspace-drafts | 按预设和字段身份保留；未存草稿或保存中在覆盖导入时按模块拦截（`poolDirty`）；改名迁移、删除清理对应字段 |
| 模块规则与条件/动作字段草稿 | rule-drafts + use-rule-editor | 每模块单一 owner、读取去重、稳定编辑 key；改名/删除保留 previousId；CAS 失败和请求期间的新编辑不丢失 |
| 指令文件正文草稿 | instruction-drafts | 与预设保存队列分离；按指令上下文（`contextId`）隔离，旧上下文迟到响应不覆盖当前视图 |
| 指令文件卡壳与视图 | instruction-editor 投影（壳 + 池 + 策略） | 壳只来自 `/bootstrap` 的指令卡会话段（descriptor 不提供该输入，壳来源过滤在 `instructionShellsFrom`）；`fields.instructionCards` 永远是三者投影的结果，不是编辑源 |
| 导入预览与提交阶段 | use-import-preview-flow | 每次 `run()` 独立生命周期；卸载结束等待、不悬挂 Promise |
| 创建意图、菜单、删除/导入确认、拖拽 | 对应 feature | 仍随页面卸载失效；不恢复或重放危险操作 |
| 模板创建目标与发布结果 | template-rule-writer + rule-drafts | 目标意图归视图，显式 moduleId 写入、声明与结果接纳归数据侧；不依赖 owner/readback。共享草稿保存完整成功响应和发布状态，离页只抑制提示／展开，不丢已提交事实；未启用目标的状态仍仅存工作台会话，启用后沿既有 refreshOnly 重试 |
| 保存队列、revision、草稿版本 | save-queue + store | 独立数据 owner 生命周期，视图卸载不取消已发起保存 |
| 手动诊断快照 | rule-diagnostics-session | 仅诊断侧栏的手动按钮调用既有两类诊断接口；同连接共享 busy、结果与成功时间，重复点击不排队。规则统计沿全仓口径，上下文快照按请求的 sessionId 展示，失败不继承另一会话结果。配置或连接变化只标失效，失败保留同目标旧成功结果；缺少 configs 明确不可用，dropped 非零时显示未保留记录数量。无计时器、打开刷新或自动重试；释放和连接重置后旧响应不得标成当前有效结果。 |
| 大文本和导入原文件 | 文件通道/bridge | 不进入 settings descriptor |

不新增 React Context 来广播整个 store。页面通过 usePromptToolFields selector 订阅窄切片，叶子组件接收显式值与 callback。

模块修改由数据侧 `module-actions` 统一组织创建、克隆、复制、删除、启停、名称写入与后续事实刷新，复用工作台保存队列；读取名称和打开目录不触发重载。页面只负责输入、确认与反馈，不再手写操作后的全局刷新。返回结果区分写入拒绝与已提交后的 `refreshError`；后者只重载事实，不重放修改。既有导入预览／确认保留在导入流程，提交后的目录刷新复用同一入口。

操作后的刷新使用 `/meta` 更新模块事实，不以 `/bootstrap` 覆盖总闸、指令或全局参数草稿。共享序号保证迟到的旧 bootstrap 不回退较新的模块目录。干净的模块参数缓存重新读取，已删除声明节恢复空基线；脏值和原始输入保留，后台参数响应只更新读取期间未编辑的字段。规则缓存只标记需要重读，entries/fields 与冲突状态不清除。

规则操作在入口校验当前编辑资格，用户已发起并进入队列的显式目标保存不因切页取消。已发起的读取、写入及发布响应按共享草稿序号接纳，视图卸载不丢结果，也不让新页面卡在过期的 busy 状态。发布重试同时接纳最新正文与版本：无本地编辑时更新基线，有本地编辑且远端变化时保留输入并进入冲突；不以旧整卡覆盖新输入。模板创建的声明事实、完整响应与发布状态归共享规则草稿，不另建视图级声明缓存；“本次新建”仍是每次选择意图，不跨失败或取消传播到随后选择的既有模块。

业务草稿不写 localStorage，不靠常驻四页保留。工具与规则动作只确认提交快照，保存途中继续编辑仍待存；同预设重挂共享在途状态。干净重挂重新读取远端事实，脏草稿优先保留。

### 6.2 首屏读取与更新

    打开任一原生工作台入口
      -> 激活独立 WorkspaceStoreOwner 并按需 store.load()
      -> bridgeCall("bootstrap") 聚合 descriptor、meta、变量和 promptConfigs
      -> fieldsFromView() 合并 value/base 与 moduleParams
      -> useRuleEditor() 去重读取 /rules，建立正文、settings、variables 的 revisions 基线
      -> /models 按需加载并缓存模型目录
      -> page selector 订阅 fields 引用

bootstrap 是首屏聚合请求，不因筛选或输入字符增加 bridge 请求。模型目录保持惰性加载；筛选、状态筛选和搜索在客户端完成。

同一 bootstrap 请求只解析一次声明的模块目录，描述身份、参数、能力事实、变量与配置投影均来自该目录。未带目标请求头时只返回全局段，moduleParams/moduleFacts/variables 缺席，overrides 为空、templatePreStepCount 为0；不投影默认模块目录。

同一预设的后台刷新同时保护请求开始前已有的未保存提示词配置与模板变量草稿，以及请求期间新增的编辑。保存后同步元数据时，已确认写入的提示词定义不被暂时为空的生成快照覆盖。未填写名称的变量行只在写入载荷中清理，本地编辑行保留；预设身份切换仍按原保存与上下文边界处理。

### 6.3 纯逻辑与 facade

use-prompt-tool-store.ts 是唯一工作台 facade，负责把 ConfigForms mirror、typed bridge、字段快照、保存队列和 feature actions 组合成 React 可消费状态。

**参数编辑生命周期**由 `data/param-editor.ts` 的 `createParamEditor` 持有：模块条目、全局条目、读取集合及读改写协议留在闭包中，页面继续使用既有 `ParamsPort`。值转换复用 `param-overrides.ts`；store 提供当前主语/声明事实、共享保存队列、通知与跨域刷新资格。三个同步入口各保留原语义：bootstrap 快照更新全局参数；普通 load 失效并重读已保留的模块条目；模块操作后的 `/meta` 刷新只重读干净条目，保留参数值与原始输入草稿。模块参数在队列执行时取提交快照，全局参数在入队前取快照；两者均不让旧应答覆盖新编辑。发布失败与其它写端点同形：读共享 `shared/publication.ts` 的 `readPublication`，`refreshOnly` 只重试运行发布。

**资源编辑器的读改写协议**（owner 的共同形状；代码级原语只有 `data/resource-track.ts`，各 owner 分别在 `data/rule-drafts.ts`、`data/module-variables.ts`、`data/instruction-editor.ts`、`data/instruction-drafts.ts` 与 `data/tools-editor.ts`；人设动作属于规则 owner）：

指令文件的池、策略、卡片壳与三条写路径（保存文件、保存策略、重新读取）由 `data/instruction-editor.ts` 持有；会话切换在 `load` 的请求之前调用 `switchSession`，快照回填走 `ingestSnapshot`，`InstructionFilesPort` 的成员只是转发。纯逻辑仍在 `instruction-drafts` / `instruction-policy` / `instruction-cards`。

指令卡的当前 Agent 局部关闭状态是只读投影：命中 `instruction-policy` 规则时显示控制规则并禁用共享开关，不写回 `instructions.yml`；没有真实 Agent 上下文时不显示局部状态。

- **版本捕获**：读时整份存快照，写时从快照取期望版本——rules（含人设动作）逐条 `rules[id]` ＋ `settings`、variables 按 `scope` ＋ `settings`、instructions 逐文件 `revision`、config-order 整表一个。**没有**统一的「版本对象」类型：各家请求形状不同，硬并会造出假共享。
- **最新优先**：草稿/状态上的 `latest` 序号（`beginLatest` 开请求、`isLatest` 判落地）。**晚到应答既不写草稿也不清 `busy`/`loading`**——清理权归最新那次请求，否则界面会停在忙碌态。这也是为什么「迟到时不回滚」是对的，不是漏了清理。
- **发布态**：所有已写盘端点统一读 `shared/publication.ts#readPublication`。普通模块保存只返回 `persisted:true`，确认提交快照后即可继续编辑，不显示待发布提示，也不据此宣称 Agent 已生效；后台发布按同模块 300ms 合并。切片失败或同步 `refreshOnly` 失败返回的显式 `publicationPending`／`publicationError` 仍由 `PublicationNotice` 提示并保留重试。rules（含人设动作）／variables／params／customTools／capability／name／install／clone×2／enable／config-order／delete 使用它；instructions 不触发运行发布，仍走重读与重写。后台失败仅写日志与 `meta.publicationFailures`，工作台不渲染该字段，也不把它并入模块侧栏会显示的 `moduleWarnings`。
- **失败分类**：rules 有 `READ_FIRST_CODES`（rules-conflict／module-changed／shared-alias）＋ `retryKind` 三分类；instructions 有四个冲突码的布尔分类；其它 owner 按 message 落 error。
- **例外保持原样**：config-order 的 `generation` 是闭包变量、外部不可观测；tools（`data/tools-editor.ts`）的草稿是整组工具，没有 CAS 版本，但已按统一判据记录发布态并支持 `refreshOnly` 重试。这两家超出「统一命名」的范围。
- **工具草稿寿命**：保存与发布重试按共享草稿的单一序号接纳结果并清理 `saving`，离页仍更新提交基线和发布状态；通知动态寻址当前 `draft.refresh`，旧卡片只停止提示。保存中读取不发请求，模板插入返回已有失败结果；保存前的在途读取由新序号失效，不能覆盖提交事实。
- **`DraftsPort.editorDrafts` 有意不收窄**：它是 6 个消费者的入口，为「不把整池递出去」造 6 套按族的读数面，代价与收益不成比例。需要改草稿的域各自归 owner（上列五个），新域照 tools 那份样板加一个 `data/<资产>-editor.ts`。

**消费方的依赖面按「端口」声明**：端口定义在 `src/client/data/store-ports.ts`（按域切：模块事实、草稿池、参数、变量、指令文件、规则编辑、模块动作、通知、模型、宿主面），每个端口对应一组同源成员。组件 props、内部 helper 参数与 hook 包装写**端口交叉**（如 `store: ModuleFactsPort & DraftsPort`），不再对 `PromptToolStore` 做 `Pick`——「这张卡需要哪些面」由端口名回答，测试桩也按端口写。判别力仍是单向的：`typecheck` 抓得住"少给端口"或"端口的成员没实现"，抓不住"多要一个端口"，所以只取实际用到的端口靠逐处核对。新增卡片时先在 `store-ports.ts` 找端口，找不到再考虑新端口（而不是回退到 Pick 大接口）。

**切页与离开时保存**：`store.persistBeforeLeave()` 只覆盖全局开关与指令文件；规则草稿由各模块 rule editor 负责并保留原有保存入口。视图卸载后草稿和已发起保存仍由数据 owner 持有，失败保留输入和恢复入口，不以卸载丢弃用户编辑。

可独立测试的逻辑放在以下模块：

| 模块 | 责任 |
|---|---|
| prompt-tool-fields.ts | Fields、默认值、字段级 helper |
| prompt-tool-view.ts | bootstrap/view 到 Fields 的 shape guard 与映射 |
| dirty-state.ts | snapshot、深比较和 reload 判定 |
| param-overrides.ts | params 的列表拆分、条件发送和读回 patch |
| param-editor.ts | 模块/全局参数的状态、读取去重、保存应答、基线与目录同步；store 不直接修改参数条目 |
| rule-drafts.ts / use-rule-editor.ts | 规则单源、稳定身份、原始字段草稿、CAS、模块队列与互斥响应快照合并 |
| template-rule-writer.ts | 模板创建的显式目标、首写和新模块启用编排；规则结果统一交回 rule-drafts |
| module-actions.ts | 模块操作与事实刷新，保留成功结果和刷新失败区别；与规则保存共用队列 |
| instruction-cards.ts | 指令文件卡的壳来源过滤（`instructionShellsFrom`：只认文件身份，非文件卡与非法元素丢弃，缺段按空壳）与视图投影：卡壳 + 草稿池 + 指令策略 → 卡片；正文唯一来源是草稿池，卡壳里过期的 `params.text` / `params.revision` / `params.readStatus` / `params.readMessage` 在投影时剥离，`contentDirty` / `contentConflict` / `contentSaving` 由投影显式覆盖 |
| prompt-config-content.ts | 指令文件卡的 fileId 解析（`origin` 优先；`sourceKind === 'instruction-file'` 时才回退 `params.fileId`）；不再承担正文与写回分流 |
| rule-facts.ts | 规则卡只读事实：typed `ruleFacts` 投影 `engine/rule-facts.mjs` 的受众与 context-activation；未知受众或空集按两个页面都显示，页面不再遍历条件树 |
| prompt-config-order.ts | 配置视图内的同位置判据（`sameConfigPosition`）与一步重排（`reorderToView`）：资格在可移动集合内判、插入位置在完整数组里算；拖拽、上移/下移按钮与拖拽手柄的键盘操作共用同一份实现 |
| use-module-config-order.ts | 跨模块排序摘要、版本读写与请求生命周期（`createModuleConfigOrderSession` 是唯一实现，hook 只把它投影成 React state）；由规则工作台消费 |
| save-queue.ts | 串行保存任务的最小队列 |
| import-files.ts | 浏览器文件导入的纯读取辅助 |
| use-import-preview-flow.ts | 导入的预览→确认→提交流程状态机（预设包与角色卡共用） |
| workspace-drafts.ts | 按模块身份的跨页草稿池：规则（含人设动作）、工具、变量、原始字段与展开状态；`poolDirty` 是「某模块有没有未保存输入」的唯一判据 |
| instruction-drafts.ts | 指令文件正文的独立草稿池与版本基线 |
| instruction-policy.ts | 指令策略的读写、默认值与单文件开关推导 |
| layer-cards.ts | 层卡片的判据：某模块在某层下有哪些卡、各是什么 kind（`param` / `capability` / `missingCapability` / `asset` / `add`）；单卡 kind 互斥、同 id 可出多张卡（参数组与能力行），`missingCapability` 是「未声明、可创建」而非能力补卡；能力补卡层仍由 `RulesWorkspace` 按能力声明计算；标签、搜索文本与渲染归页面层 |
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
- BridgeExtrasMap 端点级**顶层附加字段**映射——与 `value` 平铺的那些键（除 `ok`）**按端点声明**：`bootstrap` 与 `describe` 的字段集**不同**（后者不下发 `meta`／`promptConfigs` 等会话段）。`BridgeResponse<K>` 是「`value` ＋ 该端点顶层字段」的完整成功响应，条件是**条件存在的键标 `?` 并注明缺席条件**（如空主语时 `moduleParams`／`moduleFacts` 整键缺席）；某个键变为必有时去掉 `?`，编译器会指出 host 是否补齐；
- 请求/响应覆盖的编译期断言。

data/bridge-client.ts 提供泛型 bridgeCall(endpoint key, typed body, subject?) 和 bridgeUpload。主语是**每次调用显式携带的实参**（模块 id），没有会话级编辑目标，也不保留上次用到的主语；逐卡规则读写使用所属模块身份。业务组件不得拼接 /bootstrap、/module-delete 等原始路径。新增或改名端点必须同步 shared map、host 注册和契约测试。请求体顶层字段由 `shared/bridge-request-shape.ts` 的 `BRIDGE_REQUEST_FIELDS` 统一拒绝（400 `bridge-request-invalid`，`body:'none'` 端点不读体）；handler 只保留类型、枚举、互斥、身份、版本与读写组合校验，不再手抄字段名单。

**契约字段集 = 运行期顶层接受集**：`shared/bridge-request-shape.ts` 是 39 个端点顶层字段的唯一运行期表，与 `BRIDGE_ENDPOINTS` 编译期覆盖绑定；表值两态：`{ body: 'none' }` / `{ fields }`。所有 34 个 JSON 端点带未知顶层字段一律 400 `bridge-request-invalid` 并点名多余字段，handler 不再保留第二份字段名单。

- 5 个 `body:'none'` 端点（meta、describe、templates、assetUpload、triggers）不解析请求体；其余 34 个 JSON 端点全部由统一表拒绝。`ruleDiagnostics` 是 JSON 端点但无字段，任何顶层字段都会被统一表拒绝。
- handler 只保留类型、枚举、互斥、身份、版本与读写组合校验（如 moduleName 读分支不收写入版本、`refreshOnly` 与写字段互斥、moduleConfigOrder 读写组合）；这些不是「未知字段」，不能交给静态表。
- 字段表只约束顶层字段；嵌套对象（rules edits 及其人设动作、import files 等）仍由域内校验。Agent 导入工具用 `runtime/module-import-tools.ts#IMPORT_TOOL_FIELDS`（排除工具没有的 `sourceId`）；HTTP 导入端点的未知字段由统一表拒绝，`readImportRequestParams` 只做类型与组合校验。TUI 是斜杠命令语法，不硬套 JSON decode。
- 新增字段仍要同时改 `BridgeRequestMap` 与字段表：fields 态双向对齐（表键 ⊆ 类型且类型键 ⊆ 表），none 态要求请求类型为 `undefined`；漏改任一侧 typecheck 失败。表测试保证 39 端点 / 5 none / 34 fields 全覆盖。
- 另有一处契约与实现的错位留档：`paramOverrides` 契约声明 `expectedModuleId?` 而 handler 从不读它（只有归属门读）；`triggers` 已退役（请求类型 `undefined`、410 路由保留）。

### 7.1.1 模块主语策略

`x-module-id` 是**唯一**的目标声明处，`src/shared/bridge-contract.ts` 的 `readSubjectHeader` 把它读成三态：`ok`（合法模块 id）／`absent`（请求头**完全没有**，`undefined`／`null`）／`invalid`（其余一切：空串、纯空白、重复头数组、非字符串、超长、非法字符）。`invalid` 由 `src/runtime/bridge-runtime.ts` 的注册通道（`register` 包装的 route 层）在事务边界之后显式 400 `module-identity-invalid`，**不**降级成「未声明」。以下名单与 `BRIDGE_SUBJECT_POLICY` 同源（`satisfies Record` 强制 39 个端点全覆盖；客户端类型约束与服务端的归属门共用这一张表，桥里不再有第二份端点名单）：

| 类别 | 数量 | 端点 | 语义 |
|---|---|---|---|
| `required` | 6 | `rules`、`moduleVariables`、`customTools`、`moduleCapability`、`moduleName`、`describe` | 没有主语的调用不成立；客户端类型层要求实参，缺主语不发请求直接失败 |
| `optional` | 5 | `bootstrap`（空主语只回全局段）、`moduleDelete`（无声明＝没有在用模块）、`promptConfigs`、`mutate`、`paramOverrides`（空主语＝全局层） | 可省；省略时不带该头，端点按自己的无目标语义处理 |
| `none` | 19 | `meta`、`models`、`modelReasoning`、`templates`、`agentsFile`、`instructionsPolicy`、`triggers`、`assetUpload`、`assetRelease`、`exportModule`、`importModulePackage`、`moduleClone`、`moduleDuplicate`、`moduleOpen`、`moduleEnable`、`moduleConfigOrder`、`toolSurface`、`contextActivationDiagnostics`、`ruleDiagnostics` | 与模块无关，不接受该实参；带上也会被忽略 |

**空主语只有两条语义**：`bootstrap` 的空目标是合法状态，只回全局段（指令文件卡与 session／scope 事实）——`moduleParams`／`moduleFacts` 键整体缺席（不是空对象）、`variables` 缺席、`overrides` 为空、`templatePreStepCount` 保持 `0`；`paramOverrides` 的空主语是**全局层**（存储根 `config.yml` 的 `layerSettings`），不是「没有目标」——全局层解析失败是**可诊断软失败**：`/bootstrap` 与模块装配都按「无全局层」继续（诊断随 `meta.moduleWarnings` 下发、在模块侧栏可见），只有**写**路径仍响亮 400 拒绝，不覆盖用户内容；其余模块类端点没有主语即拒绝——`required` 一律 400 `module-dir-unavailable`（`describe` 也在其中，它的主体就是模块段）。拒绝路径统一用同一个码与同一条文案。服务端只按声明解析目标（`src/host/config-store.ts` 的 `resolveEditDir`／`resolveRequestedModuleDir`），没有声明就没有目标——不回退启用表首项，不替换成包内同名模块。声明面（「`module.yml` 顶层键是否存在」）的**服务端半边已落地**：归属门的第 4 步按 `src/host/module-declarations.ts` 的 `DECLARED_SECTIONS` 判这次要用的节——**读**没声明即 400 `module-not-declared`（定义不可解析时走既有错误码，不算「没声明」），**写**不查声明面（写一个不存在的节就是创建它，写完它就被声明了）。**阶段 3 已实施**：`/meta` 的 `meta.modules[].declares` 下发顶层键名，`/bootstrap` 的模块段按声明出现，客户端按快照只决定**两件事**——①**这次读发不发**（没声明就不发该节的读，发过去也是 400）；②**空内容从哪来**（未声明的节按空渲染，保存即建立该节）。指令文件卡来自会话文件事实。未声明的模块资产可使用创建入口，写入建立声明后刷新 `/meta`。**阶段 4 已实施**：Agent 侧模块工具改吃显式 `moduleId`（`src/host/module-tool-target.ts` 的 `MODULE_ID_PARAM` 与 `resolveModuleToolTarget`），给不出目标即拒绝、不再取装配记录 `[0]`；TUI 的主语由**用户显式声明**（`/prompt-tool module <id>` 记进该 Agent 会话，单条命令的 `module <id> …` 前缀可覆盖并成为新主语，既不带主语又未声明过即拒绝），内存态、按 agent 隔离、不持久化。

**归属判据收在一处门**：`src/runtime/module-subject-gate.ts` 的 `subjectGate(tx, key, { write?, format?, declaration? })` 是唯一的「这次读写属于哪个模块」入口，顺序固定：`required` 且无目标 → 400 `module-dir-unavailable`；写通道目标不在用户模块根下 → 403 `module-readonly`；形状核（`loadModuleDefinition` + `readModuleLayerSettings`，**默认开**）；声明面（`DECLARED_SECTIONS[key]`，三态 `declaration`：缺省查表／字符串显式覆盖要声明的节／`false` 显式跳过，例如 `/module-variables` 的 `scope: 'global'`——全局变量跨模块共享；**仅在有主语、且这次是读时**）目标没声明该节 → 400 `module-not-declared`（写路径 `write: true` 跳过本判据：写会建立该节），定义不可解析时按既有错误路径冒泡；身份两条判据。身份两条**任何情况下都跑**：载荷主语 ≠ 请求头声明 → 400 `module-subject-conflict`；解析目录或载荷与当次目标不符 → 409 `module-changed`。形状核只有 `moduleDelete` 与 `mutate` 显式传 `format: false` 豁免（目标只当身份用：坏模块仍可删、总闸不被挡），豁免只跳过形状核。门由 11 个端点（6 `required` + 5 `optional`）调用，未解析目录的 28 个 `none` 端点不调用。

### 7.2 传输层

bridge-transport.ts 只负责 HTTP/Blob 传输和结果 shape guard：

    成功：{ ok: true, value, ...可选扩展 }
    失败：{ ok: false, code?, message?, conflicts? }

host 侧的边界只有一处：`src/runtime/bridge-transaction.ts` 的事务入口。全部桥端点经它注册，loopback／Origin 校验、只收 POST、32 MiB 上限与 JSON 对象形状在一次请求里由事务完成，端点的 handler 只写业务判断（`tx.record`／`tx.write`／`tx.editDir`）。主语头形状在事务边界**之后**判定（`src/runtime/bridge-runtime.ts` 的注册通道／route 层）：`invalid` 一律 400 `module-identity-invalid` 并终止，与端点自身的 `required`／`optional`／`none` 策略无关；放在 handler 内层是为了不把 403（非 loopback）／405（非 POST）挡在自守边界之前。声明 `body: 'none'` 的端点（`/meta`、`/describe`、`/templates`、`/triggers`、`/asset-upload`）不消费请求流：它们在事务里既不解析也不排空，原始流由端点自己从 `tx.req` 读。新增端点默认继承完整边界，因此拒绝路径的测试面覆盖全部路径，而不是抽样两个端点。

JSON bridge 的统一上限为 32 MiB；原始文件上传独立限制为 64 MiB，避免 base64 膨胀。transport 不解析 feature 数据，也不拥有 Fields。

宿主尚未就绪或路由未注册时，HTTP 层可能返回空体或非 JSON 响应；transport 统一转成 `ok: false` 的可诊断桥接错误（含 HTTP 状态码），不把原生 `response.json()` 异常透传给 UI。

### 7.3 保存保护

1. 全局 settings 保存使用独立队列；公共参数、rules、能力创建/组合创建/移除共享模块保存队列；指令文件正文保持独立通道。
2. 请求使用保存时的 snapshot；成功后只更新该 snapshot 的 saved 基线。
3. 请求期间继续编辑时，当前 fields 与 saved snapshot 不同，dirty 保持为真。
4. 成功后的静默 load 留在预设队列内，且只在全局草稿版本未变化、其他通道无待存草稿、对应草稿仍等于请求快照时执行。
5. 普通规则通过 /rules 自动保存及显式提交，载荷携带 expectedModuleId、expectedRevisions 与 edits[{previousId, rule, settingsChanged?}]。正文编辑只拥有正文，状态改动显式校验 settings；新增、删除、改名也使用 settings 版本。非法 JSON／数字阻止提交，失败保留输入。
6. 参数空字符串/空数组沿用删除键语义；variables 的空字符串仍是合法占位值。详细参数规则见 [architecture-params.md](architecture-params.md)。
7. 模块写入携带 expectedModuleId，模块目标由既有请求上下文解析，载荷身份只作校验。读回失败的工具不降级为空列表供覆盖；跨模块旧草稿拒绝，切换等待保存队列。
8. 模块类读写的目录一律由请求头 `x-module-id` 定位；写端点另在载荷带 `expectedModuleId` 作一致性校验（不一致 400、与当次目录不符 409），载荷不能替请求头选路径；缺头即不发该次请求（§7.1.1），不写 settings、不切换官方会话预设。主语不成立时依赖它的公共参数与模板变量不写盘。逐卡规则事务使用独立模块草稿、显式请求身份与版本，在同一保存队列执行，不受另一主语限制。

9. 指令文件正文走独立草稿池（`data/instruction-drafts.ts`），模块保存与装配集合变化不带文件正文。离开编辑器或显式保存时提交 dirty 文件，输入、停顿与输入法组合期间不提交；保存成功只确认请求时快照。在途新输入仍聚焦时保留草稿，已离开编辑器则在当前保存成功后补交最终值。冲突/失败保留草稿并显示「重新读取」。会话或工作区切换建立新的指令上下文：旧上下文的迟到响应不覆盖当前视图，旧 `contextId` 保存由服务端 409 拒绝。
    指令上下文优先读取存活本地 Agent 的 `session.header.cwd`；浏览尚未恢复 Agent 的历史会话时，使用官方 `sessionPersistence.stat(sessionId)` 只读 header 恢复工作区，不创建 Agent、不读取整份日志。仅会话记录或服务不存在时回退部署 cwd，读取异常按桥端点失败反馈。普通字段草稿在读取期间变化时仍回填指令上下文与文件卡，不以模块或全局参数编辑阻断文件卡显示；文件正文与策略的并发保护保持独立。
10. 指令负责人事实来自 `/bootstrap` 的 `instructions.owner.officialInstructions`：`true` 仅在观察到官方装配时出现，但读协调器观察结果的通道已删除、载荷恒为 `null`（见 [ADR-0009](adr/0009-instruction-owner-observed-only.md)），重建上报链前没有生产者。对规则来源不写 `false`——那是插件观察不到的否定事实，三态因此收敛为「观察到 / 未观察到」。文件可读与官方已装配都不能显示为该文件「已经注入」；官方未装配时插件不补建文件注入。
11. 不再提供「独立指令文件来源」总开关。文件卡启停仅写独立策略 `files[fileId].enabled`，默认放行；关闭只拦截后续官方注入，不撤回历史，重新开启不强制重放。策略不可读时禁用策略编辑，保留诊断；应答成功前不乐观显示已保存。名称与开关跨预设共享，位置、顺序、晋升、受众和模型范围不属于文件卡控制项。
12. bootstrap 与策略快照均读取完成后再应用，异步边界复核请求序号、会话与草稿状态。暂时离开工作区只暂停文件写资格，保留草稿与版本基线；返回并读取时，版本未变可继续保存，版本变化仍须解决冲突。
13. 列表保存按钮等待真实 `Promise<boolean>` 结果；文件或预设部分失败时不显示整体成功、不以静默重载清除错误。已经成功保存的文件立即更新其基线，不因后续失败回滚或丢失确认。
14. 配置排序走 typed `moduleConfigOrder` 端点，服务端校验身份集合与 revision，拒绝未知、重复身份及过期版本。顺序写回 `module.yml.configOrder`。规则行箭头使用完整身份交换两个同插入点、同位置的可见槽位；`system-section` / `runtime-context` 卡的官方档位只决定初始槽位。
15. 两级变量内容校验所选 global/module 域，模块开关校验 settings。草稿按模块+scope分开，切范围不串输入；空字符串保存为值，删行才删除。后台读回和保存只确认对应请求快照，冲突保留编辑。变量值更新不重挂，开关变化只登记后台发布；切片失败或同步重试失败仍可返回 persisted 与 publicationPending，显示“已保存但未发布”。refreshOnly 等待真实发布结果，不重放变量写入；后台运行失败不写入草稿提示。存储边界见 [后端框架](architecture-params.md)。

模板创建沿用同一规则事务，但使用 `createRule` 直接提交解析后的规则对象；不要求规则卡 owner 已加载或先读回 `/rules`。缺少 `rules` 的目标模块按空基线首写，重复创建在目标模块内按规则 id 自动加后缀。三位身份校验仍适用于首写和普通写入：头体冲突 400 `module-subject-conflict`、目标切换 409 `module-changed`、系统或只读目录 403 `module-readonly`。普通保存写盘与切片验证后即回 200 + `persisted`；提交后切片失败仍回 `persisted/publicationPending`，画布与模块侧栏通过同步 `refreshOnly` 恢复，不重放规则写入。未启用目标的该状态只在当前工作台会话保留，启用并挂载规则卡后重试；刷新工作台不恢复该状态。后台运行失败不触发这些提示。

**宿主写盘原语**：进程内同 key 串行由 `src/shared/target-queue.ts#createTargetQueue` 统一（agents-cards、module-package 按目标 key；bridge 两个队列、client save-queue、agent-assembly 是单 key 全链适配；key 由调用方规范化，不同 key 互不阻塞，前一个失败不毒化后一个）。跨进程互斥只在模块类写路径由 `host/module-write.ts#withModuleLock` 提供；agents 文件与客户端队列没有跨进程锁，靠版本复核兜底。

文本 CAS 由 `src/host/versioned-text.ts#replaceVersionedText` 统一「读版本 → 校验 expectedRevision → prepare → beforeReplace 再读并 recheck（可选）→ `host/text-file.ts#atomicWriteTextFile`」；prepare 返回 undefined 或原文相同则不写盘。错误码/status 由各域的 `conflict()` 与 prepare/recheck 提供；原语不接管锁、队列或 publication。承接域：config-store、module-variables、instructions-policy、agents-cards、module-slices（module.yml）；config-store/instructions-policy 仅靠 revision 复核，不额外传 recheck。module-package 的目录安装与 module-config-order 的多文件排序回滚仍归各自域，后者继续走 module.yml 提交路径与 bridge 排序队列。

四类文本编辑复用 `data/use-autosave.ts` 的逻辑焦点、最新回调、输入法与身份清理，不再有输入停顿计时器。规则 identity 绑定模块主语和稳定条目key；离卡通过下一帧确认逻辑焦点，卡内控件及其portal之间移焦不提交。离开编辑区、手动保存及选项提交仍由领域编辑器检查写资格；未加载、忙态、未完成字段和远端冲突继续拒写并保留草稿，不建立自动重试队列。组合输入在失焦后才结束时补交最终值；身份变化取消旧回调。面板关闭早于离区回调时，只兑现同身份、已发生失焦且组合已结束的提交，未离区的卸载不额外写入。后台300ms发布队列不变。

### 7.4 导入预览与提交

导入来源的文件读取、上传、预览、确认和结果共用 `data/use-import-preview-flow.ts`；`ui/ImportDialog.tsx` 只接 props/callback，业务入口注入各自的处理器。原始上传仅写暂存区，所有大小的 PNG/JSON/YAML 和预设 ZIP／文件夹都先预览，确认后才更新目标。协议和边界见 [资产交换](asset-transfer.md)。

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

同一份预览只提交一次，读取与提交期间拒绝重复操作。导入逐份排队，“跳过这份”与“结束本次导入”分开；卸载释放暂存来源，不提交后续项。同名默认另存，覆盖使用现有 ConfirmDialog。导出范围是互斥单选：完整 ZIP／仅定义 YAML；显示资源清单、缺失依赖与需明确决定的历史记忆项。弹窗复用 DialogSurface 焦点逻辑，宽预览只增加 size 修饰，不建立第二套浮层系统。

## 8. 业务 Feature

feature 只拥有自己的视图、瞬时状态、领域纯 helper 和 CSS：

| feature | 责任边界 |
|---|---|
| prompts | 规则卡、人设动作字段、字段策略、排序、模板插入、两域变量编辑；上下文激活只读诊断 |
| models | 当前预设的主/子代理模型路由字段；模型下拉展示完整目录并按服务商分组，选择模型时内部回写 provider + model，不提供独立服务商选择控件 |
| modules | 模块侧栏管理；引擎能力身份、存在性判定及「本层引擎设置」内容装配 |
| subagents | 委派工具、子代理模型路由与采样；不重复嵌入工具面 |
| tools | 自定义工具编辑/保存、参数模板 |

业务 feature 直接使用 data/bridge-client.ts 的 endpoint key；共享控件从 ui/导入。跨 feature 组合由 app/workspace/pages/完成，不在 feature 内建立第二个工作台。

## 9. 共享 UI 与可访问性

### 9.1 共享形态

ui/ 只接收 props/callback，当前真实共享 seam 包括：

- FormField：以非交互的字段名称和 `aria-labelledby` 关联控件，维护说明与错误关联；MenuSelect 转发 id 与 ARIA 到真实触发器，hint 可内联或使用 HintTooltip。名称及名称旁的空白不会聚焦编辑框或打开下拉，控件内部点击和键盘操作保持有效。
- FormField、TextInput、TagInput：设置和字段编辑形态；开关直接复用 Switch，保留 role、aria-checked 与键盘行为。
- ImportPreviewCard：导入预览卡，展示服务端同源转换报告与有损信息（warning/info/被排除条目各自滚动容器）；导入预览共用。
- CanvasChoice：短列表直接选，长列表与分组选项使用可搜索的原生对话框。模板与目标模块选择复用原生对话框。
- MenuSelect：共享单选控件，复用 Button 的尺寸、焦点与禁用行为，支持分组标题与 portal。
- SearchInput：共用搜索输入，保留搜索图标、清空位置和主题焦点环。
- StatusDot：6px实心状态点与3px柔和静态光晕，含success/neutral/danger/warning，语义由相邻文字表达，不使用循环动画。
- StatusBadge：状态点和文字由同一 tone 驱动。模块卡按实际启用及可用状态显示，当前编辑目标单独标记。
- ImportFileButton：隐藏原生 file input 的导入入口。
- DialogSurface：预设操作的 portal 浮层；ConfirmDialog 复用 DialogSurface 的警告对话、初始焦点与还焦能力。确认按钮沿用 `.pillButton[data-danger]`，取消按钮的 ref 承载初始焦点与 busy 还焦。
- anchored-popover.ts / anchored-popover-fit.ts：锚点位置和窄视口适配。
- hint-tooltip-focus.ts / hint-tooltip-position.ts：HintTooltip 的键盘读取与视口翻转定位。
- Menu 在定位完成的可见帧聚焦首个可用项，统一处理上下键、Home/End、Escape/Tab、禁用项及焦点恢复。
- tab-key.ts、dialog-focus.ts：纯键盘索引及弹窗焦点行为。

普通单行输入统一使用 `TextInput`，搜索统一使用 `SearchInput`，操作按钮统一使用 `Button`，下拉单选统一使用 `MenuSelect`，二态开关统一使用 `Switch`。组件只接收原生属性、props 与 callback；尺寸、圆角、禁用、焦点与危险态归共享层，feature CSS 仅持有业务排列，不再把输入样式类传给下拉或搜索。正文与 JSON 使用全宽共享 textarea 样式；TagInput 的内嵌输入、文件选择、radio，以及折叠和导航控件保留各自语义。Tag 的外观直接归 StatusBadge。

官方共享库是宿主功能包的控件通道；本插件保留既有独立打包边界，在自身 `ui/` 提供唯一共享入口，不从宿主源码路径导入或复制到各业务页。

fieldset 禁用时 MenuSelect 同时拒绝 portal 中的选择。Tooltip 的键盘说明绑定实际聚焦目标，Escape 关闭说明。

菜单失焦通过relatedTarget识别自己的触发器/portal条目，跨React portal的焦点归属在下一帧复核；不在focusout微任务中先卸载菜单，以免真实鼠标的click丢失。该回归使用原生pointer按下/抬起，不能仅用element.click代替。

`RuleCard` 提供规则的画布内容与顶栏。左侧规则列表负责选择和排序，画布拖节点只改变浏览坐标。数字和 JSON 原文由草稿池跨浮层切换保留；指令卡自身 portal 内的焦点移动不视为离卡写盘。

模块卡内的选择器、开关及小型文本/数字输入使用紧凑尺寸；大文本和 JSON 编辑器保留 `field-sizing: content`、手动纵向缩放与现有自动测高，不随紧凑控件一起压缩。

规则身份及保存状态常驻画布顶栏，完整 JSON 和规则设置按需打开浮层；节点属性和指令文件在右栏编辑。

结构画布按**条件作用域**投影规则，与引擎的展开语义同构（`engine/branch.mjs#expandActions`）：呈现嵌套条件组、`then`／`else` 与按执行点分区的动作，连线表达所属分支及同执行点内次序，不建立跨生命周期执行管线。点选节点后复用现有字段编辑器在右侧编辑；节点库创建沿原规则草稿与提交协议，不建立第二份行为源。节点坐标、缩放和平移归内存浏览状态，不写模块定义。必要事实未知时两支都可能不执行，UI 不把 else 描述为必然执行。新增动作在**整条规则**范围内分配唯一 id（引擎拒绝重复 id）。

动作的生效条件是**路径合取**：根到该动作路径上所有 `if` 取「且」、`else` 侧取「¬if」，因此不存在「第 i 个条件配第 i 个动作」；卡头提示逐字给出完整生效条件。system-section / runtime-context 的普通文本贡献同样支持嵌套条件分支，在每次 assembly 使用该执行点事实求值；普通 inject-text 的 complete / suppressRuntimeContext 属固定注册效果，仍拒绝动态分支；persona 动作在原 assemble 前准备，支持动态条件。作用域带条件时可选动作按引擎目录的 supportsWhen 过滤，不按规则缺省层禁用整个规则的分支；注入动作的具体合法性由最终配置与执行点校验。JSON 面板的结构门槛同样按「动作要有 `id` + `kind`、分支要有 `then` 数组」递归判定，不把分支判成非法 JSON。规则设置与定义分别按当前抽屉状态挂载，打开的抽屉使用对应操作名称标记。说明使用 HintTooltip，错误保留就地提示。

九层表单直接从基础字段开始，不在字段上方重复展示层名、通用作用说明和层的内部技术详情；实际字段的帮助说明及错误提示保持就地可用。

身份与动作字段按内容宽度排列并自然换行，不设固定 200–240px 列。互斥组输入、范围选择和开关作为相邻单元，均属于规则顶层。范围缺省为本模块；显式跨模块组启用时发送 `activateRuleId`，服务端只在已启用模块和本次目标中关闭同组其它规则；客户端接受整份响应快照，同时保留请求期间的新编辑，不按排序选择赢家。

规则中的字符串名单复用 `TagInput`，在全宽输入框内显示可换行的小词卡，回车或失焦添加、× 删除；输入法组词时不提交。数组按原始条目保存，不经过逗号拼接，字符串形式的既有调用保持兼容。字段名称与动作、条件名称走 locale，工具名、来源标识和用户输入保持协议原值。

`assembly` 使用 `RuleSurfaceFields.tsx` 的专用表单，工具、系统段与运行上下文是可同时启用的三个独立区域；新建种子 `target: {}` 也有完整区域入口，浏览不改配置。工具支持互斥的保留/排除名单、按需解锁的发现工具与名单参数、任一必需工具缺失时保留完整目录；系统段支持保留/移除与追加正文，运行上下文支持按名称移除与追加或清空全部。模式切换只清理与新模式冲突的字段，其余字段原样保留。

`pre-step-filter` 明确区分不限制、严格来源白名单 `sources` 和保留原始消息的增量白名单 `keepKinds`，同时可独立按插件身份 `blockPlugins` 屏蔽。表单只显示字段、模式与控件，不堆叠引擎原理说明。空白名单与未声明仍按引擎原有语义保存。技能目录收窄编辑原有来源白名单，不新增技能装配目标或来源排除能力。

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

`request-params` 编辑调用字段，字符串清空删除 patch 键，数字清空删除键而 0 保留。未知动作或嵌套扩展可在 JSON 中编辑，服务端编译失败保留完整输入；改规则级 `layer` 会改「动作未声明 `config.layer` 时」的运行通道（动作自带 `config.layer` 时只改展示分组与筛选），不清除动作数据。

动态判断在规则或分支的 `if` 编辑；条件树支持 all、any、not、notAny，转换组合保留叶子与未完成字段。组合条件及嵌套动作由画布和右栏逐级导航，删除与转换组合沿原草稿管理。普通注入动作不显示旧 audience/modelScope/promotion；声明式 `subject` / `match` 已随执行链删除，客户端不再渲染这两项。存量字段可能仍留在旧 JSON，客户端不静默删键或把条件提升到同卡其它动作；规则动作路径遇到旧字段按未知键拒绝。唯一例外是固定 system-section 的 complete/suppressRuntimeContext 注册，其 audience 是静态目标而非动态条件。

规则和指令文件使用独立身份与草稿。规则的画布顺序不建立跨插入点的全局执行顺序。

动作与整个分支的同列表上下移动是显式提交点，适用于 then、else 与嵌套列表：最终合法值、新顺序及同模块全部合法脏编辑一次提交，其他模块草稿独立。同模块任意未完成或非法字段、仍在进行的输入法合成都拒绝移动，保留原文与原顺序且不写入；合成结束不会重放移动，须再次激活按钮。移动只清理换位子树的干净位置缓存，沿既有共享草稿与提交 owner 保存，不先失焦保存旧顺序。写拒绝保留本地新顺序，冲突须先重读；落盘成功但发布失败不回滚，重试只发布。在途新编辑继续保留为待保存草稿。

`InjectionPointsPanel` 组合层设置与资产入口。层参数、能力和资产由 `data/layer-cards.ts#layerCards` 派生，交给对应编辑器、草稿池与写端点。选择模块层设置后，右栏直接呈现参数、资产及能力操作。人设在规则动作中编辑。

选中某个注入层且该层没有内容时，列表给「该层还没有内容」的空状态与新增入口，不自动创建九张空卡、也不谎称「无匹配」；`context-activation` 是策略筛选而非层，保持「无匹配 + 清除筛选」提示。

本层设置由 `app/workspace/pages/layer-settings.module.css` 拥有，参数与资产使用平面小节和细分隔线，不叠加分类边框、内缩或分类级折叠。能力创建保留既有入口；模块模型覆盖可通过共享模型字段或显式请求动作编辑。官方当前会话模型直接呈现带标题的字段，委派和变量复用原编辑器的草稿与保存逻辑；人设字段复用 `ui/controls.module.css`，没有独立样式体系。

共享参数短控件按内容宽度排列并自然换行，文本和列表整行；类型由现有渲染属性表达，不复制参数定义。已有主开关与子代理参与开关保留具名字段组和 DOM 顺序，数字使用等宽数字。说明可换行，hidden 优先于布局；控件 DOM 身份包含实例，草稿键与保存入口仍共享。

同名引擎参数绑定同一 `store.fields[键]` 和草稿键，复用字段校验与保存。未完成数字与字段错误随既有草稿订阅同步。界面筛选只影响展示，能力与提示词配置保留各自的保存、排序和删除语义。

指令右栏中的全局 `instructionHint`（指令路径提示）写存储根 `config.yml` 的 `layerSettings`（`/param-overrides` 不带主语头）。有效值的优先级是**模块显式键 ＞ 全局键 ＞ 引擎默认**（存在即覆盖，`false` 也算显式），判据与合并只在 `src/host/module-params.ts#resolveModuleParams` 一处；模块总闸关闭或全局值尚未读回时禁用。指令正文仍只允许原文件正文编辑，普通注入参数继续锁定，文件级启停仍写独立策略。

`ContextActivationDiagnosticsCard` 呈现诊断侧栏的上下文分区。手动动作按真实会话读取一次，挂载和筛选均不请求。自定义工具编辑器按 `custom-tools` 编辑组归入 tool-pipeline 层。面板关闭后，未保存的资产与字段由共享草稿池保留。

搜索统一覆盖「中文名 + 技术键」，且只影响展示：规则按自身定义及层设置匹配，真实层装配通过既有 `matchesEditorGroup` 与分组标题判定设置匹配，匹配时保留同层承载实例。没有实例的层不会因为设置命中而生成卡片。批量启停作用于当前可见规则集合；旧快捷参数的 `fieldSources` 不再锁定规则或排除其编辑能力。清空搜索恢复原列表，不创建配置或保存。

变量卡复用同一编辑器切换 module/global；文本离开编辑区时保存，模块开关立即保存，删除仍走原变量事务。空变量名是待编辑草稿，不自动提交、删除或隐藏；命名完成后空字符串值是合法值。变量行身份不随名称输入变化，数字名称也保留编辑中的显示顺序，避免对象枚举重排或重挂导致焦点错移；值仍由原草稿拥有。范围切换先尝试提交原范围有效草稿，各范围未完成草稿继续独立保留。全局写提示影响同安装其它模块。同名覆盖来源由快照显示。普通规则的变量由用户手动建立，ST 导入才自动登记缺失裸引用为空占位。当前会话 selectModel 单独按官方 selectable 决定可用性。

引擎参数文本失焦后保存，数字先按共享参数定义校验，无效值保持原始草稿。人设正文与选项由所属规则的保存队列、CAS 和草稿生命周期管理，没有独立续存或来源写入。输入法确认后仍在编辑区时不提交，切换编辑身份取消旧回调；离区提交沿共享草稿处理。指令文件正文离开编辑器时提交；文件读取失败、版本冲突和上下文失效继续拒写。发送消息不等待自动保存；运行时使用已落盘有效内容，不将输入框草稿直接注入。

子代理工具策略卡（`subagent-tool-policy`）及其端点、草稿已退役，原因见 [ADR-0008 的退役注记](adr/0008-module-slices-memory-assembly.md)。

层设置区展示模块实际装配的能力（`modules` 声明、参数与行配置隐含补齐），按主归属层分组：清单里每项是能力 id 与「移除能力」入口（二次确认），没有「编辑行为」这类选择控件（能力编辑统一走各卡自己的编辑区，归属由卡片决定，不选模块）；能力自身的参数在同一设置区的参数分组里编辑，新能力从本层创建入口添加。`modules: []` 不展开默认骨架，官方组合行不生成插件能力条目。二次确认移除是完整移除：模块声明、该能力的显式参数与行配置（拥有顶层段的能力连数据段）一起删除，提交后登记后台发布并刷新模块事实。

每份已发现的指令文件（包括 `AGENTS.md`、`CLAUDE.md` 及其 `.local` 变体）各有独立画布卡，可用鼠标或键盘打开右栏。切换文件保留所选规则及浏览状态，无规则时仍可编辑。文件正文写回原文件，名称与启停写入 `$DSH_HOME/.prompt-tool/instructions.yml`。可显式保存，离开编辑器时也会尝试保存，磁盘版本冲突保留草稿并提示重新读取。文件授权、会话白名单、版本校验和读取失败保护沿原通道执行。文件卡独立于模块正文、规则连线和排序。

「指令提示」统一使用 `strategy: placeholder` 与 `fill: instruction-hint`，不提供独立旧策略或保存时转换。模块级 `instructionHint` 继续默认关闭，启用时在逐文件过滤后转换符合条件的官方消息，不做逐文件全文／提示模式。默认组合为 `promoteOn: either`、`includeSubagents: true`：主会话与子代理首请求保留全文，首次工具调用或助手消息后转为路径提示；成功压缩后重新经历全文与晋升。转换只影响待注入消息，不改已入历史的正文；其他启用模块的转换设置独立生效。指令文件正文与策略分别由原文件和独立策略文件持有，官方内容无法可靠分段时原样放行并诊断；开关不表示停止文件读取或删除历史。客户端直接消费当前插件下发的完整层元数据，不为旧宿主补字段；bootstrap 返回前使用空加载快照。**层清单有两份，用途不同**：`layerOrder` / `layers` 是九层，供视图筛选、层卡片组织与规则级 `layer`；`injectionLayers` 是可注入的六层（agent-request、llm-stream、tool-pipeline 仅由各自动作执行），只给注入动作的 `config.layer` 下拉（`RuleFields` 按 `:config` 前缀取它，其余 layer 下拉仍取九层）。两份清单同源于引擎 `LAYER_DEFINITIONS`，客户端不另写一份层表。

通用文本条件提供可选 minChars/maxChars 开关，启用后才写入含端点的非负安全整数；关闭删除键与该字段草稿。展示示例不会固化长度默认值。关键词与长度可独立或合取使用，分类正文通过普通分支与静态注入编辑；stream-output 使用 pass/replace 选择器及正文输入。工具可见面的受众归 scope 条件，首轮提示用普通注入动作，不提供专用 notice 开关。

tool-catalog 填充来源沿现有普通注入表单编辑：params.action 引用同规则工具可见面动作，text 使用只读 RESIDENT_TOOLS / DISCOVERY_TOOL 自动列出**当前可见**的常驻工具与发现工具；观测不到工具面时回落声明名单，观测到工具面但一个常驻名都不在时跳过提示。名单仍由被引用动作拥有，不在提示卡维护第二份。

工具预览页面、`ToolSurfaceView` 与专用 `/tool-surface` 请求已移除；实际工具授权、tool-gate/tool-visibility 动作、自定义工具编辑及官方会话预设切换不受影响。

### 9.2 Tabs

所有 tablist 遵循自动激活模式：

- 当前 tab 的 tabIndex 为 0，其余为 -1（roving tabIndex）。
- ArrowLeft/ArrowRight 循环移动；Home/End 跳到首尾。
- 选择后把 DOM 焦点移到新 tab。
- tab 拥有稳定 id 与 aria-controls；panel 使用 role=tabpanel 和 aria-labelledby。
- nextTabIndex() 保持无 DOM 的纯索引算法，并由 Node test 覆盖空列表、无效索引和非导航键。

### 9.3 Dialog、表单与排序

- 模板和目标模块选择由 `CanvasChoiceDialog` 调用原生 `showModal()`，搜索框获得初始焦点，支持 Escape、外点关闭和焦点恢复。其余仍使用 `DialogSurface` 的确认与管理操作沿用 portal 和各自的焦点处理。
- 工作台是宿主原生页面，不声明模态语义或圈住整页焦点；必要的业务弹窗仍由共享 DialogSurface 管理焦点循环。
- 弹窗只操作自己的 ref，不查询宿主页面结构。
- 数值输入在提交点解析，草稿期保留字符串，避免输入中间态跳动。
- 规则排序使用支持鼠标和键盘的上移、下移按钮，按钮名称包含方向及目标规则。
- reduced-motion 下关闭平移和过渡；focus-visible 必须清晰。
- 工作台壳限制内容溢出，程序化定位只滚动 canvas；窄侧栏按容器宽度使用单列与自然换行。

### 9.4 模块参数命名与说明

- 可见参数名使用简洁简体中文，优先采用 2-6 字的领域名称；不在标签中显示内部键名、英文枚举或括号实现说明。
- 内部键和值、bridge 载荷和 module.yml 保持英文契约；下拉选项通过中文映射展示，未知旧值仍回显原值，不能因汉化丢失编辑能力。
- 布尔参数使用正向短名称，例如「独占」「互斥」「动态运行时上下文」；名称位于开关上方，与输入框和选择框保持相同字段节奏。
- 字段说明统一经 `ui/HintTooltip.tsx`。组件只复用宿主 Tooltip 的视觉 token、内边距、圆角、字号与淡入效果，不调用宿主 Tooltip 的定位实现。
- HintTooltip 通过 `body` portal 与 `position: fixed` 定位：鼠标悬停延迟 500ms 后在指针附近显示并随指针移动；键盘聚焦即时读取控件 `getBoundingClientRect()`，紧邻控件显示（鼠标点击产生的聚焦不锁定说明，失焦后回到悬停延迟）；视口边缘自动翻转或收敛。
- `HintTooltip.module.css` 使用宿主 `--dsw-alias-tooltip-bg` 和静态前景 token，并与宿主尺寸一致；背景混入工作台底色以降低透明度。业务组件不得再使用原生 `title` 或自制 `data-tip` 伪元素。
- 字段错误、只读警告、保存状态和空状态不是帮助说明，继续就地显示，不藏入 Tooltip。
- 系统提示段动作保留显式参数；`RuleSteps` 的 persona 动作由 `features/prompts/ModulePersonaCard.tsx` 呈现受控字段，只修改所属规则草稿，沿 `/rules` 事务保存。prefix/suffix 分别支持省略与显式空串，complete/includeRuntimeContext 保留省略、false、true 三态；受众可选主会话、子代理或两者。没有独立正文、来源下拉或版本 owner。字段按内容宽度排列，窄容器自然换行。

默认身份接管复用人设动作的 `stripDefaultIdentity` 字段与规则卡：启用意图来自规则定义，可用性来自诊断侧栏手动取得的 `/rule-diagnostics` 装配观测快照，不在打开工作台时自动刷新。观测不持久化，显示最近成功时间；只接纳当前目标、已保存版本且无正文草稿变化的结果。成功来源发布及释放使旧身份观测失效，启停哈希回环也需重判；按动作和真实 Agent 记录，正常未选分支不抵消有效成功，实际失败保持可见。关闭和未经验证不显示成功，匹配失效不冒充条件缺事实计数；中英文同步。

结果片段沿 `RuleParameterFields` 的 `tool-result/action: edit-text` 编辑，`edits` 使用原JSON字段；装配替句的候选数组沿 `RuleSurfaceFields` 使用JSON字段，保留逗号、换行及空替文，不转成标签列表。切到edit-text清理互斥的顶层text及草稿，初始match/text留空；切回其它模式清理edits及草稿，accept不补造text，replace/block沿原空正文编辑。非法或未完成JSON继续留在同一fields池并阻止保存，不影响读取额度的实际值、继承空值与Tooltip。结果规则的 `tool:results` 诊断复用RuleCard当前目标与已保存definitionRevision过滤；旧版本或未保存草稿不显示为当前成功。界面开关表示启用意图，不保证early或真实结果owner就绪；浏览器与CLI/Web真实验收另行统一执行。

## 10. 样式所有权

人设卡的官方指令预算通过原FieldContext传给RuleParameterFields；数字原文及错误保留在同一fields Map，非法或未完成输入阻止原规则保存，切回继承清除对应字段。预算启用与运行可用性分开，实际接缝/owner缺失不能因草稿保存成功显示能力成功。

样式使用 CSS Modules 和 DSH 语义 token，当前 owner 为：

    app/workspace/PromptWorkspace.module.css
    ui/controls.module.css
    ui/HintTooltip.module.css
    ui/ImportDialog.module.css
    ui/Menu.module.css
    ui/SearchInput.module.css
    ui/StatusBadge.module.css
    ui/StatusDot.module.css
    ui/primitives.module.css
    features/prompts/prompts.module.css
    features/prompts/rules.module.css
    app/workspace/pages/layer-settings.module.css
    features/tools/tools.module.css

约束：

- 组件移动时同步移动其独占 selector；共享 selector 必须对应稳定的真实共享形态。
- 主题颜色只使用 `--dsw-alias-*`；普通控件圆角复用官方 `--dsw-radius-*`，字体、间距和动效由插件共享层持有，不复制宿主静态色板，不写 :root 主题。窗口 chrome 避让继续消费官方布局公开的 `--dsh-*` 几何变量，不读取宿主 DOM。
- 整条窗口标题栏和面板几何由宿主持有，原生工作台填充槽位，不自建覆盖聊天区的抽屉。业务模态遮罩继续消费 `--dsh-frame-chrome-top`，内容不重复累加标题栏高度。
- feature CSS 不选择宿主 class、id 或页面结构。
- 中性平面边框使用 0.5px；必要的业务浮层用 alias 颜色组合自有阴影，不叠加无意义的中性 border。
- 圆形和胶囊与 corner-shape: round 配对。
- 动画提供 prefers-reduced-motion 分支；不新增组件专用全局滚动条规则。
- 工作台的各面板持有自身间距，避免空容器叠加布局间距。
- 不为减少文件数把不相关领域重新合并，也不先复制旧 selector 再长期双写。

## 11. 性能与行为不变量

- useSyncExternalStore 的 snapshot 在值未变时复用引用；usePromptToolFields selector 只通知真正变化的 fields。
- 不把 store 放进 Context 触发整树广播；只在有实测收益时保留 memo 和稳定 callback。
- 首屏使用一次 bootstrap 聚合；模型目录惰性加载并缓存。
- filter/search 只在客户端运行；不引入虚拟列表、dynamic import 或 code splitting 来解决尚未出现的规模问题。
- UI 分组不建立九个插入点的全局执行顺序；配置序号控制对应插入点、位置内的次序，官方定位 `order` 独立保留。
- 规则排序视图每次渲染只匹配一次可见身份集合；各卡复用该结果，再沿 `sameConfigPosition` 选择可移动项，不逐卡重复遍历身份列表。
- `system-section` / `runtime-context` 卡可跨官方档位排序：`sameConfigPosition` 只要求同层同位置；跨档位先后由 `configOrder` 覆盖，装配后回填（见 `docs/engine-reuse.md` 的「提示词配置插入点与顺序」）。「插入到官方位置…」仍只改初始槽位。
- order 的官方刻度只出现在 `system-section` 与 `runtime-context` 两层。数字输入与「插入到官方位置…」共用同一 NumberField 草稿和接受值路径；选择快捷位置同时更新数字、清除该字段错误，不改其他草稿。区段之前使用 `from - 1`，全部之后使用 `max(to) + 1`，避免同值按名称排序导致位置不符。边界来自 bridge 的 `meta.officialOrders`；缺席或空表时只保留数字输入。其余层只显示层内顺序说明。
- 规则编辑直接使用画布 surface。列表与节点库置于左栏，属性置于右栏，JSON 与规则设置按需打开。未显示面板不进入 Tab 顺序；字段草稿、完整版本校验与错误恢复仍由原编辑 owner 持有。
- 当前会话模型始终读取官方 sessions projection，切换始终走 official session.selectModel。
- 未启用的可选模块保持 opt-in；生成结果、preset 优先级和 bridge 载荷不得因 UI 重构改变。

## 12. 测试与验证

### 12.1 契约测试

常驻套件只覆盖核心行为；新增用例按 [项目测试准入](../AGENTS.md#测试准入) 判断，不按功能目录补齐测试。

| 核心行为 | 覆盖位置 |
|---|---|
| 规则执行、主子隔离与生命周期 | `test/engine/rules.test.mjs`、`test/host/agent-assembly.test.mjs`、`test/host/tool-step-assembly.test.mjs` |
| 写盘、导入导出、冲突与私有数据保全 | `test/host/module-rule-tools.test.mjs`、`test/host/module-file-tools.test.mjs`、`test/host/module-package-*.test.mjs` |
| 请求和文件路径安全 | `test/shared/bridge-contract.test.mjs`、`test/host/instruction-scope-guard.test.mjs`、`test/host/agents-cards.test.mjs` |
| 保存失败、迟到响应与回退 | `test/client/*-editor.test.mjs`、`test/client/module-variables.test.mjs`、`test/client/rewind*.test.mjs`、`test/host/rewind-bridge.test.mjs` |
| 安装图、入口与分发完整性 | `verify:host`、`verify:pack` |

测试使用最小自建模块，不固定内置模块名称、数量、正文或默认行为。已有核心用例覆盖的风险不再分层重复测试；类型、字段字典、导出与资源分发交给对应检查。

类型检查分为 `tsconfig.json`（`src` 非 client）、`tsconfig.client.json`（`src/client`）与 `tsconfig.test.json`（`test/fixtures/**`）。测试夹具目前仅保留 `host-harness.mjs`，通过 `allowJs`/`checkJs` 检查其端口类型。

继续使用 Node 内置 runner，不引入新的测试框架或渲染模拟器。UI 文案、静态渲染、DOM/CSS 结构及字段穷举不进入常驻套件；交互和布局改动按需在真实浏览器核对。`§12.2` 的命令只验证自动化边界，不代表桌面体验已验收。

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

自动化检查不替代真实浏览器和桌面交互验收。

## 13. 维护清单

新增客户端能力时按以下顺序检查：

1. 先确定 owner：宿主适配放 index/data，跨页组合放 app，单领域行为放 feature，共享呈现放 ui。
2. 若新卡要读 store，先在 `src/client/data/store-ports.ts` 挑端口并在 props 上写交叉；同一画布按规则条件与动作声明呈现受众。
3. 若涉及 bridge，先修改 src/shared/bridge-contract.ts，再同步 host 注册、client 调用和契约测试。
4. 若涉及 Fields、参数或保存，先核对 [architecture-params.md](architecture-params.md) 的空值、优先级和写盘语义。
5. 若涉及引擎层或插入点，核对 [engine-reuse.md](engine-reuse.md)，不要用 UI 顺序推导运行时顺序。
6. 若涉及 SillyTavern、角色卡或世界书，遵循 [SillyTavern.md](SillyTavern.md) 的转换契约。
7. 新 selector 必须有明确 CSS owner；新交互必须同时考虑键盘、焦点、错误和 reduced-motion。
8. 新增或改造面向用户的文案时，同步更新 zh/en 两份字典；改动结构、接线或发布面时，按 §12.1 的 seam 表跑对应契约测试。
9. 完成 typecheck、lint、test、build 和 diff --check 后再提交；不要停止或重启当前 DSH 服务。

本文是客户端结构的长期权威文档；本地 `.scratch/<feature>/` 跟踪当前规格与票据，稳定结论沉淀回本文及对应领域文档。
