/** 普通模块并入与来源撤回：预览绑定两端快照，贡献只由完整定义持有。 */
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { isSeq } from 'yaml'
import type { ModuleMergeRequest, ModuleMergeSnapshot } from '../shared/bridge-contract.ts'
import { assertSafeRelativePath } from '../shared/asset-path.ts'
import { moduleImportPreview, moduleMergeFiles } from './module-package.ts'
import { assertModuleDirectory, assertModuleId, assertModuleTree } from './module-install.ts'
import { installModuleDirectory, leftoverStageWarning } from './module-install-transaction.ts'
import { loadModuleDefinition, nextModuleConfigSequence } from './module-slices.ts'
import { invalidateModuleSpec } from './module-spec.ts'
import { ModuleWriteError, record, revisionOf, serializeWithoutSharedAlias, withModuleLock } from './module-write.ts'
import { directoryVersionOf } from './preview-revision.ts'
import { finalizeModuleCandidate } from './write-module.ts'

type Contribution = { path: string[]; value: unknown; item?: string; owned: boolean }
type Source = { revision: string; definitions: Contribution[]; files: Array<{ path: string; revision: string; owned: boolean }>; ruleIds: Record<string, string> }
type Sources = Record<string, Source>
const LEDGER = 'mergeSources'
const metadata = new Set(['id', 'name', 'description', 'version', 'engineCompat', 'order', 'meta', 'upstream', 'mergedModules', LEDGER])
const rejected = (message: string): never => { throw new ModuleWriteError(message, 400, 'module-merge-rejected') }
const stale = (): never => { throw new ModuleWriteError('并入预览已过期，请重新预览', 409, 'module-merge-stale') }
const same = isDeepStrictEqual
const keyOf = (entry: Contribution): string => JSON.stringify([entry.path, entry.item ?? null])

function sourcesOf(value: unknown): Sources {
  if (value === undefined) return {}
  if (!record(value) || value.version !== 1 || !record(value.sources)) return rejected('来源所有权记录无法识别，拒绝修改')
  for (const [id, source] of Object.entries(value.sources)) {
    assertModuleId(id)
    if (!record(source) || typeof source.revision !== 'string' || !Array.isArray(source.definitions) || !Array.isArray(source.files) || !record(source.ruleIds)) return rejected('来源所有权记录损坏')
    for (const entry of source.definitions) {
      if (!record(entry) || !Array.isArray(entry.path) || entry.path.length === 0 || entry.path.some(key => typeof key !== 'string' || !key || ['__proto__', 'constructor', 'prototype'].includes(key))
        || metadata.has(entry.path[0] as string) || typeof entry.owned !== 'boolean' || (entry.item !== undefined && typeof entry.item !== 'string')) return rejected('来源定义所有权记录损坏')
    }
    for (const file of source.files) {
      if (!record(file) || typeof file.path !== 'string' || typeof file.revision !== 'string' || typeof file.owned !== 'boolean') return rejected('来源资产所有权记录损坏')
      const path = assertSafeRelativePath(file.path)
      if (path === 'module.yml' || /^(?:rules|data|skills)(?:\/|$)/.test(path) || path === 'memory.md') return rejected('来源资产记录不属于可撤回资产')
    }
  }
  return structuredClone(value.sources) as Sources
}

function checkRequest(targetId: string, request: ModuleMergeRequest): asserts request is ModuleMergeRequest & { sourceId: string; action: 'merge' | 'remove' } {
  assertModuleId(targetId)
  if (request.expectedModuleId !== targetId) rejected('操作声明与目标模块主语不一致')
  if (Object.keys(request).some(key => !['expectedModuleId', 'action', 'sourceId', 'preview', 'expectedRevision'].includes(key))) rejected('并入请求含未知字段')
  if (request.action !== 'merge' && request.action !== 'remove') rejected('action 必须为 merge 或 remove')
  assertModuleId(request.sourceId)
  if (request.sourceId === targetId) rejected('来源和目标必须是两个模块')
  if (request.preview !== undefined && typeof request.preview !== 'boolean') rejected('preview 必须为布尔值')
  if (request.expectedRevision !== undefined && (typeof request.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(request.expectedRevision))) rejected('预览版本无效')
}

