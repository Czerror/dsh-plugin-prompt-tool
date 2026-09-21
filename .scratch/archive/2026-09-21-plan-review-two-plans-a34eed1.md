# 两份 2026-09-20 计划实施结果复审 PLAN

## 需求与授权

> 实施授权补录（2026-09-21）：用户要求「根据.scratch\\plan\\2026-09-21-plan-review-two-plans-a34eed1.md执行修复」，已授权以下全部候选修复。原审查阶段的授权边界和反例保留为历史记录；本轮实施与验收见[修复 PLAN](2026-09-21-plan-fix-review-findings-bd5ea6f.md)。

- 日期：2026-09-21；本轮建计划基线：`dev / a34eed1c0957f7c10764376497a7c0bb13b0fad9`。
- 用户原始要求：`审查25f70d1de4f45813c0bc234a804f2b5605e205b9 以来的所有提交,对照两个2026-09-20 的plan`；中途要求 `继续任务`，随后明确 `应该把审查结论创建为新的plan`。
- 固定审查范围：`25f70d1de4f45813c0bc234a804f2b5605e205b9..a34eed1c0957f7c10764376497a7c0bb13b0fad9`，共 14 个提交、67 个变更文件。`git diff 25f70d1...a34eed1` 的共同祖先就是所给基线，基线自身不计入新增提交。
- 规格来源：[引擎复用与九层归一计划](../archive/2026-09-20-plan-engine-reuse-a7c80bc.md)、[引擎设置嵌入实例卡计划](../archive/2026-09-20-plan-embed-layer-settings-7d78e77.md)。后计划覆盖前计划的独立能力卡布局要求，不把被取代的布局当作当前要求。
- 已授权：只读审查、隔离验证反例、创建本轮唯一新 PLAN、追加忽略的本地项目日志，按仓库约定验证文档、提交并推送 `origin/dev`。
- 未授权：修复源码、改变配置或运行行为、安装依赖、修改宿主、启停运行中的 DSH。审查发现不等于实施授权；下列修复 Wave 均为候选，须由用户指定范围。
- 两份旧归档保持原样。本 PLAN 在候选修复尚未选定和完成前留在 `.scratch/plan/`，不归档。保留用户原有未跟踪 `skills/` 目录。
- 格式和交付规则：[PLAN 格式规范](../../docs/agents/plan-format.md)、[仓库规则](../../AGENTS.md)。

## 审查结论

**两份计划不能按当前实现判定为全部完成。** 规范轴确认 2 项 P2；需求轴确认 6 项（P1 1 项、P2 4 项、P3 1 项）。8 项均由主线程运行反例确认，按轴分别列出，不以一个轴的通过掩盖另一个轴的缺口。P1 为优先修复，P2 为功能或验收缺口，P3 为较低影响的界面不一致。

### 规范轴

#### N1 · P2：工具创建动作依赖设置区挂载，重复操作丢失

