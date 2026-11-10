import { prepareAction } from './actions/index.mjs'
import { confirmDelivered, runPreStepBatch } from './executor.mjs'
import { createPreStepSource, moduleSourceId } from './pre-step-source.mjs'
import { createLayerRuntime } from './layers.mjs'
import { actionAudiences, completeRuleSections, rebindConditions, validateDeliverySources } from './rule-spec.mjs'
import { wireTriggerObservers } from './trigger.mjs'
import { ruleFrame, actionMatches } from './conditions/evaluation.mjs'
import { createPromotionPool } from './promotion-pool.mjs'
import { PROMOTE_EVENTS, createWarnOnce, getService, isDelegated, matchesAudience } from './shared.mjs'
import { PERSONA_PREFIX, planPersonaActions, stripPersonaIdentity } from './actions/persona.mjs'
import { PRE_STEP_COORDINATOR_SERVICE } from './service-names.mjs'
import { scopeChainOf, scopeOf } from '@deepseek-ai/dsh-scope'
import { installToolStepAssembly } from './tool-step-assembly.mjs'

const noNext = new Set(['agent/inbox/inserted', 'agent/turn-stopping', 'subagent/start', 'subagent/end'])
// 判据与 `order.mjs#compareConfigSequence` 有意不同：这里在同通道同点内按 moduleId 字母序 +
// 规则声明序（ruleIndex）定位，`compareConfigSequence` 按 `sequence`（= 编辑器顺序，缺省回退
// `order`）+ `ruleId` 排。收敛到 `ruleId` 会打断现网依赖的「编辑器顺序 = 执行顺序」，别顺手统一。
const compare = (a, b) => a.action.channelOrder - b.action.channelOrder
  || a.moduleId.localeCompare(b.moduleId) || a.ruleIndex - b.ruleIndex || a.action.actionIndex - b.action.actionIndex

const sourceError = (error, moduleId) => Object.assign(new Error(String(error?.message ?? error), { cause: error }), { sourceModuleId: moduleId })

const pointKey = point => `${point.channel}:${point.phase}:${point.waterfallPosition}`
const compareEntries = (a, b) => a.sequence - b.sequence || a.sourceModuleId.localeCompare(b.sourceModuleId)
  || a.ruleIndex - b.ruleIndex || a.ruleActionIndex - b.ruleActionIndex

function pointHandler(ctx, point, snapshot, warnOnce, report, isActive, assemblyFrame) {
  return (...args) => {
    const handlers = snapshot()
    const free = noNext.has(point.channel)
    const payload = free ? args : args.slice(0, -1)
    const next = free ? () => undefined : args.at(-1)
    if (!isActive()) return next()
    let frame
    try { frame = assemblyFrame !== undefined && point.channel === 'system-prompt/assemble'
      ? assemblyFrame(payload[1], payload[0]) : ruleFrame(point.channel, payload, warnOnce, ctx, report) }
    catch (error) {
      warnOnce(`rule engine: frame construction failed on ${point.channel}: ${String(error?.message ?? error)}`)
      return next()
    }
    if (free) {
      let pending
      for (const entry of handlers) {
        const invoke = () => {
          if (!isActive()) return undefined
          if (!actionMatches(entry, frame)) { entry.miss?.(frame); return undefined }
          return entry.handler(...payload, undefined, frame)
        }
        pending = pending?.then ? pending.then(invoke) : invoke()
      }
      return pending
    }
    if (point.phase === 'after-next') return Promise.resolve(next()).then(async initial => {
      let result = initial
      for (const entry of handlers) {
        if (!isActive()) continue
        if (!actionMatches(entry, frame)) { entry.miss?.(frame); continue }
        result = await entry.handler(...payload, () => result, frame)
      }
      return result
    })
    const invoke = index => {
      if (!isActive() || index === handlers.length) return next()
      const entry = handlers[index]
      if (!actionMatches(entry, frame)) { entry.miss?.(frame); return invoke(index + 1) }
      return entry.handler(...payload, () => invoke(index + 1), frame)
    }
    return invoke(0)
  }
}

