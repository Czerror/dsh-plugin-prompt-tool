/** ST 世界书选择器；只消费显式 ST 导入字段，不改变原生 world-book 约定。 */
import { createAnchorMatcher } from './anchor-match.mjs'
import { sessionEvents } from './shared.mjs'
import { interpolateVariables } from './interpolate.mjs'

/** 只扫描真实对话的可见文本，排除插件注入与思维块。 */
export function stChatMessages(session, pending = []) {
  const result = [], ids = new Set()
  const add = (message, role) => {
    if (!message || !['user', 'assistant'].includes(role) || message.source?.plugin
      || (message.source?.kind && message.source.kind !== 'user')) return
    if (message.id && ids.has(message.id)) return
    if (message.id) ids.add(message.id)
    const text = (Array.isArray(message.content) ? message.content : []).filter(block => block.type === 'text' || block.type === undefined).map(block => block.text ?? '').join('')
    result.push({ id: message.id, role, text })
  }
  for (const event of sessionEvents(session)) {
    if (event?.type === 'user/message' || event?.type === 'assistant/message') add(event.data?.message ?? event.data, event.type.split('/')[0])
  }
  for (const message of pending) add(message, message.role ?? 'user')
  return result
}

const sessions = new WeakMap()
const matchers = new WeakMap()
const count = (value, fallback = 0) => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1000) : fallback

/** 只读诊断上限：只截断观测记录，绝不改变入选、抽样与时间窗状态。 */
const DIAGNOSTIC_LIMIT = 200

