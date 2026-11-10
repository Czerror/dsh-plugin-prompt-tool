import { scopeOf, scopeChainOf } from '@deepseek-ai/dsh-scope'
const key = Symbol.for('prompt-tool:instructions-budget')
const state = globalThis[key] ??= { readers: new Set(), owners: new Set(), available: false, reason: 'early entry not loaded' }
state.track = ctx => { state.owners.add(ctx); ctx.effect(() => () => state.owners.delete(ctx)) }
state.read = (agent, signal, original, modelSelection) => {
  signal.throwIfAborted()
  if (!instructionsBudgetStatus(agent).available) return original
  const values = [...state.readers].map(read => read(agent, modelSelection)).filter(value => value !== undefined)
  if (new Set(values).size > 1) throw new TypeError('instructionsMaxBytes conflict')
  return values[0] ?? original
}
export function instructionsBudgetStatus(agent) {
  if (!state.available) return { available: false, reason: state.reason }
  const chain = agent?.ctx === undefined ? [] : scopeChainOf(scopeOf(agent.ctx))
  const owners = [...state.owners].filter(ctx => scopeOf(ctx) === undefined || chain.includes(scopeOf(ctx)))
  const available = owners.some(ctx => ctx.get('fs') !== undefined && ctx.get('workingDirectory') !== undefined)
  return { available, reason: available ? '' : 'official instructions owner or runtime dependencies unavailable' }
}
export function registerInstructionsBudgetReader(read) { state.readers.add(read); return () => state.readers.delete(read) }
export const instructionsBudgetState = state
