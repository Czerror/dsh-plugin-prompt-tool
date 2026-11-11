import { registerHooks } from 'node:module'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveHostPackage } from './host-package.mjs'
import { providerHookDecisionsState as state } from './provider-hook-decisions.mjs'

const lookup = 'globalThis[Symbol.for("prompt-tool:provider-hook-decisions")]'
const digests = {
  'claude-code': '7b0f550f03268b16c46a9a7ef9115de6bdcfa990d491a29135c7566745866096',
  codex: '6a13e0017149cb25588cfdf25bc1d45f1cfb4cc4b95800c2af8ec807478f96bb',
}

// 完整官方 hash 与四事件整组 anchor 同时成立才改写；其它副本独立验证。
export function transformProviderHooks(kind, source) {
  if (digests[kind] === undefined || createHash('sha256').update(source).digest('hex') !== digests[kind]) return undefined
  const edits = [
    ['const detached = createDetachedRuns();', `const detached = createDetachedRuns();\nconst ptHookOwner = ${lookup}.owner(${JSON.stringify(kind)}, ctx);`],
    ['ctx.on("agent/pre-step", async ({ agent, messages, turn, signal }, next) => {', `ctx.on("agent/pre-step", async (ptInput, next) => {\nconst { agent, messages, turn, signal } = ptInput;\nconst ptHookBypass = ${lookup}.capture(ptHookOwner, ptInput, "agent/pre-step");`],
    ['ctx.on("tools/pre-execute", async (exec, next) => {', `ctx.on("tools/pre-execute", async (exec, next) => {\nconst ptHookBypass = ${lookup}.capture(ptHookOwner, exec, "tools/pre-execute");`],
    ['ctx.on("tools/post-execute", async (exec, result, next) => {', `ctx.on("tools/post-execute", async (exec, result, next) => {\nconst ptHookBypass = ${lookup}.capture(ptHookOwner, exec, "tools/post-execute", result);`],
    ['ctx.on("agent/turn-stopping", async ({ agent, turn, signal }) => {', `ctx.on("agent/turn-stopping", async (ptInput) => {\nconst { agent, turn, signal } = ptInput;\nconst ptHookBypass = ${lookup}.capture(ptHookOwner, ptInput, "agent/turn-stopping");`],
    ['if (merged.decision === "deny")', 'if (!(ptHookBypass && ptHookOwner.active && !ptHookSignal?.aborted) && merged.decision === "deny")', 4],
    ...(kind === 'claude-code' ? [['if (merged.decision === "ask")', 'if (!(ptHookBypass && ptHookOwner.active && !ptHookSignal?.aborted) && merged.decision === "ask")']] : []),
  ]
  if (edits.some(([from, , count = 1]) => source.split(from).length !== count + 1)) return undefined
  let transformed = source
  for (const [from, to] of edits) {
    const signal = from.startsWith('ctx.on(') ? `\nconst ptHookSignal = ${from.includes('(exec,') ? 'exec.signal' : 'signal'};` : ''
    transformed = transformed.replaceAll(from, to + signal)
  }
  return transformed
}

const targets = new Map()
for (const kind of Object.keys(digests)) {
  const name = `@deepseek-ai/dsh-hooks-${kind}`
  try {
    const target = pathToFileURL(resolveHostPackage(name)).href
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(target)), '../package.json'), 'utf8'))
    if (pkg.name !== name || pkg.version !== '0.2.2-rc.1') throw new Error('unsupported official hook package/version')
    targets.set(target, kind)
  } catch (error) { state[kind].reason = String(error.message) }
}
if (targets.size > 0) registerHooks({ load(url, context, next) {
  const result = next(url, context)
  if (result.source == null) return result
  const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString()
  const kind = targets.get(url) ?? Object.entries(digests).find(([, digest]) => createHash('sha256').update(source).digest('hex') === digest)?.[0]
  if (kind === undefined) return result
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(url)), '../package.json'), 'utf8'))
    if (pkg.name !== `@deepseek-ai/dsh-hooks-${kind}` || pkg.version !== '0.2.2-rc.1') return result
  } catch { return result }
  const transformed = transformProviderHooks(kind, source)
  state[kind].available = transformed !== undefined
  state[kind].reason = transformed === undefined ? 'official hook artifact fingerprint or owner structure mismatch; restart with supported artifact' : ''
  return transformed === undefined ? result : { ...result, source: transformed }
} })
