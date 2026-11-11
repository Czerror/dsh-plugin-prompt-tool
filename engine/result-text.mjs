import { isDeepStrictEqual } from 'node:util'
import { resultTextOwners } from './result-text-owners.mjs'
import { toolStepFor } from './tool-scope.mjs'

const regions = new Set(['web-notice', 'sandbox'])
const namesFor = region => region === 'web-notice' ? ['web_search', 'web_fetch']
  : ['bash', 'pwsh', 'write', 'edit', 'apply_patch', 'str_replace_editor', 'run_code']
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const singleText = content => Array.isArray(content) && content.length === 1 && content[0]?.type === 'text'
  && typeof content[0].text === 'string' ? content[0].text : undefined

export function resultTextOwnerStatus(definition, region) {
  const owner = resultTextOwners.renderers.get(definition?.output?.render)
  const supported = region === 'web-notice' ? owner?.owner === '@deepseek-ai/dsh-tool-web'
    : region === 'sandbox' && ['@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-tool-pwsh', '@deepseek-ai/dsh-tool-fs',
      '@deepseek-ai/dsh-tool-str-replace-editor', '@deepseek-ai/dsh-tool-executor-ptc'].includes(owner?.owner)
  const available = supported === true && owner.execute === definition.execute && owner.project === definition.projectContent
    && owner.finalize === definition.finalizeContent
  return { available, reason: available ? '' : 'verified official result owner or early entry unavailable' }
}

/** 同分支声明的结果能力决定关联装配正文资格；结果条件仍只在实际结果出口求值。 */
export function bindResultTextDependencies(rule, moduleId, onOutcome) {
  const controls = rule.actions.filter(action => action.kind === 'tool-result' && action.action === 'edit-text').map(action => ({
    action, dependent: new Set(rule.actions.filter(candidate => action.branchPath.every((part, index) => candidate.branchPath[index] === part)).map(candidate => candidate.id)),
  }))
  if (controls.length === 0) return
  rule.resultTextAvailable = (entry, frame) => {
    if (frame.channel !== 'system-prompt/assemble') return true
    const related = controls.filter(control => control.dependent.has(entry.ruleActionId ?? entry.id))
    if (related.length === 0) return true
    const context = frame.args[1]
    const view = context?.toolSet?.view(context.agent)
    let ready = true
    for (const { action } of related) for (const region of new Set(action.edits.map(edit => edit.region))) {
      const targets = view === undefined ? [] : namesFor(region).map(name => [name, view.get(name)]).filter(([, definition]) => definition !== undefined)
      const failures = targets.map(([name, definition]) => ({ name, ...resultTextOwnerStatus(definition, region) })).filter(status => !status.available)
      if (targets.length > 0 && failures.length === 0) continue
      ready = false
      const reason = targets.length === 0 ? `${region}: verified official result owner or resolved tool step unavailable`
        : failures.map(status => `${status.name}: ${status.reason}`).join('; ')
      const reported = frame.resultTextDependencies ??= new Set()
      const key = JSON.stringify([moduleId, rule.id, action.id, region])
      if (!reported.has(key)) {
        reported.add(key)
        try { onOutcome?.({ moduleId, ruleId: rule.id, actionId: action.id, channel: 'tool:results',
          definitionRevision: rule.definitionRevision, agentId: frame.subject?.agent?.id,
          outcome: 'unavailable', identityOutcome: 'condition-unavailable', reason }) } catch { /* 只读诊断不改变资格 */ }
      }
    }
    return ready
  }
}

export function validateResultTextEdits(edits, plugin) {
  if (!Array.isArray(edits) || edits.length === 0) throw new TypeError(`${plugin}: tool-result.edits must be a non-empty array`)
  for (const entry of edits) {
    if (!record(entry) || Object.keys(entry).some(key => !['region', 'match', 'text'].includes(key))
      || !regions.has(entry.region) || typeof entry.match !== 'string' || entry.match.length === 0 || typeof entry.text !== 'string') {
      throw new TypeError(`${plugin}: tool-result.edits entries must be { region: web-notice|sandbox, match: non-empty string, text: string }`)
    }
  }
}

function resultRegion(region, exec, result, definition, original) {
  const evidence = result.isError ? undefined : resultTextOwners.results.get(result.value)
  const owner = resultTextOwners.renderers.get(definition?.output?.render)
  if (!resultTextOwnerStatus(definition, region).available) return undefined
  if (region === 'sandbox' && result.isError === true) {
    return ['@deepseek-ai/dsh-tool-fs', '@deepseek-ai/dsh-tool-str-replace-editor'].includes(owner.owner)
      && result.error?.info?.code === 'FS_SANDBOX_DENIED' && original === `Error: ${result.error.message}`
      ? [7, original.length] : undefined
  }
  if (result.isError) return undefined
  if (evidence?.render !== definition.output.render || evidence.execute !== definition.execute
    || evidence.args !== exec.arguments || evidence.text !== original) return undefined
  const value = result.value
  if (region === 'web-notice') {
    if (owner.owner !== '@deepseek-ai/dsh-tool-web') return undefined
    let start
    if (exec.name === 'web_search' && Array.isArray(value?.sources) && typeof value.truncated === 'boolean') start = 0
    if (exec.name === 'web_fetch' && typeof value?.url === 'string' && Number.isInteger(value.statusCode)) {
      const header = `Fetched ${value.url} (HTTP ${value.statusCode})\n\n`
      if (original.startsWith(header)) start = header.length
    }
    if (start === undefined) return undefined
    const end = original.indexOf('\n\n', start)
    return end < 0 ? undefined : [start, end]
  }
  if (owner.owner === '@deepseek-ai/dsh-tool-fs' && exec.name === 'apply_patch' && Array.isArray(value?.operations)) {
    const failures = value.operations.filter(operation => operation?.code === 'FS_SANDBOX_DENIED'
      && ['failed', 'unknown'].includes(operation.status) && typeof operation.message === 'string' && operation.message.length > 0)
    if (failures.length !== 1) return undefined
    const message = failures[0].message
    const start = original.indexOf(message)
    return start >= 0 && original.indexOf(message, start + 1) < 0 ? [start, start + message.length] : undefined
  }
  if (value?.sandbox?.denied !== true) return undefined
  const marker = owner.owner === '@deepseek-ai/dsh-tool-executor-ptc'
    ? `The ${value.sandbox.mode} file sandbox denied an operation.`
    : ['@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-tool-pwsh'].includes(owner.owner)
      ? `[sandbox: file access denied under ${value.sandbox.mode} mode]` : undefined
  if (marker === undefined) return undefined
  const start = original.lastIndexOf(marker)
  return start >= 0 && (start === 0 || original[start - 1] === '\n') ? [start, original.length] : undefined
}

