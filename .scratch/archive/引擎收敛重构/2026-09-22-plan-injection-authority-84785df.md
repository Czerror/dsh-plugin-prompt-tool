# 注入层权威性、顺序刻度与来源黑名单 PLAN

> 本 PLAN 在「引擎收敛重构」总纲（`.scratch/plan/2026-09-22-plan-engine-convergence-master-84785df.md`）中是 **B8 支线**，排在 B0–B7 之后执行（B7 会先把 7 个专用能力模块重建为等价声明再删除，因此本支的 ②④ 要落在**触发器引擎**与**模式互斥的名单语义**上）。届时 ② 退化为声明里的触发器优先级、③ 挂在 B5 归一后的层注册表上、④ 变成一条「来源判断 + 剔除动作」的声明；本文件的任务块与验收标准继续有效，实现细节按当时的形态调整，但**验收断言不变**（真实 cordis 反例、区段归纳 + 下拉、精确等值匹配、来源黑名单的精确等值语义）。

## 需求与授权

- 日期：2026-09-22；基线：`dev / 84785df`（工作树仅余用户既有的未跟踪 `skills/`）。
- 用户原话（2026-09-22，dsh-purge 注入机制分析之后）：`1,是官方设定,官方minimal 也是如此设定,所以这是合理的,2 3 4值得参考,创建未完整修改plan方案,必须完整查证足够详细`。
- 据此确认的范围：
  - ①（complete 段在 `system-prompt/assemble` 之后覆盖 `sections` 并清空被 suppress 的 `contexts`）**判定为官方设计意图**，`pt-minimal` 是官方 minimal 的同构设定，**本轮不修、不改其定性**，也不写「缺陷」类文档表述。
  - ②③④ 三项进入本 PLAN：②assemble 门控的注册权威性、③`order` 的官方刻度参考、④按 `source.plugin` 的来源黑名单。
- 本轮产出：**只产出本 PLAN**，不落码、不改测试、不改文档；等用户逐 Wave 授权后开工。
- 对照来源：`D:\AI\GitHub\dsh-purge`（1.1.11 产物仓库，源码在 `lib/`，注入层级见 `.ai-memory/20260922/daily.md` 的 10:59 条目）。

## 审查结论

### ② assemble 门控只靠组合行序，注册权威性不足（严重度：中；性质：加固，非当前故障）

DSH 的 `system-prompt/assemble` 是 waterfall：`node_modules/@deepseek-ai/cordis/src/events.ts:234-243` 明确「监听器**由外向内**执行，`next()` 进入下一个，**最外层监听器的返回值即最终结果**」；注册位置由 `:254-257` 的 `options.prepend ? unshift : push` 决定，即 **`prepend` = 插到链首 = 最外层 = 最终权威**，且同为 `prepend` 时**后注册者更外层**。官方对该选项的告诫是 `docs/cordis-primer.zh.md:37`：「仅当监听器必须在普通注册之前运行时才使用 `prepend: true`」。

本项目 6 处 `system-prompt/assemble` 监听器**全部为普通注册**（`push`），顺序随加载顺序：

| 位置 | 语义 | 判定 |
|---|---|---|
| `engine/context-gate.mjs:174` | 未晋升时清空 `assembled.contexts` | **否决型**，应最外层 |
| `engine/tool-bootstrap.mjs:357` | 首轮窄化工具目录 + `personaSectionsOnly` 过滤 sections | **否决型**，应最外层 |
| `engine/tool-filter.mjs:69` | 常驻白/黑名单掩码（含第三方工具） | **否决型**，应最外层 |
| `engine/layers.mjs:271` | 在 `next()` 前填充 runtime-context 占位 | 协作式填充，**不应**抢外层 |
| `engine/promoted-code-mode.mjs:84` | 触发 `tools.presentAs('ptc')`，不改装配内容 | 纯副作用，不需要 |
| `engine/run-code-env.mjs:179` | 组装前 patch `run_code` transport | 纯副作用，不需要 |

判定证据链：

