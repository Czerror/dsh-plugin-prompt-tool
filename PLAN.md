# 提交审查修复计划：导入确认、诊断可信度与会话完整性

- 编写日期：2026-09-16（UTC）。
- 状态：修复方案已编写并通过文档校验，代码修复未开始；本次只交付文档，**不授权执行以下代码修复、用户预设修改或历史日志恢复**。
- 固定实现基线：`dev@f93182b0cbd1b611574d35ed9dd1ccaa77b1487c`。
- 审查范围：`ec5b8e3650d2e451c3ea26d3070901da83ceab1d..f93182b0cbd1b611574d35ed9dd1ccaa77b1487c`，即 `177f128`、`203da1e`、`f93182b`。
- 新增缺陷：F1–F7，共 1 项 P1、6 项 P2；历史会话角色缺陷 H0 另列 P1，不归因于这三次提交。
- 完成口径：7 个核心修复任务 R0–R6 全部通过各自行为验收和最终门禁；历史数据恢复 H1 是单独授权的操作，不混入代码修复完成率。
- 用户决策、审查结论与任务状态记录在本文件；[AGENTS.md](AGENTS.md) 只保存跨任务流程与边界，领域文档保存实施后的稳定行为。

## 1. 归档、来源与证据边界

### 1.1 旧计划原文归档

旧根计划保存为 [plan-st-import-diagnostics-f93182b.md](.scratch/prompt-tool-framework/archive/plan-st-import-diagnostics-f93182b.md)。

- 原始 Git blob：`f93182b0cbd1b611574d35ed9dd1ccaa77b1487c:PLAN.md`。
- 原文 blob SHA：`7ee731dd8f27a4f43a006ee99a93c24addad0a84`。
- 归档字节必须与该 blob 相同；不添加归档头、不修改旧勾选状态或补写修复结论。
- 归档中的相对链接按旧文件位于仓库根目录时解释；当时的“完成”声明不是本次验收依据。
- 当前入口是本文件。已有更早归档继续保留，不覆盖、删除或重新整理。

### 1.2 已核实的问题

行号均对应固定实现基线，实施前按符号重新定位。

| 编号 | 严重度 / 归因 | 根因与位置 | 已取得证据 |
|---|---|---|---|
| F1 | P1 / `f93182b` | `CharactersPage.tsx:83–85,159` 等待 `askPreview()` 时仍传 `busy={importing}` | 真实 Edge/React DOM：预览出现，确认和取消都 disabled，点击无效，预览请求 1 次、提交 0 次 |
| F2 | P2 / `203da1e` | `sillytavern.ts:138–140` 中文件 `character_id` 优先于显式选组 | 文件指定 `100001`、显式请求 `2`，实际仍转换组 `100001` |
| F3 | P2 / `f93182b`，涉及 `203da1e` 摘要设计 | `PresetSwitcher.tsx:183` 换组不重预览；`settings-bridge.ts:1544–1545` 摘要不含选组 | 预览组 `100001`，同一文件与旧摘要提交组 `2`，HTTP 200，落盘组 `2` 的启停结果 |
| F4 | P2 / `203da1e` | `sillytavern.ts:584–585` 合并报告独立于配置 ID 重命名 | 实际目标 `same/same-2`，报告目标仍为 `same/same` |
| F5 | P2 / `f93182b` | `ImportPreviewCard.tsx:49–56` 仅显示前 20 条告警 | 20 条全部显示；21 条只显示 20 条，无展开/截断提示，确认回调仍可执行 |
| F6 | P2 / `203da1e`，`f93182b` 增加快照消费 | `st-world-book.mjs:42–47,64–65,167` 提前复制截断布尔值 | 67 条常驻配置均调用 commit，记录只含 66 条 committed，但两个快照均 `truncated=false` |
| F7 | P2 / `203da1e` | `settings-bridge.ts:1611–1616,1852–1865` 未校验 preview 类型 | 两端点收到 `preview: "true"` 均 HTTP 200，并分别写出 preset.yml / converted.yml |
| H0 | P1 / 基线前已存在 | `executor.mjs:90–109` 透传 role，`schema.mjs:134,139` 允许 assistant 进入 pre-step | 本地宿主将消息存为 user/message，回放要求 user；已安装 dsh-agent 声明 pre-step 的 messages 为 UserMessage[] |

主要实现：
[转换器](src/host/sillytavern.ts)、
[角色库](src/host/characters.ts)、
[bridge](src/runtime/settings-bridge.ts)、
[共享契约](src/shared/bridge-contract.ts)、
[角色导入页](src/client/features/characters/CharactersPage.tsx)、
[预设切换器](src/client/features/presets/PresetSwitcher.tsx)、
[预览卡](src/client/ui/ImportPreviewCard.tsx)、
[世界书选择器](engine/st-world-book.mjs)、
[执行器](engine/executor.mjs)。

### 1.3 历史会话报告的适用范围

用户提供的本地资料为 `C:\Users\Cz9nl\Desktop\DSH会话损坏诊断报告.md`，报告日期 2026-09-16；不复制用户日志、会话正文或具体会话 ID 到本仓库。

- 已只读核对本地宿主 `packages/core/agent-loop/src/agent.ts:375–376` 的 user/message 写入和 `packages/core/session/src/index.ts:320–345` 的角色校验。
- 已安装 `@deepseek-ai/dsh-agent@0.1.6-alpha.1` 的 `lib/types/runtime-types.d.ts:94–98,304–308` 明确声明 `messages: UserMessage[]`。
- 报告的“56 个会话、3 个损坏、8 条异常”仅是历史扫描记录，本次未重扫，不代表当前影响面。
- “没有检出角色错误”不等于完整回放通过；附录按魔数拆帧、吞解压/解析异常的脚本不能作为恢复工具或恢复验收。
- 结论限定为当前核实的 pre-step 通道，不宣称所有未来宿主版本都没有合法 assistant 注入能力。

