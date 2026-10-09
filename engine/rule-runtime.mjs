import { prepareAction } from './actions/index.mjs'
import { applyPromptConfigSources } from './executor.mjs'
import { wireLayers } from './layers.mjs'
import { wireTriggerObservers } from './trigger.mjs'
import { ruleFrame, actionMatches } from './conditions/evaluation.mjs'
import { createWarnOnce } from './shared.mjs'

const noNext = new Set(['agent/inbox/inserted', 'agent/turn-stopping', 'subagent/start', 'subagent/end'])
const compare = (a, b) => a.action.channelOrder - b.action.channelOrder
  || a.moduleId.localeCompare(b.moduleId) || a.ruleIndex - b.ruleIndex || a.action.actionIndex - b.action.actionIndex

/** 所有来源只进入这个装配入口；注入保留原有批处理和协调器所有权。 */
export function mountRuleSources(ctx, sources, options = {}) {
  const warnOnce = options.warnOnce ?? createWarnOnce(ctx, options.plugin ?? 'rule-engine')
  // 诊断上报是只读旁路：把规则对象换回来源模块，供宿主区分跨模块同名 id；缺省不传即零开销。
  const report = options.onOutcome === undefined ? undefined : (() => {
    const moduleOfRule = new Map()
    for (const source of sources) for (const rule of source.rules) if (!moduleOfRule.has(rule)) moduleOfRule.set(rule, source.moduleId)
    return (rule, channel, outcome) => options.onOutcome({ moduleId: moduleOfRule.get(rule), ruleId: rule.id, channel, outcome })
  })()
  const releases = []
  const points = new Map()
  const injections = new Map(sources.map(source => [source.moduleId, { sourceId: `module:${source.moduleId}`, configs: [], ruleActions: [], officialInstructions: source.officialInstructions === true }]))
  const rules = sources.flatMap(source => source.rules.filter(rule => rule.enabled !== false))
  // 动作级分支条件（actionWhen）也要喂 session/event：否则 else / 嵌套 if 里的 phase / count
  // 谓词永远收不到事件，状态停在冷扫那一刻（规则级 when 已由 rules 覆盖，动作级单独补齐）。
  const observer = wireTriggerObservers(ctx, [
    ...rules,
    ...rules.flatMap(rule => (rule.actions ?? [])
      .filter(action => typeof action.actionWhen?.observe === 'function')
      .map(action => ({ id: action.id, when: action.actionWhen }))),
  ], { plugin: options.plugin ?? 'rule-engine', warnOnce })
  if (observer) releases.push(observer)
  let active = true
  const bind = (item, on) => prepareAction(item.action, { plugin: options.plugin, warnOnce, promptConfigOptions: item.rule.promptConfigOptions, on })(ctx)
  try {
    for (const source of sources) for (const [ruleIndex, rule] of source.rules.entries()) {
      if (rule.enabled === false) continue
      for (const action of rule.actions) {
        const item = { moduleId: source.moduleId, ruleIndex, rule, action }
        if (action.execution.lifecycle === 'registration' && action.kind === 'guard') { releases.push(bind(item)); continue }
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
          const config = { ...action.compiledConfig, rule, sourceModuleId: moduleId, group: undefined, exclusive: false, enabled: true, actionWhen: action.actionWhen, bypassRuleWhen: action.bypassRuleWhen }
          if (config.layer === 'pre-step') injections.get(moduleId).configs.push(config)
          else textConfigs.push(config)
          continue
        }
        flushLayers()
        const on = (channel, handler) => {
          if (channel !== point.channel) throw new TypeError(`rule action registered outside ${point.channel}: ${channel}`)
          const entry = { rule, handler, sequence: action.channelOrder, sourceModuleId: moduleId, ruleId: rule.id, ruleActionIndex: action.actionIndex, id: action.id, actionWhen: action.actionWhen, bypassRuleWhen: action.bypassRuleWhen }
          if (channel === 'agent/pre-step' && point.waterfallPosition === 'default') injections.get(moduleId).ruleActions.push(entry)
          else handlers.push(entry)
          return () => {}
        }
        releases.push(bind(item, on))
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
            const invoke = () => active && actionMatches(entry, frame) ? entry.handler(...payload, undefined, frame) : undefined
            pending = pending?.then ? pending.then(invoke) : invoke()
          }
          return pending
        }
        if (point.phase === 'after-next') return Promise.resolve(next()).then(async initial => {
          let result = initial
          for (const entry of handlers) {
            if (!active || !actionMatches(entry, frame)) continue
            result = await entry.handler(...payload, () => result, frame)
          }
          return result
        })
        const invoke = index => {
          if (!active || index === handlers.length) return next()
          const entry = handlers[index]
          return actionMatches(entry, frame) ? entry.handler(...payload, () => invoke(index + 1), frame) : invoke(index + 1)
        }
        return invoke(0)
      }, point.waterfallPosition === 'outermost' ? { prepend: true } : undefined))
    }
    const preStep = [...injections.values()].filter(source => source.configs.length || source.ruleActions.length)
    if (preStep.length) releases.push(applyPromptConfigSources(ctx, preStep, { layers: false, onOutcome: report }))
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
