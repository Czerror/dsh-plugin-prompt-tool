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
  ['dsh-tool-web', '34a99a7eb86f940e9cb5734ab19482ac231f5d5a2411ba6736b3b9ecf4699177'],
  ['dsh-tool-executor-ptc', 'ce5425f21f6da7eaf5d660979d4e69159f47446f612ccf9553d4e2636a30d86a'],
  ['dsh-tool-bash', '8fb836a65eb633f85aa8b1b079fb306866e597fe8f4987c2205b5c4482df57de'],
  ['dsh-tool-pwsh', '03a29fb9cff987662c14ab925a37ff4ae8b1ec3cce21f8af9c44eec7dd4c66eb'],
  ['dsh-tool-str-replace-editor', 'd400e702c4606d4d94986174409a351bec9b3061a4a6d6d4c9f0493bf0acb3f9'],
]
const targets = new Map()
for (const [name, digest] of artifacts) {
  const owner = `@deepseek-ai/${name}`
  try {
    const url = pathToFileURL(resolveHostPackage(owner)).href
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(url)), '../package.json'), 'utf8'))
    if (pkg.name !== owner || pkg.version !== '0.2.2-rc.2') throw new Error('unsupported result owner package/version')
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
