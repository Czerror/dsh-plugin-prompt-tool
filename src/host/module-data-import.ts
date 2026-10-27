/** 显式选择的书房数据：只读预览、只补缺失、完整候选交换。 */
import { createHash } from 'node:crypto'
import { cpSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { assertSafeRelativePath } from '../shared/asset-path.ts'
import { MAX_ASSET_BYTES, MAX_ASSET_FILES } from '../shared/asset-transfer.ts'
import { assertModuleDirectory, assertNoModuleLinks, modulePathExists } from './module-install.ts'
import { isEditableModuleDir } from './module-dirs.ts'
import { installModuleDirectory } from './module-install-transaction.ts'
import { directoryVersionOf } from './preview-revision.ts'
import { MAX_DATA_FILE_BYTES } from './module-files.ts'
import { readModuleManifest } from './module-manifest.ts'

export interface ModuleDataImportRequest {
  moduleId: string
  sourceDirectory?: string
  /** 相对所选来源目录；每个路径都是用户明确选择的普通文件。 */
  paths?: string[]
  /** 显式选择模块自己的装配清单，与外部来源导入互斥。 */
  initialize?: true
  expectedRevision?: string
}

interface DataImportEntry { source: string; path: string; kind: 'file' | 'dir'; state: 'create' | 'skip' | 'conflict'; bytes: number }
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
// 源项目旧名只有这个映射；目标始终沿用现有权威账本。
const dataPath = (path: string): string => 'data/' + (path === '02-墨.jsonl' ? '02-soul.jsonl' : path)

function prepare(moduleDir: string, input: ModuleDataImportRequest) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['moduleId', 'sourceDirectory', 'paths', 'initialize', 'expectedRevision'].includes(key))) throw new Error('数据导入包含未知字段或不是对象')
  assertNoModuleLinks(moduleDir)
  if (!isEditableModuleDir(moduleDir)) throw new Error('只能导入用户模块私有数据')
  const dir = assertModuleDirectory(dirname(moduleDir), input.moduleId)
  if (dir !== resolve(moduleDir) || basename(dir) !== input.moduleId) throw new Error('数据导入模块主语不一致')
  if (input.initialize !== undefined && input.initialize !== true) throw new Error('initialize 只能是 true')
  if (input.initialize && (input.sourceDirectory !== undefined || input.paths !== undefined)) throw new Error('初始化与外部来源选择不能混用')
  if (!input.initialize && (typeof input.sourceDirectory !== 'string' || !isAbsolute(input.sourceDirectory))) throw new Error('来源目录必须是用户显式选择的绝对路径')
  const sourceDirectory = input.initialize ? dir : resolve(input.sourceDirectory!)
  assertNoModuleLinks(sourceDirectory)
  if (!lstatSync(sourceDirectory).isDirectory()) throw new Error('来源不是普通目录')
  if (!input.initialize && (!Array.isArray(input.paths) || input.paths.length === 0 || input.paths.length > MAX_ASSET_FILES)) throw new Error('必须选择有界的来源文件列表')
  if (input.expectedRevision !== undefined && (typeof input.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedRevision))) throw new Error('数据导入版本无效')
  const version = directoryVersionOf(dir)!
  const seen = new Set<string>()
  let total = 0
  const manifest = input.initialize ? readModuleManifest(dir) : undefined
  const selected: { source: string; path: string; kind: 'file' | 'dir' }[] = manifest
    ? [...manifest.dirs.map(path => ({ source: path, path, kind: 'dir' as const })),
      ...manifest.files.map(file => ({ source: file.from, path: file.to, kind: 'file' as const }))]
    : input.paths!.map(path => ({ source: path, path: dataPath(path), kind: 'file' as const }))
  if (selected.length > MAX_ASSET_FILES) throw new Error('来源文件超过数量上限')
  const files = selected.map(({ source: path, path: targetPath, kind }) => {
    assertSafeRelativePath(path)
    assertSafeRelativePath(targetPath)
    if (targetPath === 'data/02-soul.jsonl' && modulePathExists(join(dir, 'data', '02-墨.jsonl'))) {
      throw new Error('目标已有旧账本 data/02-墨.jsonl，请先显式核对并迁移，拒绝创建第二账本')
    }
    const key = targetPath.normalize('NFC').toLowerCase()
    if (seen.has(key)) throw new Error('重复或冲突的目标路径：' + targetPath)
    seen.add(key)
    const source = join(sourceDirectory, path)
    let bytes = Buffer.alloc(0)
    if (kind === 'file') {
      assertNoModuleLinks(source)
      const stat = lstatSync(source)
      if (!stat.isFile()) throw new Error('来源不是普通文件：' + path)
      if (stat.size > MAX_DATA_FILE_BYTES) throw new Error('来源文件超过 8 MiB：' + path)
      bytes = readFileSync(source)
    }
    total += bytes.length
    if (bytes.length > MAX_DATA_FILE_BYTES || total > MAX_ASSET_BYTES) throw new Error('来源数据超过大小上限')
    // 下游文件读取约定 UTF-8；拒绝导入随后无法读取的数据。
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const target = join(dir, targetPath)
    assertNoModuleLinks(target)
    let state: DataImportEntry['state'] = 'create'
    if (modulePathExists(target)) {
      const targetStat = lstatSync(target)
      if (kind === 'dir') {
        if (!targetStat.isDirectory()) throw new Error('目标不是普通目录：' + targetPath)
        state = 'skip'
      } else {
        if (!targetStat.isFile()) throw new Error('目标不是普通文件：' + targetPath)
        state = targetStat.size === bytes.length && readFileSync(target).equals(bytes) ? 'skip' : 'conflict'
      }
    }
    return { source: path, path: targetPath, kind, state, bytes }
  })
  const revision = digest(JSON.stringify(['module-data-import/1', dir, version, sourceDirectory,
    files.map(file => [file.source, file.path, file.kind, digest(file.bytes)])]))
  const entries: DataImportEntry[] = files.map(file => ({ source: file.source, path: file.path, kind: file.kind, state: file.state, bytes: file.bytes.length }))
  return { dir, version, files, revision, entries }
}

export function previewModuleDataImport(moduleDir: string, input: ModuleDataImportRequest) {
  const { revision, entries } = prepare(moduleDir, input)
  return { revision, entries }
}

export function applyModuleDataImport(moduleDir: string, input: ModuleDataImportRequest) {
  const plan = prepare(moduleDir, input)
  if (input.expectedRevision !== plan.revision) throw new Error('数据导入预览已过期，请重新预览')
  if (!plan.files.some(file => file.state === 'create')) return { revision: plan.revision, entries: plan.entries, installed: false }
  const outcome = installModuleDirectory({
    root: dirname(plan.dir), id: input.moduleId, expectedVersion: plan.version,
    build: candidate => {
      cpSync(plan.dir, candidate, { recursive: true })
      for (const file of plan.files) {
        if (file.state !== 'create') continue
        const target = join(candidate, file.path)
        if (file.kind === 'dir') { mkdirSync(target, { recursive: true }); continue }
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, file.bytes, { flag: 'wx' })
      }
    },
  })
  if (outcome.state === 'conflict') throw new Error('数据导入预览已过期，请重新预览')
  if (outcome.state === 'recovery-required') throw new Error('数据导入恢复失败，原目录备份保留在：' + outcome.backupPath)
  return { revision: plan.revision, entries: plan.entries, installed: true, ...(outcome.leftoverStage ? { leftoverStage: outcome.leftoverStage } : {}) }
}