export function readModuleMergeSources(root: string, targetId: string): ModuleMergeSnapshot {
  const target = assertModuleDirectory(root, targetId)
  const sources = sourcesOf(loadModuleDefinition(target).source[LEDGER])
  return { targetId, sources: Object.keys(sources), rules: [], files: [] }
}

function contributionValue(source: Record<string, unknown>, entry: Contribution): unknown {
  let current: unknown = source
  for (const key of entry.path) current = record(current) ? current[key] : undefined
  if (entry.item !== undefined) return Array.isArray(current) ? current.find(value => record(value) ? value.id === entry.item : value === entry.item) : undefined
  return current
}

function updateDefinition(doc: ReturnType<typeof loadModuleDefinition>['doc'], before: Record<string, unknown>, after: Record<string, unknown>, path: string[] = []): void {
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (same(before[key], after[key])) continue
    const next = [...path, key]
    if (after[key] === undefined) { doc.deleteIn(next); continue }
    if (record(before[key]) && record(after[key])) { updateDefinition(doc, before[key], after[key], next); continue }
    const sequence = doc.getIn(next, true)
    if (path.length === 0 && ['rules', 'customTools', 'modules'].includes(key) && Array.isArray(before[key]) && Array.isArray(after[key]) && isSeq(sequence)) {
      const identity = (value: unknown): unknown => record(value) ? value.id : value
      const previous = before[key] as unknown[], following = after[key] as unknown[]
      for (let index = previous.length - 1; index >= 0; index--) if (!following.some(item => identity(item) === identity(previous[index]))) sequence.delete(index)
      for (const item of following) if (!previous.some(old => identity(old) === identity(item))) sequence.add(doc.createNode(item))
    } else doc.setIn(next, after[key])
  }
}

