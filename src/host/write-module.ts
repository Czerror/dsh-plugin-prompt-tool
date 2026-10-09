/** 模块完整定义校验、运行切片恢复与隔离导入候选。普通重建不交换用户目录。 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { parseDocument } from 'yaml'
// @ts-expect-error 纯引擎校验与运行时共用。
import { validateSubagentToolPolicy } from '../../engine/subagent-tool-policy-core.mjs'
import { MODULES_DIR, MODULE_DEFINITION_FILE } from './paths.ts'
import { appendModuleConfigOrder } from './module-config-order.ts'
import { enabledModuleIds } from './config-store.ts'
import { assertModuleDirectory, assertModuleId, assertModuleTree } from './module-install.ts'
import { validateCustomTools } from './custom-tools.ts'
import { assertCompositionArray, renderComposition, resolveModuleDir, type ModuleSpec } from './manifest.ts'
import { ensureModuleSlices, loadModuleDefinition, validateModuleDefinitionText, withModuleLock, ModuleRulesError } from './module-storage.ts'
import { atomicWriteTextFile } from './text-file.ts'
import { directoryVersionOf } from './preview-revision.ts'

/** 仅供旧导出包 requires.renderVersion 兼容读取；不再生成渲染版本戳。 */
export const RENDER_VERSION = 6
const LEGACY_ARTIFACTS = ['configs', 'rules.yml', 'agent.cordis.yml', 'custom-tools', 'subagent-tools', 'triggers.yml']

export interface WriteModuleOptions {
  modulesRoot: string
  moduleId: string
  targetModuleId?: string
  sourceDir?: string
  /** 返回独立暂存根下的合法模块目录；安装方负责交换与清理暂存根。 */
  stageOnly?: boolean
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
  if (spec.subagentToolPolicy !== undefined && spec.subagentToolPolicy !== null) {
    const policyErrors = validateSubagentToolPolicy(spec.subagentToolPolicy)
    if (policyErrors.length > 0) throw new Error(`invalid subagentToolPolicy: ${policyErrors.join('; ')}`)
  }
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

/** 未知选项即抛：删掉旧选项（moduleDir / presetOrder）后，写错的名字不能再被静默忽略。
 *  形状沿用既有的未知键守卫（engine/shared.mjs#validateConfig、settings-bridge 的参数键白名单）。 */
function assertKnownOptions(label: string, options: object, allowed: readonly string[]): void {
  const unknown = Object.keys(options).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) throw new TypeError(`${label} 收到未知选项：${unknown.join('、')}；只接受 ${allowed.join('、')}`)
}

/** 按模块身份原地恢复切片；用户资产、正文与完整定义均不重写。 */
export function ensureModuleReady(id: string, options: { modulesRoot?: string; warn?: (message: string) => void }): string {
  assertKnownOptions('ensureModuleReady', options, ['modulesRoot', 'warn'])
  const root = options.modulesRoot ?? MODULES_DIR
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
  assertKnownOptions('writeModule', options, ['modulesRoot', 'moduleId', 'targetModuleId', 'sourceDir', 'stageOnly', 'agentsInstructionText', 'warn'])
  const root = options.modulesRoot.trim().length > 0 ? options.modulesRoot : MODULES_DIR
  assertModuleId(options.moduleId)
  const targetId = options.targetModuleId ?? options.moduleId
  assertModuleId(targetId)
  const source = options.sourceDir ?? resolveModuleDir(options.moduleId, root)
  validateModule(source, options.warn)
  const target = assertModuleDirectory(root, targetId, true)
  const targetVersion = options.stageOnly ? undefined : directoryVersionOf(target)
  if (!options.stageOnly && resolve(source) === resolve(target)) {
    ensureModuleSlices(target)
    withModuleLock(root, targetId, () => {
      assertModuleDirectory(root, targetId)
      writeContentAssets(target, options.agentsInstructionText)
      removeLegacyArtifacts(target)
    })
    return target
  }
  mkdirSync(root, { recursive: true })
  const stageRoot = mkdtempSync(join(root, `.${targetId}.stage-`))
  const candidate = join(stageRoot, targetId)
  try {
    mkdirSync(candidate)
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (LEGACY_ARTIFACTS.includes(entry.name) || entry.name === 'rules') continue
      cpSync(join(source, entry.name), join(candidate, entry.name), { recursive: entry.isDirectory(), force: true })
    }
    const file = join(candidate, MODULE_DEFINITION_FILE)
    const text = readFileSync(file, 'utf8')
    const doc = parseDocument(text, { logLevel: 'silent' })
    if (doc.get('id') !== targetId) {
      doc.set('id', targetId)
      validateModuleDefinitionText(candidate, doc.toString())
      atomicWriteTextFile(file, doc.toString())
    }
    writeContentAssets(candidate, options.agentsInstructionText)
    validateModule(candidate)
    ensureModuleSlices(candidate)
    if (options.stageOnly) return candidate
    withModuleLock(root, targetId, () => {
      assertModuleDirectory(root, targetId, true)
      if (directoryVersionOf(target) !== targetVersion) throw new ModuleRulesError('模块安装期间目标已变化，未覆盖', 409, 'rules-conflict')
      const backup = join(stageRoot, 'previous')
      const hadTarget = existsSync(target)
      if (hadTarget) renameSync(target, backup)
      try { renameSync(candidate, target) }
      catch (error) {
        if (hadTarget) {
          try { renameSync(backup, target) }
          catch (restoreError) { throw new Error(`模块安装失败且恢复失败；原目录保留在 ${backup}: ${String(restoreError)}`, { cause: error }) }
        }
        throw error
      }
    })
    rmSync(stageRoot, { recursive: true, force: true })
    return target
  } catch (error) {
    // 恢复失败时保留 previous；不得清理唯一的用户资产副本。
    if (!existsSync(join(stageRoot, 'previous'))) rmSync(stageRoot, { recursive: true, force: true })
    throw error
  }
}
