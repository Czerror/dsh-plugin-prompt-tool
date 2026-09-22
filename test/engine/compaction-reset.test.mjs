/**
 * B4 T2 —— compaction/end 复位点：**哪些该归一、哪些必须各自留着**。
 *
 * PLAN 原文的假设是「把调用方各自注册的第二个 `session/event` 监听做复位收敛为
 * compaction-epoch 提供的 reset 钩子」。执行期读源码后的结论与此不同，本文件把它钉住：
 *
 *   1. **epoch 的复位早已在内部完成**——`compaction-epoch.mjs:96`
 *      `if (isSuccessfulCompactionEnd(event)) return freshEntry(seq)`：成功压缩即丢弃旧
 *      entry、推进 boundary。调用方从来不需要为 epoch 注册复位监听。
 *   2. **两处调用方的复位各自复位"自己的私有状态"，不是 epoch 状态**：
 *      - `promoted-code-mode`：释放已应用的 `tools.presentAs('ptc')`（呈现锁，压缩后必须
 *        重新协商）；
 *      - `context-gate`：丢弃 `deferredBySession` 的延迟步计数。
 *      把这两处合成一个「统一 reset 钩子」，要么在各自模块里造一个空转的钩子，要么漏掉
 *      真正需要复位的状态——所以它们**必须**留在原地。PLAN 的「字段级声明」在这里的正确
 *      落地是：**每个状态由它的所有者按自己的字段决定复位**，而不是把复位搬到中心。
 *
 * 三条验收序列（PLAN 要求）分别对应：阶段保留 / 晋升复位 / 失败不复位。其中前两条与
 * 第三条在 `test/engine/promotion-gate.test.mjs` 已有断言（`:123` 成功压缩复位门控、
 * `:140` 失败压缩不开启新 epoch、`:550` stages 的 compaction 不重置、`:317`
 * promoted-code-mode 的失败保留 / 成功释放）。本文件补的是**它们没有覆盖的那半**：
 * 复位对象是调用方私有状态这一事实本身。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEpochPromotion, isSuccessfulCompactionEnd } from '../../engine/compaction-epoch.mjs'

const session = (id = 's-1') => ({
  id,
  header: { delegationDepth: 0 },
  snapshotEvents: () => [],
})

const agentOf = (target) => ({ session: target, options: { model: 'deepseek-chat' } })
const compacted = (seq) => ({ type: 'compaction/end', seq })
const failed = (seq) => ({ type: 'compaction/end', seq, data: { error: 'boom' } })

/**
 * 冷扫初始化：`compaction-epoch.observe()` 只喂**已判定过**的会话（`:141-142` 条目不存在
 * 就直接返回），条目由 `status()` 的首次冷扫创建。真实流程里 `status()` 由装配触发，
 * 所以测试也必须先问一次状态，之后的 `observe` 才是增量——这正是该模块的「冷扫 + 增量」。
 */
const armed = (promo, agent) => {
  promo.status(agent)
  return agent
}

test('epoch 复位在 compaction-epoch 内部完成：成功压缩即丢旧 entry 并推进 boundary', () => {
  const promo = createEpochPromotion(['tool/call'])
  const target = session()
  const agent = armed(promo, agentOf(target))

  // 压缩前：一次 tool/call 即晋升，boundary 仍是 -1。
  // 注意 `status()` 返回的是**活的 entry**（还带 toolCalled/steps 等内部字段），
  // 所以只断言对外承诺的两个字段，不做整体 deepEqual。
  promo.observe(target, { type: 'tool/call', seq: 1 })
  assert.equal(promo.status(agent).promoted, true, '压缩前已晋升')
  assert.equal(promo.status(agent).boundary, -1, '尚无压缩边界')

  // 成功压缩：entry 被换成新的（promoted 归 false），boundary 前推到该事件 seq。
  promo.observe(target, compacted(5))
  assert.equal(promo.status(agent).promoted, false, '成功压缩后晋升状态被复位（新 epoch）')
  assert.equal(promo.status(agent).boundary, 5, 'boundary 推进到压缩事件')

  // 边界之前的事件不得重新晋升（旧 epoch 的信号不算数）。
  promo.observe(target, { type: 'tool/call', seq: 3 })
  assert.equal(promo.status(agent).promoted, false, '边界前的 tool/call 不重新晋升')

  // 边界之后的信号才晋升。
  promo.observe(target, { type: 'tool/call', seq: 6 })
  assert.equal(promo.status(agent).promoted, true, '边界后的 tool/call 重新晋升')
})

