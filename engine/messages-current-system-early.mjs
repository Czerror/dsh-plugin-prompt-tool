import { registerHooks } from 'node:module'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolveHostPackage } from './host-package.mjs'
import './provider-system-roles.mjs'

const digest = '955dc7bc7ca6c857ff4a7e373b87c143b96a4c43fc80325b67dc0982600dcc75'
const bridge = 'globalThis[Symbol.for("prompt-tool:provider-system-roles")]'
const targets = new Set()
const edits = [
  ['this.dependencies = dependencies;\n\t\tthis.files =', 'this.dependencies = dependencies; this[Symbol.for("prompt-tool:provider-system-roles-adapter")] = { messages: ' + JSON.stringify(digest) + ' };\n\t\tthis.files ='],
  ['async prepareCall(provider, model, signal) {', 'async prepareCall(provider, model, signal) {\n\t\tconst identity = ' + bridge + '?.capture(this);'],
  ['stream: (options) => this.generate(options, connection)', 'stream: (options) => this.generate(options, connection, identity)'],
  ['async *generate(options, connection) {', 'async *generate(options, connection, identity) {'],
  ['watchdog.pulse();\n\t\t\t});', 'watchdog.pulse();\n\t\t\t}, identity);'],
  ['async *request(options, connection, signal, activity) {', 'async *request(options, connection, signal, activity, identity) {'],
  ['function serialize(options, connection, history, images, access, onReplayDegrade, fileIds) {', 'function serialize(options, connection, history, images, access, onReplayDegrade, fileIds, currentSystem) {'],
  ['}, fileIds);', '}, fileIds, ' + bridge + '?.messages(identity, signal));'],
  ['let historySystem;', 'let historySystem;\n\tconst currentSystemParts = { current: [], other: [] };'],
  ['if (inHistory && messages.length > 0) {', 'if (currentSystem === "snapshot") {\n\t\t\t\tif (text.length > 0) (message.source?.kind === "system-prompt" ? currentSystemParts.current : currentSystemParts.other).push(text);\n\t\t\t} else if (currentSystem) {\n\t\t\t\tif (text.length > 0) historySystem = text;\n\t\t\t} else if (inHistory && messages.length > 0) {'],
  ['const system = [options.system, historySystem]', 'if (currentSystem === "snapshot") historySystem = [...currentSystemParts.current, ...currentSystemParts.other].join("\\n\\n");\n\tconst system = [options.system, historySystem]'],
]
function valid(source) { return createHash('sha256').update(source).digest('hex') === digest && edits.every(([from]) => source.split(from).length === 2) }
function configure(file) {
  const pkg = JSON.parse(readFileSync(join(dirname(file), '../package.json'), 'utf8'))
  if (pkg.name === '@deepseek-ai/dsh-llm-deepseek' && pkg.version === '0.2.2-rc.1' && valid(readFileSync(file, 'utf8'))) targets.add(pathToFileURL(file).href)
}
try { configure(resolveHostPackage('@deepseek-ai/dsh-llm-deepseek')) } catch { /* Optional Messages owner. */ }
registerHooks({ load(url, context, next) {
  const result = next(url, context)
  if (result.source == null) return result
  const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString()
  if (!targets.has(url) && valid(source)) { try { configure(fileURLToPath(url)) } catch { /* Separate deployed owner. */ } }
  if (!targets.has(url) || !valid(source)) return result
  let transformed = source
  for (const [from, to] of edits) transformed = transformed.replace(from, to)
  transformed += '\n' + bridge + '?.loaded(' + JSON.stringify(digest) + ');'
  return { ...result, source: transformed }
} })
