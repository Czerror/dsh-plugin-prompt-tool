import { createHash } from 'node:crypto'
import { bool, defineConfig, enumOf, int, passthrough } from './fields.mjs'
import { capabilityAudience } from './agent-capability.mjs'
import { recoveryCoordinator } from './generation-recovery-coordinator.mjs'
import { pluginMessage } from './layers.mjs'
import { recoveryMaintenance } from './generation-recovery-maintenance.mjs'

export const name = 'generation-recovery'
export const inject = ['llm']
const observations = new WeakMap()
export const recoveryObservationOf = agent => observations.get(agent)

const recoveryLimit = passthrough((value, plugin, field) => {
  if (value === undefined) return 0
  if (!Number.isSafeInteger(value) || value < 0 || value > 1000) throw new TypeError(`${plugin}: ${field} must be an integer from 0 to 1000`)
  return value
})

export const configContract = defineConfig({
  enabled: bool({ default: false }),
  audience: enumOf(['all', 'main', 'subagent'], { default: 'all' }),
  textRepeatChars: int({ min: 3, default: 4096 }),
  reasoningRepeatChars: int({ min: 3, default: 8192 }),
  silentReasoningChars: int({ min: 0, default: 0 }),
  lineRepeatChars: int({ min: 0, default: 0 }),
  crossCallRepeatChars: int({ min: 0, default: 0 }),
  recoverEmpty: bool({ default: false }),
  mainRecoveryLimit: recoveryLimit,
  subagentRecoveryLimit: recoveryLimit,
  maintenanceCompression: bool({ default: false }),
  allowFullFallback: bool({ default: false }),
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

// 只保存行摘要；窗口与单行都有上限，引用与代码围栏不计入材料判据。
function materialDetector(config, previous) {
  const counts = new Map()
  let line = '', fenced = false, overflow = false, chars = 0, lines = 0, repeated = 0, dominant = 0
  const overlap = [0, 0]
  return {
    push(text) {
      let offset = 0
      for (const char of text) {
        offset += char.length
        if (char !== '\n') { if (line.length < 1024) line += char; else overflow = true; continue }
        const value = line.trim(); line = ''
        if (value.startsWith('```') || value.startsWith('~~~')) { fenced = !fenced; overflow = false; continue }
        if (overflow || fenced || value.startsWith('>') || value.length < 12 || lines >= 128) { overflow = false; continue }
        const key = createHash('sha256').update(value).digest('hex')
        const count = (counts.get(key) ?? 0) + 1
        counts.set(key, count); lines++; chars += value.length
        if (count > 1) repeated += value.length
        dominant = Math.max(dominant, count)
        previous.forEach((sample, index) => { if (sample.has(key)) overlap[index] += value.length })
        if (config.lineRepeatChars > 0 && chars >= config.lineRepeatChars && lines >= 6 && repeated / chars >= 0.8 && dominant / lines >= 0.5) return { offset, cause: 'repeated-lines' }
        if (config.crossCallRepeatChars > 0 && chars >= config.crossCallRepeatChars && lines >= 6 && previous.length === 2 && overlap.every(value => value / chars >= 0.9)) return { offset, cause: 'repeated-material' }
      }
    },
    sample: () => lines >= 6 && chars >= config.crossCallRepeatChars ? new Set(counts.keys()) : undefined,
  }
}

export function apply(ctx, raw, options = {}) {
  const { agent } = options
  const config = configContract.parse(raw, name)
  if (!config.enabled || typeof agent?.session?.id !== 'string') return
  if (config.audience !== 'all' && config.audience !== capabilityAudience(agent)) return
  let active = true
  const samples = { text: [], reasoning: [] }
  const clearSamples = () => { samples.text.length = 0; samples.reasoning.length = 0 }
  const observe = state => observations.set(agent, { state, observedAt: new Date().toISOString() })
  const report = message => { observe('reported'); ctx.logger?.warn?.(`${name}: ${message}`) }
  const limit = capabilityAudience(agent) === 'subagent' ? config.subagentRecoveryLimit : config.mainRecoveryLimit
  const coordinator = recoveryCoordinator(ctx, agent, config, { ...options, recover(candidate) {
    observe('candidate')
    if (!limit) return
    if (!options.recoveryState) { report('persistent recovery state unavailable; automatic recovery disabled'); return }
    try {
      const claimed = options.recoveryState.claim(agent.session.id, candidate.execution, limit)
      if (!claimed.claimed) { report(`recovery unavailable (${claimed.used}/${limit})`); return }
      observe('claimed')
      void (async () => {
        try {
          await agent.whenIdle()
          const valid = () => active && !candidate.signal?.aborted && coordinator.unchanged(candidate)
          if (!valid()) return
          let maintenance
          if (config.maintenanceCompression) {
            maintenance = await recoveryMaintenance(options.contextRuntimeOf?.(agent), candidate.signal, config.allowFullFallback, valid, report)
            if (!maintenance) return
          }
          if (!valid()) return
          const text = '上一轮输出因异常重复或仅有推理而未完成。请停止重复，检查已完成的工作，并给出有效结果或明确说明阻塞原因。'
            + (maintenance ? `\n维护压缩已完成，实际来源事件：${maintenance.shadowedSeqs.join(',')}。` : '')
          agent.followup(pluginMessage('generation-recovery', text, '恢复异常生成'))
          observe('enqueued')
        } catch (error) { report(String(error?.message ?? error)) }
      })()
    } catch (error) { report(String(error?.message ?? error)) }
  } }, () => active)
  const stop = ctx.effect(() => () => { active = false; clearSamples() })
  const off = ctx.on('llm/stream', (options, next) => {
    if (options.sessionId === agent.session.id && options.signal?.aborted) clearSamples()
    if (!active || options.signal?.aborted || options.purpose !== undefined || options.sessionId !== agent.session.id) return next()
    return (async function* () {
      const detectors = {
        text: repeatDetector(config.textRepeatChars, config.maxCycleChars),
        reasoning: repeatDetector(config.reasoningRepeatChars, config.maxCycleChars),
      }
      const materials = { text: materialDetector(config, samples.text), reasoning: materialDetector(config, samples.reasoning) }
      const open = new Map()
      const closed = new Set()
      const finalized = new Set()
      let hasToolCall = false
      let visibleText = false
      let reasoningChars = 0
      for await (const chunk of next()) {
        if (finalized.has(chunk.index)) continue
        if (!active || options.signal?.aborted) { clearSamples(); yield chunk; continue }
        if (chunk.type === 'tool-call-delta' || chunk.blockType === 'tool-call' || chunk.block?.type === 'tool-call') hasToolCall = true
        if (chunk.type === 'block-start') open.set(chunk.index, { type: chunk.blockType, text: '' })
        if (chunk.type === 'block-end') { open.delete(chunk.index); closed.add(chunk.index) }
        const kind = chunk.type === 'text-delta' ? 'text' : chunk.type === 'reasoning-delta' ? 'reasoning' : undefined
        if (kind === undefined || closed.has(chunk.index)) { yield chunk; continue }
        if (!open.has(chunk.index)) open.set(chunk.index, { type: kind, text: '' })
        // 已闭合工具也要保留原始finish语义，不把工具回合伪装成普通stop。
        const safe = !hasToolCall && [...open.values()].every(block => block.type === 'text' || block.type === 'reasoning')
        if (kind === 'text' && chunk.text.trim()) visibleText = true
        let cutoff = safe ? detectors[kind](chunk.text) : undefined
        let cause = 'repeated-' + kind
        const material = safe ? materials[kind].push(chunk.text) : undefined
        if (material && (cutoff === undefined || material.offset < cutoff)) { cutoff = material.offset; cause = material.cause }
        if (safe && kind === 'reasoning' && !visibleText && config.silentReasoningChars > 0) {
          const chars = [...chunk.text]
          const remaining = config.silentReasoningChars - reasoningChars
          reasoningChars += chars.length
          if (remaining > 0 && remaining <= chars.length) {
            const silentCutoff = chars.slice(0, remaining).join('').length
            if (cutoff === undefined || silentCutoff < cutoff) { cutoff = silentCutoff; cause = 'silent-reasoning' }
          }
        }
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
        coordinator.mark(cause)
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      if (active && !options.signal?.aborted && !hasToolCall && config.crossCallRepeatChars > 0) {
        for (const kind of ['text', 'reasoning']) {
          const sample = materials[kind].sample()
          if (sample) { samples[kind].push(sample); if (samples[kind].length > 2) samples[kind].shift() }
        }
      }
    })()
  })
  return () => { stop(); off(); coordinator.dispose(); observations.delete(agent) }
}
