/** 模块交换：有界资源、完整候选与可恢复提交，Web 和 CLI 共用。 */
import { createHash } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, posix } from 'node:path'
import { parseDocument } from 'yaml'
import type { AssetFile, AssetImportRequest, AssetSummary, ModuleExportRequest, ModuleExportResult } from '../shared/asset-transfer.ts'
import { MAX_ASSET_BYTES, MAX_ASSET_FILES, packZip, safeAssetPath, unpackZip } from './asset-archive.ts'
import { decodeAssetFile, normalizeAssetFiles, prepareImport, assetSourceDigest } from './import-source.ts'
import { directoryVersionOf, computePreviewRevision } from './preview-revision.ts'
import { resolveModuleDir, invalidateModuleSpec, packageEngineDir, type ModuleSpec } from './manifest.ts'
import { MODULE_DEFINITION_FILE } from './paths.ts'
import { validateCustomTools } from './custom-tools.ts'
import { readModuleLayerSettings } from './module-layer-settings.ts'
import { projectCharacterMemories } from './characters.ts'
import { writeModule } from './write-module.ts'
import { assertModuleId, assertModuleTree, assertModuleDirectory, canonicalModulesRoot, modulePathExists, setModuleDefinitionId } from './module-install.ts'
import { ruleInjections } from './rule-content.ts'
import { validateModuleDefinitionText, withModuleLock } from './module-storage.ts'
// @ts-expect-error 与保存、装配使用同一策略校验器。
import { validateSubagentToolPolicy } from '../../engine/subagent-tool-policy-core.mjs'

const MANIFEST = 'prompt-tool-package.json'
const PACKAGE_VERSION = 1
const STORAGE_VERSION = 6
/**
 * 包内定义文件名：写入用新名，**读取接受历史名**。
 *
 * 包是可分享的外部产物，用户手里可能有旧版导出的包（清单 `definition: preset.yml`）；
 * 导入是信任边界，拒绝它等于把用户已有的包判为损坏。
 */
const DEFINITION_NAMES: readonly string[] = [MODULE_DEFINITION_FILE, 'preset.yml']
const sha = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

export class AssetTransferError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code }
}

function stale(): never { throw new AssetTransferError('module-preview-stale', '预览已过期，请重新预览后再导入') }

export function assertTransferId(id: string): void {
  assertModuleId(id)
  if (id.length > 128) throw new Error('预设 id 过长')
}

function ownedFile(path: string): boolean {
  const root = path.split('/')[0]!
  if (root.startsWith('.') || ['configs', 'custom-tools', 'subagent-tools', 'skills'].includes(root)) return false
  if (path === 'variables.yml' || path === MANIFEST) return false
  // 根 agents.md 是模块自有旧内容资产，工作区指令文件绝不沿路径收集。
  return path === 'agents.md' || !/^(?:AGENTS|CLAUDE)(?:\.local)?\.md$/i.test(basename(path))
}

/** 先筛选再读取：派生切片和不分享的私有资产不参与读取、配额或导出版本。 */
function shareableFile(path: string): boolean {
  const root = path.split('/')[0]!.toLowerCase()
  return !['rules', 'rules.yml', 'agent.cordis.yml', 'triggers.yml', 'memory.md'].includes(root) && ownedFile(path)
}

