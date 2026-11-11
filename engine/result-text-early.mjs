import { registerHooks } from 'node:module'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveHostPackage } from './host-package.mjs'
import { resultTextOwners as state } from './result-text-owners.mjs'
import './fs-tool-early.mjs'
import { transformEscalationCaller, escalationDecisionsState } from './escalation-decisions.mjs'

const escalationOwners = { '@deepseek-ai/dsh-tool-executor-ptc': 'ptc', '@deepseek-ai/dsh-tool-bash': 'bash', '@deepseek-ai/dsh-tool-pwsh': 'pwsh' }

const artifacts = [
  ['dsh-tool-web', '129af8e6bf485d47d3f5f562877b5c266fd57f1a5cc14bfebacc2780b2837d46'],
  ['dsh-tool-executor-ptc', 'aab21d46e71316a97ad2a071ab7d8d21aa876c4192a4cd98094f61b2800cad9a'],
  ['dsh-tool-bash', 'ae6be2d8b287b5e410d026acd2fdfc553ebb95565f7b361029c7fb5bcda5fd27'],
  ['dsh-tool-pwsh', '157aa3964db76e64d3013e63daed72a61d7fc5f86b247b0103753290d7dd6ed9'],
  ['dsh-tool-str-replace-editor', '14a7380c94b53150ec5545dfb8fcf28bb26c99b6deef9b27bb9cf4ff6fabb616'],
]
const targets = new Map()
for (const [name, digest] of artifacts) {
  const owner = `@deepseek-ai/${name}`
  try {
    const url = pathToFileURL(resolveHostPackage(owner)).href
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(url)), '../package.json'), 'utf8'))
    if (pkg.name !== owner || pkg.version !== '0.2.2-rc.1') throw new Error('unsupported result owner package/version')
    targets.set(url, { owner, digest })
    state.status.set(owner, { available: false, reason: 'result owner not loaded through early entry' })
  } catch (error) { state.status.set(owner, { available: false, reason: String(error.message) }) }
}
registerHooks({ load(url, context, next) {
  const loaded = next(url, context)
  const artifact = targets.get(url)
  if (artifact === undefined) return loaded
  const source = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source).toString()
  const imports = [...source.matchAll(/import \{[^\n]+\bdefineTool\b[^\n]*\} from "@deepseek-ai\/dsh-tools";/g)]
  if (createHash('sha256').update(source).digest('hex') !== artifact.digest || imports.length !== 1) {
    state.status.set(artifact.owner, { available: false, reason: 'result owner artifact fingerprint or structure mismatch' })
    if (escalationOwners[artifact.owner]) escalationDecisionsState.status.set(escalationOwners[artifact.owner], { available: false, reason: 'escalation caller artifact fingerprint mismatch' })
    return loaded
  }
  const original = imports[0][0]
  const replacement = original.replace(/\bdefineTool\b/, 'defineTool as promptToolResultDefineTool')
    + `\nconst defineTool = (...args) => { const tool = promptToolResultDefineTool(...args); return globalThis[Symbol.for("prompt-tool:result-text")]?.mark(tool, ${JSON.stringify(artifact.owner)}) ?? tool; };`
  state.status.set(artifact.owner, { available: true, reason: '' })
  const transformed = source.replace(original, replacement)
  return { ...loaded, source: escalationOwners[artifact.owner] ? transformEscalationCaller(transformed, escalationOwners[artifact.owner]) : transformed }
} })
