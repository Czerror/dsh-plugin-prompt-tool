/** 模块完整定义校验、运行切片恢复与隔离导入候选。普通重建不交换用户目录。 */
import { cpSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { parseDocument } from 'yaml'
import { MODULE_DEFINITION_FILE, modulesDir } from './paths.ts'
import { appendModuleConfigOrder } from './module-config-order.ts'
import { enabledModuleIds } from './config-store.ts'
import { assertModuleDirectory, assertModuleId, assertModuleTree } from './module-install.ts'
import { validateCustomTools } from './custom-tools.ts'
import { assertCompositionArray } from './module-composition.ts'
import { resolveModuleDir } from './module-dirs.ts'
import { renderComposition } from './module-params.ts'
import type { ModuleSpec } from './module-spec.ts'
import { ensureModuleSlices, loadModuleDefinition, validateModuleDefinitionText } from './module-slices.ts'
import { ModuleWriteError, withModuleLock } from './module-write.ts'
import { atomicWriteTextFile } from './text-file.ts'
import { directoryVersionOf } from './preview-revision.ts'
import { installModuleDirectory, leftoverStageWarning } from './module-install-transaction.ts'

export const LEGACY_ARTIFACTS = ['configs', 'rules.yml', 'agent.cordis.yml', 'custom-tools', 'subagent-tools', 'triggers.yml']

export interface WriteModuleOptions {
  modulesRoot: string
  moduleId: string
  targetModuleId?: string
  sourceDir?: string
  agentsInstructionText?: string
  warn?: (message: string) => void
}

function validateModule(directory: string, warn?: (message: string) => void): void {
  assertModuleTree(directory)
  const snapshot = loadModuleDefinition(directory)
  const spec = { ...snapshot.source, id: snapshot.source.id ?? basename(snapshot.dir),
    rules: snapshot.rules, configOrder: snapshot.configOrder, variables: snapshot.variables, variablesEnabled: snapshot.variablesEnabled } as unknown as ModuleSpec
  assertCompositionArray(renderComposition(spec, {}, directory), spec)
  if (spec.customTools !== undefined && !Array.isArray(spec.customTools)) throw new TypeError('customTools must be an array')
  const toolErrors = validateCustomTools(spec.customTools ?? [])
  if (toolErrors.length > 0) throw new Error(`invalid customTools: ${toolErrors.join('; ')}`)
  if (Array.isArray(spec.meta?.stWarnings)) for (const warning of spec.meta.stWarnings) {
    if (typeof warning === 'string') warn?.(`prompt-tool: ST 导入兼容提示：${warning}`)
  }
}

function removeLegacyArtifacts(directory: string): void {
  for (const name of LEGACY_ARTIFACTS) rmSync(join(directory, name), { recursive: true, force: true })
}

/** 只有明确传入的非空内容才更新内容资产；空值保留原文件。正文归 module.yml，这里只剩 agents.md。 */
function writeContentAssets(directory: string, agentsText?: string): void {
  const path = join(directory, 'agents.md')
  if (typeof agentsText !== 'string' || agentsText.trim().length === 0) return
  if (existsSync(path) && readFileSync(path, 'utf8') === agentsText) return
  atomicWriteTextFile(path, agentsText)
}

/**
 * 把 source 的模块资产复制到已存在的空候选目录，并完成定义身份、内容资产、完整性校验与切片。
 * 候选目录由调用方创建（安装事务或 stage）；helper 不做目录交换。
 */
export function buildModuleCandidate(
  candidate: string,
  source: string,
  targetId: string,
  agentsText?: string,
  options: { validate?: boolean } = {},
): void {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (LEGACY_ARTIFACTS.includes(entry.name) || entry.name === 'rules') continue
    cpSync(join(source, entry.name), join(candidate, entry.name), { recursive: entry.isDirectory(), force: true })
  }
  finalizeModuleCandidate(candidate, targetId, agentsText, options)
}