type PackageFile = { path: string; bytes: Buffer }
function packageTemplate(files: readonly PackageFile[], missing?: Set<string>): (file: unknown) => unknown {
  const entries = new Map(files.map(file => [file.path, file.bytes]))
  return (file: unknown): unknown => {
    if (file === undefined || file === '') return undefined
    if (typeof file !== 'string') throw new Error('templateFile 必须是字符串')
    const path = posix.normalize(file)
    if (file.includes('\\') || file.includes(':') || posix.isAbsolute(path) || path === '..' || path.startsWith('../')
      || path === 'rules' || path.startsWith('rules/')) throw new Error('非法或外部模板资源：' + file)
    safeAssetPath(path)
    const bytes = entries.get(path)
    if (bytes === undefined) {
      if (missing) { missing.add('缺失资源：' + path); return undefined }
      throw new Error('缺失模板资源：' + path)
    }
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (/\.json$/i.test(path)) { const value: unknown = JSON.parse(raw); return typeof value === 'string' ? { text: value } : value }
    if (/\.ya?ml$/i.test(path)) {
      const doc = parseDocument(raw, { logLevel: 'silent' })
      if (doc.errors.length > 0) throw new Error('模板 YAML 无效：' + path)
      const value: unknown = doc.toJS()
      return typeof value === 'string' ? { text: value } : value
    }
    return { text: raw }
  }
}

function validatePackageDefinition(directory: string, text: string, files: readonly PackageFile[], missing?: Set<string>) {
  const snapshot = validateModuleDefinitionText(directory, text, { loadTemplate: packageTemplate(files, missing) })
  const spec = snapshot.source as unknown as ModuleSpec
  readModuleLayerSettings(spec)
  if (spec.customTools !== undefined) {
    if (!Array.isArray(spec.customTools)) throw new Error('customTools 必须是数组')
    const errors = validateCustomTools(spec.customTools)
    if (errors.length > 0) throw new Error(errors.join('\n'))
  }
  if (spec.subagentToolPolicy !== undefined && spec.subagentToolPolicy !== null) {
    const errors = validateSubagentToolPolicy(spec.subagentToolPolicy)
    if (errors.length > 0) throw new Error(errors.join('\n'))
  }
  return snapshot
}

export async function expandModuleSource(input: AssetFile[]): Promise<AssetFile[]> {
  let files = input
  if (files.length === 1 && /\.zip$/i.test(files[0]!.path)) files = await unpackZip(decodeAssetFile(files[0]!))
  files = normalizeAssetFiles(files)
  // 仅当所有条目共享一个真实外层目录时剥离一次。
  const first = files[0]?.path.split('/')[0]
  let sourceFolder: string | undefined
  if (first !== undefined && files.every((file) => file.path.startsWith(first + '/'))) {
    sourceFolder = first
    files = files.map((file) => ({ ...file, path: file.path.slice(first.length + 1) }))
  }
  const seen = new Set<string>()
  let size = 0
  for (const file of files) {
    safeAssetPath(file.path)
    const key = file.path.normalize('NFC').toLowerCase()
    if (seen.has(key)) throw new Error(`重复资源路径：${file.path}`)
    seen.add(key)
    size += decodeAssetFile(file).length
    if (size > MAX_ASSET_BYTES || files.length > MAX_ASSET_FILES) throw new Error('资源包超过大小或数量上限')
    if (file.path !== MANIFEST && !ownedFile(file.path)) throw new Error(`资源不属于预设交换范围：${file.path}`)
  }
  const manifest = files.find((file) => file.path === MANIFEST)
  if (manifest !== undefined) {
    const value: unknown = JSON.parse(decodeAssetFile(manifest).toString('utf8'))
    if (!isRecord(value) || value.version !== PACKAGE_VERSION || typeof value.definition !== 'string' || !DEFINITION_NAMES.includes(value.definition) || !isRecord(value.files)) throw new Error('不支持或损坏的预设包清单')
    if (isRecord(value.requires) && typeof value.requires.renderVersion === 'number' && value.requires.renderVersion > STORAGE_VERSION) throw new Error('模块包需要较新的 Prompt Tool')
    const entries = files.filter((file) => file !== manifest)
    if (Object.keys(value.files).length !== entries.length) throw new Error('包清单与文件集合不一致')
    for (const file of entries) if (value.files[file.path] !== sha(decodeAssetFile(file))) throw new Error(`包文件摘要不符：${file.path}`)
    files = entries
  }
  // 官方目录可只声明 name 并携带 agent.cordis.yml；保留既有无 ID 回退语义。
  const yaml = files.filter((file) => !file.path.includes('/') && /\.ya?ml$/i.test(file.path) && file.path !== 'agent.cordis.yml')
  // 定义文件名接受新旧两种（旧包 = 用户手里已导出的产物，导入是信任边界）。
  const definition = yaml.find((file) => /^(?:module|preset)\.ya?ml$/i.test(file.path)) ?? (yaml.length === 1 ? yaml[0] : undefined)
  if (definition !== undefined) {
    const doc = parseDocument(decodeAssetFile(definition).toString('utf8'), { logLevel: 'silent' })
    const value: unknown = doc.errors.length === 0 ? doc.toJS({ maxAliasCount: 100 }) : undefined
    if (isRecord(value) && value.id === undefined && !('prompts' in value) && !('spec' in value)
      && (['modules', 'composition', 'rules', 'params', 'content'].some((key) => key in value)
        || (typeof value.name === 'string' && files.some((file) => file.path === 'agent.cordis.yml')))) {
      doc.set('id', sourceFolder ?? 'imported-preset')
      definition.content = doc.toString()
      definition.encoding = 'utf8'
    }
  }
  return files
}

