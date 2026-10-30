/** 同模块共享一个维护owner；成员拥有授权，最后释放使异步工作失效。 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { pluginMessage } from '../../engine/layers.mjs'
import { readSoulSelfSnapshot, refreshSoulSelf } from '../host/soul-self.ts'
import type { SoulIndexStatus } from '../host/soul-self.ts'

export interface SoulMaintenanceConfig { enabled: boolean; intervalMs: number; wake: boolean; audience: 'all' | 'main' | 'subagent'; budgetBytes: number; pressureThresholds?: readonly number[] }
interface Mount { agent: Agent; sourceModuleId: string; sourceModuleDir: string }
type Member = Mount & { config: SoulMaintenanceConfig }
interface State { members: Set<Member>; state: string; error?: string; timer?: ReturnType<typeof setTimeout>; running?: Promise<void>; controller?: AbortController; owner?: Member }

async function waitForIdle(agent: Agent, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  let aborted!: () => void
  try {
    await Promise.race([agent.whenIdle(), new Promise<never>((_resolve, reject) => {
      aborted = () => reject(signal.reason)
      signal.addEventListener('abort', aborted, { once: true })
      if (signal.aborted) aborted()
    })])
  } finally { signal.removeEventListener('abort', aborted) }
}

export function createSoulMaintenanceProvider(options: { refreshRetrieval: (agent: Agent, moduleId: string, signal: AbortSignal) => Promise<SoulIndexStatus> }) {
  const states = new Map<string, State>()
  const status = (id: string): { state: string; error?: string } => {
    const state = states.get(id)
    return state ? { state: state.state, ...(state.error ? { error: state.error } : {}) } : { state: 'disabled' }
  }
  const tick = (id: string): Promise<void> => {
    const state = states.get(id)
    if (!state || !state.members.size) return Promise.resolve()
    if (state.running) return state.running
    if (state.timer) clearTimeout(state.timer)
    const owner = [...state.members].at(-1)!
    const controller = new AbortController()
    let signal = controller.signal
    state.controller = controller; state.owner = owner; state.state = 'running'; delete state.error
    const valid = (): boolean => !signal.aborted && states.get(id) === state && state.members.has(owner)
    state.running = Promise.resolve().then(async () => {
      try {
        if (!valid()) return
        state.state = 'waiting'
        await waitForIdle(owner.agent, signal)
        if (!valid()) return
        let entered = false
        try { await owner.agent.runMaintenance(async activitySignal => {
          entered = true
          state.state = 'running'
          signal = AbortSignal.any([controller.signal, activitySignal])
          signal.throwIfAborted()
          const revision = readSoulSelfSnapshot(owner.sourceModuleDir).revision
          const index = await options.refreshRetrieval(owner.agent, id, signal)
          if (!valid()) return
          refreshSoulSelf(owner.sourceModuleDir, index, { expectedRevision: revision, signal, budgetBytes: owner.config.budgetBytes })
        }) } catch (error) {
          // 宿主在回调进入前同步拒绝占用竞争；按间隔重试，不忙等。
          if (!entered && valid()) { state.state = 'waiting'; return }
          throw error
        }
        if (!valid()) return
        state.state = 'ready'
        if (owner.config.wake) owner.agent.followup(pluginMessage('soul-maintenance', '书房索引与 SELF 已维护。请核对当前未结事项；无需重复写入已有事实。', '书房维护心跳'))
      } catch (error) {
        if (valid()) { state.state = 'failed'; state.error = error instanceof Error ? error.message : String(error) }
      } finally {
        state.running = undefined
        state.owner = undefined
        if (state.state === 'running') state.state = signal.aborted ? 'cancelled' : 'idle'
        if (states.get(id) === state && state.members.size) {
          const current = [...state.members].at(-1)!
          if (current !== owner && controller.signal.aborted) void tick(id)
          else {
            state.timer = setTimeout(() => { void tick(id) }, current.config.intervalMs)
            state.timer.unref()
          }
        }
      }
    })
    return state.running
  }
  const mount = (_ctx: Context, config: SoulMaintenanceConfig, source: Mount): (() => void) => {
    const audience = (source.agent.session.header.delegationDepth ?? 0) > 0 ? 'subagent' : 'main'
    if (!config.enabled || config.audience !== 'all' && config.audience !== audience) return () => {}
    if (!Number.isSafeInteger(config.intervalMs) || config.intervalMs < 1000 || config.intervalMs > 2147483647) throw new Error('心跳间隔必须为 1000–2147483647ms')
    const id = source.sourceModuleId
    let state = states.get(id)
    if (!state) { state = { members: new Set(), state: 'idle' }; states.set(id, state) }
    if ([...state.members].some(member => member.sourceModuleDir !== source.sourceModuleDir)) throw new Error('心跳模块目录身份冲突')
    const member = { ...source, config }
    state.members.add(member)
    if (!state.running && !state.timer) void tick(id)
    return () => {
      state.members.delete(member)
      if (state.owner === member) state.controller?.abort()
      if (state.members.size) return
      state.controller?.abort()
      if (state.timer) clearTimeout(state.timer)
      if (states.get(id) === state) states.delete(id)
    }
  }
  return { mount, tick, status, dispose: (): void => {
    for (const state of states.values()) { state.controller?.abort(); if (state.timer) clearTimeout(state.timer); state.members.clear() }
    states.clear()
  } }
}
