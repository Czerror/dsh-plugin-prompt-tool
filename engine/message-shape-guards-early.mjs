import { registerHooks, createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveHostPackage } from './host-package.mjs'
import './message-shape-guards.mjs'

const targets = new Map()
try {
  const peer = createRequire(resolveHostPackage('@deepseek-ai/dsh-agent-loop'))
  for (const [name, digest, edits] of [
    ['agent', '8673b5cfadfbb6e6ce0bcb341d0ea2877adc2986eab1c2b6c8baf32726534c92', [
      ['this.readState = readState;', 'this.readState = readState; this[Symbol.for("prompt-tool:message-shape-agent-owner")] = true;'],
      ['const decision = await next();\n\t\tif (decision.kind === "reject" || signal.aborted)', 'const originalDecision = await next();\n\t\tconst decision = globalThis[Symbol.for("prompt-tool:message-shape-guards")]?.decision(agent, modelSelection, originalDecision) ?? originalDecision;\n\t\tif (decision.kind === "reject" || signal.aborted)'],
    ]],
    ['session', '6fad466aa1f7aa64bfa038681ead5721f66c88e9891e25d357d2b8edbccd5494', [
      ['deriveMessages() {\n\t\tconst surface = this.surface;', 'deriveMessages() {\n\t\tglobalThis[Symbol.for("prompt-tool:message-shape-guards")]?.cache(this, () => { this.derivedGeneration = -1; });\n\t\tconst surface = this.surface;'],
      ['function deriveEventMessage(event, projectedMessages) {', 'function deriveEventMessage(event, projectedMessages, ownerSession) {\n\tconst guards = globalThis[Symbol.for("prompt-tool:message-shape-guards")];\n\tif (guards !== undefined) return guards.derive(event, projectedMessages, ownerSession, () => deriveOriginalEventMessage(event, projectedMessages));\n\treturn deriveOriginalEventMessage(event, projectedMessages);\n}\nfunction deriveOriginalEventMessage(event, projectedMessages) {'],
      ['return deriveEventMessage(event, this._state.projectedMessages);', 'return deriveEventMessage(event, this._state.projectedMessages, this[Symbol.for("prompt-tool:message-shape-session")]);'],
      ['this.surfaceManager = new SurfaceManager(this.log, SessionLogOffset(0), projections);', 'this.surfaceManager = new SurfaceManager(this.log, SessionLogOffset(0), projections); this.surfaceManager[Symbol.for("prompt-tool:message-shape-session")] = this;'],
    ]],
  ]) {
    const file = peer.resolve('@deepseek-ai/dsh-' + name), pkg = JSON.parse(readFileSync(join(dirname(file), '../package.json'), 'utf8'))
    if (pkg.name === '@deepseek-ai/dsh-' + name && pkg.version === '0.2.2-rc.1') targets.set(pathToFileURL(file).href, { name, digest, edits })
  }
} catch { /* Missing owners leave only this capability unavailable. */ }
registerHooks({ load(url, context, next) {
  const result = next(url, context), target = targets.get(url)
  if (target === undefined) return result
  const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString()
  if (createHash('sha256').update(source).digest('hex') !== target.digest || !target.edits.every(([from]) => source.split(from).length === 2)) return result
  let transformed = source
  for (const [from, to] of target.edits) transformed = transformed.replace(from, to)
  return { ...result, source: transformed }
} })
