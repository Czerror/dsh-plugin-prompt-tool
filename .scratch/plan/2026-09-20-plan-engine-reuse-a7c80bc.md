# 引擎复用与模块化归一审查 PLAN

## 需求与授权

- 日期：2026-09-20；审查与建计划起始基线：`dev / a7c80bc`。
- 用户原始需求：`/dev-expert /codebase-design 审查引擎能力是否可复用模块化, 是否有可归一优化.`
- 用户补充要求：`按照仓库指令 应该创建为plan`。
- 2026-09-20 新增原话：`本项目已经 对齐官方9个注入层,可否 统一前端和后端可编辑引擎参数 设置到 9个注入层 模块卡片中,不在把引擎设置分散在各处,请给出重构方案,也写入2026-09-20-plan-engine-reuse-a7c80bc.md`。
- 用户进一步明确：`比方说 tool-config 、tool-filter 、自定义工具等功能完全可以加入tool-pipeline模块卡中,按照这个思路 其他引擎设置也可以加入到对应注入层的模块卡中`。
- 随后澄清：`预设中同一层拥有不同配置时 可创建多张同层卡片 这是目前合理的设计.比方说系统提示段,在某些自定义预设中 可存在几十张不同设置的卡片`，并指定本地 beta-2-42 预设作为参考。最终约束为九种层类型、每层可有多张独立配置卡；能力设置进入对应层卡，但不收拢或减少配置实例数量。前述“固定数量容器”的推断已撤回。
- 最新补充：`多实例设计是合理的,唯一引擎功能的设置参数 可采用 同步或互斥,在多张同层或跨层卡中同步`。据此改为唯一存储所有者、多处同步编辑；只有真实不兼容的功能采用后端校验的互斥，不以“唯一功能”为由强制单一可写控件。
- 本次方案增补基线：`dev / d415d4a`（上一轮 PLAN 提交）；保留文件名中的原始审查基线，不新建第二份计划。
- 2026-09-20 18:00 授权补录：用户原话 `根据plan执行`，经互动提问选定范围 **Wave 1+2（T2—T6，R1、R2、R3、R5、R4）**；随后明确 `PLAN中 所有wave全部完成才能归档`。据此本轮实施 T2—T6，Wave 3、4、6—9 仍未授权，PLAN 保留在 `.scratch/plan/`，不归档。
- 已授权：审查、验证反例、将结论与候选任务写入本 PLAN，九层参数编辑收敛的方案设计，以及本轮 T2—T6 的实现与其回归、文档同步、提交推送。文档与代码按仓库规则验证、提交并推送 `origin/dev`。
- 未授权：Wave 3（T7—T9）、Wave 4（T10）、Wave 6—9（T12—T17）的任何实现；PLAN 归档须待全部 Wave 完成。
- 本文件是本次审查的唯一 PLAN；结论集中在「审查结论」，不另建审查报告。仅建计划不等于修复完成，因此保留在 `.scratch/plan/`；选定任务完成并验收后才按仓库规则归档。
- 保留起始工作树中的用户未跟踪目录 `skills/`；本轮不修改宿主源码，不启停服务，不安装依赖。
- 格式依据：[PLAN 格式规范](../../docs/agents/plan-format.md)；授权、归档与交付依据：[仓库规则](../../AGENTS.md)。

## 审查结论

### 总体判定与现有复用

核心引擎已经具备可验证的复用基础。主要缺口是模块组合后的契约一致性：资格判定和副作用分离、候选消息与投递确认分离、缺省值与显式值分离，以及适配当前宿主事件。