/**
 * 候选已写好 module.yml 与资产后，统一做身份改写、内容资产、完整校验与切片。
 * 包安装直接写文件到候选，跳过复制，但仍走这里。
 */
export function finalizeModuleCandidate(
  candidate: string,
  targetId: string,
  agentsText?: string,
  options: { validate?: boolean } = {},
): void {
  const file = join(candidate, MODULE_DEFINITION_FILE)
  const text = readFileSync(file, 'utf8')
  const doc = parseDocument(text, { logLevel: 'silent' })
  if (doc.get('id') !== targetId) {
    doc.set('id', targetId)
    validateModuleDefinitionText(candidate, doc.toString())
    atomicWriteTextFile(file, doc.toString())
  }
  writeContentAssets(candidate, agentsText)
  // 复制现有用户模块时沿用旧语义：只保证可读与切片重建，不额外用组合/customTools 校验拒绝复制。
  if (options.validate !== false) validateModule(candidate)
  ensureModuleSlices(candidate)
}

/** 未知选项即抛：删掉旧选项（moduleDir / presetOrder）后，写错的名字不能再被静默忽略。
 *  形状沿用既有的未知键守卫（engine/shared.mjs#validateConfig、settings-bridge 的参数键白名单）。 */
function assertKnownOptions(label: string, options: object, allowed: readonly string[]): void {
  const unknown = Object.keys(options).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) throw new TypeError(`${label} 收到未知选项：${unknown.join('、')}；只接受 ${allowed.join('、')}`)
}

/** 按模块身份原地恢复切片；用户资产、正文与完整定义均不重写。 */
export function ensureModuleReady(id: string, options: { modulesRoot?: string; warn?: (message: string) => void }): string {
  assertKnownOptions('ensureModuleReady', options, ['modulesRoot', 'warn'])
  const root = options.modulesRoot ?? modulesDir()
  const directory = assertModuleDirectory(root, id)
  validateModule(directory, options.warn)
  if (enabledModuleIds(root).includes(id)) appendModuleConfigOrder(root, id)
  ensureModuleSlices(directory)
  withModuleLock(root, id, () => {
    assertModuleDirectory(root, id)
    removeLegacyArtifacts(directory)
  })
  return directory
}

/** 已有同一模块只恢复切片；导入/复制先完整生成合法身份候选，再交换目标。 */
export function writeModule(options: WriteModuleOptions): string {
  assertKnownOptions('writeModule', options, ['modulesRoot', 'moduleId', 'targetModuleId', 'sourceDir', 'agentsInstructionText', 'warn'])
  const root = options.modulesRoot.trim().length > 0 ? options.modulesRoot : modulesDir()
  assertModuleId(options.moduleId)
  const targetId = options.targetModuleId ?? options.moduleId
  assertModuleId(targetId)
  const source = options.sourceDir ?? resolveModuleDir(options.moduleId, root)
  validateModule(source, options.warn)
  const target = assertModuleDirectory(root, targetId, true)
  const targetVersion = directoryVersionOf(target)
  if (resolve(source) === resolve(target)) {
    ensureModuleSlices(target)
    withModuleLock(root, targetId, () => {
      assertModuleDirectory(root, targetId)
      writeContentAssets(target, options.agentsInstructionText)
      removeLegacyArtifacts(target)
    })
    return target
  }
  const result = installModuleDirectory({
    root,
    id: targetId,
    expectedVersion: targetVersion,
    build: (candidate) => buildModuleCandidate(candidate, source, targetId, options.agentsInstructionText),
  })
  if (result.state === 'conflict') throw new ModuleWriteError('模块安装期间目标已变化，未覆盖', 409, 'rules-conflict')
  if (result.state === 'recovery-required') {
    throw new Error(`模块安装失败且恢复失败；原目录保留在 ${result.backupPath}: ${String(result.cause)}`)
  }
  if (result.leftoverStage !== undefined) {
    options.warn?.(leftoverStageWarning(result.leftoverStage))
  }
  return target
}
