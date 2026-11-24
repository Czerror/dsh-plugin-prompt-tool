import { basename, dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { Document, parseDocument } from 'yaml'
import { compileRules, ruleCrossValidation, type CompiledRule } from '../../engine/rule-spec.mjs'
import type { RuleDefinition, RuleEdit, RuleRevisions } from '../shared/rules.ts'
import { moduleLocalObjectStamp, readModuleEditHead, readModuleLocalObject, publishModuleRuleEdit, writeModuleLocalObject } from './module-local-state.ts'
import { assertRuleFileId, getVerifiedModuleInputs, readModuleRuleEditSettings, rememberRuntimeRuleEdit, rulePromptConfigOptions, ruleValueRevision, templateDependencyRevision } from './module-slices.ts'
import { canonicalDirectory, ModuleWriteError, record, withModuleLock } from './module-write.ts'

const version = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)
const conflict = (id: string): ModuleWriteError => new ModuleWriteError(`规则 ${id} 正文已变化，请重新读取`, 409, 'rules-conflict')
const preStepOnly = (rules: CompiledRule[]): boolean => rules.every(rule => rule.executionScope === 'agent' && rule.actions.every(action => {
  const execution = action.execution
  return action.kind === 'inject-text' && record(execution)
    && execution.channel === 'agent/pre-step' && execution.phase === 'after-next' && execution.lifecycle === 'event'
}))

function parse(text: string): unknown {
  const doc = parseDocument(text, { logLevel: 'silent' })
  if (doc.errors.length > 0) throw new ModuleWriteError(doc.errors[0]!.message)
  return doc.toJS()
}

/** 保留当前状态与其他规则，变更全局校验约束时交给完整事务。 */
export function tryEditModuleRuleContent(directory: string, edit: RuleEdit, expectedRevisions: Partial<RuleRevisions>) {
  if (!record(edit) || !record(edit.rule) || typeof edit.previousId !== 'string' || edit.previousId !== edit.rule.id
    || (edit.settingsChanged !== undefined && edit.settingsChanged !== false)) return undefined
  if (Object.keys(edit).some(key => !['previousId', 'rule', 'settingsChanged'].includes(key))
    || !record(expectedRevisions) || Object.keys(expectedRevisions).some(key => !['rules', 'settings', 'variables'].includes(key))
    || !record(expectedRevisions.rules) || Object.values(expectedRevisions.rules).some(revision => !version(revision))
    || (expectedRevisions.settings !== undefined && !version(expectedRevisions.settings))
    || (expectedRevisions.variables !== undefined && !version(expectedRevisions.variables))) throw new ModuleWriteError('规则修改项或版本对象不合法')

  const id = edit.previousId
  const requested = edit.rule
  assertRuleFileId(id)
  const dir = canonicalDirectory(directory)
  return withModuleLock(dirname(dir), basename(dir), () => {
    const current = readModuleEditHead(dir, id)
    if (!current || current.hasRuleAliases) return undefined
    const hash = current.ruleHash
    if (hash === undefined || current.ruleIndex === undefined) throw conflict(id)
    const state = readModuleRuleEditSettings(dir, current.settingsHash)
    if (record(state) && record(state._integrity) && state.settingsRevision === undefined) return undefined
    if (!record(state) || !record(state.rules) || !version(state.settingsRevision) || !version(state.variablesRevision)) {
      throw new ModuleWriteError('模块规则状态格式无效')
    }
    const settings = state.rules[id]
    const ruleStamp = moduleLocalObjectStamp(dir, hash)
    const before = parse(readModuleLocalObject(dir, hash))
    if (moduleLocalObjectStamp(dir, hash) !== ruleStamp) throw conflict(id)
    if (!record(settings) || typeof settings.order !== 'number' || !Number.isSafeInteger(settings.order) || !record(before) || before.id !== id) {
      throw new ModuleWriteError(`规则提交成员身份或顺序无效：${id}`)
    }
    if (expectedRevisions.rules?.[id] !== ruleValueRevision(before)) throw conflict(id)
    const source = getVerifiedModuleInputs(dir, current)
    if (!Array.isArray(source.modules)) throw new ModuleWriteError('当前组合没有可编辑的 modules 清单')
    const variables = (source.variables ?? {}) as Record<string, string>
    const moduleConfig = record(source.moduleConfigs) ? source.moduleConfigs['rule-engine'] : undefined
    const strategy = record(moduleConfig) ? moduleConfig.strategyDir : undefined
    const { order: _order, ...fields } = settings
    const { enabled: _enabled, group: _group, groupScope: _scope, exclusive: _exclusive, ...content } = requested
    if (content.executionScope !== before.executionScope) return undefined
    const rule: RuleDefinition = { ...content, ...fields }
    const dependencies = new Map<string, string | undefined>()
    const explicitOrder = record(source.configOrder) && Object.hasOwn(source.configOrder, id) ? source.configOrder[id] : undefined
    const order = explicitOrder ?? current.ruleIndex * 10
    if (typeof order !== 'number' || !Number.isSafeInteger(order) || order < 0) throw new ModuleWriteError('规则顺序无效')
    const options = {
      moduleId: current.moduleId,
      configOrder: { [id]: order },
      variables,
      variablesEnabled: source.variablesEnabled !== false,
      promptConfigOptions: rulePromptConfigOptions(dir, strategy, (dependency) => {
        const revision = templateDependencyRevision(dependency)
        if (dependencies.has(dependency) && dependencies.get(dependency) !== revision) throw conflict(id)
        dependencies.set(dependency, revision)
      }),
    }
    let deferUntilRequest = false
    try {
      const candidate = compileRules([rule], options)
      let previous
      try { previous = compileRules([{ ...before, ...fields }], options) }
      catch { return undefined }
      if (!isDeepStrictEqual(ruleCrossValidation(candidate, current.moduleId), ruleCrossValidation(previous, current.moduleId))) return undefined
      deferUntilRequest = preStepOnly(candidate) && preStepOnly(previous)
    } catch (error) {
      if (error instanceof ModuleWriteError) throw error
      throw new ModuleWriteError(String((error as Error).message ?? error))
    }
    const verify = (): void => {
      for (const [dependency, revision] of dependencies) if (templateDependencyRevision(dependency) !== revision) throw conflict(id)
    }
    verify()
    const ruleRevision = ruleValueRevision(content)
    const nextHash = ruleRevision === expectedRevisions.rules![id] ? hash
      : writeModuleLocalObject(dir, new Document(content).toString())
    const committed = publishModuleRuleEdit(dir, current, id, nextHash, () => {
      if (moduleLocalObjectStamp(dir, hash) !== ruleStamp) throw conflict(id)
      readModuleLocalObject(dir, hash)
      if (readModuleRuleEditSettings(dir, current.settingsHash) !== state || getVerifiedModuleInputs(dir, current) !== source) throw conflict(id)
      verify()
    })
    if (committed.generation !== current.generation) rememberRuntimeRuleEdit(dir, { previous: current.generation, generation: committed.generation, id, dependencies })
    return { rule, ruleRevision, definitionRevision: committed.generation, settingsRevision: state.settingsRevision, variablesRevision: state.variablesRevision,
      ...(deferUntilRequest && committed.generation !== current.generation ? { deferUntilRequest: true as const } : {}) }
  })
}
