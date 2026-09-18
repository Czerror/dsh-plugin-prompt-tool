/**
 * condition — 声明式条件判定的共享实现（pre-step / tool-pipeline / 事件层共用）。
 *
 * 匹配语义来自 anchor-match.mjs：键集合由 schema.mjs 在挂载期归一化并预编译为
 * `config.matchScan`（非法 logic / 空键集合 / 非法正则在挂载期 fail loud）。
 * 本模块只负责「按 subject 取文本」与「是否命中」两件事。
 *
 * 语义约定：
 *   - 未声明 match 的配置是**无条件**的（与引入条件判定前逐字一致）；
 *   - 取不到匹配文本（字段缺失、类型不符、序列化失败）一律按空串处理，即不命中；
 *   - 判定异常不抛出：门配错不应该阻断正常链路。
 */

import { extractText, sessionEvents } from './shared.mjs'

/** subject → 载荷字段名。改这里等于改所有层的匹配对象。 */
const SUBJECT_FIELDS = {
  toolArgs: 'argsText',
  toolResult: 'resultText',
  userMessage: 'userText',
  assistantText: 'assistantText',
  subagentInfo: 'subagentText',
}

/** 按 subject 取参与匹配的文本；取不到一律空串（不命中，不抛错）。 */
export function subjectTextOf(subject, payload) {
  if (payload === undefined || payload === null) return ''
  const field = SUBJECT_FIELDS[subject]
  return field !== undefined && typeof payload[field] === 'string' ? payload[field] : ''
}

/**
 * 条件判定：未声明 match 恒真。
 * 消费 schema 预编译的 `config.matchScan`；外部手工构造的 config 没有该函数时按无条件处理。
 */
export function conditionHit(config, payload) {
  if (config?.match === undefined) return true
  const scan = config.matchScan
  if (typeof scan !== 'function') return true
  try {
    return scan(subjectTextOf(config.subject, payload)).active === true
  } catch {
    return true
  }
}

/** 工具参数的可匹配文本：对象按 JSON 序列化，字符串原样；序列化失败按空串。 */
export function toolArgsText(args) {
  if (typeof args === 'string') return args
  try {
    return JSON.stringify(args ?? {})
  } catch {
    return ''
  }
}

/** pre-step 的缺省匹配对象：本批用户消息的文本。 */
export function userMessagesText(messages) {
  if (!Array.isArray(messages)) return ''
  return messages
    .filter((message) => message?.role === 'user')
    .map((message) => extractText(message))
    .filter((text) => text.length > 0)
    .join('\n')
}

/** 最后一条 assistant 消息的文本（turn-stop 的缺省匹配对象）。 */
export function lastAssistantText(session) {
  const events = sessionEvents(session)
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'assistant/message') return extractText(events[index].data)
  }
  return ''
}

/** 子代理事件的匹配文本：事件载荷序列化，取不到即空串。 */
export function subagentTextOf(info) {
  try {
    return JSON.stringify(info ?? {})
  } catch {
    return ''
  }
}
