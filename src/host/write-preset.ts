/** 模块完整定义校验、运行切片恢复与隔离导入候选。普通重建不交换用户目录。 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { parseDocument } from 'yaml'
// @ts-expect-error 纯引擎校验与运行时共用。
import { validateSubagentToolPolicy } from '../../engine/subagent-tool-policy-core.mjs'
import { MODULES_DIR, MODULE_DEFINITION_FILE } from './paths.ts'
import { DEFAULT_MODULE_ID } from '../shared/preset-ids.ts'
import type { ModuleWriterParams } from '../shared/engine-params.ts'
import type { PromptConfigSpec } from './prompt-configs.ts'
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

/** 旧入口只做名称适配；行为规则和参数必须已写入完整定义。 */
export interface WritePresetOptions extends ModuleWriterParams {
  moduleDir: string
  presetTemplate?: string
  outputId?: string
  sourceDir?: string
  materializeOnly?: boolean
  agentsInstructionText?: string
  presetOrder?: number
  promptConfigs?: PromptConfigSpec[]
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

/**
 * 只有明确传入的非空内容才更新旧内容资产；空值保留原文件。
 *
 * `preset.md` 是改名前的正文资产名，**当前已无生产者**：唯一调用方导入路径
 * （module-package）传的是空串，正文早已归 module.yml；真实模块目录里只有 module.yml。
 * 保留这个写入能力只为不改变旧 API 的对外形状，不要据此以为它还在被生成。
 */
function writeContentAssets(directory: string, prompt: string, agentsText?: string): void {
  for (const [file, content] of [['preset.md', prompt], ['agents.md', agentsText]] as const) {
    if (typeof content !== 'string' || content.trim().length === 0) continue
    const path = join(directory, file)
    if (!existsSync(path) || readFileSync(path, 'utf8') !== content) atomicWriteTextFile(path, content)
  }
}

/** 按模块身份原地恢复切片；用户资产、正文与完整定义均不重写。 */
export function ensureModuleReady(id: string, options: { modulesRoot?: string; moduleDir?: string; presetOrder?: number; warn?: (message: string) => void }): string {
  const root = options.modulesRoot ?? options.moduleDir ?? MODULES_DIR
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

/** 已发布旧入口只保留名称适配。 */
export { ensureModuleReady as materializeModule }

/** 已有同一模块只恢复切片；导入/复制先完整生成合法身份候选，再交换目标。 */
export function writeModule(prompt: string, options: WriteModuleOptions): string {
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
      writeContentAssets(target, prompt, options.agentsInstructionText)
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
    writeContentAssets(candidate, prompt, options.agentsInstructionText)
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

/** @deprecated 使用 writeModule；旧字段仅在此边界适配。 */
export function writePreset(prompt: string, options: WritePresetOptions): string {
  if ((options.promptConfigs?.length ?? 0) > 0) throw new Error('旧 promptConfigs 物化覆盖已退出，请先离线迁移为 rules')
  const moduleId = options.presetTemplate?.trim() || DEFAULT_MODULE_ID
  if (!/^[a-z0-9][a-z0-9-]*$/.test(moduleId)) throw new Error(`invalid presetTemplate ${JSON.stringify(moduleId)}`)
  return writeModule(prompt, { modulesRoot: options.moduleDir, moduleId, targetModuleId: options.outputId,
    sourceDir: options.sourceDir, stageOnly: options.materializeOnly, agentsInstructionText: options.agentsInstructionText, warn: options.warn })
}
