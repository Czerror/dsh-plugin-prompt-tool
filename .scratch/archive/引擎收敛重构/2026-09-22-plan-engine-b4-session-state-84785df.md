# B4 会话态与生命周期统一 PLAN

总纲：`2026-09-22-plan-engine-convergence-master-84785df.md`。本支收敛「每个模块自己维护会话态 Map、自己决定上限与清空策略、自己决定复位时机」。

## 需求与授权

- 日期：2026-09-22；基线：`dev / 84785df`；**单向**依赖 B3（能力运行时已就位，且最小会话态接口由 B3 定义；R7——本支不再被 B3 反向等待）。
- 全局纪律第 1 条：**行为变更必须为零**；本支的风险点（纯计数状态不可重建）须逐条论证后才动。

## 审查结论

### 1. 会话态的两种键类型与两种淘汰策略

| 键类型 | 模块 | 上限行为 |
|---|---|---|
| `Map<session.id>` | compaction-epoch:71、deliberation-gate:50、executor:364、layers:423/486、progress-reminder:44、tool-bootstrap:243、strategies:96 | `clear()` 全清（B1 已收敛为 `sessionMapGet`） |
| `Map<session.id>`（Set 形态） | executor:90-99（`deliveredSessions`） | `clear()` + 另一套 `MAX_MEMO_CONFIGS=4096` |
| `Map<session.id>` | layers:493、layers:546 | **`delete(最旧一条)`**（与上两者不同） |
| `WeakMap<session 对象>` | context-gate:154、layers:23、promoted-code-mode:43/44、st-world-book:24/27、st-render:53/54 | 无上限逻辑（随对象回收） |
| `WeakMap<config.params 对象>` | st-world-book:25 | 同上 |
| `WeakMap<agent 对象>` | subagent-tool-policy:236 | 同上 |
| `WeakMap<tool 对象>` | run-code-env:36 | 同上 |

### 2. 复位时机不统一

- `compaction/end` 复位**只有 1 处**：context-gate:164-166 的 `deferredBySession.delete(session)`。
- 另有 2 个模块**各自注册第二个 `session/event` 监听**做复位：promoted-code-mode:74-82、以及 tool-bootstrap（注释明确「compaction 不重置」，见其 :29-31）。
- `agent/disposed` 清理只有 1 处：subagent-tool-policy:256。
- dispose 时清理只有 2 处：executor:394-398、layers:496。
- **其余全部只靠超限清空**：compaction-epoch、deliberation-gate、progress-reminder、tool-bootstrap、layers:23/541 两个 WeakMap、promoted-code-mode（release 只重置字段不 delete）。

### 3. 关键风险：并非所有会话态都能从事件流重建

- `compaction-epoch` 的 entry **可冷扫重建**（有 `scan()`，`:113-120`）——换键类型安全。
- `progress-reminder` 的计数（`results`/`drips`/`lastTurn`）是**纯增量**，无法从事件流重建；改 WeakMap 后「何时丢状态」从「第 4097 个会话」变为「session 对象被 GC」，后者更精确但仍需断言「丢失后行为可接受」。
- `layers.mjs:493/546` 的 `delete(最旧)` 与 `sessionMapGet` 的 `clear()` **不等价**，不能简单替换。
- `executor.mjs:90-99` 是 `Map<identity, Set<session.id>>` 的二维索引（`deliveredSessions(memo, key)`），语义上不适合 WeakMap。

### 4. 扩容：承载触发器引擎的「计数 / 会话状态」判断（2026-09-22 评审后）

用户拍板把引擎收敛为「判断 + 执行」后，B3 的判断原语里有两类需要**有界、可冷扫重建**的会话态。**该容器的最小接口（键类型 + 两类形态 + `rebuildable` 标注）已由 B3 定义在 `engine/shared.mjs`**（R7），本支只负责把下表模块迁移到该接口：

| 原语 | 现状实现（每模块自写） | 迁移后的形态（接口由 B3 定义，本支落实） |
|---|---|---|
| **计数 / 阈值** | `deliberation-gate.mjs:49-76`（turns Map + 每轮修剪 `MAX_TRACKED_TURNS=8`）、`progress-reminder.mjs:44-54`（results/drips/lastTurn） | 「按轮次分桶 + 上限修剪」与「纯计数」两种形态 |
| **会话状态** | `anchor-turn.mjs:35-38` 直接扫 `sessionEvents` 判「无 user/message」 | 「事件流谓词首次求值 + 之后增量维护」的缓存形态 |

