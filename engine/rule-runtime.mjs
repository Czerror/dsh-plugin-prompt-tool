import { prepareAction } from './actions/index.mjs'
import { applyPromptConfigSources } from './executor.mjs'
import { createPreStepSource, moduleSourceId } from './pre-step-source.mjs'
import { wireLayers } from './layers.mjs'
import { rebindConditions, validateDeliverySources } from './rule-spec.mjs'
import { wireTriggerObservers } from './trigger.mjs'
import { ruleFrame, actionMatches } from './conditions/evaluation.mjs'
import { createPromotionPool } from './promotion-pool.mjs'
import { PROMOTE_EVENTS, createWarnOnce, getService } from './shared.mjs'
import { PRE_STEP_COORDINATOR_SERVICE } from './service-names.mjs'

const noNext = new Set(['agent/inbox/inserted', 'agent/turn-stopping', 'subagent/start', 'subagent/end'])
// 判据与 `order.mjs#compareConfigSequence` 有意不同：这里在同通道同点内按 moduleId 字母序 +
// 规则声明序（ruleIndex）定位，`compareConfigSequence` 按 `sequence`（= 编辑器顺序，缺省回退
// `order`）+ `ruleId` 排。收敛到 `ruleId` 会打断现网依赖的「编辑器顺序 = 执行顺序」，别顺手统一。
const compare = (a, b) => a.action.channelOrder - b.action.channelOrder
  || a.moduleId.localeCompare(b.moduleId) || a.ruleIndex - b.ruleIndex || a.action.actionIndex - b.action.actionIndex

const sourceError = (error, moduleId) => Object.assign(new Error(String(error?.message ?? error), { cause: error }), { sourceModuleId: moduleId })

