/**
 * condition — live 规则条件的文本事实提取（if.text.subject / if.anchor.subject）。
 *
 * 声明式 `config.subject` / `config.match` 执行链已退役；这里只保留：
 *   - subject → 载荷文本字段的映射（conditions/subject 与 availability 共用）；
 *   - 真实对话消息判据与 pre-step / turn-stop / 子代理事件的文本提取。
 * 条件判定本身归 conditions/*；本模块不做命中判断、不预编译匹配器。
 */

import { currentEvents } from './history.mjs'
import { extractText } from './shared.mjs'

/** 按 subject 取参与匹配的文本；live 条件 conditions/text 消费。 */
export function subjectTextOf(subject, payload) {
  if (payload === undefined || payload === null) return ''
  const field = SUBJECT_FIELDS[subject]
  return field !== undefined && typeof payload[field] === 'string' ? payload[field] : ''
}

/** subject → 载荷字段名。改这里等于改所有层的匹配对象。 */
export const SUBJECT_FIELDS = {
  toolArgs: 'argsText',
  toolResult: 'resultText',
  userMessage: 'userText',
  assistantText: 'assistantText',
  subagentInfo: 'subagentText',
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

/**
 * 「真实对话消息」的唯一判据（角色过滤由消费方各自保留）。
 *
 * 引擎自己注入的消息同样是 user-role（`executor.mjs` 的 `role: PRE_STEP_ROLE`、
 * `pluginMessage` 的 `source` 是 `plugin:<name>` 生产者身份），把它们算进来会让
 * `text.match` / 关键词世界书匹配到自己注入过的正文——正文里出现「重构」「实现」
 * 这类词就会自我命中，且命中判定在去重之前，`dedupe` 挡不住。
 * `userMessagesText`、原生关键词世界书的扫描 haystack 与
 * `context-activation.mjs#conversationMessages` 共用这一份，不再各写各的。
 */
export function isConversationMessage(message) {
  if (message === null || typeof message !== 'object') return false
  if (message.source?.plugin !== undefined) return false
  return message.source?.kind === undefined || message.source.kind === 'user'
}

/**
 * pre-step 的缺省匹配对象：本批**真实对话**的用户消息文本（判据见
 * {@link isConversationMessage}）。
 */
export function userMessagesText(messages) {
  if (!Array.isArray(messages)) return ''
  return messages
    .filter((message) => message?.role === 'user' && isConversationMessage(message))
    .map((message) => extractText(message))
    .filter((text) => text.length > 0)
    .join('\n')
}

/** 最后一条 assistant 消息的文本（turn-stop 的缺省匹配对象）；取**当前上下文**里可见的那条。 */
export function lastAssistantText(session) {
  const events = currentEvents(session)
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
