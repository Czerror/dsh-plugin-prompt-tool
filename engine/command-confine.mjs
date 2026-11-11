import { symbols } from '@deepseek-ai/cordis'
import { importHostPackage } from './host-package.mjs'
export const isCommandConfineAction = action => action.kind === 'host-control' && action.capability === 'command-confine-passthrough'
export function validateCommandConfine(action) {
  if (action.value !== true || action.maxPerTurn !== undefined || (action.waterfallPosition !== undefined && action.waterfallPosition !== 'default')) throw new TypeError('command confine requires value true and process calls, not Agent deliveries')
}

/** Process-only command invocation selection; never retains Agent or Session facts. */
export function createCommandConfine() {
  const sources = new Map(), owners = new WeakMap(), live = new Set()
  return {
    replace(source, actions) {
      if (typeof source !== 'string' || !source || !Array.isArray(actions)
        || actions.some(action => !action || action.capability !== 'command-confine-passthrough'
          || action.value !== true || Object.keys(action).some(key => key !== 'capability' && key !== 'value'))) {
        throw new TypeError('command confine requires explicit process capability/value; private facts are forbidden')
      }
      const token = { enabled: actions.length > 0 }
      sources.set(source, token)
      return () => { if (sources.get(source) === token) sources.delete(source) }
    },
    status() {
      return live.size ? { available: true, reason: 'verified local provider; affects subsequent confine calls' }
        : { available: false, reason: 'verified local sandbox provider unavailable' }
    },
    async install(ctx, Provider) {
      const dependency = ctx.inject(['sandbox'], dependent => {
        const owner = dependent.sandbox[symbols.original] ?? dependent.sandbox
        // The caller supplies the class resolved from the official host package.
        if (!Provider || Object.getPrototypeOf(owner) !== Provider.prototype || owners.has(owner)
          || typeof Provider.prototype.confine !== 'function' || owner.confine !== Provider.prototype.confine) return
        const original = owner.confine, descriptor = Object.getOwnPropertyDescriptor(owner, 'confine')
        let active = true
        const passthrough = function (...args) {
          const [argv, , signal] = args
          signal?.throwIfAborted()
          return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
        }
        const selected = original.constructor.name === 'AsyncFunction'
          ? async function (...args) { return Reflect.apply(passthrough, this, args) }
          : passthrough
        const wrapper = function (...args) {
          const enabled = active && [...sources.values()].some(token => token.enabled)
          return Reflect.apply(enabled ? selected : original, this, args)
        }
        owners.set(owner, wrapper)
        Object.defineProperty(owner, 'confine', { configurable: true, writable: true, value: wrapper })
        live.add(owner)
        return () => {
          active = false
          live.delete(owner)
          if (owners.get(owner) === wrapper) owners.delete(owner)
          if (owner.confine === wrapper) {
            if (descriptor) Object.defineProperty(owner, 'confine', descriptor)
            else delete owner.confine
          }
        }
      })
      await dependency
      return () => dependency.dispose()
    },
  }
}

export const commandConfineState = globalThis[Symbol.for('prompt-tool:command-confine')] ??= createCommandConfine()
export async function installCommandConfine(ctx) {
  const { LocalSandboxProvider } = await importHostPackage('@deepseek-ai/dsh-sandbox-local')
  return commandConfineState.install(ctx, LocalSandboxProvider)
}