因此 T1 从「统一键类型」扩展为「**按 B3 已定义的最小接口迁移**，并落实两类可复用的会话态形态」，供 B3 的判断原语消费、B7 的等价声明使用。硬约束不变：**行为变更必须为零**；纯计数状态不可重建这一点必须在声明里显式标注（如 `rebuildable: false`），供消费方判断是否可安全冷扫。

**落位修正（B3 收口时查证，覆盖上文两处「定义在 `engine/shared.mjs`」的字面措辞）**：B3 的 T3 已把该最小接口定义在 `engine/trigger.mjs` 的 `state` 契约小节（*读取 → 既有实现 → 最小形状* 五条表：`session.id` / `sessionEvents()` / 内联 `event.data.turn` / `isDelegated()` / `MAX_TRACKED_SESSIONS` + `sessionMapGet`），并有可运行断言钉住（`test/engine/trigger.test.mjs` 的「会话态最小接口」用例，逐条断言语义与既有字面量写法等价）。

计划里的 `session(create, { resetOn })` **不放 `shared.mjs`**：`resetOn` 是复位时机，落地就要在挂载期注册 `session/event` 监听，而 `shared.mjs` 是**没有 `ctx` 的纯函数模块**（现有导出全是无状态工具，`keepDisposer` 也要调用方传 `ctx`）。本支 T1 的统一访问接口因此须满足：**(a)** 接收挂载期 `ctx`，或由运行时（`mountTriggers` / capability 运行时）一侧构造；**(b)** 建在上述五条既有读法之上，不新造事件类型或持久通道；**(c)** 逐模块保留原有键类型与淘汰策略；**(d)** `resetOn` 按**状态字段**声明而非按模块——`tool-bootstrap` 的 `stage`（不订阅复位）与 `promotion`（订阅复位）策略相反，是本条现成的反例。

## 影响面、依赖与护栏

- 涉及：全部持有会话态的模块 + `engine/shared.mjs`（state 声明入口）。
- 硬约束：
  - 键类型统一**只对「按会话索引」的 state 生效**；二维索引（executor 的去重 memo）保持 `Map` + 双上限。
  - 淘汰策略统一前必须逐条确认等价性；`delete(最旧)` 两处若无法证明等价，**保留并注释**。
  - 状态丢失后的行为必须逐模块断言（尤其是纯计数模块）。
- 前置事实：`WeakMap<session 对象>` 在本项目已有先例且有测试（`context-gate.mjs:154` + `test/engine/preset-engine-modules.test.mjs`），说明宿主在同一会话内传的是同一 session 对象。

## Wave 1：state 声明

```xml
<task type="auto">
  <name>T1：shared.mjs 增加 session() 状态声明并统一键类型</name>
  <files>engine/shared.mjs；engine/{compaction-epoch,deliberation-gate,progress-reminder,tool-bootstrap,layers,strategies}.mjs</files>
  <action>**分两步，第一步不改任何策略**（R8 修正了原方案把 WeakMap 替换当成零行为重构的判断）：

**步骤一（本支必做，零行为变更）**：提供 `session(create, { resetOn })` 声明作为**统一访问接口**，但内部**保留各状态原有的键类型**（`Map<session.id>` 或 `WeakMap<session 对象>`）、**淘汰策略**（`clear()` / `delete(最旧)` / 无上限）与**复位语义**。逐个模块只把访问方式换成该接口，并逐条对拍读写结果与被清空的时机。

**步骤二（单列为行为变更，本支不承诺等价）**：若确实要把 `Map<session.id>` 改成 `WeakMap<session 对象>`，必须作为**独立的行为变更**登记——`progress-reminder` 的计数不可冷扫重建，原 Map 在第 4096 个会话时会**清空其它仍存活会话的预算**，而 WeakMap 不会；保持所有 session 对象存活即可**确定性观察到提醒次数差异**；`session.id` 与对象身份也不是同一契约。该变更需覆盖四种情形：存活会话超限、同 id 不同对象、重挂、恢复。

`executor` 的二维 memo 与 `layers:493/546` 的 `delete(最旧)` 保持不动，在原地注释说明为何不统一。</action>
  <verify>步骤一：只断言「访问接口替换后读写结果与清空时机不变」，**不得用「差异可接受」的措辞冒充等价**。步骤二（若做）：断言四种情形下的行为差异被显式记录为变更，且**不以现有 WeakMap 用例推断「宿主对象永不重建」**——那只是既有用例的覆盖范围，不是宿主的契约。</verify>
  <security>会话态是「进程内快路径，真相在 durable 事件流」（shared.mjs:150-152 既有注释）：迁移不得让任何判定从 durable 事实退化为进程内状态；不得改变任何门控/过滤的结果。</security>
  <done>步骤一完成：所有会话态走统一访问接口，且**键类型 / 淘汰策略 / 复位语义逐条保持不变**；二维索引与 `delete(最旧)` 有明确保留理由；凡涉及键类型或淘汰策略的变更已**单列为行为变更**，未混入本支。</done>
</task>
```

