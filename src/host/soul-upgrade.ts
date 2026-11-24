/** 定向升级只生成候选，持久化仍由正式导入预览与重建事务拥有。 */
import { isAlias, isMap, isScalar, isSeq, parseDocument } from 'yaml'
import type { Document, YAMLSeq } from 'yaml'
import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { assertModuleDirectory } from './module-install.ts'
import { packageModulesDir, userModulesDir } from './module-dirs.ts'
import { serializeWithoutSharedAlias } from './module-write.ts'
import { readModuleDefinitionExport } from './module-slices.ts'
import { expandModuleSource, exportModulePackage } from './module-package.ts'
import type { AssetFile } from '../shared/asset-transfer.ts'
import { decodeAssetFile } from './import-source.ts'
import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'

// 8431b2d7 有效提示资产基线；统一换行，用户未知正文必须先解决冲突。
const ASSET_BASELINES: Record<string, string> = {
  'assets/tools.md': '88f2f18d6f87777f2e8fc850b5938d063f68f5d9730066f62221ba2aa4cba557',
  'assets/ledger.md': 'd386102c931a553e1c4d7e5516a8b0901ce560da66501c67c5f7b6daffb6084c',
}

const RULE_IDS = ['soul-ledger-open', 'soul-check']
const VARIABLE_IDS = ['ledger_open', 'ledger_seq']
// 9007bf28 modules/soul/module.yml：只保留本次升级拥有的两个完整规则。
const BASELINE = `rules:
  - id: soul-check
    name: 检查失败处置
    enabled: true
    layer: system-section
    if: { manifest: { ok: false } }
    then:
      - id: inject
        kind: inject-text
        config:
          id: soul-check
          layer: system-section
          strategy: static
          order: 247
          text: |-
            清单检查当前有未通过项（由引擎按装配事实求值，不需要手写变量）：
            先 module_manifest（moduleId: soul）action=check 看全部明细，
            再说清是哪一条、证据是什么、下一步改哪个文件或哪条规则；
            修完要重新 check，不要用「已修复」代替重新检查，也不要把失败项藏进总结。
  - id: soul-ledger-open
    name: 未结账本提醒
    enabled: true
    layer: pre-step
    if: { variable: { key: ledger_open, op: gt, value: '0' } }
    then:
      - id: inject
        kind: inject-text
        config:
          id: soul-ledger-open
          layer: pre-step
          strategy: static
          position: before-all
          order: 126
          role: user
          text: |-
            账本还有未结事项：回复里逐条收口，或说清为什么先放着。
            先用 soul_ledger（moduleId: soul，action: list）核对原始未结记录；
            需要追加时用 soul_ledger（moduleId: soul，action: append，type: fact/shelved/gain/loss/persona/container 之一，概要: 一句话，ref: 出处），
            作者和时间由宿主提供，promise 只允许最后 lead 署名的主导会话；lead 需用户指定并经审批。
            只往后加，不改旧行；收口后把 ledger_open 减到 0。
`

