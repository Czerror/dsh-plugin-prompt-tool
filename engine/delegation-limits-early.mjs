import { registerHooks } from 'node:module'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveHostPackage } from './host-package.mjs'
import { delegationLimitsState as state } from './delegation-limits.mjs'

const lookup = 'globalThis[Symbol.for("prompt-tool:delegation-limits")]'
const groups = [
  { field: 'maxDepth', name: '@deepseek-ai/dsh-tool-subagent', digest: 'e73d2fb1753421bfd80e8adf38a3cafe93a4fa2516e07f9764279a880821734e', edits: [
    ['const unregister = ctx.tools.register(definition);', `const unregister = ctx.tools.register(config.provider === "spawn" ? ${lookup}.mark("maxDepth", ctx, definition) : definition);`],
    ['const maxDepth = ctx.subagents.resolveMaxDepth(config.maxDepth);', `const maxDepth = ctx.subagents.resolveMaxDepth(${lookup}.depth(ctx, config.maxDepth));`, 2],
  ] },
  { field: 'askTimeout', name: '@deepseek-ai/dsh-tool-ask-user', digest: 'bd67c94dcecde5c8c0211a5f347fd28ae9c650d631a5d7f4d6f285dd13250438', edits: [
    ['function registerTimedAskUser(ctx, timeout = 120) {', `function registerTimedAskUser(ctx, timeout = 120) {\nconst registerTimed = definition => ctx.tools.register(${lookup}.mark("askTimeout", ctx, definition));`],
    ['ctx.tools.register(defineTool({\n\t\tname: "ask_user_question",\n\t\tdescription: description$1,', 'registerTimed(defineTool({\n\t\tname: "ask_user_question",\n\t\tdescription: description$1,'],
  ] },
]
const targets = new Map()
for (const group of groups) {
  try {
    const target = pathToFileURL(resolveHostPackage(group.name)).href
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(target)), '../package.json'), 'utf8'))
    if (pkg.name !== group.name || pkg.version !== '0.2.2-rc.1') throw new Error('unsupported official package/version')
    targets.set(target, group)
  } catch (error) { state[group.field].reason = String(error.message) }
}
if (targets.size > 0) registerHooks({ load(url, context, next) {
  const result = next(url, context)
  const group = targets.get(url)
  if (group === undefined) return result
  const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString()
  if (createHash('sha256').update(source).digest('hex') !== group.digest
    || group.edits.some(([from, , count = 1]) => source.split(from).length !== count + 1)) {
    state[group.field].available = false
    state[group.field].reason = 'official delegation artifact fingerprint or owner structure mismatch; restart with supported artifact'
    return result
  }
  let transformed = source
  for (const [from, to] of group.edits) transformed = transformed.replaceAll(from, to)
  state[group.field].available = true
  state[group.field].reason = ''
  return { ...result, source: transformed }
} })