## Wave 2：复位与生命周期

```xml
<task type="auto">
  <name>T2：统一 compaction/end 复位点</name>
  <files>engine/compaction-epoch.mjs；engine/promoted-code-mode.mjs；engine/context-gate.mjs；engine/tool-bootstrap.mjs</files>
  <action>把「调用方各自注册第二个 `session/event` 监听做复位」收敛为 compaction-epoch 提供的 reset 钩子，且**复位策略按状态字段声明、不能按旧模块名或整个模块决定**（R3 修正）：`promoted-code-mode:74-82` 与 `context-gate:164-166` 的复位改为经该钩子；**`tool-bootstrap` 不得整体声明为「不订阅复位」**——它的**阶段状态**（`:243-299`）确实不因压缩重置，但它的 **promotion 状态**（`:299-306`）仍观察会话事件、并在成功压缩后创建新 epoch（`:406-419` 据此恢复 compaction 工具窗口）。因此该模块必须拆成**两个字段级声明**：`stage` 不订阅复位、`promotion` 订阅复位。</action>
  <verify>三条序列分别验证（R3）：(a) 压缩后**阶段保留**——阶段推进状态不被复位；(b) 压缩后**晋升复位**——新 epoch 生效、compaction 工具窗口按既有逻辑恢复；(c) **失败压缩不复位**——两者都不变。另断言复位策略**由字段声明驱动**：只翻转某一个字段的 `resetOn`，只有该字段的行为变化。</verify>
  <security>复位语义影响晋升相位与门控：失败的 compaction 不得推进 epoch、不得复位状态（既有纪律）；迁移不得让任何模块在失败压缩时被误复位。</security>
  <done>复位点集中在 epoch 模块，刻意不复位的模块有显式声明。</done>
</task>
```

```xml
<task type="auto">
  <name>T3：disposer 覆盖补齐决策与实施</name>
  <files>engine/{context-gate,deliberation-gate,progress-reminder,promoted-code-mode,tool-bootstrap,tool-filter,anchor-turn,skill-search,tool-git-bash,run-code-env,st-world-book}.mjs</files>
  <action>B3 已让 capability 运行时接管注册入口。本任务决定并实施：对持有进程内状态的 11 个模块，是否在 dispose 时清理其状态。判据：若模块被宿主重挂（HMR/预设切换）时旧状态会造成**可观察的错误行为**，则补清理；否则保留现状并注明「随进程存活是有意」。每一条决定都要写明判据与验证方式。</action>
  <verify>对决定补清理的模块，断言 dispose 后状态确实释放（重挂后行为等同全新挂载）；对不补的模块，断言重挂后行为与现状一致。不得因为「统一」而给全部模块加清理。</verify>
  <security>dispose 清理不得误删其它实例的状态；不得在清理中执行 IO；不得影响 durable 事实（清理只针对进程内快路径）。</security>
  <done>每个持有状态的模块都有明确的清理决定与验证。</done>
</task>
```

## 回滚与检查点

`git revert` 本支提交，按 Wave 回退。T1 若在某个模块上发现状态丢失导致行为变化，可单独回退该模块的迁移（其余模块保留）。

## 状态

- [x] T1 session() 状态声明与键类型统一 —— **步骤一完成**（`shared.mjs` 的 `sessionState()` + 6 个模块迁移）；**步骤二不做**（见「实施取舍」：它是行为变更，本支不承诺等价）。
- [x] T2 compaction/end 复位点统一 —— **结论为「不需改代码」**（见下），验收序列由既有用例 + 新增 `compaction-reset.test.mjs` 覆盖。
- [x] T3 disposer 覆盖决策与实施 —— 决策表见 `## T3 disposer 覆盖决策表（执行期产出）`；11 个模块全部记「保留现状」，每条写明判据。