/** 所有来源只进入这个装配入口；受众限定固定效果要求 ctx 属于 options.agent 的 scope。 */
function mountSources(ctx, sources, options = {}) {
  validateDeliverySources(sources)
  const pool = options.promotionPool
  // 条件绑定**在这里**发生：`compileRules` 编译期没有挂载 scope 的 ctx（preset 条件在那边恒
  // UNAVAILABLE 且静默）。必须早于事件订阅与动作注册——动作级 `actionWhen.observe` 是订阅通道，
  // 绑晚了那一类谓词会漏事件。`standingMountFor` 是可选兜底（官方包缺席＝没有兜底，不是错误）。
  const warnOnce = options.warnOnce ?? createWarnOnce(ctx, options.plugin ?? 'rule-engine')
  const releases = []
  const points = new Map()
  const injections = new Map(sources.map(source => [source.moduleId, { moduleId: source.moduleId, sourceId: moduleSourceId(source.moduleId), configs: [], ruleActions: [] }]))
  // 动作级分支条件（actionWhen）也要喂 session/event：否则 else / 嵌套 if 里的 phase / count
  // 谓词永远收不到事件，状态停在冷扫那一刻（规则级 when 已由 rules 覆盖，动作级单独补齐）。
  const bind = (item, on) => prepareAction(item.action, { plugin: options.plugin, warnOnce, promptConfigOptions: item.rule.promptConfigOptions, on })(ctx)
  try {
    for (const source of sources) {
      try { rebindConditions([source], { ctx, standingMountFor: options.standingMountFor, promotionPool: pool, variableStore: options.variableStore, manifestCheck: options.manifestCheck, soulReminder: options.soulReminder }) }
      catch (error) { throw sourceError(error, source.moduleId) }
    }
    const rules = sources.flatMap(source => source.rules.filter(rule => rule.enabled !== false))
    const observer = wireTriggerObservers(ctx, [
      ...rules,
      ...rules.flatMap(rule => (rule.actions ?? [])
        .filter(action => typeof action.actionWhen?.observe === 'function')
        .map(action => ({ id: action.id, when: action.actionWhen }))),
    ], { plugin: options.plugin ?? 'rule-engine', warnOnce })
    if (observer) releases.push(observer)
    for (const source of sources) for (const [ruleIndex, rule] of source.rules.entries()) {
      if (rule.enabled === false) continue
      for (const action of rule.actions) {
        const item = { moduleId: source.moduleId, ruleIndex, rule, action }
        const point = action.execution
        const key = `${point.channel}:${point.phase}:${action.waterfallPosition}`
        const bucket = points.get(key) ?? { ...point, waterfallPosition: action.waterfallPosition, items: [] }
        bucket.items.push(item); points.set(key, bucket)
      }
    }
    for (const point of points.values()) {
      point.items.sort(compare)
      const handlers = []
      let textConfigs = []
      const flushLayers = () => {
        if (!textConfigs.length) return
        options.collectText(point, textConfigs)
        textConfigs = []
      }
      for (const item of point.items) {
        const { action, rule, moduleId } = item
        if (action.kind === 'persona') {
          options.collectPersona({ action, rule, id: action.id, sequence: action.channelOrder, sourceModuleId: moduleId,
            ruleIndex: item.ruleIndex, ruleActionIndex: action.actionIndex, actionWhen: action.actionWhen, bypassRuleWhen: action.bypassRuleWhen })
          continue
        }
        if (action.kind === 'inject-text') {
          const config = { ...action.compiledConfig, rule, sourceModuleId: moduleId, variableStore: options.variableStore,
            group: undefined, exclusive: false, enabled: true, actionWhen: action.actionWhen, bypassRuleWhen: action.bypassRuleWhen, runtimeOrder: action.channelOrder, runtimeRuleIndex: item.ruleIndex }
          if (config.layer === 'pre-step') injections.get(moduleId).configs.push(config)
          else textConfigs.push(config)
          continue
        }
        flushLayers()
        const created = []
        const on = (channel, handler) => {
          if (channel !== point.channel) throw new TypeError(`rule action registered outside ${point.channel}: ${channel}`)
          const entry = { rule, handler, toolSurface: action.kind === 'tool-visibility', sequence: action.channelOrder, sourceModuleId: moduleId, ruleId: rule.id, ruleIndex: item.ruleIndex, ruleActionIndex: action.actionIndex, id: action.id, actionWhen: action.actionWhen, bypassRuleWhen: action.bypassRuleWhen }
          if (channel === 'agent/pre-step' && point.waterfallPosition === 'default') injections.get(moduleId).ruleActions.push(entry)
          else handlers.push(entry)
          created.push(entry)
          // handler 由稳定执行点统一分派；来源 disposer 只释放动作自身的副作用。
          return () => {}
        }
        let dispose
        try { dispose = bind(item, on) }
        catch (error) { throw sourceError(error, moduleId) }
        // 未命中通知：条件为假时动作不会进入 handler，撤销型动作（tool-visibility 的执行闸）
        // 只能靠这条回调收手——否则第一轮为真后永久留闸。
        if (typeof dispose?.miss === 'function') {
          for (const entry of created) entry.miss = dispose.miss
        }
        releases.push(dispose)
      }
      flushLayers()
      if (!handlers.length) continue
      options.collectPoint(point, handlers)
    }
    // 各来源共用运行时拥有的晋升相位对，事件只由相位池喂入。
    const promotion = options.promotion
    const preStep = [...injections.values()]
      .filter(source => source.configs.length || source.ruleActions.length)
      .map(source => createPreStepSource({
        sourceId: source.sourceId,
        ctx,
        configs: source.configs,
        ruleActions: source.ruleActions,
        onOutcome: options.onOutcome === undefined ? undefined : report => options.onOutcome({ moduleId: source.moduleId, ...report }),
        promotion,
      }))
    if (preStep.length) releases.push(options.registerPreStep(preStep))
  } catch (error) {
    for (const dispose of releases.reverse()) { try { dispose?.() } catch {} }
    throw error
  }
  return () => {
    for (const dispose of releases.splice(0).reverse()) { try { dispose?.() } catch {} }
  }
}