- 位置：[MainSessionPage:83](../../src/client/app/workspace/pages/MainSessionPage.tsx#L83)、[SubagentPage:67](../../src/client/app/workspace/pages/SubagentPage.tsx#L67)、[EngineLayersPanel:249](../../src/client/app/workspace/pages/EngineLayersPanel.tsx#L249)。
- `c26651d` 把唯一创建意图消费者 CustomToolsCard 搬入懒挂载设置区，页面仍仅调用 `setToolCreate`。默认「全部」视图没有工具链实例卡或未展开设置时，没有组件消费创建意图。
- 真实 Edge 反例：在「全部」视图点击两次「新建空白工具」，工具编辑器数为 0、工具草稿数为 0；切到具体工具链空层后仅产生 1 条工具草稿，前一次意图被后一次覆盖。尚未消费时切页也会丢失该动作。已有工具草稿存于共享池，本项不等于所有草稿在卸载时丢失。
- 违反：[UI 创建/生命周期约定](../../docs/ui-architecture.md#L291)和[编辑器状态保持约定](../../docs/ui-architecture.md#L515)；后计划 T4/T5 要求保留创建入口及原编辑行为。
- 最小方向：由常驻页面或工具草稿所有者立即消费创建动作，显示和展开不决定动作是否执行；保留用户的筛选和搜索，不用自动切层掩盖问题。

#### N2 · P2：统一搜索没有接入新设置区

- 位置：[EngineLayersPanel:313](../../src/client/app/workspace/pages/EngineLayersPanel.tsx#L313)、[PromptConfigList:146](../../src/client/features/prompts/PromptConfigList.tsx#L146)、[无匹配分支:450](../../src/client/features/prompts/PromptConfigList.tsx#L450)。
- 新装配入口接收 `keyword` 却不消费；列表只搜索配置实例的元字段及局部参数键。搜索没有匹配配置时，兜底设置容器也被「无匹配」分支遮掉。
- 真实 Edge 反例：普通工具链实例 `pipe-a`，已装配深思门，搜索 `deliberationMinChars`，结果为「没有匹配」，配置卡和设置区数量均为 0。目标参数存在却无入口可编辑。
- 违反：[统一搜索契约](../../docs/ui-architecture.md#L517)、前计划前端交互/验收要求、后计划需求第4项的搜索语义保持。
- 最小方向：真实层设置使用已有编辑组匹配函数；匹配参数或能力时保留对应实例或兜底入口，并定位到匹配内容，不增加另一套搜索服务。

### 需求轴

#### V1 · P2：投递缓存混用两种身份，热路径与恢复结果不一致

- 位置：[executor:106](../../engine/executor.mjs#L106)、[alreadyDelivered:117](../../engine/executor.mjs#L117)；由 `54bac00` 引入。
- `confirmDelivered` 将 `source.plugin` 和 `source.kind` 的字符串写入同一 Map 键空间，读取时也不区分字段，而持久扫描分别比较这两个字段。
- 运行反例：配置 first 的 `sourceKind=second`；第二配置 `id=second, sourceKind=other`，只有输入 LATER 才命中。第一条确认投递后，热路径误认为第二条也已投递，只返回用户消息；同一持久日志重挂后正常发出第二条。实际未注入的正文被静默遗漏。
- 未满足：前计划 T2/R1 的来源身份保持、真实接纳去重和恢复一致性。
- 最小方向：缓存键保留身份字段命名空间，或分别记录 plugin/kind，确保与持久扫描的比较规则完全一致。

#### V2 · P1：ST 条件副作用仍可从官方组装路径绕过

- 位置：[st-render:89](../../engine/st-render.mjs#L89)、[系统段调用:25](../../engine/layers.mjs#L25)。
- T3/R2 只在 pre-step 向 ST 渲染器传入 eligible 集合；官方系统段先组装时未传该集合，回退分支仅检查可见性和晋升，仍会预求值不满足 match 的 pre-step 静态 setter。缓存后的污染帧又被后续 pre-step 复用。
- 运行反例：pre-step setter 匹配 NEVER，正文赋值 `x=BAD`；另有系统段 reader 与 pre-step reader。纯 pre-step 对照读到 EMPTY；先调用已安装官方 `SystemPrompt.assemble` 后得到 `SYS[BAD]`，随后 pre-step reader 也读到 BAD。条件未满足的模板已改变最终注入内容。
- 未满足：前计划 T3/R2 的「资格先于副作用」「未命中 setter 不改变量」及跨层行为保持。新增 R2 用例只有两个 pre-step 配置，没覆盖宿主先组装系统段的顺序。
- 最小方向：所有 ST 求值入口使用一致的资格事实；尚未完成条件判定的 pre-step 模板不能在官方组装的回退分支提前执行赋值，同时保留合法跨层变量帧。

#### V3 · P2：受管来源说明与真实覆盖优先级不符

- 位置：[managed-config-fields:33](../../src/shared/managed-config-fields.ts#L33)、[PromptConfigFields:355](../../src/client/features/prompts/PromptConfigFields.tsx#L355)、[writer 合并:475](../../src/host/write-preset.ts#L475)。
- 新映射只凭 ID 把 near-anchor/router-guide 标成预设级参数的唯一投影，界面锁住局部参数。但[在线重建](../../src/index.ts#L141)把原始 `spec.promptConfigs` 又作为最高优先级交给 writer，覆盖前面计算的模板投影。
- 隔离真实 writer 对照：`firstTurnText=GLOBAL`，不传配置覆盖时产物为 GLOBAL；传显式 `near-anchor.params.text=LOCAL` 时产物为 LOCAL。界面却指向可能不生效的全局来源，隐藏真正有效的局部编辑入口。
- 归因：基线已有按 ID 锁定局部参数；`78705db` 新增共享来源表和说明，没有按计划纠正旧假设。本项是计划未完成，不宣称本轮新引入数据丢失。
- 未满足：前计划「真实多来源按现有优先级展示」「host 产生来源绑定」「保留合法显式覆盖」及 T15 的来源核验。
- 最小方向：由 host 根据最终合并来源区分受管投影和显式局部覆盖，保留后者的编辑入口，不为使说明成立而强制全局覆盖所有同名配置。

#### V4 · P2：只读预设的变量和预设模型仍可编辑

- 位置：[资产装配:233](../../src/client/app/workspace/pages/EngineLayersPanel.tsx#L233)、[变量接口:65](../../src/client/features/prompts/PromptConfigsEditor.tsx#L65)、[模型控件:138](../../src/client/features/models/ModelRouteCard.tsx#L138)。
- persona/工具/策略收到 `canEditPreset`，变量和模型没有；变量组件没有 disabled 参数，模型组件只检查 writePreset。
- 真实 Edge 验证：`moduleFacts.editable=false` 且 `writePreset=true` 时，变量名称、预设模型采样温度控件的 disabled 均为 false。用户可改本地草稿并进入最终会失败的保存链。
- 这是旧缺口在本轮仍未按后计划 T4/T5 的只读禁用验收补齐。完整测试中的后端 system 拒写仍通过，未发现越权落盘，不标为新增安全漏洞。
- 最小方向：透传真实可写性给变量及预设模型控件；当前会话 selectModel 继续作为独立操作，不随预设可写性一并关闭。

#### V5 · P3：没有引擎参数的层仍出现空设置区

- 位置：[列表传入回调:349](../../src/client/features/prompts/PromptConfigList.tsx#L349)、[表单容器:231](../../src/client/features/prompts/PromptConfigForm.tsx#L231)。
- 所有实例都收到设置回调，表单只检查回调存在；`hasLayerSettings` 仅控制空层兜底。真实 Edge 展开 llm-stream 卡后存在「本层引擎设置」空壳，内部控件数为 0；turn-stop/subagent-end 同一路径。
- 未满足：后计划需求第3项及 T1/T3 的无参数层不创建设置容器要求。
- 最小方向：按 `hasLayerSettings(layer)` 决定是否向该实例传入设置回调。

#### V6 · P2：模板变量折叠按钮不触发重渲染

- 位置：[EngineLayersPanel:212](../../src/client/app/workspace/pages/EngineLayersPanel.tsx#L212)、[展开回调:242](../../src/client/app/workspace/pages/EngineLayersPanel.tsx#L242)；由 `c26651d` 的资产迁入引入。
- 回调只向 expanded Map 写布尔值，没有 React 状态更新或通知。真实 Edge 点击变量标题前后，aria-expanded 均为 true，内容没有收起，需其他无关更新才可能读回新的 Map 值。
- 未满足：后计划 T5 复用专用编辑器并保持原行为的要求。
- 最小方向：由该控件所有者维护可重渲染的展开状态并写回草稿池，或复用已有更新通知，避免单独写 Map。

### 计划验收映射

| 原计划范围 | 当前已有证据 | 本次判定 |
|---|---|---|
| 前计划 Wave 0、5 / T1、T11 | 审查和九层方案盘点 | 文档工作已有记录 |
| 前计划 Wave 1 / T2、T3 | 接纳确认、pre-step 资格集合及对应回归 | 部分完成，V1、V2 未闭合 |
| 前计划 Wave 2 / T4—T6 | 缺省参数保真、编辑器行级优先级、内容指纹回归 | 本次未另确认缺陷；对应回归通过 |
| 前计划 Wave 3 / T7—T9 | 动态策略消费、当前持久事件适配、推进工具目录回归 | 目标反例对应测试通过；不扩大为所有生命周期均已证明 |
| 前计划 Wave 6 / T12、T13 | 九层元数据，71 个参数键定义、校验、读回和保存链 | 主体完成；参数最终来源生效还受 V3 影响 |
| 前计划 Wave 7、8 / T14—T16 | 九层组织、184 卡身份/顺序保真、四层结构化字段、同层数字草稿同步 | 部分完成，来源、搜索等仍有缺口；卡片布局以后一计划为准 |
| 前计划 Wave 4、9 / T10、T17 | 稳定文档与完整门禁 | 不能以全绿替代未覆盖行为的验收 |
| 后计划 Wave 1 / T1、T2 | 默认折叠、折叠不渲染参数；选具体空层可显示兜底且不建配置 | 部分完成，N1/N2/V5 |
| 后计划 Wave 2 / T3、T4 | 参数派生、真实装配、移除确认及独立能力卡退场 | 主要结构成立，创建和搜索未保持 |
| 后计划 Wave 2 / T5 | 结构化资产按主归属层嵌入，既有资产草稿池保留 | 部分完成，V4/V6 |
| 后计划 Wave 3 / T6—T8 | 文档、构建、类型/静态检查及 1200 项测试 | 测试盲区见下；真实已登录 GUI 未获验证 |

### 测试和凭据的限制

- [搜索测试](../../test/client/engine-module-cards.test.mjs#L570)仍验证已退场的 ToolPipelineSettingsCard/EngineModuleCards；[创建测试](../../test/client/module-policy-smoke.test.mjs#L175)先切工具链再等待工具出现，没有证明点击瞬间建立草稿。
- [受管字段测试](../../test/host/managed-config-fields.test.mjs#L41)固定 `promptConfigs: []`，只验证模板投影，不覆盖在线重建的最高优先级覆盖链。
- [无设置区测试](../../test/client/prompt-config-form-layout.test.mjs#L467)直接省略回调，未经过真实页面的无参数层判断。
- 184 卡测试分别验证真实组件渲染/操作和 host 存储往返，不能替代所有 owner 的前端输入→bridge→writer→重读端到端覆盖。同层两卡数字草稿切换回归不等于同时挂载、跨层镜像或迟到失焦均已证明。
- 后计划原状态引用的 `8b9a5c8` 无法在当前仓库解析，也不在所审 14 个提交中；相关最终测试变更可见 `a34eed1`。此处只记录凭据不可核实，不推定历史操作，不改旧记录。
- 两份旧计划的 3080 探测返回 401，只能证明服务在役；不能证明已登录工作台使用了对应产物或交互已通过。当前审查也不声称已验证真实用户 GUI。

### 不作为缺陷的事项

- 后计划明确资产在主归属层展示，因此不要求恢复前计划已被取代的跨层资产布局。
- 不把少量退场组件暂留、名称风格或文件长度单独列成高风险；没有发现需要新状态库、事件总线或通用框架的理由。
- 已产生的工具、人设、策略草稿仍由 WorkspaceDrafts 保留，没有依据声称懒卸载会丢掉所有资产正文。
- 未运行性能基准，不宣称性能收益或退化；未对真实用户数据执行写入。

## 影响面、依赖与护栏

1. 引擎链：官方系统段组装 → ST 变量帧 → pre-step 资格/候选 → 宿主接纳事件 → 去重缓存与持久恢复。V1 与 V2 可能同时影响执行器，按任务顺序实现，避免并行争用。
2. 来源链：预设定义 → reloadPresetParams → writer 模板投影和显式覆盖 → 生成配置 → 来源显示。V3 修复须先核对全部 writer 调用者，保留原有覆盖优先级。
3. 界面链：主/子页面 → engineLayerSlots → 配置列表/表单 → LayerSettingsContent → 参数与资产编辑器 → 既有 store/bridge。N1/N2/V4/V5/V6 共用装配组件，默认串行。
4. 九层独立、同层多实例、共享参数唯一存储及默认折叠保持；不把层展示位置迁移成运行时监听位置，不改受众或隐式打开子代理开关。
5. 修复若涉及 bridge 载荷，先改共享契约，随后同步 host/client/测试；不新增通用写对象，不绕过白名单、Host/Origin、大小限制、预设身份或指令文件版本守卫。
6. 指令正文、策略和预设保持独立所有者；不改用户配置，不读写真实用户预设作为测试样本。
7. 只用已安装依赖，不改宿主、不重启服务、不抢占 3080。所有测试 cwd 和临时根在 `D:\AI\workspase\_temp`，需要文件写入时设置临时 DSH_HOME，结束后清理。
8. 本轮子代理均为只读审查，最终采用结论由主线程复跑确认；提交/推送仅由主线程执行。候选修复必须先获用户选定授权。

## Wave 0：审查验证与新 PLAN（已授权）

```xml
<task type="auto">
  <name>T1：审查14个提交并将结论写入本轮新PLAN</name>
  <files>本 PLAN；.ai-memory/20260921/daily.md（仅本地追加，不入库）</files>
  <action>固定基线和终点，按规范/需求两轴审查67文件；主线程复核有效发现，保留旧归档原样，将问题、证据、候选任务和边界集中在本 PLAN。</action>
  <verify>隔离 cwd 运行 typecheck、lint、test（包含 build），复跑八项最小反例；核对本 PLAN 路径、章节和任务节点，git diff --check。</verify>
  <security>不改生产源码、宿主与用户资产；不启停服务，不安装依赖，不记录秘密；只暂存本 PLAN。</security>
  <done>审查证据和8项发现完成，新 PLAN 验证后中文提交并推送 origin/dev；仅审查完成不等于候选修复完成。</done>
</task>
```

## Wave 1：投递身份与条件副作用（候选，未授权）

```xml
<task type="auto">
  <name>T2：修复V1，投递缓存保留身份字段命名空间</name>
  <files>engine/executor.mjs；test/engine/prompt-config-engine.test.mjs；test/host/pre-step-wiring.test.mjs</files>
  <action>复用现有投递确认路径，区分plugin/kind键并使快路径与持久扫描等价；保留独立/管理路径共同实现。</action>
  <verify>先加入first.kind=second与second.id=second的延迟命中反例，确认旧实现漏投；修后冷热路径都只投递目标一次，并重跑pre-step-wiring、pre-step-persistence和prompt-config-engine。</verify>
  <security>确认只来自宿主接纳事实，不绕过外层门控，不改变来源作用域或兄弟会话隔离。</security>
  <done>V1反例转绿，独立与管理路径、恢复和disposer回归保持通过。</done>
</task>
<task type="auto">
  <name>T3：修复V2，官方组装不能提前执行未获准ST模板</name>
  <files>engine/st-render.mjs；engine/executor.mjs；engine/layers.mjs（按根因必要范围）；test/engine/official-variable-regression.test.mjs；test/engine/prompt-config-engine.test.mjs</files>
  <action>追踪所有renderSt调用者，以共享资格事实约束副作用，保持已验证的跨层变量帧与每步一次求值；不另建全局注入调度器。</action>
  <verify>真实官方assembly先于pre-step，未命中setter读到EMPTY、命中对照生效；覆盖禁用/受众/晋升/去重/新epoch与重复组装，重跑st-render-macros及official-variable-regression。</verify>
  <security>未获资格模板不得写变量；不引入脚本执行，不保存用于计数或渲染的用户原文。</security>
  <done>系统段与pre-step两种入口都满足资格先于副作用，合法跨层用例不回退。</done>
</task>
```

## Wave 2：真实来源绑定（候选，未授权）

```xml
<task type="auto">
  <name>T4：修复V3，按最终合并来源显示和编辑受管字段</name>
  <files>src/host/write-preset.ts及其调用链；src/shared/managed-config-fields.ts；src/shared/bridge-contract.ts（载荷需要时）；src/runtime/settings-bridge.ts；src/client/features/prompts/PromptConfigFields.tsx；对应host/client契约测试</files>
  <action>先盘点导入、离线物化、在线重建的最终优先级，由既有host投影规则产生来源事实；保留合法局部覆盖及编辑，不将同名ID一律当全局参数投影。</action>
  <verify>用LOCAL/GLOBAL对照覆盖空options与真实spec.promptConfigs；前端输入经bridge、writer到重读按实际owner生效；普通同策略配置、清空、只读和过期presetId均有行为断言。</verify>
  <security>不改变用户覆盖优先级来迎合UI；只下发白名单来源元数据，不下发任意行配置或路径，指令文件所有权保持。</security>
  <done>来源说明与真正生效值一致，用户可编辑有效owner，模板投影和显式覆盖均可往返。</done>
</task>
```

## Wave 3：界面入口和交互（候选，未授权）

```xml
<task type="auto">
  <name>T5：修复N1，新建工具动作不依赖编辑器挂载</name>
  <files>src/client/app/workspace/pages/MainSessionPage.tsx；SubagentPage.tsx；EngineLayersPanel.tsx；src/client/features/tools/CustomToolsCard.tsx；现有工具草稿所有者；test/client/module-policy-smoke.test.mjs</files>
  <action>将意图消费放回常驻所有者或同一工具草稿池，保留模板插入校验、独立保存通道及筛选纪律。</action>
  <verify>真实页面在all、其他层、工具层但设置折叠三态，各点击两次创建即有两条独立草稿；切页/返回不丢不重放，模板重复ID与只读仍被拒绝。</verify>
  <security>不自动保存半成品工具、不扩大工具执行权限；保持presetId绑定及自定义工具校验。</security>
  <done>创建动作即产生唯一草稿，反复操作不会覆盖前一请求，显示位置不控制动作执行。</done>
</task>
<task type="auto">
  <name>T6：修复N2，统一搜索接入真实层设置入口</name>
  <files>src/client/app/workspace/pages/EngineLayersPanel.tsx；src/client/features/prompts/PromptConfigList.tsx；prompt-config-policy.ts；test/client/engine-module-cards.test.mjs；test/client/module-policy-smoke.test.mjs</files>
  <action>复用已有编辑组和配置匹配逻辑，让匹配参数的实例或兜底入口可见；测试改走生产装配链，不以退场组件代替。</action>
  <verify>中文参数名、技术键、能力名、配置名分别命中；有/无实例卡均可进入匹配设置；清空搜索恢复卡数，筛选不写盘、不改实例或批量操作范围。</verify>
  <security>搜索只改变可见性，不扩大写权限，不创建隐式配置对象，不丢未保存草稿。</security>
  <done>真实页面可搜索并定位现有公开参数，空匹配仍给正确提示。</done>
</task>
<task type="auto">
  <name>T7：修复V4，补齐结构化资产的只读禁用</name>
  <files>src/client/app/workspace/pages/EngineLayersPanel.tsx；src/client/features/prompts/PromptConfigsEditor.tsx；src/client/features/models/ModelRouteCard.tsx；对应client行为测试</files>
  <action>共享真实预设可写性，覆盖变量输入/开关/删除与预设模型；当前会话模型保持独立通道。</action>
  <verify>system且writePreset=true、writePreset=false、正常可写预设三态；只读控件不可编辑且不产生写请求，可写正例保持，当前会话模型按官方selectable生效。</verify>
  <security>后端只读守卫继续保留，UI禁用不能代替服务端校验；不混入指令文件授权。</security>
  <done>所有资产在只读预设下正确禁用，独立会话操作不受误伤。</done>
</task>
<task type="auto">
  <name>T8：修复V5和V6，设置空态与变量折叠状态一致</name>
  <files>src/client/app/workspace/pages/EngineLayersPanel.tsx；src/client/features/prompts/PromptConfigList.tsx；PromptConfigForm.tsx；对应client行为测试</files>
  <action>按实际hasLayerSettings注入实例设置区；变量展开状态更新要触发渲染并保留既有草稿键。</action>
  <verify>真实页面llm-stream/turn-stop/subagent-end无空设置壳，有参数层仍显示；变量连续展开/收起立即改变aria-expanded，切卡/切层返回保留状态，不触发额外保存。</verify>
  <security>不为消除空态创建配置，不混淆共享参数与实例启停，键盘和aria关联保持可用。</security>
  <done>无设置层没有空容器，变量折叠动作立即生效且保留状态。</done>
</task>
```

## Wave 4：验收、文档与交付（候选，依赖选定任务完成）

```xml
<task type="auto">
  <name>T9：复核所选修复并更新稳定契约</name>
  <files>本 PLAN；docs/ui-architecture.md；docs/architecture-params.md；docs/engine-reuse.md；CHANGELOG.md；对应契约测试和脚本生成产物</files>
  <action>只更新用户选定且完成的行为；逐项复跑本轮反例，检查旧组件测试是否覆盖生产入口；同步来源、搜索、折叠和生命周期文档。</action>
  <verify>隔离cwd跑typecheck、lint、test、build、git diff --check；核对实际3080产物及可执行的GUI验收，无法完成的部分如实标明，不以401当交互通过。</verify>
  <security>不启停现有DSH，不手改或提交lib，不暂存用户文件或本地日志；未选任务不能冒充完成。</security>
  <done>所选修复及边界有证据，中文提交推送origin/dev；本PLAN按用户最终确认的范围和归档条件处理。</done>
</task>
```

## 回滚与检查点

- 本轮只产生审查计划和忽略的本地日志，源码和用户配置未改。文档需要撤销时使用对应提交的 `git revert`，不重写历史。
- 修复前先由用户指定 N/V 编号范围；选定后补录授权原话，再更新相应 Wave 状态。候选任务不自动执行。
- 反例脚本仅用于本轮临时验证，清理后在本 PLAN 保留输入、输出与调用位置。获修复授权时，把相应反例转为仓库中最小确定性回归，再修改代码。
- 中断恢复以本 PLAN、当前HEAD和工作树为准；保留旧归档与原有未跟踪目录。

## 状态

- [✔] Wave 0 / T1 审查与验证：14提交/67文件覆盖，双轴结果已复核，完整门禁通过，新PLAN已生成。
- [✔] Wave 0 / T1 文档验收：8个章节、9个六节点任务、32处本地链接与UTF-8无BOM检查通过；提交推送凭据见本轮交付回执，不预写成功。
- [✔] Wave 1 / T2、T3：V1/V2已修复，含其他插入点模板资格和管理路径克隆身份回归。
- [✔] Wave 2 / T4：V3已修复，保留显式覆盖优先级并按实际物化来源显示。
- [✔] Wave 3 / T5—T8：N1/N2/V4/V5/V6已修复，真实页面与CSS回归通过。
- [✔] Wave 4 / T9：稳定文档、双轴复核及最终完整门禁通过：1240/1240、0失败、0跳过；typecheck/lint/build/diff-check均退出0。详见[本轮实施记录](2026-09-21-plan-fix-review-findings-bd5ea6f.md)。
- 本PLAN和本轮修复PLAN按最终授权范围一同归档；两份2026-09-20旧归档原样保留。以下审查验收记录保留原终点事实，不冒充修复后结果。

## 验收记录

执行环境：Windows、Node v26.7.0；命令由 PowerShell 7 执行，测试 cwd 为 `D:\AI\workspase\_temp`。全量门禁设置本次独立 DSH_HOME、TEMP、TMP，并在 finally 清理。以下结果均针对审查终点 `a34eed1`，不是修复后结果。

| 命令或证据 | 实际结果 | 证明范围 |
|---|---|---|
| `git log 25f70d1..a34eed1 --oneline`、三点差异清单 | 14提交、67文件，含默认工具排除的7个文档/夹具 | 覆盖所有提交的最终累积变化 |
| `pnpm --dir $Repo typecheck` | 退出0 | host/client类型检查 |
| `pnpm --dir $Repo lint` | 退出0 | 现有静态规则 |
| `pnpm --dir $Repo test` | 1200/1200通过，0失败、0跳过、退出0 | 完整现有回归，含真实Edge smoke |
| test脚本内 `pnpm --dir $Repo build` | 退出0 | 受影响产物构建成功 |
| `git diff 25f70d1...a34eed1 --check` | 退出0 | 所审范围差异格式 |
| V1：公开编译/挂载/接纳/重挂的stdin反例 | 热路径1条用户消息，冷恢复2条含目标注入；断言退出0 | 缓存跨字段串用确认 |
| V2：pre-step对照及真实官方SystemPrompt.assemble | 纯pre-step为EMPTY；先assembly为SYS[BAD]、随后PRE[BAD]；断言退出0 | 官方组装路径仍执行未命中副作用 |
| V3：临时预设的真实writePreset对照 | 无覆盖GLOBAL，显式覆盖LOCAL；退出0 | 新来源说明不符合真实最终优先级 |
| N1/N2/V4/V5/V6：真实React工作台+独立Edge | 创建两次后草稿0、切层后1；参数搜索无匹配；只读变量/模型disabled=false；无参数层有空壳；变量折叠前后true；退出0 | 五项界面反例确认，HTTP依赖仅内存夹具 |
| `git cat-file -t 8b9a5c8` | 退出1，不是有效对象名 | 旧计划引用无法在当前仓库核实 |

反例加载过程中曾出现 Windows 动态 import 需要 file URL、审查加载器自身递归、模型组件不支持SSR三个探针错误；分别修正探针或转真实浏览器后完成验证，未将这些工具/夹具错误当成产品缺陷。两条审查子代理初次执行中断，恢复后完成；本轮采用结论均有主线程运行证据。

提交清单（由旧到新）：

| 提交 | 主题 |
|---|---|
| `54bac00` | 投递确认、ST资格与参数缺省修复 |
| `b85935e` | 动态策略、深思门、阶段目录及九层元数据/参数闭环 |
| `d72f624` | 九层归位、实例字段入口和首计划归档 |
| `e5ce012` | 统一页面装配与工具层参数区 |
| `a5affe0` | 共享参数草稿广播 |
| `abf5781` | 184卡与草稿保持回归 |
| `401bcab` | 统一搜索与层空态 |
| `78705db` | 受管字段来源与只读回显 |
| `7d78e77` | 文档及首计划复核补录 |
| `01d2654` | 实例卡设置注入点与空层兜底 |
| `56b7925` | 按层装配设置并注入实例卡 |
| `0293bea` | 独立能力卡退场 |
| `c26651d` | 结构化资产迁入层设置区 |
| `a34eed1` | 稳定文档与第二计划归档、最终测试调整 |

## 实施取舍与已知边界

- 本轮以最终累积差异和真实调用链审查所有提交，没有逐个复演14个中间提交的运行状态。
- 浏览器反例复用仓库真实React工作台夹具，宿主HTTP/会话依赖使用内存数据；没有验证真实已登录3080页面，也没有访问真实用户预设。
- 未运行性能基准；保留现有所有权与最小修复方向，不新增实现框架。
- 本轮只创建新的审查PLAN；不改两份旧归档，不实施任何候选修复。无需重启DSH。

## 测试现场与清理限制

- 全量门禁、writer对照的独立临时根由finally清理；临时Edge已正常关闭，profile已清理。
- 本轮临时浏览器反例脚本已从 `_temp` 删除，不作为仓库新测试提交。
- 只保留本PLAN与忽略的本地日志；用户原有 `skills/` 未触碰。无已知需要用户清理的现场。