## 验收记录

本轮为方案产出，未执行。查证证据：全部会话态容器清单（`new Map()` / `new WeakMap()` 逐处行号）、两种淘汰策略的分布、`compaction/end` 仅 1 处复位的实证、`agent/disposed` 与 dispose 清理的各自唯一处、`executor.mjs:90-99` 的 Set + 双上限。

### 执行结果（2026-09-22 执行）

**门槛（主线程统一跑，cwd `D:\AI\workspase\_temp`）**：`pnpm typecheck` ✓ / `pnpm lint` **0 errors**（2 warnings 在 `test/engine/actions.test.mjs`，属 B3 遗留）/ `pnpm test` **1445 pass / 0 fail**（B3 时为 1433，本支新增 12 例）/ `pnpm build` ✓ / `git diff --check` **CLEAN**。

**T1 步骤一**（零行为变更）：

| 交付 | 内容 |
|---|---|
| `shared.mjs` | 新增 `sessionState(ctx, create, { weak, limit, evict, reset })`，把三处现状差异（键类型 / 淘汰策略 / 复位语义）收进一套读写入口；`evict:'clear'` 逐字复用 `sessionMapGet` 的语义，**`reset` 缺省完全不订阅**（零开销） |
| `test/engine/session-state.test.mjs` | **8 例**：`get/peek/set/delete` 与既有写法逐例一致、第 `MAX_TRACKED_SESSIONS` 个会话触发全清（`>=` 而非 `>`）、`oldest` 与 `clear` 两档不互通、缺省不订阅 / 声明后只删 `reset` 返回 true 的会话、弱键档不暴露 `size/keys`、无 id 不记账（id 档与 weak 档语义差异） |
| 迁入模块（6 个） | `deliberation-gate`（键 id / 超限 clear / 不复位）、`progress-reminder`（同档；计数不可重建，注释已标明）、`strategies`（同档；缓存值为布尔，用 `peek` 区分 `false` 与未命中，且保持「未找到首条 assistant/message 时不写缓存」的既有行为）、`compaction-epoch`（同档；**不传 ctx**，因为它不声明复位）、`tool-bootstrap`（同档；读只用 `peek`——`get` 会在无条目时写入 0，让 `currentStage` 跳过冷扫，与 `sessionMapGet(state, id, …)` 的读法不等价）、`layers` 的 `createTurnStopBudget`（同档；**对外签名与 `entry/available/claim` 三个方法逐字不变**，用 `{ id: sessionId }` 造最小键宿主） |

**T1 保留原状并注明理由**：`executor.mjs` 的二维索引（`Map<identity, Set<sessionId>>`，不是「按会话索引」）、`layers.mjs` 的 `subagentEndDeliveries`（外层按会话、**内层按 `${runId}:${config.id}` 去重**，是第二层索引）与 `runs`（键是 `runId`，不是会话态）——三处均在原地写明「为何不统一」。

**T2 的执行期结论（与 PLAN 假设不同，据此收敛为「不改代码」）**：

1. **epoch 的复位早已在内部完成**：`compaction-epoch.mjs:96` `if (isSuccessfulCompactionEnd(event)) return freshEntry(seq)` —— 成功压缩即丢旧 entry、推进 boundary，调用方从来不需要为 epoch 注册复位监听。
2. **两处调用方复位各自复位「自己的私有状态」**，不是 epoch 状态：`promoted-code-mode` 释放已应用的 `tools.presentAs('ptc')` 呈现锁；`context-gate` 丢弃 `deferredBySession` 的延迟步计数。把二者收敛成一个中心 reset 钩子，要么在各自模块里造空转钩子，要么漏掉真正需要复位的状态——**归一只会删掉正确行为**。
3. **三条验收序列在既有用例已有覆盖**：`promotion-gate.test.mjs:123`（成功压缩复位门控、边界前事件不重新晋升）、`:140`（失败压缩不开启新 epoch）、`:550`（stages 的「compaction 不重置」）、`:317`（呈现锁失败保留 / 成功释放）。
4. 本支**补齐它们没覆盖的那半**：新增 `test/engine/compaction-reset.test.mjs`（**4 例**）钉住「复位对象是调用方私有状态」这一事实与「策略必须声明在字段上」（同一个 `tool-bootstrap` 里 `stage` 不订阅、`promotion` 订阅，按模块的开关表达不了）。

