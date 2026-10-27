import { bool, defineConfig, enumOf, int, passthrough } from './fields.mjs'
import { capabilityAudience } from './agent-capability.mjs'
import { recoveryCoordinator } from './generation-recovery-coordinator.mjs'
import { pluginMessage } from './layers.mjs'
import { recoveryMaintenance } from './generation-recovery-maintenance.mjs'

export const name = 'generation-recovery'
export const inject = ['llm']

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

export function apply(ctx, raw, options = {}) {
  const { agent } = options
  const config = configContract.parse(raw, name)
  if (!config.enabled || typeof agent?.session?.id !== 'string') return
  if (config.audience !== 'all' && config.audience !== capabilityAudience(agent)) return
  let active = true
  const report = message => ctx.logger?.warn?.(`${name}: ${message}`)
  const limit = capabilityAudience(agent) === 'subagent' ? config.subagentRecoveryLimit : config.mainRecoveryLimit
  const coordinator = recoveryCoordinator(ctx, agent, config, { ...options, recover(candidate) {
    if (!limit) return
    if (!options.recoveryState) { report('persistent recovery state unavailable; automatic recovery disabled'); return }
    try {
      const claimed = options.recoveryState.claim(agent.session.id, candidate.execution, limit)
      if (!claimed.claimed) { report(`recovery unavailable (${claimed.used}/${limit})`); return }
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
        } catch (error) { report(String(error?.message ?? error)) }
      })()
    } catch (error) { report(String(error?.message ?? error)) }
  } }, () => active)
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
      let visibleText = false
      let reasoningChars = 0
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
        if (kind === 'text' && chunk.text.trim()) visibleText = true
        let cutoff = safe ? detectors[kind](chunk.text) : undefined
        let cause = 'repeated-' + kind
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
    })()
  })
  return () => { stop(); off(); coordinator.dispose() }
}
