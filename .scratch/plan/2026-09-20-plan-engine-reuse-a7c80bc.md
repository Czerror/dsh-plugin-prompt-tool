# 引擎复用与模块化归一审查 PLAN

## 需求与授权

- 日期：2026-09-20；审查与建计划起始基线：`dev / a7c80bc`。
- 用户原始需求：`/dev-expert /codebase-design 审查引擎能力是否可复用模块化, 是否有可归一优化.`
- 用户补充要求：`按照仓库指令 应该创建为plan`。
- 已授权：审查、验证反例、将结论与候选任务写入本 PLAN。文档按仓库规则验证、提交并推送 `origin/dev`。
- 未授权：实施以下任何引擎、生成器或参数修复。Wave 1—4 都是供用户选定的候选范围，不因列入 PLAN 自动开始。
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

## 影响面、依赖与护栏

1. 主要链路：配置编译 → 策略绑定 → 独立执行器或宿主协调器 → 外层门控 → 宿主接纳/持久事件；以及导入/重建 → writer → 参数合并 → 组合与提示词物化 → 共享引擎同步。
2. Wave 0 是当前已授权工作。Wave 1—4 必须先由用户选定 R 编号；仅实施选中项，未选项记录为不在本轮范围。推荐优先 R1—R4，推荐不构成授权。
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

## 回滚与检查点

- 当前只有 PLAN 文档及忽略的本地日志，未修改运行行为；需要撤销已提交计划时用 `git revert`，不清理用户目录或重写历史。
- 未来每个选定任务完成后更新对应状态、验证命令、结果和实际基线。中断时以本 PLAN 中最后一个已验证任务为检查点；恢复前重新检查工作树及宿主依赖版本。
- 代码回滚采用对应提交的 `git revert`；测试数据只清理本任务创建的独立临时根，不触碰真实 DSH_HOME。
- 共享引擎同步和导入继续使用既有临时目录、原子 rename 与失败恢复；发现恢复失败时保留备份并记录现场，不自动删除。
- 若用户只选择部分 R 项，更新需求与授权并据此调整状态；所有选中任务完成后才归档，不以“审查完成”替代“修复完成”。

## 状态

- [✔] Wave 0 / T1：审查证据、PLAN 补录与文档核对完成；本轮仅交付计划，Git 提交推送凭据见交付回执。
- [ ] Wave 1 / T2、T3（R1、R2）：未启动，等待用户指定修复范围。
- [ ] Wave 2 / T4、T5、T6（R3、R5、R4）：未启动，等待用户指定修复范围。
- [ ] Wave 3 / T7、T8、T9（R6、R7、R8）：未启动，等待用户指定修复范围。
- [ ] Wave 4 / T10（A1 与选定范围验收）：未启动，依赖范围授权和所选实现通过。

## 验收记录

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
