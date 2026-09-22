# B1 既有 helper 收敛 PLAN（零行为变更）

总纲：`2026-09-22-plan-engine-convergence-master-84785df.md`。本支只做一件事：**把 `shared.mjs` 里已经写好、却没人用的 helper 用起来**。全部替换逐字等价，行为零变更。

## 需求与授权

- 日期：2026-09-22；基线：`dev / 84785df`；依赖 B0。
- 授权来源：总纲「按 8 支拆」拍板；全局纪律第 1 条（本支行为变更必须为零）。

## 审查结论

`engine/shared.mjs` 已提供三个 helper，但收敛只做了一半：

| helper | 定义 | 实际使用 | 手写重复 |
|---|---|---|---|
| `sessionMapGet(map, key, create)` | `shared.mjs:155-163`（get-or-create + `MAX_TRACKED_SESSIONS` 超限 `clear()`） | **全仓库零调用** | 8 处以上 |
| `createWarnOnce(ctx, pluginName)` | `shared.mjs:67-78` | context-gate:168、tool-filter:67、tool-bootstrap:315、executor:374 | `progress-reminder.mjs:56-65`、`fillers.mjs:54-63` 各手抄一份 |
| `newMessageId(prefix)` | `shared.mjs:81-85`（crypto.randomUUID 快路径） | executor:159、layers:252/346 | `anchor-turn.mjs:56-58`、`progress-reminder.mjs:110-112` 各内联一份 |

`sessionMapGet` 的等价手写（`clear()` 策略，与 helper 逐字等价）：

| 模块 | 位置 |
|---|---|
| compaction-epoch.mjs | `:117`、`:145` |
| deliberation-gate.mjs | `:53-61` 与 `:103-114`（**同文件两份同语义**） |
| progress-reminder.mjs | `:46-54` |
| tool-bootstrap.mjs | `:255-257` |
| layers.mjs | `:425-431` |
| strategies.mjs | `:100-108` |
| executor.mjs | `:90-99`（Set 形态，见下） |

**两处策略不同，不在本支范围**：`layers.mjs:493`、`layers.mjs:546` 用 `delete(最旧一条)` 而非 `clear()`；`executor.mjs:90-99` 的容器是 `Set`（`deliveredSessions`）且另有 `MAX_MEMO_CONFIGS` 上限。三者语义与 helper 不等价，留待 B4 统一时决定。

## 影响面、依赖与护栏

- 涉及文件：8 个引擎模块（替换点）+ 2 个手抄 warnOnce/id 的模块。
- 硬约束：**逐字等价替换**——替换后每个模块的行为（含超限清空时机、告警次数、id 生成回退分支）必须与替换前一致；不得顺手改上限值、不得顺手统一 `delete(最旧)` 两处。
- 不做：不引入新的 state 抽象（那是 B4）；不改 `MAX_TRACKED_SESSIONS` 的值。

## Wave 1：三个 helper 落地

```xml
<task type="auto">
  <name>T1：sessionMapGet 替换 4 处等价手写</name>
  <files>engine/deliberation-gate.mjs；engine/progress-reminder.mjs；engine/layers.mjs</files>
  <action>**只替换真正的 get-or-create**（R2 修正了原清单，三处被剔除）：把 `deliberation-gate.mjs:53-61` 与 `:103-114`、`progress-reminder.mjs:46-54`、`layers.mjs:425-431` 的 get-or-create + 超限 clear 换成 `sessionMapGet(map, key, create)`；deliberation-gate 的两处保持两个调用点（对象工厂不同）。

**明确剔除以下三处（原清单把非等价写入当成了等价替换）**：

- `engine/compaction-epoch.mjs` —— 成功压缩时**必须覆盖已有键**，而 `sessionMapGet` 只在键缺失时创建；直接替换会留下旧 epoch（`:140-146`）；
- `engine/tool-bootstrap.mjs:255-269` —— 那里的容量检查服务于**已有阶段的推进**，不是单纯的 get-or-create；
- `engine/strategies.mjs:100-108` —— 尚无首个 assistant 消息时**不缓存 false**，属条件缓存。

`executor.mjs:90-99` 的 Set 形态与 `layers.mjs:493/546` 的 `delete(最旧)` 形态同样**不动**。</action>
  <verify>替换前后对拍：同一组 (map, key) 输入下返回值、map 内容、清空时机三者一致。**另加 R2 要求的三条序列断言**（证明三处剔除确实必要）：(a) 成功压缩后 epoch 状态被覆盖为新值；(b) 已有键的更新路径仍走覆盖写入；(c) 首个 assistant 消息延迟到达时不缓存错误值。确认 `MAX_TRACKED_SESSIONS` 的 import 在不再直接使用的模块中被移除。全量测试绿。</verify>
  <security>只改进程内状态管理，不接触写盘、权限与网络；不得改变上限值或清空策略，避免「会话态丢失时机」静默变化。</security>
  <done>4 处手写替换为共享 helper，行为逐字等价（其余形态按 R2 剔除，见 action）。</done>
</task>
```