| 现有模块或接缝 | 已验证的复用事实 | 处理原则 |
|---|---|---|
| [共享晋升状态机](../../engine/compaction-epoch.mjs#L61) | `status/observe` 隐藏冷扫描、增量更新、成功压缩边界、子代理和严格晋升逻辑，被多个消费者复用。 | 保留各能力独立配置，不引入全局晋升管理器。 |
| [批执行器及挂载入口](../../engine/executor.mjs#L309) | 独立挂载与宿主协调器共用 `runPreStepBatch`；已有真实 Cordis 作用域、接管和释放验证。 | 将共同缺陷修在共享执行路径，避免两条路径分别打补丁。 |
| [参数定义与映射](../../src/shared/engine-params.ts#L197) | 参数键、正向装配和反向回显已有共同定义。 | 删除破坏缺省语义的例外，不新增平行参数目录。 |
| [核心装配入口](../../engine/prompt-config-engine.mjs#L25) | 整个引擎复制到隔离目录且不复制 node_modules，核心加载和注入成功。 | 保持核心依赖闭包；区分附加能力的宿主依赖。 |

### 已复现缺陷

优先级：P1 为建议优先修复，P2 为随后处理；编号 R1—R8 供用户选择修复范围。下列结果来自审查阶段的实际反例，不表示修复已完成。

| 编号 | 严重度与位置 | 触发、实测与影响 | 最小归一方向 |
|---|---|---|---|
| R1 | P1：[执行器记账](../../engine/executor.mjs#L276)、[外层门控](../../engine/context-gate.mjs#L198) | `dedupe=session` 的候选消息先记为已注入，再被首阶段门控剥离；晋升后仍缺正文。真实 Cordis 对照中 `dedupe=none` 可正常补发。 | 分离候选生成和投递确认；以宿主实际接纳的持久消息确认去重，保持既有来源身份。 |
| R2 | P1：[ST 提前求值](../../engine/st-render.mjs#L89) | `match.keys=['NEVER']` 未命中的 setter 没有注入，却执行 `setvar`，后续 reader 得到 `BAD`。禁用 setter 或排除受众的对照不泄漏。 | 执行器统一决定资格，模板渲染仅处理获准配置；保留既有跨层变量帧语义。 |
| R3 | P1：[写入器缺省值](../../src/host/write-preset.ts#L189)、[真实导入调用](../../src/host/preset-package.ts#L184) | 导入不传运行时参数，writer 将缺参补 false/空串/true，覆盖预设：锚定被禁用、文本清空、关闭的注入器启用、子代理模型路由消失；预设定义仍保留原值。 | 未提供参数保留 undefined，合并定义后在消费点兜底；不要求每个调用方补展开参数。 |
| R4 | P1：[引擎指纹](../../src/host/write-preset.ts#L52)、[同步短路](../../src/host/write-preset.ts#L137) | 指纹只含相对路径和大小。原同步函数配真实临时文件系统：`version=1` 改为等字节 `version=2` 后仍复制旧 1；改为 333 后正常刷新。 | 指纹使用有序路径与内容摘要，保留现有原子替换和恢复流程。 |
| R5 | P2：[编辑器参数补值](../../src/shared/engine-params.ts#L289)、[组合合并](../../src/host/manifest.ts#L1120) | 行级 `maxOutputChars=32000` 在扁平参数缺失时被生成的默认 16000 覆盖；显式参数 48000 则正常，能力回显同样经过该参数桥。 | 去掉缺参时的特殊补值，保留数值归一和既有行默认，恢复显式参数、行级配置、行默认的优先级。 |
| R6 | P2：[策略许可](../../engine/schema.mjs#L142)、[运行上下文装配](../../engine/layers.mjs#L223)、[策略路径](../../engine/strategies.mjs#L209) | 自定义策略用于 runtime-context 通过校验，但 resolver 调用为 0，实际显示静态文本。相对 `strategyDir='../strategies'` 直接抛 `ERR_INVALID_URL`。 | 许可矩阵与真实消费一致；支持已声明的动态策略，并在入口统一解析目录 URL。 |
| R7 | P2：[深思门事件适配](../../engine/deliberation-gate.mjs#L89) | 当前已安装宿主持久事件没有 assistant/chunk。正阈值 10 时，真实 Session 首轮已有 300 字 reasoning 仍 deny，次轮无文本却 accept；阈值 0 对照正常。 | 冷扫描与实时更新共用事件处理函数，按 turn/start 重置预算，消费当前 assistant/message，避免重复计数。 |
| R8 | P2：[阶段目录裁剪](../../engine/tool-bootstrap.mjs#L350) | 两阶段 read/write、`stagePreUnlock=0`，注册表有 phase_advance，模型目录只有 read，提示仍要求调用推进工具。把推进工具手工放入第一档后恢复可见。 | 现有阶段保留集合加入实际注册的推进工具名，注册、提示和裁剪引用同一值。 |

R6 的运行上下文反例以公开编译/挂载路径加可观测 resolver 证明“无人调用”；未把自定义工厂的状态寿命推断列为确认缺陷。R8 限定原生工具目录场景，不泛化为所有 PTC 组合都绝对无法推进。

### 复用说明需补齐的范围

A1：[复用指南](../../docs/engine-reuse.md#L34) 的整目录复制表述应区分三类能力：核心可复制、需官方 DSH 包、需 Prompt Tool 私有服务。[角色工具](../../engine/character-tools.mjs#L5)、[世界书工具](../../engine/world-book-tools.mjs#L5)、[会话变量工具](../../engine/session-var-tools.mjs#L5) 都是私有 `pt-*` 服务适配器；隔离复制后缺服务各告警一次，提供 mount 服务后 3/3 正常挂载。仅在第二个真实宿主需要这些实现时再考虑下沉，当前只需明确依赖契约。

### 测试缺口与不采纳项

- [深思门测试](../../test/engine/injection-gates.test.mjs#L90) 使用已撤销的 assistant/chunk 桩，测试通过不能说明当前宿主链路有效。
- [阶段目录夹具](../../test/engine/promotion-gate.test.mjs#L501) 没包含实际注册的推进工具；现有测试检查注册后人工发推进事件，绕过了可见性缺口。
- 不按文件长度拆模块，不强推跨插入点全局顺序，不新增通用生命周期框架。
- 不把 PTC 调用处缺少显式 keepDisposer 认定为泄漏：已安装宿主的 presentAs 内部已有 ctx.effect。
- 未进行性能基准，不宣称延迟、吞吐或资源消耗改善。

## 九层参数编辑收敛方案（2026-09-20 增补，待批准实施）

### 目标与取舍

可行。采用「九层分类、多卡实例、唯一数据源、共享功能同步或互斥」：收敛参数定义、元数据和写回绑定，编辑控件可以在多张同层/跨层卡中出现，但引用同一数据所有者。继续使用现有预设格式、保存队列、校验器与物化流程，不新增 `layers.*` 数据树，不把所有能力改写为 promptConfig。

**最终编辑结构**：一个引擎编辑面，按九种官方注入层分类，每层允许零张、一张或多张独立配置卡，不以层类型作唯一卡片键，也不把多张卡压成一个表单。现有 promptConfigs 卡片继续独立新增、复制、排序、启停、删除和编辑。tool-config-engine、tool-filter、自定义工具等预设级功能集中到属于 tool-pipeline 的能力设置区，也可以在相关卡中显示同步控件；它们与多张 tool-pipeline 规则实例卡并存。其他引擎设置同样进入相应层，消除各处私有数据和重复保存逻辑，保留多处同源编辑和所有不同配置实例。

必须保留两类数据粒度：预设级能力参数引用现有唯一所有者，移动或增加编辑位置不为每张卡复制一份；实例字段继续保存在 `promptConfigs[].params` 和该实例自身字段中，允许同层各卡有不同值。标记“共享引擎参数，同步影响相关卡”与“仅本卡”，不得用层默认值批量覆盖实例。

主会话/子代理是同一编辑面的受众视图，不再各自维护一套表单。保留既有页面标识作为进入相应视图的入口，资产库页继续管理导入/导出等资产操作，不再承载重复的引擎参数表单。

工具管线的示例结构（预设级能力卡与多张规则实例卡均属于同一层）：

```text
tool-pipeline 层
  工具能力设置卡（引用预设级配置）
    工具配置 / tool-config-engine：装配状态、执行前批准种类
    工具过滤 / tool-filter：启用、允许工具、禁止工具
    自定义工具：新增、模板、编辑、删除（仍保存 customTools）
    工具呈现 / PTC：开关、晋升信号、子代理范围
    编辑器：输出字符上限
    深思门、执行后提醒：各自的参数
    相关设置：首阶段工具目录、子代理授权（同源同步控件及定位）
  管线规则卡 A：独立 id、条件、调用前裁决、调用后动作
  管线规则卡 B：另一套 id、条件与参数
  ……继续新增同层卡片

system-section 层
  人设设置卡（引用顶层 persona）
  系统段卡 A：独立 id、order、文本、params
  系统段卡 B：独立 id、order、文本、params
  ……允许几十张不同配置的系统段卡
```

此处“装配状态”来自真实能力装配；没有布尔 enabled 参数的模块以装配/移除动作表达，不伪造新运行时开关。能力参数单例来自其原有数据所有权，不是“一层只能一张卡”的规则。

必须区分两个概念：**编辑归属层**是能力主要在哪里展示，**实际生效通道**是运行时在哪里消费。工具注册、默认模型装配、收件箱锚定并不是九层中的新 hook（扩展点）。它们可在相关层卡片中提供参数控件，但不能为统一外观迁移运行时监听器。主归属用于组织导航，不限制关联层提供同源可写控件。

### 多卡共享参数：默认同步，真实冲突才互斥

| 字段类别 | 数据身份与保存位置 | 多卡行为 |
|---|---|---|
| 配置实例字段 | presetId + config.id + 字段路径，保存到该条 promptConfig | 完全独立；同层相同字段名也不互相覆盖。复制生成新 ID，排序/删除只作用于目标实例。 |
| 唯一引擎功能参数 | presetId + 既有所有者 + 参数键，例如 params.toolFilterAllow | 同层/跨层多张卡绑定同一 store 字段和草稿；任一处修改立即在其他位置回显，一次语义变更只提交一份参数。 |
| 共享结构化资产 | presetId + persona/variables/customTools/subagentToolPolicy + 内部稳定身份 | 重用各自专用编辑器及同一草稿池/写端点；可以镜像编辑，不能在各卡缓存独立“真值”并整段互相覆盖。 |
| 真实互斥配置 | 官方作用域及现有冲突规则，例如 persona.complete 与同作用域独占系统段 | 不接受相互矛盾的有效配置。后端验证候选最终状态；若提供“切换独占目标”，需用户明确操作后原子调整冲突项。未提供此动作时保留现有明确报错，不能静默关闭其他卡。 |

实现约束：

- 复用现有 store/字段草稿池/保存队列；共享字段控件直接订阅同一个值，不通过组件之间的 effect 相互复制，不新增独立同步服务、事件总线或状态库。共享字段身份由既有参数/资产目录给出，不能仅因两个字段都叫 `enabled` 就同步。
- 合法值、尚未完成的数字/文本输入、错误和保存状态都按同一个共享绑定同步；实例草稿仍按 config.id 隔离。每个控件的 DOM id/aria 关联须加所在卡实例前缀，避免多个镜像输入发生标签或焦点冲突。
- 一个控件的用户操作只调用一次现有 patch/保存动作；其他镜像的重新渲染不触发保存。保存采用入队快照和编辑版本，迟到的 blur/异步响应不能把较新的共享值覆盖回去；失败保留最新草稿及错误，不谎报已保存。跨预设迟到请求继续拒绝。
- 已持久化的旧配置中若同一功能存在真实多个来源，先按现有优先级计算有效值并标明来源；重构不新增“最后渲染的卡获胜”。启用互斥必须复用真实运行规则，不能把用户合法的几十张普通系统段卡判冲突。
- 能力开关跨卡同步不等于卡片实例启停同步。关闭某条系统段/管线规则只关闭该实例；改共享工具过滤开关才影响所有引用它的卡。删除普通实例不删除共享能力、预设参数或其他引用。
- 工具目录过滤、阶段推进等共享模块仍只装配一次；多个编辑镜像不重复创建 modules 行、监听器或工具注册。移除能力属于原有明确操作，所有镜像同步成未装配状态；不会因关闭一张展示卡就卸载能力。


### 现状证据与收敛范围

| 现状 | 代码证据 | 本次方案处理 |
|---|---|---|
| 主会话上方另有模型、提示词默认值、人设等卡片；子代理另有模型和委派深度 | [主会话装配](../../src/client/app/workspace/pages/MainSessionPage.tsx#L132)、[子代理装配](../../src/client/app/workspace/pages/SubagentPage.tsx#L98) | 移入九层对应卡片，复用专用编辑器，移除 commonCards/beforeCards 中这些编辑入口。 |
| 提示词列表与能力卡平行呈现，筛选没有统一包含所有编辑项 | [提示词列表](../../src/client/features/prompts/PromptConfigList.tsx#L391)、[能力卡列表](../../src/client/features/modules/EngineModuleList.tsx#L136) | 页面装配层统一分层、搜索与定位，取消固定漂浮在层过滤之外的引擎表单。 |
| 能力目录 displayLayer 只有三种，参数目录已覆盖 64 个键 | [能力目录](../../src/shared/engine-capabilities.ts#L18)、[参数目录](../../src/shared/engine-params.ts#L197) | 将展示归属扩展到九层，在现有定义上补齐编辑组，不复制第二套参数键表。 |
| 额外 7 个内容键能被 writer 消费，但未进入共享参数定义；bridge 白名单通过后仍被值校验拒绝 | [附加键](../../src/shared/param-keys.ts#L16)、[值校验](../../src/shared/engine-params.ts#L394)、[保存链](../../src/runtime/settings-bridge.ts#L1360) | 将 7 键正式纳入共享定义、类型、校验、草稿、读回、保存和词条；目标为 71 个已声明扁平参数的闭环，保留旧存储键。 |
| near-anchor、router-guide 的局部策略字段因 writer 管理而被隐藏 | [托管字段编辑逻辑](../../src/client/features/prompts/PromptConfigFields.tsx#L224)、[writer 投影](../../src/host/write-preset.ts#L434) | 在所属层内呈现唯一来源字段；生成字段只读回显或链接到来源，不留下“能改但重建覆盖”的入口。 |
| 模型卡同时修改当前会话和预设默认，持久化通道不同 | [模型卡](../../src/client/features/models/ModelRouteCard.tsx#L58)、[模型请求配置生成](../../src/host/write-preset.ts#L267) | 预设参数进入九层；当前会话选择保留为明确标注的会话操作，不进入预设批保存。 |

七个待闭合键为 `buildPattern`、`complexPattern`、`firstTurnBuild`、`firstTurnInspect`、`firstTurnDeep`、`guideWeak`、`guideDeep`。这属于补齐现有功能的保存契约，不是把任意后端配置键公开成 UI 输入。

### 同层多卡的参考预设与不变量

已只读解析用户指定的本地 beta-2-42 定义：本次快照含 128 个不同 ID 的 promptConfigs，其中 pre-step 120 张（启用 18 张）、system-section 8 张（启用 4 张）；每层的 order 均各不相同。这些实例全部声明 mergeMode=merged，说明“运行时可以合并输出”与“编辑器中保留多张独立配置卡”必须分开处理。参考正文未复制到仓库，用户预设未修改。

- `layer` 只是分类/执行通道，不能用于 Map 覆盖同层条目。实例身份继续使用预设身份和配置 id；改名/复制沿用现有 ID 唯一性校验，新增同层卡不替换已有卡。
- 单卡的 order、enabled、strategy、text/texts、params、variables、受支持的 audience/modelScope/match 与 mergeMode 均按现有语义独立保存；排序保持同层的稳定顺序。显示归类不得重排 YAML 数组或改写已有 order。
- 预设级能力设置卡不能进入 promptConfigs 数组；配置实例也不能因挂在某层而被投影成一份全局参数。托管配置、普通自定义配置和独立指令文件仍按现有来源区分。
- 行为回归使用合成的 128 卡数据（匹配本地样本层分布）与至少 64 张 system-section 卡，使用不同 id/order/参数值；逐卡修改、复制、排序、启停、删除后，其他实例及同名全局变量不受影响。实例编辑→保存→重读应保持数量、身份、顺序和未修改字段。
- 实例卡片的草稿键/展开态/焦点锚点按“预设 + 来源类型 + 实例 id + 字段路径”保存，不能只按 layer；共享参数的值/草稿按参数或资产身份保存，显示它的每个控件仍有独立 DOM 身份。层导航保留九种选项，不建立每层容量为 1 的断言。

### 九层卡片目标映射

以下是编辑位置的建议映射；只有 promptConfigs 实例使用真实 `layer` 参与执行。顶层资产和装配能力仍用其原有保存通道。

| 层类型（每层可多卡） | 主要编辑内容 | 共享或实例范围 |
|---|---|---|
| 消息批层 `pre-step` | 多张本层提示词/世界书卡；锚定/引导/兜底注入、context-gate、anchor-turn、独立指令来源/策略/文件卡 | 8 个既有默认参数及 7 内容键引用预设来源，实例文本和局部 params 独立；context-gate 可在 runtime-context 卡内同步编辑。 |
| 系统段层 `system-section` | 多张不同系统段卡；人设设置；tool-bootstrap 的 16 个共享参数 | 每条系统段的 id/order/text/params 独立，persona 仍是独立顶层所有者；bootstrap 封顶/工具设置可在相关层镜像编辑，装配一次。 |
| 运行上下文 `runtime-context` | 多张上下文提供项、占位填充、上下文名称；共享模板变量 | 变量全局默认仍存 variables/variablesEnabled，可在使用它的卡中同步编辑；局部 promptConfig.variables 按实例隔离。 |
| 调用配置层 `agent-request` | 多张 patch/replace 配置；主模型 5 参数、子模型采样 3 参数 | 生成模型配置的控件绑定原参数来源；用户独立请求 patch 保留自身字段，不能把同名 patch 强制同步。 |
| 模型流层 `llm-stream` | 多张启用/模型范围/pass/replace/替换正文配置 | 各实例独立；没有需求就不新增全局流参数，深思门不伪装成流拦截。 |
| 工具管线层 `tool-pipeline` | 工具配置、过滤、自定义工具、PTC、编辑器限额、深思门、提醒；多张条件/裁决/结果处理规则卡 | 唯一能力参数跨卡同步，customTools 仍是同一资产集合；每条管线规则独立，目录/呈现/注册/执行方式分清；子代理策略可在关联卡同步编辑。 |
| 轮次停止层 `turn-stop` | 多张条件、匹配对象、续跑正文配置 | 每卡字段独立；引擎防循环总上限保持内部约束，不因多实例放大预算或开放关闭按钮。 |
| 子代理启动层 `subagent-start` | 多张启动事件提示卡；子模型路由 2 项、maxDepth、结构化工具策略 | 委派配置引用共享所有者，可以在工具管线/请求配置的相关卡同步；每条启动消息卡仍独立。 |
| 子代理结束层 `subagent-end` | 多张结束条件/匹配对象/观察配置卡 | 各卡独立，当前只观察记录；不新增或暗示结束后消息注入。 |

**64 个已有参数覆盖核对**：pre-step 为 prompt-defaults 8 + context-gate 8 + anchor-turn 3，共 19；system-section 为 tool-bootstrap 16；agent-request 为主模型 5 + 子模型采样 3，共 8；tool-pipeline 为 tool-filter 3 + PTC 3 + 编辑器 1 + 深思门 5 + 提醒 5 + 自定义批准 1，共 18；subagent-start 为子模型路由 2 + maxDepth 1，共 3。合计 64；新增 7 个内容键归 pre-step。其余四层主要由配置实例和结构化资产承载，不为平均分配参数制造空功能。

此处的唯一性按“预设/资产或配置实例/字段路径”判断：不同实例同名参数不是重复；同一个预设参数在主会话/子代理视图中共享同一草稿和写回，不能变成两份状态。

### 前端结构与交互

1. 在 app/workspace/pages 装配一个共用九层分类编辑面（建议新增 `EngineLayersPanel.tsx`），让 MainSessionPage 与 SubagentPage 只传受众视图和导航信息。跨 feature 组合放在 app 层，不让模块 feature 导入其他 feature 的内部实现。
2. 九层是导航/筛选类型，不是卡片数量。保留当前独立卡片呈现，层内允许 0..N 张配置实例及相关能力设置卡；无内容的层显示空状态与新增入口，不自动创建九个配置对象。每张实例保留名称、独立启停、顺序和编辑入口。
3. 工具配置、过滤、自定义工具等在 tool-pipeline 卡的功能区内操作；其他相关卡可以嵌入同源共享控件。搜索同时覆盖中文名、技术键、能力名、配置名，定位匹配实例及功能区；不要把几十张匹配卡合并成一张“层结果”。创建同层新卡沿用现有筛选和定位纪律。
4. 普通字段复用 EngineParamFields；模型、阶段、工具定义、授权策略、人设继续用专用编辑器，必要时拆出可嵌入内容。清理旧的私有状态/重复保存逻辑和零散公共区，保留真实实例卡壳与多处同源控件。默认显示中文功能名、共享/仅本卡范围，真实 hook/存储细节放高级说明。
5. 主/子代理只是视图筛选，不改 audience，不默默启用 includeSubagents。跨受众共享设置明确标注影响范围；同一数据身份的镜像同步，不把主会话模型键与子代理模型键混为一份。
6. 切层/换受众不丢数字半成品、未完成阶段、模板变量空行或专用编辑器草稿；共享字段的草稿按参数/资产身份复用，实例字段按 config.id 隔离。多控件允许同时存在，但 DOM id 独立、值和提交基线同源。
7. 不新增“一键关闭整个注入层”或跨层运行顺序。批量操作沿用可写配置实例范围，不把共享能力、独立文件和授权策略一起删除/停用；显示多个镜像不等于重复装配模块。

### 前后端共同契约与保存路线

- `engine/schema.mjs#getEngineMeta` 继续拥有真实九层及字段/策略支持事实；在现有 meta 返回中提供稳定的 `layerOrder`，浏览器消费此顺序，移除客户端另写的运行时九层清单。共享 TypeScript 类型可声明九层联合，但运行时合法性以引擎校验为准；不让浏览器直接 import 含 node:fs 的 schema，也不让复制引擎反向依赖 src。
- `ENGINE_PARAM_DEFINITIONS` 继续是参数键、类型、默认草稿、校验和组合行映射唯一来源，补齐 7 个键；现有 `card` 继续表示编辑组。只在既有 shared 文件补少量编辑组元数据，不在页面再维护键数组。
- 复用并扩展 `ENGINE_CAPABILITIES.displayLayer` 到九层；非能力编辑组（模型、提示词默认值、人设、变量、委派等）在同一 shared 契约中登记主归属，能力组派生现有目录而不重复声明。确有跨层影响的组才补 `relatedLayers`，同时记录实际 hook 或装配方式供只读说明。无需同时引入含义相同的 ownerLayer/displayLayer 两套字段。
- `/meta` 与 `/bootstrap` 复用现有 loadEngineMeta，一次组合引擎层信息与白名单编辑组说明；响应形状先在 shared/bridge-contract 登记，再改 host/client/transport 守卫。只序列化可公开的类型、选项、组归属和说明，不序列化 check 函数、路径、任意 moduleConfigs 或服务对象。
- 补齐 7 键时同步 EngineParams、词条、读回/保存/脏检测/快照派生，PARAM_KEYS 不再为它们保留旁路键表。正则值复用现有分类/匹配编译逻辑验证，空串仍是删键语义，错误在写盘前返回；不得只取消校验来“支持”字段。
- 扁平参数与 promptConfigs 继续走 `/param-overrides`、`savePresetParams`、`reloadPresetParams`、`rebuildPreset/writePreset`；persona、variables、customTools、subagentToolPolicy 各保留既有端点和顶层所有者。统一入口不要求把不同数据塞进一个通用写路径。
- 受 writer 管理的 near-anchor/router-guide/prompt-injector/model-params 等字段必须有明确来源绑定。可直接映射的字段在当前卡显示同步控件，保存仍写原参数/资产，不另存派生副本；只有无法直接逆映射的计算结果（例如自动派生 anchorWords）只读显示并链接来源。绑定事实由 host 既有投影规则产生，前端不另写 ID 特判和优先级。普通自建策略配置继续编辑局部 params，合法显式覆盖保留原来源及优先级，不能被共享控件覆盖。
- 卡片保存沿用入队时快照、预设身份核对、串行队列和保存后脏状态判定；同一预设同一次编辑涉及扁平参数与配置时可复用现有复合载荷，禁止先写显示默认值再修正。不同端点的保存按真实结果逐项报告，不宣称跨资产原子提交。
- 独立指令源的控制入口移入 pre-step，但正文和策略继续分别走授权、上下文白名单与版本校验通道；不会因“保存本层/保存预设”自动写指令文件。当前会话模型选择仍走官方 selectModel，部署开关/默认预设仍留设置页，资产库保留导入管理入口；这些不是散落的预设引擎参数。

### 迁移、前置依赖与范围控制

- 旧预设无须批量迁移：保留 params、moduleConfigs、promptConfigs、model/subagentModel、persona、variables 等现有路径和优先级。只读浏览不写默认值；打开再关闭新界面，预设应逐字不变。
- 参数视图收敛的前置依赖是 T4/R3 和 T5/R5，否则新卡仍可能保存后被默认值覆盖；若本轮涉及引擎分发变化，交付前包含 T6/R4，防止等字节更新遗漏。R1/R2/R6/R7/R8 继续单独列为已知问题，不为界面重排默认扩大到全量修复。
- 旧页面入口改为同一九层视图的受众定位或只读导航，旧卡片本体完成接管后移除；不存在长期维护的新旧两套编辑器，也不迁移真实用户数据。
- 未知/未来层或扩展字段保留读取与现有高级编辑能力，不静默删值，也不把它们算成第十个官方层。不支持的字段仍由后端拒绝，UI 不因“全量可编辑”放宽运行时矩阵。
- 未公开的装配参数（配置目录、策略目录、插件路径、工具执行环境和宿主私有选项）按真实权限逐项处理；本方案覆盖插件已承诺的公开引擎参数和实例字段，不把任意 moduleConfigs 变成可远程写的通用对象。`tool-filter.includeSubagents` 在 [现有覆盖测试](../../test/shared/engine-param-schema.test.mjs#L98) 中明确是有意不暴露的字段，子代理工具面使用实例策略，本轮不以“补全参数”为由重新开放。若新增公开选项，必须同时补共享定义、校验、owner 和回归。
- 首期新增生产文件最多一处页面装配组件，其他调整在既有 owner 中完成；不更换路由、状态库、卡片库或保存服务。超过约 200 行实现量级的切片在实施时继续细拆，不用“大 UI 重构”一次替换整个 store。

### 验收标准

- 九层的层名、顺序、有效字段来自权威元数据；64 个现有参数及选定补齐的 7 键均有唯一数据所有者和主要展示归属，可在相关卡提供同步编辑；覆盖测试同时检查绑定来源与真实保存行为。
- 以合成 128 卡样本及 64 张系统段卡验证同层可多实例：数量/ID/order/启用/文本/局部参数在保存往返后不折叠、不串值；运行输出合并不影响编辑实例身份。
- 同层与跨层各至少两个共享控件：合法值、未完成输入、错误/保存状态同步；同名实例参数保持不同值，控件 DOM id 不重复；单次语义变更只发一次保存，迟到响应不覆盖新草稿。
- 真实互斥项由后端校验最终候选状态，冲突保存不落盘；普通多系统段不互斥，不以渲染顺序或最后一次保存决定功能所有者。
- 前端实际输入 → 队列载荷 → bridge 验证 → 预设落盘 → 物化 → 重读回显至少按每种存储 owner 各跑一条行为用例；非法键/非法值/system 只读/过期 presetId 均在写盘前拒绝。
- 非修改打开不写盘；省略/false/0/空串/空列表、行默认与显式覆盖、主子模型与委派授权、受托管字段的来源都往返一致；导入与重建不覆盖用户值。
- 切层/筛选/受众切换/保存中继续编辑/切预设保留草稿并拒绝过期响应；键盘可定位具体实例与共享控件，错误与同步影响范围清晰；清理零散入口的私有状态与重复写入逻辑，而非禁止多处同源编辑。
- 九层展示不改变 hook 注册、scope、disposer 或 epoch；工具目录不被误当执行权限，结束层保持只观察，停止层防循环上限不放开。
- 指令文件与预设、会话操作与预设分别保存，错误逐项报告；复制核心引擎仍不依赖 src 或浏览器包。
- 完整 typecheck/lint/test/build、文档 diff 与对应契约测试通过。实施后的 UI 验证必须使用现有 `http://127.0.0.1:3080`：先确认同仓库 `dev:web` watcher 再决定 HMR 验证方式，否则重建受影响产物并刷新现有页面；不启动替代服务冒充当前 GUI 已更新，不重启宿主。

## 影响面、依赖与护栏

1. 主要链路：配置编译 → 策略绑定 → 独立执行器或宿主协调器 → 外层门控 → 宿主接纳/持久事件；以及导入/重建 → writer → 参数合并 → 组合与提示词物化 → 共享引擎同步。
2. Wave 0、Wave 5 是已授权的审查/方案工作；Wave 1—4 及 Wave 6—9 的实施须由用户选定范围。推荐优先 R1—R4；九层收敛以 R3/R5 为参数保真前置，涉及引擎分发时包含 R4。推荐不构成授权。
3. Wave 1 的 T2、T3 可能同时修改执行器与 ST 帧，串行完成；Wave 2 的 T4、T6 共用 writer，串行完成。Wave 3 的任务可按互斥写区独立执行；共享文档统一在 Wave 4 收敛。
4. 修复参数链前读取 [参数架构](../../docs/architecture-params.md)；引擎修复前读取 [引擎复用契约](../../docs/engine-reuse.md)。若需修改组合来源，先读取 [组合编辑技能](../../preset/pt-cordis/skills/editing-cordis-compositions/SKILL.md)。
5. 保持官方插入点独立，order 只作用于同一插入点；PTC、锚定、引导及增强能力保持 opt-in；不得改变用户未选择的行为范围。
6. 保持 preset.yml 为预设行为来源；独立指令文件及其策略的所有者不变，不复制正文到预设或生成目录，不扩大指令编辑授权。
7. 文件测试使用独立临时目录和 DSH_HOME；默认只写插件拥有的目录，system 目录只读。保持白名单、Host/Origin、载荷限制和原子替换；本计划不新增 bridge 接口。
8. 依赖已发布宿主包及安装类型，不修改 DeepSeek Harness 源码，不停止或重启当前服务，不抢端口。监听器和工具仍随 ctx.effect/disposer 释放。
9. 后续每个任务按约 200 行实现量级控制；超过时按行为拆成可验收切片，并更新本 PLAN。仅暂存本轮文件，保留用户改动，不提交本地记忆或构建目录。

## Wave 0：审查证据与计划补录（已授权）

```xml
<task type="auto">
  <name>T1：将本轮审查整理为唯一 PLAN</name>
  <files>.scratch/plan/2026-09-20-plan-engine-reuse-a7c80bc.md；.ai-memory/20260920/daily.md（仅追加纠正记录、不入库）</files>
  <action>汇总主线程与已复核子代理证据，列出 R1—R8、A1、保留的模块边界和候选任务，明确审查与修复授权边界。</action>
  <verify>核对必需章节、各 task 六个子节点、连续编号、本地链接和测试命令；执行 git diff --check；确认未改源码或用户已有目录。</verify>
  <security>仅写本仓库计划与忽略的本地日志，不复制凭据或会话私密内容，不触发任何运行时写入。</security>
  <done>计划结构和引用核对通过，文档提交并推送 origin/dev，向用户交付文件。</done>
</task>
```

## Wave 1：注入资格与投递确认（候选，未授权）

```xml
<task type="auto">
  <name>T2：修复 R1，按真实接纳确认会话去重</name>
  <files>engine/executor.mjs；src/runtime/pre-step-coordinator.ts；test/host/pre-step-wiring.test.mjs；test/host/pre-step-persistence.test.mjs</files>
  <action>追踪共享批执行器和所有调用方，将未投递候选与已接纳消息区分；复用宿主持久事实和现有来源身份，保留合并消息内成员身份，不在两种挂载路径分别补丁。</action>
  <verify>node --test "$Repo/test/host/pre-step-wiring.test.mjs" "$Repo/test/host/pre-step-persistence.test.mjs"；新增断言：首阶段剥离后晋升可补发，接纳后只出现一次，reject/取消不误记账，独立和协调路径一致，重挂/恢复不重复。</verify>
  <security>覆盖主会话、子代理、兄弟作用域隔离；不得绕过外层门控或恢复已被策略禁止的内容；独立指令文件授权边界保持不变。</security>
  <done>真实接纳决定去重，R1 反例转为通过的回归，并保留压缩、合并身份与 disposer 语义。</done>
</task>
<task type="auto">
  <name>T3：修复 R2，资格判定先于 ST 副作用</name>
  <files>engine/executor.mjs；engine/st-render.mjs；engine/condition.mjs；test/engine/st-render-macros.test.mjs；test/engine/official-variable-regression.test.mjs</files>
  <action>在既有执行资格路径控制求值，复用已编译条件；避免渲染器自行复制不完整的判定。保留已经验证的每步变量帧和合法跨层引用。</action>
  <verify>node --test "$Repo/test/engine/st-render-macros.test.mjs" "$Repo/test/engine/official-variable-regression.test.mjs" "$Repo/test/engine/prompt-config-engine.test.mjs"；未命中 setter 不改变量，命中则按既有顺序可读，禁用/受众/去重/晋升对照成立，每步不重复求值。</verify>
  <security>不让未获资格的模板影响其他配置，不引入任意脚本执行；保持会话变量隔离和子代理受众边界。</security>
  <done>R2 行为反例不再成立，既有跨层变量回归保持通过。</done>
</task>
```

## Wave 2：参数来源与共享引擎同步（候选，未授权）

```xml
<task type="auto">
  <name>T4：修复 R3，写入器保留未提供参数</name>
  <files>src/host/write-preset.ts；src/host/preset-package.ts（调用链验证）；src/host/manifest.ts；test/host/preset-package-import.test.mjs；test/host/write-preset.test.mjs</files>
  <action>修正 runtimeOf 的缺参投影，在合并预设后应用必要默认；逐一验证导入、在线重建和离线物化调用，不给调用者复制一套参数展开。</action>
  <verify>node --test "$Repo/test/host/preset-package-import.test.mjs" "$Repo/test/host/write-preset.test.mjs"；真实导入保留锚定、自定义文本、injectPrompt=false 和子代理路由；显式 false/0/空串与省略值分开断言，生成结果与定义一致。</verify>
  <security>不扩大 writer 路径权限；保留 YAML 未知字段、导入版本复检、临时生成后原子替换和失败恢复；模型路由不写入凭据。</security>
  <done>R3 真实导入反例修复，所有调用方共享同一缺参语义。</done>
</task>
<task type="auto">
  <name>T5：修复 R5，编辑器参数桥只投影已提供值</name>
  <files>src/shared/engine-params.ts；src/host/manifest.ts；engine/compositions/source/local/filesystem-editor.yml（读取现有默认）；test/shared/engine-param-schema.test.mjs；test/host/engine-params-bridge.test.mjs</files>
  <action>去掉 editor-default 在参数省略时的运行时补值，保留数值转换、合法值校验与已有 UI/组合默认；核对正向装配和反向回显同源。</action>
  <verify>node --test "$Repo/test/shared/engine-param-schema.test.mjs" "$Repo/test/host/engine-params-bridge.test.mjs"；覆盖无参数无行配置、行配置 32000、显式参数 48000 三态及非法输入；生成和回显一致。</verify>
  <security>保留数值范围校验，不将任意行配置、路径或凭据暴露给浏览器；bridge 白名单不变。</security>
  <done>R5 回归通过，默认值不再越级覆盖作者明确声明的行配置。</done>
</task>
<task type="auto">
  <name>T6：修复 R4，共享引擎指纹包含内容</name>
  <files>src/host/write-preset.ts；test/host/write-preset.test.mjs</files>
  <action>用 node:crypto 在现有有序目录遍历中计算路径与内容摘要，保留 compositions 排除约定、无变化短路、原子交换和锁重试；不增加新依赖。</action>
  <verify>node --test "$Repo/test/host/write-preset.test.mjs"；同大小内容变化必须刷新，完全不变不重写，文件新增/删除也刷新；失败替换保留可恢复的旧引擎。</verify>
  <security>保持根目录与树校验、符号链接边界和插件拥有目录限制；测试使用临时 DSH_HOME，禁止同步或清理真实用户资产。</security>
  <done>R4 等字节反例转为通过，既有同步安全性和无变化行为保持。</done>
</task>
```

## Wave 3：扩展策略与当前宿主能力契约（候选，未授权）

```xml
<task type="auto">
  <name>T7：修复 R6，自定义策略许可与消费一致</name>
  <files>engine/prompt-config-engine.mjs；engine/schema.mjs；engine/strategies.mjs；engine/layers.mjs；test/engine/prompt-config-engine.test.mjs</files>
  <action>追踪策略绑定全部调用方，按既有支持声明让 runtime-context 消费自定义 resolver；在入口统一解析相对策略目录，不依赖测试 cwd。继续拒绝没有策略消费通道的层。</action>
  <verify>node --test "$Repo/test/engine/prompt-config-engine.test.mjs"；临时自定义模块在 pre-step/runtime-context 实际调用并返回动态内容，相对与绝对 URL 指向一致；不支持的组合挂载时报错，释放后 provider 不残留。</verify>
  <security>自定义模块沿用可信插件代码边界，不扩大上传或配置路径权限；隔离模块测试目录并清理，不吞掉挂载校验错误。</security>
  <done>R6 两个反例修复，能力矩阵、路径说明与实际行为一致。</done>
</task>
<task type="auto">
  <name>T8：修复 R7，深思门适配当前持久事件</name>
  <files>engine/deliberation-gate.mjs；engine/shared.mjs（复用已有读取/文本辅助）；test/engine/injection-gates.test.mjs</files>
  <action>保留现有模块接口，冷恢复与实时消费共用处理函数；turn/start 建立当前轮预算，assistant/message 计入可获得文本，避免 message 与 stream 双计；替换过时 chunk 桩。</action>
  <verify>node --test "$Repo/test/engine/injection-gates.test.mjs"；使用已安装 Session 的合法事件和 surface 标记，验证充足首轮放行、无文本次轮受门、阈值 0、冷恢复等价、子代理选项和每轮上限。</verify>
  <security>不扩大工具授权，不保存或回显用于计数的原文；保持 opt-in、同步预算判断和会话隔离。</security>
  <done>R7 当前宿主反例修复，真实事件下的实时路径与冷扫描一致。</done>
</task>
<task type="auto">
  <name>T9：修复 R8，推进工具在阶段目录中可见</name>
  <files>engine/tool-bootstrap.mjs；test/engine/promotion-gate.test.mjs</files>
  <action>在既有阶段 keep 集合保留实际注册的 stageAdvanceTool；用注册结果构造装配输入，验证目录而非仅人工触发推进事件，不新建阶段服务。</action>
  <verify>node --test "$Repo/test/engine/promotion-gate.test.mjs"；预放 0 时默认/自定义推进工具可见，推进后下一档开放，未解锁业务工具仍不可见，默认预放与子代理语义保持。</verify>
  <security>仅保留该模块注册的控制工具，不放开未授权业务工具；现有工具策略、作用域和 disposer 继续生效。</security>
  <done>R8 目录反例修复，注册、提示和筛选对工具名称保持一致。</done>
</task>
```

## Wave 4：文档、完整验收与归档（依赖选定修复完成，未授权）

```xml
<task type="auto">
  <name>T10：同步稳定契约并完成所选范围交付</name>
  <files>docs/engine-reuse.md；docs/architecture-params.md（仅所选参数变化涉及）；本 PLAN；所选任务对应测试及脚本生成的分发快照</files>
  <action>将 A1 的三类依赖和选定修复后的稳定行为写入权威文档；通过项目脚本生成所需产物，逐项复核主线程/子代理结果，补齐实际验收记录，所选范围完成后原样归档本 PLAN。</action>
  <verify>在隔离 cwd 执行 pnpm --dir $Repo typecheck、lint、test、build 及 git -C $Repo diff --check；核对主会话、子代理、压缩后重晋升、disposer 和复制 smoke。未选任务明确标为不在本轮范围，不冒充完成。</verify>
  <security>不手改或删除分发快照，不提交 lib、秘密、本地记忆或用户文件；不重启服务，任何生效要求仅在交付说明标明。</security>
  <done>所选任务全部验收通过，状态与边界完整；PLAN 原样复制到 .scratch/archive 后移除原件，与该轮改动一并中文提交并推送 origin/dev。</done>
</task>
```

## Wave 5：九层统一编辑方案（已授权，仅文档）

```xml
<task type="auto">
  <name>T11：盘点参数与真实通道，补写九层收敛方案</name>
  <files>本 PLAN；docs/ui-architecture.md、docs/architecture-params.md、src/client、src/shared、src/runtime/settings-bridge.ts、src/host/write-preset.ts 与 engine（只读调研）；本地 daily.md（追加记录）</files>
  <action>复核九层、64 参数、7 附加键、能力和资产编辑入口，写明归属表、前后端共用契约、迁移和候选任务；不实施任何重构。</action>
  <verify>执行内存参数目录断言、回读方案、核对必需章节与新增任务六节点、本地链接和命令；git diff --check，只提交本 PLAN。</verify>
  <security>只读分析源码，未改用户配置、后端白名单或宿主服务；文档不记录秘密，日志不入库。</security>
  <done>方案按要求进入现有 PLAN，证据与未授权实施边界明确，验证后提交并推送 origin/dev。</done>
</task>
```

## Wave 6：九层元数据与参数完整性（候选，未授权）

```xml
<task type="auto">
  <name>T12：建立九层编辑组映射与元数据读契约</name>
  <files>src/shared/engine-capabilities.ts；src/shared/bridge-contract.ts；engine/schema.mjs；src/runtime/settings-bridge.ts；src/client/prompt-tool-types.ts；src/client/data/bridge-transport.ts；src/client/features/prompts/prompt-config-policy.ts；test/shared/bridge-contract.test.mjs；test/client/bridge-client.test.mjs</files>
  <action>扩展现有 displayLayer 的九层类型；由能力定义与少量专用编辑组定义派生主归属和相关层，不再给每个参数复制归属。meta/bootstrap 同源输出 layerOrder 和公开编辑说明，前端消费后删除重复运行时层序清单。只改元数据，不改 hook。</action>
  <verify>node --test "$Repo/test/shared/bridge-contract.test.mjs" "$Repo/test/client/bridge-client.test.mjs" "$Repo/test/client/engine-module-cards.test.mjs"；断言每组主归属唯一、相关层合法、meta/bootstrap 同源、旧数据可读、复制引擎无需 src。</verify>
  <security>只返回白名单的可序列化字段，不输出路径、任意行配置、校验函数或服务实例；不因展示归属扩大写权限。</security>
  <done>同一个组映射可同时供后端说明和前端九层组织使用，运行时层矩阵仍由引擎负责。</done>
</task>
<task type="auto">
  <name>T13：闭合七个已有内容参数的编辑保存链</name>
  <files>src/shared/engine-params.ts；src/shared/param-keys.ts；src/client/locales-params.ts；src/client/data/param-overrides.ts；src/runtime/settings-bridge.ts；src/host/write-preset.ts；test/shared/engine-param-schema.test.mjs；test/client/param-overrides.test.mjs；test/host/engine-params-bridge.test.mjs；test/host/settings-bridge.test.mjs</files>
  <action>将七个已被生成器消费的键纳入类型和共同定义，删除旁路键清单，复用现有草稿/序列化/校验派生；添加字符串和模式校验、中文英文词条、预设级归属，不改变键名。实施前完成选定的 T4/R3、T5/R5。</action>
  <verify>node --test "$Repo/test/shared/engine-param-schema.test.mjs" "$Repo/test/client/param-overrides.test.mjs" "$Repo/test/host/engine-params-bridge.test.mjs" "$Repo/test/host/settings-bridge.test.mjs"；71 键覆盖，七键从有效 bridge 写入到生成及回显，非法值写前拒绝，清空删键，未改动不固化默认。</verify>
  <security>不绕过白名单和值校验，不执行输入脚本；正则沿用既有安全/长度规则，未支持的模式明确返回错误，不写入未知字段。</security>
  <done>七键不再出现“白名单接受但值校验拒绝”的断层，前后端编辑能力一致。</done>
</task>
```

T12 与 T13 可能同时改 shared/bridge/client 类型，默认串行；若委派必须明确互斥文件。T13 涉及 writer 时与 T4/T6 串行。方案不要求先完成不相关的 R1/R2/R6/R7/R8。

## Wave 7：以工具管线卡建立首个完整切片（候选，未授权）

```xml
<task type="auto">
  <name>T14：将 tool-config、tool-filter 与自定义工具纳入工具管线卡</name>
  <files>src/client/app/workspace/pages/EngineLayersPanel.tsx（拟新增页面装配）；MainSessionPage.tsx、SubagentPage.tsx；src/client/features/modules/EngineModuleList.tsx、EngineParamFields.tsx；src/client/features/tools/CustomToolsCard.tsx；src/client/features/prompts/PromptConfigList.tsx；对应 client 测试</files>
  <action>将工具配置、过滤、自定义工具、PTC、编辑器、深思门和提醒集中到 tool-pipeline 能力设置区，允许相关卡嵌入共享控件；保留所有独立管线规则实例卡，不按 layer 去重。复用原编辑器/保存端点，共享控件绑定同一字段草稿和提交动作，实例字段保持按 id 独立。</action>
  <verify>node --test "$Repo/test/client/engine-module-cards.test.mjs" "$Repo/test/client/custom-tool-editor.test.mjs" "$Repo/test/client/module-policy-smoke.test.mjs" "$Repo/test/client/editor-state.test.mjs"；两张同层规则卡参数独立，两个共享过滤控件实时同步，单次修改只保存一次、无循环；新增/删除规则不改共享资产，DOM id 不重复，切层不丢草稿。</verify>
  <security>以实际装配事实判定能力存在，不新增 enabled 假字段或通用写对象；保留预设只读、身份核对和工具批准策略，不改目录过滤的权限语义。</security>
  <done>用户举例的三个功能及其余工具能力直接在工具管线卡内操作，保存往返与原实现一致，该整卡结构可复用于其他八层。</done>
</task>
```

T14 依赖 T12 的归属契约；单纯整卡接管可先验证，不要求先实现所有缺陷修复或七键扩展。完整参数保真验收前仍需完成已选 T4/T5。若单次改动超过约 200 行，按工具管线骨架、普通能力区、自定义工具区拆检查点，不同时重写 store。

## Wave 8：其余层接管与跨卡同步/互斥（候选，未授权）

```xml
<task type="auto">
  <name>T15：归位模型、人设、变量、工具与委派能力</name>
  <files>共用 EngineLayersPanel（拟新增）；src/client/features/models/ModelRouteCard.tsx；src/client/features/persona/PresetPersonaCard.tsx；src/client/features/subagents/DelegationToolsCard.tsx、SubagentToolPolicyCard.tsx；src/client/features/tools/CustomToolsCard.tsx；src/client/features/prompts/PromptConfigsEditor.tsx；src/client/features/modules/EngineModuleList.tsx；src/client/data/use-prompt-tool-store.ts、workspace-drafts.ts；src/shared/engine-params.ts、engine-capabilities.ts；相关 client 测试</files>
  <action>按映射表迁移字段组件，让同一共享参数/结构化资产的跨卡控件绑定同一草稿；主/子页是同源视图，独立实例与不同作用域的参数保持独立。复用已有冲突校验，提供清晰互斥错误；保留当前会话操作通道，删除各处私有状态和重复提交逻辑，不限制同层实例数量。</action>
  <verify>node --test "$Repo/test/client/engine-module-cards.test.mjs" "$Repo/test/client/scope-create-separation.test.mjs" "$Repo/test/client/session-model-face.test.mjs" "$Repo/test/client/module-policy-smoke.test.mjs" "$Repo/test/client/locale-contract.test.mjs"；跨层改共享值即时回显，失败/迟到 blur 不覆盖新值；主子路由不串、实例策略上限不变、独占冲突写前拒绝，普通多系统段合法。</verify>
  <security>展示归类不得当成权限；互斥仍由候选有效配置校验，不静默关闭别人的实例；不把工具目录过滤伪装为授权，不把当前会话模型操作纳入预设保存。</security>
  <done>64 参数及新增七键的存储所有者唯一，多卡同步引用无重复落盘；结构化资产共用草稿，实例参数和未改动内容保持独立。</done>
</task>
<task type="auto">
  <name>T16：补齐九层实例字段与交互一致性</name>
  <files>src/client/features/prompts/PromptConfigFields.tsx、PromptConfigForm.tsx、PromptConfigList.tsx、prompt-config-policy.ts；src/client/data/workspace-drafts.ts；src/client/app/workspace/workspace-browse-state.ts；src/client/locales-prompts.ts、locales-cards.ts；test/client/prompt-config-form-layout.test.mjs；test/client/editor-state.test.mjs；test/engine/prompt-config-engine.test.mjs</files>
  <action>复用层能力矩阵与现有表单，为 runtime-context 名称、agent-request patch/replace、llm-stream mode、tool-pipeline 裁决等现有可编辑实例字段提供可发现入口；保留高级配置和未知字段。完成跨参数搜索、定位、切层草稿保持与只读说明，不增加新运行时能力。</action>
  <verify>node --test "$Repo/test/client/prompt-config-form-layout.test.mjs" "$Repo/test/client/editor-state.test.mjs" "$Repo/test/client/engine-module-cards.test.mjs" "$Repo/test/engine/prompt-config-engine.test.mjs"；九层有效字段可编辑且保存受相同规则限制，停止上限无可写项，结束层只观察；无隐藏重复输入，键盘与错误提示可用。</verify>
  <security>不支持的 subject/match/strategy 仍由后端拒绝；原始 JSON 只能走现有配置校验，不能引入任意路径或脚本编辑；切层不静默删除未知资产。</security>
  <done>九层不仅能筛选卡片，还能找到并正确编辑所属公开参数；交互保持原草稿与权限保护。</done>
</task>
```

T15 按 pre-step 来源绑定、系统段/变量、模型/委派分组检查点执行；涉及托管字段说明时补查 writer、settings-bridge 和 PromptConfigFields，元数据须从已有生成规则与源配置事实派生，不能仅凭 ID 把用户项变为只读。pre-step 单独运行 `node --test "$Repo/test/client/instruction-save-flow.test.mjs" "$Repo/test/host/write-preset.test.mjs"`，验证锚定/引导/注入器唯一写回、局部实例保留、独立指令不进入预设批保存。T16 与 T14/T15 共用表单和层卡组件，应串行集成，避免多个代理同时改页面 owner；复用列表正文，避免挂九个拥有独立保存状态的完整列表。

## Wave 9：行为保持、旧入口清理与九层交付（候选，未授权）

```xml
<task type="auto">
  <name>T17：验证九层编辑重构并更新权威文档</name>
  <files>docs/ui-architecture.md；docs/architecture-params.md；docs/engine-reuse.md；CHANGELOG.md；本 PLAN；相关 shared/client/host/engine 契约测试；脚本生成的必要产物</files>
  <action>删除完成接管的旧表单入口和重复层序/映射；更新过去“公共配置独立显示”的文档和测试断言。用按 owner 的行为用例验证保存保真及只读打开无写盘，再运行完整门禁；记录真实 GUI 构建/刷新验证结果。</action>
  <verify>隔离 cwd 执行 pnpm --dir $Repo typecheck、lint、test、build，git diff --check；补齐计划验收标准中的 71 参数覆盖、各 owner 往返、旧预设无迁移、只读/并发/失败保护；确认现有 3080 GUI 使用了本次受影响 Web 产物。</verify>
  <security>保留 Host/Origin、体积、白名单、预设身份和指令版本守卫；不手改生成目录，不启停现有服务，不提交本地日志或用户变更。</security>
  <done>选定九层重构范围全部通过并有实际验证记录；与 T10 合并执行一次最终文档/归档/提交交付，未选缺陷列为边界，不宣称已修复。</done>
</task>
```

## 回滚与检查点

- 当前只有 PLAN 文档及忽略的本地日志，未修改运行行为；需要撤销已提交计划时用 `git revert`，不清理用户目录或重写历史。
- 未来每个选定任务完成后更新对应状态、验证命令、结果和实际基线。中断时以本 PLAN 中最后一个已验证任务为检查点；恢复前重新检查工作树及宿主依赖版本。
- 代码回滚采用对应提交的 `git revert`；测试数据只清理本任务创建的独立临时根，不触碰真实 DSH_HOME。
- 共享引擎同步和导入继续使用既有临时目录、原子 rename 与失败恢复；发现恢复失败时保留备份并记录现场，不自动删除。
- 若用户只选择部分 R 项，更新需求与授权并据此调整状态；所有选中任务完成后才归档，不以“审查完成”替代“修复完成”。

## 状态

- [✔] Wave 0 / T1：审查证据、PLAN 补录与文档核对完成；本轮仅交付计划，Git 提交推送凭据见交付回执。
- [✔] Wave 1 / T2、T3（R1、R2）：2026-09-20 实施完成并验收（见「本轮修复验收」）；R1 改为「候选生成 vs 宿主接纳确认」，R2 改为「执行器判定获准集合驱动 ST 预求值」。
- [✔] Wave 2 / T4、T5、T6（R3、R5、R4）：2026-09-20 实施完成并验收；runtimeOf 未提供参数不覆盖定义、参数桥 editor-default 只投影已提供值、引擎指纹含内容摘要。
- [ ] Wave 3 / T7、T8、T9（R6、R7、R8）：未启动，等待用户指定修复范围。
- [ ] Wave 4 / T10（A1 与选定范围验收）：未启动；本轮已在 T2—T6 交付内完成所选范围的文档同步与完整门禁，但 A1 三类依赖说明与归档仍待全部 Wave 完成后执行。
- [✔] Wave 5 / T11：已完成九层多实例、共享参数同步/互斥方案、64+7 参数盘点和本地 beta-2-42 结构核对；本轮文档校验与交付记录见下。
- [ ] Wave 6 / T12、T13：元数据与七键保存闭环未实施，等待用户确认方案和相关前置修复范围。
- [ ] Wave 7 / T14：tool-pipeline 整卡切片未实施，依赖 T12；以用户给出的 tool-config/tool-filter/自定义工具归并为首个样板。
- [ ] Wave 8 / T15、T16：其余八层能力接管和九层交互未实施，依赖工具管线切片通过及所选参数保真前置。
- [ ] Wave 9 / T17：清理旧入口、完整门禁及现有 GUI 验证未实施。
- 归档条件（用户 2026-09-20 明确）：PLAN 内全部 Wave 完成后才归档；本轮保持在本目录。

## 验收记录

### 本轮修复验收（Wave 1+2 / T2—T6，基线 25f70d1）

执行目录 `D:\AI\workspase\_temp`（隔离 cwd），Node `v26.7.0`；文件系统用例使用临时目录与临时 `DSH_HOME`，`finally` 清理。命令前先 `pnpm --dir $Repo build` 重建 `lib/`（write-preset / preset-render 类测试 import 构建产物）。

| 任务 | 修改 | 回归证据 | 结果 |
|---|---|---|---|
| T2（R1） | `engine/executor.mjs`：`dedupe=session` 改为「宿主接纳确认」——新增 `confirmDelivered(memo, session, event)`，删除候选入批时的记账；`src/runtime/pre-step-coordinator.ts` 管理路径接入同一确认 | `test/host/pre-step-wiring.test.mjs` 新增 4 条：门控剥离→晋升补发（管理/独立双路径）、接纳后只注入一次 + 快路径独立生效、重挂按持久事实恢复、reject 不记账；`test/engine/prompt-config-engine.test.mjs` 两条旧用例改为「未确认不记账 / 接纳后去重」 | 25/25、76/76 通过 |
| T3（R2） | `engine/executor.mjs`：抽出唯一资格判定 `qualified` 并产出 `eligible` 集合传给渲染器；`engine/st-render.mjs` 预求值改用该集合（无集合时退回保守判定） | `test/engine/prompt-config-engine.test.mjs` 新增 R2 用例：未命中的 setter 不改变量帧（reader 读 fallback），命中时按 order 先行求值 | 通过 |
| T4（R3） | `src/host/write-preset.ts#runtimeOf`：未提供的布尔/字符串参数保持 `undefined`（不再补 `false` / `''` / `true`），显式值（含 `''`）仍生效 | `test/host/write-preset.test.mjs` 新增 R3 用例：省略时保留 `firstTurnAnchor: true` / `firstTurnText` / `injectPrompt: false` / 子代理路由；显式 `false` / `true` / `''` 对照 | 通过 |
| T5（R5） | `src/shared/engine-params.ts#buildEngineModuleParams`：`editor-default` 只投影已提供的正值，非法值不写行配置 | `test/shared/engine-param-schema.test.mjs` 与 `test/host/preset-render-variants.test.mjs` 各新增用例：缺参不补 16000（行级 32000 生效）、显式 48000 优先、非法值回落行配置 | 通过 |
| T6（R4） | `src/host/write-preset.ts#engineFingerprint`：`路径:大小` → 有序路径 + `sha256` 内容摘要（排除 `compositions` 约定不变） | `test/host/write-preset.test.mjs` 新增 R4 用例：等字节内容变化必须改指纹、不变稳定、新增/删除刷新、`compositions` 不计入 | 通过 |

完整门禁（隔离 cwd，`pnpm --dir $Repo …`）：`typecheck`、`lint`、`build`、`git diff --check` 全部通过；`test` 为 **1156 测试全通过（fail 0）**。文档同步：`docs/engine-reuse.md`（会话去重以宿主接纳为准、ST 预求值只对获准配置）、`docs/architecture-params.md`（物化缺省语义「未提供 ≠ 显式空值」、引擎指纹含内容摘要）。

未实施：Wave 3、4、6—9 全部任务；A1 的三类依赖说明仍待 T10；本轮未做 UI 重构、未跑性能基准、未重启或抢占运行中的 DSH 服务。


### 审查阶段已执行（基线 a7c80bc，非修复验收）

执行目录均为 `D:\AI\workspase\_temp`。文件系统反例使用独立临时根和临时 DSH_HOME，并在 finally 清理。Node 版本为 `v26.7.0`；宿主契约以已安装的发布包为准。

| 命令或证据类型 | 实际结果 | 证明范围 |
|---|---|---|
| `node --test --test-reporter=tap 'D:/AI/GitHub/dsh-plugin-prompt-tool/test/engine/*.test.mjs'` | 290 测试，290 通过，退出 0。 | 现有引擎测试基线通过，不代表新反例已覆盖。 |
| `node --test --test-reporter=dot 'D:/AI/GitHub/dsh-plugin-prompt-tool/test/host/pre-step-wiring.test.mjs' 'D:/AI/GitHub/dsh-plugin-prompt-tool/test/host/pre-step-persistence.test.mjs'` | 25 测试通过，退出 0。 | 真实 Cordis 接线、作用域、接管、释放和官方持久回放。 |
| R1：真实 Cordis 门控与批执行器内联断言 | session 去重晋升后正文仍缺失；none 对照补发；退出 0。 | 证实候选记账早于外层门控。 |
| R2：公开编译/执行链内联断言 | 未命中 setter 仍影响 reader；禁用与受众对照正常；退出 0。 | 证实 ST 提前求值遗漏条件资格。 |
| R3：真实 installPresetPackage 隔离导入 | 定义保留值，产物出现禁用、清空、反向启用和路由丢失；退出 0。 | 导入到生成产物的完整调用链。 |
| R4：提取当前源码原函数并用真实临时文件系统 | 等字节修改不刷新，变更长度后刷新；退出 0。 | 原指纹和同步逻辑；根目录守卫在隔离测试中替换，不是实际服务升级验证。 |
| R5：直接调用 renderComposition | 行配置 32000 被缺省 16000 覆盖，显式参数 48000 生效；退出 0。 | 参数桥与真实组合合并。 |
| R6：公开编译/挂载及相对目录反例 | runtime-context resolver 调用为 0；相对目录 ERR_INVALID_URL；断言通过。 | 许可矩阵与消费/路径契约不一致。 |
| R7：真实已安装 Session 事件 | 300 字首轮 deny，空文本次轮 accept；退出 0。 | 当前宿主持久事件适配；测试使用合法 surfaceOp。 |
| R8：注册结果进入 assembly 的对照断言 | 推进工具注册但被裁剪；手工纳入第一档后可见；退出 0。 | 原生模型目录的阶段控制工具可达性。 |
| A1：隔离复制整个引擎的烟测 | 核心注入 COPIED；缺私有服务告警 3 次，补 mount 服务后 3 次挂载；退出 0。 | 核心复制可用及附加适配器的宿主依赖。 |
| `git diff --check` 与 `git status --short` | 格式检查通过；审查后只有用户原有 skills/ 未跟踪。 | 审查未修改源码。 |

反例脚本以 stdin 内联执行，未作为新测试文件保留；修复时先将所选反例转成上述测试入口中的最小确定性回归。主线程已复核采纳的子代理结论。

### 本次补建 PLAN 的文档验收

- 已执行结构与引用核验：必需章节 6 项、任务块 10 个（各含 name/files/action/verify/security/done）、本地链接 29 个、测试引用 13 处、package scripts 4 项全部通过，UTF-8 无 BOM；内联 Node 校验退出 0。
- `git diff --check` 与 `git diff --cached --check` 均通过；暂存文件列表只含本 PLAN，未包含源码、用户已有目录或本地记忆。提交前再次检查最终暂存内容。
- 本次只修改文档，按仓库规则无需重跑 typecheck/lint/test/build；不得把审查阶段的测试结果写成修复后验收。
- 提交与推送结果以交付回执为准，提交前不得宣称已经成功。

### 九层多卡方案增补的文档验收（基线 d415d4a）

- 已读取 UI/参数权威文档、页面装配、能力/参数定义、bridge 保存与 writer 投影；已复核子代理的参数和真实通道证据。用户明确能力进入对应层卡，又澄清同层多实例及共享参数可同步/互斥；最终方案已经撤回固定卡数与唯一可写控件限制，更新任务和验收条件。
- 已只读解析用户提供的 beta-2-42：128 个唯一 ID，pre-step 120（启用18），system-section 8（启用4），全部 mergeMode=merged。结构断言退出0；只在 PLAN 保留数量与身份语义，未复制正文或改写预设。拟用合成 128 卡与 64 系统段数据验证未来重构，这些未来回归尚未运行。
- 在隔离 cwd 执行内联 Node 盘点断言：现有 `ENGINE_PARAM_KEYS` 为 64，额外内容键为 7；七键均被当前值校验拒绝；能力 displayLayer 仅有 system-section/pre-step/tool-pipeline 三种。退出 0，无文件写入；这些是方案依据，未在本轮修复。
- 最终文档校验通过：17 个六节点任务、10 个 Wave、43 处本地链接（含行号检查）、35 处测试引用和4个 package scripts 有效，UTF-8 无 BOM；不存在固定九张卡、跨层强制只读或唯一可写控件的残留约束。内联断言退出0；参考预设的读取前后摘要一致。
- `git diff --check` 通过；受版本控制的修改仅本 PLAN。未修改生产/测试源码，不运行 UI 构建或假称当前 GUI 已更新；纯文档按仓库要求检查路径与命令。
- 初版计划已经在 `d415d4a` 推送 origin/dev；本次增补提交与推送凭据在交付回执记录。实施候选任务仍未启动，计划不归档。

### 后续实施的命令约定

以下是未来修复验收命令，尚未执行为本计划的修复验收。运行各任务中的直接 Node 测试前同样设置隔离环境。

```powershell
$Repo = 'D:\AI\GitHub\dsh-plugin-prompt-tool'
# 通过工具 workdir 指定 D:\AI\workspase\_temp；独立临时根用 New-Item 创建。
$verifyRoot = Join-Path 'D:\AI\workspase\_temp' ('pt-engine-plan-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $verifyRoot | Out-Null
$env:DSH_HOME = Join-Path $verifyRoot 'home'
$env:TEMP = $verifyRoot
$env:TMP = $verifyRoot
try {
    foreach ($gate in @('typecheck', 'lint', 'test', 'build')) {
        pnpm --dir $Repo $gate
        if ($LASTEXITCODE -ne 0) { throw "$gate failed: $LASTEXITCODE" }
    }
    git -C $Repo diff --check
    if ($LASTEXITCODE -ne 0) { throw 'diff check failed' }
} finally {
    Remove-Item -LiteralPath $verifyRoot -Recurse -Force
}
```

## 实施取舍与已知边界

- 本次纠正上一轮仅在会话交付结论、推迟创建 PLAN 的遗漏；当前建档不追加修复授权。
- 只沿既有批执行器、参数桥、策略绑定和能力模块修复，不增加全局调度层、通用生命周期服务或新依赖。
- 相同条件、相同模块共享实现；不同官方插入点、预设定义与指令策略仍保留各自所有权。
- 未验证真实运行服务热更新，未运行性能基准；当前文档修改无需重启或重建预设。
- PLAN 的候选任务不是已承诺实现的范围。用户选定后补录原话与日期，再执行对应 Wave。

## 测试现场与清理限制

审查阶段创建的指纹、导入、引擎复制和测试目录均已 finally 清理；无需要用户清理的已知残留，未发生清理策略拒绝。用户原有 skills/ 未触碰。后续若有清理失败，记录精确临时路径与原因，不用扩大删除范围规避。