function prepare(root: string, targetId: string, request: ModuleMergeRequest) {
  checkRequest(targetId, request)
  const target = assertModuleDirectory(root, targetId)
  assertModuleTree(target)
  const targetVersion = directoryVersionOf(target)
  const snapshot = loadModuleDefinition(target)
  const doc = snapshot.doc.clone()
  const definitions = structuredClone(snapshot.source)
  const sources = sourcesOf(definitions[LEDGER])
  const assets = moduleMergeFiles(root, targetId)
  const existingFiles = new Map(assets.map(file => [file.path.normalize('NFC').toLowerCase(), file]))
  const addFiles: Array<{ path: string; bytes: Buffer }> = []
  const removeFiles: string[] = []
  let sourceVersion: string | null = null
  let sourceFiles: Array<{ path: string; bytes: Buffer }> = []
  let sourceDir: string | undefined
  let changed = false
  let rules: string[] = []
  let files: string[] = []
  if (request.action === 'merge') {
    sourceDir = assertModuleDirectory(root, request.sourceId)
    assertModuleTree(sourceDir)
    sourceVersion = directoryVersionOf(sourceDir)
    sourceFiles = moduleMergeFiles(root, request.sourceId)
    const source = loadModuleDefinition(sourceDir)
    if ((Array.isArray(snapshot.source.modules) || Array.isArray(source.source.modules))
      && (snapshot.source.composition !== undefined || source.source.composition !== undefined)) rejected('modules 与 composition 组合来源不能同时保真，请先显式处理')
    if (source.variablesEnabled !== snapshot.variablesEnabled) rejected('来源与目标的变量开关不同，无法保持两端变量语义')
    if ((source.source.contextActivationRecursive === true) !== (snapshot.source.contextActivationRecursive === true)) rejected('来源与目标的上下文递归开关不同，无法无歧义并入')
    // 元数据和未知字段的语义不能由并入器猜测；保留目标，非等值来源必须明确处理。
    const ignored = ['id', 'name', 'description', 'version', 'engineCompat', 'order', 'upstream', LEDGER]
    for (const key of ['meta', 'mergedModules']) if (source.source[key] !== undefined && !same(source.source[key], snapshot.source[key])) rejected(`来源字段 ${key} 不能无歧义并入，请先显式处理`)
    const sourceRevision = revisionOf(JSON.stringify([source.text, sourceFiles.map(file => [file.path, revisionOf(file.bytes)])]))
    const previous = sources[request.sourceId]
    if (previous && previous.revision !== sourceRevision) rejected('该来源并入后已变化，请先移除既有来源再重新并入')
    if (!previous) {
      const incoming: Source = { revision: sourceRevision, definitions: [], files: [], ruleIds: {} }
      const merge = (destination: Record<string, unknown>, input: Record<string, unknown>, path: string[] = []): void => {
        for (const [key, value] of Object.entries(input)) {
          if (path.length === 0 && (ignored.includes(key) || key === 'configOrder')) continue
          if (['__proto__', 'constructor', 'prototype'].includes(key)) rejected('来源含不安全字段')
          const next = [...path, key]
          const old = destination[key]
          if (record(value)) {
            if (old !== undefined && !record(old)) rejected(`定义冲突：${next.join('.')}`)
            destination[key] ??= {}
            merge(destination[key] as Record<string, unknown>, value, next)
          } else if (path.length === 0 && ['rules', 'customTools', 'modules'].includes(key) && Array.isArray(value)) {
            if (old !== undefined && !Array.isArray(old)) rejected(`定义冲突：${key}`)
            const entries = (destination[key] ??= []) as unknown[]
            for (const item of value) {
              const id = record(item) ? item.id : item
              if (typeof id !== 'string' || !id) rejected(`无法识别 ${key} 的条目身份`)
              const current = entries.find(entry => record(entry) ? entry.id === id : entry === id)
              if (current !== undefined && (key !== 'modules' || !same(current, item))) rejected(`${key} 身份冲突：${id}`)
              incoming.definitions.push({ path: next, item: id as string, value: structuredClone(item), owned: current === undefined })
              if (current === undefined) entries.push(structuredClone(item))
              if (key === 'rules') incoming.ruleIds[id as string] = id as string
            }
          } else {
            if (old !== undefined && !same(old, value)) rejected(`定义冲突：${next.join('.')}`)
            incoming.definitions.push({ path: next, value: structuredClone(value), owned: old === undefined })
            if (old === undefined) destination[key] = structuredClone(value)
          }
        }
      }
      merge(definitions, source.source)
      const order = definitions.configOrder = { ...snapshot.configOrder, ...(definitions.configOrder as Record<string, number> | undefined) }
      for (const rule of source.rules) {
        if (order[rule.id] !== undefined) rejected(`目标已有该规则身份的顺序元数据，拒绝冲突：${rule.id}`)
        const sequence = nextModuleConfigSequence(order)
        order[rule.id] = sequence
        incoming.definitions.push({ path: ['configOrder', rule.id], value: sequence, owned: true })
      }
      for (const file of sourceFiles) {
        if (file.path === 'module.yml') continue
        const current = existingFiles.get(file.path.normalize('NFC').toLowerCase())
        if (current && (current.path !== file.path || !current.bytes.equals(file.bytes))) rejected(`资产路径或内容冲突：${file.path}`)
        incoming.files.push({ path: file.path, revision: revisionOf(file.bytes), owned: current === undefined })
        if (!current) addFiles.push(file)
      }
      sources[request.sourceId] = incoming
      changed = true
    }
    rules = Object.keys(sources[request.sourceId]!.ruleIds)
    files = sources[request.sourceId]!.files.map(file => file.path)
  } else {
    const outgoing = sources[request.sourceId]
    if (outgoing) {
      rules = Object.keys(outgoing.ruleIds)
      files = outgoing.files.map(file => file.path)
      delete sources[request.sourceId]
      for (const entry of outgoing.definitions) {
        if (!same(contributionValue(definitions, entry), entry.value)) rejected(`来源贡献已被修改，拒绝移除：${entry.path.join('.')}${entry.item ? ':' + entry.item : ''}`)
        if (!entry.owned) continue
        const shared = Object.values(sources).flatMap(source => source.definitions).find(other => keyOf(other) === keyOf(entry))
        if (shared) { shared.owned = true; continue }
        let parent = definitions
        for (const key of entry.path.slice(0, -1)) {
          if (!record(parent[key])) rejected('来源贡献父字段已改变')
          parent = parent[key] as Record<string, unknown>
        }
        const key = entry.path.at(-1)!
        if (entry.item === undefined) delete parent[key]
        else parent[key] = (parent[key] as unknown[]).filter(value => record(value) ? value.id !== entry.item : value !== entry.item)
      }
      for (const file of outgoing.files) {
        const current = existingFiles.get(file.path.normalize('NFC').toLowerCase())
        if (!current || revisionOf(current.bytes) !== file.revision) rejected(`来源资产已修改或缺失，拒绝移除：${file.path}`)
        if (!file.owned) continue
        const shared = Object.values(sources).flatMap(source => source.files).find(other => other.path === file.path)
        if (shared) shared.owned = true
        else removeFiles.push(file.path)
      }
      changed = true
    }
  }
  const ledger = { ...(record(definitions[LEDGER]) ? definitions[LEDGER] : {}), version: 1, sources }
  if (Object.keys(sources).length > 0 || Object.keys(ledger).some(key => key !== 'version' && key !== 'sources')) definitions[LEDGER] = ledger
  else delete definitions[LEDGER]
  updateDefinition(doc, snapshot.source, definitions)
  const text = serializeWithoutSharedAlias(doc, definitions, '共享引用连带改变了未授权定义')
  const candidateFiles = new Map(assets.map(file => [file.path, file.bytes]))
  for (const file of removeFiles) candidateFiles.delete(file)
  for (const file of addFiles) candidateFiles.set(file.path, file.bytes)
  candidateFiles.set('module.yml', Buffer.from(text))
  const validation = moduleImportPreview(root, [...candidateFiles].map(([path, bytes]) => ({ path, content: bytes.toString('base64'), encoding: 'base64' })), { targetId, overwrite: true })
  if (!('prepared' in validation)) return rejected('并入候选无法识别为完整模块定义')
  const revision = revisionOf(JSON.stringify([targetId, request.sourceId, request.action, targetVersion, sourceVersion,
    sourceFiles.map(file => [file.path, revisionOf(file.bytes)]), assets.map(file => [file.path, revisionOf(file.bytes)]), text, validation.previewRevision]))
  const result: ModuleMergeSnapshot = { targetId, sourceId: request.sourceId, action: request.action, revision, sources: Object.keys(sources), rules, files, changed }
  return { target, targetVersion, sourceDir, sourceVersion, text, addFiles, removeFiles, result }
}

