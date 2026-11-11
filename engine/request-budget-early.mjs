import { registerHooks } from 'node:module'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveHostPackage } from './host-package.mjs'
import { requestBudgetState as state } from './request-budget-bridge.mjs'

const digest = 'a6fa8e0c7c90191caf5f4a3bb5c624a86e9845cf3c79d020b71420d0e20ae4c1'
let target
try {
  target = pathToFileURL(resolveHostPackage('@deepseek-ai/dsh-agent-loop')).href
  const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(target)), '../package.json'), 'utf8'))
  if (pkg.name !== '@deepseek-ai/dsh-agent-loop' || pkg.version !== '0.2.2-rc.1') throw new Error('unsupported agent-loop package/version')
} catch (error) { target = undefined; state.reason = String(error.message) }

if (target !== undefined) registerHooks({ load(url, context, next) {
  const result = next(url, context)
  if (url !== target) return result
  const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString()
  const acceptedFrom = '\t\tsignal.throwIfAborted();\n\t\treturn {\n\t\t\tconfig,\n\t\t\t...preparedCall === void 0 ? {} : { preparedCall }\n\t\t};'
  const coreEdits = [
    ['this.model = new AgentModel(projections.modelSelection, session, options);',
      'this.model = new AgentModel(projections.modelSelection, session, options); this[Symbol.for("prompt-tool:request-budget-owner")] = true;'],
    ['const seedConfig = deepFreeze(structuredClone({',
      'const priorBudget = this[Symbol.for("prompt-tool:request-budget-seed")]; delete this[Symbol.for("prompt-tool:request-budget-seed")];\n'
      + 'if (priorBudget !== undefined && Object.is(controls.maxTokens, priorBudget.value)) { if (priorBudget.present) controls.maxTokens = priorBudget.original; else delete controls.maxTokens; }\n'
      + 'const seedConfig = deepFreeze(structuredClone({'],
    [acceptedFrom, acceptedFrom.replace('\t\treturn {', '\t\tglobalThis[Symbol.for("prompt-tool:request-budget")]?.accepted(this, proposedConfig, config);\n\t\treturn {')],
  ]
  const snapshotEdits = [
    ['const commits = this.systemPrompt.project(renderedPrompt, {',
      'const commits = (input => (globalThis[Symbol.for("prompt-tool:current-system-snapshot:commits")] ?? ((agent, rendered, input) => agent.systemPrompt.project(rendered, input)))(this, renderedPrompt, input, createSystemMessage, assembly))({'],
    ['buildRequest(config, preparedCall, tools, position, startsRequestSeries, signal) {',
      'buildRequest(config, preparedCall, tools, position, startsRequestSeries, signal, renderedPrompt, assembly) {'],
    ['startsRequestSeries, signal);', 'startsRequestSeries, signal, renderedPrompt, assembly);'],
    ['const boundaryMessages = session.deriveMessages();',
      'const derivedMessages = session.deriveMessages();\n\t\tconst boundaryMessages = globalThis[Symbol.for("prompt-tool:current-system-snapshot:project")]?.(this, derivedMessages, renderedPrompt, position, signal, assembly) ?? derivedMessages;'],
  ]
  if (createHash('sha256').update(source).digest('hex') !== digest) {
    state.available = false; state.reason = 'agent-loop artifact fingerprint or structure mismatch'; return result
  }
  let transformed = source
  const budgetReady = coreEdits.every(([from]) => source.split(from).length === 2)
  const snapshotReady = snapshotEdits.every(([from]) => source.split(from).length === 2)
    && source.split('this.model = new AgentModel(projections.modelSelection, session, options);').length === 2
  if (budgetReady) for (const [from, to] of coreEdits) transformed = transformed.replace(from, to)
  if (snapshotReady) for (const [from, to] of snapshotEdits) transformed = transformed.replace(from, to)
  if (snapshotReady) transformed = transformed.replace(
    'this.model = new AgentModel(projections.modelSelection, session, options);',
    'this.model = new AgentModel(projections.modelSelection, session, options); this[Symbol.for("prompt-tool:current-system-snapshot-owner")] = true;')
  state.available = budgetReady; state.reason = budgetReady ? '' : 'agent-loop request budget structure mismatch'
  return { ...result, source: transformed }
} })
