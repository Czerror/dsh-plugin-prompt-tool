import type { Context, Fiber, Plugin } from '@deepseek-ai/cordis'
import { isDeepStrictEqual } from 'node:util'
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
type Release = () => void | Promise<void>
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
  configure(source: PersonaPolicySource): Promise<Release>
  /** 验证完整候选后刷新既有 Agent；失败保留该 Agent 的上次有效人设。 */
  refresh(): Promise<void>
  /** 验证整批 Agent 的有效声明；提交与回滚只使用这次捕获的策略，不重读磁盘。 */
  prepare(targets: readonly PersonaAssemblyTarget[], modules?: readonly PersonaModule[]): Promise<PersonaPreparation>
}
export interface PersonaAssemblyTarget {
  agent: Agent
  /** 本插件全部候选规则中的独占段来源，用于与官方继承人设合并校验。 */
  completeSections: readonly string[]
}
export interface PersonaPreparation { commit(): Promise<void>; rollback(): Promise<void>; release(): Promise<void> }
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
  owner: Fiber
  swap?: (section: PromptSection) => void
}
interface PersonaLoader {
  import(name: string): unknown | Promise<unknown>
  unwrapExports(value: unknown): Plugin
}
interface AgentState {
  agent: Agent
  scope: ScopeKey
  audience: Audience
  policy: TargetPolicy
  source: PersonaPolicySource | undefined
  shadows: Off[]
  official?: { fiber: Fiber; config: unknown }
  capturedOfficial?: boolean
}
const SECTION_NAMES = [PERSONA_PREFIX_SECTION, PERSONA_SUFFIX_SECTION] as const
const emptyPolicy = (): TargetPolicy => ({ spec: {}, owners: {} })

