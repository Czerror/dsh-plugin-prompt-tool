// B1 helper 收敛（零行为变更）验收用例（2026-09-22，PLAN: engine-b1-helper-convergence）。
// ① sessionMapGet 与替换前手写形态逐字对拍：返回值身份、map 内容、清空时机三者一致；
// ② PLAN R2 要求的三条序列断言，证明被剔除的三处确实与 sessionMapGet 不等价：
//    (a) compaction-epoch 成功压缩必须覆盖已有键（只建不改会留下旧 epoch）；
//    (c) strategies 首个 assistant 消息延迟到达时不缓存 false。
//    (b) 的 `tool-bootstrap` 阶段更新路径用例已随该模块在 B7 T3 删除（模块被声明式触发器取代）。
// 这两处按 PLAN 明确不替换，本文件只做行为证明，不驱动它们改用 helper。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_TRACKED_SESSIONS, sessionMapGet } from '../../engine/shared.mjs'
import { createEpochPromotion } from '../../engine/compaction-epoch.mjs'
import { bindResolver } from '../../engine/strategies.mjs'

// ── ① sessionMapGet 对拍 ────────────────────────────────────────────────────

/**
 * 替换前的手写形态（逐字复制自 deliberation-gate.mjs / progress-reminder.mjs /
 * layers.mjs 被替换的三段：get → 缺失时超限 clear → create → set）。
 */
function legacySessionMapGet(map, key, create) {
  let entry = map.get(key)
  if (entry === undefined) {
    if (map.size >= MAX_TRACKED_SESSIONS) map.clear()
    entry = create()
    map.set(key, entry)
  }
  return entry
}

/**
 * 同一脚本跑一遍实现，记录每次 get 的返回值身份、create 次数与 map 规模。
 * 填充阶段只记规模（避免 4096 条日志各自快照 keys）。
 */
function runScript(impl) {
  const map = new Map()
  const log = []
  const get = (key, record = true) => {
    let created = 0
    const entry = impl(map, key, () => { created += 1; return { key } })
    const step = { created, size: map.size, sameRef: map.get(key) === entry }
    if (record) log.push({ key, ...step })
    return { ...step, entry }
  }
  const first = get('s-1')
  const second = get('s-1')
  for (let index = 0; index < MAX_TRACKED_SESSIONS - 2; index += 1) get(`fill-${index}`, false)
  const belowCapMiss = get('probe-a')
  const atCapHit = get('s-1')
  const overCapMiss = get('probe-b')
  return {
    log, first, second, belowCapMiss, atCapHit, overCapMiss,
    finalSize: map.size,
    finalKeys: [...map.keys()].sort(),
    probeEntry: map.get('probe-b') === overCapMiss.entry,
  }
}

test('sessionMapGet 对拍：返回值身份、map 内容与清空时机与替换前手写逐字一致', () => {
  // 上限值本身是硬约束（不得顺手改）。
  assert.equal(MAX_TRACKED_SESSIONS, 4096, '上限值 4096 未变')

  const legacy = runScript(legacySessionMapGet)
  const helper = runScript(sessionMapGet)

  for (const [label, run] of [['legacy', legacy], ['helper', helper]]) {
    assert.equal(run.first.created, 1, `${label}: 缺失时创建一次`)
    assert.equal(run.first.sameRef, true, `${label}: 返回的就是 map 里的条目`)
    assert.equal(run.second.created, 0, `${label}: 命中不重新创建`)
    assert.equal(run.second.size, 1, `${label}: 命中不新增键`)
    assert.equal(run.belowCapMiss.size, MAX_TRACKED_SESSIONS, `${label}: 未超限的 miss 不清空`)
    assert.equal(run.belowCapMiss.created, 1, `${label}: 未超限的 miss 仍创建`)
    assert.equal(run.atCapHit.size, MAX_TRACKED_SESSIONS, `${label}: 满员时的命中绝不清空`)
    assert.equal(run.atCapHit.created, 0, `${label}: 满员时的命中不创建`)
    assert.equal(run.overCapMiss.size, 1, `${label}: 满员后的 miss 清空重建（清空时机在 miss 上）`)
    assert.equal(run.overCapMiss.created, 1, `${label}: 清空后重新创建`)
    assert.deepEqual(run.finalKeys, ['probe-b'], `${label}: 清空后只剩触发重建的键`)
    assert.equal(run.probeEntry, true, `${label}: 重建条目确实落进 map`)
  }

  // 逐条对拍：同一组 (map, key) 序列下两实现的可观测行为完全一致。
  assert.deepEqual(helper.log, legacy.log, 'probe 序列的返回值/创建次数/map 规模一致')
  assert.deepEqual(helper.finalKeys, legacy.finalKeys, 'map 内容一致')
  assert.equal(helper.finalSize, legacy.finalSize, 'map 规模一致')

  // 显式语义：值为 undefined 的键按缺失处理（helper 用 `=== undefined` 判定）。
  for (const [label, impl] of [['legacy', legacySessionMapGet], ['helper', sessionMapGet]]) {
    const map = new Map([['ghost', undefined]])
    let created = 0
    const entry = impl(map, 'ghost', () => { created += 1; return { key: 'ghost' } })
    assert.equal(created, 1, `${label}: undefined 值视为缺失`)
    assert.equal(map.get('ghost'), entry, `${label}: 缺失分支重建并覆盖`)
  }
})