```xml
<task type="auto">
  <name>T2：createWarnOnce 与 newMessageId 替换手抄实现</name>
  <files>engine/progress-reminder.mjs；engine/fillers.mjs；engine/anchor-turn.mjs</files>
  <action>progress-reminder.mjs:56-65 与 fillers.mjs:54-63 的手抄 warnOnce 替换为 createWarnOnce(ctx, name)；anchor-turn.mjs:56-58 与 progress-reminder.mjs:110-112 的内联 crypto.randomUUID 回退替换为 newMessageId(prefix)。fillers.mjs 若不持有 ctx，需按其调用形态决定是接收 ctx 还是保留本地实现——**若无法在不改签名的前提下替换，则保留并在注释中说明原因**，不为替换而扩大改动面。</action>
  <verify>告警一次性语义对拍（同一模块连续两次告警只出一次，且 ctx.logger 缺失时不抛）；id 生成的两种分支（有/无 crypto.randomUUID）行为一致；全量测试绿。</verify>
  <security>warnOnce 的降级纪律不变（logger 不可用时不抛）；随机 id 只用于消息标识，不参与安全判定。</security>
  <done>两个 helper 的手抄实现在可行处替换完毕，不可行处有明确注释。</done>
</task>
```

## 回滚与检查点

`git revert` 本支提交。中断检查点：替换必须按模块成对完成（同一模块的 import 与调用点同进同退），不留半迁移文件。

## 状态

- [x] T1 sessionMapGet 4 处替换（其余形态按 R2 剔除）。
- [x] T2 warnOnce / newMessageId 手抄替换（`fillers.mjs` 按 PLAN 边界保留并注明原因）。

## 验收记录

执行日期 2026-09-22；分支 `dev`，起点 `5e03ac8`（B0 已提交推送）。本支**零行为变更**；全部改动集中在 5 个 `engine/*.mjs` 文件（净 -30 行）与 1 个新增用例文件。

**T1：`sessionMapGet` 替换 4 处**（R2 修正后的清单，原「8 处」的旧数字已在执行前统一）
- `engine/deliberation-gate.mjs`：两处（`entryOf` 与 `depthOf` 的冷扫路径）→ `sessionMapGet(state, id, () => ({ turns: new Map(), lastTurn: -1 }))`；`MAX_TRACKED_SESSIONS` 的 import 随之移除，文件内 grep 零残留；模块 import 自检通过。
- `engine/progress-reminder.mjs`：`countersOf` → `sessionMapGet(state, id, () => ({ results: 0, drips: 0, lastTurn: undefined }))`。
- `engine/layers.mjs`：`stateOf` → `sessionMapGet`；**保留** `MAX_TRACKED_SESSIONS` 的 import —— 经 grep 确认 `:489` 与 `:542` 的 `delete(最旧)` 形态仍在使用（PLAN 明令不动），故不是死引用。
- 按 PLAN 未动：`compaction-epoch.mjs`（成功压缩须覆盖已有键）、`tool-bootstrap.mjs:255-269`（容量服务于阶段推进）、`strategies.mjs:100-108`（条件缓存）、`executor.mjs:90-99` 的 Set 形态、`layers.mjs:493/546` 的 `delete(最旧)`。

