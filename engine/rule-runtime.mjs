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
import { instructionsBudgetStatus } from './instructions-budget-bridge.mjs'
import { toolStepFor } from './tool-scope.mjs'
import { PRE_STEP_COORDINATOR_SERVICE } from './service-names.mjs'
import { scopeChainOf, scopeOf } from '@deepseek-ai/dsh-scope'
import { installToolStepAssembly } from './tool-step-assembly.mjs'
import { subagentParamsStatus } from './subagent-params.mjs'
import { requestBudgetStatus } from './request-budget-bridge.mjs'
import { compileWhen } from './conditions/index.mjs'
import { bindReadLimitsDependencies, isReadLimitsAction, prepareReadLimits } from './read-limits.mjs'
import { bindDelegationLimitsDependencies, isDelegationLimitsAction, prepareDelegationLimits } from './delegation-limits.mjs'
import { bindFilesystemPolicyDependencies, isFilesystemPolicyAction, prepareFilesystemPolicy } from './filesystem-policy.mjs'
import { bindApprovalDecisionsDependencies, isApprovalDecisionsAction, prepareApprovalDecisions } from './approval-decisions.mjs'
import { bindEscalationDecisionDependencies, isEscalationDecisionAction, prepareEscalationDecisions } from './escalation-decisions.mjs'
import { applyToolDescriptions } from './actions/assembly.mjs'
import { applyTransportDescriptions, toolDescriptionObservation, settleSkillDescriptions, skillDescriptionObservation } from './tool-metadata.mjs'
import { resultTextOwners } from './result-text-owners.mjs'
import { bindResultTextDependencies } from './result-text.mjs'
import { providerHookDecisionsState, isProviderHookDecisionsAction, prepareProviderHookDecisions, bindProviderHookDependencies } from './provider-hook-decisions.mjs'
import { bindRepeatCompactionDependencies, filterRepeatReminderDecision, installPrunerGate, isRepeatCompactionAction, repeatReminderStatus } from './repeat-compaction-policy.mjs'
import { bindCurrentSystemSnapshotDependencies, isCurrentSystemSnapshotAction, registerCurrentSystemSnapshot } from './current-system-snapshot.mjs'
import { isRewindAction, registerRewindControl } from './rewind-control.mjs'
import { bindMessageShapeGuardsDependencies, isMessageShapeGuardsAction, registerMessageShapeGuards } from './message-shape-guards.mjs'
import { bindProviderSystemRolesDependencies, isProviderSystemRolesAction, registerProviderSystemRoles } from './provider-system-roles.mjs'

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
    const replacements = point.channel === 'system-prompt/assemble' ? { sections: new WeakMap(), contexts: new WeakMap() } : undefined
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
        result = await entry.handler(...payload, () => result, frame, replacements)
      }
      return result
    })
    const invoke = index => {
      if (!isActive() || index === handlers.length) return next()
      const entry = handlers[index]
      if (entry.handler.resultTextPlan !== undefined && resultTextOwners.handled.has(payload[0])) return invoke(index + 1)
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
  const bind = (item, on) => prepareAction(item.action, { plugin: options.plugin, warnOnce, promptConfigOptions: item.rule.promptConfigOptions, on,
    requestBudgetOutcome: (agent, matched) => options.onOutcome?.({ moduleId: item.moduleId, ruleId: item.rule.id, channel: 'request:budget',
      outcome: matched ? 'hit' : 'unavailable', identityOutcome: matched ? 'matched' : 'target-mismatch', actionId: item.action.id,
      definitionRevision: item.rule.definitionRevision, agentId: agent?.id, ...(matched ? {} : { reason: 'maxTokens changed by another request owner' }) }) })(ctx)
  try {
    for (const source of sources) {
      try { rebindConditions([source], { ctx, standingMountFor: options.standingMountFor, promotionPool: pool, variableStore: options.variableStore, manifestCheck: options.manifestCheck, soulReminder: options.soulReminder }) }
      catch (error) { throw sourceError(error, source.moduleId) }
    }
    const rules = sources.flatMap(source => source.rules.filter(rule => rule.enabled !== false && rule.executionScope !== 'process'))
    const observer = wireTriggerObservers(ctx, [
      ...rules,
      ...rules.flatMap(rule => (rule.actions ?? [])
        .filter(action => typeof action.actionWhen?.observe === 'function')
        .map(action => ({ id: action.id, when: action.actionWhen }))),
    ], { plugin: options.plugin ?? 'rule-engine', warnOnce })
    if (observer) releases.push(observer)
    for (const source of sources) for (const [ruleIndex, rule] of source.rules.entries()) {
      if (rule.executionScope === 'process') continue
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
        if (action.kind === 'request-params' && action.maxTokens !== undefined) options.collectRequestBudget({ action, rule, id: action.id, sourceModuleId: moduleId,
          actionWhen: action.actionWhen, bypassRuleWhen: action.bypassRuleWhen })
        if (isProviderSystemRolesAction(action)) {
          options.collectProviderSystemRoles({ action, rule, id: action.id, actionWhen: action.actionWhen, bypassRuleWhen: action.bypassRuleWhen })
          continue
        }
        if (isMessageShapeGuardsAction(action)) {
          options.collectMessageShapeGuards({ action, rule, id: action.id, actionWhen: action.actionWhen, bypassRuleWhen: action.bypassRuleWhen })
          continue
        }
        if (isCurrentSystemSnapshotAction(action)) {
          options.collectCurrentSystemSnapshot({ action, rule, id: action.id, actionWhen: action.actionWhen, bypassRuleWhen: action.bypassRuleWhen })
          continue
        }
        if (isRewindAction(action)) {
          options.collectRewind({ action, rule, id: action.id, actionWhen: action.actionWhen, bypassRuleWhen: action.bypassRuleWhen })
          continue
        }
        if (action.kind === 'host-control' && isRepeatCompactionAction(action)) {
          options.collectRepeatCompaction?.({ action, rule, id: action.id, sequence: action.channelOrder, sourceModuleId: moduleId,
            ruleIndex: item.ruleIndex, ruleActionIndex: action.actionIndex, actionWhen: action.actionWhen, bypassRuleWhen: action.bypassRuleWhen })
          continue
        }
        if (action.kind === 'persona' || action.kind === 'subagent-params' || isReadLimitsAction(action) || isDelegationLimitsAction(action) || isFilesystemPolicyAction(action) || isApprovalDecisionsAction(action) || isEscalationDecisionAction(action) || isProviderHookDecisionsAction(action)) {
          const collect = isProviderHookDecisionsAction(action) ? options.collectProviderHookDecisions : isEscalationDecisionAction(action) ? options.collectEscalationDecisions : isApprovalDecisionsAction(action) ? options.collectApprovalDecisions : isFilesystemPolicyAction(action) ? options.collectFilesystemPolicy : action.kind === 'persona' ? options.collectPersona : isReadLimitsAction(action) ? options.collectReadLimits : isDelegationLimitsAction(action) ? options.collectDelegationLimits : options.collectSubagentParams
          collect({ action, rule, id: action.id, sequence: action.channelOrder, sourceModuleId: moduleId,
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
          const entry = { rule, action, kind: action.kind, handler, toolSurface: action.kind === 'tool-visibility', toolDescription: action.kind === 'assembly' && (action.target?.toolDescriptions?.length > 0 || action.target?.skillDescriptions?.length > 0), contextReplacement: action.kind === 'assembly' && action.target?.contexts?.replace?.length > 0, sequence: action.channelOrder, sourceModuleId: moduleId, ruleId: rule.id, ruleIndex: item.ruleIndex, ruleActionIndex: action.actionIndex, id: action.id, actionWhen: action.actionWhen, bypassRuleWhen: action.bypassRuleWhen }
          if (channel === 'agent/pre-step' && point.waterfallPosition === 'default') injections.get(moduleId).ruleActions.push(entry)
          else handlers.push(entry)
          if (handler.resultTextPlan !== undefined) {
            const observe = (exec, reason) => options.onOutcome?.({ moduleId, ruleId: rule.id, actionId: action.id,
              channel: 'tool:results', definitionRevision: rule.definitionRevision, agentId: exec?.agent?.id ?? options.agent?.id,
              outcome: reason === undefined ? 'hit' : 'unavailable', identityOutcome: reason === undefined ? 'matched' : 'target-mismatch',
              ...(reason === undefined ? {} : { reason }) })
            handler.resultTextPlan.onUnavailable = (reason, exec) => observe(exec, reason)
            handler.resultTextPlan.onApplied = exec => observe(exec)
          }
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
  const currentSystemSnapshot = options.agent === undefined ? undefined : registerCurrentSystemSnapshot(options.agent)
  const messageShapeGuards = options.agent === undefined ? undefined : registerMessageShapeGuards(options.agent)
  const providerSystemRoles = options.agent === undefined ? undefined : registerProviderSystemRoles(options.agent)
  const repeatSessions = new Set(), prunerBlockedSessions = new Set()
  const repeatRelease = ctx.on('tools/post-execute', async (exec, result, next) => {
    const enabled = repeatSessions.has(exec?.agent?.session)
    const decision = await next()
    if (!active || exec?.signal?.aborted || !enabled) return decision
    return filterRepeatReminderDecision(decision, true)
  }, { prepend: true })
  const prunerRelease = typeof ctx.inject === 'function'
    ? installPrunerGate(ctx, session => prunerBlockedSessions.has(session) ? false : undefined)
    : () => {}
  let points = new Map()
  const listeners = new Map()
  const ruleOwners = new WeakMap()
  const resultTextOwner = {}
  let releaseProviderHook
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
  const releaseRewind = options.agent === undefined ? undefined : registerRewindControl(options.agent, capability => active
    && [...records.values()].some(record => record.rewind.some(entry => entry.action.capability === capability && actionMatches(entry, assemblyFrame({ agent: options.agent })))))
  let layers
  const readLimitEntries = () => [...records.values()].flatMap(record => record.readLimits)
  const delegationLimitEntries = () => [...records.values()].flatMap(record => record.delegationLimits)
  const filesystemEntries = () => [...records.values()].flatMap(record => record.filesystemPolicy)
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
    const record = { source, points: [], text: [], personas: [], subagentParams: [], requestBudgets: [], readLimits: [], delegationLimits: [], filesystemPolicy: [], providerHookDecisions: [], repeatCompaction: [], currentSystemSnapshot: [], rewind: [], messageShapeGuards: [], dispose: undefined }
    record.approvalDecisions = []
    record.providerSystemRoles = []
    record.escalationDecisions = []
    for (const rule of source.rules) {
      bindFilesystemPolicyDependencies(rule, source.moduleId, options.onOutcome)
      bindApprovalDecisionsDependencies(rule, source.moduleId, options.onOutcome)
      bindEscalationDecisionDependencies(rule, source.moduleId, options.onOutcome)
      bindProviderHookDependencies(rule, source.moduleId, options.onOutcome)
      bindCurrentSystemSnapshotDependencies(rule, source.moduleId, options.onOutcome)
      bindMessageShapeGuardsDependencies(rule, source.moduleId, options.onOutcome)
      bindProviderSystemRolesDependencies(rule, source.moduleId, options.onOutcome)
    }
    for (const rule of source.rules) bindDelegationLimitsDependencies(rule, source.moduleId, delegationLimitEntries, options.onOutcome)
    for (const rule of source.rules) bindReadLimitsDependencies(rule, source.moduleId, readLimitEntries, options.onOutcome)
    for (const rule of source.rules) bindRepeatCompactionDependencies(rule, source.moduleId, (action, agent) => action.capability === 'compaction-tool-result-pruner'
      ? { available: prunerRelease.available?.(agent) === true, reason: 'official toolResultPruner unavailable' }
      : repeatReminderStatus(agent), options.onOutcome)
    for (const rule of source.rules) bindResultTextDependencies(rule, source.moduleId, options.onOutcome)
    for (const rule of source.rules) {
      const budgets = rule.actions.filter(action => action.kind === 'request-params' && action.maxTokens !== undefined)
      if (budgets.length === 0) continue
      const dependent = new Set(rule.actions.filter(action => budgets.some(budget => budget.branchPath.every((part, index) => action.branchPath[index] === part))).map(action => action.id))
      rule.requestBudgetAvailable = (entry, frame) => {
        if (!dependent.has(entry.ruleActionId ?? entry.id)) return true
        const agent = frame.subject?.agent ?? options.agent
        const status = requestBudgetStatus(agent)
        const conflict = requestBudgetConflict(frame)
        if (status.available && !conflict) return true
        try { options.onOutcome?.({ moduleId: source.moduleId, ruleId: rule.id, channel: 'request:budget', outcome: 'unavailable',
          identityOutcome: 'condition-unavailable', definitionRevision: rule.definitionRevision, agentId: agent?.id,
          actionId: budgets[0].id, reason: conflict ? frame.requestBudgetReason : status.reason }) } catch { /* 只读诊断 */ }
        return false
      }
    }
    for (const rule of source.rules) if (rule.actions.some(action => action.kind === 'persona' && action.instructionsMaxBytes !== undefined)) {
      const dependent = new Set(rule.actions.filter(action => rule.actions.some(budget => budget.kind === 'persona' && budget.instructionsMaxBytes !== undefined
        && budget.branchPath.every((part, index) => action.branchPath[index] === part))).map(action => action.id))
      rule.instructionsAvailable = entry => !dependent.has(entry.ruleActionId ?? entry.id) || instructionsBudgetStatus(options.agent).available
    }
    for (const rule of source.rules) {
      const params = rule.actions.filter(action => action.kind === 'subagent-params').map(action => ({ action,
        dependent: new Set(rule.actions.filter(candidate => action.branchPath.every((part, index) => candidate.branchPath[index] === part)).map(candidate => candidate.id)) }))
      if (params.length === 0) continue
      rule.subagentAvailable = (entry, frame) => params.every(({ action, dependent }) => !dependent.has(entry.ruleActionId ?? entry.id)
        || !frame.subagentConflicts?.has(`${action.tool}/${action.provider}`) && subagentParamsStatus(ctx, action,
          frame.args[frame.channel === 'system-prompt/assemble' ? 1 : 0], options.agent).available)
    }
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
      collectSubagentParams(entry) { record.subagentParams.push(entry) },
      collectRequestBudget(entry) { record.requestBudgets.push(entry) },
      collectReadLimits(entry) { record.readLimits.push(entry) },
      collectDelegationLimits(entry) { record.delegationLimits.push(entry) },
      collectFilesystemPolicy(entry) { record.filesystemPolicy.push(entry) },
      collectApprovalDecisions(entry) { record.approvalDecisions.push(entry) },
      collectEscalationDecisions(entry) { record.escalationDecisions.push(entry) },
      collectProviderHookDecisions(entry) { record.providerHookDecisions.push(entry) },
      collectRepeatCompaction(entry) { record.repeatCompaction.push(entry) },
      collectCurrentSystemSnapshot(entry) { record.currentSystemSnapshot.push(entry) },
      collectRewind(entry) { record.rewind.push(entry) },
      collectMessageShapeGuards(entry) { record.messageShapeGuards.push(entry) },
      collectProviderSystemRoles(entry) { record.providerSystemRoles.push(entry) },
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
    if (old?.instructionsMaxBytes === plan.instructionsMaxBytes && old?.customPrefix === plan.customPrefix && old?.identityEntries?.length === plan.identityEntries?.length
      && old?.identityEntries?.every((entry, index) => entry === plan.identityEntries[index])
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
    frame.ignoreInstructionsDependency = preview
    const selected = entries.filter(entry => {
      if (!matchesAudience(entry.action.audience, audience)) { frame.actionOutcomes.set(entry, 'miss'); return false }
      return actionMatches(entry, frame)
    })
    if (!preview) for (const entry of entries) {
      if (entry.action.stripDefaultIdentity === undefined || selected.includes(entry)) continue
      const outcome = frame.decisions.get(entry.rule)?.outcome ?? 'miss'
      try { options.onOutcome?.({ moduleId: entry.sourceModuleId, ruleId: entry.rule.id, channel: `persona:identity:${entry.action.stripDefaultIdentity}`, outcome,
        identityOutcome: outcome === 'error' ? 'error' : outcome === 'unavailable' ? 'condition-unavailable' : 'condition-miss',
        definitionRevision: entry.rule.definitionRevision, actionId: entry.id, agentId: context.agent?.id }) } catch { /* 诊断不改变装配 */ }
    }
    if ([...frame.decisions.values()].some(decision => decision.outcome === 'error')) throw new Error('persona condition evaluation failed; keeping previous contribution')
    const prompt = getService(ctx, 'systemPrompt')
    let plan = planPersonaActions(selected, context, prompt, options.persona, options.variableStore, warnOnce, preview)
    if (preview) plan = planPersonaActions(selected.filter(entry => entry.rule.instructionsAvailable?.(entry) !== false), context, prompt, options.persona, options.variableStore, warnOnce, true)
    frame.ignoreInstructionsDependency = false
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
    if (!preview) plan.instructionsObservations = entries.filter(entry => entry.action.instructionsMaxBytes !== undefined).map(entry => {
      const outcome = frame.actionOutcomes.get(entry) ?? 'miss'
      return { moduleId: entry.sourceModuleId, ruleId: entry.rule.id, channel: 'persona:instructions', outcome,
        identityOutcome: outcome === 'hit' ? 'matched' : outcome === 'error' ? 'error' : outcome === 'unavailable' ? 'condition-unavailable' : 'condition-miss',
        definitionRevision: entry.rule.definitionRevision, actionId: entry.id, agentId: context.agent?.id,
        ...(outcome === 'unavailable' ? { reason: instructionsBudgetStatus(context.agent).reason } : {}) }
    })
    return plan
  }
  const prepareSubagentParams = (context = {}, preview = false) => {
    context = context.agent === undefined ? { agent: options.agent, ...context } : context
    const frame = assemblyFrame(context)
    frame.ignoreSubagentDependency = preview
    const entries = [...records.values()].flatMap(record => record.subagentParams).sort(compareEntries)
    const selected = entries.filter(entry => actionMatches(entry, frame))
    frame.ignoreSubagentDependency = false
    const plan = []
    const conflicts = new Set()
    for (const entry of selected) {
      const action = entry.action
      const previous = plan.find(value => value.tool === action.tool && value.provider === action.provider)
      if (previous !== undefined && previous.maxDepth !== action.maxDepth) conflicts.add(`${action.tool}/${action.provider}`)
      if (previous === undefined) plan.push(Object.freeze({ tool: action.tool, provider: action.provider, maxDepth: action.maxDepth,
        contextOrder: getService(ctx, 'systemPrompt')?.getContextOrder?.('SUBAGENT_DELEGATION') ?? 0 }))
    }
    if (preview && conflicts.size > 0) throw new TypeError(`subagent-params maxDepth conflict for ${[...conflicts].join(', ')}`)
    frame.subagentConflicts = conflicts
    return { values: Object.freeze(plan.filter(entry => !conflicts.has(`${entry.tool}/${entry.provider}`))), observations: preview ? [] : entries.map(entry => {
      const conflict = conflicts.has(`${entry.action.tool}/${entry.action.provider}`)
      const outcome = conflict ? 'unavailable' : frame.actionOutcomes.get(entry) ?? 'miss'
      const status = subagentParamsStatus(ctx, entry.action, context)
      return { moduleId: entry.sourceModuleId, ruleId: entry.rule.id, channel: 'subagent:params', outcome,
        identityOutcome: outcome === 'hit' ? 'matched' : outcome === 'error' ? 'error' : outcome === 'unavailable' ? 'condition-unavailable' : 'condition-miss',
        definitionRevision: entry.rule.definitionRevision, actionId: entry.id, agentId: context.agent?.id,
        ...(outcome === 'unavailable' ? { reason: conflict ? `委派深度 maxDepth conflict: ${entry.action.tool}/${entry.action.provider}` : status.reason } : {}) }
    }) }
  }
  const requestBudgetConflict = (frame, preview = false) => {
    if (frame.requestBudgetConflict !== undefined) return frame.requestBudgetConflict
    const checking = { ...frame, decisions: new Map(), actionDecisions: new Set(), actionOutcomes: new Map(), reminders: new Map(),
      ignoreRequestBudgetDependency: true, onOutcome: undefined }
    const selected = [...records.values()].flatMap(record => record.requestBudgets).filter(entry => actionMatches(entry, checking))
    const values = new Set(selected.map(entry => entry.action.maxTokens))
    const counts = new Set()
    const addCounts = (node, entry) => {
      if (node?.phase?.maxPromoteSteps !== undefined) counts.add(node.phase.maxPromoteSteps)
      for (const child of node?.all ?? []) addCounts(child, entry)
      for (const child of node?.any ?? []) {
        const matches = compileWhen(child, { ctx, promotionPool: pool, moduleId: entry.sourceModuleId,
          standingMountFor: options.standingMountFor, variableStore: options.variableStore,
          manifestCheck: options.manifestCheck, soulReminder: options.soulReminder,
          resolveAction: id => {
            const config = entry.rule.actions.find(action => action.id === id)?.compiledConfig
            return config === undefined ? undefined : { ...config, sourceModuleId: entry.sourceModuleId }
          } })(checking.subject)
        if (matches !== true) continue
        addCounts(child, entry)
        break
      }
    }
    for (const entry of selected) {
      if (!entry.bypassRuleWhen) addCounts(entry.rule.conditionTrees.when, entry)
      addCounts(entry.action.conditions, entry)
    }
    const reason = values.size > 1 ? 'request-params maxTokens conflict' : counts.size > 1 ? 'request-params maxTokens bootstrap step conflict' : undefined
    if (reason !== undefined && preview) throw new TypeError(reason)
    if (reason !== undefined) warnOnce(reason)
    frame.requestBudgetConflict = reason !== undefined
    frame.requestBudgetReason = reason
    return frame.requestBudgetConflict
  }
  releaseProviderHook = providerHookDecisionsState.register(ctx, options.agent, (input, channel, result) => {
    const entries = [...records.values()].flatMap(record => record.providerHookDecisions)
    if (entries.length === 0 || input?.agent !== options.agent) return undefined
    const frame = ruleFrame(channel, [{ ...input, modelSelection: input.modelSelection ?? {} }, result].filter(value => value !== undefined), warnOnce, ctx, report)
    // Hook model conditions may use only this event's explicit selection; never read Agent current model.
    frame.subject = { ...frame.subject, model: input.modelSelection?.model }
    return { status: 'sealed', providerHookDecisions: prepareProviderHookDecisions(entries, frame) }
  })
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
        repeatSessions.clear(); prunerBlockedSessions.clear()
        requestBudgetConflict(ruleFrame('agent/request', [{ agent: options.agent }], warnOnce, ctx), true)
        prepareReadLimits(readLimitEntries(), ruleFrame('system-prompt/assemble', [{}, { agent: options.agent }], warnOnce, ctx), true)
        prepareDelegationLimits(delegationLimitEntries(), ruleFrame('system-prompt/assemble', [{}, { agent: options.agent }], warnOnce, ctx), true)
        prepareApprovalDecisions([...records.values()].flatMap(record => record.approvalDecisions), ruleFrame('system-prompt/assemble', [{}, { agent: options.agent }], warnOnce, ctx))
        prepareSubagentParams({}, true)
        prepareProviderHookDecisions([...records.values()].flatMap(record => record.providerHookDecisions), ruleFrame('system-prompt/assemble', [{}, { agent: options.agent }], warnOnce, ctx))
        const personaPlan = preparePersona({}, true)
        const text = [...records.values()].flatMap(record => record.text)
        if (text.length > 0) layers ??= createLayerRuntime(ctx, warnOnce, { agent: options.agent, turnStopBudgets: new Map(), sourceError })
        layers?.replace(text)
        publishPoints()
        if (options.externalAssembly !== true && releaseAssembly === undefined
          && ([...points.values()].some(point => point.handlers.some(entry => entry.toolSurface || entry.toolDescription || entry.contextReplacement || entry.handler.resultTextPlan !== undefined)) || [...records.values()].some(record => record.providerSystemRoles.length > 0 || record.messageShapeGuards.length > 0 || record.currentSystemSnapshot.length > 0 || record.escalationDecisions.length > 0 || record.approvalDecisions.length > 0 || record.personas.length > 0 || record.subagentParams.length > 0 || record.readLimits.length > 0 || record.delegationLimits.length > 0 || record.filesystemPolicy.length > 0))) {
          const scope = scopeOf(ctx)
          releaseAssembly = installToolStepAssembly(ctx, {
            knows: agent => active && ([...points.values()].some(point => point.handlers.some(entry => entry.toolSurface || entry.toolDescription || entry.contextReplacement || entry.handler.resultTextPlan !== undefined)) || [...records.values()].some(record => record.providerSystemRoles.length > 0 || record.messageShapeGuards.length > 0 || record.currentSystemSnapshot.length > 0 || record.escalationDecisions.length > 0 || record.approvalDecisions.length > 0 || record.personas.length > 0 || record.subagentParams.length > 0 || record.readLimits.length > 0 || record.delegationLimits.length > 0 || record.filesystemPolicy.length > 0))
              && (options.agent === undefined ? scope === undefined || scopeChainOf(agent).includes(scope) : agent === options.agent),
            ensureFresh: async () => {},
            assemble: (context, invoke) => { runtime.prepareAssembly(context); return invoke() },
            settle: (assembly, context) => runtime.settleToolSurface(assembly, context),
          })
        }
        if (personaPlan !== undefined) commitPersona(personaPlan)
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
    prepareAssembly(context) {
      if (!active) return
      if (context !== undefined) assemblyFrames.delete(context)
      const policyFrame = assemblyFrame(context ?? { agent: options.agent })
      currentSystemSnapshot?.setEnabled([...records.values()].flatMap(record => record.currentSystemSnapshot).some(entry => actionMatches(entry, policyFrame)), context)
      messageShapeGuards?.setEnabled([...records.values()].flatMap(record => record.messageShapeGuards).some(entry => actionMatches(entry, policyFrame)), context)
      providerSystemRoles?.prepare([...records.values()].flatMap(record => record.providerSystemRoles), policyFrame, context)
      const session = policyFrame.subject?.agent?.session ?? context?.agent?.session ?? options.agent?.session
      const policies = [...records.values()].flatMap(record => record.repeatCompaction)
      if (session !== undefined) {
        repeatSessions.delete(session); prunerBlockedSessions.delete(session)
        for (const entry of policies) if (entry.rule.enabled !== false && actionMatches(entry, policyFrame)) {
          if (entry.action.capability === 'repeat-tool-reminder') repeatSessions.add(session)
          if (entry.action.capability === 'compaction-tool-result-pruner') {
            if (prunerRelease.available?.(policyFrame.subject?.agent ?? context?.agent ?? options.agent) === true) prunerBlockedSessions.add(session)
            else { try { options.onOutcome?.({ moduleId: entry.sourceModuleId, ruleId: entry.rule.id, actionId: entry.id, channel: 'host:compaction-tool-result-pruner', outcome: 'unavailable', identityOutcome: 'condition-unavailable', reason: 'official toolResultPruner injection unavailable' }) } catch {} }
          }
        }
      }
      const step = toolStepFor(context)
      if (step != null) step.escalationDecisions = prepareEscalationDecisions([...records.values()].flatMap(record => record.escalationDecisions), assemblyFrame(context ?? { agent: options.agent }), context)
      if (step != null) step.approvalDecisions = prepareApprovalDecisions([...records.values()].flatMap(record => record.approvalDecisions), assemblyFrame(context ?? { agent: options.agent }))
      const filesystem = prepareFilesystemPolicy(filesystemEntries(), assemblyFrame(context ?? { agent: options.agent }))
      if (step != null) { step.filesystemPolicy = filesystem.values; step.filesystemPolicyObservations = filesystem.observations }
      const reading = prepareReadLimits(readLimitEntries(), assemblyFrame(context ?? { agent: options.agent }))
      if (step != null) { step.readLimits = reading.values; step.readLimitsObservations = reading.observations }
      const limits = prepareDelegationLimits(delegationLimitEntries(), assemblyFrame(context ?? { agent: options.agent }))
      if (step != null) { step.delegationLimits = limits.values; step.delegationLimitsObservations = limits.observations }
      const delegation = prepareSubagentParams(context)
      if (step != null) { step.subagentParams = delegation.values; step.subagentObservations = delegation.observations }
      if (step != null) {
        const entries = [...points.values()].flatMap(point => point.handlers.filter(entry => entry.handler.resultTextPlan !== undefined)).sort(compareEntries)
        const frames = new WeakMap()
        const plans = entries.map(entry => Object.freeze({
          ...entry.handler.resultTextPlan, owner: resultTextOwner, entry,
          edits: Object.freeze(entry.handler.resultTextPlan.edits.map(value => Object.freeze({ ...value }))),
          matches(exec, result) {
            let frame = frames.get(exec)
            if (frame === undefined) {
              frame = ruleFrame('tools/post-execute', [exec, result], warnOnce, ctx, report)
              frame.subject = { ...frame.subject, model: step.modelSelection?.model }
              frames.set(exec, frame)
            }
            return actionMatches(entry, frame)
          },
        }))
        step.resultTextPlans = Object.freeze([...(step.resultTextPlans ?? []).filter(plan => plan.owner !== resultTextOwner), ...plans]
          .sort((a, b) => compareEntries(a.entry, b.entry)))
      }
      const descriptions = [...points.values()].flatMap(point => point.handlers.filter(entry => entry.toolDescription)).sort(compareEntries)
      if (descriptions.length > 0) {
        const frame = assemblyFrame(context)
        if (step != null) step.toolDescriptionSource ??= step.toolSet.view(context.agent)
        for (const entry of descriptions) for (const field of ['toolDescriptions', 'skillDescriptions']) {
          if (!entry.action.target[field]?.length) continue
          const hit = actionMatches(entry, frame)
          const accepted = frame.frozenActionMatches ??= new Map()
          accepted.set(entry, hit)
          const outcome = frame.actionOutcomes.get(entry) ?? 'miss'
          const ruled = frame.decisions.get(entry.rule)
          const condition = ruled?.outcome === 'unavailable' ? entry.rule.conditionTrees?.when
            : entry.bypassRuleWhen || ruled?.hit ? entry.action.conditions : undefined
          const missingTool = outcome === 'unavailable' && step != null && condition?.tool !== undefined
            && !step.toolDescriptionSource.has(condition.tool.name) ? condition.tool.name : undefined
          const conditionReason = missingTool === undefined ? undefined
            : `tool condition ${JSON.stringify(missingTool)} target missing from resolved tool step; skipped`
          const reasons = []
          const plan = { entries: Object.freeze(hit ? entry.action.target[field].map(value => Object.freeze({ ...value })) : []),
            plugin: `module:${entry.sourceModuleId}/rule:${entry.rule.id}`, warnOnce, owner: ctx }
          if (hit) {
            if (step == null) reasons.push(`assembly.${field} requires a resolved tool step; skipped`)
            else if (field === 'toolDescriptions') applyToolDescriptions(step.toolDescriptionSource, [...(step.toolDescriptions ?? []), plan].map(source => ({ ...source, entries: source.entries.filter(value => value.name !== 'run_code'), source })), (value, reason) => { if (value.source === plan) reasons.push(reason) })
          }
          plan.observation = Object.freeze({ moduleId: entry.sourceModuleId, ruleId: entry.rule.id, channel: field === 'toolDescriptions' ? 'tool:descriptions' : 'skill:descriptions',
            actionId: entry.id, agentId: context.agent?.id, definitionRevision: entry.rule.definitionRevision,
            outcome: reasons.length > 0 ? 'unavailable' : outcome,
            identityOutcome: reasons.length > 0 ? 'target-mismatch' : hit ? 'matched' : outcome === 'error' ? 'error' : outcome === 'unavailable' ? 'condition-unavailable' : 'condition-miss',
            ...(reasons.length > 0 ? { reason: reasons.join('; ') } : conditionReason === undefined ? {} : { reason: conditionReason }) })
          if (step == null) { try { options.onOutcome?.(plan.observation) } catch { /* 诊断不改变装配 */ } }
          else {
            const plans = step[field] ??= []
            plans.push(Object.freeze(plan))
          }
        }
      }
      let plan
      try { plan = preparePersona(context) } catch (error) {
        const step = toolStepFor(context)
        if (step != null) step.instructionsPlan = persona?.plan
        throw error
      }
      if (plan !== undefined) {
        commitPersona(plan)
        if (context !== undefined) assemblyPersonaPlans.set(context, plan)
        const step = toolStepFor(context)
        if (step != null) step.instructionsPlan = plan
      }
    },
    readInstructionsBudget(modelSelection) {
      const step = modelSelection === undefined ? undefined : toolStepFor({ agent: options.agent, modelSelection })
      if (modelSelection !== undefined && (step == null || step.status !== 'sealed')) return undefined
      return (modelSelection === undefined ? persona?.plan : step.instructionsPlan)?.instructionsMaxBytes
    },
    async settleToolSurface(assembly, context) {
      const frame = assemblyFrame(context, assembly)
      let result = applyTransportDescriptions(assembly, toolStepFor(context))
      await settleSkillDescriptions(ctx, context)
      const handlers = [...points.values()].flatMap(point => point.handlers.filter(entry => entry.toolSurface)).sort(compareEntries)
      for (const entry of handlers) {
        if (!active) break
        if (!actionMatches(entry, frame)) { entry.miss?.(frame); continue }
        result = await entry.handler(result, context, () => result, frame)
      }
      for (const observation of assemblyPersonaPlans.get(context)?.instructionsObservations ?? []) {
        try { options.onOutcome?.(observation) } catch { /* 只读诊断不改变已接受装配 */ }
      }
      for (const observation of toolStepFor(context)?.subagentObservations ?? []) {
        try { options.onOutcome?.(observation) } catch { /* 只读诊断不改变已接受装配 */ }
      }
      for (const observation of toolStepFor(context)?.readLimitsObservations ?? []) {
        try { options.onOutcome?.(observation) } catch { /* 只读诊断不改变已接受装配 */ }
      }
      for (const observation of toolStepFor(context)?.delegationLimitsObservations ?? []) {
        try { options.onOutcome?.(observation) } catch { /* 只读诊断不改变已接受装配 */ }
      }
      for (const observation of toolStepFor(context)?.filesystemPolicyObservations ?? []) {
        try { options.onOutcome?.(observation) } catch { /* 只读诊断不改变已接受装配 */ }
      }
      for (const plan of toolStepFor(context)?.toolDescriptions ?? []) if (plan.owner === ctx) {
        try { options.onOutcome?.(toolDescriptionObservation(plan, toolStepFor(context))) } catch { /* 只读诊断不改变已接受装配 */ }
      }
      for (const plan of toolStepFor(context)?.skillDescriptions ?? []) if (plan.owner === ctx) {
        try { options.onOutcome?.(skillDescriptionObservation(plan, toolStepFor(context))) } catch { /* 只读诊断不改变已接受装配 */ }
      }
      return stripPersonaIdentity(result, assemblyPersonaPlans.get(context), options.onOutcome, context.agent?.id)
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
      releaseProviderHook?.()
      repeatRelease?.()
      prunerRelease?.()
      repeatSessions.clear(); prunerBlockedSessions.clear()
      currentSystemSnapshot?.dispose()
      releaseRewind?.()
      messageShapeGuards?.dispose()
      providerSystemRoles?.dispose()
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