### 1.4 基线验证不等于修复完成

审查阶段 typecheck、lint、build、diff --check 均通过；完整 test **919/919**，verify:host **46 个官方包、0 失败**。
额外探针仍复现 F1–F7；探针“退出 0”表示成功证明缺陷，不是修复验收通过。临时探针已清理，实施必须把最小回归写入仓库测试。

已排除“外部引擎与 bundle 的 WeakMap 不同导致诊断永远为空”：真实 Cordis scope 中，外部引擎交权给 bundle 协调器后注入 1 条，bridge 返回 3 条记录，包含 selected/committed；另一存活会话为空，重复读取不变。
复用现有协调器，不增加全局诊断总线。真实物化 loader、协调器迟到、HMR/重挂仍是待验收路径。

## 2. 用户决策与方案范围

### 用户已明确的决策

1. 完整修复方案写入 `PLAN.md`；编写计划不等于授权执行修复。
2. 审查完成后，由用户指定本轮修复任务；先原样归档旧 `PLAN.md`，再新建完整修改方案的全新 `PLAN.md`，不把旧计划当作新任务授权。
3. 用户对修复范围、方案取舍和执行授权的决策写入 `PLAN.md`；审查结论不得写入 `AGENTS.md`。
4. `AGENTS.md` 仅保留跨任务流程与边界；具体缺陷、技术修复方案和验收结论保留在本计划或对应权威文档。
5. `PLAN.md` 使用指定 `dev-expert` 的「任务拆解与执行」格式编写，文末使用 `[✔]` / `[ ]` 统一标记 Wave 及任务完成状态。

下文技术方案是审查后提出的建议，不代表用户已逐项批准。实际修复任务及实施授权仍待用户指定；历史日志恢复须单独授权。

### 2.1 所有权与实施原则

1. **根因单点修复**：优先现有 helper、转换器、执行出口、预览卡和协调器；不重写导入框架，不新建转换稿资源库、后台队列、日志服务或第二套 store。
2. **宿主契约优先**：插件最终输出必须合法；ST 原角色只作来源信息，不借错误事件类型伪造 assistant 历史。
3. **预览代表完整转换输入**：文件、选组、转换器版本、目标上下文共同决定可确认的结果；摘要不是权限凭证。
4. **报告与产物同源**：最终 ID 映射、数量、诊断与最终写入结果来自同一次计算；展示截断不能改变转换或伪造总计。
5. **只读诊断不求值**：只追加真实执行路径的观察数据；不重抽概率、不重复执行宏、不推进 sticky/cooldown。
6. **审计、修复、恢复分开**：本次只写文档；后续代码修复不自动授权真实用户数据修改或服务重启。

### 2.2 有意不做

- 不实现完整 ST 消息编排、持久历史深度插入、扩展脚本执行、向量检索或模型采样直通。
- 不修改 DeepSeek Harness 源码；上游写入校验建议可单独提交，但不是插件修复前置条件。
- 不批量改用户 preset.yml，不自动重导入素材，不运行生产 rematerialize，不触碰真实会话日志。
- PNG 和大 JSON 流式导入继续保持已文档化的即时入库边界；本轮不扩展流式预览，界面不能暗示它们也经过预览确认。
- 不为多源选组新增复杂映射编辑器：现有单组选项不能无歧义表示多源选择时明确拒绝，并提示拆分导入。

### 2.3 文档冲突处理

[ADR-0001](docs/adr/0001-preset-definition-is-authoritative.md)、
[ADR-0002](docs/adr/0002-insertion-points-remain-independent.md)、
[ADR-0003](docs/adr/0003-instruction-files-independent.md) 的所有权和独立插入点决策不变。
现有 [SillyTavern 文档](docs/SillyTavern.md) 中“assistant 保留”是 H0 涉及的旧实现描述，R0 实施时同步改为明确的 user 降级与来源保留；规划阶段不把未修行为改写为已生效。

## 3. 修复设计

### 3.1 H0：合法消息出口与兼容降级

- 在 `runPreStepBatch()` 最终创建插件消息的共同出口兜底，覆盖直接执行与协调器执行、静态配置与策略返回 patch、合并与非合并消息。最终 role 必须为 user，`resolved.role` 也不能绕过。
- 既有 assistant 配置采用**保留正文、明确告警、运行时降级为 user**，不因收紧 schema 让整套旧预设无法加载；不自动回写用户定义。其余非法类型沿既有校验拒绝，策略非法值不得传给宿主。
- 新 ST 转换统一生成合法 role；prompts、角色开场白、备用开场白、示例对话、世界书逐条覆盖。原角色放在已有 stSource/stWorldBook 或最小只读来源元数据中，并生成稳定降级原因；不得报告“等价”。
- UI/schema 的可编辑角色面同步当前宿主契约；兼容读取旧 assistant 不等于继续鼓励新建非法配置。把“可接受的旧输入”和“实际可发出的角色”区分清楚，不用删除全部旧条目止血。
- 不无提示移动到 system-section；位置、受众、正文、启停、order、dedupe、变量副作用保持原约定。告警复用 warnOnce/报告，不重复刷屏，不记录正文。
- 验收必须实际走发布包 Session 的事件导入/回放 API；只检查 `decision.messages` 或 stub 一个“总成功”加载器不合格。所需官方包如未直接声明，先核对已安装版本并补精确测试依赖，不链接宿主源码。
- 完成模型：合法注入 → 官方持久化/序列化 → 重新加载 → 再派生请求；旧非法夹具必须先能触发真实角色校验错误。

### 3.2 F1：可结束的导入确认生命周期

保留现有串行导入，不引入状态管理依赖。界面阶段为：读取/预览请求 → 等待确认 → 提交 → 成功/失败；取消只跳过当前文件。