function targetId(root: string, wanted: string, request: AssetImportRequest): string {
  assertTransferId(wanted)
  if (request.targetId !== undefined || request.overwrite) return wanted
  let id = wanted
  for (let n = 1; existsSync(join(root, id)); n++) id = `${wanted}-copy${n === 1 ? '' : '-' + n}`
  return id
}

type ReadyImport = Extract<ReturnType<typeof prepareImport>, { state: 'ready' }>

export function moduleImportPreview(root: string, files: AssetFile[], request: AssetImportRequest): {
  prepared: ReadyImport
  summary: AssetSummary
  sourceDigest: string
  previewRevision: string
} | Exclude<ReturnType<typeof prepareImport>, { state: 'ready' }> {
  const prepared = prepareImport(files, 'preset', { ...request, targetId: undefined, targetName: undefined })
  if (prepared.state !== 'ready') return prepared
  validatePackageDefinition(join(root, prepared.spec.id), prepared.yaml, prepared.files.map(file => ({ path: file.path, bytes: decodeAssetFile(file) })))
  const id = targetId(root, request.targetId ?? prepared.spec.id, request)
  const target = assertModuleDirectory(root, id, true)
  const version = directoryVersionOf(target)
  const sourceDigest = assetSourceDigest(files)
  const previewRevision = computePreviewRevision({
    files: [{ path: 'source', content: sourceDigest }, { path: 'choices', content: JSON.stringify([id, request.targetName ?? '', request.overwrite === true, request.sourceKind ?? null]) }],
    ...(request.promptOrderCharacterId === undefined ? {} : { orderCharacterId: request.promptOrderCharacterId }),
    converter: 'asset-import/1',
    target: { kind: 'module-package', targetId: id, targetVersion: version, ownerModule: root },
  })
  return {
    prepared, sourceDigest, previewRevision,
    summary: { sourceName: prepared.sourceName, kind: prepared.kind, targetId: id, targetName: request.targetName ?? prepared.spec.name,
      exists: version !== null, files: files.map((file) => ({ path: file.path, bytes: decodeAssetFile(file).length })),
      configCount: prepared.spec.rules?.length ?? 0, warnings: [] },
  }
}