/** 仅返回content投影；原值、异常、meta和下游决定均由官方结果链保留。 */
export function editResultText(exec, result, decision, plans, tools, originalDefinition) {
  if (decision?.kind !== 'accept' || Object.hasOwn(decision, 'value') || decision.content !== undefined
    && !isDeepStrictEqual(decision.content, result.content)) return decision
  const original = singleText(result.content)
  const definition = originalDefinition ?? tools?.executable?.(exec.name, exec.agent, exec.toolSet)
    ?? exec.toolSet?.view(exec.agent)?.get(exec.name) ?? tools?.get(exec.name, exec.agent, exec.toolSet)
    ?? (exec.name === 'run_code' ? resultTextOwners.results.get(result.value)?.definition : undefined)
  let content = result.content
  let selected = new Map(), applied = new Set()
  for (const plan of plans) {
    const previous = selected, previousApplied = applied
    selected = new Map([...selected].map(([key, value]) => [key, { ...value }]))
    applied = new Set(applied)
    const reasons = []
    let changed = false, matched = false
    for (const entry of plan.edits) {
      if (!namesFor(entry.region).includes(exec.name)) continue
      if (resultTextOwnerStatus(definition, entry.region).available) {
        if (entry.region === 'web-notice' && result.isError) continue
        if (entry.region === 'sandbox' && (result.isError ? result.error?.info?.code !== 'FS_SANDBOX_DENIED'
          : result.value?.sandbox?.denied !== true && !(exec.name === 'apply_patch'
            && result.value?.operations?.some(operation => operation?.code === 'FS_SANDBOX_DENIED')))) continue
      }
      const key = JSON.stringify(entry)
      if (applied.has(key)) { matched = true; continue }
      let region = selected.get(entry.region)
      if (region === undefined) {
        const range = original === undefined ? undefined : resultRegion(entry.region, exec, result, definition, original)
        if (range !== undefined) { region = { range, text: original.slice(...range) }; selected.set(entry.region, region) }
      }
      const at = region?.text.indexOf(entry.match) ?? -1
      const mixed = entry.region === 'web-notice' && region?.text !== entry.match
      if (at < 0 || mixed || region.text.indexOf(entry.match, at + 1) >= 0) {
        const reason = `${plan.plugin}: tool-result ${JSON.stringify(exec.name)} ${entry.region} owner or match missing or ambiguous; skipped`
        reasons.push(reason)
        plan.warnOnce?.(reason)
        continue
      }
      matched = true
      applied.add(key)
      const text = region.text.slice(0, at) + entry.text + region.text.slice(at + entry.match.length)
      changed ||= text !== region.text
      region.text = text
    }
    if (changed && plan.take?.(exec) === false) { selected = previous; applied = previousApplied; continue }
    try {
      if (reasons.length > 0) plan.onUnavailable?.(reasons.join('; '), exec)
      else if (matched) plan.onApplied?.(exec)
    } catch { /* 只读诊断不改变结果 */ }
  }
  if (selected.size > 0) {
    let text = original
    for (const { range: [start, end], text: replacement } of [...selected.values()].sort((a, b) => b.range[0] - a.range[0])) {
      text = text.slice(0, start) + replacement + text.slice(end)
    }
    if (text !== original) content = [{ ...result.content[0], text }]
  }
  return content === result.content ? decision : { ...decision, content }
}

// post策略读取原结果；条件与说明只在其结算后处理同一份未被接管的结果。
resultTextOwners.project = (exec, result, definition) => {
  const plans = toolStepFor(exec)?.resultTextPlans
  if (plans === undefined) return undefined
  resultTextOwners.handled.add(exec)
  resultTextOwners.prepared.set(exec, { plans, definition, result })
  return undefined
}

resultTextOwners.finalize = (exec, result) => {
  const prepared = resultTextOwners.prepared.get(exec)
  resultTextOwners.prepared.delete(exec)
  if (prepared === undefined || result.isError !== prepared.result.isError || result.value !== prepared.result.value
    || !isDeepStrictEqual(result.error, prepared.result.error) || !isDeepStrictEqual(result.meta, prepared.result.meta)
    || !isDeepStrictEqual(result.content, prepared.result.content)) return undefined
  try {
    const active = prepared.plans.filter(plan => plan.matches(exec, result))
    return editResultText(exec, result, { kind: 'accept' }, active, undefined, prepared.definition).content
  }
  catch (error) {
    for (const plan of prepared.plans) try { plan.warnOnce?.(`${plan.plugin}: result text finalization failed; keeping original content: ${String(error?.message ?? error)}`) } catch {}
    return undefined
  }
}