/** 稳定执行点持有有序快照；来源仅在规则实例改变时重新绑定和注册。 */
export function createRuleRuntime(ctx, options = {}) {
  const warnOnce = options.warnOnce ?? createWarnOnce(ctx, options.plugin ?? 'rule-engine')
  const coordinatorOf = () => {
    const value = getService(ctx, PRE_STEP_COORDINATOR_SERVICE)
    return typeof value?.registerPreset === 'function' ? value : undefined
  }
  const initialCoordinator = coordinatorOf()
  const pool = options.promotionPool ?? initialCoordinator?.promotionPool ?? createPromotionPool(ctx)
  const ownsPool = options.promotionPool === undefined && initialCoordinator?.promotionPool === undefined
  const promotion = options.promotion ?? initialCoordinator?.promotion ?? {
    main: pool.tracker(PROMOTE_EVENTS.either, { includeSubagents: false }),
    withSubagents: pool.tracker(PROMOTE_EVENTS.either, { includeSubagents: true }),
  }
  const standalone = new Map()
  const registrations = new Map()
  let registeredCoordinator = initialCoordinator
  let active = true
  let records = new Map()
  let points = new Map()
  const listeners = new Map()
  const ruleOwners = new WeakMap()
  const memo = new Map()
  const report = options.onOutcome === undefined ? undefined : (rule, channel, outcome) => options.onOutcome({ moduleId: ruleOwners.get(rule), ruleId: rule.id, channel, outcome })
  const assemblyFrames = new WeakMap()
  const assemblyPersonaPlans = new WeakMap()
  const assemblyFrame = (context, assembly = {}) => {
    let frame = assemblyFrames.get(context)
    if (frame === undefined) {
      frame = ruleFrame('system-prompt/assemble', [assembly, context], warnOnce, ctx, report)
      assemblyFrames.set(context, frame)
    }
    return frame
  }
  let layers
  let releaseAssembly
  let releaseMemo, releaseFallback
  const register = (coordinator, source) => {
    if (coordinator.promotion === undefined) throw new TypeError('prompt-tool: pre-step coordinator v2 must expose a promotion owner')
    return coordinator.registerPreset(source.sourceId, { ...source, promotion: coordinator.promotion }) ?? (() => {})
  }
  const ensureFallback = () => {
    if (releaseFallback !== undefined) return
    releaseMemo = ctx.on('session/event', (session, event) => confirmDelivered(memo, session, event))
    try {
      releaseFallback = ctx.on('agent/pre-step', async (payload, next) => {
        // 取得本次完整来源快照后才进入宿主，途中更新不会拼接两个版本的批次。
        const coordinator = coordinatorOf()
        if (coordinator !== registeredCoordinator) {
          for (const release of registrations.values()) release()
          registrations.clear()
          registeredCoordinator = coordinator
          if (coordinator !== undefined) for (const source of standalone.values()) registrations.set(source.sourceId, register(coordinator, source))
        }
        const sources = [...standalone.values()]
        const decision = await next()
        if (!active || coordinator !== undefined || sources.length === 0) return decision
        return runPreStepBatch({ sources, ctx, payload, agent: payload?.agent, decision, memo, warnOnce })
      }, { prepend: true })
    } catch (error) { releaseMemo(); releaseMemo = undefined; throw error }
  }
  const mount = source => {
    const record = { source, points: [], text: [], personas: [], dispose: undefined }
    for (const rule of source.rules) ruleOwners.set(rule, source.moduleId)
    record.dispose = mountSources(ctx, [source], {
      ...options, warnOnce, promotionPool: pool, promotion,
      registerPreStep(sources) {
        const installed = []
        const dispose = () => {
          for (const item of installed) if (standalone.get(item.sourceId) === item) {
            standalone.delete(item.sourceId)
            registrations.get(item.sourceId)?.()
            registrations.delete(item.sourceId)
          }
        }
        try {
          ensureFallback()
          for (const item of sources) {
            if (standalone.has(item.sourceId)) throw new TypeError(`prompt-tool: duplicate pre-step source ${item.sourceId}`)
            standalone.set(item.sourceId, item)
            installed.push(item)
            const coordinator = coordinatorOf()
            if (coordinator !== undefined) {
              try { registrations.set(item.sourceId, register(coordinator, item)) }
              catch (error) { throw sourceError(error, source.moduleId) }
            }
          }
          return dispose
        } catch (error) { dispose(); throw error }
      },
      collectPoint(point, handlers) { record.points.push({ point, handlers }) },
      collectPersona(entry) { record.personas.push(entry) },
      collectText(point, configs) {
        for (const config of configs) { config.runtimePoint = point; record.text.push(config) }
      },
    })
    return record
  }
  const publishPoints = () => {
    const next = new Map()
    const add = (point, entry) => {
      const key = pointKey(point)
      const value = next.get(key) ?? { point, handlers: [] }
      value.handlers.push(entry)
      next.set(key, value)
    }
    for (const record of records.values()) for (const { point, handlers } of record.points) for (const entry of handlers) add(point, entry)
    for (const { channel, handler, config } of layers?.entries() ?? []) {
      const point = { ...config.runtimePoint, channel }
      add(point, { handler, sequence: config.runtimeOrder, sourceModuleId: config.sourceModuleId, ruleIndex: config.runtimeRuleIndex, ruleActionIndex: config.ruleActionIndex ?? 0 })
    }
    for (const [key, value] of next) {
      value.handlers.sort(compareEntries)
      if (value.handlers.some(entry => !entry.toolSurface) && !listeners.has(key)) listeners.set(key, ctx.on(value.point.channel,
        pointHandler(ctx, value.point, () => (points.get(key)?.handlers ?? []).filter(entry => !entry.toolSurface), warnOnce, report, () => active,
          (context, assembly) => options.externalAssembly === true || releaseAssembly !== undefined
            ? assemblyFrame(context, assembly) : ruleFrame('system-prompt/assemble', [assembly, context], warnOnce, ctx, report)),
        value.point.waterfallPosition === 'outermost' ? { prepend: true } : undefined))
    }
    points = next
  }
  let persona
  const releasePersona = current => {
    if (current === undefined) return
    for (const off of current.releases.splice(0).reverse()) off()
    for (const restore of current.restores.splice(0).reverse()) restore()
  }
  const installPersona = plan => {
    const current = { plan, releases: [], restores: [] }
    try {
      const prompt = getService(ctx, 'systemPrompt')
      for (const section of plan.sections) {
        const restore = options.persona?.suspend?.(section.name)
        if (restore !== undefined) current.restores.push(restore)
        current.releases.push(prompt.section(section))
      }
      if (plan.suppressRuntimeContext) current.releases.push(prompt.suppressRuntimeContext())
      return current
    } catch (error) {
      try { releasePersona(current) } catch (cleanupError) {
        throw Object.assign(new AggregateError([error, cleanupError], `persona registration and cleanup failed: ${String(error.message)}; ${String(cleanupError.message)}`), { recoveryFailed: true })
      }
      throw error
    }
  }
  const commitPersona = plan => {
    const old = persona?.plan
    if (old?.instructionMaxBytes === plan.instructionMaxBytes && old?.customPrefix === plan.customPrefix && old?.identityEntries?.length === plan.identityEntries?.length && old?.identityEntries?.every((entry, index) => entry === plan.identityEntries[index])
      && old?.suppressRuntimeContext === plan.suppressRuntimeContext && old.sections.length === plan.sections.length
      && old.sections.every((section, index) => ['name', 'text', 'order', 'complete', 'interpolate'].every(key => section[key] === plan.sections[index][key]))) return
    releasePersona(persona)
    persona = undefined
    try { persona = installPersona(plan) }
    catch (error) {
      if (old !== undefined) {
        try { persona = installPersona(old) }
        catch (restoreError) {
          throw Object.assign(new AggregateError([error, restoreError], `persona replacement and recovery failed: ${String(error.message)}; ${String(restoreError.message)}`), { recoveryFailed: true })
        }
      }
      throw error
    }
  }
  const preparePersona = (context = {}, preview = false) => {
    const entries = [...records.values()].flatMap(record => record.personas).sort(compareEntries)
    if (entries.length === 0 && persona === undefined && options.persona === undefined) return undefined
    context = context.agent === undefined ? { agent: options.agent, ...context } : context
    context.signal?.throwIfAborted()
    if (entries.length > 0 && context.agent === undefined) throw new TypeError('persona rules require the real Agent')
    const audience = isDelegated(context.agent?.session) ? 'subagent' : 'main'
    const frame = assemblyFrame(context)
    const selected = entries.filter(entry => matchesAudience(entry.action.audience, audience) && actionMatches(entry, frame))
    if (!preview) for (const entry of entries) {
      if (entry.action.stripDefaultIdentity === undefined || selected.includes(entry)) continue
      const outcome = frame.decisions.get(entry.rule)?.outcome ?? 'miss'
      try { options.onOutcome?.({ moduleId: entry.sourceModuleId, ruleId: entry.rule.id, channel: `persona:identity:${entry.action.stripDefaultIdentity}`, outcome,
        identityOutcome: outcome === 'error' ? 'error' : outcome === 'unavailable' ? 'condition-unavailable' : 'condition-miss',
        definitionRevision: entry.rule.definitionRevision }) } catch { /* 只读诊断不能改变装配 */ }
    }
    if ([...frame.decisions.values()].some(decision => decision.outcome === 'error')) throw new Error('persona condition evaluation failed; keeping previous contribution')
    const prompt = getService(ctx, 'systemPrompt')
    const plan = planPersonaActions(selected, context, prompt, options.persona, options.variableStore, warnOnce, preview)
    const rules = [...records.values()].flatMap(record => record.source.rules)
    const complete = completeRuleSections(rules, audience)
    const prefix = plan.sections.find(section => section.name === PERSONA_PREFIX) ?? options.persona?.inherited?.(PERSONA_PREFIX)
    if (prefix?.complete === true && complete.length > 0) throw new TypeError(`persona and rules have multiple complete sections for ${audience}`)
    if (prefix?.complete === true || complete.length > 0) {
      const append = rules.some(rule => rule.enabled !== false && rule.actions.some(action => action.kind === 'assembly'
        && action.target?.sections?.append?.length > 0 && actionAudiences(rule, action.id).has(audience)))
      if (append) throw new TypeError(`persona/rules complete conflicts with sections.append for ${audience}`)
    }
    context.signal?.throwIfAborted()
    return plan
  }
  const runtime = {
    replace(sources) {
      if (!active) throw new Error('rule runtime disposed')
      validateDeliverySources(sources)
      const desired = new Map()
      for (const source of sources) {
        if (desired.has(source.moduleId)) throw sourceError(new TypeError(`duplicate rule source ${source.moduleId}`), source.moduleId)
        desired.set(source.moduleId, source)
      }
      const old = records
      const changed = [...old.values()].filter(record => desired.get(record.source.moduleId)?.rules !== record.source.rules)
      if (changed.length === 0 && sources.length === old.size) return
      for (const record of changed) record.dispose()
      const created = []
      try {
        const next = new Map()
        for (const source of sources) {
          let record = old.get(source.moduleId)
          if (record?.source.rules !== source.rules) {
            record = mount(source)
            created.push(record)
          }
          next.set(source.moduleId, record)
        }
        records = next
        const personaPlan = preparePersona({}, true)
        const text = [...records.values()].flatMap(record => record.text)
        if (text.length > 0) layers ??= createLayerRuntime(ctx, warnOnce, { agent: options.agent, turnStopBudgets: new Map(), sourceError })
        layers?.replace(text)
        publishPoints()
        if (options.externalAssembly !== true && releaseAssembly === undefined
          && ([...points.values()].some(point => point.handlers.some(entry => entry.toolSurface)) || [...records.values()].some(record => record.personas.length > 0))) {
          const scope = scopeOf(ctx)
          releaseAssembly = installToolStepAssembly(ctx, {
            knows: agent => active && ([...points.values()].some(point => point.handlers.some(entry => entry.toolSurface)) || [...records.values()].some(record => record.personas.length > 0))
              && (options.agent === undefined ? scope === undefined || scopeChainOf(agent).includes(scope) : agent === options.agent),
            ensureFresh: async () => {},
            assemble: (context, invoke) => { runtime.prepareAssembly(context); return invoke() },
            settle: (assembly, context) => runtime.settleToolSurface(assembly, context),
          })
        }
        const needsInstructions = [...records.values()].some(record => record.personas.some(entry => entry.action.instructionMaxBytes !== undefined))
        if (personaPlan !== undefined && !needsInstructions && persona?.plan.instructionMaxBytes === undefined) commitPersona(personaPlan)
      } catch (error) {
        for (const record of created.reverse()) record.dispose()
        records = new Map(old)
        try {
          for (const record of changed) records.set(record.source.moduleId, mount(record.source))
          layers?.replace([...records.values()].flatMap(record => record.text))
          publishPoints()
        } catch (restoreError) {
          throw Object.assign(new AggregateError([error, restoreError], `rule source replacement and recovery failed: ${String(error.message)}; ${String(restoreError.message)}`), { sourceModuleId: error.sourceModuleId })
        }
        throw error
      }
    },
    prepareAssembly(context, beforeCommit) {
      if (!active) return
      if (context !== undefined) assemblyFrames.delete(context)
      const plan = preparePersona(context)
      const oldPlan = persona?.plan
      const commit = () => {
        if (!active) return
        context?.signal?.throwIfAborted()
        if (plan !== undefined) {
          commitPersona(plan)
          if (context !== undefined) assemblyPersonaPlans.set(context, plan)
        }
      }
      if (plan?.instructionMaxBytes !== undefined && beforeCommit === undefined) throw new Error('persona.instructionMaxBytes requires the official instruction host adapter')
      if (beforeCommit !== undefined) return Promise.resolve(beforeCommit(plan?.instructionMaxBytes)).then(async transaction => {
        try {
          if (!active) { await transaction?.rollback(); return }
          if (transaction?.ready === false) { if (context !== undefined && oldPlan !== undefined) assemblyPersonaPlans.set(context, oldPlan); return }
          commit(); await transaction?.commit()
        } catch (error) {
          await transaction?.rollback()
          if (active && oldPlan !== undefined) commitPersona(oldPlan)
          if (context !== undefined && oldPlan !== undefined) assemblyPersonaPlans.set(context, oldPlan)
          throw error
        }
      })
      commit()
    },
    async settleToolSurface(assembly, context) {
      const frame = assemblyFrame(context, assembly)
      let result = assembly
      const handlers = [...points.values()].flatMap(point => point.handlers.filter(entry => entry.toolSurface)).sort(compareEntries)
      for (const entry of handlers) {
        if (!active) break
        if (!actionMatches(entry, frame)) { entry.miss?.(frame); continue }
        result = await entry.handler(result, context, () => result, frame)
      }
      const accepted = assemblyPersonaPlans.get(context) ?? persona?.plan
      return stripPersonaIdentity(result, accepted?.identityEntries ?? [], options.onOutcome, accepted?.customPrefix)
    },
    dispose() {
      if (!active) return
      active = false
      releaseAssembly?.()
      releasePersona(persona)
      persona = undefined
      for (const record of records.values()) record.dispose()
      records.clear()
      layers?.dispose()
      for (const release of listeners.values()) release()
      listeners.clear()
      points.clear()
      releaseFallback?.()
      releaseMemo?.()
      if (ownsPool) pool.dispose()
    },
  }
  return runtime
}

/** 兼容一次性挂载；增量调用者持有 createRuleRuntime 的来源集合。 */
export function mountRuleSources(ctx, sources, options = {}) {
  validateDeliverySources(sources)
  const runtime = createRuleRuntime(ctx, options)
  try { runtime.replace(sources) } catch (error) { runtime.dispose(); throw error }
  return () => runtime.dispose()
}
