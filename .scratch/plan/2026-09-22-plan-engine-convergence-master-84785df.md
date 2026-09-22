# 引擎收敛重构总纲 PLAN

本文件是「引擎重复面收敛」这一大型任务的总纲：定义分支划分、依赖顺序、全局纪律与验收口径。各分支的原子任务、验收与回滚写在各自的支线 PLAN 里，本文件不重复。

## 需求与授权

- 日期：2026-09-22；基线：`dev / 84785df`（工作树仅含未跟踪的 PLAN 与用户既有 `skills/`）。
- 用户原话（多轮，按时间顺序）：
  1. `继续分析本项目引擎框架, 功能,行为,能力等重复可归一收敛后的新后端框架`；
  2. `应该只使用一套事实源`（针对 `enabled` 与行级 `disabled:` 的关系）；
  3. `这个需要对照st的变量参数行为 再讨论方案`（针对 host 侧不合并 `variables.yml`）；
  4. `F:\ai\other\SillyTavern 这是st源码`（提供对照基线）；
  5. `本项目是预设级 天生带有跨会话持久能力,通过世界书工具 应该可以运行时改写`（对变量作用域的判断）；
  6. 拍板：`enabled` 统一为 **fail loud**；**按 8 支拆**；`2026-09-22-plan-injection-authority-84785df` **放在重构之后**；**本轮只修文档**（变量运行时改写）；**1 份总纲 + 7 份支线**。
- **2026-09-22 评审追加拍板**（用户提出「引擎能力只需判断 + 执行」后）：
  7. `因为有一些是过时设计,用来调整模型能力. 所以本项目需要精简,即引擎能力 只需要 条件判断 行为判断等判断或 字词句锚定 对应执行即可`；
  8. `全删除,只保留机制,同时 subagent-tool-policy tool-config-engine str-replace-editor 是必须保留的功能`；
  9. `删除模块但先重建等价声明`（除 PTC 呈现）+ `pt-cordis 与 beta-2-42 迁到新机制`；
  10. `promoted-code-mode` **移除**（放弃"晋升后才呈现 PTC"的时机特性）；名单语义关切：`主要是黑白名单语义不明, 用户会理解未 白名单中增加 即可使用,黑名单中增加 不可使用`。
- 本轮产出：**只产出 PLAN 文件，不落码、不改测试、不跑门禁**；等用户逐支授权后开工。

## 评审后的架构调整（2026-09-22）

用户主张「引擎只需判断 + 执行」，经逐能力核实**成立**：

- 10 个能力里 **7 个是「判断 → 执行」**（`tool-filter`/`tool-bootstrap`/`context-gate`/`anchor-turn`/`deliberation-gate`/`progress-reminder`/`promoted-code-mode`），**3 个是能力提供者**（`subagent-tool-policy`/`tool-config-engine`/`str-replace-editor`，用户确认必须保留）。
- **判断需七类原语**：文本锚定 ✅已有(`anchor-match`) / 相位 ✅已有(`compaction-epoch`) / 来源 ❌ / 计数阈值 ❌ / 名单 ❌ / 会话状态 ❌ / **当前预设** ❌（取法唯一正确：`composedPreset(agent.ctx)`，见下）。
- **执行需四类动作**：注入文本 ✅ / 改装配 ❌分散 / 裁决 ❌分散 / 追加上下文 ❌分散。
- **六类判断里 `deliberation-gate` 属"计数阈值"而非字词锚定**（`deliberation-gate.mjs:12-13` 用的是轮内字符数），做词检测的 `classifyReasoning` 在 `compaction-epoch.mjs:37-53` 仅服务 `promoteGate`——所以"字词句锚定"单类覆盖不了深思门控。
- 七个模块的"过时"依据：6 个移植自已进入维护期的上游 `dsh-anchored-standard`（其姊妹项目作者已公开勘误强归因理论），且其中 5 个在真实部署的任何预设里都未挂载。

**因此本轮的最终形态是**：`引擎 = 触发器引擎（判断原语 + 动作库）+ 3 个能力提供者`，原 7 个专用模块**先重建为等价声明、再删除**（PTC 呈现为唯一净损失）。

### 外部项目实证补充（2026-09-22，来源 dsh-agent-studio）