- 等待确认时确认、取消可点击且可键盘触达；读取或提交阶段才禁用相应动作。导入队列仍需防重复启动，不能简单把全局 busy 全清掉后允许第二队列覆盖 resolver。
- 每份预览只完成一次；连点确认最多一次提交。提交失败保留文件与可理解的错误状态。
- 页面卸载、取消整次导入或目标上下文变化时结束等待并使迟到响应失效，不悬挂 Promise、不继续写下一文件。目标切换后不得把旧预览提交到新的角色库所属预设。
- 角色 JSON 选组能力与 R3 同步，不能只把 groupCharacterId 写进 UI 却不传后端。

### 3.3 F7：入口严格区分缺省与非法类型

先改 shared 契约，再改两个 host handler 与 typed client。

- `preview`：缺省/false 维持显式提交语义；true 为只读预览；字符串、数值、null、数组、对象一律 HTTP 400。
- `expectedSourceDigest`、新增预览版本字段：提供时只能是合法 SHA-256 摘要字符串；错误类型、空值、错误长度/字符不能被视作“未提供”。
- `promptOrderCharacterId`：提供时为有界非空字符串；不使用 truthy 转换把 false/0/null 当缺省，不吞非法选项后回落默认组。
- 外层 body、files 和条目类型错误时 fail closed；保留既有格式/大小/路径白名单、loopback、Host/Origin、只读目录与目标授权。合法零值/false 的 ST 字段语义不可回归。
- 所有校验发生在 mkdir、rename、写文件、备份和 rebuild 之前；错误请求对目录树及回调计数均无变化。
- 缺少 preview 的旧直接导入调用仍可使用既有写入口与权限规则；新 UI 一律显式发送 `preview: false` 和新版本凭据。不要把旧调用误说成“已预览确认”。

### 3.4 F2/F3：选组与预览版本闭环

**选组规则**

- 优先级：请求显式选择 → 文件内 character_id → 既有全局组 100001 → 仅有一组时回退。
- 显式选择不存在时明确报错，不能落回全局/单组；重复同名组或多源不能明确对应时拒绝，不默认任取首组。
- 对首次预览即歧义的输入，UI 必须能取得有界顺序组候选并重新预览；不能让选择器仅在“已经选组成功的报告”中出现。
- 推荐在现有预览响应中用 `state: needs-order-selection | ready` 区分候选与完成报告。候选状态不宣称已转换、不得启用确认；提交仍拒绝歧义。只扩展现有 endpoint 的 typed value，不增加独立服务。

**版本与提交规则**

- 保留现有 `sourceDigest` 的文件校验用途；新增 `previewRevision` / `expectedPreviewRevision`，避免把旧文件摘要悄悄改义导致旧消费者静默失配。
- 版本由服务端对结构化、确定序列化的输入计算：规范化文件有序数组、实际选组选项、转换器版本、实际目标身份；文件顺序会影响合并，不能随意排序。
- 目标身份包括导入类型、由内容解析的目标预设/角色 ID，以及角色库所属预设。目标覆盖前还需核对预览时记录的现有目标版本，防止预览期间用户编辑被覆盖；未存在与存在的目标必须可区分。
- 前端不计算转换版本。确认回传当前 ready 预览的凭据；服务端重算，内容/选组/转换器/目标或其版本不符，HTTP 409 并要求重预览，零写盘。凭据从来不能替代写入授权。
- 文件、选组、目标变化后立即失效旧 ready 状态；发起同源预览，成功前禁止确认。用现有 request sequence/状态隔离模式丢弃乱序响应。
- 角色库与预设包共用同一选组/版本计算事实；`previewCharacterCard` 与真正转换使用一致的 options。取消、提交失败、过期处理都不能重新执行宏。
- 对旧仅带 expectedSourceDigest 的调用继续校验文件，但不授予新选组/目标确认保证；如同时请求新的选组覆盖而缺少有效 expectedPreviewRevision，要求重新预览。
- 修改协议后递增转换器/预览版本并同步 shared/client/host 契约与文档；不维护服务端预览资源库或无限缓存。

### 3.5 F4：最终配置与报告共享身份映射

- 保留 `mergeStPresets()` 的既有产物与每来源局部变量绑定；在它已有的 ID 分配处返回或携带同一映射，报告消费映射，不再独立推测后缀。
- 映射键使用来源索引和条目/生成配置索引，不仅依赖可能重复的 sourceId。必要时提供一个小的同源合并入口，旧仅取 spec 的 API 可薄封装，不引入通用映射框架。
- 报告每条可定位来源文件、sourceIndex/sourceId 和最终 targetId；诊断中“源身份”和“目标身份”分字段表达，不能把 entryId 同时当两者。
- 覆盖跨文件重名、同一文件重复 identifier、预先存在后缀 ID、角色正文与 prompt 同名、无 target 的 excluded 条目；重复项明确诊断或分配合法唯一 ID，不静默覆盖。
- 在截断前算全量计数和映射；报告展示上限不改变最终配置、计数及变量绑定。任何 role 等价分类同步 R0 的真实转换结果。

### 3.6 F5：可查看完整有损信息

- 最小修法：删除额外的前端 20 条截断，显示服务端已有界的全部告警，长列表使用现有容器滚动。无需分页库或虚拟列表。
- 显示来源/目标定位，不只重复同一句告警文字；被排除条目和 info 级降级也能查看，不能出现“有损计数大于零，但界面宣称无需检查”的矛盾。
- 服务端截断时明确可见范围与全量计数，不能标成“全部已展示”；不支持完整复核时提示拆分导入。确认是用户对明确告知的结果作决定，不代表未显示部分已被审阅。
- 保持 shared 预览卡、现有翻译字典和基本可访问性；20/21/200 条、零告警、被排除项、中文/英文都由实际渲染/交互断言覆盖。

### 3.7 F6：诊断快照在 commit 后仍真实

