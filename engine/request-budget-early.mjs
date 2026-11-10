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
  const edits = [
    ['this.model = new AgentModel(projections.modelSelection, session, options);',
      'this.model = new AgentModel(projections.modelSelection, session, options); this[Symbol.for("prompt-tool:request-budget-owner")] = true;'],
    ['const seedConfig = deepFreeze(structuredClone({',
      'const priorBudget = this[Symbol.for("prompt-tool:request-budget-seed")]; delete this[Symbol.for("prompt-tool:request-budget-seed")];\n'
      + 'if (priorBudget !== undefined && Object.is(controls.maxTokens, priorBudget.value)) { if (priorBudget.present) controls.maxTokens = priorBudget.original; else delete controls.maxTokens; }\n'
      + 'const seedConfig = deepFreeze(structuredClone({'],
    [acceptedFrom, acceptedFrom.replace('\t\treturn {', '\t\tglobalThis[Symbol.for("prompt-tool:request-budget")]?.accepted(this, proposedConfig, config);\n\t\treturn {')],
  ]
  if (createHash('sha256').update(source).digest('hex') !== digest || edits.some(([from]) => source.split(from).length !== 2)) {
    state.available = false; state.reason = 'agent-loop artifact fingerprint or structure mismatch'; return result
  }
  let transformed = source
  for (const [from, to] of edits) transformed = transformed.replace(from, to)
  state.available = true; state.reason = ''
  return { ...result, source: transformed }
} })