export function selectStWorldBook(configs, session, messages, warn = () => {}) {
  const entries = configs.filter(config => config.enabled !== false && config.strategy === 'world-book' && config.params?.stWorldBook)
  const records = []
  let truncated = false
  const note = (config, stage, reason, extra) => {
    if (records.length >= DIAGNOSTIC_LIMIT) { truncated = true; return }
    records.push({ id: String(config.id ?? ''), stage, reason, ...extra })
  }
  const finish = selection => {
    selection.diagnostics = { records, truncated }
    return selection
  }
  if (!entries.length) return finish(new Set())
  // 被显式禁用的 ST 条目：由本层负责报告，不由 UI 猜测。
  for (const config of configs) {
    if (config.enabled === false && config.strategy === 'world-book' && config.params?.stWorldBook) note(config, 'excluded', 'disabled')
  }
  const chat = stChatMessages(session, messages)
  let state = sessions.get(session)
  if (!state) { state = new WeakMap(); sessions.set(session, state) }
  const generation = JSON.stringify([chat.length, chat.at(-1)])
  const selected = new Set(), failed = new Set(), occupied = new Set(), stickyEntries = new Set(), candidates = []
  const updates = new Map()
  selected.commit = config => {
    note(config, 'committed', 'injected')
    if (updates.has(config)) state.set(config, updates.get(config))
  }
  const priority = [...entries].sort((a, b) => b.order - a.order)
  const recursiveText = []
  // 每轮至多激活每条一次；有限传递闭包，不递归调用解析器。
  for (let pass = 0; pass <= entries.length; pass++) {
    candidates.length = 0
    for (const config of priority) {
      if (selected.has(config) || failed.has(config)) continue
      const p = config.params, st = p.stWorldBook
      const previous = state.get(config)
      const sticky = previous?.last !== undefined && count(st.sticky) > 0 && chat.length < previous.last + count(st.sticky)
      if (sticky) { stickyEntries.add(config); note(config, 'candidate', 'sticky') }
      if (chat.length < count(st.delay)) { note(config, 'excluded', 'delay', { delay: count(st.delay), messages: chat.length }); continue }
      if (!sticky && previous?.last !== undefined && count(st.cooldown) > 0 && chat.length > previous.last
        && chat.length < previous.last + count(st.sticky) + count(st.cooldown)) { note(config, 'excluded', 'cooldown'); continue }
      if (pass > 0 && (st.excludeRecursion === true || st.recursive !== true)) { note(config, 'excluded', 'recursion'); continue }
      let active = sticky || p.constant === true
      let activation = sticky ? 'sticky' : p.constant === true ? 'constant' : 'key-match'
      if (!active) {
        const depth = count(st.scanDepth, 2)
        const parts = depth === 0 ? [] : chat.slice(-depth).reverse().map(message => message.text)
        for (const [flag, key] of [['matchCharacterDescription', 'description'], ['matchCharacterPersonality', 'personality'], ['matchScenario', 'scenario'], ['matchPersonaDescription', 'persona']]) {
          if (depth > 0 && st[flag] === true && typeof config.variables[key] === 'string') parts.push(config.variables[key])
        }
        if (pass > 0 && depth > 0) parts.push(...recursiveText)
        const keys = (Array.isArray(p.keys) ? p.keys : []).map(key => interpolateVariables(String(key), config.variables, session)).filter(Boolean)
        const secondaryKeys = (Array.isArray(p.secondaryKeys) ? p.secondaryKeys : []).map(key => interpolateVariables(String(key), config.variables, session)).filter(Boolean)
        try {
          const signature = JSON.stringify([keys, secondaryKeys, p.caseSensitive, p.wholeWords, p.useRegex])
          let compiled = matchers.get(p)
          if (compiled?.signature !== signature) {
            compiled = { signature, matcher: createAnchorMatcher({ keys, secondaryKeys, caseSensitive: p.caseSensitive === true, wholeWords: p.wholeWords === true, useRegex: p.useRegex, stWords: true }) }
            matchers.set(p, compiled)
          }
          const match = compiled.matcher.scan(parts.length ? '\x01' + parts.join('\n\x01') : '')
          active = match.primary > 0
          const logic = p.selectiveLogic ?? 0
          const detail = { scanDepth: depth, primary: match.primary, secondary: match.secondary, secondaryKeys: secondaryKeys.length, logic }
          if (active && st.selective === true && secondaryKeys.length > 0) {
            active = logic === 1 ? match.secondary < secondaryKeys.length : logic === 2 ? match.secondary === 0
              : logic === 3 ? match.secondary === secondaryKeys.length : match.secondary > 0
            if (!active) note(config, 'rejected', 'secondary-miss', detail)
          } else if (!active) {
            note(config, 'rejected', 'primary-miss', detail)
          }
        } catch (error) {
          note(config, 'rejected', 'match-error', { message: String(error?.message ?? error).slice(0, 120) })
          warn(`prompt-config-engine: 世界书 ${config.id} 匹配失败：${String(error?.message ?? error)}`)
          failed.add(config)
          continue
        }
      }
      if (!active) continue
      const probability = typeof st.probability === 'number' && Number.isFinite(st.probability) ? Math.max(0, Math.min(100, st.probability)) : 100
      const roll = previous?.generation === generation ? previous.roll : Math.random() * 100
      state.set(config, { ...previous, generation, roll })
      if (!sticky && st.useProbability !== false && (probability <= 0 || roll >= probability)) {
        note(config, 'rejected', 'probability', { probability, roll })
        failed.add(config)
        continue
      }
      note(config, 'candidate', activation, { probability, useProbability: st.useProbability !== false })
      candidates.push(config)
    }
    if (!candidates.length) break
    const groups = new Map()
    for (const config of candidates) {
      const names = String(config.params.stWorldBook.group ?? '').split(',').map(name => name.trim()).filter(Boolean)
      if (!names.length) { selected.add(config); note(config, 'selected', 'ungrouped'); continue }
      if (names.some(name => occupied.has(name))) { note(config, 'rejected', 'group-occupied'); failed.add(config); continue }
      for (const name of names) { const members = groups.get(name) ?? []; members.push(config); groups.set(name, members) }
    }
    for (const [name, members] of groups) {
      if (occupied.has(name)) continue
      const remaining = members.filter(config => !failed.has(config) && !String(config.params.stWorldBook.group).split(',').some(group => occupied.has(group.trim())))
      if (!remaining.length) continue
      const sticky = remaining.filter(config => stickyEntries.has(config))
      const overriding = sticky.length ? sticky : remaining.filter(config => config.params.stWorldBook.groupOverride === true)
      const available = overriding.length ? overriding : remaining
      const weight = config => typeof config.params.stWorldBook.groupWeight === 'number' ? Math.max(0, config.params.stWorldBook.groupWeight) : 100
      let choice = available[0]
      if (!overriding.length) {
        let roll = (state.get(choice).roll / 100) * available.reduce((sum, config) => sum + weight(config), 0)
        for (const config of available) { roll -= weight(config); if (roll < 0) { choice = config; break } }
      }
      selected.add(choice)
      note(choice, 'selected', 'group-winner', { group: String(choice.params.stWorldBook.group ?? '') })
      for (const group of String(choice.params.stWorldBook.group).split(',').map(value => value.trim()).filter(Boolean)) occupied.add(group)
      for (const config of members) if (config !== choice) { note(config, 'rejected', 'group-lost', { group: name }); failed.add(config) }
    }
    const added = candidates.filter(config => selected.has(config))
    if (!added.length) break
    for (const config of added) {
      const previous = state.get(config)
      // sticky 期间的重发不延长有效期；新命中才开始下一段窗口。
      if (previous.last === undefined || chat.length >= previous.last + count(config.params.stWorldBook.sticky)) updates.set(config, { ...previous, last: chat.length })
    }
    if (!entries.some(config => config.params.stWorldBook.recursive === true)) break
    recursiveText.push(...added.filter(config => config.params.stWorldBook.preventRecursion !== true).map(config => config.texts.join('\n')))
  }
  return finish(selected)
}