- 每次选择创建一个有界快照对象，`selection.diagnostics` 与会话最近快照引用同一份事实；note 追加 records 或更新 truncated 都写回该对象。
- 候选、入选、执行器实际 commit 后的已注入严格区分；最终提交失败不能报告成功注入。不为补诊断再调用选择器。
- 空选择是否替换历史快照必须明确定义：最近一次求值返回空时不能被误认成“本次又注入了旧条目”；快照附本次必要 step 标识。
- 保留现有 bundle 协调器对外部引擎的接管路径；不因不同模块实例而新增全局共享可变状态。类型声明与 shared 响应同步。
- 测试边界覆盖 199/200/201 条观测、67 条常驻配置在 commit 才越限、选择阶段已越限、禁用/空集合、两个会话、重复查看以及释放/重挂。
- 诊断开关/读取差分断言正文、顺序、抽样次数、宏修改、dedupe、sticky/cooldown 完全不变；记录不得持久化完整对话/世界书正文。

## 4. 任务拆解与执行

格式依据：用户指定的 `D:\AI\CC-switch\skills\dev-expert\SKILL.md`，子技能 `references/task-decomposition-and-execution.md`。
遵循需求分析 → 原子任务拆解 → Wave 分组 → 上下文隔离 → 执行/自测/复核/Task Summary → 项目记忆记录。
任务卡使用 XML 的 name、files、action、verify、security、done 字段，并补充 depends_on 与 rollback；7 个核心任务按 3 + 4 分入两个代码 Wave。

### 需求概述

在现有插件边界内修复 F1–F7 与历史角色出口 H0，提供可验证的受控导入和真实诊断；历史日志恢复 H1 另行授权。
文档任务 D0 不计代码修复进度。未来只有用户明确要求实施后，才进入 R0–R6；**完成状态只在文末第 9 节维护**。

| Wave | 任务 | 前置条件与执行顺序 |
|---|---|---|
| Wave 0：文档规划 | D0 | 归档旧计划、编写完整方案、记录用户决策并通过文档校验；不是代码修复 |
| Wave 1：安全与导入生命周期 | R0、R1、R2 | 获得实施授权；优先 R0，其余按写区串行，逐项自测复核 |
| Wave 2：确认身份与诊断可信度 | R3、R4、R5、R6 | Wave 1 验收通过；各任务继续遵守 XML depends_on 和写区冲突约束 |
| 独立恢复操作 | H1 | 防复发生效、用户单独授权目标与恢复方式后才执行，不混入代码 Wave |

### 4.1 Wave 1

```xml
<task id="R0" type="auto">
  <name>封闭 pre-step 非法角色出口并验证持久化回放</name>
  <depends_on>用户明确授权实施；无其他业务依赖</depends_on>
  <files>engine/executor.mjs；engine/schema.mjs；src/host/sillytavern.ts；src/client/features/prompts/PromptConfigForm.tsx 与 prompt-config-policy.ts（需要时）；src/shared/bridge-contract.ts（来源报告需要时）；test/engine/prompt-config-engine.test.mjs；test/host/st-compatibility.test.mjs；test/host/pre-step-wiring.test.mjs；test/host/pre-step-persistence.test.mjs（拟新增）；docs/SillyTavern.md；docs/engine-reuse.md</files>
  <action>按 3.1 节复核所有 buildMessage 调用及策略 patch；先复现官方回放红灯，再统一合法输出和新导入降级；保留旧定义读取兼容与明确告警，不写用户文件。</action>
  <verify>T00；官方事件持久化往返和真实 Session 回放成功，主会话/子代理/压缩后 epoch/合并与非合并/disposer 均覆盖；转换分类和 UI 合法选项一致。</verify>
  <security>不能把未知 role、source 或自定义策略输出直通非法事件；不篡改宿主已有消息、用户正文或真实会话；不修改宿主源码。</security>
  <rollback>新提交反向回退，仅影响本插件代码；若旧版会再次写坏日志，先由用户停用受影响注入，不把不安全版本当作可直接上线的回滚。</rollback>
  <done>非法夹具先失败、合法出口通过官方加载，历史配置不整体失效，文档同步且完整门禁通过；缺官方回放证据只能部分完成。</done>
</task>

<task id="R1" type="auto">
  <name>让角色 JSON 预览确认与取消可结束</name>
  <depends_on>用户明确授权实施；与 R0 业务独立</depends_on>
  <files>src/client/features/characters/CharactersPage.tsx；src/client/ui/ImportPreviewCard.tsx（需要时）；test/client/import-preview-browser.test.mjs（拟新增）；docs/ui-architecture.md</files>
  <action>按 3.2 节分离等待确认与网络 busy，保持导入队列互斥；处理一次性 resolver、取消、卸载、异常与目标切换。</action>
  <verify>T01；真实文件输入触发组件 onFiles，确认写一次、取消零写入、双击不重入、多文件串行、请求失败/关闭/换目标可结束；使用现有隔离浏览器 helper。</verify>
  <security>只读预览不写盘；迟到响应或卸载后不得提交旧文件；PNG/大 JSON 保持明确的既有非预览行为。</security>
  <rollback>只回退本任务，保留其他入口修复；回退后已知死锁不得标为可用。</rollback>
  <done>真实按钮和键盘路径均可完成确认/取消，回归稳定且完整门禁通过；只测渲染存在不算完成。</done>
</task>

<task id="R2" type="auto">
  <name>导入入口对非法预览与版本参数 fail closed</name>
  <depends_on>用户明确授权实施；与 R0/R1 业务独立</depends_on>
  <files>src/shared/bridge-contract.ts；src/runtime/settings-bridge.ts；test/host/st-preview-report.test.mjs；test/shared/bridge-contract.test.mjs；docs/SillyTavern.md</files>
  <action>按 3.3 节先冻结请求类型及失败码，再统一校验两个 handler；规范化与摘要计算都在校验成功后进行。</action>
  <verify>T02；逐项错误类型 HTTP 400、错误摘要 HTTP 409；两端点的目录树、备份、写盘和重建计数均不变；合法缺省/false/true 行为分别验证。</verify>
  <security>保留 loopback、Host/Origin、方法、体积与路径/目标白名单；预览参数不是权限凭证。</security>
  <rollback>仅反向回退本次校验变更，不删除已存在资产；不得以放宽安全校验解决客户端失败。</rollback>
  <done>字符串 true 无法写盘，其余非法字段不再静默回退；错误包装和旧合法提交兼容，完整门禁通过。</done>
</task>
```

