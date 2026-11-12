import { registerHooks } from 'node:module'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveHostPackage } from './host-package.mjs'
import { filesystemPolicyState as state } from './filesystem-policy.mjs'

const groups = [
  ['fence', '@deepseek-ai/dsh-fs-sandbox', 'f1b987fa86584ea3e194a8a413f6ce4c7d1d86de380dc1608634be5124612e61', [
    ['this.defaultMode = ctx.sandboxPolicy.defaultMode;', 'this.defaultMode = ctx.sandboxPolicy.defaultMode;\nglobalThis[Symbol.for("prompt-tool:filesystem-policy")]?.provider(ctx, this);'],
    ['async checkedTarget(target, sandboxPolicy) {', 'async checkedTarget(target, sandboxPolicy) {\nif (globalThis[Symbol.for("prompt-tool:filesystem-policy")]?.fence(sandboxPolicy, this.ctx)) return target;'],
  ]],
  ['observation', '@deepseek-ai/dsh-fs-observation-policy', 'f4268f8f10f1137eb84ff4c01ef87bb924f4bffa0457e6f69d6e271ae9083b11',
    [['const gate = new ObservedStateGate();', 'const gate = new ObservedStateGate();\nglobalThis[Symbol.for("prompt-tool:filesystem-policy")]?.observer(ctx);'], ...['write', 'edit', 'delete'].map(verb => [
      `Promise.resolve().then(() => gate.${verb}Intent(target, actor))`,
      `Promise.resolve().then(() => globalThis[Symbol.for("prompt-tool:filesystem-policy")]?.intent(actor, ctx) ? void 0 : gate.${verb}Intent(target, actor))`,
    ])]],
]

const targets = new Map()
for (const [id, name, digest, edits] of groups) {
  try {
    const entry = resolveHostPackage(name)
    const pkg = JSON.parse(readFileSync(join(dirname(entry), '../package.json'), 'utf8'))
    if (pkg.name !== name || pkg.version !== '0.2.2-rc.2') throw new Error(`unsupported ${name} package/version`)
    targets.set(pathToFileURL(entry).href, { id, digest, edits })
    state.status.set(id, { available: false, reason: `${name} not loaded through early entry; restart DSH` })
  } catch (error) { state.status.set(id, { available: false, reason: error.message }) }
}
registerHooks({ load(url, context, next) {
  const loaded = next(url, context)
  const group = targets.get(url)
  if (group === undefined) return loaded
  const source = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source).toString()
  if (createHash('sha256').update(source).digest('hex') !== group.digest
    || !group.edits.every(([from]) => source.split(from).length === 2)) {
    state.status.set(group.id, { available: false, reason: `filesystem ${group.id} artifact fingerprint/structure mismatch` })
    return loaded
  }
  let transformed = source
  for (const [from, to] of group.edits) transformed = transformed.replace(from, to)
  state.status.set(group.id, { available: true, reason: '' })
  return { ...loaded, source: transformed }
} })
