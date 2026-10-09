import { SURFACE_MESSAGE_TYPES, currentEvents, historyEvents } from '../history.mjs'
import { isDelegated } from '../shared.mjs'
import { sessionOf } from './subject.mjs'
import { optionalBoolean } from './values.mjs'

export function createSessionStatePredicate(options = {}) {
  const type = options.type
  if (typeof type !== 'string' || type.length === 0) {
    throw new TypeError('predicates: a session-state predicate needs an event type')
  }
  const present = optionalBoolean(options.present, 'present', false)
  // 受众判据（2026-09-22 用户拍板「扩原语」）：`delegated: false` = 只在主会话命中，
  // `true` = 只在子代理命中，未声明 = 不判受众。子代理判定复用 `shared.isDelegated`，
  // 不写字面量比较（trigger.mjs 的会话态契约第 (2) 条纪律）。
  const delegated = optionalBoolean(options.delegated, 'delegated', undefined)
  // `present` 对消息类镜像的是**当前上下文**，不是「本会话发生过」：被压缩遮蔽的事件模型已经看不到。
  // 非 surface 承载的类型（`tool/call`、`turn/start`、`compaction/end`）永远不是 surface 节点，
  // 按当前上下文判只会恒 false（`present: true`）/ 恒 true（`present: false`）——配置能编译能挂载，
  // 却永不按意图命中，所以这类类型按完整历史判（类型表见 `history.mjs#SURFACE_MESSAGE_TYPES`）。
  const view = SURFACE_MESSAGE_TYPES.has(type) ? currentEvents : historyEvents
  const predicate = (payload) => {
    if (delegated !== undefined && isDelegated(sessionOf(payload)) !== delegated) return false
    return view(sessionOf(payload))
      .some((event) => event?.type === type) === present
  }
  predicate.kind = 'session'
  return predicate
}
