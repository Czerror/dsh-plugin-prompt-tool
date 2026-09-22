/**
 * progress-reminder — 执行期深思维持节拍（上游 dsh-anchored-standard 移植, MIT）。
 *
 * 锚定模式在每轮开场有深思考，但长工具循环中深思会衰减（后期步骤退化
 * 回 "Let me…"）。本模块每 N 次工具结果向对话滴入一条短 user 提醒——
 * 永不阻塞、永不报错、不碰工具目录：
 *
 *   `tools/post-execute` → { kind: 'accept', additionalContexts: [notice] }
 *
 * harness 把 additionalContexts 作为 durable user 消息追加在整批工具结果
 * 之后，落在下一请求的规划节拍位（与 Code Mode 嵌套上下文同形状）。
 * 模型读到后以一句 "We …" 重申剩余目标并继续。
 *
 * 节奏由配置给出（组合源默认 every: 4 次结果、每轮最多 maxPerTurn: 1 条；
 * every: 0 禁用）。计数在 await 前同步自增（并行调用无法竞态越过节奏）；
 * 轮边界由 durable turn/start + assistant/chunk 双路跟踪（无轮号时降级
 * session 全局）；子代理默认不滴（brief 即计划）。
 */

import { booleanOption, createWarnOnce, newMessageId, requiredInt, requiredText, sessionState, validateConfig } from './shared.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'progress-reminder'

// 节拍间隔、每轮上限与提醒正文无内置默认：取值与文案归组合源 / 预设
// （见 engine/compositions/source/local/progress-reminder.yml）。

/** Every config key this plugin accepts — anything else is a typo. */
const ALLOWED_KEYS = new Set(['enabled', 'every', 'maxPerTurn', 'includeSubagents', 'text'])

/** 注册执行后深思滴入。 */
export function apply(ctx, config) {
  const source = validateConfig(name, config, ALLOWED_KEYS)
  // 开关语义：未声明 = 关闭（需要默认开启时由组合源显式写 enabled: true）。
  if (source.enabled !== true) return
  const every = requiredInt(name, source.every, 'every', 0)
  const maxPerTurn = requiredInt(name, source.maxPerTurn, 'maxPerTurn', 1)
  const includeSubagents = booleanOption(name, source.includeSubagents, 'includeSubagents', false)
  const text = requiredText(name, source.text, 'text')
  // 显式留空正文 = 不滴入（无提醒措辞即无节拍）。
  if (text === undefined) return

  /**
   * 每轮计数条目（`sessionState`：统一访问接口，策略与迁移前逐条相同）。
   *
   * 键类型 `session.id`、淘汰策略超限 `clear()` 全清、**不声明复位**——复位时机由本模块
   * 自己的 `turn/start` 监听按字段处理（B4 迁移只换访问方式，不改任何策略）。
   *
   * 注：本计数是**纯增量**、不可从事件流重建（B4 PLAN 的已知边界），所以它的丢失时机
   * 与迁移前逐字一致才算零变更——`sessionState` 的 `clear()` 档正是 `sessionMapGet` 的
   * 同一实现，第 4096 个会话仍会清空其它存活会话的预算。
   */
  const state = sessionState(ctx, () => ({ results: 0, drips: 0, lastTurn: undefined }))

  /** 取（或建）会话计数条目；无 id 的会话取不到（调用方已有守卫）。 */
  const countersOf = (session) => state.get(session) ?? { results: 0, drips: 0, lastTurn: undefined }

  const warnOnce = createWarnOnce(ctx, name)

  // 轮跟踪：turn/start 重置计数；无可用轮号时用 assistant/chunk 的新轮。
  ctx.on('session/event', (session, event) => {
    if (session === undefined || session.id === undefined) return
    if (event.type === 'turn/start') {
      const turn = event.data?.turn
      const entry = countersOf(session)
      if (entry.lastTurn !== turn) {
        entry.lastTurn = typeof turn === 'number' ? turn : entry.lastTurn
        entry.results = 0
        entry.drips = 0
      }
      return
    }
    if (event.type === 'assistant/chunk') {
      const turn = event.data?.turn
      if (typeof turn !== 'number') return
      const entry = countersOf(session)
      if (entry.lastTurn === undefined || turn > entry.lastTurn) {
        entry.lastTurn = turn
        entry.results = 0
        entry.drips = 0
      }
    }
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    // await 前同步计数，并行调用不能竞态越过节奏。
    const session = exec?.agent?.session
    const eligible = session !== undefined
      && session.id !== undefined
      && (includeSubagents || (session.header?.delegationDepth ?? 0) === 0)
    const entry = eligible ? countersOf(session) : undefined
    if (entry !== undefined) entry.results += 1
    const due = entry !== undefined
      && every > 0
      && entry.results % every === 0
      && entry.drips < maxPerTurn

    const decision = await next()
    try {
      if (!due || decision?.kind !== 'accept') return decision
      entry.drips += 1
      const notice = {
        id: newMessageId('progress-reminder'),
        role: 'user',
        content: [{ type: 'text', text }],
        source: {
          kind: 'plugin',
          plugin: name,
          form: 'notice',
          summary: 'deliberation maintenance beat',
        },
      }
      return {
        ...decision,
        additionalContexts: [...(decision.additionalContexts ?? []), notice],
      }
    } catch (error) {
      warnOnce(`${name}: drip injection failed, keeping the plain result: ${String((error && error.message) || error)}`)
      return decision
    }
  })
}