对标项目 [dsh-agent-studio](https://github.com/thissensen/dsh-agent-studio)（`0.1.2`，18,260 行，可视化配置 Agent 的提示词 / 工具 / 技能 / 子代理 / 备用模型）的源码注释里有大量 DSH 宿主「源码 + 真机双重确认」的取证。三条已核实并落入本 PLAN：

| 实证 | 对本项目的意义 | 落点 |
|---|---|---|
| `assembly.tools` 在 waterfall **之前**按当时工具视图求值完毕；**PTC 的 `tools:sdk` 是与它并列的第二条投递通道**，由平台按视图生成 | 本项目 `tool-filter` 只改数组、**不改视图** → PTC 下被剔除的工具仍可能出现在 SDK 声明里被模型看到并调用（**安全边界缺口**） | **B3 T2**（新增第五类动作：裁 SDK 声明文本）+ **B7 §5 / T1**（`tool-filter` 声明必须含裁剪） |
| 平台**切换预设不重建 agent、不发 `agent/created`**（只 `rebind` standing scope），依赖创建窗口的挂载会错过时机；补救点是 `tools/change` | 本项目已有 2 处 `tools/change`（`run-code-env.mjs:176`、`subagent-tool-policy.mjs:263`），但覆盖的是**工具注册层**，**视图/呈现层**没有补救 | B7 迁移纪律（记录为设计约束） |
| 「没生效」有多种原因而**结果长得一样**（缺 agent / 解析不出预设 / 未绑定 / 被删），用一行**决策链日志**一次给全 | 本项目目前是零散 `warnOnce`，没有"为什么这次没生效"的完整依据 | **B3 T5**（每会话一次决策链诊断，默认关闭） |
| **四种「当前预设」来源里只有 `composedPreset(agent.ctx)` 正确**（官方 `index.ts:504-505` 服务方法就是模块导出 `standingMountFor` 的包装、`invariant.ts:48` 内核自用、`child-agent.ts:145` 子代理继承也用它、`session.ts:12` 明写重建**绝不读 header**）；`undefined` = 该 agent **没有预设**，不得回落默认值。**但它是进程内取法**：官方客户端 remote 只暴露 `list/read/copy/deletePreset/select`（无 `composedPreset`），session-controller 对外给的"会话当前预设"读的是**会话投影**（`agent.ts:361/515`、`skill-catalog.ts:47`）——**两种取法是分工不是替代** | 本项目客户端读会话投影 → **与官方契约一致，不改**；host 的 `agent-presets.default` 语义正确（"新会话默认"）；**缺**一个进程内"取当前 agent 预设"的工具 | **B3 T1**（第 7 类判断原语 + 三条硬约束 + 适用边界） |

**记录备查但未纳入本轮**（设计模式层面可借鉴）：三层收窄的判据同源（视图 `restrict` / 投递 `restrictToolSchemas` / 执行 `guard`）、文本裁剪的保守失败 + 删后自校验、每层挂载失败就地隔离（对应本项目「引擎行 `apply` 抛错会拖垮整个 preset 挂载」的既有教训）、跨供应商模型候选链与重试码表、工具来源归因、按 agent 裁剪技能面。

## 审查结论

### 2026-09-22 源码对照复审：原则成立，当前任务拆分尚不可直接实施

本次用户追加要求：`对照方案中提到的官方dsh源码,和对应的借鉴的项目源码,保证这次重构原则 引擎 = 触发器引擎（判断原语 + 动作库）+ 3 个能力提供者`。

**固定架构约束**：最终只保留一套触发器运行时，三个能力提供者为 `subagent-tool-policy`、`tool-config-engine`、`str-replace-editor`。七个旧专用模块按既定方向退出；修正下列问题时，把行为迁成声明、补齐通用动作与既有提供者接线，不能以保留旧模块、增加第四个专用提供者或建立第二条执行管线来绕过。

**审查判定**：可以达到这一结构，但现有 B0–B8 尚有 13 项需要修订的执行/验收问题。以下是本次审查记录；后文与支线原任务块保留历史，不能将其相互矛盾的内容同时视为已通过。审查不授权落码，也不把建议中的能力放弃、兼容变化或新 UI 范围视为用户拍板。

#### 对照基线与可采用的机制

外部项目均只读；没有修改或重启宿主。引用的真机现象属于参考项目的记录，本次没有重新做真机复现。

| 源码基线 | 本次直接核对的实现 | 对本次重构的约束 |
|---|---|---|
| 官方 DSH `ddefc45fbc7f8e46dd73185e68295696d1297887`；安装包 `@deepseek-ai/dsh-tools@0.1.6-alpha.2`、Cordis `4.0.2` | `packages/core/system-prompt/src/index.ts:605-633`；`packages/core/tools/src/index.ts:1106/1158`；安装工具包 `lib/index.js:1402/2518/2743`、`lib/types/index.d.ts:619/630` | 装配内容在 waterfall 前求值；complete/context 抑制仍由官方最终收口。工具视图、SDK、执行绑定有关联，但文本裁剪本身不限制执行。动作必须接公开 seam，不能伪造全局顺序或绕过官方最终裁决。 |
| 官方 agent-presets，同一源码基线 | `packages/preset/agent-presets/src/index.ts:504-505/672-698`；已发布传递依赖的 `lib/types/index.d.ts:46/246` | 进程内使用 `composedPreset(agent.ctx)`；切预设重绑 scope 后发 `tools/change`。服务缺席与已返回 `undefined` 分开处理；后者不回落默认。客户端保留会话投影。 |
| `dsh-agent-studio` `9b07053a3e6595dfe627e2964b2b86372ddb955c` | `src/host/apply.ts:727-765/1067-1087/1111-1136`；`src/host/sdk-strip.ts:1-20` | 真实实现同时使用同判据的 restrict、投递过滤、guard；SDK 裁剪是执行已经受限后的呈现补救。不能只移植裁剪而省掉执行边界；也不照搬其 settings 所有权和机制工具豁免名单。 |
| `dsh-anchored-standard` `180184c252fbbf23dcf0f608fef6ea4c63a78a15` | `shared/context-gate.mjs:141-183`、`shared/deliberation-gate.mjs:20-42`、`shared/cot-drip.mjs:82-138`、`shared/tool-bootstrap.mjs:287-297` | 可抽取来源/相位/计数判断及过滤、裁决、追加、请求字段动作；旧默认措辞、阈值和模型归因留在可选预设声明，不进入机制默认。 |
| `dsh-router-standard` `b39112dce54b90e67b50b166c2773861d7945d1f` | `preset/router-standard/router-bootstrap.mjs:621/703/787-819`；`docs/statement.md:5-35` | stages 包含工具注册、状态推进和工具面更新三个职责；应拆到已有工具提供者与触发器，不能仅因动作库没有注册工具就判定不可保留。其具体阶段、文案、持久状态格式不照搬。 |
| `dsh-purge` `b0a53211514bb39745633349179dbae24c4f4294` | `lib/index.js:207-237`、`lib/identity.js:199-204` | `global + prepend` 是顺序反例，不是本项目应复制的注册方式；其插件名子串匹配也不替代已拍板的大小写不敏感精确匹配。 |

上游维护状态不构成删除行为的技术证明：`dsh-anchored-standard/FAREWELL.md` 说明停止主动开发；`dsh-router-standard/docs/statement.md` 明确作废理论强归因、保留工程实现。本项目移除专用模块的依据是用户确定的机制化方向，不能据此额外推导“已有功能无须迁移”。

#### 旧能力如何归入固定架构

以下是职责映射与验收约束，不另建一套按旧模块名分派的动作实现。

| 旧能力/职责 | 判断原语与状态 | 动作或提供者归属 | 必须证明的行为 |
|---|---|---|---|
| tool-filter | 名单、条件、受众 | 同一名单判据驱动工具呈现过滤和官方执行 guard；可用处复用 scope restrict | native 与 PTC 子调用均受约束；本层工具、晚注册工具、名单空值、子代理豁免与 disposer 可验证 |
| context-gate | epoch/晋升、来源、延迟计数 | assemble contexts 过滤 + pre-step 消息过滤 | claimed 批、reject、独立指令来源、成功/失败压缩均保持既有语义 |
| anchor-turn | 首个真实 user/message 尚未落盘、消息来源 | 官方 inbox prepend 动作 | 只在合适窗口锚定，不被自身插件消息递归触发 |
| deliberation-gate | 轮内字符数、裁决次数、受众 | 工具调用裁决动作 | 字符数不是词匹配；记录是否可重建、计数顺序与轮边界必须明确 |
| progress-reminder | 结果次数、轮号、已投递次数 | post-execute additionalContexts | 只在 accept 结果追加；并发、每轮上限、取消/错误不改变计数契约 |
| tool-bootstrap 的窄化、预算、人设段 | 晋升/epoch、工具名、阶段、section 名 | 工具面过滤、agent/request 字段覆盖与释放、sections 过滤 | 三项都是可声明行为；预算释放不能误清除后续其它来源设置的值 |
| tool-bootstrap 的 stages 推进工具 | 工具事件与会话级阶段状态 | 工具定义归 `tool-config-engine`，状态变化与后续过滤归触发器 | 现有提供者只有 shell/http/delegate/fs/ask-user 执行形态，不能声称已经支持机制调用；需补一个最小受控接线方案及行为证明，不能用 shell/HTTP 绕路或增加第四个提供者 |
| promoted-code-mode | 原有相位呈现不迁移 | 按已有拍板删除；需要静态 PTC 的预设复用官方 tool-presentation | 静态呈现与“晋升后切换”区别明确，切换预设后的首个请求正确 |
| 三个保留提供者 | 各自既有配置与授权 | 子代理策略、自定义工具、官方 str_replace_editor | 保留扩权审批、工具 approvalGate、文件系统作用域；不归入普通 predicate 副作用 |

提供者的文件归属也要校正：`str-replace-editor` 由 `engine/compositions/source/local/filesystem-editor.yml:20` 引用官方 `@deepseek-ai/dsh-tool-str-replace-editor`；B3 T4 列出的 `engine/tool-git-bash.mjs` 实际提供 bash，并不是第三个指定提供者。官方适配、纯函数库、已有角色/世界书/技能接线不等于新增一类引擎能力提供者，但也不能凭“三个”这个数量顺手删除这些既有职责。

#### 开工前必须修订的问题

**R1 / P1：能力净损失超出本 PLAN 记录的授权。**

- 位置：B7 T1（第 89 行）与其已知边界；本总纲“需求与授权”第 9–10 项及“PTC 呈现为唯一净损失”的陈述。
- 证据与影响：B7 又要求放弃 `stages`、`bootstrapMaxTokens`、`personaSectionsOnly`。本项目 `engine/tool-bootstrap.mjs:428-440` 是 sections 过滤，`:454` 起是请求预算逻辑，后两项根本不依赖工具注册。“动作库不注册工具”不能证明这三项都必须丢弃。
- 修订要求：把这些行为的声明映射补齐；若要净删除，逐项保留为尚未确认的范围变更。不得为满足固定架构而保留旧模块，也不得把实现缺口自动当作功能删除授权。

**R2 / P1：B1 的“等价 helper 替换”包含非等价写入。**

- 位置：[B1 T1](2026-09-22-plan-engine-b1-helper-convergence-84785df.md)，第 46 行。
- 证据与影响：`engine/shared.mjs:155-163` 的 `sessionMapGet` 只在键缺失时创建；`engine/compaction-epoch.mjs:140-146` 在成功压缩时必须覆盖已有键，`engine/tool-bootstrap.mjs:255-269` 的容量检查服务于已有阶段推进。直接替换会留下旧 epoch 或丢掉阶段更新。`engine/strategies.mjs:100-108` 尚无首个 assistant 消息时不缓存 false，也不能无条件包进 helper。
- 修订要求：替换白名单只列真正的 get-or-create，其余保留覆盖写入和条件缓存；验收加入成功压缩、已有键更新、首个 assistant 延迟到达序列。

**R3 / P1：B4 把 stages 不复位扩大成 tool-bootstrap 整体不复位。**

- 位置：[B4 T2](2026-09-22-plan-engine-b4-session-state-84785df.md)，第 78–79 行。
- 证据与影响：`engine/tool-bootstrap.mjs:243-299` 的阶段不因压缩重置；`:299-306` 的 promotion 仍观察会话事件，并在成功压缩后创建新 epoch，`:406-419` 据此恢复 compaction 工具窗口。模块级“不订阅复位”会失去压缩后的窄化与重晋升。
- 修订要求：按状态字段声明 resetOn，分别验证阶段保留、晋升复位及失败压缩不复位，不按旧模块名决定复位策略。

**R4 / P1：只裁 SDK 文本无法保证黑名单工具不可调用。**

- 位置：[B3 T2](2026-09-22-plan-engine-b3-capability-runtime-84785df.md)，第 108–110 行；B7 的 PTC 验收；总纲原“仅备查”的三层收窄条目。
- 证据与影响：已发布工具包 `lib/index.js:1402-1407` 在 run_code 执行时从 `registry.schemas(exec.agent)` 建绑定，不从裁过的 SDK 正文建绑定。知道旧工具名仍可调用；裁剪解析失败又要求回原文。该包 `:2518-2520` 同时支持 TypeScript/Python，原方案只认 TS interface，Python 会直接漏过。
- 修订要求：同一名单 predicate 同时供呈现动作和执行 guard 使用；scope restrict 仅处理它能限制的继承面，本层/晚到工具仍由 guard 裁决。SDK 必要时按更新后的视图通过官方 `sdkSection().text(context)` 重生，剩余呈现补救不能代替执行边界。验收必须包含真实 PTC 子调用拒绝、TS/Python、预设切换首请求、主子代理隔离、挂载失败与 disposer；不增加独立策略提供者。

**R5 / P1：B7 先删后迁，与共享 .engine 的提交及回滚顺序冲突。**

- 位置：[B7 T2/T3](2026-09-22-plan-engine-b7-capability-consolidation-84785df.md)，第 102/115 行；总纲“数据侧无需回滚”。
- 证据与影响：任务顺序是先删模块，后备份/迁移。实际引用是 `../.engine/`（`src/host/write-preset.ts:330`），任一重建在单预设提交前就刷新共享引擎（`:571`），成功刷新会删除旧引擎备份（`:173`）。第一个预设重建后，未迁移预设便可能找不到旧模块；仅 revert 代码并恢复两个预设目录不能恢复磁盘共享引擎。
- 修订要求：先备份定义、生成目录、共享引擎及指纹；旧模块仍可用时完成全部候选迁移与隔离装配，再切换、删除。利用既有 materializeOnly/候选路径，明确失败恢复整个相关集合的顺序；补“第二个预设迁移失败”断言。不启停在役服务，交付由用户重启生效。

**R6 / P1：声明的存储—装配—迁移链没有闭合，B8 又依赖已删除的入口。**

- 位置：B3 T3 的 `trigger({...})`；B7 T1 的“落位由 B3 决定”、T3；[B8 T9](2026-09-22-plan-injection-authority-84785df.md)，第 195 行。
- 证据与影响：B3 定义了运行时 API，却未明确声明在 preset.yml 的位置、校验/物化/加载入口及与已有 promptConfigs 的关系。B7 对 pt-cordis 只删旧行，没有要求装配替代 bootstrap 声明；旧组合默认就有窄化行为（`engine/compositions/source/local/tool-bootstrap.yml:9`）。B8 仍把 blockedPlugins 写到已删除的 context-gate card/row，且要求 UI 可见可存；B7 却删除该卡、不新增声明编辑入口。
- 修订要求：先确定由 preset.yml 拥有的声明契约，沿既有 writePreset/rebuildPreset 接入同一触发器运行时；promptConfigs 与迁移声明不能各自保留独立的判断/执行实现。迁移旧配置时计算组合默认、moduleConfigs、参数桥的最终有效值，逐项转换并实际挂载。将 B8 的存储与编辑任务重写到新入口；用“保存→重建→重载→首次/晋升后/压缩后执行”验收，不以无加载错误代替等价证明。

**R7 / P2：B3/B4 互为前置，B6 也依赖 B2 明确不产出的声明。**

- 位置：B3 第 74/120–124 行、B4 第 7/65 行、B2 T2 与 B6 T1。
- 证据与影响：B3 只消费 B4 的 session()，但 B4 等 B3 完成；当前 shared 没有该接口。B2 不迁移七个待删模块，B6 却在 B7 前要求每个绑定模块均有字段声明。各支独立验收无法按总纲线性顺序满足。
- 修订要求：把最小状态接口先置于 B3，B4 只做后续迁移，或显式拆前置/后置阶段；B6 只检查当时存在的声明，迁移声明的闭合检查随 B7 交付。依赖图、文件冲突表和独立回滚范围同步更新，后继依赖未撤回时不能承诺任意单支 revert 都不波及其它支线。

**R8 / P2：B4 的 WeakMap 替换不是零行为重构。**

- 位置：B4 T1 第 65–66 行及其“GC 即归零”边界。
- 证据与影响：`progress-reminder` 的计数不可冷扫重建；原 Map 达 4096 会话会清空其它仍存活会话的预算，新 WeakMap 不会。保持所有 session 对象存活即可确定性观察到提醒次数差异，不能用“差异可接受”断言冒充等价；session.id 与对象身份也不是同一契约。
- 修订要求：先统一访问接口，保留各状态的键、淘汰与复位语义。若改策略，单列为行为变更，覆盖存活会话超限、同 id 不同对象、重挂与恢复，不把现有 WeakMap 用例当作宿主对象永不重建的证明。

**R9 / P2：B6 把编辑草稿、参数桥表示和运行时缺省要求为原值相等。**

- 位置：[B6 T1](2026-09-22-plan-engine-b6-cross-layer-mirrors-84785df.md)，第 91–92 行。
- 证据与影响：`src/shared/engine-params.ts:212` 明说 defaultValue 是编辑草稿；contextGateEnabled 草稿 true 与引擎缺省 false 分工不同，bootstrapMaxTokens 草稿 0 经桥转换成删键，不能直接送入正整数校验。强制类型/默认相等会持续报红，或迫使修改清空/关闭语义。
- 修订要求：校验“草稿/保存输入→参数桥→引擎有效配置”的行为闭合；运行默认仍归组合源，UI 元数据仍归 src，不把不同表示的刻意转换当作重复事实源。

**R10 / P2：B2 除 enabled 外还改变缺字段与未知键行为。**

- 位置：[B2 T4](2026-09-22-plan-engine-b2-config-contract-84785df.md)，第 107 行，与第 9/116 行的唯一行为差异承诺冲突。
- 证据与影响：`engine/subagent-tool-policy.mjs:37/53` 当前有默认路径/provider，`engine/tool-config-engine.mjs:370` 的降级也允许缺目录；改为缺键 fail loud、未知键拒绝会影响复制引擎、手写组合与旧生成目录，更新包内 yml 不会自动迁移它们。
- 修订要求：保留兼容，或明确列出严格化的迁移范围、旧输入→新输入映射和装配失败恢复。T2 已缩到两个模块，完成条件与状态仍写 9/12 个，也要按真实迁移范围同步。

**R11 / P2：B0 指定守卫无法捕获其承诺的三处漂移。**

- 位置：[B0 T1](2026-09-22-plan-engine-b0-guards-docs-84785df.md)，第 49–50 行。
- 证据与影响：T1 检查 writer/index/config 参数键与 yml 落点；已知漂移却分别在测试 ALLOWED 镜像、bridge content 联合、文档模块计数。检查对象不同，修正这三处不会让所列四类检查由红转绿。
- 修订要求：对三处漂移分别指定真实白名单双向校验、content 值域闭合、文档计数核对；四类新增守卫用对应的定向变异证明有效，不能把检查任务写成不存在的红绿因果。

**R12 / P2：B6 两条加载路径的差异不止变量合并。**

- 位置：B6 T4/T5 第 128–139 行。
- 证据与影响：host 的 `src/host/prompt-configs.ts:264/279-284` 还有空路径短路、对象/id 校验、带文件名的错误；引擎 `engine/schema.mjs:71-88/108-118` 的 JSON 形状校验阶段和错误类型不同。直接共用 parser、只对拍 variables 差异，会改变编辑端的拒绝与诊断行为。
- 修订要求：只共享确实等价的扫描/读取/解析步骤，两个边界保留各自校验与异常包装；以 `{}`、JSON 标量/数组、YAML 非对象、空路径和不可读目录验证旧新各自等价。

**R13 / P2：数字 order 不能直接映射为 Cordis 的布尔 prepend。**

- 位置：B3 T3 第 121 行；总纲将 B8 ②“退化为触发器优先级”的陈述。
- 证据与影响：Cordis `src/events.ts:234-243/254-257` 只有外层 waterfall 与 unshift/push；多个 prepend 的顺序由注册先后反转，并不比较数字，next 前后也有不同的执行方向。直接映射无法兑现声明间稳定排序，更不能提供跨插件最终否决。
- 修订要求：分别定义“同一官方通道的声明顺序”和“适配器在宿主 waterfall 的位置”；前者稳定排序且注明 next 前/后阶段，后者保持既有布尔注册策略，B8 再处理明确获准的改变。禁止跨九层全局调度，也不以 prepend 替代单调执行 guard。

#### 固定架构的最终验收门槛

1. **运行时唯一**：六类被迁能力及既有提示词配置复用同一判断/动作实现；旧模块删除后，不能在 actions 内按旧模块名恢复六套私有状态机与 listener。
2. **规则与机制分离**：谓词读取事实并返回判断；计数/epoch 状态由有明确生命周期的事件处理更新；文案、阈值、名单、可选模型增强属于预设声明。诊断能力只记录事实，不成为第二套状态事实源。
3. **提供者恰为指定三类**：需要注册模型工具的行为通过已有提供者；工具注册、执行授权与触发规则之间有明确接口。str_replace_editor 仍用官方包，不能用 bash 模块代替。
4. **官方契约保持**：每个动作标明事件、输入/返回形状、next 前后阶段、受众、失败语义与 disposer；使用同一份宿主服务/包实例。当前预设模块兜底如确有必要，复用 `engine/host-package.mjs` 的宿主解析链，在注册期加载，不能在同步 predicate 内做 IO 或静态导入另一份 live registry。
5. **行为证明覆盖全链**：主会话、子代理、成功/失败压缩、重晋升、切换预设首请求、晚到服务/工具、重挂与 disposer；工具名单另覆盖 PTC 实际调用。新旧对拍必须在迁移后的真实装配链执行，不只证明两个纯函数输出相同。
6. **迁移可退**：定义、共享引擎与生成目录作为相关资产核验；未知用户字段和指令文件所有权保留。先确认全部目标候选可装配，再删除旧实现；部分失败能恢复，且不操作在役服务。

#### 本次已执行验证与限制

- 基线：本仓库 `84785dfab18d12dc64b6e9c5cd865a13f21ef3ff`；总纲、B0–B8 与上述源码逐项对照，三个只读子代理的结论由主线程复核。
- 在 `D:\AI\workspase\_temp` 运行 Node 内置 assert 的无文件探针，两项通过：①真实 epoch tracker 成功压缩会复位，而 `sessionMapGet` 对已有键保留旧值；②真实 progress-reminder 在保持 4097 个会话对象存活时发生 Map 清空并重新允许提醒，证明纯 WeakMap 行为不等价。探针只调用进程内逻辑，没有写盘或接触在役服务。
- 本次只追加审查文档与本地项目记忆；不修改支线任务块、源码、测试和用户预设。未执行完整 typecheck/lint/test/build，也不声称完成任何重构或真机验收。全部支线仍未开工，总纲尚不归档。

### 原始重复面勘察（保留历史）

引擎根目录 37 文件 6928 行（35 `.mjs` + 2 `.d.mts`，不含 `compositions/` 与 `vendor/`），内部依赖 55 条单向边、**无循环依赖**。已有的成功归一层：`shared.mjs`(163) / `schema.mjs`(532) / `condition.mjs`(83) / `compaction-epoch.mjs`(150) / `anchor-match.mjs`(137) / `tool-definition.mjs`(140)。

问题不是"重复不好看"，而是**手工同步面已开始出错**。四个重复面：

| 面 | 核心事实 | 归属支线 |
|---|---|---|
| 配置契约 | 11 个等价归一化 helper（同一句错误文本 4 份实现）；`undefined` 处理 7 种；`enabled` 2 种语义且 3 个模块无该键；4 个插件行无白名单；同名 `booleanOption` 两种相反策略 | B2 |
| 会话态与生命周期 | `sessionMapGet` 全仓零调用，等价逻辑手写 8 处以上、淘汰策略 2 种；键类型不统一；`compaction/end` 复位只有 1 处；9 个模块无 disposer | B1 / B4 |
| 注册样板与降级 | 18 个 waterfall 监听器 + 15 处同步旁听、三种改写姿势；`createWarnOnce` 3 份实现；降级兜底 4 类语义、文案格式不统一；`{global:true}` 零出现、`{prepend:true}` 仅 4 处 | B3 |
| 跨层镜像 | 参数目录 71 键平均出现在 5.39/14 个候选文件；**三处已漂移**；host 13 类候选中 10 类重写引擎逻辑；bridge 载荷形状两端各写一遍；客户端多张手抄表 | B0 / B5 / B6 |

**三处已漂移（实证，非理论风险）**：

1. `test/host/engine-params-bridge.test.mjs:260` 的手抄镜像 `'tool-filter': new Set(['allow','deny','enabled'])` 缺 `includeSubagents`，与 `engine/tool-filter.mjs:34` 不一致。
2. `src/shared/bridge-contract.ts:280` 的 `content` 联合多出 `'observe'`，引擎 `LAYER_EDITING` 从未产生该值。
3. `docs/engine-reuse.md:23` 称 `library`「22 个模块」，实际 24 个。

**另有一处文档承诺了不存在的能力**：`docs/architecture-params.md:130` 称空值占位键「供内部世界书工具（`world_book_upsert`）动态登记与调整」；该工具（`src/runtime/world-book-tools.ts:134-151`）只写世界书条目，不写变量。用户对此的判断「预设级变量天生跨会话持久」**正确**，「通过世界书工具可以运行时改写」**不成立**——运行时写变量的通道只有工作台 `/preset-variables` 端点（人工编辑）。按拍板：**本轮只修文档**，不实现该能力。

## 影响面、依赖与护栏

### 文件冲突矩阵（决定执行序）

| 文件 | 被哪些支线涉及 | 约束 |
|---|---|---|
| `engine/{context-gate,tool-bootstrap,tool-filter,anchor-turn,deliberation-gate,progress-reminder,promoted-code-mode}.mjs` | B2 / B3 / B4 / **B7（删除）** / B8 | B7 删除前 B8 不得开工 |
| `engine/schema.mjs` | B5 / B8（③ 的 order 校验） | B5 先 |
| `src/shared/engine-params.ts` | B2 / B6（单一来源） / B7（参数清理） / B8（④ 的参数） | B6 → B7 → B8 依次 |
| `docs/engine-reuse.md`、`docs/injection-point-contracts.md` | B0 / B3 / B6 / B7 / B8 | 同一执行者串行落笔，不得并发编辑 |
| `test/host/engine-params-bridge.test.mjs`、`test/shared/engine-param-schema.test.mjs` | B0 / B2 / B6 | B0 先建守卫，后续支线随改动同步 |
| `CHANGELOG.md` | 全部 | 各支不写，统一由各支收口时追加一节 |

### 执行顺序

`B0 → B1 → B2 → B3 → B4 → B5 → B6 → B7 → B8`

- B0 先行的理由：把「必须手工同步」变成「漂移即红」，后续每支都在红灯保护下改。
- B7 排在 B3/B4/B6 之后：删除模块前必须先在触发器引擎里**重建等价声明并对拍通过**，且参数清理要在 B6 的单一来源上做。
- B8 最后的理由（用户拍板）：重构会让 ② 退化为声明里的触发器优先级、③ 挂在 B5 归一后的层注册表上、④ 退化为改一处参数目录。

### 全局纪律（各支共同遵守）

1. **B1–B6 每支的行为变更必须为零**，唯一例外是 B2 的 `enabled` 统一为 fail loud（拍板项，须在 CHANGELOG 标注为行为变更）。
2. **不顺手做 B7 的 ②**：迁移时保持现有注册选项（普通注册），否则结构变更与行为变更混在同一提交里无法定位。
3. 不修改 DSH 源码仓库，只使用已发布官方包与官方扩展点；不引入任何运行时依赖；`engine/` 保持自包含（可整体复制），新框架文件放在 `engine/` 内并同步更新复制协议文档。
4. 官方 seam 语义不可伪造（维持 ADR 0002：九层插入点彼此独立，无插件级全局顺序）。
5. 每支独立提交、独立可回滚；测试 cwd 固定 `D:\AI\workspase\_temp`，用独立 `DSH_HOME`，结束清理。
6. 引擎与组合属装配期读取，交付说明标注「需用户重启 DSH 后生效」；不启停在役服务。

## 分支清单

| 支线 | 主题 | PLAN 文件 | 依赖 | 主要冲突文件 |
|---|---|---|---|---|
| **B0** | 镜像守卫先行 + 文档修正 | `2026-09-22-plan-engine-b0-guards-docs-84785df.md` | 无 | 测试镜像、三份文档 |
| **B1** | 既有 helper 收敛（零行为） | `2026-09-22-plan-engine-b1-helper-convergence-84785df.md` | B0 | 8 个引擎模块 |
| **B2** | 配置契约统一 + 能力开关单源 | `2026-09-22-plan-engine-b2-config-contract-84785df.md` | B1 | `fields.mjs`（新增）+ 2 个保留模块 + 4 个无白名单模块 + engine-params.ts |
| **B3** | 触发器引擎（判断原语 + 动作库） | `2026-09-22-plan-engine-b3-capability-runtime-84785df.md` | B2 | 新增引擎文件 + 三个提供者样板 |
| **B4** | 会话态与生命周期统一 | `2026-09-22-plan-engine-b4-session-state-84785df.md` | B3 | 全部持有会话态的模块 |
| **B5** | 层注册表归一（schema 四表合一） | `2026-09-22-plan-engine-b5-layer-registry-84785df.md` | 无（可并行） | engine/schema.mjs、bridge 契约 |
| **B6** | 跨层镜像归一 | `2026-09-22-plan-engine-b6-cross-layer-mirrors-84785df.md` | B0 | src/host、src/runtime、src/client/data、src/shared |
| **B7** | 专用能力重建、删除与预设迁移 | `2026-09-22-plan-engine-b7-capability-consolidation-84785df.md` | B3 / B4 / B6 | 7 个引擎模块 + 7 个组合源 yml + 参数目录 + UI 能力卡 + recipe + 两个真实预设 |
| **B8** | 注入层权威性与刻度（既有，不重写） | `2026-09-22-plan-injection-authority-84785df.md` | B0–B7 | `schema.mjs`、`engine-params.ts`（②④ 在新机制上重做） |

## 验收口径

每支共同门槛（在该支收口时执行）：

```
pnpm --dir $Repo typecheck
pnpm --dir $Repo lint
pnpm --dir $Repo test
pnpm --dir $Repo build
git -C $Repo diff --check
```

各支另需的**行为等价证明**：

| 支线 | 等价证明方式 |
|---|---|
| B0 | 新增守卫先红（能抓到三处既有漂移）、修完转绿；文档修正与代码事实逐句对拍 |
| B1 | 替换前后对拍（既有 helper 与手写实现逐字等价，已有代码可直接比对）；全量测试绿 |
| B2 | 每个模块迁移前后用同一组 config 断言白名单/校验/归一化输出逐字段相同；`enabled` fail loud 作为唯一预期差异单独断言 |
| B3 | 监听器注册表快照对比（事件名、顺序选项、改写方式）；降级路径逐条对拍 |
| B4 | 会话态读写与上限行为对拍；`compaction/end` 复位点统一后断言旧路径不再重复注册 |
| B5 | `getEngineMeta()` 输出与现状逐字段快照对比；`LAYER_CONTRACTS`/`LAYER_FIELD_POLICIES` 深比较 |
| B6 | 镜像守卫全绿；参数目录单一来源后，新增一个参数只需改一处的演示性断言 |

## 回滚与检查点

- 每支一个提交；回滚即 `git revert <该支提交>`，不波及其它支线。
- B7 的提交独立于 B0–B6，可单独 revert 而不回退重构。
- 中断检查点：支线之间工作树须保持 `typecheck` / `lint` 通过；未完成的支线不得留下半迁移的模块（同一模块的声明与消费点必须同进同退）。
- 数据侧无需回滚：本轮不新增持久格式；组合源 yml 的默认值变化随提交回退。

## 状态

本轮**只产出 PLAN**，全部支线未开工：

- [ ] B0 守卫先行 + 文档修正。
- [ ] B1 既有 helper 收敛。
- [ ] B2 配置契约统一 + 能力开关单源。
- [ ] B3 触发器引擎（判断原语 + 动作库）。
- [ ] B4 会话态与生命周期统一。
- [ ] B5 层注册表归一。
- [ ] B6 跨层镜像归一。
- [ ] B7 专用能力重建、删除与预设迁移（7 个模块先重建等价声明、再删除；两个真实预设迁移）。
- [ ] B8 既有 `2026-09-22-plan-injection-authority-84785df`（在触发器引擎上重做 ②④，届时按声明形态调整实现细节）。

## 验收记录

本轮为**方案查证**，未执行任何代码或测试改动。证据分布：

- 四支勘察报告（配置契约面 / 运行时行为面 / 跨层耦合面）与两轮 ST 对照查证的全部行号证据，分落在各支线 PLAN 的「审查结论」与「验收记录」节。
- 关键基线：`engine/` 37 文件 6928 行、依赖边 55 条无环、19 个本地组合源模块、24 个 library 模块、71 个参数定义、18 个引擎测试文件。
- ST 对照基线：`F:\ai\other\SillyTavern` 版本 1.19.0、commit `7c399419`（2026-09-14）。

## 实施取舍与已知边界

- **不重写纯库模块**：`condition.mjs` / `anchor-match.mjs` / `classify-task.mjs` / `st-render.mjs` / `tool-definition.mjs` 已是合格深模块，只被动接入框架，不改其内部。
- **不抹平真实差异**：改写型 vs 副作用型监听器、纯模块 vs 状态模块、声明式层（promptConfigs）vs 命令式能力（模块行），差异保留，只收敛样板。
- **`prepend` 不是绝对否决**：同为 `prepend` 时后注册者更外层（详见 B7 的边界断言）。
- **变量运行时改写不在本轮**：按拍板只修 `docs/architecture-params.md:130` 的错误表述；该能力若要做，另立支线并需授权门与版本校验。
- **ST global 变量不复刻**：预设级变量在持久性上可承担该角色，但作用域是「每个预设一份」而非 ST 的「跨预设一份」；差异写入文档。
- **这是一次「机制统一 + 能力净缩减」**：B7 之后引擎只保留触发器机制与三个能力提供者，7 个专用能力模块先重建为等价声明再删除。四项能力**真正放弃**且必须写进交付说明：`stages` 渐进披露、`bootstrapMaxTokens` 预算、`personaSectionsOnly`、`promoted-code-mode` 的相位 PTC 呈现。其余能力行为可由声明重建，不算损失。
- **名单语义改为模式互斥**：现状 `tool-filter` 的 `deny` 优先于 `allow`（`tool-filter.mjs:52-53`），两个名单同写时结果不可预期，与用户「白名单里加=可用、黑名单里加=不可用」的心理模型冲突。新语义为「选一个模式 + 一个列表 + 可选条件」，allow 模式内部仍按 fail-closed 实现，**默认方向不翻转**。
- **三个能力提供者不归一**：`subagent-tool-policy`、`tool-config-engine`、`str-replace-editor` 的本质是"给模型提供能力"，与"干预流程"不同层，强行并入会让引擎失去单一职责。
- B0–B6 为内部重构；B7 起为用户可见的结构与能力变化（UI 能力卡 10 → 3、参数目录缩减、recipe 重做）。

## 测试现场与清理限制

- 本轮未创建任何临时目录或文件；未启停 DSH，未改真实用户配置。
- 用户既有的未跟踪 `skills/` 与本轮无关，保持原样；`.ai-memory` 仅本地追加，不入库。