因此 PLAN 的「把复位收敛为 compaction-epoch 提供的 reset 钩子」**不实施**；`sessionState` 的 `reset` 参数保留为**机制**（`test/engine/session-state.test.mjs` 有 8 例覆盖其语义），当前**无调用点**——这是「机制先行、策略按需」的有意结果，不是遗漏。

## 实施取舍与已知边界

- **二维索引不统一**：`executor` 的去重 memo 是 `Map<identity, Set<sessionId>>`，不是「按会话索引」，强行套 `session()` 会改变语义。
- **`delete(最旧)` 保留待证**：两处与 `clear()` 不等价；无等价证明前保留原状。
- **进度计数不可重建**（R8 修正了原表述）：`progress-reminder` 的计数无法从事件流重建，原 `Map` 的清空会**误伤其它仍存活会话**的预算，WeakMap 不会——这是**行为差异**，不是「更精确」。要做就单列为行为变更，并覆盖存活会话超限、同 id 不同对象、重挂与恢复四种情形；本支的步骤一不改动它。
- **不新增状态持久化**：本支只统一内存态，不引入任何落盘。
- **T1 步骤二不做，并明确登记为行为变更**：把 `Map<session.id>` 换成 `WeakMap<session 对象>` 会改变**状态丢失的时机**——原 `Map` 在第 `MAX_TRACKED_SESSIONS` 个会话时会**清空其它仍存活会话的预算**，WeakMap 不会。这不是「更精确」，是**行为差异**（`progress-reminder` 的计数不可重建，所以「保持所有 session 对象存活」即可**确定性观察到提醒次数差异**）；`session.id` 与对象身份也不是同一契约。本支**不实施**，若将来要做，须单列一支并覆盖四种情形：存活会话超限、同 id 不同对象、重挂、恢复。
- **`sessionState` 的 `reset` 参数当前无调用点**：T2 的执行期结论是「两处调用方复位各自复位私有状态、不可归一」（见验收记录），所以本支只把 `reset` 作为**机制**落地（8 例断言覆盖其语义），不强行找调用者。机制先行、策略按需——将来若有真正「按字段复位且删除条目」的状态，直接用即可。
- **`session()` 的实际落位**：PLAN 原文要求 `session(create, { resetOn })` 定义在 `engine/shared.mjs`；执行期确认**不能**那样——`resetOn` 要落地就得在挂载期注册 `session/event` 监听，而 `shared.mjs` 是没有 `ctx` 的纯函数模块。最终签名是 `sessionState(ctx, create, {...})`，且**只在声明了 `reset` 时才读 `ctx`**（其余档传 `undefined` 合法且零开销），评审此条时以本行为准。

## 测试现场与清理限制

本支未创建临时目录；执行时测试 cwd 固定 `D:\AI\workspase\_temp`，独立 `DSH_HOME`，结束清理。

## T3 disposer 覆盖决策表（执行期产出）

**前置查证（全仓证据）**：`test/engine/*.mjs` 与 `test/host/*.mjs` 中，本任务点名的 11 个模块**没有任何一处** dispose / 重挂断言（只有 `tool-filter`、`anchor-turn`、`deliberation-gate`、`progress-reminder` 等在其它主题的用例里被间接装配）。所以「补清理」与「判定无需清理」都必须**新写断言**，不能靠既有用例反推。

判据（PLAN 原文）：模块被宿主重挂（HMR / 预设切换）时，旧状态是否会造成**可观察的错误行为**。