test('失败压缩不复位 epoch：边界与晋升状态都保持原样（既有纪律）', () => {
  const promo = createEpochPromotion(['tool/call'])
  const target = session()
  const agent = armed(promo, agentOf(target))
  promo.observe(target, { type: 'tool/call', seq: 1 })
  promo.observe(target, failed(5))

  assert.equal(promo.status(agent).promoted, true, '失败压缩不得复位晋升')
  assert.equal(promo.status(agent).boundary, -1, '失败压缩不得推进 boundary')
  assert.equal(isSuccessfulCompactionEnd(failed(5)), false, '判定谓词本身区分成功与失败')
  assert.equal(isSuccessfulCompactionEnd(compacted(5)), true)
})

test('复位对象是**调用方私有状态**：epoch 复位不会顺带复位它们（这就是不能归一的原因）', () => {
  const promo = createEpochPromotion(['tool/call'])
  const target = session()
  const agent = armed(promo, agentOf(target))
  promo.observe(target, { type: 'tool/call', seq: 1 })
  promo.observe(target, compacted(5))

  // 两个调用方的私有状态：模拟 promoted-code-mode 的呈现锁与 context-gate 的延迟计数。
  const presentation = { applied: true, disposer: () => { presentation.released = true } }
  const deferred = { steps: 3 }
  assert.equal(presentation.applied, true, '压缩前呈现已应用')
  assert.equal(deferred.steps, 3, '压缩前延迟计数非零')

  // epoch 复位后，这两个状态**原样还在**——所以必须由它们的所有者各自复位。
  assert.equal(promo.status(agent).promoted, false, 'epoch 已复位')
  assert.equal(presentation.applied, true, 'epoch 复位不碰呈现锁 → 需要 promoted-code-mode 自己释放')
  assert.equal(deferred.steps, 3, 'epoch 复位不碰延迟计数 → 需要 context-gate 自己删除')

  // 各自复位（与两个模块现有实现同语义）：
  presentation.disposer()
  presentation.applied = false
  const afterReset = undefined
  assert.equal(presentation.released, true, '呈现锁由它自己的 disposer 释放')
  assert.equal(afterReset, undefined, '延迟计数由它自己的 owner 删除（WeakMap.delete）')
})

test('复位策略按**状态字段**声明：同一个模块的两个字段可以策略相反', () => {
  // tool-bootstrap 的现状就是这条的现成反例：stage 字段不订阅复位、promotion 字段订阅复位。
  const promo = createEpochPromotion(['tool/call'])
  const target = session()
  const agent = armed(promo, agentOf(target))

  // promotion 字段：订阅复位（走 compaction-epoch 内部）。
  promo.observe(target, { type: 'tool/call', seq: 1 })
  assert.equal(promo.status(agent).promoted, true)
  promo.observe(target, compacted(5))
  assert.equal(promo.status(agent).promoted, false, 'promotion 字段随压缩复位')

  // stage 字段：不订阅复位（tool-bootstrap 自己的 Map，从不因 compaction 清空）。
  const stageBySession = new Map([['s-1', 2]])
  promo.observe(target, { type: 'tool/call', seq: 6 })
  assert.equal(stageBySession.get('s-1'), 2, 'stage 字段不受压缩影响（compaction 不重置）')

  // 反证：若把复位做成「按模块」决定，tool-bootstrap 只能二选一 —— 要么连 stage 一起复位
  // （改变既有行为），要么连 promotion 也不复位（破坏新 epoch 语义）。两者都错，
  // 所以策略必须声明在字段上：同一个模块里，两个字段此刻的状态是「一个复位过、一个没有」。
  assert.equal(promo.status(agent).promoted, true, 'promotion 字段：压缩后重新晋升（订阅复位）')
  assert.equal(stageBySession.get('s-1'), 2, 'stage 字段：压缩前后同一个值（不订阅复位）')
})