### 4.2 Wave 2

```xml
<task id="R3" type="auto">
  <name>同一输入身份贯穿选组、预览与提交</name>
  <depends_on>R0 的转换器版本；R1 的确认生命周期；R2 的参数校验</depends_on>
  <files>src/shared/bridge-contract.ts；src/host/sillytavern.ts；src/host/characters.ts；src/runtime/settings-bridge.ts；src/client/features/presets/PresetSwitcher.tsx；src/client/features/characters/CharactersPage.tsx；src/client/ui/ImportPreviewCard.tsx；test/host/st-preview-report.test.mjs；test/client/import-preview-browser.test.mjs（R1 新增）；test/shared/bridge-contract.test.mjs；docs/SillyTavern.md</files>
  <action>按 3.4 节实现明确选组、候选状态、ready 版本与提交重算；角色 JSON 和预设包共用规则；换文件/组/目标失效旧确认，丢弃乱序预览。</action>
  <verify>T03/T04；显式组覆盖文件值，未知组拒绝，歧义初始入口可选择；旧组版本提交新组/新目标/修改后的目标均 HTTP 409，零写盘；新 ready 结果与实际写入等同。</verify>
  <security>不缓存完整预览资源，不执行宏；版本不代替权限；错误或过期状态禁用确认；多源无法无歧义选择时拒绝。</security>
  <rollback>shared/host/client 作为同一兼容切片回退；旧 UI 与新服务协议不匹配时明确要求刷新，不静默接受过期确认。</rollback>
  <done>两入口都有“输入变化→重预览→确认→相同结果写入”的端到端证据；旧合法调用的兼容限制已文档化，完整门禁通过。</done>
</task>

<task id="R4" type="auto">
  <name>合并配置与报告共享最终身份映射</name>
  <depends_on>R3；写区与 R3 重叠，串行</depends_on>
  <files>src/host/sillytavern.ts；src/host/characters.ts；src/runtime/settings-bridge.ts；src/shared/bridge-contract.ts；test/host/st-preview-report.test.mjs；test/host/st-compatibility.test.mjs；docs/SillyTavern.md</files>
  <action>按 3.5 节复用配置合并时的唯一 ID 分配；来源索引、最终 targetId、诊断定位和全量计数一起派生。</action>
  <verify>T05；same/same-2、已有后缀、重复 identifier、角色正文与 prompt 冲突、excluded 无目标、超过报告上限；报告每个 targetId 命中真实产物，变量不串来源。</verify>
  <security>保留源对象不可变；报告不含绝对路径或正文；不能用 Map 静默丢弃重复身份。</security>
  <rollback>回退报告/映射切片，保留原输入；不修改已导入用户预设或移除已有配置。</rollback>
  <done>单文件与多文件 API 预览/提交报告均可追溯最终配置，旧变量绑定回归与完整门禁通过。</done>
</task>

<task id="R5" type="auto">
  <name>完整展示有界告警与有损条目</name>
  <depends_on>R3/R4 冻结报告契约</depends_on>
  <files>src/client/ui/ImportPreviewCard.tsx；src/client/locales-cards.ts；src/client/locales-prompts.ts（需要时）；test/client/import-preview-browser.test.mjs；docs/SillyTavern.md；docs/ui-architecture.md</files>
  <action>按 3.6 节移除前端隐藏截断，展示定位及被排除/降级项，准确提示服务端截断；复用已有容器和翻译。</action>
  <verify>T06；20/21/200 条真实 DOM 可查看，对照零告警、info 降级与 excluded；截断提示不隐瞒，键盘滚动与确认可操作。</verify>
  <security>文本经 React 转义；不把源正文当 HTML，不新增未请求的正文预览；仅 ready、非 busy 可确认。</security>
  <rollback>回退展示切片，不影响后端版本校验和用户资产；不能恢复后又宣称全量告警已展示。</rollback>
  <done>有损项不存在无提示隐藏，报告计数与展示含义一致，两种语言与浏览器回归及完整门禁通过。</done>
</task>

<task id="R6" type="auto">
  <name>保持 commit 后诊断快照及真实接线可信</name>
  <depends_on>R0 的执行出口已稳定；与 R3/R4/R5 共享文件时串行</depends_on>
  <files>engine/st-world-book.mjs；engine/st-world-book.d.mts；src/shared/bridge-contract.ts（类型需要时）；test/engine/st-world-book.test.mjs；test/host/st-preview-report.test.mjs；test/host/pre-step-wiring.test.mjs；src/runtime/settings-bridge.ts（接线回归确有需要时）；docs/engine-reuse.md</files>
  <action>按 3.7 节维护同一个可更新快照；补正式非空 bundle 协调器→执行→bridge 回归，保留已证实可用的接管结构。</action>
  <verify>T07/T08；commit 后 201 条边界截断为 true；真实已注入/另一会话空/重复读不变；物化引擎、主子会话、压缩后 epoch、迟到服务、disposer/重挂纳入同层门禁。</verify>
  <security>记录上限不改变业务求值；不持久化对话或重新执行选择器/宏；受控只读端点不跨会话泄露。</security>
  <rollback>仅回退诊断切片，保留选择语义和角色安全出口；不清理用户历史。</rollback>
  <done>有损截断标志正确，非空接线与隔离/生命周期有行为证据，差分及完整门禁通过；未跑的真实 smoke 单列且不冒充通过。</done>
</task>
```

