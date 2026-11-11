const values = Object.freeze({ 'sandbox-soft-default': 'danger-full-access',
  'approval-composition-default': 'never', 'approval-config-default': 'never' })
export const isProcessDefaultAction = action => action.kind === 'host-control' && Object.hasOwn(values, action.capability)
export function validateProcessDefault(action) {
  if (!Object.hasOwn(values, action.capability) || action.value !== values[action.capability]) throw new TypeError('invalid process default capability/value')
  if (action.maxPerTurn !== undefined || (action.waterfallPosition !== undefined && action.waterfallPosition !== 'default')) throw new TypeError('process defaults are constructor defaults, not Agent deliveries')
}

/** One contribution per source per process; never retains an Agent or Session. */
export function createProcessDefaults() {
  const sources = new Map()
  const enabled = capability => [...sources.values()].some(source => source.has(capability))
  return {
    replaceRules(source, rules) {
      return this.replace(source, rules.filter(rule => rule.executionScope === 'process' && rule.enabled !== false)
        .flatMap(rule => rule.actions.map(({ capability, value }) => ({ capability, value }))))
    },
    replace(source, actions) {
      if (typeof source !== 'string' || source.length === 0 || !Array.isArray(actions)) throw new TypeError('process defaults require a source and actions')
      for (const action of actions) {
        if (action === null || typeof action !== 'object' || !Object.hasOwn(values, action.capability) || action.value !== values[action.capability]
          || Object.keys(action).some(key => key !== 'capability' && key !== 'value')) {
          throw new TypeError('process defaults require a supported capability/value; Agent conditions are forbidden')
        }
      }
      const token = new Set(actions.map(action => action.capability))
      sources.set(source, token)
      return () => { if (sources.get(source) === token) sources.delete(source) }
    },
    rawConfig(fiber, original) {
      if (original !== undefined && (original === null || typeof original !== 'object' || Array.isArray(original))) return original
      const name = fiber.entry?.options?.name
      const config = original ?? {}
      if (name === '@deepseek-ai/dsh-sandbox-policy' && enabled('sandbox-soft-default')
        && config.mode?.__jsExpr === "process.env.DSH_PERMISSION_MODE ?? 'workspace-write'") {
        return { ...config, mode: { __jsExpr: "process.env.DSH_PERMISSION_MODE ?? 'danger-full-access'" } }
      }
      if (name === '@deepseek-ai/dsh-user-approval') {
        if (enabled('approval-composition-default')
          && config.policy?.__jsExpr === "(process.env.DSH_PERMISSION_MODE ?? 'workspace-write') === 'danger-full-access' ? 'never' : 'ask'") {
          return { ...config, policy: { __jsExpr: "(process.env.DSH_PERMISSION_MODE ?? 'danger-full-access') === 'danger-full-access' ? 'never' : 'ask'" } }
        }
        if (enabled('approval-config-default') && config.policy === undefined) return { ...config, policy: 'never' }
      }
      return original
    },
  }
}

export const processDefaultsState = globalThis[Symbol.for('prompt-tool:process-defaults')] ??= {
  configAvailable: false,
  configReason: 'process defaults early entry missing or Loader already cached; needs a verified early entry and a subsequent owner construction',
  ...createProcessDefaults(),
}
const owners = new WeakMap()
const ready = new Set()
const failures = new Map()
processDefaultsState.markOwner = (name, owner) => { owners.set(owner, name); ready.add(name); failures.delete(name) }
processDefaultsState.ownerUnavailable = (name, reason) => { ready.delete(name); failures.set(name, reason) }
const rawConfig = processDefaultsState.rawConfig
processDefaultsState.rawConfig = (fiber, original) => processDefaultsState.configAvailable
  && owners.get(fiber.runtime?.callback) === fiber.entry?.options?.name ? rawConfig(fiber, original) : original
processDefaultsState.status = capability => {
  const owner = capability === 'sandbox-soft-default' ? '@deepseek-ai/dsh-sandbox-policy' : '@deepseek-ai/dsh-user-approval'
  return processDefaultsState.configAvailable && ready.has(owner)
    ? { available: true, reason: 'verified constructor default seam; affects only subsequent owner constructions, not existing instances' }
    : { available: false, reason: !processDefaultsState.configAvailable ? processDefaultsState.configReason : failures.get(owner) ?? `verified ${owner} constructor unavailable or not loaded` }
}
