import { registerHooks } from 'node:module'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveHostPackage } from './host-package.mjs'
import { readLimitsState as reads } from './read-limits.mjs'
import { resultTextOwners as results } from './result-text-owners.mjs'

const owner = '@deepseek-ai/dsh-tool-fs'
const digest = '0e866969b6bf1aa93407ccd9c944b50bc27a1d961b7e4209ed60bd2b73d28805'
let target
try {
  target = pathToFileURL(resolveHostPackage(owner)).href
  const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(target)), '../package.json'), 'utf8'))
  if (pkg.name !== owner || pkg.version !== '0.2.2-rc.1') throw new Error('unsupported tool-fs package/version')
  results.status.set(owner, { available: false, reason: 'result owner not loaded through early entry' })
} catch (error) {
  target = undefined
  reads.reason = String(error.message)
  results.status.set(owner, { available: false, reason: String(error.message) })
}
if (target !== undefined) registerHooks({ load(url, context, next) {
  const loaded = next(url, context)
  if (url !== target) return loaded
  const source = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source).toString()
  if (createHash('sha256').update(source).digest('hex') !== digest) {
    const reason = 'tool-fs artifact fingerprint mismatch; restart with a supported artifact'
    reads.available = false; reads.reason = reason
    results.status.set(owner, { available: false, reason })
    return loaded
  }
  const readEdits = [
    ['function applyReadTool(ctx, caps) {', 'function applyReadTool(ctx, caps) {\nconst originalCaps = caps; const snapshots = new WeakMap();\nconst registerRead = definition => ctx.tools.register(globalThis[Symbol.for("prompt-tool:file-read-limits")]?.mark(ctx, definition) ?? definition);'],
    ['ctx.tools.register(defineTool({\n\t\tname: "read",', 'registerRead(defineTool({\n\t\tname: "read",'],
    ['render: (args, value) => {\n\t\t\t\tconst input = parseReadArgs(args, caps.limit);', 'render: (args, value) => {\nconst caps = snapshots.get(args) ?? originalCaps;\n\t\t\t\tconst input = parseReadArgs(args, caps.limit);'],
    ['async execute(args, exec) {\n\t\t\tconst input = parseReadArgs(args, caps.limit);', 'async execute(args, exec) {\nconst caps = globalThis[Symbol.for("prompt-tool:file-read-limits")]?.read(ctx, exec, originalCaps) ?? originalCaps; snapshots.set(args, caps);\n\t\t\tconst input = parseReadArgs(args, caps.limit);'],
  ]
  let transformed = source
  if (readEdits.every(([from]) => source.split(from).length === 2)) {
    for (const [from, to] of readEdits) transformed = transformed.replace(from, to)
    reads.available = true; reads.reason = ''
  } else {
    reads.available = false
    reads.reason = 'tool-fs read capability group structure mismatch; restart with a supported artifact'
  }
  const imports = [...source.matchAll(/import \{[^\n]+\bdefineTool\b[^\n]*\} from "@deepseek-ai\/dsh-tools";/g)]
  if (imports.length === 1) {
    const original = imports[0][0]
    const replacement = original.replace(/\bdefineTool\b/, 'defineTool as promptToolResultDefineTool')
      + `\nconst defineTool = (...args) => { const tool = promptToolResultDefineTool(...args); return globalThis[Symbol.for("prompt-tool:result-text")]?.mark(tool, ${JSON.stringify(owner)}) ?? tool; };`
    transformed = transformed.replace(original, replacement)
    results.status.set(owner, { available: true, reason: '' })
  } else results.status.set(owner, { available: false, reason: 'tool-fs result owner structure mismatch; restart with a supported artifact' })
  return transformed === source ? loaded : { ...loaded, source: transformed }
} })