// ── ② 三条序列断言：证明被剔除的三处与 sessionMapGet 不等价 ─────────────────

/** 只建不改的反事实：键已存在时 sessionMapGet 返回旧条目，新值写不进去。 */
const onlyCreateKeepsStale = (stale, fresh) => {
  const map = new Map([['s', stale]])
  const returned = sessionMapGet(map, 's', () => fresh)
  return { returned, stored: map.get('s') }
}

test('序列断言(a)：compaction-epoch 成功压缩后 epoch 状态被覆盖为新值', () => {
  const stale = { boundary: -1, promoted: true }
  const fresh = { boundary: 5, promoted: false }
  const counterfactual = onlyCreateKeepsStale(stale, fresh)
  assert.equal(counterfactual.returned, stale, '反事实：只建不改拿到的仍是旧 entry')
  assert.equal(counterfactual.stored, stale, '反事实：新 epoch 根本没写进 map')

  // 真实路径：压缩前的晋升信号 → 成功压缩 → 状态必须被新 entry 覆盖。
  const promo = createEpochPromotion(['tool/call'], {})
  const session = { id: 'epoch-overwrite', header: { delegationDepth: 0 }, snapshotEvents: () => [{ type: 'tool/call', seq: 1 }] }
  const agent = { session }
  const before = promo.status(agent)
  assert.equal(before.boundary, -1, '压缩前边界仍是 -1')
  assert.equal(before.promoted, true, '压缩前已有晋升信号 → 已晋升')

  promo.observe(session, { type: 'compaction/end', seq: 5, data: {} })

  const after = promo.status(agent)
  assert.equal(after.boundary, 5, '成功压缩后 boundary 前推到新边界（覆盖写入生效）')
  assert.equal(after.promoted, false, '压缩前的事件不再计入新 epoch（旧值被覆盖，未被旧 entry 卡住）')
  assert.notEqual(after, before, '压缩后取到的是新 entry 对象')
})

test('序列断言(c)：strategies 首个 assistant 消息延迟到达时不缓存 false（条件缓存）', () => {
  const resolve = bindResolver({
    id: 'seq-custom-fallback',
    strategy: 'custom-fallback',
    texts: ['FALLBACK'],
    params: { firstTurnWord: 'We' },
  })
  const events = []
  const session = { id: 'fallback-deferred', header: { delegationDepth: 0 }, snapshotEvents: () => events }
  const agent = { session }

  // 尚无首条 assistant 消息：返回 null，且不得把 false 缓存下来。
  assert.equal(resolve({ agent }), null, '无 assistant 消息 → 不注入')
  const counterfactual = onlyCreateKeepsStale({ cached: false }, { cached: true })
  assert.equal(counterfactual.stored.cached, false, '反事实：只建不改会把 false 永久钉住')

  // 延迟到达的确认：同一会话必须重新判定并注入（缓存 false 会永久挡住）。
  events.push({
    type: 'assistant/message',
    seq: 1,
    data: { message: { content: [{ type: 'reasoning', text: 'We start.' }] } },
  })
  const resolved = resolve({ agent })
  assert.equal(resolved?.text, 'FALLBACK', '延迟到达的首个 assistant 消息使确认生效并注入')
  assert.equal(resolved?.source?.plugin, 'seq-custom-fallback', '注入来源为配置 id')
  assert.equal(resolve({ agent })?.text, 'FALLBACK', '首次判定未留下错误缓存（第二次判定仍为已确认）')
})
