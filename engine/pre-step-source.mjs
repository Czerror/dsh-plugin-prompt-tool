/**
 * pre-step-source — 一次 pre-step 注册所携带的事实。
 *
 * 来源生产者（mountRuleSources / 直接 inject-text）在这里绑定自己的 ctx；执行 owner
 * （coordinator 或独立 apply）只合并来源、检查 promotion 唯一性，并按 rule 分派判定上报。
 * 本模块不做注入、不排序、不读会话。
 */

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** 来源 ctx 绑定一次；批执行传入的 ctx 不覆盖来源自己的 scope。 */
export function createPreStepSource(options) {
  if (!isRecord(options)) throw new TypeError('pre-step source options must be an object')
  const { sourceId, configs, ruleActions, ctx, onOutcome, promotion } = options
  if (typeof sourceId !== 'string' || sourceId.length === 0) {
    throw new TypeError('pre-step source requires a non-empty sourceId')
  }
  if (ctx === undefined || ctx === null) throw new TypeError(`pre-step source ${sourceId} requires a ctx`)
  if (!Array.isArray(configs)) throw new TypeError(`pre-step source ${sourceId}.configs must be an array`)
  if (ruleActions !== undefined && !Array.isArray(ruleActions)) {
    throw new TypeError(`pre-step source ${sourceId}.ruleActions must be an array when present`)
  }
  if (onOutcome !== undefined && typeof onOutcome !== 'function') {
    throw new TypeError(`pre-step source ${sourceId}.onOutcome must be a function when present`)
  }
  if (promotion !== undefined && (!isRecord(promotion) || !isRecord(promotion.main) || !isRecord(promotion.withSubagents))) {
    throw new TypeError(`pre-step source ${sourceId}.promotion must be a { main, withSubagents } pair when present`)
  }
  const bound = configs.map((config, index) => {
    if (!isRecord(config)) throw new TypeError(`pre-step source ${sourceId}.configs[${index}] must be an object`)
    const resolve = config.resolve
    return {
      ...config,
      ...(typeof resolve !== 'function' ? {} : {
        resolve: input => resolve({ ...input, ctx }),
      }),
    }
  })
  return {
    sourceId,
    configs: bound,
    ...(ruleActions === undefined ? {} : { ruleActions: [...ruleActions] }),
    ctx,
    ...(onOutcome === undefined ? {} : { onOutcome }),
    ...(promotion === undefined ? {} : { promotion }),
  }
}

/** 所有有 owner 的来源必须引用同一个实例；返回该 owner（没有则 undefined）。 */
export function promotionOwnerOf(sources) {
  const owners = sources.map(source => source.promotion).filter(owner => owner !== undefined)
  if (owners.length > 1 && owners.some(owner => owner !== owners[0])) {
    throw new TypeError('pre-step sources must share one promotion owner')
  }
  return owners[0]
}

/**
 * 合并来源，建立唯一的 promotion owner 与按 rule 分派的判定上报。
 * 有实际工作（configs/ruleActions 非空）却没有 promotion，或 owner 不一致，都 fail loud。
 */
export function composePreStepSources(sources) {
  if (!Array.isArray(sources)) throw new TypeError('pre-step sources must be an array')
  if (sources.length === 0) return { configs: [], ruleActions: [] }
  for (const source of sources) {
    if (!isRecord(source) || typeof source.sourceId !== 'string' || !Array.isArray(source.configs)) {
      throw new TypeError('pre-step sources must be objects created by createPreStepSource')
    }
  }
  const configs = sources.flatMap(source => source.configs)
  const ruleActions = sources.flatMap(source => source.ruleActions ?? [])
  const hasWork = configs.length > 0 || ruleActions.length > 0
  const promotion = promotionOwnerOf(sources)
  if (hasWork && promotion === undefined) {
    throw new TypeError('pre-step sources need one promotion owner before batch execution')
  }
  // rule → source sink；只保留首个来源，避免同一条规则被来源重复声明时重复记账。
  const sinks = new Map()
  const collect = (entry, sink) => {
    if (!isRecord(entry) || !isRecord(entry.rule) || typeof sink !== 'function' || sinks.has(entry.rule)) return
    sinks.set(entry.rule, sink)
  }
  for (const source of sources) {
    for (const config of source.configs) collect(config, source.onOutcome)
    for (const action of source.ruleActions ?? []) collect(action, source.onOutcome)
  }
  const report = sinks.size === 0
    ? undefined
    : (rule, channel, outcome) => {
      const sink = sinks.get(rule)
      if (sink !== undefined) sink({ ruleId: rule.id, channel, outcome })
    }
  return {
    configs,
    ruleActions,
    ...(promotion === undefined ? {} : { promotion }),
    ...(report === undefined ? {} : { report }),
  }
}
