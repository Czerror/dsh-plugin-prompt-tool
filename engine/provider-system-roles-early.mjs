import { registerHooks, createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolveHostPackage } from './host-package.mjs'
import './provider-system-roles.mjs'

const targets = new Map()
const preloads = []
const bridge = 'globalThis[Symbol.for("prompt-tool:provider-system-roles")]'
const valid = (source, digest, edits) => createHash('sha256').update(source).digest('hex') === digest && edits.every(([from]) => source.split(from).length === 2)
function target(file, digest, edits) {
  edits = edits.map(pair => pair.map(text => text.replaceAll(String.fromCharCode(92, 110), String.fromCharCode(10)).replaceAll(String.fromCharCode(92, 116), String.fromCharCode(9))))
  try {
    const source = readFileSync(file, 'utf8')
    if (!valid(source, digest, edits)) return undefined
    const token = pathToFileURL(realpathSync(file)).href
    targets.set(token, { digest, edits })
    return token
  } catch { return undefined }
}
function configureLlm(llm) {
  const pkg = JSON.parse(readFileSync(join(dirname(llm), '../package.json'), 'utf8'))
  if (pkg.name !== '@deepseek-ai/dsh-llm' || pkg.version !== '0.2.2-rc.1') return
  target(llm, '8e541fc98a11897706a122fde1db42f8b2a41b3b354ba3fcb932e9a16929ac6a', [
    ['registration(provider) {', '[Symbol.for("prompt-tool:provider-system-roles-route")](provider) { return this.adapters.get(provider); }\n\t\tregistration(provider) {'],
  ])
}
try {
  const loopPeer = createRequire(resolveHostPackage('@deepseek-ai/dsh-agent-loop'))
  const llm = loopPeer.resolve('@deepseek-ai/dsh-llm')
  configureLlm(llm)
} catch { /* An absent route owner is reported only for these capabilities. */ }
function configureAdapter(adapter) {
  const pkg = JSON.parse(readFileSync(join(dirname(adapter), '../package.json'), 'utf8'))
  if (pkg.name !== '@deepseek-ai/dsh-llm-pi-ai' || pkg.version !== '0.2.2-rc.1') throw new Error('unsupported pi-ai adapter')
  const pi = realpathSync(join(dirname(adapter), '../../../@earendil-works/pi-ai'))
  const piPackage = JSON.parse(readFileSync(join(pi, 'package.json'), 'utf8'))
  if (piPackage.name !== '@earendil-works/pi-ai' || piPackage.version !== '1.5.2') throw new Error('unsupported pi-ai provider')
  const group = {
    anthropic: target(join(pi, 'dist/api/anthropic-messages.js'), '47cce5fb2770f6ffde0268cfb6549c4839af04129f776149bd60e04555c584dc', [
      ['if (isOAuthToken) {\n        params.system = [', 'if (isOAuthToken && !' + bridge + '?.strip(model)) {\n        params.system = ['],
    ]),
    completions: target(join(pi, 'dist/api/openai-completions.js'), '3221deb8b506eab9722d27694fc1bceb752d8786180999add590c2489ac91846', [
      ['const instructionRole = model.reasoning && compat.supportsDeveloperRole ? "developer" : "system";', 'const originalInstructionRole = model.reasoning && compat.supportsDeveloperRole ? "developer" : "system";\n    const instructionRole = ' + bridge + '?.role(model, originalInstructionRole) ?? originalInstructionRole;'],
    ]),
    responses: target(join(pi, 'dist/api/openai-responses-shared.js'), '00796997da00cd4cb77ae8c1c4bb92a3d4a4a4dd5bea18524de7173e4f877e4c', [
      ['const instructionRole = model.reasoning && compat?.supportsDeveloperRole !== false ? "developer" : "system";', 'const originalInstructionRole = model.reasoning && compat?.supportsDeveloperRole !== false ? "developer" : "system";\n    const instructionRole = ' + bridge + '?.role(model, originalInstructionRole) ?? originalInstructionRole;'],
      ['messages.push({ role: instructionRole, content: renderIncrementalToolsNotice(unavailableTools) });', 'messages.push({ role: originalInstructionRole, content: renderIncrementalToolsNotice(unavailableTools) });'],
      ['if (text.length > 0) {\n                    messages.push({ role: instructionRole, content: sanitizeSurrogates(text) });', 'if (instructionRole !== originalInstructionRole && parts.length > 1) {\n                    if (parts[0].length > 0) messages.push({ role: instructionRole, content: sanitizeSurrogates(parts[0]) });\n                    messages.push({ role: originalInstructionRole, content: sanitizeSurrogates(parts[1]) });\n                }\n                else if (text.length > 0) {\n                    messages.push({ role: instructionRole, content: sanitizeSurrogates(text) });'],
    ]),
  }
  const adapterToken = target(adapter, '1a3ae58f9b4493e15459cc5000ec80f21b5d3f4a9dea6ffb6bc28e5b8817ae8a', [
    ['this.config = config;', 'this.config = config; this[Symbol.for("prompt-tool:provider-system-roles-adapter")] = ' + JSON.stringify(group) + ';'],
    ['prepareCall(provider, model, _signal) {\n\t\tconst snapshot = this.current();', 'prepareCall(provider, model, _signal) {\n\t\tconst identity = ' + bridge + '?.capture(this);\n\t\tconst snapshot = this.current();'],
    ['stream: (options) => this.streamWithSnapshot(options, snapshot)', 'stream: (options) => this.streamWithSnapshot(options, snapshot, identity)'],
    ['async *streamWithSnapshot(options, snapshot) {', 'async *streamWithSnapshot(options, snapshot, identity) {'],
    ['const model = this.modelOf(snapshot, options.provider, options.model);', 'const originalModel = this.modelOf(snapshot, options.provider, options.model);\n\t\t\tconst model = ' + bridge + '?.model(originalModel, identity, options.signal) ?? originalModel;'],
  ])
  if (adapterToken !== undefined) {
    const imports = Object.values(group).filter(Boolean)
    preloads.push(...imports)
    targets.get(adapterToken).imports = imports
  }
}
try { configureAdapter(resolveHostPackage('@deepseek-ai/dsh-llm-pi-ai')) } catch { /* Optional adapter. */ }
registerHooks({ load(url, context, next) {
  const result = next(url, context)
  if (result.source == null) return result
  const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString()
  if (!targets.has(url) && createHash('sha256').update(source).digest('hex') === '8e541fc98a11897706a122fde1db42f8b2a41b3b354ba3fcb932e9a16929ac6a') {
    try { configureLlm(fileURLToPath(url)) } catch { /* A separate runtime owns its own route registry. */ }
  }
  if (!targets.has(url) && createHash('sha256').update(source).digest('hex') === '1a3ae58f9b4493e15459cc5000ec80f21b5d3f4a9dea6ffb6bc28e5b8817ae8a') {
    try { configureAdapter(fileURLToPath(url)) } catch { /* Each deployed copy validates its own provider group. */ }
  }
  const entry = targets.get(url)
  if (entry === undefined) return result
  if (!valid(source, entry.digest, entry.edits)) return result
  let transformed = source
  for (const [from, to] of entry.edits) transformed = transformed.replace(from, to)
  if (entry.imports !== undefined) transformed = 'await Promise.allSettled(' + JSON.stringify(entry.imports) + '.map(url => import(url)));' + String.fromCharCode(10) + transformed
  transformed += String.fromCharCode(10) + bridge + '?.loaded(' + JSON.stringify(url) + ');'
  return { ...result, source: transformed }
} })
await Promise.allSettled(preloads.map(url => import(url)))