/** 同一进程的同目标安装串行；磁盘版本复检保护其他写入者。 */
const installs = new Map<string, Promise<unknown>>()
export async function installModulePackage(root: string, files: AssetFile[], request: AssetImportRequest, options: { preserveAssets?: boolean } = {}): Promise<{ id: string; backupPath?: string }> {
  root = canonicalModulesRoot(root, true)
  const initial = moduleImportPreview(root, files, request)
  if (!('prepared' in initial)) throw new Error('请先完成来源和顺序组选择')
  const target = join(root, initial.summary.targetId)
  const previous = installs.get(target) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(() => {
    const preview = moduleImportPreview(root, files, request)
    if (!('prepared' in preview)) throw new Error('来源选择已失效')
    if (!request.expectedPreviewRevision || request.expectedPreviewRevision !== preview.previewRevision
      || request.expectedSourceDigest !== preview.sourceDigest) stale()
    if (preview.summary.exists && request.overwrite !== true) throw new Error('目标已存在，请明确选择更新或另存')
    mkdirSync(root, { recursive: true })
    const stage = mkdtempSync(join(root, '.import-'))
    const source = join(stage, preview.summary.targetId)
    mkdirSync(source)
    let generated: string | undefined
    let generatedRoot: string | undefined
    let moved = false
    const backup = join(stage, 'previous')
    try {
      if ((options.preserveAssets || preview.prepared.kind === 'st-character' || preview.prepared.kind === 'native-character') && preview.summary.exists) {
        for (const entry of readdirSync(target)) {
          if ([MODULE_DEFINITION_FILE, 'rules', 'configs', 'rules.yml', 'agent.cordis.yml', 'custom-tools', 'subagent-tools'].includes(entry)) continue
          const path = join(target, entry)
          assertModuleTree(path)
          cpSync(path, join(source, entry), { recursive: true })
        }
      }
      for (const file of preview.prepared.files.filter((file) => file.path !== MANIFEST && !DEFINITION_NAMES.includes(file.path))) {
        const path = join(source, safeAssetPath(file.path))
        mkdirSync(dirname(path), { recursive: true })
        if (file.path === 'memory.md' && existsSync(path)) continue
        writeFileSync(path, decodeAssetFile(file))
      }
      const doc = parseDocument(preview.prepared.yaml)
      setModuleDefinitionId(doc, preview.summary.targetId)
      doc.set('name', preview.summary.targetName)
      writeFileSync(join(source, MODULE_DEFINITION_FILE), doc.toString(), 'utf8')
      // 正文归 module.yml；preset.md 随包作资源落盘，供离线迁移读取。
      generated = writeModule({
        modulesRoot: root, moduleId: preview.summary.targetId, targetModuleId: preview.summary.targetId,
        sourceDir: source, stageOnly: true,
      })
      generatedRoot = dirname(generated)
      withModuleLock(root, preview.summary.targetId, () => {
        const now = moduleImportPreview(root, files, request)
        if (!('prepared' in now) || now.previewRevision !== preview.previewRevision) stale()
        if (existsSync(target)) { renameSync(target, backup); moved = true }
        try { renameSync(generated!, target); generated = undefined }
        catch (error) {
          if (moved) {
            try { renameSync(backup, target); moved = false }
            catch { throw new AssetTransferError('module-recovery-required', `安装失败且恢复未完成，原目录保留在 ${backup}`) }
          }
          throw error
        }
      })
      invalidateModuleSpec(target)
      // 备份清理失败不会把已经成功的安装说成失败；保留路径供诊断。
      try { rmSync(stage, { recursive: true, force: true }); moved = false } catch { return { id: preview.summary.targetId, backupPath: stage } }
      return { id: preview.summary.targetId }
    } finally {
      if (generated !== undefined) rmSync(generated, { recursive: true, force: true })
      if (generatedRoot !== undefined) rmSync(generatedRoot, { recursive: true, force: true })
      if (!moved) rmSync(stage, { recursive: true, force: true })
    }
  })
  installs.set(target, run)
  try { return await run } finally { if (installs.get(target) === run) installs.delete(target) }
}

