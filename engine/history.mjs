/**
 * history — 会话历史的**唯一**读取入口，给出两个互不替代的视图。
 *
 * 1. `currentEvents()`：**当前模型可见上下文**，即 surface 有序节点（`session.surface.nodes`）指向的事件。
 *    压缩 / 位置替换遮蔽掉的节点不在其中，这正是「当前上下文」与「本会话曾经发生过」的差别。
 * 2. `historyEvents()`：**完整历史**，按 log 序返回本会话全部 durable 事件，供「必须看全量」的消费点。
 *
 * 两个视图都是纯函数：每次都读当场快照，不缓存、不跨会话保存任何状态。
 */

/**
 * 完整历史：`snapshotEvents()` 的全量不可变快照。
 * 宿主缺该接口（或返回非数组）时按空日志降级，不读取旧 `events` 数组。
 */
export function historyEvents(session) {
  const snapshot = session?.snapshotEvents?.()
  return Array.isArray(snapshot) ? snapshot : []
}

/**
 * 当前模型可见上下文：按 surface 节点序取出对应事件。
 *
 * `surface.nodes` 存的是 log seq，而 seq 就是 log 下标（`snapshotEvents()` 返回 [0, seq) 的切片），
 * 因此一次快照加索引即可映射，无需折叠、无需已 deprecated 的 `eventAt()`。
 *
 * 降级：surface 缺失、`nodes` 非数组，或任何节点越界（seq >= 日志长度）时退回完整历史 ——
 * 「宁可多看见，不少看见」，且等价于迁移前的旧行为。空 `nodes` 是合法状态（新会话尚无消息），
 * 按「当前上下文为空」返回空数组，**不**降级。
 * ponytail: 与 `deriveMessages()` 的差别是这里不跳过派生出 null 的空内容节点（判据读事件而非正文）；
 * 需要正文的消费点出现时再按 `deriveMessages()` 收窄。
 * 同一 seq 可在 `nodes` 中出现多次（位置替换后同一事件占多个位置），按条数计数的消费点需自行按 seq 去重。
 */
export function currentEvents(session) {
  const events = historyEvents(session)
  const nodes = session?.surface?.nodes
  if (!Array.isArray(nodes)) return events
  const visible = []
  for (const seq of nodes) {
    const event = events[seq]
    if (event === undefined) return events
    visible.push(event)
  }
  return visible
}

/**
 * surface 只承载**消息类**事件——`system/message`、`developer/message`、`user/message`、
 * `assistant/message`、`tool/result`（真值源：宿主 `packages/core/session/src/surface.ts` 的
 * `SURFACE_EVENT_TYPES`）。非该集合的事件（`tool/call`、`turn/start`、`compaction/end`）永远不是
 * surface 节点，按 `currentEvents()` 读它们只会读到空 —— 它们只能按完整历史读。
 * ponytail: 宿主扩大 `SURFACE_EVENT_TYPES` 时这里要同步，否则新的消息类事件会被当成 log-only
 * （count 多计、session 恒不命中）。
 */
export const SURFACE_MESSAGE_TYPES = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
])