/** 所有来源只进入这个装配入口；受众限定固定效果要求 ctx 属于 options.agent 的 scope。 */
export function mountRuleSources(ctx, sources, options = {}) {
  validateDeliverySources(sources)
  // 晋升相位池先建：条件的挂载期绑定要用它（`phase` 的订阅模式从池取实例，见 promotion-pool.mjs）。
  // 池自己订阅 `session/event` 并统一喂事件；自建的随本挂载释放，注入的由创建者释放。
  const coordinator = (() => {
    const service = getService(ctx, PRE_STEP_COORDINATOR_SERVICE)
    return service !== null && typeof service === 'object' && typeof service.registerPreset === 'function'
      ? service
      : undefined
  })()
  const pool = options.promotionPool ?? coordinator?.promotionPool ?? createPromotionPool(ctx)
  const ownsPool = options.promotionPool === undefined && coordinator?.promotionPool === undefined
  // 条件绑定**在这里**发生：`compileRules` 编译期没有挂载 scope 的 ctx（preset 条件在那边恒
  // UNAVAILABLE 且静默）。必须早于事件订阅与动作注册——动作级 `actionWhen.observe` 是订阅通道，
  // 绑晚了那一类谓词会漏事件。`standingMountFor` 是可选兜底（官方包缺席＝没有兜底，不是错误）。
  const warnOnce = options.warnOnce ?? createWarnOnce(ctx, options.plugin ?? 'rule-engine')
  // 非 pre-step 动作仍共享一次 ruleFrame；规则实例没有来源字段（RuleDefinition 不暴露 moduleId），
  // 因此保留一份局部 rule→module 映射。它不是 pre-step 来源事实的重建，不参与 pre-step 的 source sink。
  const report = options.onOutcome === undefined ? undefined : (() => {
    const moduleOfRule = new Map()
    for (const source of sources) for (const rule of source.rules) if (!moduleOfRule.has(rule)) moduleOfRule.set(rule, source.moduleId)
    return (rule, channel, outcome) => options.onOutcome({ moduleId: moduleOfRule.get(rule), ruleId: rule.id, channel, outcome })
  })()
  const releases = []
  // 自建池随本挂载释放；协调器/调用方注入的池由创建者释放（生命周期随归属，不跨界代管）。
  if (ownsPool) releases.push(() => pool.dispose())
  const points = new Map()
  // 续跑预算按来源模块一份：同模块的 turn-stop 动作共享上限，
  // 不再按动作各建一份。本 mount 可能含多个模块（agent-assembly 一次装载全部启用模块），
  // 因此按 moduleId 分档；来源 id 缺失时落空串兜底键（与 wireTurnStops 同源）。
  const turnStopBudgets = new Map()
  const injections = new Map(sources.map(source => [source.moduleId, { moduleId: source.moduleId, sourceId: moduleSourceId(source.moduleId), configs: [], ruleActions: [] }]))
  // 动作级分支条件（actionWhen）也要喂 session/event：否则 else / 嵌套 if 里的 phase / count
  // 谓词永远收不到事件，状态停在冷扫那一刻（规则级 when 已由 rules 覆盖，动作级单独补齐）。
  let active = true
  const bind = (item, on) => prepareAction(item.action, { plugin: options.plugin, warnOnce, promptConfigOptions: item.rule.promptConfigOptions, on })(ctx)
  try {
    for (const source of sources) {
      try { rebindConditions([source], { ctx, standingMountFor: options.standingMountFor, promotionPool: pool, variableStore: options.variableStore }) }
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
        releases.push(wireLayers(ctx, textConfigs, warnOnce, {
          agent: options.agent,
          turnStopBudgets,
          sourceError,
          on: (channel, handler) => {
            if (channel !== point.channel) throw new TypeError(`rule action registered outside ${point.channel}: ${channel}`)
            handlers.push({ handler }); return () => {}
          },
        }))
        textConfigs = []
      }
      for (const item of point.items) {
        const { action, rule, moduleId } = item
        if (action.kind === 'inject-text') {
          const config = { ...action.compiledConfig, rule, sourceModuleId: moduleId, variableStore: options.variableStore, group: undefined, exclusive: false, enabled: true, actionWhen: action.actionWhen, bypassRuleWhen: action.bypassRuleWhen }
          if (config.layer === 'pre-step') injections.get(moduleId).configs.push(config)
          else textConfigs.push(config)
          continue
        }
        flushLayers()
        const created = []
        const on = (channel, handler) => {
          if (channel !== point.channel) throw new TypeError(`rule action registered outside ${point.channel}: ${channel}`)
          const entry = { rule, handler, sequence: action.channelOrder, sourceModuleId: moduleId, ruleId: rule.id, ruleActionIndex: action.actionIndex, id: action.id, actionWhen: action.actionWhen, bypassRuleWhen: action.bypassRuleWhen }
          if (channel === 'agent/pre-step' && point.waterfallPosition === 'default') injections.get(moduleId).ruleActions.push(entry)
          else handlers.push(entry)
          created.push(entry)
          // 显式放弃：handler 的存活期由下面唯一的 `ctx.on(point.channel, …)` 统一撤销，
          // 这里再返回一个真 disposer 会与它重复释放同一批 handler。
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
      releases.push(ctx.on(point.channel, (...args) => {
        const free = noNext.has(point.channel)
        const payload = free ? args : args.slice(0, -1)
        const next = free ? () => undefined : args[args.length - 1]
        if (!active) return next()
        // 帧构造失败（如宿主 snapshotEvents 抛错）只告警并按「无事实」跳过本点动作，
        // 不得把异常抛出整条分派。
        let frame
        try {
          frame = ruleFrame(point.channel, payload, warnOnce, ctx, report)
        } catch (error) {
          warnOnce(`rule engine: frame construction failed on ${point.channel}: ${String(error?.message ?? error)}`)
          return next()
        }
        if (free) {
          let pending
          for (const entry of handlers) {
            const invoke = () => {
              if (!active) return undefined
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
            if (!active) continue
            if (!actionMatches(entry, frame)) { entry.miss?.(frame); continue }
            result = await entry.handler(...payload, () => result, frame)
          }
          return result
        })
        const invoke = index => {
          if (!active || index === handlers.length) return next()
          const entry = handlers[index]
          if (!actionMatches(entry, frame)) {
            entry.miss?.(frame)
            return invoke(index + 1)
          }
          return entry.handler(...payload, () => invoke(index + 1), frame)
        }
        return invoke(0)
      }, point.waterfallPosition === 'outermost' ? { prepend: true } : undefined))
    }
    // 晋升相位实例对：`options.promotion` 注入（托管路径传协调器那两份），否则从池里按配置取
    // ——池在挂载开头已建，条件绑定也用它。共用实例后事件由池统一喂，消费者一律不得再 observe。
    const promotion = options.promotion ?? coordinator?.promotion ?? {
      main: pool.tracker(PROMOTE_EVENTS.either, { includeSubagents: false }),
      withSubagents: pool.tracker(PROMOTE_EVENTS.either, { includeSubagents: true }),
    }
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
    if (preStep.length) releases.push(applyPromptConfigSources(preStep, { layers: false }))
  } catch (error) {
    active = false
    for (const dispose of releases.reverse()) { try { dispose?.() } catch {} }
    throw error
  }
  return () => {
    active = false
    for (const dispose of releases.splice(0).reverse()) { try { dispose?.() } catch {} }
  }
}
