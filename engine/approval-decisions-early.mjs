import { registerHooks } from 'node:module'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveHostPackage } from './host-package.mjs'
import { approvalDecisionsState as state } from './approval-decisions.mjs'
import './process-defaults-early.mjs'

const lookup = 'globalThis[Symbol.for("prompt-tool:approval-decisions")]'
const groups = [
  { field: 'autoReviewPassthrough', name: '@deepseek-ai/dsh-experimental-auto-review', digest: 'c516e8803facb9c8484f10c81037859826f1b1d0fef098d933ea23b38fd780b3', edits: [
    ['function apply(ctx) {', `function apply(ctx) {\n${lookup}.integration("autoReviewPassthrough", ctx);`],
    ['if (!accepting || lifecycle.signal.aborted) return { kind: "cancel" };', `if (!accepting || lifecycle.signal.aborted) return { kind: "cancel" };\n\t\t\tif (!exec.signal.aborted && ${lookup}.review(exec, ctx)) return next();`],
  ] },
  { field: 'toolAskAllow', name: '@deepseek-ai/dsh-tools', file: 'pipeline.js', digest: '679072e59502fc211ac2336f5b3146a96c98636b30846ec70433db42d82a7abb', edits: [
    ['constructor(ctx, source = {}) {', `constructor(ctx, source = {}) {\n${lookup}.integration("toolAskAllow", ctx);`],
    ['async serviceAsk(exec, ask) {\n\t\tconst approval = this.ctx.get("approval");', `async serviceAsk(exec, ask) {\n\t\tconst approval = this.ctx.get("approval");\n\t\tif (${lookup}.ask(exec, this.ctx)) return { decision: { kind: "allow" }, approvalCancelled: false };`],
    ['const outcome = await approval.request({', `const outcome = await ${lookup}.request(approval, exec, {`],
  ] },
]
const targets = new Map()
for (const group of groups) {
  try {
    const entry = resolveHostPackage(group.name)
    const pkg = JSON.parse(readFileSync(join(dirname(entry), '../package.json'), 'utf8'))
    if (pkg.name !== group.name || pkg.version !== '0.2.2-rc.2') throw new Error('unsupported official package/version')
    targets.set(pathToFileURL(group.file ? join(dirname(entry), group.file) : entry).href, group)
  } catch (error) { state[group.field].reason = String(error.message) }
}
if (targets.size > 0) registerHooks({ load(url, context, next) {
  const result = next(url, context)
  const group = targets.get(url)
  if (group === undefined) return result
  const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString()
  if (createHash('sha256').update(source).digest('hex') !== group.digest
    || group.edits.some(([from]) => source.split(from).length !== 2)) {
    state[group.field].available = false
    state[group.field].reason = 'official approval artifact fingerprint or owner structure mismatch; restart with supported artifact'
    return result
  }
  let transformed = source
  for (const [from, to] of group.edits) transformed = transformed.replace(from, to)
  state[group.field].available = true
  state[group.field].reason = ''
  return { ...result, source: transformed }
} })
