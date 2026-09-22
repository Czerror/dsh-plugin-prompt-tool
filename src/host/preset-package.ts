/** 预设交换：有界资源、完整候选与可恢复提交，Web 和 CLI 共用。 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, posix, resolve, sep } from 'node:path'
import { parseDocument, parse as parseYaml } from 'yaml'
import type { AssetFile, AssetImportRequest, AssetSummary, PresetExportRequest, PresetExportResult } from '../shared/asset-transfer.ts'
import { MAX_ASSET_BYTES, MAX_ASSET_FILES, packZip, safeAssetPath, unpackZip } from './asset-archive.ts'
import { decodeAssetFile, normalizeAssetFiles, prepareImport, assetSourceDigest } from './import-source.ts'
import { directoryVersionOf, computePreviewRevision } from './preview-revision.ts'
import { resolvePresetDir, invalidatePresetSpec, packageEngineDir, type PresetSpec } from './manifest.ts'
import { validateCustomTools } from './custom-tools.ts'
import { readPresetLayerSettings } from './preset-layer-settings.ts'
import { projectCharacterMemories } from './characters.ts'
import { writePreset, RENDER_VERSION } from './write-preset.ts'
import { assertPresetId, assertPresetDirectory, canonicalPresetRoot, setPresetDefinitionId } from './preset-install.ts'
// @ts-expect-error 引擎 ESM 是权威校验实现，由构建器同源打包。
import { createPromptConfigs } from '../../engine/schema.mjs'

const MANIFEST = 'prompt-tool-package.json'
const PACKAGE_VERSION = 1
const sha = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

export class AssetTransferError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code }
}

function stale(): never { throw new AssetTransferError('preset-preview-stale', '预览已过期，请重新预览后再导入') }

export function assertTransferId(id: string): void {
  assertPresetId(id)
  if (id.length > 128) throw new Error('预设 id 过长')
}

function ownedFile(path: string): boolean {
  const root = path.split('/')[0]!
  if (root.startsWith('.') || ['prompt-configs', 'custom-tools', 'subagent-tools', 'skills'].includes(root)) return false
  if (path === 'variables.yml' || path === MANIFEST) return false
  // 根 agents.md 是预设自有旧内容资产，工作区指令文件绝不沿路径收集。
  return path === 'agents.md' || !/^(?:AGENTS|CLAUDE)(?:\.local)?\.md$/i.test(basename(path))
}

export async function expandPresetSource(input: AssetFile[]): Promise<AssetFile[]> {
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
    if (!isRecord(value) || value.version !== PACKAGE_VERSION || value.definition !== 'preset.yml' || !isRecord(value.files)) throw new Error('不支持或损坏的预设包清单')
    if (isRecord(value.requires) && typeof value.requires.renderVersion === 'number' && value.requires.renderVersion > RENDER_VERSION) throw new Error('预设包需要较新的 Prompt Tool')
    const entries = files.filter((file) => file !== manifest)
    if (Object.keys(value.files).length !== entries.length) throw new Error('包清单与文件集合不一致')
    for (const file of entries) if (value.files[file.path] !== sha(decodeAssetFile(file))) throw new Error(`包文件摘要不符：${file.path}`)
    files = entries
  }
  // 官方目录可只声明 name 并携带 agent.cordis.yml；保留既有无 ID 回退语义。
  const yaml = files.filter((file) => !file.path.includes('/') && /\.ya?ml$/i.test(file.path) && file.path !== 'agent.cordis.yml')
  const definition = yaml.find((file) => /^preset\.ya?ml$/i.test(file.path)) ?? (yaml.length === 1 ? yaml[0] : undefined)
  if (definition !== undefined) {
    const doc = parseDocument(decodeAssetFile(definition).toString('utf8'), { logLevel: 'silent' })
    const value: unknown = doc.errors.length === 0 ? doc.toJS({ maxAliasCount: 100 }) : undefined
    if (isRecord(value) && value.id === undefined && !('prompts' in value) && !('spec' in value)
      && (['modules', 'composition', 'promptConfigs', 'params', 'content'].some((key) => key in value)
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

export function presetImportPreview(root: string, files: AssetFile[], request: AssetImportRequest): {
  prepared: ReadyImport
  summary: AssetSummary
  sourceDigest: string
  previewRevision: string
} | Exclude<ReturnType<typeof prepareImport>, { state: 'ready' }> {
  const prepared = prepareImport(files, 'preset', { ...request, targetId: undefined, targetName: undefined })
  if (prepared.state !== 'ready') return prepared
  const id = targetId(root, request.targetId ?? prepared.spec.id, request)
  const target = assertPresetDirectory(root, id, true)
  const version = directoryVersionOf(target)
  const sourceDigest = assetSourceDigest(files)
  const previewRevision = computePreviewRevision({
    files: [{ path: 'source', content: sourceDigest }, { path: 'choices', content: JSON.stringify([id, request.targetName ?? '', request.overwrite === true, request.sourceKind ?? null]) }],
    ...(request.promptOrderCharacterId === undefined ? {} : { orderCharacterId: request.promptOrderCharacterId }),
    converter: 'asset-import/1',
    target: { kind: 'preset-package', targetId: id, targetVersion: version, ownerPreset: root },
  })
  return {
    prepared, sourceDigest, previewRevision,
    summary: { sourceName: prepared.sourceName, kind: prepared.kind, targetId: id, targetName: request.targetName ?? prepared.spec.name,
      exists: version !== null, files: files.map((file) => ({ path: file.path, bytes: decodeAssetFile(file).length })),
      configCount: prepared.spec.promptConfigs?.length ?? 0, warnings: [] },
  }
}

/** templateFile 相对最终共享引擎定位，再映射回尚未交换的候选根。 */
function candidateTemplate(source: string, root: string, id: string, file: unknown): unknown {
  if (file === undefined || file === '') return undefined
  if (typeof file !== 'string' || file.includes('\\') || file.includes(':')) throw new Error('非法 templateFile')
  const finalTarget = resolve(root, id)
  const finalFile = resolve(root, '.engine', file)
  if (!finalFile.startsWith(finalTarget + sep)) throw new Error(`templateFile 不属于目标预设：${file}`)
  const relative = finalFile.slice(finalTarget.length + 1)
  const raw = readFileSync(join(source, relative), 'utf8')
  if (/\.json$/i.test(file)) { const data: unknown = JSON.parse(raw); return typeof data === 'string' ? { text: data } : data }
  if (/\.ya?ml$/i.test(file)) { const data: unknown = parseYaml(raw); return typeof data === 'string' ? { text: data } : data }
  return { text: raw }
}

