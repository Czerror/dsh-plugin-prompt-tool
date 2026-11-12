import { registerHooks } from 'node:module'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveHostPackage } from './host-package.mjs'
import { requestBudgetState as state } from './request-budget-bridge.mjs'

const digest = 'f09f60814d4e96a880f41b9fc3832f33c56a28f954f48810d8439ce83ad6ffa8'
let target
try {
  target = pathToFileURL(resolveHostPackage('@deepseek-ai/dsh-agent-loop')).href
  const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(target)), '../package.json'), 'utf8'))
  if (pkg.name !== '@deepseek-ai/dsh-agent-loop' || pkg.version !== '0.2.2-rc.2') throw new Error('unsupported agent-loop package/version')
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
  const shapeEdits = [
    ['const decision = await this.dispatch.waterfall("agent/pre-step", {', 'let decision = await this.dispatch.waterfall("agent/pre-step", {'],
    ['\t\t\tsignal.throwIfAborted();\n\t\t\tif (decision.kind === "reject") {', '\t\t\tdecision = globalThis[Symbol.for("prompt-tool:message-shape-guards")]?.decision(this, selection, decision) ?? decision;\n\t\t\tsignal.throwIfAborted();\n\t\t\tif (decision.kind === "reject") {'],
    ['const [block] = message.content;\n\treturn message.content.length === 1', 'const content = globalThis[Symbol.for("prompt-tool:message-shape-guards")]?.content(message, shapeSession) ?? message.content;\n\tconst [block] = content;\n\treturn content.length === 1'],
    ['function textOf(message) {', 'function textOf(message, shapeSession) {'],
    ['const text = event.data.message.content.length === 0 ? "" : textOf(event.data.message);', 'const content = globalThis[Symbol.for("prompt-tool:message-shape-guards")]?.content(event.data.message, this.session) ?? event.data.message.content;\n\t\t\tconst text = content.length === 0 ? "" : textOf(event.data.message, this.session);'],
    ['const renderedPrompt = renderPrompt(assembly);', 'return (globalThis[Symbol.for("prompt-tool:message-shape-guards")]?.run ?? ((agent, assembly, signal, invoke) => invoke()))(this, assembly, signal, async () => this.shapeGuardedStep(decision));\n\t}\n\tasync shapeGuardedStep(decision) {\n\t\tconst { turn, step, abort: { signal } } = this.phase;\n\t\tconst { assembly } = decision;\n\t\tconst renderedPrompt = renderPrompt(assembly);'],
  ]
  const providerEdits = [
    ['preparedCall = await this.loopCtx.llm.prepareCall(proposedConfig, signal);',
      'preparedCall = await (globalThis[Symbol.for("prompt-tool:provider-system-roles")]?.prepare ?? ((agent, selection, invoke) => invoke()))(this, selection, () => this.loopCtx.llm.prepareCall(proposedConfig, signal));'],
  ]
  if (createHash('sha256').update(source).digest('hex') !== digest) {
    state.available = false; state.reason = 'agent-loop artifact fingerprint or structure mismatch'; return result
  }
  let transformed = source
  const budgetReady = coreEdits.every(([from]) => source.split(from).length === 2)
  const snapshotReady = snapshotEdits.every(([from]) => source.split(from).length === 2)
    && source.split('this.model = new AgentModel(projections.modelSelection, session, options);').length === 2
  const shapeReady = shapeEdits.every(([from]) => source.split(from).length === 2)
  const providerReady = providerEdits.every(([from]) => source.split(from).length === 2)
    && source.split('this.model = new AgentModel(projections.modelSelection, session, options);').length === 2
  if (providerReady) for (const [from, to] of providerEdits) transformed = transformed.replace(from, to)
  if (providerReady) transformed = transformed.replace('this.model = new AgentModel(projections.modelSelection, session, options);', 'this.model = new AgentModel(projections.modelSelection, session, options); this[Symbol.for("prompt-tool:provider-system-roles-loop-owner")] = true;')
  if (shapeReady) for (const [from, to] of shapeEdits) transformed = transformed.replace(from, to)
  if (shapeReady) transformed = transformed.replace('this.model = new AgentModel(projections.modelSelection, session, options);', 'this.model = new AgentModel(projections.modelSelection, session, options); this[Symbol.for("prompt-tool:message-shape-guards-owner")] = true;')
  if (budgetReady) for (const [from, to] of coreEdits) transformed = transformed.replace(from, to)
  if (snapshotReady) for (const [from, to] of snapshotEdits) transformed = transformed.replace(from, to)
  if (snapshotReady) transformed = transformed.replace(
    'this.model = new AgentModel(projections.modelSelection, session, options);',
    'this.model = new AgentModel(projections.modelSelection, session, options); this[Symbol.for("prompt-tool:current-system-snapshot-owner")] = true;')
  state.available = budgetReady; state.reason = budgetReady ? '' : 'agent-loop request budget structure mismatch'
  return { ...result, source: transformed }
} })