export async function readSoulUpgradePreview(moduleDir: string) {
  const directory = assertModuleDirectory(userModulesDir(), basename(moduleDir))
  if (directory !== moduleDir && directory.replaceAll('\\', '/') !== moduleDir.replaceAll('\\', '/')) throw new Error('Soul升级目标不在当前用户模块根')
  const { text: source, revision } = readModuleDefinitionExport(directory)
  if (Buffer.byteLength(source) > 1024 * 1024) throw new Error('Soul升级模块定义无效或超限')
  const value = parseDocument(source)
  if (value.errors.length) throw new Error('Soul升级YAML无效')
  const rules = value.get('rules')
  if (!isSeq(rules) || !RULE_IDS.every(id => rules.items.some(rule => isMap(rule) && rule.get('id') === id))) return { status: 'not-applicable' as const }
  const seed = readFileSync(join(packageModulesDir(), 'soul/module.yml'), 'utf8')
  const preview = previewSoulUpgrade(source, BASELINE, seed)
  const result = { ...preview, expectedRevision: revision, files: [] as AssetFile[],
    apply: '真实用户使用 /prompt-tool upgrade {"moduleId":"目标模块","action":"preview"} 审阅；确认时action=confirm并原样带回expectedRevision、expectedSourceDigest、expectedPreviewRevision。保留私有资产并重建；升级不授权知识库，不自动更新用户副本。' }
  if (!preview.candidate) return result
  const exported = await exportModulePackage(userModulesDir(), { id: basename(moduleDir), mode: 'zip' })
  const files = await expandModuleSource([{ path: 'soul.zip', content: exported.content, encoding: 'base64' }])
  const current = await exportModulePackage(userModulesDir(), { id: basename(moduleDir), mode: 'zip', preview: true })
  if (current.revision !== exported.revision) throw new Error('Soul升级资产已变化，请重新预览')
  if (readModuleDefinitionExport(directory).revision !== revision) throw new Error('Soul升级定义已变化，请重新预览')
  result.files = files.map(file => file.path === 'module.yml' ? { path: file.path, content: preview.candidate! } : file)
  for (const path of ['assets/retrieval-synonyms.json', ...Object.keys(ASSET_BASELINES)]) {
    const content = readFileSync(join(packageModulesDir(), 'soul', path), 'utf8')
    const index = result.files.findIndex(file => file.path === path)
    const before = index < 0 ? null : decodeAssetFile(result.files[index]!).toString('utf8')
    const normalized = (text: string) => text.replaceAll('\r\n', '\n')
    if (before !== null && normalized(before) === normalized(content)) continue
    if (before !== null && createHash('sha256').update(normalized(before)).digest('hex') !== ASSET_BASELINES[path]) {
      result.conflicts.push(`${path}: 用户已修改资产，请先审阅并解决差异`)
      continue
    }
    if (index < 0) result.files.push({ path, content })
    else result.files[index] = { path, content }
    result.changes.push({ id: path, before, after: content })
  }
  if (result.conflicts.length) return { ...result, status: 'conflict' as const, candidate: null, files: [] }
  return result
}
type Rule = Record<string, unknown>
function knownShape(value: unknown, shape: unknown): unknown {
  if (Array.isArray(shape)) return Array.isArray(value) ? value.map((item, i) => knownShape(item, shape[i])) : value
  if (shape && typeof shape === 'object' && value && typeof value === 'object') return Object.fromEntries(Object.keys(shape).map(key => [key, knownShape((value as Rule)[key], (shape as Rule)[key])]))
  return value
}
function mergeValue(current: unknown, old: unknown, fresh: unknown): unknown {
  if (Array.isArray(fresh)) return fresh.map((item, index) => mergeValue(Array.isArray(current) ? current[index] : undefined, Array.isArray(old) ? old[index] : undefined, item))
  if (fresh && typeof fresh === 'object') {
    const result: Rule = current && typeof current === 'object' && !Array.isArray(current) ? structuredClone(current as Rule) : {}
    for (const key of Object.keys(old && typeof old === 'object' ? old : {})) if (!(key in fresh) && !['enabled', 'order'].includes(key)) delete result[key]
    for (const [key, value] of Object.entries(fresh)) {
      if (['enabled', 'order'].includes(key) && key in result) continue
      result[key] = mergeValue(result[key], old && typeof old === 'object' ? (old as Rule)[key] : undefined, value)
    }
    return result
  }
  return fresh
}
function patchNode(document: Document, current: unknown, wanted: unknown): unknown {
  if (isAlias(current)) throw new Error('Soul升级目标含共享引用，请先解除相关引用')
  if (isMap(current) && wanted && typeof wanted === 'object' && !Array.isArray(wanted)) {
    for (const key of current.items.map(pair => String(pair.key))) if (!(key in wanted)) current.delete(key)
    for (const [key, value] of Object.entries(wanted)) current.set(key, patchNode(document, current.get(key, true), value))
    return current
  }
  if (isSeq(current) && Array.isArray(wanted)) {
    current.items = wanted.map((value, index) => patchNode(document, current.items[index], value)) as YAMLSeq['items']
    return current
  }
  if (isScalar(current) && (wanted === null || typeof wanted !== 'object')) { current.value = wanted; return current }
  const next = document.createNode(wanted)
  if (current && typeof current === 'object') for (const key of ['comment', 'commentBefore', 'spaceBefore'] as const) if (key in current) (next as unknown as Rule)[key] = (current as Rule)[key]
  return next
}
function behavior(rule: Rule): string {
  const value = structuredClone(rule)
  delete value.enabled; delete value.order
  if (Array.isArray(value.then)) for (const action of value.then) {
    if (action && typeof action === 'object' && action.config && typeof action.config === 'object') delete action.config.order
  }
  return JSON.stringify(value)
}