function checkCandidate(spec: PresetSpec, source: string, root: string, id: string): void {
  if (spec.customTools !== undefined) {
    if (!Array.isArray(spec.customTools)) throw new Error('customTools 必须是数组')
    const errors = validateCustomTools(spec.customTools)
    if (errors.length > 0) throw new Error(errors.join('\n'))
  }
  createPromptConfigs(spec.promptConfigs ?? [], { loadTemplate: (file: unknown) => candidateTemplate(source, root, id, file) })
}

/** 同一进程的同目标安装串行；磁盘版本复检保护其他写入者。 */
const installs = new Map<string, Promise<unknown>>()
export async function installPresetPackage(root: string, files: AssetFile[], request: AssetImportRequest): Promise<{ id: string; backupPath?: string }> {
  root = canonicalPresetRoot(root, true)
  const initial = presetImportPreview(root, files, request)
  if (!('prepared' in initial)) throw new Error('请先完成来源和顺序组选择')
  const target = join(root, initial.summary.targetId)
  const previous = installs.get(target) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(() => {
    const preview = presetImportPreview(root, files, request)
    if (!('prepared' in preview)) throw new Error('来源选择已失效')
    if (!request.expectedPreviewRevision || request.expectedPreviewRevision !== preview.previewRevision
      || request.expectedSourceDigest !== preview.sourceDigest) stale()
    if (preview.summary.exists && request.overwrite !== true) throw new Error('目标已存在，请明确选择更新或另存')
    mkdirSync(root, { recursive: true })
    const stage = mkdtempSync(join(root, '.import-'))
    const source = join(stage, 'source')
    mkdirSync(source)
    let generated: string | undefined
    let moved = false
    const backup = join(stage, 'previous')
    try {
      for (const file of preview.prepared.files.filter((file) => !['preset.yml', MANIFEST].includes(file.path))) {
        const path = join(source, safeAssetPath(file.path))
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, decodeAssetFile(file), { flag: 'wx' })
      }
      const doc = parseDocument(preview.prepared.yaml)
      setPresetDefinitionId(doc, preview.summary.targetId)
      doc.set('name', preview.summary.targetName)
      const spec = doc.toJS() as PresetSpec
      writeFileSync(join(source, 'preset.yml'), doc.toString(), 'utf8')
      checkCandidate(spec, source, root, preview.summary.targetId)
      generated = writePreset(existsSync(join(source, 'preset.md')) ? readFileSync(join(source, 'preset.md'), 'utf8') : '', {
        presetDir: root, presetTemplate: preview.summary.targetId, outputId: preview.summary.targetId,
        sourceDir: source, materializeOnly: true, presetOrder: 5, promptConfigs: [],
      })
      const now = presetImportPreview(root, files, request)
      if (!('prepared' in now) || now.previewRevision !== preview.previewRevision) stale()
      if (existsSync(target)) { renameSync(target, backup); moved = true }
      try { renameSync(generated, target); generated = undefined }
      catch (error) {
        if (moved) {
          try { renameSync(backup, target); moved = false }
          catch { throw new AssetTransferError('preset-recovery-required', `安装失败且恢复未完成，原目录保留在 ${backup}`) }
        }
        throw error
      }
      invalidatePresetSpec(target)
      // 备份清理失败不会把已经成功的安装说成失败；保留路径供诊断。
      try { rmSync(stage, { recursive: true, force: true }); moved = false } catch { return { id: preview.summary.targetId, backupPath: stage } }
      return { id: preview.summary.targetId }
    } finally {
      if (generated !== undefined) rmSync(generated, { recursive: true, force: true })
      if (!moved) rmSync(stage, { recursive: true, force: true })
    }
  })
  installs.set(target, run)
  try { return await run } finally { if (installs.get(target) === run) installs.delete(target) }
}

