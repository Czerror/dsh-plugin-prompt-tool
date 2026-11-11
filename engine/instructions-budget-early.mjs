import { registerHooks } from 'node:module'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { resolveHostPackage } from './host-package.mjs'
import { instructionsBudgetState as state } from './instructions-budget-bridge.mjs'
import './request-budget-early.mjs'
import './read-limits-early.mjs'
import './result-text-early.mjs'

const digest = 'afbd526d1e3126a368774f24105140adc3ef532ca4aa93cfa0fb1318d5b9b75d'
let target
try {
  target = pathToFileURL(resolveHostPackage('@deepseek-ai/dsh-agent-instructions')).href
  const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(target)), '../package.json'), 'utf8'))
  if (pkg.name !== '@deepseek-ai/dsh-agent-instructions' || pkg.version !== '0.2.2-rc.1') throw new Error('unsupported instructions package/version')
} catch (error) { target = undefined; state.reason = String(error.message) }
if (target !== undefined) registerHooks({ load(url, context, next) {
  const result = next(url, context)
  if (url !== target) return result
  const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString()
  const edits = [
    ['function apply(ctx, config) {', 'function apply(ctx, config) { globalThis[Symbol.for("prompt-tool:instructions-budget")]?.track(ctx);'],
    ['const resolved = resolveConfig(config);', 'const baseResolved = resolveConfig(config);'],
    ['const compose = async (agent, signal, claimed, pending, touchedPaths = []) => {', 'const compose = async (agent, signal, claimed, pending, touchedPaths = [], modelSelection) => {\nconst resolved = { ...baseResolved, maxBytes: globalThis[Symbol.for("prompt-tool:instructions-budget")]?.read(agent, signal, baseResolved.maxBytes, modelSelection) ?? baseResolved.maxBytes };'],
    ['async ({ agent, messages, step, signal }, next)', 'async ({ agent, messages, step, signal, modelSelection }, next)'],
    ['await compose(agent, signal, messages, pending);', 'await compose(agent, signal, messages, pending, [], modelSelection);'],
  ]
  if (createHash('sha256').update(source).digest('hex') !== digest || edits.some(([from]) => source.split(from).length !== 2)) {
    state.available = false; state.reason = 'instructions artifact fingerprint or structure mismatch'; return result
  }
  let transformed = source
  for (const [from, to] of edits) transformed = transformed.replace(from, to)
  state.available = true; state.reason = ''
  return { ...result, source: transformed }
} })
