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
/** 每个会话只保留最近一次选择的诊断快照（随会话对象 GC 释放）。 */
const lastRuns = new WeakMap()
const count = (value, fallback = 0) => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1000) : fallback

/** 只读诊断上限：只截断观测记录，绝不改变入选、抽样与时间窗状态。 */
const DIAGNOSTIC_LIMIT = 200

/** 最近一次世界书选择诊断（只读快照；无记录时返回空集合，不触发任何求值）。
 *  `evaluated: false` 表示该会话还没求值过，与"已求值但本次为空"区分开。 */
export function lastWorldBookDiagnostics(session) {
  return lastRuns.get(session) ?? { records: [], truncated: false, step: 0, evaluated: false }
}

export function selectStWorldBook(configs, session, messages, warn = () => {}) {
  const entries = configs.filter(config => config.enabled !== false && config.strategy === 'world-book' && config.params?.stWorldBook)
  // 本次选择的有界观测快照：`selection.diagnostics` 与会话最近快照引用**同一对象**，
  // 因此 commit 阶段追加记录或把 truncated 置真都写回同一份事实（不复制布尔值，
  // 否则 commit 越限时读取端仍看到 truncated=false）。
  const snapshot = { records: [], truncated: false, step: 0, evaluated: true }
  const note = (config, stage, reason, extra) => {
    if (snapshot.records.length >= DIAGNOSTIC_LIMIT) { snapshot.truncated = true; return }
    snapshot.records.push({ id: String(config.id ?? ''), stage, reason, ...extra })
  }
  const finish = selection => {
    selection.diagnostics = snapshot
    // 最近一次求值总是替换快照（含空集合）：空结果不能被读成"本次又注入了旧条目"。
    lastRuns.set(session, snapshot)
    return selection
  }
  // 被显式禁用的 ST 条目：由本层负责报告，不由 UI 猜测。
  for (const config of configs) {
    if (config.enabled === false && config.strategy === 'world-book' && config.params?.stWorldBook) note(config, 'excluded', 'disabled')
  }
  if (!entries.length) return finish(new Set())
  const chat = stChatMessages(session, messages)
  snapshot.step = chat.length
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
  // ST 的延迟层级池（world-info.js:4753-4762）：只收真值，true 归一为 1，升序去重；
  // 初始化即取走最小层级，因此「延迟到第 N 层」的条目在首次递归 pass 就能解锁；
  // 层级只增不减（:5131），已打开的层级对后续 pass 保持打开。
  const delayLevels = [...new Set(entries
    .map(config => config.params.stWorldBook.delayUntilRecursion)
    .filter(Boolean)
    .map(value => value === true ? 1 : value))].sort((a, b) => a - b)
  let delayLevel = delayLevels.shift() ?? 0
  const hasRecursive = entries.some(config => config.params.stWorldBook.recursive === true)
  /** 键匹配器（按 params 对象缓存；签名含插值后的键与匹配选项）。 */
  const matcherOf = (config, material) => {
    const p = config.params
    const signature = JSON.stringify([material.keys, material.secondaryKeys, p.caseSensitive, p.wholeWords, p.useRegex])
    let compiled = matchers.get(p)
    if (compiled?.signature !== signature) {
      compiled = { signature, matcher: createAnchorMatcher({ keys: material.keys, secondaryKeys: material.secondaryKeys, caseSensitive: p.caseSensitive === true, wholeWords: p.wholeWords === true, useRegex: p.useRegex, stWords: true }) }
      matchers.set(p, compiled)
    }
    return compiled.matcher
  }
  // 每轮至多激活每条一次；有限传递闭包，不递归调用解析器。
  for (let pass = 0; pass <= entries.length; pass++) {
    candidates.length = 0
    // 每 pass 的扫描材料缓存：递归文本随 pass 变化，材料必须按 pass 重新构造；
    // 材料只被匹配与评分读取，构造本身不改变入选结果。
    const scanCache = new Map()
    const scanOf = (config, st) => {
      let material = scanCache.get(config)
      if (material !== undefined) return material
      const depth = count(st.scanDepth, 2)
      const parts = depth === 0 ? [] : chat.slice(-depth).reverse().map(message => message.text)
      // 角色字段扫描（ST globalScanData，world-info.js:294-320）：每个开关只在对应变量
      // 有值时并入扫描文本；creator_notes / depth_prompt 由导入期登记（未开启不并入，
      // 既有触发面不变）。
      for (const [flag, key] of [['matchCharacterDescription', 'description'], ['matchCharacterPersonality', 'personality'], ['matchScenario', 'scenario'], ['matchPersonaDescription', 'persona'], ['matchCreatorNotes', 'creator_notes'], ['matchCharacterDepthPrompt', 'depth_prompt']]) {
        if (depth > 0 && st[flag] === true && typeof config.variables[key] === 'string') parts.push(config.variables[key])
      }
      if (pass > 0 && depth > 0) parts.push(...recursiveText)
      const p = config.params
      const keys = (Array.isArray(p.keys) ? p.keys : []).map(key => interpolateVariables(String(key), config.variables, session)).filter(Boolean)
      const secondaryKeys = (Array.isArray(p.secondaryKeys) ? p.secondaryKeys : []).map(key => interpolateVariables(String(key), config.variables, session)).filter(Boolean)
      material = { depth, keys, secondaryKeys, text: parts.length ? '\x01' + parts.join('\n\x01') : '' }
      scanCache.set(config, material)
      return material
    }
    // ST getScore 等价（world-info.js:428-473）：只统计命中数，否定逻辑（NOT_ALL/NOT_ANY）
    // 不参与加分，主键为空记 0 分。
    const scoreOf = (config, st) => {
      const material = scanOf(config, st)
      const match = matcherOf(config, material).scan(material.text)
      if (material.keys.length === 0) return 0
      if (material.secondaryKeys.length === 0) return match.primary
      const logic = config.params.selectiveLogic ?? 0
      if (logic === 0) return match.primary + match.secondary
      if (logic === 3) return match.secondary === material.secondaryKeys.length ? match.primary + match.secondary : match.primary
      return match.primary
    }
    for (const config of priority) {
      if (selected.has(config) || failed.has(config)) continue
      const p = config.params, st = p.stWorldBook
      const previous = state.get(config)
      const sticky = previous?.last !== undefined && count(st.sticky) > 0 && chat.length < previous.last + count(st.sticky)
      if (sticky) { stickyEntries.add(config); note(config, 'candidate', 'sticky') }
      if (chat.length < count(st.delay)) { note(config, 'excluded', 'delay', { delay: count(st.delay), messages: chat.length }); continue }
      if (!sticky && previous?.last !== undefined && count(st.cooldown) > 0 && chat.length > previous.last
        && chat.length < previous.last + count(st.sticky) + count(st.cooldown)) { note(config, 'excluded', 'cooldown'); continue }
      // ST 的延迟门控（world-info.js:4860-4868）：非递归 pass 一律抑制（sticky 例外，
      // constant 也不例外）；递归 pass 中层级未到同样抑制。比较用条目原始值。
      const delayUntil = st.delayUntilRecursion
      if (!sticky && delayUntil && (pass === 0 || delayUntil > delayLevel)) {
        note(config, 'excluded', 'delay-until-recursion', { delayUntilRecursion: delayUntil, level: delayLevel, pass })
        continue
      }
      // 递归 pass 的参与资格：excludeRecursion 对任何条目生效；其余条目仍要求自身声明
      // recursive（延迟条目由层级池驱动，ST 的门控不要求全局 recursive）。
      if (pass > 0 && (st.excludeRecursion === true || (!delayUntil && st.recursive !== true))) { note(config, 'excluded', 'recursion'); continue }
      let active = sticky || p.constant === true
      let activation = sticky ? 'sticky' : p.constant === true ? 'constant' : 'key-match'
      if (!active) {
        const material = scanOf(config, st)
        try {
          const match = matcherOf(config, material).scan(material.text)
          active = match.primary > 0
          const logic = p.selectiveLogic ?? 0
          const detail = { scanDepth: material.depth, primary: match.primary, secondary: match.secondary, secondaryKeys: material.secondaryKeys.length, logic }
          if (active && st.selective === true && material.secondaryKeys.length > 0) {
            active = logic === 1 ? match.secondary < material.secondaryKeys.length : logic === 2 ? match.secondary === 0
              : logic === 3 ? match.secondary === material.secondaryKeys.length : match.secondary > 0
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
    if (!candidates.length && !delayLevels.length) break
    const groups = new Map()
    for (const config of candidates) {
      const names = String(config.params.stWorldBook.group ?? '').split(',').map(name => name.trim()).filter(Boolean)
      if (!names.length) { selected.add(config); note(config, 'selected', 'ungrouped'); continue }
      if (names.some(name => occupied.has(name))) { note(config, 'rejected', 'group-occupied'); failed.add(config); continue }
      for (const name of names) { const members = groups.get(name) ?? []; members.push(config); groups.set(name, members) }
    }
    for (const [name, members] of groups) {
      if (occupied.has(name)) continue
      let remaining = members.filter(config => !failed.has(config) && !String(config.params.stWorldBook.group).split(',').some(group => occupied.has(group.trim())))
      if (!remaining.length) continue
      const sticky = remaining.filter(config => stickyEntries.has(config))
      // 组内评分（ST filterGroupsByScoring 5292-5328）：无全局开关时，只要组内存在显式
      // 开启 useGroupScoring 的条目就整组参与评分；组内有 sticky 时整组跳过（5300-5305）。
      // 只有开启评分的条目会被淘汰（严格小于最高分）；未开启者不被淘汰，但其分数计入最高分。
      if (!sticky.length && remaining.some(config => config.params.stWorldBook.useGroupScoring === true)) {
        let scores
        try {
          scores = remaining.map(config => scoreOf(config, config.params.stWorldBook))
        } catch (error) {
          scores = undefined
          warn(`prompt-config-engine: 世界书分组评分失败：${String(error?.message ?? error)}`)
        }
        if (scores !== undefined) {
          const maxScore = Math.max(...scores)
          const survivors = []
          for (const [index, config] of remaining.entries()) {
            if (config.params.stWorldBook.useGroupScoring !== true || scores[index] >= maxScore) { survivors.push(config); continue }
            note(config, 'rejected', 'group-score-lost', { group: name, score: scores[index], maxScore })
            failed.add(config)
          }
          remaining = survivors
          if (!remaining.length) continue
        }
      }
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
    if (!added.length && !delayLevels.length) break
    for (const config of added) {
      const previous = state.get(config)
      // sticky 期间的重发不延长有效期；新命中才开始下一段窗口。
      if (previous.last === undefined || chat.length >= previous.last + count(config.params.stWorldBook.sticky)) updates.set(config, { ...previous, last: chat.length })
    }
    // 递归驱动优先于延迟层级（ST world-info.js:5097-5133）：有新正文可递归时层级保持不变；
    // 没有新正文而层级池仍有剩余时打开下一层继续扫描；两者都没有才结束。
    const recursiveAdds = hasRecursive ? added.filter(config => config.params.stWorldBook.preventRecursion !== true) : []
    if (recursiveAdds.length) recursiveText.push(...recursiveAdds.map(config => config.texts.join('\n')))
    else if (delayLevels.length) delayLevel = delayLevels.shift()
    else break
  }
  return finish(selected)
}
