import { registerHooks } from 'node:module'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveHostPackage } from './host-package.mjs'
import { readLimitsState as state } from './read-limits.mjs'

const digest = '0e866969b6bf1aa93407ccd9c944b50bc27a1d961b7e4209ed60bd2b73d28805'
let target
try {
  target = pathToFileURL(resolveHostPackage('@deepseek-ai/dsh-tool-fs')).href
  const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(target)), '../package.json'), 'utf8'))
  if (pkg.name !== '@deepseek-ai/dsh-tool-fs' || pkg.version !== '0.2.2-rc.1') throw new Error('unsupported tool-fs package/version')
} catch (error) { target = undefined; state.reason = String(error.message) }

if (target !== undefined) registerHooks({ load(url, context, next) {
  const result = next(url, context)
  if (url !== target) return result
  const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString()
  const edits = [
    ['function applyReadTool(ctx, caps) {', 'function applyReadTool(ctx, caps) {\nconst originalCaps = caps; const snapshots = new WeakMap();\nconst registerRead = definition => ctx.tools.register(globalThis[Symbol.for("prompt-tool:file-read-limits")]?.mark(ctx, definition) ?? definition);'],
    ['ctx.tools.register(defineTool({\n\t\tname: "read",', 'registerRead(defineTool({\n\t\tname: "read",'],
    ['render: (args, value) => {\n\t\t\t\tconst input = parseReadArgs(args, caps.limit);', 'render: (args, value) => {\nconst caps = snapshots.get(args) ?? originalCaps;\n\t\t\t\tconst input = parseReadArgs(args, caps.limit);'],
    ['async execute(args, exec) {\n\t\t\tconst input = parseReadArgs(args, caps.limit);', 'async execute(args, exec) {\nconst caps = globalThis[Symbol.for("prompt-tool:file-read-limits")]?.read(ctx, exec, originalCaps) ?? originalCaps; snapshots.set(args, caps);\n\t\t\tconst input = parseReadArgs(args, caps.limit);'],
  ]
  if (createHash('sha256').update(source).digest('hex') !== digest || edits.some(([from]) => source.split(from).length !== 2)) {
    state.available = false; state.reason = 'tool-fs artifact fingerprint or read capability group structure mismatch; restart with a supported artifact'; return result
  }
  let transformed = source
  for (const [from, to] of edits) transformed = transformed.replace(from, to)
  state.available = true; state.reason = ''
  return { ...result, source: transformed }
} })