function collectFiles(dir: string): Array<{ path: string; bytes: Buffer }> {
  const files: Array<{ path: string; bytes: Buffer }> = []
  const seen = new Set<string>()
  let total = 0
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = safeAssetPath(prefix + entry.name)
      if (!ownedFile(path)) continue
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

function dependencyErrors(files: Array<{ path: string; bytes: Buffer }>, spec: PresetSpec): string[] {
  const paths = new Set(files.map((file) => file.path))
  const errors = new Set<string>()
  const check = (ref: string, from: string): void => {
    // 共享引擎不再随包分发（引擎由插件提供，组合行用包名说明符）：旧预设包里的
    // `../.engine/x.mjs` 引用不再豁免，会按越界资源在下面被拒绝。
    const rel = posix.normalize(posix.join(posix.dirname(from), ref))
    if (rel.startsWith('../') || posix.isAbsolute(rel) || ref.includes(':')) errors.add(`外部资源：${ref}`)
    else if (!paths.has(rel)) errors.add(`缺失资源：${rel}`)
  }
  for (const config of spec.promptConfigs ?? []) {
    if (!isRecord(config)) continue
    if (typeof config.templateFile === 'string') {
      const prefix = `../${spec.id}/`
      if (!config.templateFile.startsWith(prefix)) errors.add(`外部模板：${config.templateFile}`)
      else check('./' + config.templateFile.slice(prefix.length), 'preset.yml')
    }
  }
  for (const file of files) {
    if (/\.[cm]?js$/i.test(file.path)) {
      const code = file.bytes.toString('utf8')
      for (const match of code.matchAll(/(?:from\s*|import\s*\(|require\s*\()\s*['"](\.[^'"]+)['"]/g)) check(match[1]!, file.path)
    }
    if (file.path === 'agent.cordis.yml') {
      const rows: unknown = parseYaml(file.bytes.toString('utf8'))
      const visit = (value: unknown): void => {
        if (Array.isArray(value)) { value.forEach(visit); return }
        if (!isRecord(value)) return
        if (typeof value.name === 'string' && value.name.startsWith('.')) check(value.name, file.path)
        Object.values(value).forEach((child) => { if (typeof child === 'object') visit(child) })
      }
      visit(rows)
    }
  }
  return [...errors]
}

export async function exportPresetPackage(root: string, request: PresetExportRequest): Promise<PresetExportResult> {
  assertTransferId(request.id)
  const dir = resolvePresetDir(request.id, root)
  const before = directoryVersionOf(dir)
  if (before === null) throw new Error('预设不存在')
  const files = collectFiles(dir)
  const definition = files.find((file) => file.path === 'preset.yml')
  if (!definition) throw new Error('缺少预设定义')
  const original = parseDocument(definition.bytes.toString('utf8'))
  if (original.errors.length > 0) throw new Error(original.errors[0]!.message)
  if (original.get('id') !== undefined && original.get('id') !== request.id) throw new Error('定义 ID 与目录身份不一致，请先修正')
  if (original.get('id') === undefined) original.set('id', request.id)
  const projection = projectCharacterMemories(original, request.memoryChoices ?? {}, root)
  definition.bytes = Buffer.from(projection.doc.toString())
  const spec = projection.doc.toJS() as PresetSpec
  readPresetLayerSettings(spec)
  const blockers = dependencyErrors(files, spec)
  if (projection.memoryConflicts.length > 0) blockers.push('请明确选择来源不明的记忆条目是否分享')
  const mode = request.mode ?? 'definition'
  const revision = sha(JSON.stringify([before, mode, request.memoryChoices ?? {}]))
  const result: PresetExportResult = {
    id: request.id, name: spec.name || request.id, content: '', revision,
    filename: `${request.id}.${mode === 'zip' ? 'zip' : 'preset.yml'}`,
    files: files.map((file) => ({ path: file.path, bytes: file.bytes.length })),
    warnings: ['不包含工作区指令、角色记忆文件、技能库；需要兼容的 Prompt Tool 与宿主。'],
    blockers: mode === 'zip' ? blockers : projection.memoryConflicts.length ? ['请先处理记忆条目'] : [],
    memoryConflicts: projection.memoryConflicts, excludedMemoryCount: projection.excludedMemoryCount,
  }
  if (mode === 'definition' && files.length > 1) result.warnings!.push(`仅导出定义，不包含 ${files.length - 1} 个附属文件。`)
  if (directoryVersionOf(dir) !== before) stale()
  if (request.preview) return result
  if (request.expectedRevision !== undefined && request.expectedRevision !== revision) stale()
  if (result.blockers!.length) throw new Error(result.blockers!.join('\n'))
  if (mode === 'definition') return { ...result, encoding: 'utf8', content: definition.bytes.toString('utf8') }
  const plugin = JSON.parse(readFileSync(join(dirname(packageEngineDir()), 'package.json'), 'utf8')) as { version: string }
  const manifest = Buffer.from(JSON.stringify({ version: PACKAGE_VERSION, definition: 'preset.yml', requires: { promptTool: plugin.version, renderVersion: RENDER_VERSION }, files: Object.fromEntries(files.map((file) => [file.path, sha(file.bytes)])) }, null, 2))
  if (files.reduce((sum, file) => sum + file.bytes.length, manifest.length) > MAX_ASSET_BYTES) throw new Error('包含清单后的预设包超过 64 MiB')
  const archive = await packZip([...files, { path: MANIFEST, bytes: manifest }].map((file) => ({ ...file, path: `${request.id}/${file.path}` })))
  if (archive.length > MAX_ASSET_BYTES) throw new Error('ZIP 超过 64 MiB，无法通过导入上限')
  if (directoryVersionOf(dir) !== before) stale()
  return { ...result, encoding: 'base64', content: Buffer.from(archive).toString('base64') }
}
