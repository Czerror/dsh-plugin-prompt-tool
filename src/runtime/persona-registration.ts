/**
 * AgentSetup 窗口内捕获同层官方人设。规则运行时暂撤后可原样恢复，
 * 原所有者显式撤销或释放后不再恢复；祖先声明由官方 scope 链自然继承。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import { PERSONA_PREFIX_SECTION, PERSONA_SUFFIX_SECTION } from '@deepseek-ai/dsh-system-prompt'
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'
import { scopeOf, type ScopeKey } from '@deepseek-ai/dsh-scope'

/** 本插件接管的人设槽位；只有这两个名字参与捕获与遮蔽。 */
const PERSONA_SECTION_NAMES = [PERSONA_PREFIX_SECTION, PERSONA_SUFFIX_SECTION] as const

/** 被接住的同层声明：`off` 撤销它，`section` 是被撤下的原对象。 */
export interface CapturedSection {
  name: string
  section: PromptSection
  off: () => void
  suspend(): (() => void) | undefined
}
export interface PersonaCapture {
  /** 该 scope 在 AgentSetup 窗口内注册的同名人设段，按注册顺序。 */
  records(scope: ScopeKey): readonly CapturedSection[]
  dispose(): void
}

/**
 * 只接住两个官方人设槽位，窗口是 `agents.create` / `agents.resume` 的 setup 回调。
 * 窗口之外（含本插件自己的装配注册）一律不捕获。
 */
export function installPersonaCapture(ctx: Context): PersonaCapture {
  // 弱引用：scope 释放后捕获记录随之回收，不随会话数增长。
  const records = new WeakMap<ScopeKey, CapturedSection[]>()
  const pending = new Set<ScopeKey>()
  let active = true
  const isPersonaSection = (name: string): boolean => (PERSONA_SECTION_NAMES as readonly string[]).includes(name)
  const stopPrompt = ctx.on('internal/get', (caller, name, _error, next) => {
    const service = next()
    const scope = scopeOf(caller)
    if (!active || name !== 'systemPrompt' || scope === undefined || !pending.has(scope)) return service
    return new Proxy(service, {
      get(target, property, receiver) {
        const method = Reflect.get(target, property, receiver)
        if (property !== 'section') return method
        return (section: PromptSection) => {
          if (!active || !isPersonaSection(section.name)) return Reflect.apply(method, target, [section])
          let registered = Reflect.apply(method, target, [section]) as (() => void) | undefined
          let live = true
          const off = caller.effect(() => () => {
            live = false; registered?.(); registered = undefined
            const list = records.get(scope)
            if (list !== undefined) records.set(scope, list.filter(item => item !== captured))
          }, 'prompt-tool captured persona owner')
          const captured: CapturedSection = { name: section.name, section, off, suspend: () => {
            if (!live || registered === undefined) return undefined
            registered(); registered = undefined
            let suspended = true
            return () => {
              if (!suspended || !live) return
              registered = Reflect.apply(method, target, [section]) as () => void
              suspended = false
            }
          } }
          const list = records.get(scope)
          if (list === undefined) records.set(scope, [captured])
          else list.push(captured)
          return off
        }
      },
    })
  }, { global: true })
  const stopAgents = ctx.on('internal/get', (_caller, name, _error, next) => {
    const service = next()
    if (!active || name !== 'agents') return service
    return new Proxy(service, {
      get(target, property, receiver) {
        const method = Reflect.get(target, property, receiver)
        if (property !== 'create' && property !== 'resume') return method
        return (options: CreateAgentOptions | ResumeAgentOptions) => Reflect.apply(method, target, [{
          ...options,
          setup: async (agentCtx: Context, agent: Agent) => {
            const scope = scopeOf(agentCtx)
            if (scope === undefined) return options.setup?.(agentCtx, agent)
            pending.add(scope)
            try { return await options.setup?.(agentCtx, agent) } finally { pending.delete(scope) }
          },
        }])
      },
    })
  }, { global: true })
  return {
    records: scope => records.get(scope) ?? [],
    dispose: () => { active = false; pending.clear(); stopPrompt(); stopAgents() },
  }
}
