import { createEpochPromotion } from '../compaction-epoch.mjs'
import { parsePromoteOn } from '../shared.mjs'
import { agentOf } from './subject.mjs'
import { optionalBoolean } from './values.mjs'

export function createPhasePredicate(options = {}) {
  const promoteEvents = options.promoteEvents ?? parsePromoteOn('predicates', options.promoteOn)
  if (!Array.isArray(promoteEvents) || promoteEvents.some((type) => typeof type !== 'string')) {
    throw new TypeError('predicates: promoteEvents must be an array of event type strings')
  }
  const subscribe = optionalBoolean(options.subscribe, 'subscribe', true)
  const trackerOptions = {
    includeSubagents: options.includeSubagents === true,
    promoteGate: options.promoteGate === true,
    promoteAfterFirstResponse: options.promoteAfterFirstResponse === true,
    maxPromoteSteps: options.maxPromoteSteps,
    reasoningPattern: options.reasoningPattern,
    reasoningNegativePattern: options.reasoningNegativePattern,
    reasoningFlags: options.reasoningFlags,
  }
  const tracker = createEpochPromotion(promoteEvents, trackerOptions)
  // 载荷归一后 agent 在 `payload.agent`；旧的手工形态（载荷本身就是 agent）由 agentOf 兼容。
  //
  // `compacted`（2026-09-22 用户拍板「扩原语」）：`status()` 本来就返回 `boundary`
  // （最近一次成功 `compaction/end` 的 seq，未压缩过为 -1），此前只用了 `promoted`。
  // `compacted: true` = 发生过成功压缩；`false` = 从未压缩；未声明 = 不判该维度。
  const compacted = optionalBoolean(options.compacted, 'compacted', undefined)
  // `promoted` 三态：缺省 `true`（= 原行为，向后兼容）/ `false` / `'ignore'`。
  //
  // 为什么需要它（对拍实测）：原实现把 `compacted` 与 `promoted` 写成**合取**，于是可表达的
  // 原子只有 `P`、`C∧P`、`¬C∧P`——三者在 **¬P 的会话上全为 false**，用 `any`/`all`/`not`/
  // `notAny` 的任何组合都表达不出原 `tool-bootstrap` compaction 回退要的 **`C ∧ ¬P`**
  // （受控相位 + 已压缩：压缩后回到受控工具集；声明侧见
  // `test/engine/declarations/tool-bootstrap.yml` 声明 2）。解耦后
  // `{ compacted: true, promoted: false }` 就是 `C ∧ ¬P`。
  const promotedOption = options.promoted
  if (promotedOption !== undefined && promotedOption !== true && promotedOption !== false && promotedOption !== 'ignore') {
    throw new TypeError("predicates: phase promoted must be true, false or 'ignore'")
  }
  if (promotedOption === 'ignore' && compacted === undefined) {
    throw new TypeError("predicates: phase promoted 'ignore' needs compacted — 否则该判定恒真")
  }
  const predicate = (payload) => {
    const status = (subscribe ? tracker : createEpochPromotion(promoteEvents, trackerOptions))
      .status(agentOf(payload))
    if (compacted !== undefined && (status.boundary >= 0) !== compacted) return false
    if (promotedOption === 'ignore') return true
    return status.promoted === (promotedOption ?? true)
  }
  predicate.kind = 'phase'
  // 只有订阅模式才有增量入口：不订阅时多一个入口只会诱使调用方以为状态被记住了。
  if (subscribe) predicate.observe = (session, event) => tracker.observe(session, event)
  return predicate
}
