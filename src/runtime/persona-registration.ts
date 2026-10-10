import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Agent, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import SystemPrompt, { PERSONA_PREFIX_SECTION, PERSONA_SUFFIX_SECTION } from '@deepseek-ai/dsh-system-prompt'
import type { AssembleContext, PromptSection } from '@deepseek-ai/dsh-system-prompt'
import { scopeChainOf, scopeOf, type ScopeKey } from '@deepseek-ai/dsh-scope'
import { readPersonaSpec, type PersonaSpec, type PersonaTargetSpec } from '../shared/persona-section.ts'
import { renderTemplate, type TemplateVariableStore } from '../../engine/template-frame.mjs'

export const PERSONA_REGISTRATION_SERVICE = 'promptToolPersona'
type Audience = 'main' | 'subagent'
type Field = keyof PersonaTargetSpec
type Off = () => void
export interface PersonaModule {
  moduleId: string
  persona?: PersonaSpec
  variablesEnabled?: boolean
}
export interface PersonaPolicySource {
  modules(): readonly PersonaModule[]
  variableStore?: TemplateVariableStore
  warn?: (message: string) => void
}
interface TargetPolicy {
  spec: PersonaTargetSpec
  owners: Partial<Record<Field, PersonaModule>>
}
interface Policies { main: TargetPolicy; subagent: TargetPolicy }
export interface PersonaRegistration {
  /** 主插件提供已授权模块的唯一快照来源；释放时撤回覆盖，官方服务继续运行。 */
  configure(source: PersonaPolicySource): Off
  /** 验证完整候选后刷新既有 Agent；失败保留该 Agent 的上次有效人设。 */
  refresh(): void
  /** 验证整批 Agent 的有效声明；提交与回滚只使用这次捕获的策略，不重读磁盘。 */
  prepare(targets: readonly PersonaAssemblyTarget[], modules?: readonly PersonaModule[]): PersonaPreparation
}
export interface PersonaAssemblyTarget {
  agent: Agent
  /** 本插件全部候选规则中的独占段来源，用于与官方继承人设合并校验。 */
  completeSections: readonly string[]
}
export interface PersonaPreparation { commit(): void; rollback(): void }
declare module '@deepseek-ai/cordis' {
  interface Context { promptToolPersona: PersonaRegistration }
}

function policiesOf(modules: readonly PersonaModule[]): Policies {
  const policies: Policies = { main: { spec: {}, owners: {} }, subagent: { spec: {}, owners: {} } }
  for (const module of modules) {
    const persona = readPersonaSpec(module.persona)
    for (const audience of ['main', 'subagent'] as const) {
      const target = persona?.[audience]
      if (target === undefined) continue
      for (const field of Object.keys(target) as Field[]) {
        const previous = policies[audience].owners[field]
        if (previous !== undefined) throw new Error(`人设字段 persona.${audience}.${field} 冲突：模块 ${previous.moduleId}、${module.moduleId}`)
        Object.assign(policies[audience].spec, { [field]: target[field] })
        policies[audience].owners[field] = module
      }
    }
  }
  return policies
}
interface OriginalSection {
  scope: ScopeKey | undefined
  original: PromptSection
  active: boolean
  core?: Fiber
  swap?: (section: PromptSection) => void
}
interface AgentState {
  agent: Agent
  scope: ScopeKey
  audience: Audience
  policy: TargetPolicy
  source: PersonaPolicySource | undefined
  shadows: Off[]
}
const SECTION_NAMES = [PERSONA_PREFIX_SECTION, PERSONA_SUFFIX_SECTION] as const
const emptyPolicy = (): TargetPolicy => ({ spec: {}, owners: {} })

