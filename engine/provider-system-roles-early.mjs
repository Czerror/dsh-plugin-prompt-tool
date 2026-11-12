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
  if (pkg.name !== '@deepseek-ai/dsh-llm' || pkg.version !== '0.2.2-rc.2') return
  target(llm, '6384b5f1e21404e997a41a31a22a079c9533f2ddc1ffd9148e684884ff62eb74', [
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
  if (pkg.name !== '@deepseek-ai/dsh-llm-pi-ai' || pkg.version !== '0.2.2-rc.2') throw new Error('unsupported pi-ai adapter')
  const pi = realpathSync(join(dirname(adapter), '../../../@earendil-works/pi-ai'))
  const piPackage = JSON.parse(readFileSync(join(pi, 'package.json'), 'utf8'))
  if (piPackage.name !== '@earendil-works/pi-ai' || piPackage.version !== '1.3.0') throw new Error('unsupported pi-ai provider')
  const group = {
    anthropic: target(join(pi, 'dist/api/anthropic-messages.js'), 'b65f40610f7c2d3120eeaa36512c0e3db37a93e6ba3a9baf6650294785880de0', [
      ['if (isOAuthToken) {\n        params.system = [', 'if (isOAuthToken && !' + bridge + '?.strip(model)) {\n        params.system = ['],
    ]),
    completions: target(join(pi, 'dist/api/openai-completions.js'), 'f5cf6982b703ef0af515d3c61926cd861ff17feeea3229522bf97bcd88d93b76', [
      ['const instructionRole = model.reasoning && compat.supportsDeveloperRole ? "developer" : "system";', 'const originalInstructionRole = model.reasoning && compat.supportsDeveloperRole ? "developer" : "system";\n    const instructionRole = ' + bridge + '?.role(model, originalInstructionRole) ?? originalInstructionRole;'],
    ]),
    responses: target(join(pi, 'dist/api/openai-responses-shared.js'), '919b1dbf276ab8805f6ce26bfe389da189711dad8f79354534091d2225e6d25a', [
      ['const instructionRole = model.reasoning && compat?.supportsDeveloperRole !== false ? "developer" : "system";', 'const originalInstructionRole = model.reasoning && compat?.supportsDeveloperRole !== false ? "developer" : "system";\n    const instructionRole = ' + bridge + '?.role(model, originalInstructionRole) ?? originalInstructionRole;'],
    ]),
  }
  const adapterToken = target(adapter, 'e956da3d7300e1426e13e14f47e6f981dd1ca345633a406568ee5058ad93e9d8', [
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
  if (!targets.has(url) && createHash('sha256').update(source).digest('hex') === '6384b5f1e21404e997a41a31a22a079c9533f2ddc1ffd9148e684884ff62eb74') {
    try { configureLlm(fileURLToPath(url)) } catch { /* A separate runtime owns its own route registry. */ }
  }
  if (!targets.has(url) && createHash('sha256').update(source).digest('hex') === 'e956da3d7300e1426e13e14f47e6f981dd1ca345633a406568ee5058ad93e9d8') {
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