export function previewModuleMerge(root: string, targetId: string, request: ModuleMergeRequest): ModuleMergeSnapshot {
  return prepare(root, targetId, request).result
}

export function applyModuleMerge(root: string, targetId: string, request: ModuleMergeRequest, warn?: (message: string) => void): ModuleMergeSnapshot {
  const plan = prepare(root, targetId, request)
  if (!request.expectedRevision || request.expectedRevision !== plan.result.revision) stale()
  if (!plan.result.changed) return plan.result
  const apply = () => {
    const outcome = installModuleDirectory({ root, id: targetId, expectedVersion: plan.targetVersion,
      build: candidate => {
        cpSync(plan.target, candidate, { recursive: true })
        for (const file of plan.addFiles) {
          const path = join(candidate, assertSafeRelativePath(file.path))
          mkdirSync(dirname(path), { recursive: true })
          writeFileSync(path, file.bytes, { flag: 'wx' })
        }
        for (const file of plan.removeFiles) rmSync(join(candidate, assertSafeRelativePath(file)))
        writeFileSync(join(candidate, 'module.yml'), plan.text)
        finalizeModuleCandidate(candidate, targetId)
        if (prepare(root, targetId, request).result.revision !== request.expectedRevision) stale()
      },
    })
    if (outcome.state === 'conflict') stale()
    if (outcome.state === 'recovery-required') throw new ModuleWriteError(`模块恢复失败；原目录保留在 ${outcome.backupPath}`, 500, 'module-merge-recovery')
    invalidateModuleSpec(plan.target)
    if (outcome.state === 'installed' && outcome.leftoverStage !== undefined) warn?.(leftoverStageWarning(outcome.leftoverStage))
    return plan.result
  }
  return plan.sourceDir ? withModuleLock(root, request.sourceId!, apply) : apply()
}