/** 无宿主服务依赖的早入口；只通过公开生命周期、官方声明与真实 AgentSetup 接入。 */
export function installPersonaRegistration(ctx: Context): PersonaRegistration {
  const originals = new Set<OriginalSection>()
  const agents = new Map<ScopeKey, AgentState>()
  let source: PersonaPolicySource | undefined
  let active = true

  const effective = (original: PromptSection, state: AgentState): PromptSection => {
    const field = original.name === PERSONA_PREFIX_SECTION ? 'prefix' : 'suffix'
    const text = state.policy.spec[field]
    const complete = field === 'prefix' ? state.policy.spec.complete : undefined
    if (text === undefined && complete === undefined) return original
    const owner = state.policy.owners[field]
    return {
      ...original,
      ...(complete === undefined ? {} : { complete }),
      ...(text === undefined ? {} : {
        text: (context: AssembleContext) => renderTemplate({
          sourceModuleId: owner!.moduleId, ruleId: 'persona', id: `persona-${state.audience}-${field}`, texts: [text],
        }, context, { variableStore: state.source?.variableStore, enabled: owner!.variablesEnabled !== false, warn: state.source?.warn }),
      }),
    }
  }
  const inherited = (scope: ScopeKey, name: string): PromptSection => {
    for (const parent of [...scopeChainOf(scope).slice(1), undefined]) {
      const record = [...originals].find(item => item.active && item.scope === parent && item.original.name === name)
      if (record !== undefined) return record.original
    }
    throw new Error(`人设原声明未被观察：${name}；请重新配装 owner 或重启 DSH`)
  }
  const validate = (state: AgentState, policy: TargetPolicy, completeSections: readonly string[]): void => {
    const own = [...originals].filter(item => item.active && item.scope === state.scope)
    for (const name of SECTION_NAMES) {
      const field = name === PERSONA_PREFIX_SECTION ? 'prefix' : 'suffix'
      if (policy.spec[field] !== undefined || field === 'prefix' && policy.spec.complete !== undefined) {
        if (!own.some(item => item.original.name === name)) inherited(state.scope, name)
      }
    }
    if (completeSections.length === 0) return
    const prefix = own.find(item => item.original.name === PERSONA_PREFIX_SECTION)?.original
      ?? inherited(state.scope, PERSONA_PREFIX_SECTION)
    if ((policy.spec.complete ?? prefix.complete) === true) {
      throw new Error(`Agent ${state.agent.id} 有多个生效 complete 段：官方人设与 ${completeSections.join('、')}；请显式关闭该受众的人设 complete`)
    }
  }
  const applyState = (state: AgentState): void => {
    const own = [...originals].filter(item => item.active && item.scope === state.scope)
    const shadows = SECTION_NAMES.flatMap(name => {
      const field = name === PERSONA_PREFIX_SECTION ? 'prefix' : 'suffix'
      if (own.some(item => item.original.name === name)) return []
      if (state.policy.spec[field] === undefined && !(field === 'prefix' && state.policy.spec.complete !== undefined)) return []
      return [effective(inherited(state.scope, name), state)]
    })
    for (const off of state.shadows.splice(0)) off()
    for (const record of own) record.swap?.(effective(record.original, state))
    const prompt = state.agent.ctx.get('systemPrompt')
    if (prompt === undefined) throw new Error('人设配装需要 systemPrompt 服务')
    try {
      for (const section of shadows) state.shadows.push(prompt.section(section))
      if (state.policy.spec.includeRuntimeContext === false) state.shadows.push(prompt.suppressRuntimeContext())
    } catch (error) {
      for (const off of state.shadows.splice(0)) off()
      throw new Error('人设声明接入失败；存在未观察的同名注册，请重新配装 owner 或重启 DSH', { cause: error })
    }
  }
  const update = (state: AgentState, policy: TargetPolicy, policySource: PersonaPolicySource | undefined): void => {
    const previous = state.policy, previousSource = state.source
    state.policy = policy; state.source = policySource
    try { applyState(state) }
    catch (error) {
      state.policy = previous; state.source = previousSource
      try { applyState(state) }
      catch (restoreError) { throw new AggregateError([error, restoreError], '人设更新与恢复均失败') }
      throw error
    }
  }
  const prepare = (targets: readonly PersonaAssemblyTarget[], modules?: readonly PersonaModule[]): PersonaPreparation => {
    const policySource = source, candidate = policiesOf(modules ?? policySource?.modules() ?? [])
    const updates = targets.flatMap(({ agent, completeSections }) => {
      if (completeSections.length > 1) throw new Error(`Agent ${agent.id} 有多个生效 complete 段：${completeSections.join('、')}`)
      const audience = agent.session.header.origin === 'subagent' ? 'subagent' : 'main'
      const policy = candidate[audience], scope = scopeOf(agent.ctx), state = scope === undefined ? undefined : agents.get(scope)
      if (state === undefined) {
        if (Object.keys(policy.spec).length > 0 || completeSections.length > 0) {
          throw new Error(`Agent ${agent.id} 的人设创建路径未被观察；请重新创建会话或重启 DSH`)
        }
        return []
      }
      validate(state, policy, completeSections)
      return [{ state, policy, previous: state.policy, previousSource: state.source }]
    })
    const applied: typeof updates = []
    const rollback = (): void => {
      const errors: unknown[] = []
      for (const item of applied.splice(0).reverse()) {
        if (agents.get(item.state.scope) !== item.state) continue
        try { update(item.state, item.previous, item.previousSource) } catch (error) { errors.push(error) }
      }
      if (errors.length > 0) throw new AggregateError(errors, `人设恢复失败：${errors.map(String).join('；')}`)
    }
    return {
      commit() {
        try {
          for (const item of updates) {
            if (agents.get(item.state.scope) !== item.state) continue
            update(item.state, item.policy, policySource)
            applied.push(item)
          }
        } catch (error) {
          try { rollback() } catch (restoreError) { throw new AggregateError([error, restoreError], '人设提交与恢复均失败') }
          throw error
        }
      },
      rollback,
    }
  }
  const refresh = (): void => {
    const targets = new Set([...(ctx.get('agents')?.list() ?? []), ...[...agents.values()].map(state => state.agent)])
    prepare([...targets].map(agent => ({ agent, completeSections: [] }))).commit()
  }
  const runtime: PersonaRegistration = {
    configure(next) {
      if (source !== undefined) throw new Error('人设模块来源已注册')
      policiesOf(next.modules())
      source = next
      try { refresh() } catch (error) { source = undefined; throw error }
      let configured = true
      return () => {
        if (!configured) return
        configured = false
        source = undefined
        refresh()
      }
    },
    refresh, prepare,
  }
  ctx.provide(PERSONA_REGISTRATION_SERVICE, runtime)

  ctx.on('internal/status', fiber => {
    if (fiber.runtime?.callback !== SystemPrompt) return
    for (const record of originals) if (record.core === fiber) originals.delete(record)
    const prompt = fiber.ctx.get('systemPrompt')
    if (prompt === undefined) return
    // 官方构造器自己的 this.section 不经过属性钩子；只读取该准确实现的已验证 Config。
    for (const [name, field, order] of [
      [PERSONA_PREFIX_SECTION, 'personaPrefix', 'DEPLOYMENT_PERSONA_PREFIX'],
      [PERSONA_SUFFIX_SECTION, 'personaSuffix', 'DEPLOYMENT_PERSONA_SUFFIX'],
    ] as const) originals.add({ core: fiber, scope: undefined, active: true,
      original: { name, text: String(fiber.config[field] ?? ''), order: prompt.getSectionOrder(order) },
    })
  })
  ctx.on('internal/get', (caller, name, _error, next) => {
    const service = next()
    if (name === 'agents') return new Proxy(service, {
      get(target, property, receiver) {
        const method = Reflect.get(target, property, receiver)
        if (property !== 'create' && property !== 'resume') return method
        return (options: CreateAgentOptions | ResumeAgentOptions) => {
          if (!active) return Reflect.apply(method, target, [options])
          const setup = options.setup
          return Reflect.apply(method, target, [{ ...options, setup: async (agentCtx: Context, agent: Agent) => {
            const scope = scopeOf(agentCtx)
            if (scope === undefined) throw new Error('AgentSetup 缺少官方 scope')
            const audience: Audience = agent.session.header.origin === 'subagent' ? 'subagent' : 'main'
            const state: AgentState = { agent, scope, audience, policy: policiesOf(source?.modules() ?? [])[audience], source, shadows: [] }
            agents.set(scope, state)
            agentCtx.effect(() => () => {
              agents.delete(scope)
              for (const off of state.shadows.splice(0)) off()
            }, 'prompt-tool persona agent')
            const commit = await setup?.(agentCtx, agent)
            if (active && !options.signal?.aborted && agents.get(scope) === state) applyState(state)
            return commit
          } }])
        }
      },
    })
    if (name !== 'systemPrompt') return service
    return new Proxy(service, {
      get(target, property, receiver) {
        const method = Reflect.get(target, property, receiver)
        if (property !== 'section') return method
        return (original: PromptSection) => {
          if (!active || !SECTION_NAMES.includes(original.name as typeof SECTION_NAMES[number])) return Reflect.apply(method, target, [original])
          const scope = scopeOf(caller)
          const record: OriginalSection = { scope, original, active: true }
          const register = (section: PromptSection): Off => Reflect.apply(method, target, [section])
          let applied = scope === undefined || !agents.has(scope) ? original : effective(original, agents.get(scope)!)
          let off: Off
          const lease = caller.effect(() => {
            off = register(applied)
            originals.add(record)
            return () => { record.active = false; originals.delete(record); off() }
          }, 'prompt-tool persona declaration')
          record.swap = candidate => {
            if (candidate === applied) return
            off()
            try { off = register(candidate) }
            catch (error) { off = register(applied); throw error }
            applied = candidate
          }
          return lease
        }
      },
    })
  }, { global: true })
  ctx.on('agent/created', ({ agent }): undefined => {
    const scope = scopeOf(agent.ctx)
    if (scope !== undefined && agents.has(scope)) return
    const policies = policiesOf(source?.modules() ?? [])
    const audience = agent.session.header.origin === 'subagent' ? 'subagent' : 'main'
    if (Object.keys(policies[audience].spec).length > 0) {
      throw new Error('人设创建路径未被观察，请通过官方 agents.create/resume 重新创建或重启 DSH')
    }
    return undefined
  })
  ctx.effect(() => () => {
    active = false
    source = undefined
    for (const state of agents.values()) update(state, emptyPolicy(), undefined)
    for (const record of originals) if (record.active) record.swap?.(record.original)
  }, 'prompt-tool persona restoration')
  return runtime
}