export function previewSoulUpgrade(source: string, baseline: string, newSeed: string) {
  const documents = [source, baseline, newSeed].map(text => {
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Soul升级YAML超过1 MiB')
    const doc = parseDocument(text)
    if (doc.errors.length || !isMap(doc.contents)) throw new Error('Soul升级YAML无效')
    return doc
  })
  const [document, base, seed] = documents
  // 候选必须独立展开别名，否则JS共享对象会同步掩盖YAML连带修改。
  const expected = JSON.parse(JSON.stringify(document!.toJS())) as Rule
  const conflicts: string[] = []
  const changes: { id: string; before: unknown; after: unknown }[] = []
  const sourceRules = document!.get('rules'), baseRules = base!.get('rules'), seedRules = seed!.get('rules')
  if (!isSeq(sourceRules) || !isSeq(baseRules) || !isSeq(seedRules)) throw new Error('Soul升级YAML缺少rules数组')
  for (const id of RULE_IDS) {
    const current = sourceRules.items.filter(rule => isMap(rule) && rule.get('id') === id)
    const old = baseRules.items.find(rule => isMap(rule) && rule.get('id') === id)
    const fresh = seedRules.items.find(rule => isMap(rule) && rule.get('id') === id)
    if (current.length !== 1 || !isMap(current[0]) || !isMap(old) || !isMap(fresh)) { conflicts.push(`${id}: 目标规则缺失或重复`); continue }
    const node = current[0], before = node.toJSON() as Rule
    const oldValue = old.toJSON() as Rule, freshValue = fresh.toJSON() as Rule
    if (behavior(knownShape(before, freshValue) as Rule) === behavior(freshValue)) continue
    if (behavior(knownShape(before, oldValue) as Rule) !== behavior(oldValue)) { conflicts.push(`${id}: 用户已修改规则行为`); continue }
    const after = mergeValue(before, oldValue, freshValue) as Rule
    ;(expected.rules as Rule[])[sourceRules.items.indexOf(node)] = after
    patchNode(document!, node, after)
    changes.push({ id, before, after })
  }
  const external = document!.toJS()
  external.rules = external.rules.filter((rule: Rule) => !RULE_IDS.includes(String(rule.id)))
  for (const id of VARIABLE_IDS) if (external.variables) delete external.variables[id]
  const consumers = JSON.stringify(external)
  for (const id of VARIABLE_IDS) {
    if (consumers.includes(id)) { conflicts.push(`${id}: 目标规则以外仍有引用`); continue }
    const variables = document!.get('variables')
    if (isMap(variables) && variables.has(id)) { changes.push({ id, before: (expected.variables as Rule)?.[id], after: null }); variables.delete(id); delete (expected.variables as Rule)[id] }
  }
  for (const [capability, keys] of [['retrieval', ['synonymsFile']], ['soul-maintenance', ['pressureThresholds', 'assistedInputTarget', 'assistedOutputTokens', 'assistedTimeoutMs', 'assistedSessionTokens', 'assistedSessionMs', 'assistedBacklogTurns']], ['generation-recovery', ['lineRepeatChars', 'crossCallRepeatChars', 'maxCycleChars']]] as const) {
    for (const key of keys) {
      const path = ['moduleConfigs', capability, key]
      const fresh = seed!.getIn(path)
      if (fresh === undefined) continue
      const freshValue: unknown = isSeq(fresh) || isMap(fresh) || isScalar(fresh) ? fresh.toJSON() : fresh
      const current = document!.getIn(path)
      const currentValue: unknown = isSeq(current) || isMap(current) || isScalar(current) ? current.toJSON() : current
      if (currentValue !== undefined) {
        if (!isDeepStrictEqual(currentValue, freshValue)) conflicts.push(`${capability}.${key}: 用户已配置不同值`)
        continue
      }
      expected.moduleConfigs ??= {}
      ;(expected.moduleConfigs as Rule)[capability] ??= {}
      ;((expected.moduleConfigs as Rule)[capability] as Rule)[key] = structuredClone(freshValue)
      document!.setIn(path, document!.createNode(freshValue))
      changes.push({ id: `${capability}.${key}`, before: null, after: freshValue })
    }
  }
  return { status: conflicts.length ? 'conflict' as const : 'ready' as const, conflicts, changes, candidate: conflicts.length ? null : serializeWithoutSharedAlias(document!, expected, 'Soul升级共享引用会连带改变用户定义，请先解除相关引用') }
}