function collectFiles(dir: string): PackageFile[] {
  const files: PackageFile[] = []
  const seen = new Set<string>()
  let total = 0
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!shareableFile(prefix + entry.name)) continue
      const path = safeAssetPath(prefix + entry.name)
      const key = path.normalize('NFC').toLowerCase()
      if (seen.has(key)) throw new Error(`导出路径大小写或规范化冲突：${path}`)
      seen.add(key)
      if (entry.isSymbolicLink()) throw new Error(`不能导出链接：${path}`)
      const absolute = join(current, entry.name)
      if (entry.isDirectory()) { walk(absolute, path + '/'); continue }
      const stat = lstatSync(absolute)
      if (!stat.isFile()) throw new Error(`不能导出特殊文件：${path}`)
      total += stat.size
      if (total > MAX_ASSET_BYTES || files.length >= MAX_ASSET_FILES) throw new Error('导出超过大小或数量上限')
      const bytes = readFileSync(absolute)
      if (bytes.length !== stat.size) throw new Error('导出期间文件发生变化')
      files.push({ path, bytes })
    }
  }
  walk(dir, '')
  return files
}

function dependencyErrors(files: PackageFile[], spec: ModuleSpec): string[] {
  const paths = new Set(files.map((file) => file.path))
  const errors = new Set<string>()
  const check = (ref: string, from: string): void => {
    // 共享引擎不再随包分发（引擎由插件提供，组合行用包名说明符）：旧模块包里的
    // `../.engine/x.mjs` 引用不再豁免，会按越界资源在下面被拒绝。
    const rel = posix.normalize(posix.join(posix.dirname(from), ref))
    if (rel.startsWith('../') || posix.isAbsolute(rel) || ref.includes(':')) errors.add(`外部资源：${ref}`)
    else if (!paths.has(rel)) errors.add(`缺失资源：${rel}`)
  }
  for (const { config } of ruleInjections(spec.rules)) {
    if (typeof config.templateFile === 'string') {
      check(config.templateFile, MODULE_DEFINITION_FILE)
    }
  }
  if (!Array.isArray(spec.modules) && typeof spec.composition === 'string') {
    let raw = spec.composition
    if (raw.startsWith('./')) {
      check(raw, MODULE_DEFINITION_FILE)
      raw = files.find(file => file.path === posix.normalize(raw))?.bytes.toString('utf8') ?? ''
    }
    if (raw.includes('\n')) {
      const doc = parseDocument(raw, { logLevel: 'silent' })
      if (doc.errors.length > 0) errors.add('模块组合 YAML 无效')
      else {
        const visit = (value: unknown): void => {
          if (Array.isArray(value)) { value.forEach(visit); return }
          if (!isRecord(value)) return
          if (typeof value.name === 'string' && value.name.startsWith('.')) check(value.name, MODULE_DEFINITION_FILE)
          Object.values(value).forEach(child => { if (typeof child === 'object') visit(child) })
        }
        visit(doc.toJS())
      }
    }
  }
  for (const file of files) {
    if (/\.[cm]?js$/i.test(file.path)) {
      const code = file.bytes.toString('utf8')
      for (const match of code.matchAll(/(?:from\s*|import\s*\(|require\s*\()\s*['"](\.[^'"]+)['"]/g)) check(match[1]!, file.path)
    }
  }
  return [...errors]
}

function sharingSnapshot(dir: string, id: string, root: string, choices: Record<string, 'include' | 'exclude'>) {
  const files = collectFiles(dir)
  const definition = files.find(file => file.path === MODULE_DEFINITION_FILE)
  if (!definition) throw new Error('缺少模块定义')
  const originalText = new TextDecoder('utf-8', { fatal: true }).decode(definition.bytes)
  const missing = new Set<string>()
  const original = validatePackageDefinition(dir, originalText, files, missing).doc
  if (original.get('id') === undefined) original.set('id', id)
  // 原始完整源先校验；分享投影不能把无效规则隐藏掉后伪装成有效源。
  const source = files.map(file => [file.path, sha(file.bytes)])
  const projection = projectCharacterMemories(original, choices, root)
  definition.bytes = Buffer.from(projection.doc.toString())
  const spec = validatePackageDefinition(dir, definition.bytes.toString('utf8'), files, missing).source as unknown as ModuleSpec
  // 分享过滤会读取历史来源证明；投影结果也进版本，证明变化影响输出时必须重新确认。
  const revision = sha(JSON.stringify([source, definition.bytes.toString('utf8'), projection.memoryConflicts, projection.excludedMemoryCount]))
  return { files, definition, spec, projection, missing: [...missing], revision }
}

export async function exportModulePackage(root: string, request: ModuleExportRequest): Promise<ModuleExportResult> {
  assertTransferId(request.id)
  const resolved = resolveModuleDir(request.id, root)
  const dir = assertModuleDirectory(dirname(resolved), request.id)
  if (!modulePathExists(dir)) throw new Error('模块不存在')
  // 包只携带完整定义和用户资产，切片由安装方确定性重建。预览不修复源目录。
  const choices = request.memoryChoices ?? {}
  const { files, definition, spec, projection, missing, revision: before } = sharingSnapshot(dir, request.id, root, choices)
  const blockers = [...new Set([...missing, ...dependencyErrors(files, spec)])]
  if (projection.memoryConflicts.length > 0) blockers.push('请明确选择来源不明的记忆条目是否分享')
  const mode = request.mode ?? 'definition'
  const revision = sha(JSON.stringify([before, mode, request.memoryChoices ?? {}]))
  const result: ModuleExportResult = {
    id: request.id, name: spec.name || request.id, content: '', revision,
    filename: `${request.id}.${mode === 'zip' ? 'zip' : MODULE_DEFINITION_FILE}`,
    files: files.map((file) => ({ path: file.path, bytes: file.bytes.length })),
    warnings: ['不包含工作区指令、角色记忆文件、技能库；需要兼容的 Prompt Tool 与宿主。'],
    blockers: mode === 'zip' ? blockers : projection.memoryConflicts.length ? ['请先处理记忆条目'] : [],
    memoryConflicts: projection.memoryConflicts, excludedMemoryCount: projection.excludedMemoryCount,
  }
  if (mode === 'definition') result.warnings!.push(...blockers)
  if (mode === 'definition' && files.length > 1) result.warnings!.push(`仅导出定义，不包含 ${files.length - 1} 个附属文件。`)
  const verify = (): void => { if (sharingSnapshot(dir, request.id, root, choices).revision !== before) stale() }
  verify()
  if (request.preview) return result
  if (request.expectedRevision !== undefined && request.expectedRevision !== revision) stale()
  if (result.blockers!.length) throw new Error(result.blockers!.join('\n'))
  if (mode === 'definition') return { ...result, encoding: 'utf8', content: definition.bytes.toString('utf8') }
  const plugin = JSON.parse(readFileSync(join(dirname(packageEngineDir()), 'package.json'), 'utf8')) as { version: string }
  const manifest = Buffer.from(JSON.stringify({ version: PACKAGE_VERSION, definition: MODULE_DEFINITION_FILE, requires: { promptTool: plugin.version, renderVersion: STORAGE_VERSION }, files: Object.fromEntries(files.map((file) => [file.path, sha(file.bytes)])) }, null, 2))
  if (files.length + 1 > MAX_ASSET_FILES) throw new Error('包含清单后的模块包超过文件数量上限')
  if (files.reduce((sum, file) => sum + file.bytes.length, manifest.length) > MAX_ASSET_BYTES) throw new Error('包含清单后的预设包超过 64 MiB')
  const archive = await packZip([...files, { path: MANIFEST, bytes: manifest }].map((file) => ({ ...file, path: `${request.id}/${file.path}` })))
  if (archive.length > MAX_ASSET_BYTES) throw new Error('ZIP 超过 64 MiB，无法通过导入上限')
  verify()
  return { ...result, encoding: 'base64', content: Buffer.from(archive).toString('base64') }
}
