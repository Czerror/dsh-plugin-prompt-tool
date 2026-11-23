import { AsyncLocalStorage } from 'node:async_hooks'
import { createRequire } from 'node:module'
import { resolveHostPackage } from './host-package.mjs'
import { resultTextOwners } from './result-text-owners.mjs'

const owners = new WeakMap()
const depthCalls = new AsyncLocalStorage()
const requireHost = createRequire(import.meta.url)
const sources = new Map([
  ['tool-ask-user', { limit: 'askTimeout', tool: 'ask_user_question' }],
  ['tool-subagent', { limit: 'maxDepth', tool: 'subagent' }],
  ['tool-fs', { limit: 'read', tool: 'read', results: ['write', 'edit', 'apply_patch'] }],
  ['tool-web', { results: ['web_search', 'web_fetch'] }],
  ['tool-bash', { results: ['bash'] }],
  ['tool-pwsh', { results: ['pwsh'] }],
  ['tool-str-replace-editor', { results: ['str_replace_editor'] }],
])

function loadOfficialTool(name) {
  try { return requireHost(resolveHostPackage(name)) } catch { return undefined }
}

export function officialToolLimitOwner(definition) {
  const owner = owners.get(definition)
  return owner?.active && owner.installed() ? owner : undefined
}

export function rememberToolLimitProjection(projection, owner) {
  owners.set(projection, owner)
}

export function withOfficialDepth(owner, value, run) {
  return depthCalls.run({ owner, value }, run)
}

export function installOfficialToolLimitOwners(ctx) {
  const classified = new WeakMap()
  let active = true
  const off = ctx.on('internal/get', (caller, name, _error, next) => {
    if (!active || (name !== 'tools' && name !== 'subagents')) return next()
    const depth = name === 'subagents' ? depthCalls.getStore() : undefined
    if (name === 'subagents' && depth === undefined) return next()
    const fiber = caller.fiber
    const runtime = fiber.runtime
    if (runtime === undefined) return next()
    if (!classified.has(runtime)) {
      const descriptor = sources.get(runtime.name)
      const pkg = descriptor === undefined ? undefined : '@deepseek-ai/dsh-' + runtime.name
      const plugin = pkg === undefined ? undefined : loadOfficialTool(pkg)
      classified.set(runtime, plugin?.apply === runtime.callback ? { ...descriptor, pkg, apply: plugin.apply } : undefined)
    }
    const source = classified.get(runtime)
    if (source === undefined) return next()
    const config = fiber.effectiveConfig
    const isSpawn = source.limit === 'maxDepth' && config?.provider === 'spawn'
    const service = next()
    if (service === undefined) return service
    if (name === 'subagents') {
      if (!isSpawn || depth.owner.ctx.fiber !== fiber || depth.owner.active !== true || !depth.owner.installed()) return service
      return new Proxy(service, { get(target, property, receiver) {
        const method = Reflect.get(target, property, receiver)
        if (property !== 'resolveMaxDepth' || typeof method !== 'function') return method
        return configured => Reflect.apply(method, target, [configured === undefined ? depth.value : configured])
      } })
    }
    const isTimed = source.limit === 'askTimeout' && config?.mode === 'timed'
    const targetName = isTimed || isSpawn || source.limit === 'read' ? source.tool : undefined
    if (targetName === undefined && source.results === undefined) return service
    return new Proxy(service, { get(target, property, receiver) {
      const register = Reflect.get(target, property, receiver)
      if (property !== 'register') return register
      return (definition, options) => {
        if (source.results?.includes(definition.name)) {
          let registered = true
          const marked = resultTextOwners.mark(definition, source.pkg, () => active && registered)
          const release = Reflect.apply(register, target, [marked, options])
          caller.effect(() => () => { registered = false })
          return () => { registered = false; return release() }
        }
        const release = Reflect.apply(register, target, [definition, options])
        if (definition.name !== targetName) return release
        const owner = { kind: source.limit, ctx: caller, active: true, installed: () => active,
          ...(source.limit === 'read' ? { config: { ...config }, apply: source.apply } : {}) }
        owners.set(definition, owner)
        caller.effect(() => () => { owner.active = false })
        return () => { owner.active = false; return release() }
      }
    } })
  }, { global: true })
  return () => { active = false; off() }
}