/** 主插件会话期适配；只管理目标 Agent 的声明，不改变官方服务启动依赖。 */
export function installPersonaRegistration(ctx: Context): PersonaRegistration {
  const originals = new Set<OriginalSection>()
  const agents = new Map<ScopeKey, AgentState>()
  let source: PersonaPolicySource | undefined
  let active = true
  let personaPlugin: Plugin | undefined
  let knowledge = Promise.resolve()
  let knowledgeError = ''
  let metadataLoader: PersonaLoader | undefined
  const reserved = new Set<ScopeKey>()
  const readKnowledge = (): Promise<void> => {
    const loader = ctx.get('loader') as PersonaLoader | undefined
    if (!loader || loader === metadataLoader) return knowledge
    metadataLoader = loader
    knowledge = Promise.resolve().then(() => loader.import('@deepseek-ai/dsh-persona')).then(namespace => {
      if (!active) return
      const plugin = loader.unwrapExports(namespace)
      if (!ctx.registry.resolve(plugin)) throw new Error('官方 Persona 导出无有效入口')
      personaPlugin = plugin
      knowledgeError = ''
    }).catch(error => {
      if (active) knowledgeError = String((error as Error).message ?? error)
    })
    return knowledge
  }

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
  const live = (fiber: Fiber): boolean => fiber.uid !== null && fiber.store !== undefined && fiber.inertia === undefined
  const officialAt = (scope: ScopeKey): Fiber | undefined => {
    const fibers = [...(personaPlugin ? ctx.registry.get(personaPlugin)?.fibers ?? [] : [])]
      .filter(fiber => live(fiber) && scopeOf(fiber.ctx) === scope)
    if (fibers.length > 1) throw new Error('同作用域存在多个官方人设实例，拒绝猜测所有者')
    return fibers[0]
  }
  const fromConfig = (fiber: Fiber, name: string, root = false): PromptSection => {
    const prefix = name === PERSONA_PREFIX_SECTION
    const field = root ? prefix ? 'personaPrefix' : 'personaSuffix' : prefix ? 'prefix' : 'suffix'
    const prompt = fiber.ctx.get('systemPrompt')
    if (!prompt) throw new Error('官方人设需要 systemPrompt 服务')
    return { name, text: String(fiber.config[field] ?? ''), order: prompt.getSectionOrder(prefix ? 'DEPLOYMENT_PERSONA_PREFIX' : 'DEPLOYMENT_PERSONA_SUFFIX'),
      ...(!root && prefix && fiber.config.complete === true ? { complete: true } : {}) }
  }
  const ownRecords = (state: AgentState): OriginalSection[] => [...originals].filter(record => record.active && record.scope === state.scope)
  const capture = (state: AgentState, owner?: Fiber): Off => {
    let capturing = true
    const remove = ctx.on('internal/get', (caller, name, _error, next) => {
      const service = next()
      if (name !== 'systemPrompt' || scopeOf(caller) !== state.scope || owner && caller.fiber !== owner) return service
      return new Proxy(service, {
        get(target, property, receiver) {
          const method = Reflect.get(target, property, receiver)
          if (property !== 'section') return method
          return (original: PromptSection) => {
            if (!active || !capturing || !SECTION_NAMES.includes(original.name as typeof SECTION_NAMES[number])) return Reflect.apply(method, target, [original])
            const record: OriginalSection = { scope: state.scope, original, active: true, owner: caller.fiber }
            const register = (section: PromptSection): Off => Reflect.apply(method, target, [section])
            let applied = original, off: Off
            const lease = caller.effect(() => {
              off = register(applied)
              originals.add(record)
              return () => { record.active = false; originals.delete(record); off() }
            }, 'prompt-tool persona declaration')
            record.swap = candidate => {
              if (!record.active) throw new Error('人设原声明已变化，请重新读取')
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
    return () => { capturing = false; remove() }
  }
  const inherited = (scope: ScopeKey, name: string): PromptSection => {
    for (const parent of [...scopeChainOf(scope).slice(1), undefined]) {
      const record = [...originals].find(item => item.active && item.scope === parent && item.original.name === name)
      if (record !== undefined) return record.original
      const fiber = parent === undefined ? [...(ctx.registry.get(SystemPrompt)?.fibers ?? [])].find(item => live(item) && scopeOf(item.ctx) === undefined) : officialAt(parent)
      if (fiber) return fromConfig(fiber, name, parent === undefined)
      // 未观察的 standing scope 不等于空层，不能用根配置替换未知声明。
      if (parent !== undefined) break
    }
    throw new Error(`人设原声明未被观察：${name}；保持未知声明原状${knowledgeError ? `（${knowledgeError}）` : ''}`)
  }
  const validate = (state: AgentState, policy: TargetPolicy, completeSections: readonly string[]): void => {
    const own = ownRecords(state)
    if (state.official && (!live(state.official.fiber) || !isDeepStrictEqual(state.official.fiber.config, state.official.config))) {
      throw new Error('官方人设配置已变化，拒绝覆盖外部更新')
    }
    if (state.capturedOfficial && SECTION_NAMES.some(name => !own.some(record => record.owner === state.official?.fiber && record.original.name === name))) {
      throw new Error('官方人设注册已变化，拒绝覆盖外部重载')
    }
    const original = (name: string): PromptSection => own.find(item => item.original.name === name)?.original
      ?? (state.official ? fromConfig(state.official.fiber, name) : inherited(state.scope, name))
    for (const name of SECTION_NAMES) {
      const field = name === PERSONA_PREFIX_SECTION ? 'prefix' : 'suffix'
      if (policy.spec[field] !== undefined || field === 'prefix' && policy.spec.complete !== undefined) {
        original(name)
      }
    }
    if (completeSections.length === 0) return
    const prefix = original(PERSONA_PREFIX_SECTION)
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
  const attach = (agent: Agent): AgentState => {
    const scope = scopeOf(agent.ctx)
    if (scope === undefined) throw new Error('Agent 缺少官方 scope')
    const retained = agents.get(scope)
    if (retained) return retained
    const state: AgentState = { agent, scope, audience: agent.session.header.origin === 'subagent' ? 'subagent' : 'main',
      policy: emptyPolicy(), source: undefined, shadows: [] }
    agents.set(scope, state)
    agent.ctx.effect(() => () => {
      agents.delete(scope)
      for (const off of state.shadows.splice(0)) off()
    }, 'prompt-tool persona agent')
    return state
  }
  const adoptOfficial = async (state: AgentState, signal?: AbortSignal): Promise<void> => {
    const official = state.official
    if (!official || ownRecords(state).some(record => record.owner === official.fiber)) return
    signal?.throwIfAborted()
    if (!active || !live(official.fiber) || !isDeepStrictEqual(official.fiber.config, official.config)) throw new Error('官方人设配置已变化，拒绝接管')
    const stop = capture(state, official.fiber)
    try {
      official.fiber.update(official.config, true)
      await official.fiber.await()
      signal?.throwIfAborted()
      if (!active || agents.get(state.scope) !== state) throw new Error('人设接管已取消')
      const owned = ownRecords(state).filter(record => record.owner === official.fiber)
      if (!live(official.fiber) || !isDeepStrictEqual(official.fiber.config, official.config)
        || SECTION_NAMES.some(name => !owned.some(record => record.original.name === name))) {
        throw new Error('官方人设重载被拦截或声明不完整，未接管人设')
      }
      state.capturedOfficial = true
    } catch (error) {
      for (const record of ownRecords(state)) if (record.owner === official.fiber) record.swap?.(record.original)
      // 只恢复仍属于本次配置的失败生命周期，不回写已被外部修改的配置。
      if (official.fiber.uid !== null && !live(official.fiber) && isDeepStrictEqual(official.fiber.config, official.config)) {
        await official.fiber.restart()
      }
      throw error
    } finally { stop() }
  }
  const holdMaintenance = async (agent: Agent): Promise<{ signal: AbortSignal; release(): Promise<void> }> => {
    const entered = Promise.withResolvers<AbortSignal>(), finished = Promise.withResolvers<void>()
    const task = agent.runMaintenance(async signal => { entered.resolve(signal); await finished.promise })
    void task.catch(error => entered.reject(error))
    const signal = await entered.promise
    return { signal, release: async () => { finished.resolve(); await task } }
  }
  const prepare = async (targets: readonly PersonaAssemblyTarget[], modules?: readonly PersonaModule[]): Promise<PersonaPreparation> => {
    const policySource = source, candidate = policiesOf(modules ?? policySource?.modules() ?? [])
    if (targets.some(({ agent, completeSections }) => completeSections.length > 0
      || Object.keys(candidate[agent.session.header.origin === 'subagent' ? 'subagent' : 'main'].spec).length > 0)) await readKnowledge()
    if (!active) throw new Error('人设运行适配器已释放')
    const updates = targets.flatMap(({ agent, completeSections }) => {
      if (completeSections.length > 1) throw new Error(`Agent ${agent.id} 有多个生效 complete 段：${completeSections.join('、')}`)
      const audience = agent.session.header.origin === 'subagent' ? 'subagent' : 'main'
      const policy = candidate[audience], retained = agents.get(scopeOf(agent.ctx)!)
      if (Object.keys(policy.spec).length === 0 && completeSections.length === 0 && (!retained || Object.keys(retained.policy.spec).length === 0)) return []
      const state = retained ?? attach(agent)
      if (reserved.has(state.scope)) throw new Error(`Agent ${agent.id} 正在更新人设，请稍后重试`)
      if (!state.official && ownRecords(state).length === 0) {
        const fiber = officialAt(state.scope)
        if (fiber) state.official = { fiber, config: structuredClone(fiber.config) }
      }
      validate(state, policy, completeSections)
      return [{ state, policy, completeSections, previous: state.policy, previousSource: state.source,
        changes: !isDeepStrictEqual(policy, state.policy) || policySource !== state.source }]
    })
    const holds = new Map<AgentState, Awaited<ReturnType<typeof holdMaintenance>>>()
    let released = false
    const release = async (): Promise<void> => {
      if (released) return
      released = true
      for (const item of updates) reserved.delete(item.state.scope)
      await Promise.all([...holds.values()].map(hold => hold.release()))
    }
    for (const item of updates) reserved.add(item.state.scope)
    try {
      for (const item of updates) {
        if (!item.changes) continue
        const agent = item.state.agent
        if (agent.status === 'running') throw new Error(`Agent ${agent.id} 正在运行，保留原人设，请空闲后重试`)
        if (typeof agent.runMaintenance === 'function') holds.set(item.state, await holdMaintenance(agent))
        else if (item.state.official && !item.state.capturedOfficial) throw new Error('旧会话没有官方维护接口，保留原人设')
      }
    } catch (error) { await release(); throw error }
    const applied: typeof updates = []
    const rollback = async (): Promise<void> => {
      if (!active) { applied.length = 0; return }
      const errors: unknown[] = []
      for (const item of applied.splice(0).reverse()) {
        if (agents.get(item.state.scope) !== item.state) continue
        try {
          validate(item.state, item.previous, [])
          update(item.state, item.previous, item.previousSource)
        } catch (error) { errors.push(error) }
      }
      if (errors.length > 0) throw new AggregateError(errors, `人设恢复失败：${errors.map(String).join('；')}`)
    }
    return {
      async commit() {
        try {
          for (const item of updates) {
            if (!active || released || agents.get(item.state.scope) !== item.state) throw new Error('人设更新已取消或会话已释放')
            holds.get(item.state)?.signal.throwIfAborted()
            if (item.state.policy !== item.previous || item.state.source !== item.previousSource) throw new Error('人设运行状态已变化，请重新读取')
            validate(item.state, item.policy, item.completeSections)
            if (!item.changes) continue
            if (Object.keys(item.policy.spec).length > 0) await adoptOfficial(item.state, holds.get(item.state)?.signal)
            if (!active) throw new Error('人设更新已取消')
            holds.get(item.state)?.signal.throwIfAborted()
            update(item.state, item.policy, policySource)
            applied.push(item)
          }
        } catch (error) {
          try { await rollback() } catch (restoreError) { throw new AggregateError([error, restoreError], '人设提交与恢复均失败') }
          throw error
        }
      },
      rollback, release,
    }
  }
  const refresh = async (): Promise<void> => {
    const targets = new Set([...(ctx.get('agents')?.list() ?? []), ...[...agents.values()].map(state => state.agent)])
    const change = await prepare([...targets].map(agent => ({ agent, completeSections: [] })))
    try { await change.commit() } finally { await change.release() }
  }
  const runtime: PersonaRegistration = {
    async configure(next) {
      if (source !== undefined) throw new Error('人设模块来源已注册')
      policiesOf(next.modules())
      source = next
      try { await refresh() } catch (error) { next.warn?.(`人设尚未发布，原会话保持不变：${String(error)}`) }
      let configured = true
      return async () => {
        if (!configured) return
        configured = false
        source = undefined
        if (active) await refresh()
      }
    },
    refresh, prepare,
  }
  ctx.provide(PERSONA_REGISTRATION_SERVICE, runtime)

  ctx.on('internal/get', (_caller, name, _error, next) => {
    const service = next()
    if (name !== 'agents') return service
    return new Proxy(service, {
      get(target, property, receiver) {
        const method = Reflect.get(target, property, receiver)
        if (property !== 'create' && property !== 'resume') return method
        return (options: CreateAgentOptions | ResumeAgentOptions) => {
          if (!active) return Reflect.apply(method, target, [options])
          const setup = options.setup
          return Reflect.apply(method, target, [{ ...options, setup: async (agentCtx: Context, agent: Agent) => {
            if (!active) return setup?.(agentCtx, agent)
            const state = attach(agent), stop = capture(state)
            let commit
            try { commit = await setup?.(agentCtx, agent) } finally { stop() }
            if (!active || options.signal?.aborted || agents.get(state.scope) !== state) return commit
            const policy = policiesOf(source?.modules() ?? [])[state.audience]
            if (Object.keys(policy.spec).length > 0) {
              await readKnowledge()
              if (!active || options.signal?.aborted) return commit
              try { validate(state, policy, []); update(state, policy, source) }
              catch (error) { source?.warn?.(`会话 ${agent.id} 保留官方人设：${String(error)}`) }
            }
            return commit
          } }])
        }
      },
    })
  }, { global: true })
  ctx.effect(() => () => {
    active = false
    source = undefined
    for (const state of agents.values()) {
      for (const off of state.shadows.splice(0)) off()
      for (const record of ownRecords(state)) {
        if (state.official && !isDeepStrictEqual(state.official.fiber.config, state.official.config)) continue
        try { record.swap?.(record.original) }
        catch (error) { ctx.logger?.warn(`人设原声明恢复失败：${String(error)}`) }
      }
    }
  }, 'prompt-tool persona restoration')
  return runtime
}