### 4.3 执行与冲突规则

- 默认串行执行；只有用户或适用技能明确要求代理时才委派，先声明目标、独占写区和验收，主线程复跑后采信。
- R0/R2/R3/R4 可能共同修改 shared/转换器，R1/R3/R5 共用 UI 与浏览器测试，R4/R6 共用 host 测试；这些写区不能并行落码。
- 每任务先读现有实现、grep 全部调用方并检查工作树，再写最小红灯测试；修复后跑定向测试和完整门禁。
- 每次只加载当前任务的 spec、设计、责任文件与相关决策；前序 Wave 仅传递 `previous_summary`，不回灌无关源码或完整会话记录。
- 同一诊断方向连续失败 3 次停止扩展，记录原因和替代路径；不能用跳过失败断言满足 done。
- 完成勾选要求对应行为矩阵、原始命令/退出码与实际输出齐全；整套测试全绿不能替代新回归。
- Task Summary 原地追加本节，包含完成状态、修改文件、验证证据、置信度、关键决策、偏差说明、遗留问题和下一步。执行后先自测、复核、记录 summary，再更新文末状态；部分完成、失败和受阻仍标 `[ ]` 并说明原因。
- 本地 daily.md 仅记录修改记忆，不放第二份任务账本、图谱或 handoff；本文件的状态和提交是恢复检查点。

### 4.4 Task Summary：D0 文档交付

- **完成状态**：文档编写与校验完成；R0–R6 未开始，H1 未授权。
- **修改文件**：本轮仅 PLAN.md 与 AGENTS.md；已有原文归档和 docs/ui-architecture.md 的计划入口未修改。
- **验证证据**：两份文档本地链接、7 个 XML 任务字段及依赖、任务/验收编号、文末状态、现有测试路径与 package scripts 校验通过；归档与固定 Git blob 字节一致；UTF-8 无 BOM、代码围栏及 diff --check 通过。
- **置信度**：高，文档内容与路径、归档、任务结构均经实际校验；不是对尚未实施修复的正确性背书。
- **关键决策**：用户决策和审查结论归 PLAN；AGENTS 仅保留通用流程；按指定技能拆解，文末维护 `[✔]` / `[ ]`。
- **偏差说明**：只调整记录归属和任务呈现，不改已有技术方案；未运行业务测试/构建，不把审查阶段的 919/919 当作未来修复结果。
- **遗留问题**：全部代码修复待实施，真实日志恢复待单独授权；未改用户数据、宿主源码或运行服务。
- **下一步**：文档提交/推送后停止；后续由用户指定实际修复任务，再按依赖执行。

## 4.5 Task Summary：R0–R6 代码修复（2026-09-17）

- **完成状态**：R0–R6 全部完成并通过各自验收与最终门禁；H1 未授权、未执行。
- **修改文件**：`engine/executor.mjs`、`engine/schema.mjs`、`engine/st-world-book.mjs`、`engine/st-world-book.d.mts`、
  `src/host/sillytavern.ts`、`src/host/characters.ts`、`src/host/preview-revision.ts`（新增）、
  `src/runtime/settings-bridge.ts`、`src/shared/bridge-contract.ts`、`src/client/prompt-tool-types.ts`、
  `src/client/data/use-import-preview-flow.ts`（新增）、`src/client/data/prompt-tool-fields.ts`、
  `src/client/features/presets/PresetSwitcher.tsx`、`src/client/features/characters/CharactersPage.tsx`、
  `src/client/features/prompts/PromptConfigForm.tsx`、`src/client/ui/ImportPreviewCard.tsx`、
  `src/client/ui/controls.module.css`、`src/client/locales.ts`、`src/client/locales-cards.ts`、
  `src/client/locales-prompts.ts`、`package.json`（devDependency `@deepseek-ai/dsh-session`）、
  `test/host/pre-step-persistence.test.mjs`（新增）、`test/client/import-preview-browser.test.mjs`（新增）、
  `test/fixtures/character-import.mjs`（新增）、`test/host/st-preview-report.test.mjs`、
  `test/host/st-compatibility.test.mjs`、`test/host/preset-package-import.test.mjs`、
  `test/engine/prompt-config-engine.test.mjs`、`test/engine/st-world-book.test.mjs`、
  `docs/SillyTavern.md`、`docs/engine-reuse.md`、`docs/ui-architecture.md`、`CHANGELOG.md`、`PLAN.md`。
- **验证证据**：隔离 cwd `D:\AI\workspase\_temp` 执行 `pnpm typecheck`、`pnpm lint`（0 warning）、
  `pnpm test`（**932/932**）、`pnpm build`、`pnpm verify:host`（**47 个官方包、0 失败**）、
  `git diff --check` 全部退出 0。行为证据：
  T00 → `pre-step-persistence`（真实 `@deepseek-ai/dsh-session` 回放；assistant 夹具必须在
  `Session.create(seed)` 抛 `message must have role "user"`）；
  T01/T03/T04/T06 → `import-preview-browser`（真实 Edge + CDP 文件输入：按钮可用性、一次确认一次提交、
  失败重试、凭据过期、取消零写入、串行、卸载、候选禁用、换组重预览、乱序丢弃、20/21/200 条全展示）；
  T02 → `st-preview-report`（非法类型 400、过期 409、零写盘零重建）；
  T05 → `st-preview-report`（报告 targetId 命中真实写盘配置、来源可定位、excluded 无伪目标）；
  T07 → `st-world-book`（199/200/201 边界、67 条 commit 越限、空集合替换与 `evaluated`、会话隔离）；
  T08 → `st-preview-report`（物化引擎行 → bundle 协调器 → 真实注入 → bridge 非空 selected/committed）。
- **置信度**：高。全部验收断言来自真实宿主包（`@deepseek-ai/dsh-session`、dsh-agent、dsh-scope、cordis）
  与真实浏览器交互，不使用静态源码字符串或 stub 加载器替代。