**T2：`createWarnOnce` / `newMessageId` 替换**
- `engine/progress-reminder.mjs`：手抄 `warnOnce`（8 行）→ `createWarnOnce(ctx, name)`；内联 uuid 回退 → `newMessageId('progress-reminder')`。
- `engine/anchor-turn.mjs`：内联 uuid 回退 → `newMessageId('anchor-turn')`（前缀与原实现逐字一致）。
- `engine/fillers.mjs`：**按 PLAN 边界保留本地实现**并加注释说明原因 —— 该工厂只拿得到 `config`，`ctx` 要到每次 resolve 调用时才由参数传入；换成 `createWarnOnce(ctx, name)` 必须改工厂签名，而唯一调用点 `engine/strategies.mjs` 的 `createPlaceholderResolver(config)` 不在本支写区。为替换而扩大改动面违反 PLAN，故不动。

**新增验收用例** `test/engine/helper-convergence.test.mjs`（4 条，全绿）：
1. `sessionMapGet` 与替换前手写形态对拍 —— 把三段被替换的手写逻辑逐字复制成 `legacySessionMapGet`，与 helper 跑**同一脚本**，对拍返回值身份、`create` 次数、map 规模与清空时机；覆盖「命中 / 未超限 miss / 满员命中（绝不清空）/ 超限 miss（清空重建）」四个边界，显式断言 `MAX_TRACKED_SESSIONS === 4096` 未被顺手改，并覆盖「值为 `undefined` 视同缺失」这一 helper 判定语义。
2. **序列断言 (a)** `compaction-epoch` 成功压缩后 epoch 被覆盖为新值 —— 反事实（`onlyCreateKeepsStale` 证明只建不改会拿到旧 entry 且新值未进 map）+ 真实路径（`createEpochPromotion` 的 `boundary: -1→5`、`promoted: true→false`、`after !== before`）。
3. **序列断言 (b)** `tool-bootstrap` 已有键的更新路径仍走覆盖写入 —— 真实 `apply` + 桩 ctx，两次推进断言 `stage=2:开发` → `stage=3:验证`（阶段不冻结在首次写入值）。
4. **序列断言 (c)** `strategies` 首个 assistant 消息延迟到达不缓存 `false` —— 无消息返回 `null`，消息到达后注入生效，且第二次判定仍为已确认。

**门禁（全部通过）**：`lint` 0 warnings / 0 errors（282 files）；`typecheck` exit 0；全量 `test` **1323 tests / 1323 pass / 0 fail**（B0 后为 1319，本支新增 4 条）；`build` 由 `scripts/run-tests.mjs` 内含执行且成功；`git diff --check` exit 0。

**未验证项**：①本支改动集中在 `engine/*.mjs`，而 `lint` 的检查范围是 `src test tsdown.config.ts`（**不含 engine/**），这 5 个文件的静态质量由全量测试与人工 diff 复核保证，**未经 linter 检查**。②`fillers.mjs` 的本地 warnOnce 未替换，一次性语义因此存在**第二份实现**；待该工厂签名可调整时（或 B4 统一会话态时）再收敛。

**交付凭据**：提交 SHA 与推送结果在归档后补记（随下一支的提交带入，避免为一个哈希多占一次提交）。

## 实施取舍与已知边界

- `layers.mjs:493/546` 的 `delete(最旧)` 与 `executor.mjs:90-99` 的 Set+双上限**保留原样**：它们与 `sessionMapGet` 语义不同，强行为统一会造成行为变更，留待 B4 一并决策。
- 不为替换而扩大改动面：`fillers.mjs` 若拿不到 ctx，保留本地实现并注明。

## 测试现场与清理限制

本支未创建临时目录；执行时测试 cwd 固定 `D:\AI\workspase\_temp`，独立 `DSH_HOME`，结束清理。