1. 本项目**已有** `prepend` 的正确先例，且全部在 assemble 之外：`engine/context-gate.mjs:224`、`:255`（`agent/pre-step`）、`engine/tool-bootstrap.mjs:478`（`agent/request`）、`engine/executor.mjs:439`、`engine/prompt-config-engine.mjs:76`。
2. 同一文件内存在**自相矛盾的假设**：`engine/context-gate.mjs:68-71` 写「ROW ORDER: mount this row FIRST in the composition…registering first (plus the pre-step listener's `prepend: true`) makes the gate the outermost transform」；而 `engine/tool-bootstrap.mjs:455-460` 已明确承认「`prepend` keeps this listener the OUTERMOST transform…**loader row application is concurrent; row order alone does not decide listener order — see issue #6 and upstream PR #13**」。后者才是真实约束：assemble 门控目前**只有行序这一条不成立的保证**。
3. 官方包全量核对：`deepseek-harness/packages` 内 `system-prompt/assemble.*prepend` **零命中**，即官方插件不会与门控竞争外层。
4. 真实风险源是第三方插件：dsh-purge 用 `ctx.on("system-prompt/assemble", hook, { global: true, prepend: true })`（`dsh-purge/lib/index.js:237`）重写整份 `sections`。同类插件排在本项目门控**外层**时，可在门控清空/窄化之后重新填充，翻越首轮上下文隔离与工具窄化。
5. 当前部署是否已触发：未观测到同 scope 存在 `prepend` 注册的 assemble 监听器，故这是**预防性加固**，不得描述成已发生故障。
6. 测试基建事实：`test/engine/promotion-gate.test.mjs:21-33` 与 `test/engine/tool-filter.test.mjs:11-24` 的 mock `ctx.on` **记录 `opts` 但不实现顺序语义**，`preStepThrough`（`promotion-gate.test.mjs:381-394`）按注册顺序串联；因此 `prepend` 的效果**只能**由真实 cordis 用例证明（`test/engine/official-variable-regression.test.mjs:20-58` 的 harness：真实 `Context` + 官方 `SystemPrompt` + `createScope`）。
7. 加 `prepend` 后三者互不干扰：`context-gate` 只动 `contexts`，`tool-bootstrap`/`tool-filter` 只动 `tools` 与 `sections`，且两个工具类过滤都是单调收缩（交集），先后顺序不改变结果。

### ③ `order` 是裸数字，缺官方刻度，且只有两层具备官方位置语义（严重度：低—中；性质：体验缺口 + 认知缺口）

`order` 的校验只有「有限数」这一条：`engine/schema.mjs:437-440`（`const order = spec.order ?? 0`，非有限数抛 `TypeError`），落盘与类型见 `src/host/prompt-configs.ts:15`/`:22`、`src/client/prompt-tool-types.ts:44`/`:61`。UI 上它是 `src/client/features/prompts/PromptConfigForm.tsx:178-180` 的一个 `NumberField`（`:151-152` 实为无 `type` 属性的文本输入 + `inputMode="numeric"`，**无步进器**），文案只有 `src/client/locales-prompts.ts:159-160`（zh `'form.order.label': '顺序'` / `'form.order.hint': '数值越小越靠前'`）与 `:605-606`（en 对应）。用户无法知道自己填的数字落在官方哪一段之间。

`order` 的真实作用面必须分两层说清，否则参考刻度会误导：

- **加载期**（所有层都受影响）：`engine/schema.mjs:520-531` 的排序契约——`configKind: 'anchor'` 保持文件序在前，`ordered` 按 order 稳定升序排在其后，默认 `order = 0` 等价文件顺序。这个数组顺序进而决定每层监听器的注册/执行顺序。
- **运行期**（只有两层进入官方 API 的 order 参数）：`engine/layers.mjs:203-208` 把 `base.order` 传给 `systemPrompt.section({ name, order, text })`、`:238-242` 与 `:249-265` 传给 `systemPrompt.context({ name, order, text })`。其余六层（`agent-request`、`llm-stream`、`tool-pipeline`、`turn-stop`、`subagent-start`、`subagent-end`）的 order **只在插件内部比较**（`engine/executor.mjs:256-257` 的 pre-step 升序、`engine/st-render.mjs:95-98`、`engine/layers.mjs:159-178`）。这与 `docs/adr/0002-insertion-points-remain-independent.md:3`「`order` 只在同一插入点内比较」一致。

结论：**官方 33 个 section 档位 / 3 个 context 档位只对 `system-section` 与 `runtime-context` 两层的 order 有意义**；其它层的参考文案必须显式说明「本层 order 只决定同层配置的执行顺序，不对应官方装配位置」，不得给出看似可比的档位。

可用性与约束（决定实现路径）：

- 已安装 `@deepseek-ai/dsh-system-prompt@0.1.6-alpha.2` 确有 `getSectionOrder(name)` / `getContextOrder(name)`（`node_modules/@deepseek-ai/dsh-system-prompt/lib/types/index.d.ts:246`、`:252`；产物 `lib/index.js:250`、`:258`），本地官方检出同为 `0.1.6-alpha.2`（`ddefc45fbc`），与 `docs/injection-point-contracts.md:3` 的核对基线一致。
- **但档位常量表没有从包导出**（`lib/index.js:365` 的 export 列表只有 `PERSONA_PREFIX_SECTION`、`PERSONA_SUFFIX_SECTION`、`SystemPrompt`、`TOOL_ORDER_REST`、`joinContextSections`、`renderContextSections`、`renderContextSnapshot`、`renderPrompt`），所以**名字清单必须手抄、数值必须运行期经服务取值**，不能 `import` 常量表。手抄常量在本仓库有明确先例与配套纪律（`src/shared/engine-capabilities.ts:11`：「与 `engine/schema.mjs` 的 `LAYER_ORDER` 同源，改一处必须同步另一处」）。
- 引擎已持有该服务并有成熟降级写法：`engine/layers.mjs:66-69`、`:182-186`、`:221-225` 用 `getService(ctx, 'systemPrompt')` + `typeof` 判断 + `warnOnce` 跳过；但**全仓库当前 0 处调用这两个方法**。
- 客户端拿不到官方常量：`/meta` 与 `/bootstrap` 的载荷都由 `src/runtime/settings-bridge.ts:572-590` 的 `loadEngineMeta()` 产出（`:793-800` 与 `:776-785` 同源），而 `engine/schema.mjs:238-261` 的 `getEngineMeta()` 是纯模块、不持有 ctx，**无法自己取官方数值**；该 bridge 文件已有读官方服务的先例（`:596` 读 `agents`、`:603` 读 `skills`，均在 try/catch 内降级）。契约与守卫：`src/shared/bridge-contract.ts:292-299`（`EngineMetaLayerContract`）与 `test/shared/bridge-contract.test.mjs:155-205`（只含白名单、不得含 function 与本地路径、`/meta` 与 `/bootstrap` 同源）。客户端退化默认在 `src/client/data/prompt-tool-fields.ts:56-73` 的 `EMPTY_META`，客户端字典守卫见 `test/client/locale-contract.test.mjs:80-90`（中英键集必须完全一致、非空且不等值）。

### ④ 只能按 `source.kind` 过滤，无法屏蔽指定第三方插件的注入（严重度：中；性质：能力缺口）

`context-gate` 的三个过滤点全部只读 `source.kind`（`engine/context-gate.mjs:202` 的 `messageSources` 分支、`:216` 的 `allowKinds` 分支、`:240` 的 `deferredSources` 分支），全文**没有** `source.plugin`；文件头 `engine/context-gate.mjs:7` 还写明了现有立场：「injection paths — **not a per-source denylist** — so it covers sources that do not exist yet」。因此 ④ 是**新增能力**，并会改变该条注释所声明的立场，不能当成缺陷修复来叙述。

关键事实是两边的 `source` 形状不同：

- 官方与第三方插件注入的消息统一是 `{ kind: 'plugin', plugin: '<插件名>' }`（`D:\AI\GitHub\deepseek-harness\packages\llm\llm\src\message.ts:104` 的 `plugin: { kind: 'plugin'; plugin: string }`）。已核到的真实 `plugin` 值包括 `agent-instructions`、`tools-ptc`、`compact`、`dsh-compaction-basic`、`plan-mode`、`repeat-tool-reminder`、`tool-jobs`、`model-selection`、`@deepseek-ai/dsh-system-prompt`、`hooks-codex`、`hooks-claude-code`、`tool-bash`、`cordis-host-runner`、`dsh-tool-skill`、`user-approval`。
- 本项目自己注入的消息是 `{ kind: config.sourceKind, plugin: identityOf(config) }`（`engine/executor.mjs:147-157`；merged 组在 `:291-293` 改写为 `merged:<position>`）。

结论：按 `kind` 过滤对官方/第三方注入只能看到 `'plugin'` 这**一个值**，无法区分来源；要屏蔽「某个具体插件的注入」必须按 `source.plugin`。参考实现是 dsh-purge 的 `isMnemonPluginMessage`（`dsh-purge/lib/identity.js:199-204`：要求 `kind === 'plugin'` 且 plugin 名小写**包含**匹配），其 `stripMnemon` 默认开启（`dsh-purge/lib/index.js:231`），并在 section 侧同法丢弃（`lib/identity.js:206-208`、`:257`）。

落地约束（影响改动面，必须先知道）：

- 新增一个 context-gate config 键会同时被两处测试钉死：`test/shared/engine-param-schema.test.mjs:113-130`（`engine/*.mjs` 的每个 `ALLOWED_KEYS` 键都必须有 `ENGINE_PARAM_DEFINITIONS` 的 UI 绑定，反向也必须相等）与 `test/host/engine-params-bridge.test.mjs:250-292`（本地模块行 config 键必须 ⊆ 硬编码的 ALLOWED 镜像，其中 `:257-258` 就是 context-gate 的键集）。
- 参数链路是单一目录：`src/shared/engine-params.ts:239`/`:258-261` 定义（`kind: 'string-list'`、`card: 'context-gate'`、`module: { row: 'context-gate' }`）→ `buildEngineModuleParams`（`:310-340`）→ `applyModuleConfigs` 写入 `agent.cordis.yml` 行 config；UI 由 `src/client/features/modules/EngineParamFields.tsx:41` 按 `card` 取键、`:123-128` 的 `string-list` 分支渲染成 `TagInput`；中文文案在 `src/client/locales-params.ts`（现有同类：`:48` `'param.messageSources': '消息来源白名单'`），中英键集强制一致。
- 现有行为测试入口：`test/engine/promotion-gate.test.mjs:379-496`（6 条 context-gate 用例 + `:381-394` 的 `preStepThrough` 串联 helper + `:396` 的 `msg(kind, text)` 构造器，只造 `source: { kind }`，**需要扩展出带 `plugin` 的构造器**）与 `test/host/pre-step-wiring.test.mjs`（`:226` T23 门控剥离、`:253` R1 晋升后补发、`:388` 迟到协调器不得绕门控、`:671` prepend LIFO、`:694` 真实共挂）。
- 安全边界：`messageSources` 分支目前对 claimed 批**不豁免**（`:200-204`），新增黑名单必须保持 claimed 批（用户消息 `kind: 'user'`）不受影响；`reject` 步必须原样返回；过滤自身失败一律降级为「保留全部消息」（对齐 `:219-223` 的既有纪律）。

## 影响面、依赖与护栏

- 涉及模块（按 Wave）：
  - Wave 1（②）：B7 收敛后的 assemble 门控注册处（旧 `engine/context-gate.mjs`、`engine/tool-bootstrap.mjs`、`engine/tool-filter.mjs` 已被 B7 删除）、`docs/engine-reuse.md`、`docs/injection-point-contracts.md`、`test/engine/official-variable-regression.test.mjs`（或新增同级真实 cordis 用例文件）。
  - Wave 2（③）：`src/shared/official-orders.ts`（新增）、`src/runtime/settings-bridge.ts`、`src/shared/bridge-contract.ts`、`src/client/features/prompts/PromptConfigForm.tsx`、`src/client/locales-prompts.ts`、`src/client/data/prompt-tool-fields.ts`、`test/shared/bridge-contract.test.mjs`、`test/client/prompt-config-form-layout.test.mjs`。
  - Wave 3（④）：B7 收敛后的 pre-step 门控载体、B3 T3 的声明契约、`src/shared/engine-params.ts`、`src/client/locales-params.ts`、`test/engine/promotion-gate.test.mjs`、`test/host/pre-step-wiring.test.mjs`、`test/host/engine-params-bridge.test.mjs`、`test/shared/engine-param-schema.test.mjs`、`test/client/engine-module-cards.test.mjs`、`docs/engine-reuse.md`、`docs/injection-point-contracts.md`。
- 任务依赖与**并行冲突**（改同一文件的任务必须串行或合并，不得并发）：
  - B7 收敛后的门控载体被 Wave 1 与 Wave 3 同时修改（前者改 assemble 注册选项，后者加 pre-step 剥离步骤、加声明键、改立场注释）→ **两 Wave 串行**；若追求并行，须由同一执行者一次改完该载体。
  - `docs/engine-reuse.md`、`docs/injection-point-contracts.md` 被 Wave 1（T2）、Wave 2（T6）、Wave 3（T10）三处修改 → 三者的章节不同但**文件相同，必须由同一执行者串行落笔**，不得并发编辑同一文件；若追求并行，则把三处文档改动合并为一个任务。
  - `CHANGELOG.md` 同理：三个 Wave 都可能追加条目，统一由 T11 收口时写成一条完整叙述，各 Wave 任务不写 CHANGELOG（已在 T2/T6/T10 的 `<files>` 中显式排除）。
  - Wave 2 与 Wave 3 内部各自无冲突（客户端文案文件互不相交：`locales-prompts.ts` 只归 Wave 2，`locales-params.ts` 只归 Wave 3），可并行推进。
  - 三个 Wave 的验证统一在 Wave 4 收口；每个 Wave 完成时工作树须保持 typecheck / lint 可过。
- 硬约束：
  - 不修改 DSH 源码仓库，只使用已发布官方包与官方扩展点。
  - 只加 `prepend`，**绝不加 `global: true`**：门控必须留在声明它的 scope 内，不得跨预设/子代理串味（`events.ts:171-174` 的 global 会绕过 scope 过滤）。
  - mock ctx 不实现 `prepend` 顺序，因此新增断言必须落在真实 cordis 装配上；既有 mock 用例保持原状（每个用例只挂一个引擎行，取 `listeners[0]`，加 `prepend` 对其零影响）。
  - 引擎改动属装配期行为，需用户重启 DSH 后生效；本 PLAN 不重启在役服务。
  - 测试 cwd 固定 `D:\AI\workspase\_temp`，用独立 `DSH_HOME`，结束后清理。

## 落点口径（与 B7 收敛后机制的对应关系）

本支在三份 PLAN 的**最后**执行（`B0→…→B7→B8`）。B7 会删除 `engine/{tool-filter,context-gate,anchor-turn,deliberation-gate,progress-reminder,tool-bootstrap,promoted-code-mode}.mjs` 这批旧能力，因此本文中出现的这些文件路径**只是现状取证**（说明问题从哪来、旧实现怎么写），不是改点。执行本支时一律落到 B3/B7 定稿的新机制载体上：

| 本支主张 | 旧落点（B7 后不存在） | 新落点 |
|---|---|---|
| 参数声明的位置与校验 | `card: 'context-gate'` + 组合模块行 | B3 T3 定义的 `preset.yml` 触发器声明入口 |
| 否决型 assemble 门控须位于普通注册之外 | `engine/context-gate.mjs`、`tool-bootstrap.mjs`、`tool-filter.mjs` 各自的 `ctx.on('system-prompt/assemble', …)` | B7 收敛后**唯一**的 assemble 门控注册处（由 B7 定稿；若三类否决合并为一个守卫点，则只需在这一处加 `prepend`） |
| 按 `source.plugin` 屏蔽注入 | `engine/context-gate.mjs` 的 `ALLOWED_KEYS` / `apply()` / 新增第三个 `agent/pre-step` 监听器 | 同一新载体 + B3 T3 的声明契约 |

执行纪律：动工前先读 B3/B7 的**实际交付**（新机制的声明入口与门控注册处），以实际载体为准重述本支任务；若新机制已天然满足某条主张（例如新的门控注册本来就带 `prepend`），该任务降级为「补一条真实 cordis 断言 + 更正注释」，不再重复实现。**任何情况下不得为了对上本文原文而恢复已删除的旧文件。**

## Wave 1：assemble 门控的注册权威性（②）

```xml
<task type="auto">
  <name>T1：否决型 assemble 门控改为 prepend 注册（落点为收敛后载体），并更正行序注释</name>
  <files>B7 收敛后的 assemble 门控注册处（旧路径 `engine/context-gate.mjs`、`engine/tool-bootstrap.mjs`、`engine/tool-filter.mjs` 已在 B7 删除，仅作取证）；真实 cordis 顺序用例（新建 `test/engine/assemble-authority.test.mjs`，或并入 `test/engine/official-variable-regression.test.mjs`）</files>
  <action>在 B7 收敛后的**每一处**否决型 assemble 门控注册上补第三参数 `{ prepend: true }`：旧实现分别是 `engine/context-gate.mjs:174`、`engine/tool-bootstrap.mjs:357`、`engine/tool-filter.mjs:69`，改点以新载体的实际调用为准（三类否决可能已合并为一处）；同文件既有的 prepend 先例（旧 `context-gate.mjs:224`、`tool-bootstrap.mjs:478`）保持同一写法。不改监听器回调体、不改过滤/清空逻辑、不改协作式填充与纯副作用监听器（旧 `layers.mjs:271`、`promoted-code-mode.mjs:84`、`run-code-env.mjs:179` 的对应位置）。同时把新载体里残留的「依赖组合行序 / ROW ORDER」说明改为「门控由 prepend 保证位于普通注册之外，不再依赖组合行序」，并引用已记录的并发装配事实（旧 `tool-bootstrap.mjs:455-460`：行应用是并发的，行序不决定监听器顺序）。若新载体已自带 `prepend`，本任务只保留注释更正与真实 cordis 断言。</action>
  <verify>先写真实 cordis 反例并确认其先红。注意反例必须用 **prepend 的竞争者**：改前引擎是普通注册（`push`），一个后注册的**普通**监听器本就在它的内层、根本翻越不了，用那种写法测不出红。正确设计：用 `test/engine/official-variable-regression.test.mjs:20-58` 的 harness（真实 `Context` + 官方 `SystemPrompt` + `createScope`），先注册一个 **prepend 的竞争 assemble 监听器**（模拟先加载的第三方插件），它在 `await next()` 之后把 `contexts` 填回去，再挂引擎行并断言——改前引擎为普通注册，竞争者位于链首、门控被翻越、未晋升时 `contexts` 非空（断言先红）；把引擎改为 prepend 后（`unshift` 插到竞争者之前）门控重新位于最外层，未晋升时 `contexts` 为空（转绿）；已晋升时两种顺序都必须保留填充内容。同法覆盖 tool-bootstrap 的首轮窄化与 tool-filter 的掩码。另补一条**边界断言**：当竞争者同样 prepend 且**注册在引擎行之后**时，它仍处于更外层、门控仍会被翻越——该用例如实断言这一已知限制（不伪装通过），注释指向本 PLAN 的「实施取舍与已知边界」。既有 `test/engine/promotion-gate.test.mjs`、`tool-filter.test.mjs`、`injection-gates.test.mjs`、`official-variable-regression.test.mjs` 全部保持通过。</verify>
  <security>只改注册选项，不触碰消息内容、不写盘、不放宽任何过滤：prepend 只提高监听器在 waterfall 中的位置，不改变其判定条件；严禁顺带加 global: true，避免门控跨 scope 生效影响其它预设或子代理。测试使用临时 DSH_HOME 与临时目录并在 t.after 清理，不接触真实用户配置。</security>
  <done>三处门控为 prepend 注册，真实 cordis 反例证明后注册的普通监听器无法翻越；注释不再声称依赖行序；相关定向测试与完整门禁全绿。</done>
</task>
```

```xml
<task type="auto">
  <name>T2：把 assemble 顺序语义固化进引擎文档与结构契约</name>
  <files>docs/engine-reuse.md；docs/injection-point-contracts.md（B7 收敛载体的注释一致性由 T1 负责，本任务不重复改源码；CHANGELOG 条目统一由 T11 落笔）</files>
  <action>在 docs/engine-reuse.md 的插入点章节补一段「同 scope 内的注册顺序」事实：waterfall 由外向内、先注册者在外、prepend 插到链首且后注册者更外层；本项目否决型门控（context-gate 的 contexts 清空、tool-bootstrap 的窄化与 personaSectionsOnly、tool-filter 的掩码）用 prepend 取得否决权，协作式填充（runtime-context）与副作用监听器保持普通注册。docs/injection-point-contracts.md 的 system-section / runtime-context 行补同一句顺序约束，不改任何既有语义陈述。</action>
  <verify>文档改动后核对相对路径、章节锚点与命令可执行；git diff --check 退出 0；按仓库规则只改文档时无需跑测试，但需人工复核与 engine 注释、测试名一致，且不把「不依赖行序」写成「与顺序无关」。</verify>
  <security>纯文档，不涉及输入、权限、写盘与网络；不得写入 token、路径凭据或第三方仓库内部细节。</security>
  <done>两份权威文档如实描述注册顺序与 prepend 的适用范围，与实际实现和测试断言一致。</done>
</task>
```

## Wave 2：`order` 的官方刻度参考（③）

```xml
<task type="decision">
  <name>T3：确定刻度的呈现粒度与交互形态</name>
  <files>src/shared/official-orders.ts（若选区段方案）；src/client/locales-prompts.ts；src/client/features/prompts/PromptConfigForm.tsx</files>
  <action>**已拍板（2026-09-22，用户选定）**：粒度取**区段归纳**（方案 A），交互取**可选下拉自动填值**（形态 B）。区段归纳的口径：共享常量只存**有序的档位名分组**（不存数值），section 侧分 6 组——①身份与人设前（`HARNESS_IDENTITY`、`DEPLOYMENT_PERSONA_PREFIX`）②策略与引用（`PLAN_POLICY`、`TEAM_POLICY`、`PTC_ONLY`、`FILE_REFERENCE`）③工具指导（`TOOL_BASH` … `MCP_SERVERS`）④SDK 与外部面（`TOOLS_SDK`）⑤产出与结构化（`DELIVERABLE_FILE_REFERENCES`、`STRUCTURED_OUTPUT`）⑥人设后收尾（`HARNESS_SOURCE`、`WEB_SURFACE`、`DEPLOYMENT_PERSONA_SUFFIX`）；context 侧合成 1 组「运行策略」（`SANDBOX_POLICY`、`APPROVAL_POLICY`、`SUBAGENT_DELEGATION`）。每组的下界/上界数值一律由组内首末档位名**运行期求值**，字典只需 7 个区段名键（中英各 7 个）。交互采用下拉填值：下拉项为这 7 个区段（语义即「插到该区段之前」），选中后把对应边界数值写入 order 字段；下拉只是快捷填值入口，**数字输入仍是唯一真相与唯一写入通道**，清空下拉不清空 order，也不引入第二份草稿。被否决的形态 A（仅只读提示）不保留半成品实现。</action>
  <verify>拍板结论已写入本任务的 action 与 `## 状态`；所选方案决定 T4 的清单结构（按组存名字、运行期求边界）与 T5 的组件改动范围（新增下拉 + 保持数字输入），未选项不得在实现里留半成品开关。</verify>
  <security>纯呈现层取舍，不改变 order 的存储、校验（仍为有限数）与运行期语义；不得因为「看起来更友好」而给 order 增加范围或步长限制，那会破坏既有预设的合法取值；下拉选中写入的值必须是本区段的真实边界值，不得写入自定义常量。</security>
  <done>已拍板：区段归纳（section 6 组 + context 1 组）+ 可选下拉自动填值；与 T4/T5 的文件清单一致。</done>
</task>
```

```xml
<task type="auto">
  <name>T4：官方档位名字清单与运行期取值，经 bridge 下发</name>
  <files>src/shared/official-orders.ts（新增）；src/runtime/settings-bridge.ts；src/shared/bridge-contract.ts；test/shared/bridge-contract.test.mjs；test/host/*（bridge 相关）</files>
  <action>新增 `src/shared/official-orders.ts`：按 T3 拍板的区段口径**手抄档位名分组**（section 侧 6 组、context 侧 1 组，覆盖官方 33 + 3 个档位名，按已安装 `@deepseek-ai/dsh-system-prompt@0.1.6-alpha.2` 的 `lib/types/index.d.ts:113-154` 抄录），文件头写明来源版本、核对基线 `ddefc45fbc` 与「与官方包同源，官方新增或改名档位时须同步本文件」的纪律（对齐 `src/shared/engine-capabilities.ts:11` 的既有先例）；**不抄任何数值**，只存名字分组与区段 id。在 `src/runtime/settings-bridge.ts` 的 `loadEngineMeta()`（`:572-590`）里按该文件已有的读服务先例（`:596` 的 `sctx.get?.('agents')`、`:603` 的 `sctx.get?.('skills')`，均在 try/catch 内降级）取 `systemPrompt`，对每组用 `getSectionOrder(name)` / `getContextOrder(name)` 求**该组首末档位的数值**，下发 `meta.officialOrders = { sections: [{ id, from, to }], contexts: [{ id, from, to }] }`（`id` 为区段标识，显示名走客户端字典）；**任一组内有名字取不到有限数**（官方改名、方法缺失或服务缺失）时**整体不附加该字段**并 `warnOnce` 一次——不下发部分区段，否则 UI 会展示一份看似完整实则缺口的刻度。同步 `src/shared/bridge-contract.ts:292-299` 的契约类型与 `test/shared/bridge-contract.test.mjs:155-205` 的白名单断言（仍不得含 function 与本地路径、`/meta` 与 `/bootstrap` 必须同源）。</action>
  <verify>新增断言：(1) 真实 bridge 载荷含 7 个区段（section 6 + context 1），每项 `{ id, from, to }` 为可序列化基本类型且 `from <= to`；(2) 边界值与逐名调用官方方法的结果一一对应（同一次装配内不出现偏差）；(3) 拔掉 systemPrompt 服务、或让某个档位名取不到有限数时，该字段**整体缺席**、无异常、只有一个 `warnOnce`，且 `test/client/bridge-client.test.mjs:91-94`/`:114` 的退化默认依旧成立；(4) `/meta` 与 `/bootstrap` 的档位表同源一致。既有 `test/shared/bridge-contract.test.mjs` 全部保持通过。</verify>
  <security>该字段只包含官方公开档位名与数值，不含任何本地路径、凭据或用户数据；不新增端点、不改 bridge 的成功/失败包装与白名单校验；取值失败必须降级为「不显示」，绝不用手抄数值兜底（手抄数值正是版本漂移的来源）。</security>
  <done>档位表随 `/meta` 与 `/bootstrap` 下发，缺服务时安全缺席，契约与守卫测试同步。</done>
</task>
```

```xml
<task type="auto">
  <name>T5：order 字段的刻度呈现与分层说明</name>
  <files>src/client/features/prompts/PromptConfigForm.tsx；src/client/ui/MenuSelect.tsx（复用，预期不改）；src/client/locales-prompts.ts；src/client/data/prompt-tool-fields.ts（`EMPTY_META` 与 `EngineMeta` 类型）；test/client/prompt-config-form-layout.test.mjs；test/client/locale-contract.test.mjs（键集守卫）</files>
  <action>按 T3 拍板实现，含下拉填值。刻度**只出现在 `system-section` 与 `runtime-context` 两层**的 order 字段上——只有这两层把 order 原样交给官方 `section()`/`context()`（`engine/layers.mjs:203-208`、`:238-242`）；其余六层（`agent-request`、`llm-stream`、`tool-pipeline`、`turn-stop`、`subagent-start`、`subagent-end`）的 order 字段改显示为说明文案「本层 order 只决定同层配置的执行顺序，不对应官方装配位置」，不得展示任何档位数值（避免让用户以为可与官方位置比较）。下拉实现：在两层的 order 字段旁复用现有 `src/client/ui/MenuSelect.tsx` 渲染一个「插入到官方位置…」选择器，选项来自 `meta.officialOrders`（区段显示名走 `src/client/locales-prompts.ts` 的 7 个新键，中英各 7 个），每项选中后把该区段的 `from` 写入 order，另加一项「最后」写入全部区段 `to` 的最大值 + 1；`officialOrders` 缺席（服务降级）时**不渲染该下拉**，只保留原有数字输入。数字输入仍是唯一真相与唯一写入通道：下拉只调用既有的 `onPatch({ order })` 路径，不持有独立草稿、不清空 order、不新增保存队列入口。同步更新 `src/client/data/prompt-tool-fields.ts:56-73` 的 `EMPTY_META`（含 `officialOrders` 的可选类型）保证退化路径不显示刻度。</action>
  <verify>客户端用例：`test/client/prompt-config-form-layout.test.mjs`（照 `:20-60` 的既有写法挂 SSR harness）断言 system-section / runtime-context 两层渲染出下拉、选项含 7 个区段名、其余层含「不对应官方装配位置」说明且不含档位数值；`officialOrders` 缺席时不渲染下拉；选中某区段后 order 草稿被写入该区段 `from`、选择「最后」写入 max `to` + 1，且数字输入随后手改仍生效（下拉不覆盖用户手改）。`test/client/locale-contract.test.mjs:80-90` 的中英键集一致、非空、不相等断言通过（新增 14 个键）；`EMPTY_META` 退化用例不抛 `missing locale key`；`test/client/ui-v2-page-smoke.test.mjs:669-678` 的既有 order 输入交互（`1e`/`-` 草稿）保持通过。</verify>
  <security>不改变 order 的校验与存储（仍为有限数、仍走既有草稿与保存队列）；不新增可写通道——下拉只复用既有 `onPatch({ order })`，不得直写 store 或绕过保存队列；下拉写入的数值**必须来自 `meta.officialOrders`**，客户端不得硬编码任何档位数值（否则官方改档位后 UI 会给出过期刻度）；提示文案不得把官方档位说成「必须使用」的取值，也不得暴露官方内部实现细节。</security>
  <done>两层显示官方刻度参考、其余六层显示正确说明，中英文案完整，退化路径与既有交互不变。</done>
</task>
```

```xml
<task type="auto">
  <name>T6：order 语义与刻度来源的文档同步</name>
  <files>docs/injection-point-contracts.md；docs/ui-architecture.md；README.md（按需）；CHANGELOG 条目交由 T11 统一落笔，本任务不写</files>
  <action>在 `docs/injection-point-contracts.md` 补一节「order 的作用面」：加载期对所有层生效（`engine/schema.mjs:520-531` 的 anchor 优先 + ordered 升序），运行期只有 `system-section` 与 `runtime-context` 进入官方 API 的 order 参数，其余层只在同一插入点内比较（与 `:3` 的既有表述「`order` 只在各自入口内解释」自洽，不推翻它）；同时说明刻度的来源是运行期 `getSectionOrder`/`getContextOrder` 取值、名字清单手抄自 `0.1.6-alpha.2`，官方新增档位时需同步 `src/shared/official-orders.ts`。`docs/ui-architecture.md` 在排序/表单分区相关段落（`:607`、`:624` 附近）补刻度呈现的分层规则。</action>
  <verify>文档中的路径、行号引用、命令与实现一致；`git diff --check` 退出 0；只改文档时按仓库规则不强制跑测试，但需人工复核与 `src/shared/official-orders.ts` 的注释、UI 文案三处表述一致。</verify>
  <security>不写入凭据、本地绝对路径或用户私有数据；不把官方档位表抄成"权威清单"而忽略运行期取值这一事实。</security>
  <done>文档如实描述 order 的两层作用面与刻度来源，与实现、注释、UI 一致。</done>
</task>
```

## Wave 3：按 `source.plugin` 屏蔽第三方注入（④）

```xml
<task type="decision">
  <name>T7：确定 blockedPlugins 的匹配语义</name>
  <files>src/client/locales-params.ts（hint 文案随语义定稿）；实现落点为 B7 收敛后的 pre-step 门控载体（旧 `engine/context-gate.mjs` 已删除，仅作取证）</files>
  <action>**已拍板（2026-09-22，用户选定）**：方案 A——仅当 `message.source.kind === 'plugin'` 时，把 `source.plugin` 与列表项做**大小写不敏感的精确等值**比较（两侧统一 `toLowerCase()` 后全等，不做子串、不做正则、不做 glob）。理由：`source.plugin` 是插件自报的稳定身份（官方值如 `agent-instructions`、`tools-ptc`、`@deepseek-ai/dsh-system-prompt`），精确匹配可预测、无误伤；用户需要知道确切插件名这一点由 UI hint 补偿——hint 里列出已核实的常见取值。被否决的方案 B（小写子串包含，对齐 dsh-purge 的 `isMnemonPluginMessage`）不保留实现路径，但要在文档里写明「本插件不做子串匹配，要覆盖 `dsh-mnemon` 需写全名」，避免用户照搬别处的 `mnemon` 写法后困惑于不生效。</action>
  <verify>拍板结论已写入本任务的 action 与 `## 状态`；实现完成后由 T8/T10 的用例证明该语义：`blockedPlugins: ['dsh-mnemon']` 必须剥离 `{kind:'plugin',plugin:'dsh-mnemon'}`，而 `{kind:'plugin',plugin:'mnemon'}`、`{kind:'plugin',plugin:'dsh-mnemon-helper'}` 均**不被**剥离（子串写法在此语义下不生效，这条正是与方案 B 的分界断言）；大小写不同的同名插件（如 `DSH-Mnemon`）仍应命中。</verify>
  <security>该名单只影响消息过滤，不涉及文件、权限或网络；必须由用户显式填写才生效（未声明=不过滤），不得预置任何第三方插件名做默认屏蔽。</security>
  <done>匹配语义唯一确定，且引擎注释、UI hint、测试断言三处表述一致。</done>
</task>
```

```xml
<task type="auto">
  <name>T8：引擎新增 blockedPlugins 过滤与立场注释更新</name>
  <files>B7 收敛后的 pre-step 门控载体（旧 `engine/context-gate.mjs` 已删除，仅作取证）；B3 T3 的声明契约（与 T9 同一落点，须串行）；test/engine/promotion-gate.test.mjs（扩展 `msg` 构造器以支持带 `plugin` 的来源；该文件若随 B7 改名则跟随新名）</files>
  <action>**落点按上文「落点口径」表**：旧实现的行号（ALLOWED_KEYS `:94-97`、归一化段 `:142-145`、失败降级 `:219-223`）只用于说明要插入的逻辑形态，实际写进 B7 收敛后的 pre-step 门控载体与 B3 T3 的声明契约。按现有 `sourceList` 同款校验（非空字符串数组，`undefined`=不过滤）读取新键。在 pre-step 阶段新增一个 prepend 的剥离步骤（与相位无关，未晋升/已晋升都生效）：`await next()` 后若 `decision.kind === 'reject'` 原样返回；否则从 `decision.messages` 中剔除命中名单的插件消息，长度不变则返回原对象；自身异常走 `warnOnce` 并保留全部消息（对齐 :219-223 纪律）。claimed 批（`kind: 'user'`）因前置条件不可能是 `kind === 'plugin'`，天然不受影响；不修改现有两个监听器的任何判定。同时更正新载体中对应文件的立场注释（旧 `engine/context-gate.mjs:7` 的对应句）：说明门控仍不以「逐源黑名单」为默认路径，但新增了可选的 `blockedPlugins` 逃生阀，且默认不启用。</action>
  <verify>先写反例：`test/engine/promotion-gate.test.mjs` 的 `msg(kind, text)` 构造器扩展出可带 `plugin` 的变体后，(1) 未声明 `blockedPlugins` 时 `{kind:'plugin',plugin:'dsh-mnemon'}` 消息照常通过（回归）；(2) 声明后该消息被剥离，而 `{kind:'user'}`、`{kind:'goal'}` 与其它插件消息保留；(3) `reject` 步仍返回 reject；(4) 未晋升与已晋升两个相位都生效；(5) 监听器抛错时保留全部消息。既有 6 条 context-gate 用例与 `test/host/pre-step-wiring.test.mjs` 的 T23/R1/prepend LIFO 全部保持通过。</verify>
  <security>输入边界：名单项必须为非空字符串（非法数组在挂载期 fail loud，不静默降级为「全拦」）；过滤只读 `source.kind`/`source.plugin`，不改写消息内容、不写盘、不触碰文件与网络；不得让该名单影响 claimed 批、reject 步或其它插件的正常注入；`warnOnce` 只输出插件名与错误摘要，不打印消息正文。</security>
  <done>blockedPlugins 默认关闭、显式开启后按拍板语义剥离指定插件消息，两个相位一致，失败降级保留全部消息。</done>
</task>
```

```xml
<task type="auto">
  <name>T9：声明参数目录、UI 文案与契约镜像同步（落点是新声明入口）</name>
  <files>触发器声明的参数落位（由 B3 T3 定义）；src/shared/engine-params.ts；src/client/locales-params.ts；test/shared/engine-param-schema.test.mjs；test/host/engine-params-bridge.test.mjs</files>
  <action>**存储与编辑入口必须落在 B3 T3 定义的触发器声明上，不能挂在 `card: 'context-gate'`**（R6——B7 会删除该能力卡与对应行，本支若仍写到那张卡就等于写到已删除的入口）。按 B3 确定的 `preset.yml` 声明契约新增 `blockedPlugins`（`string-list`，未声明 = 不过滤），并同步 `src/client/locales-params.ts` 的中英同键文案（中文「屏蔽的插件来源」+ hint 说明填 `source.plugin` 的取值并给出已核实示例，英文对应）。镜像同步按**当时的**契约位置进行：`test/host/engine-params-bridge.test.mjs:250-292` 的硬编码键集与 `test/shared/engine-param-schema.test.mjs:113-130` 的双向闭合断言随新键更新。</action>
  <verify>(a) 新键在**新入口**上可见可存、往返一致；(b) 三处一致性断言全绿：声明 `ALLOWED_KEYS` ↔ `ENGINE_PARAM_DEFINITIONS` ↔ 参数桥镜像；(c) `test/client/prompt-tool-view.test.mjs:113-124`（string-list 字符串化回读）对新键通过，且 `test/client/engine-module-cards.test.mjs:151-167` 一类「字段集合不增不丢」的断言按**预期新增**更新，而非放宽容差；(d) `test/host/write-preset.test.mjs:216-260` 的**空值语义**有专门断言——本键空 = 关闭，与既有 `allowKinds` 空数组 = 全拦**不同**，避免沿用邻居语义；(e) 端到端按 R6 的口径：**保存 → 重建 → 重载 → 首次 / 晋升后 / 压缩后执行**，不以「无加载错误」代替等价证明。</verify>
  <security>只走既有 layerSettings 写盘通道与 bridge 白名单，不新增端点、不改 bridge 契约；空值语义必须与 `allowKinds`/`messageSources` 区分清楚（本键空 = 关闭），防止用户以为空列表等于「全拦」而误配；文案不得写入 token 或用户私有路径。</security>
  <done>新键在 UI 可见可存、往返一致，三处契约镜像与客户端用例全部同步并通过。</done>
</task>
```

```xml
<task type="auto">
  <name>T10：来源黑名单的行为回归与文档同步</name>
  <files>test/host/pre-step-wiring.test.mjs；docs/engine-reuse.md；docs/injection-point-contracts.md；README.md（按需）；CHANGELOG 条目交由 T11 统一落笔，本任务不写</files>
  <action>在 `test/host/pre-step-wiring.test.mjs` 补一条真实共挂用例：**新声明入口**（B3 T3 定义的触发器声明，不是 B7 已删除的 context-gate 卡与模块行）开启 `blockedPlugins` 后与 executor 同 scope 挂载，断言被屏蔽插件的注入消息在**本步**被剥离且不计入投递去重，关闭该键后同一路径恢复注入（对照证明剥离确实来自本键而非门控其它分支）。文档侧在 `docs/engine-reuse.md` 的能力表（:64）、默认值表（:316-320）与严格两阶段示例（:388-392）旁补 `blockedPlugins`，并在 `docs/injection-point-contracts.md` 的 pre-step 行说明「按 `source.plugin` 的显式屏蔽为可选逃生阀，默认不启用」。</action>
  <verify>新用例先红后绿；`pnpm --dir $Repo test` 全量通过；**声明链闭合**：新键的声明入口 → 引擎实际读取处 → UI 文案三处同名同义，`docs` 中新增表述与引擎实际语义一致；`git diff --check` 退出 0。</verify>
  <security>测试使用独立临时 `DSH_HOME` 与临时目录并在结束时清理，不依赖执行顺序；文档只描述稳定行为，不写第三方插件的内部实现细节或凭据。</security>
  <done>新能力有端到端行为证明，两份引擎文档如实记录这一可选行为（CHANGELOG 由 T11 统一落笔）。</done>
</task>
```

## Wave 4：门禁、归档与交付

```xml
<task type="auto">
  <name>T11：完整门禁、PLAN 归档与推送</name>
  <files>本 PLAN；CHANGELOG.md；.ai-memory/（本地追加，不入库）；源码与测试文件（按各 Wave 实际改动）</files>
  <action>三个 Wave 汇合后按顺序收口：先跑定向回归（`test/engine/promotion-gate.test.mjs`、`test/engine/tool-filter.test.mjs`、`test/engine/prompt-config-engine.test.mjs`、`test/engine/official-variable-regression.test.mjs`、`test/host/pre-step-wiring.test.mjs`、`test/host/engine-params-bridge.test.mjs`、`test/shared/engine-param-schema.test.mjs`、`test/shared/bridge-contract.test.mjs`、`test/client/prompt-config-form-layout.test.mjs`、`test/client/locale-contract.test.mjs`），再跑完整门禁 `pnpm --dir $Repo typecheck` / `lint` / `test` / `build` 与 `git -C $Repo diff --check`；随后填满 `## 状态` 与 `## 验收记录`，把本 PLAN 原样复制到 `.scratch/archive/` 并从 `.scratch/plan/` 移除，随本轮代码改动同一个中文 Conventional Commit 推送 `origin/dev`；`.ai-memory/{日期}/daily.md` 按仓库协议追加本轮条目（不入库）。</action>
  <verify>四条命令与 `git diff --check` 全部退出 0、完整测试 0 失败 0 跳过；提交前核对暂存范围只含本轮文件（不含 `.scratch` 临时物、`lib/` 生成物、本地记忆与用户既有未跟踪目录）；推送后 `git -C $Repo status --short` 与 `git log -1` 作为交付凭据抄进 `## 验收记录`。</verify>
  <security>不提交生成产物、日志、临时目录与用户文件；不执行 `reset --hard`/`clean`/`checkout` 覆盖等破坏性操作；不启停在役 DSH 服务，交付说明中标注「引擎与宿主改动需用户重启 DSH 后生效」。</security>
  <done>完整门禁通过，PLAN 归档、CHANGELOG 与本轮行为变化同步，提交已推送 `origin/dev`。</done>
</task>
```

## 回滚与检查点

- 代码回滚：三个 Wave 按 T11 合并为同一个提交推送时，`git revert <提交>` 即整体撤回（三处 `prepend` 与注释、③ 的档位清单与 bridge 字段、④ 的 `blockedPlugins` 及其参数/UI 接线一并回退），不影响其它轮次；若用户授权时要求按 Wave 分开提交，则按对应提交粒度 revert，无需改动本 PLAN。
- 数据侧无需回滚：③ 只新增只读字段、不写预设；④ 新增的参数不在组合源声明默认值，既有预设加载后该键缺失即等于关闭；若某个预设已显式写入 `blockedPlugins`，删除该键即回到关闭状态，不需要迁移脚本。
- 中断检查点：Wave 之间工作树保持可构建（typecheck / lint 通过）状态；未完成的 Wave 不得留下半改的监听器注册或半接线的参数键——新增 config 键必须与 `ALLOWED_KEYS`、`ENGINE_PARAM_DEFINITIONS`、参数桥镜像、UI 文案四处同进同退，任一处缺失都会被既有契约测试判红。

## 状态

本 PLAN 的方案期只产出方案（不落码、不改测试）；两个决策任务（T3、T7）已由用户拍板。三个 Wave 已于 2026-09-22 全部执行并收口，逐条进度见下方清单——**唯一未完成项是 T9 的 UI/参数目录入口**，按用户拍板延后（理由见该条）。

> **执行期交接注（2026-09-22 B7 交付后补记，新会话开工前必读）**
>
> 1. **基线已推进**：B7「引擎收敛」已完成并推送——代码 `3e64852`（七个内置能力模块改为声明式触发器后删除）、架构图 `29f42cf`。本 PLAN `:7` 记的基线 `dev / 84785df` 已过期；`:12` 的「不落码」约束只约束**方案产出期**，现已到可开工阶段，但仍**等用户逐 Wave 授权**（`:246`）。
> 2. **T1 的对象已变（先行勘察再动手）**：`:25-27` 表格里的三处否决型门控模块（`context-gate.mjs:174`、`tool-bootstrap.mjs:357`、`tool-filter.mjs:69`）**已随 B7 全部删除**，其行为改由预设顶层 `triggers` 声明承担（经 `engine/trigger-spec.mjs` 编译、`engine/actions.mjs` 注册）。B7 后 `system-prompt/assemble` 的引擎侧注册者只剩：`engine/layers.mjs:279`（协作式填充 runtime-context 占位，`:28` 判定**不应**抢外层）、`engine/run-code-env.mjs:208`（纯副作用，不需要）、以及 `engine/actions.mjs:408`/`:627`/`:649` 的三个动作（`assembly` / `sdk-strip` / `guard`）。
> 3. **② 可能已被 B7 部分解决，勿重复实现**：B7 的声明侧已引入 `waterfallPosition`（`test/engine/trigger.test.mjs:63` 用到 `'outermost'`）。开工前先勘察该字段是否已经把「否决型门控占据最外层」这一诉求表达出来；若已表达，T1 的剩余工作应从「改三个模块的注册」变为「核对声明侧位置语义 + 更正文档/注释」，`:249`（写入引擎文档与插入点契约）仍是有效任务。
> 4. **测试基建已变**：`:270` 引用的 `test/engine/tool-filter.test.mjs` **已删**（`test/engine/promotion-gate.test.mjs` 也已改写）；B7 留下的等价基建是 `test/engine/official-variable-regression.test.mjs`（真实 `Context` + 官方 `SystemPrompt` + `createScope`）、`test/engine/pre-step-wiring.test.mjs`（门控载体已换成 `mountDeclarations`）与 `test/engine/declarations/*.yml`（声明侧档案，含 `context-gate.yml`）。`:39` 的结论「`prepend` 的效果只能由真实 cordis 用例证明」依然成立。
> 5. **`:268` 的注释冲突证据已消失**：`engine/context-gate.mjs:68-71` 与 `engine/tool-bootstrap.mjs:455-460` 两个文件都已删除，该冲突不再可复现——写文档时改用「已删除模块的历史注释」这一表述，不要再指向不存在的行号。
> 6. **验收断言不变**（`:3` 的承诺）：真实 cordis 反例、区段归纳 + 下拉、精确等值匹配、来源黑名单的精确等值语义，四项均按原文执行。
> 7. **工程纪律（B7 教训）**：验收**必须先 `pnpm build` 再跑测试**——`lib/**` 是构建产物，未 build 时 `test/host` 的夹具用例会跑在旧 `lib/index.mjs` 上**假通过**（B7 实测：未 build 32 fail，build 后 87 fail）。

- [x] Wave 1 / T1：四处否决型装配声明改 `waterfallPosition: outermost`（映射 `prepend: true`）+ 更正行序注释 + 新增真实 cordis 反例 `test/engine/assemble-authority.test.mjs`（改前 3 红 → 改后 5/5 绿）。**注**：B7 收敛后已无「三处模块级门控注册」，落点改为**声明侧**（见上方「执行期交接注」第 2 条）。
- [x] Wave 1 / T2：`docs/engine-reuse.md` 新增「同 scope 内的注册顺序」一节；`docs/injection-point-contracts.md` 的 system-section / runtime-context 两行补同一约束（未写成「与顺序无关」，并写明 prepend 的上界）。
- [✔] Wave 2 / T3：**已拍板（2026-09-22）**——刻度取**区段归纳**（section 6 组 + context 1 组），交互取**可选下拉自动填值**；数字输入仍是唯一真相，下拉缺席于服务降级时。
- [x] Wave 2 / T4：`src/shared/official-orders.ts` 抄录 33 + 3 个档位名（**零数值**）+ `readOfficialOrderSegments` 纯函数；`loadEngineMeta()` 运行期求各区段边界并经 `/meta` 与 `/bootstrap` 同源下发，失败整表缺席 + 只告警一次。
- [x] Wave 2 / T5：两层渲染「插入到官方位置…」下拉（复用 `MenuSelect`），其余层显示说明且不展示档位数值；`officialOrders` 缺席时不渲染；下拉只走既有 `onPatch({ order })`。
- [x] Wave 2 / T6：`docs/injection-point-contracts.md` 新增「order 的作用面与刻度来源」一节；`docs/ui-architecture.md` 补分层呈现与退化行为。
- [✔] Wave 3 / T7：**已拍板（2026-09-22）**——`blockPlugins` 取**大小写不敏感的精确等值**匹配；子串写法（如只填 `mnemon` 去命中 `dsh-mnemon`）不生效，由文档显式说明补偿。
- [x] Wave 3 / T8：`pre-step-filter` 新增 `blockPlugins`（仅来源 kind 为 plugin 时按 `source.plugin` 精确等值剔除；空名单 = 关闭；与 `sources` / `keepKinds` 正交；`reject` 透传；异常保留全部消息）。
- [ ] Wave 3 / T9：**部分完成（用户 2026-09-22 拍板收缩范围）**——声明入口（`triggers[].do.blockPlugins`）已落地；**UI 与参数目录入口延后**。落点分析：实测 `engine/` 完全不出现 `layerSettings`（它由 `src/host/manifest.ts:6,630` 展平为内部 params），而声明动作只从声明读参（`actions.mjs:757-758`）⇒ 做成层参数需在 host→引擎之间新增「参数→声明/引擎」通道并同步层契约 schema，本会话余量不足。`src/shared/engine-params.ts` 与 `src/client/locales-params.ts` 本轮未改。
- [x] Wave 3 / T10：声明侧行为回归（`test/engine/blocked-plugins.test.mjs` 7 例，含方案 B 的分界断言）+ `docs/engine-reuse.md` 剥离语义段 + `docs/injection-point-contracts.md` 的 pre-step 行说明。
- [x] Wave 4 / T11：完整门禁、CHANGELOG、PLAN 归档与推送（本 PLAN 随收口提交入库）。

## 验收记录

**执行期验收（2026-09-22，三个 Wave 全部收口）**：

- **提交**：Wave 1 `d12c2f9`、Wave 2 `d519f30`、Wave 3 `7a3c74b`，均推送 `origin/dev`；本 PLAN 与 CHANGELOG 随收口提交入库。
- **门槛实测（build 在前**，避免 B7 那个 stale `lib/` 陷阱）：`typecheck` exit 0、`lint` 309 文件 96 规则 0 error、`build` 成功、`git diff --check` exit 0；三目录（engine + shared + host，**1200 例**）**0 失败 0 跳过**；四目录 1490 例 / 1458 通过 / **32 失败全在 `test/client`**——那是 B7 遗留、用户口径允许的红（`engine-module-cards` 等 9 层模块卡待重构），Wave 1/2/3 前后**红数完全相同**，本轮未新增任何客户端红。
- **定向回归**：`assemble-authority` 5/5（改前 3 红 → 改后全绿）、`official-orders` 3/3、`bridge-contract` 11/11、`prompt-config-form-layout` 25/25、`blocked-plugins` 7/7、`pre-step-wiring` 34/34、`pre-step-injection` 22/22、`test/host` 全量 652/652。
- **一条如实记录的偶发**：三目录**首次**全量时 `test/host/pre-step-injection.test.mjs` 的「T15/T16 文件卡按策略晋升门控」偶发 1 条失败；该文件单跑 22/22、`test/host` 全量 652/652、三目录重跑 1200/1200 均全绿。**未能证明它由本轮改动引入，也未能完全排除**（疑为并发时序敏感）⇒ 不掩盖，记录在此供后续观察。
- **范围收缩（用户 2026-09-22 拍板）**：T9 的 UI 与参数目录入口延后，落点分析见「状态」节第 9 条。
- **未跑**：`pnpm test`（用 `node --test` 逐目录代替，与 B7 批次 D 同一口径）；装配 smoke 未重跑（本轮不涉及模块清单与预设装配面）。

**方案产出期的查证证据（保留）**：本 PLAN 方案期未执行任何代码或测试改动，当时已核对的证据（可复核）：

- `node_modules/@deepseek-ai/cordis/src/events.ts:234-243`（waterfall 外层优先与最终返回值）、`:254-257`（`prepend` 即 `unshift`）、`:171-174`（`global` 绕过 scope 过滤）。
- `D:\AI\GitHub\deepseek-harness\docs\cordis-primer.zh.md:37`（官方对 `prepend` 的适用告诫）。
- `D:\AI\GitHub\deepseek-harness\packages` 全量检索 `system-prompt/assemble.*prepend`：0 命中。
- 本项目 6 处 assemble 监听器位置与语义（见审查结论表格），以及 5 处既有 `prepend` 先例。
- `engine/context-gate.mjs:68-71` 与 `engine/tool-bootstrap.mjs:455-460` 的注释冲突。
- `dsh-purge/lib/index.js:237` 的 `{ global: true, prepend: true }` 反例。
- 测试基建：mock `ctx.on` 不实现顺序（`promotion-gate.test.mjs:21-33`、`tool-filter.test.mjs:11-24`），真实顺序验证入口 `official-variable-regression.test.mjs:20-58`。
- ③ 的 order 事实：`engine/schema.mjs:437-440`（校验）、`:520-531`（加载期排序契约）、`engine/layers.mjs:159-178`/`:203-208`/`:238-242`/`:249-265`（唯一两处把 order 交给官方 API）、`engine/executor.mjs:256-257`、`engine/st-render.mjs:95-98`；UI 字段 `PromptConfigForm.tsx:178-180` + `PromptConfigFields.tsx:137-154`；文案 `locales-prompts.ts:159-160`/`:605-606`。
- ③ 的官方可用性：`node_modules/@deepseek-ai/dsh-system-prompt/package.json` = `0.1.6-alpha.2`；`lib/types/index.d.ts:246`/`:252` 有 `getSectionOrder`/`getContextOrder`；`lib/index.js:10-49` 的档位表与 master 源码逐值一致（`1e3` 等科学计数法）；`lib/index.js:365` 的 export 列表**不含**常量表；`package.json:67`/`:99` 的依赖声明版本一致。
- ③ 的桥与守卫：`src/runtime/settings-bridge.ts:572-590`（`loadEngineMeta`）、`:776-785`/`:793-800`（两个端点同源）、`:596`/`:603`（读官方服务的既有先例）；`src/shared/bridge-contract.ts:292-299`/`:308`；`test/shared/bridge-contract.test.mjs:155-205`；`src/client/data/prompt-tool-fields.ts:56-73` 的 `EMPTY_META`；`test/client/locale-contract.test.mjs:80-90` 的键集守卫；`test/client/support/ssr-render.mjs:45-96` 的页面测试 harness。
- ④ 的现有面：`engine/context-gate.mjs:7`（"not a per-source denylist" 立场）、`:94-97`（ALLOWED_KEYS）、`:103-127`（三个归一化 helper）、`:200-204`/`:216`/`:240`（三个只读 `source.kind` 的过滤点）、`:219-223`（失败降级纪律）、`:224`/`:255`（两处已带 `prepend`）。
- ④ 的官方来源形状：`D:\AI\GitHub\deepseek-harness\packages\llm\llm\src\message.ts:104`（`plugin: { kind: 'plugin'; plugin: string }`），以及在官方源码中核到的真实 `plugin` 取值清单（`agent-instructions`、`tools-ptc`、`compact`、`dsh-compaction-basic`、`plan-mode`、`repeat-tool-reminder`、`tool-jobs`、`model-selection`、`@deepseek-ai/dsh-system-prompt`、`hooks-codex`、`hooks-claude-code`、`tool-bash`、`cordis-host-runner`、`dsh-tool-skill`、`user-approval`）。
- ④ 的落地约束证据：`src/shared/engine-params.ts:239`/`:258-261`/`:301-340`；`src/client/features/modules/EngineParamFields.tsx:41`/`:123-128`；`src/client/locales-params.ts:48-51`/`:82`；`test/shared/engine-param-schema.test.mjs:36-48`/`:113-130`；`test/host/engine-params-bridge.test.mjs:204`/`:250-292`；`test/engine/promotion-gate.test.mjs:379-496`；`test/host/pre-step-wiring.test.mjs:226`/`:253`/`:388`/`:671`/`:694`；`test/host/write-preset.test.mjs:216-260`/`:677-729`；`test/client/engine-module-cards.test.mjs:151-167`。
- ④ 的参考实现：`dsh-purge/lib/identity.js:199-204`（`isMnemonPluginMessage`：`kind === 'plugin'` + plugin 名小写包含）、`dsh-purge/lib/index.js:207`/`:231`（过滤调用点与默认开关）。

## 实施取舍与已知边界

- 本轮**只出方案**：不落码、不跑测试、不改文档，避免把「审查发现」当成「修复授权」。
- ② 是加固而非修 bug：当前部署未观测到 `prepend` 注册的 assemble 监听器；一旦第三方插件（如 dsh-purge）以 `prepend` 注册，普通注册的门控即可被翻越。
- `prepend` 只提高优先级、**不提供绝对否决**：同为 `prepend` 时后注册者更外层，故第三方仍可能排到更外层。本轮的收益是把「是否被翻越」从**始终取决于注册顺序**收窄为**只在双方都 `prepend` 时才取决于注册顺序**——绝大多数插件使用默认的普通注册，改后即可稳定不被翻越。若将来需要绝对否决，才考虑在门控内不调用 `next()`（会丢弃内层全部贡献）——本轮明确不采用，且在 T1 的边界断言里如实记录该限制。
- mock ctx 不实现 `prepend` 顺序这一事实被保留：既有用例每个只挂一个引擎行并取 `listeners[0]`，加 `prepend` 对其零影响；顺序语义统一由真实 cordis 用例负责，不为此改造 mock（改造会改变既有 waterfall 串联用例的期望顺序，风险大于收益）。
- ③ 刻意**只给两层**显示官方刻度：`system-section` 与 `runtime-context` 是唯二把 order 交给官方 API 的层；对其余六层显示档位数值会让用户误以为那些层的 order 具有跨插件位置语义，属于制造错误认知，宁可不显示。
- ③ 的名字清单手抄不可避免（官方未导出 `SECTION_ORDERS`/`CONTEXT_ORDERS`），但**数值一律运行期经服务取值**；任何情况都不用手抄数值兜底——手抄数值正是官方改档位后悄悄失真的来源。同理，客户端不 import 官方常量（拿不到），刻度在 bridge 取值失败时**整体缺席**，不退化成静态表。
- ④ 是**新增能力而非修缺陷**，并且会改变 `engine/context-gate.mjs:7` 声明的「不是逐源黑名单」立场，该注释必须随实现改写；默认不启用、不预置任何第三方插件名，是否屏蔽完全由用户显式声明。
- ④ 不套用 `engine/anchor-match.mjs` 的正则/整词匹配：那套语义服务于消息**文本**匹配，而插件名是标识符，引入正则只增加学习成本与误配风险；匹配语义在 T7 二选一，不在实现里两者并存。

## 测试现场与清理限制

- 本轮未创建任何临时目录或文件；未启停 DSH，未改真实用户配置。
- 用户既有的未跟踪 `skills/` 与本轮无关，保持原样；`.ai-memory` 仅本地追加，不入库。
