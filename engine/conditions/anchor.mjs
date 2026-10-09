import { createAnchorMatcher } from '../anchor-match.mjs'
import { isSuccessfulCompactionEnd } from '../compaction-epoch.mjs'
import { currentEvents } from '../history.mjs'
import { sessionState } from '../shared.mjs'
import { sessionOf } from './subject.mjs'
import { boundOf, keyList } from './values.mjs'

/** 首条 assistant reasoning 的确认事实（只报确认，轮数由谓词按需数）；未到达时不缓存，无 id 会话不共享状态。 */
export function createAnchorState(options = {}) {
  const matcher = createAnchorMatcher({ keys: keyList(options.keys, 'anchor.keys'), mode: 'prefix' })
  // `sessionState` 的 `reset` 档要挂载期 `ctx` 才订阅，而本模块由 `compileWhen` 在编译期构造、
  // 拿不到 `ctx`；失效改走 `observe`（谓词自己的增量入口，与 count / phase 同一条既有接线）。
  const confirmedBySession = sessionState(undefined, () => false)
  const inspect = session => {
    const cached = confirmedBySession.peek(session)
    // 确认与否一旦记下就不再回看事件流（它只由首条 assistant 消息决定，后来者改不了）。
    if (cached !== undefined) return { confirmed: cached }
    // 确认看**当前上下文**的首条 assistant 推理：被压缩遮蔽的那条已不在模型眼前。
    // 与门控 `anchored`（`compaction-epoch.mjs` 按完整历史判「曾经锚定过」）方向相反，
    // 两者对同一会话可能给出不同答案——已知对偶，不是 bug。
    for (const event of currentEvents(session)) {
      if (event.type !== 'assistant/message') continue
      const reasoning = (event.data?.message?.content ?? []).find(block => block.type === 'reasoning')
      const confirmed = reasoning !== undefined && matcher.scan(String(reasoning.text ?? '')).active
      confirmedBySession.set(session, confirmed)
      return { confirmed }
    }
    return { confirmed: false }
  }
  // 记忆读的是**当前上下文**：成功压缩把原首条推理遮蔽掉后可见首条可能变，旧结论必须作废
  // （`isSuccessfulCompactionEnd` 是「成功压缩」的既有判据，count 的复位用的是同一个）。
  inspect.observe = (session, event) => {
    if (isSuccessfulCompactionEnd(event)) confirmedBySession.delete(session)
  }
  return inspect
}

/** 确认即命中；可选 fallbackAfter 表示超过指定 assistant 消息数后也允许。 */
export function createAnchorPredicate(options = {}) {
  const inspect = createAnchorState(options)
  const fallbackAfter = boundOf(options.fallbackAfter, 'anchor.fallbackAfter')
  const predicate = payload => {
    const session = sessionOf(payload)
    if (inspect(session).confirmed) return true
    if (fallbackAfter === undefined) return false
    // 兜底只看轮数，计到 fallbackAfter + 1 即提前退出（开场尚无 assistant 消息时这一步会再读一次快照）。
    // 轮数按**当前上下文**算，且同一 seq 只算一次：位置替换后同一事件可在
    // `session.surface.nodes` 里占多个位置（`history.mjs` 头部），按条数直数会虚高。
    const seen = new Set()
    let rounds = 0
    for (const event of currentEvents(session)) {
      if (event.type !== 'assistant/message') continue
      if (event.seq !== undefined) {
        if (seen.has(event.seq)) continue
        seen.add(event.seq)
      }
      if (++rounds > fallbackAfter) return true
    }
    return false
  }
  predicate.kind = 'anchor'
  // 转发给 `wireTriggerObservers`：谓词自己不订阅事件流，接线规则与 count / phase 逐字相同。
  predicate.observe = (session, event) => inspect.observe(session, event)
  return predicate
}
