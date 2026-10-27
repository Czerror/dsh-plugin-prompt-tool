import { bool, defineConfig, enumOf, int, passthrough } from './fields.mjs'
import { capabilityAudience } from './agent-capability.mjs'

export const name = 'generation-recovery'
export const inject = ['llm']

export const configContract = defineConfig({
  enabled: bool({ default: false }),
  audience: enumOf(['all', 'main', 'subagent'], { default: 'all' }),
  textRepeatChars: int({ min: 3, default: 4096 }),
  reasoningRepeatChars: int({ min: 3, default: 8192 }),
  maxCycleChars: passthrough((value, plugin, field) => {
    if (value === undefined) return 256
    if (!Number.isSafeInteger(value) || value < 1 || value > 1024) throw new TypeError(`${plugin}: ${field} must be an integer from 1 to 1024`)
    return value
  }),
})

// 逐 Unicode 字符比较周期，内存只随最长周期增长，不保留整段推理。
function repeatDetector(threshold, maxCycle) {
  const tail = new Array(maxCycle)
  const matches = new Float64Array(maxCycle + 1)
  let seen = 0
  return text => {
    let offset = 0
    for (const char of text) {
      offset += char.length
      let repeated = false
      for (let period = 1; period <= Math.min(seen, maxCycle); period++) {
        const needed = Math.max(threshold - period, 2 * period)
        matches[period] = tail[(seen - period) % maxCycle] === char ? Math.min(matches[period] + 1, needed) : 0
        if (matches[period] >= needed) repeated = true
      }
      tail[seen % maxCycle] = char
      seen++
      if (repeated) return offset
    }
    return undefined
  }
}

export function apply(ctx, raw, { agent } = {}) {
  const config = configContract.parse(raw, name)
  if (!config.enabled || typeof agent?.session?.id !== 'string') return
  if (config.audience !== 'all' && config.audience !== capabilityAudience(agent)) return
  let active = true
  const stop = ctx.effect(() => () => { active = false })
  const off = ctx.on('llm/stream', (options, next) => {
    if (!active || options.signal?.aborted || options.purpose !== undefined || options.sessionId !== agent.session.id) return next()
    return (async function* () {
      const detectors = {
        text: repeatDetector(config.textRepeatChars, config.maxCycleChars),
        reasoning: repeatDetector(config.reasoningRepeatChars, config.maxCycleChars),
      }
      const open = new Map()
      const closed = new Set()
      const finalized = new Set()
      let hasToolCall = false
      for await (const chunk of next()) {
        if (finalized.has(chunk.index)) continue
        if (!active || options.signal?.aborted) { yield chunk; continue }
        if (chunk.type === 'tool-call-delta' || chunk.blockType === 'tool-call' || chunk.block?.type === 'tool-call') hasToolCall = true
        if (chunk.type === 'block-start') open.set(chunk.index, { type: chunk.blockType, text: '' })
        if (chunk.type === 'block-end') { open.delete(chunk.index); closed.add(chunk.index) }
        const kind = chunk.type === 'text-delta' ? 'text' : chunk.type === 'reasoning-delta' ? 'reasoning' : undefined
        if (kind === undefined || closed.has(chunk.index)) { yield chunk; continue }
        if (!open.has(chunk.index)) open.set(chunk.index, { type: kind, text: '' })
        // 已闭合工具也要保留原始finish语义，不把工具回合伪装成普通stop。
        const safe = !hasToolCall && [...open.values()].every(block => block.type === 'text' || block.type === 'reasoning')
        const cutoff = safe ? detectors[kind](chunk.text) : undefined
        const text = cutoff === undefined ? chunk.text : chunk.text.slice(0, cutoff)
        const block = open.get(chunk.index)
        if (block !== undefined) block.text += text
        yield cutoff === undefined ? chunk : { ...chunk, text }
        if (cutoff === undefined) continue
        if (!active || options.signal?.aborted) {
          const remainder = chunk.text.slice(cutoff)
          if (remainder) yield { ...chunk, text: remainder }
          continue
        }
        for (const [index, value] of open) {
          if (!active || options.signal?.aborted) break
          finalized.add(index)
          yield { type: 'block-end', index, block: value }
        }
        if (!active || options.signal?.aborted) {
          const remainder = chunk.text.slice(cutoff)
          if (!finalized.has(chunk.index) && remainder) yield { ...chunk, text: remainder }
          continue
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
    })()
  })
  return () => { stop(); off() }
}