| 模块 | 进程内状态 | 丢状态后可重建 | 重挂时旧状态的实际影响 | 决定 |
|---|---|---|---|---|
| `tool-filter` | 无 | — | — | **无需处理** |
| `anchor-turn` | 无（每次读 durable） | — | — | **无需处理** |
| `tool-git-bash` | 无 | — | — | **无需处理** |
| `deliberation-gate` | `Map<session.id>`（轮深度/门计数） | 可冷扫重建 | 旧实例与新实例各自持 Map，互不影响；丢弃后行为**等同全新挂载** | **保留现状**（随进程存活是有意：能冷扫，无需清理） |
| `progress-reminder` | `Map<session.id>`（纯增量计数） | **不可重建** | 丢弃后计数重置 = 提醒节拍从头算；符合「等同全新挂载」定义，不违反任何硬约束（提醒是建议性注入） | **保留现状并注明**：本计数不可重建，故「清理」与「不清理」都只影响提醒次数；不给它加清理（B4 步骤一不改策略） |
| `compaction-epoch` | `Map<session.id>`（epoch entry） | 可冷扫重建（`scan()`） | 同上 | **保留现状** |
| `tool-bootstrap` | `Map<session.id>`（阶段） | 可冷扫重建（`scanStage()`） | 同上 | **保留现状** |
| `promoted-code-mode` | 2 × `WeakMap<session>` | 展示态可重算 | WeakMap 随 session 回收；重挂时新实例空容器 | **保留现状** |
| `skill-search` | 无会话态 | — | — | **无需处理** |
| `run-code-env` | `WeakMap` | 纯缓存 | 同上 | **保留现状** |
| `st-world-book` | 3 × `WeakMap` | 纯缓存 | 同上 | **保留现状** |
| `layers.mjs`（turn-stop 预算） | `Map<session.id>`（`createTurnStopBudget`） | 不重建 | 若同一个长生命周期 ctx 上被**重复挂载**，旧实例与新实例各持一份预算 → 每会话 3 次上限被**翻倍**。这是本表**唯一**具硬约束含义（强制续跑失控）的状态，也是唯一「补清理有价值」的候选 | **不在本支补**（见下） |

## 迁移的行为差异登记（两个子代理各自独立探针复现，方向一致）

**唯一差异：无 `session.id` 的会话**。旧实现把条目存在**共享的 `undefined` 键**上，新实现按 `sessionState` 的既有决定「无 id 不记账」，于是每次回到 durable 事件流。两个并行子代理用各自的对拍探针独立复现，结论相同：

| 路径 | 旧行为 | 迁移后 | 说明 |
|---|---|---|---|
| turn-stop 预算（`layers.mjs:493`） | 连续 4 次判定 `[true,false,false,false]`（共享槽记账，预算被消耗） | `[true,true,true,true]`（不记账 → 每次新条目） | 差异**不可达**：两个调用点（`actions.mjs:316`、`layers.mjs:527`）都在 `entry()` 之前守卫 `session?.id === undefined → return` |
| `tool-bootstrap` 阶段（`:296`） | 共享槽；监听器在 `session === undefined` 时读 `session.id` **抛 TypeError** | 静默 no-op（无 id 走冷扫） | 差异**可达但方向正确**：`currentStage` 的守卫只有 `session === undefined`（`:295`），不覆盖「有 session 但无 id」——旧实现此时会把别的无 id 会话的阶段串给本会话，新实现回到本会话的 durable 事件流 |
| `compaction-epoch`（`:95`） | 共享槽钉住非 durable 状态（探针：`boundary=5/promoted=false`） | 回到事件流真实状态（`boundary=-1/promoted=true`） | 同上，方向正确 |
| `strategies` 缓存（`:110`） | 第二个无 id 会话读到第一个的缓存 | 各自按自己的事件流判定 | 同上，方向正确 |

**结论**：全部差异集中在无 id 路径，且**方向统一为「回到 durable 事实」**——这正是 `predicates.mjs:343` 与 `sessionState` JSDoc 刻意声明的那一档（无 id 不记账，避免共用 Map 键让两个会话串味）。因此**不为此加 sentinel 键**：那会绕开接口的刻意决定、并把「进程内共享槽」这一非 durable 真相重新引回来。若要位级一致，改动是一行 sentinel 键，但方向是错的。

**未验证**：「宿主永不对空 id 的 session 发 `session/event`」这一点没有从宿主源码证实（子代理明确标注）——不过即便宿主会发，迁移后的行为也是**按该会话自己的事件流判定**，比跨会话共享槽更正确。

**为何 `layers` 的预算也不补清理**：`applyPromptConfigs` 的注册**本身就已挂在宿主 fiber 上**（`ctx.on` 直接注册、`keepDisposer` 显式接管），因此宿主释放 fiber 时监听器与状态一并随实例不可达，不存在「旧状态污染新实例」的路径——真正能触发翻倍的场景是「同一个长生命周期 ctx 上重复调用挂载」，那本身就不在宿主的行为契约内。按 PLAN 的判据（「不得因为『统一』而给全部模块加清理」），**本支给 11 个模块全部记「保留现状」，且每条都写明判据**；若将来确认宿主会复用长生命周期 ctx 重挂，再单独为 `createTurnStopBudget` 补 `clear()`（`sessionState` 已提供该方法，改动是一行）。