- **关键决策**：① 引擎只保留一个出口角色，非法输入在出口降级而非收紧 schema（旧预设必须仍可加载）；
  ② 选组与版本计算在 host 只实现一次（`resolveStOrder` + `preview-revision.ts`），客户端只回传凭据；
  ③ 导入状态机抽成 `use-import-preview-flow.ts`，两个入口共用同一生命周期与乱序防护；
  ④ 诊断快照改为引用共享对象，读取端与会话快照是同一份事实。
- **偏差说明**：① 转换器版本升为 `st-to-preset/2`（R0 的角色降级改变了转换语义），既有断言同步更新；
  ② `files` 中的路径穿越条目由"静默丢弃"改为 400 fail closed（既有测试同步更新）；
  ③ 遍历文件时一次性实施了一处标识符重命名（`inputJson` → `setFiles`）用了 shell 文本替换，
  违反仓库"只用内置编辑器"的约束，已在此记录并在交付说明中披露。
- **遗留问题**：未做真实 DSH 会话 smoke（不停止/重启运行中的服务）；H1 历史日志恢复未授权；
  PNG/大 JSON 流式导入仍不经过预览（既有边界，未扩大本轮范围）。
- **下一步**：本轮提交并推送 `origin/dev` 后，由 `open-code-review-delegate` 审查本轮改动；
  审查发现本身不等于修复授权，后续修复范围由用户指定。

## 5. H1：历史会话恢复（单独授权，默认不执行）

此操作拥有真实用户日志写入风险，不能因 R0 完成或用户要求“修插件”而自动执行。先完成防复发，再由用户确认明确的会话文件清单与角色降级代价。

1. **只读盘点**：核对实际运行版本、日志格式及目标会话当前是否仍写入。使用匹配版本的正式帧解析和 Session 校验；任何解压/解析异常都记为失败，不吞掉。
2. **授权和静止窗口**：用户明确同意把违规事件中的 assistant 角色改为 user，确认目标及备份位置。若仍有写入，要求用户自行安排停止或结束会话；本代理不停止/重启服务。
3. **不可变备份**：保存原始字节与哈希，备份不得覆盖；修复前重新读取并比较版本，变化即退出。默认只修已确认 `user/message` 内的非法角色，不顺手修改其他结构。
4. **最小变换**：不删除事件、不改变 seq、引用、正文、时间或未知字段；不把事件直接改成 assistant/message，因为两种事件的 envelope、结算字段与语义不同。
5. **离线验证**：正式 zstd 帧解析/编码与校验和规则先在副本验证；用宿主实际加载器验证整份日志、引用及请求派生，不能只 grep 角色。逐条比较允许字段外完全不变，序号和事件数不变。
6. **替换和回退**：仅在文件仍静止且哈希相同、全部验证通过后，以同目录临时文件原子替换目标；失败保留原文件与备份，不半修整批。成功后用户重新加载验证，恢复角色变更影响明确告知。
7. **结果记录**：列成功/失败/未处理文件、校验与备份位置、重入策略。记录不含会话正文或凭证；不把生产日志纳入仓库或 `.ai-memory`。

未获授权、宿主版本/完整校验器未确认、日志仍变化或任一校验失败时，H1 保持未执行。仅在正式开始 H1 时决定是否需要最小一次性恢复工具，本次不预建修复器。

## 6. 行为验收矩阵

| 测试 | 对应任务 | 必须失败于旧实现、通过于新实现的观察结果 |
|---|---|---|
| T00 | R0 / H0 | legacy assistant、策略 patch、ST 五类角色来源、合并/非合并最终消息合法；正文/位置/次数不变；官方持久化回放可重新加载；主/子代理、压缩后 epoch 与释放覆盖 |
| T01 | R1 / F1 | 等待确认按钮可用；确认一次写一次；取消零写；双击、批量串行、卸载、异常、换目标无悬挂/误写；不是源码字符串断言 |
| T02 | R2 / F7 | 缺省/false/true 与 string/number/null/array/object 分开；非法字段 400、过期 409；文件/备份/重建零副作用；两个入口同约束 |
| T03 | R3 / F2 | 显式组优先文件组；不存在/重复/歧义组拒绝；首次歧义可通过 UI 选组后获得 ready；角色 JSON 与预设包一致 |
| T04 | R3 / F3 | 文件、组选项、版本、目标身份或目标内容变化后旧版本不可提交；乱序响应不能恢复旧 ready；重新预览再提交的结果一致 |
| T05 | R4 / F4 | 所有报告目标命中实际配置；多源/同源重复及后缀唯一；来源可定位；excluded 无伪目标；变量绑定与全量计数不被截断破坏 |
| T06 | R5 / F5 | 20/21/200 条与 info/excluded 真实可查看；服务端截断明确，来源定位可辨；确认是主动操作，未 ready 不可用 |
| T07 | R6 / F6 | 199/200/201 观测边界正确；67 条 commit 越限时两个快照 truncated=true；selection 与 bridge 同源，空/禁用状态明确 |
| T08 | R6 / 接线 | 外部引擎→bundle 协调器→真实注入→bridge 非空 committed；其他会话空；读诊断不改正文/抽样/变量/状态；迟到/HMR/disposer/重挂无重复 |
| T09 | 全部 / 保持项 | selective_logic/use_probability 的驼峰/蛇形、false/0、独立/内嵌世界书、非 ST 原生策略、纯赋值卡、源对象不可变、权限/原子写盘不回归 |
| T10 | H1 / 独立操作 | 原备份可恢复；仅授权角色字段变化，完整帧/事件/引用回放成功；并发修改拒绝；无吞错、无删事件；用户确认可加载 |

真实 HTTP/浏览器 smoke 只用隔离 DSH_HOME、随机端口、合成素材，不调用真实模型或读取生产会话。
UI HTTP 替身可证明按钮生命周期；host 内存 handler 可证明输入/写盘契约；二者不能冒充实际部署的端到端证据。

