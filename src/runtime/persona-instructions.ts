/** 人设预算只补缺失的官方指令 owner；现存官方实例保留其配置与生命周期。 */
import type { Context, Events, Fiber, Plugin } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { scopeChainOf, scopeOf } from '@deepseek-ai/dsh-scope'
import { importHostCapability } from '../../engine/host-package.mjs'
import { createModuleInitialization } from './module-initialization.ts'

export function createPersonaInstructions(ctx: Context, warn: (message: string) => void, initialization = createModuleInitialization(ctx)) {
  let plugin: Plugin | undefined
  let loading: Promise<void> | undefined
  let active = true
  const owned = new Map<Agent, Fiber>()
  const budgets = new WeakMap<Fiber, number>()
  type Candidate = { fiber: Fiber; ready: boolean; live: boolean; off(): void; rollback(): Promise<void> }
  const pending = new Map<Agent, Candidate>()
  const released = new WeakSet<Agent>()
  const observations = new WeakMap<Agent, string>()
  const report = (agent: Agent, value: string): void => {
    if (observations.get(agent) === value) return
    observations.set(agent, value); warn(`官方指令（${agent.id}）：${value}`)
  }
  const load = async (): Promise<void> => {
    if (plugin !== undefined) return
    loading ??= Promise.resolve().then(async () => {
      const loader = ctx.get('loader')
      const value = await importHostCapability('@deepseek-ai/dsh-agent-instructions')
      const candidate = loader === undefined ? value : loader.unwrapExports(value)
      if (!ctx.registry.resolve(candidate)) throw new Error('官方 agent-instructions 导出无有效入口')
      plugin = candidate
    }).catch(error => { loading = undefined; throw error })
    await loading
  }
  const original = (agent: Agent): Fiber[] => {
    const chain = scopeChainOf(scopeOf(agent.ctx))
    return [...(plugin === undefined ? [] : ctx.registry.get(plugin)?.fibers ?? [])].filter(fiber =>
      fiber.uid !== null && fiber.state === 2 && (scopeOf(fiber.ctx) === undefined || chain.includes(scopeOf(fiber.ctx)!)))
  }
  const release = async (agent: Agent): Promise<void> => {
    await pending.get(agent)?.rollback()
    const fiber = owned.get(agent)
    owned.delete(agent)
    await fiber?.dispose()
  }
  const transaction = (agent: Agent, candidate: Candidate, current: Fiber | undefined) => ({
    ready: candidate.live && candidate.ready && candidate.fiber.state === 2, rollback: candidate.rollback,
    async commit(): Promise<void> {
      if (!active || released.has(agent) || !candidate.live || !candidate.ready || candidate.fiber.state !== 2) return
      candidate.off(); pending.delete(agent); owned.set(agent, candidate.fiber)
      await current?.dispose()
    },
  })
  return {
    async prepare(agent: Agent, maxBytes: number | undefined): Promise<{ ready?: boolean; commit(): Promise<void>; rollback(): Promise<void> } | undefined> {
      if (!active || released.has(agent)) return
      if (maxBytes === undefined) return { commit: () => release(agent), rollback: async () => {} }
      await load()
      if (!active || released.has(agent)) return
      const existing = original(agent)
      if (existing.length > 0) { report(agent, `沿用 ${existing.length} 个现有 owner，预算 ${existing.map(fiber => String(fiber.config.maxBytes)).join('、')} 字节；不覆盖用户配置`); return { commit: () => release(agent), rollback: async () => {} } }
      const current = owned.get(agent)
      if (current !== undefined && current.uid !== null && budgets.get(current) === maxBytes) {
        if (['agents', 'workingDirectory', 'fs'].every(name => agent.ctx.get(name) !== undefined)) await current.await()
        return { ready: current.state === 2, commit: async () => {}, rollback: async () => {} }
      }
      let candidate = pending.get(agent)
      if (candidate !== undefined && budgets.get(candidate.fiber) !== maxBytes) { await candidate.rollback(); candidate = undefined }
      if (candidate !== undefined) {
        await candidate.fiber.await()
        await initialization.settled([candidate.fiber])
        return transaction(agent, candidate, current)
      }
      const official = plugin!
      const callback = ctx.registry.resolve(official)!
      const fiber = agent.ctx.inject(['agents', 'workingDirectory', 'fs'], inner => {
        // 晚到原 owner 从下一事件优先；不复制官方正文发现、预算或会话账本。
        const guarded = new Proxy(inner, { get(target, key, receiver) {
          if (key !== 'on') return Reflect.get(target, key, receiver)
          return (name: string, handler: (...args: any[]) => unknown, options?: unknown) => target.on(name as keyof Events, (...args: any[]) => {
            const subject = name === 'session/event' ? args[0] === agent.session : args[0]?.agent === agent
            if (active && !released.has(agent) && subject && owned.get(agent) === fiber && original(agent).length === 0) return handler(...args)
            return typeof args.at(-1) === 'function' ? args.at(-1)() : undefined
          }, options as never)
        } })
        return Reflect.apply(callback, undefined, [guarded, { maxBytes }])
      })
      budgets.set(fiber, maxBytes)
      const next: Candidate = { fiber, ready: false, live: true, off: () => {}, rollback: async () => {
        next.live = false; next.off()
        if (pending.get(agent) === next) pending.delete(agent)
        if (owned.get(agent) === fiber) { if (current?.uid !== null && current !== undefined) owned.set(agent, current); else owned.delete(agent) }
        await fiber.dispose()
      } }
      pending.set(agent, next)
      next.off = initialization.observe(fiber, { ready: () => { if (next.live) next.ready = true }, failed: error => {
        if (!next.live) return
        void next.rollback().then(() => report(agent, `装配失败，保留上次有效 owner：${String(error)}`))
      } })
      try {
        if (['agents', 'workingDirectory', 'fs'].some(name => agent.ctx.get(name) === undefined)) {
          report(agent, '等待 agents、workingDirectory 与 fs 服务；尚未验证投递')
        } else await fiber
        await initialization.settled([fiber])
        if (!active || released.has(agent)) await next.rollback()
        else return transaction(agent, next, current)
      } catch (error) {
        await next.rollback()
        throw error
      }
    },
    async release(agent: Agent): Promise<void> { released.add(agent); await release(agent) },
    async dispose(): Promise<void> { active = false; await Promise.all([...new Set([...owned.keys(), ...pending.keys()])].map(release)) },
  }
}