## 7. 验证命令与证据要求

所有 shell 使用 `D:\App\PowerShell\7\pwsh.exe`。以下路径均是现有路径；拟新增用例在任务卡显式标注，建成前不把它们的运行记为通过。

```powershell
$Repo = 'D:\AI\GitHub\dsh-plugin-prompt-tool'
Set-Location 'D:\AI\workspase\_temp'
$env:TEMP = 'D:\AI\workspase\_temp'
$env:TMP = $env:TEMP

# 只改本次文档：无需业务构建或运行用户环境
git -C $Repo diff --check
git -C $Repo hash-object --no-filters `
  "$Repo\.scratch\prompt-tool-framework\archive\plan-st-import-diagnostics-f93182b.md"
# 结果必须为 7ee731dd8f27a4f43a006ee99a93c24addad0a84

# 后续实施：lib 是 host 测试输入，先用 package script 构建
pnpm --dir $Repo build
node --test "$Repo\test\host\st-preview-report.test.mjs" `
  "$Repo\test\host\st-compatibility.test.mjs" `
  "$Repo\test\engine\st-world-book.test.mjs" `
  "$Repo\test\host\pre-step-wiring.test.mjs" `
  "$Repo\test\shared\bridge-contract.test.mjs"

# 每个代码任务与最终集成门禁；test 脚本会在临时 cwd 内运行用例
pnpm --dir $Repo typecheck
pnpm --dir $Repo lint
pnpm --dir $Repo test
pnpm --dir $Repo build
pnpm --dir $Repo verify:host
git -C $Repo diff --check
```

- R0/R1 新增正式回归后纳入定向与全量发现；R5 复用 R1 浏览器用例，避免重复搭测试框架。
- 证据最少包含命令、退出码、通过/失败计数；浏览器额外记版本、操作步骤和实际按钮/请求行为；持久化额外记加载 API、事件数与回放结果。
- 临时文件、浏览器 profile、隔离服务均结束后清理；Windows 递归删除前校验绝对目标归属隔离目录。只停止本次启动的隔离实例。
- 生成分发快照有变化才按作用范围运行 rebuild:composition / sync:yaml；绝不手工编辑或删除版本化快照。
- 新会话按本文件任务状态恢复；旧 919/919 不能复用为新补丁门禁。必要 smoke 未完成时任务只记部分完成。

## 8. 发布、回滚与停止条件

### 本次文档交付

- 本轮仅调整 PLAN 用户决策与 AGENTS 通用流程；已有完整修复方案、原文归档和 UI 权威文档入口保持不变。
- 校验当前链接/源码定位/脚本名称、原文归档哈希、7 个 F 编号与 H0/H1 的任务和测试覆盖、拟新增文件标记、全部业务任务未完成状态。
- 仅暂存本次文档，中文 Conventional Commit，普通推送 origin/dev；不切 main、不创建 PR、不提交本地记忆。推送失败保留提交并报告。
- 文档变更不需要重启 DSH、重建预设或重新链接 profile。D0 仅代表文档编写与校验完成，提交/推送结果在交付时核对，不能因此勾选 R0–R6。

### 后续代码交付

- R0 优先，已知会损坏日志的旧版本不作为无条件回退方案。其余任务按 Wave 顺序独立提交，反向提交回退，不 reset/clean 用户工作树。
- runtime/engine/bundle 变化按现有重建与物化通道发布；需要用户重启 DSH 服务后生效时明确提示，由用户安排。不得自行刷新生产目录或重启服务。
- 新导入的角色降级和报告变化需明确告知；旧预设只在运行出口安全兼容，不自动保存、重导入或覆盖手工修改。
- 完成条件：R0–R6 的 T00–T09、最终门禁和必要集成 smoke 通过；报告修改文件、证据、提交、分支和限制。H1 未授权必须注明“未执行”，不得把历史日志已经恢复写进结论。

### 本次停止条件

完成用户决策记录、通用流程调整与文档提交后停止。所有代码修复保持未开始，历史数据恢复保持待单独授权。

## 9. Wave 与任务完成状态

`[✔]` = 已完成且对应验证通过；`[ ]` = 未完成。进行中、部分完成、失败或受阻均保持 `[ ]`，原因记录在 Task Summary。
Wave 只有在全部必需子任务验收通过后才能标记 `[✔]`；文档 Wave 完成不代表代码修复完成。

- [✔] **Wave 0：文档规划**
  - [✔] D0：旧计划原文已归档，完整修复方案、用户决策、任务卡及状态清单已编写并通过文档校验。
- [✔] **Wave 1：安全与导入生命周期**
  - [✔] R0：H0 合法消息出口、兼容降级与官方持久化回放回归（T00）。
  - [✔] R1：F1 角色 JSON 导入确认、取消及等待生命周期（T01）。
  - [✔] R2：F7 导入预览与版本参数运行时校验（T02）。
- [✔] **Wave 2：确认身份与诊断可信度**
  - [✔] R3：F2/F3 显式选组与版本化预览闭环（T03/T04）。
  - [✔] R4：F4 最终配置 ID、来源与报告同源（T05）。
  - [✔] R5：F5 全部有界有损信息可查看（T06）。
  - [✔] R6：F6 commit 后诊断截断与真实非空接线（T07/T08）。
- [✔] **最终集成验收**：T00–T09 由新增回归覆盖，typecheck / lint / test（932/932）/ build /
  verify:host（47 个官方包、0 失败）/ `git diff --check` 全部通过；未做真实 DSH 会话 smoke（不操作运行中的服务）。
- [ ] **独立恢复 H1**：历史日志恢复，尚未授权；不计入代码修复完成率。

当前代码修复进度：**7 / 7**（R0–R6 全部完成并通过各自验收与最终门禁）。历史日志恢复 H1 仍未执行。
