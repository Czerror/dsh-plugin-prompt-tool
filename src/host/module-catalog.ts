/**
 * 模块目录清单与管理：列举、种子化、从内置模板新建、复制、删除与在文件管理器中打开。
 * 从原 `manifest.ts` 按簇拆出；目录写通道只在这里，写盘纪律与原实现一致。
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, resolve, sep } from 'node:path'
import { Document } from 'yaml'
import { isModuleId } from '../shared/module-ids.ts'
import { MODULE_DEFINITION_FILE } from './paths.ts'
import { assertModuleDirectory, assertModuleId, assertModuleTree, modulePathExists } from './module-install.ts'
import { ModuleLayerSettingsError } from './module-layer-settings.ts'
import { ModuleWriteError } from './module-write.ts'
import { buildModuleCandidate, finalizeModuleCandidate } from './write-module.ts'
import { installModuleDirectory, type ModuleInstallOutcome } from './module-install-transaction.ts'
import { findModuleDir, packageModulesDir, userModulesDir } from './module-dirs.ts'
import { loadModuleSpec } from './module-spec.ts'

/**
 * 内置空白模板（唯一的内存形态模板）：`moduleClone('blank')` 的源。
 *
 * 为什么不落 `modules/blank/module.yml`：唯一的新建通道是目录到目录复制，落一个目录就得
 * 再给「可复制但用户不可见」加一套过滤（旧 `meta.internal` + 两处过滤），源与机制都不必要。
 * 字段与包内其它模板（各自目录下的 module.yml）逐字段同构，只有身份、组合行与排序。
 */
const BLANK_MODULE_TEMPLATE: Record<string, unknown> = {
  id: 'blank',
  name: '默认模块',
  version: '1.0.0',
  engineCompat: '>=0.4.2',
  description: '空白起点：不预置任何配置，创建入口选完模板后可写入第一节。',
  meta: { source: 'manual' },
  modules: ['rule-engine'],
  order: 9,
}

/** 引擎内组装空白模板的 `module.yml`：身份跟随目标目录名，同一输入逐字节稳定；文件头注释说明它是组装的内置模板。 */
function blankModuleDefinitionText(targetId: string): string {
  const doc = new Document(structuredClone(BLANK_MODULE_TEMPLATE))
  doc.set('id', targetId)
  // 块注释的每行都以 `# ` 起（yaml 库不自动补空格），与包内其它 module.yml 的注释风格一致。
  doc.commentBefore = [
    '空白模块模板：什么都不声明。',
    '用途：创建入口选完注入模板后「新建空白模块」这一步的源。由引擎按内置模板常量组装（不随包',
    '分发 `modules/blank/`），只声明身份与组合行，没有 rules / params / layerSettings / persona /',
    'variables 等节——客户端把内容写进来时，写路径按既有语义为它建立第一节声明（写成功即声明）。',
    '不预置任何配置卡：新建出来的模块是干净起点，唯一入口是页级「添加」。',
  ].join('\n').replace(/^/gm, ' ')
  return doc.toString()
}

/** 模块目录是否含组合源：modules、composition 或官方 agent.cordis.yml。 */
function isRenderableModuleDir(dir: string): boolean {
  try {
    const spec = loadModuleSpec(dir)
    if (Array.isArray(spec.modules)) return true
    if (typeof spec.composition === 'string' && spec.composition.length > 0) return true
  } catch (error) {
    if (error instanceof ModuleLayerSettingsError || error instanceof ModuleWriteError) throw error
    return false
  }
  return false
}

/** 本插件模块清单；所有目录按同一身份与组合源规则列举。 */
export function listModules(moduleRoot = userModulesDir()): Array<{ id: string; name: string; user: boolean; renderable: boolean; description?: string; meta?: Record<string, unknown> }> {
  const scan = (dir: string): Array<{ id: string; name: string; user: boolean; renderable: boolean; description?: string; meta?: Record<string, unknown> }> => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && isModuleId(entry.name))
        .flatMap((entry) => {
          try {
            const spec = loadModuleSpec(assertModuleDirectory(dir, entry.name))
            if (typeof spec.id !== 'string' || spec.id.length === 0) return []
            // 切换值用目录名（与 resolveModuleDir 路径一致）；name 保持 spec.name 契约。
            return [{
              id: entry.name,
              name: spec.name,
              user: true,
              renderable: isRenderableModuleDir(join(dir, entry.name)),
              ...(typeof spec.description === 'string' && spec.description.length > 0 ? { description: spec.description } : {}),
              ...(spec.meta !== undefined && spec.meta !== null ? { meta: spec.meta } : {}),
            }]
          } catch (error) {
            return [{ id: entry.name, name: entry.name, user: true, renderable: false, broken: String((error as Error).message ?? error) }]
          }
        })
    } catch {
      return []
    }
  }
  const byId = new Map<string, { id: string; name: string; user: boolean; renderable: boolean }>()
  for (const preset of scan(moduleRoot)) byId.set(preset.id, preset)
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

/** 插件目录模板清单（「新建」选择器与首次种子化数据源；不直接出现在模块列表）。 */
export function listBuiltinTemplates(): Array<{ id: string; name: string }> {
  try {
    return readdirSync(packageModulesDir(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const dir = join(packageModulesDir(), entry.name)
        try {
          const spec = loadModuleSpec(dir)
          return [{ id: entry.name, name: spec.name }]
        } catch {
          return []
        }
      })
      .sort((a, b) => a.id.localeCompare(b.id))
  } catch {
    return []
  }
}
/** 按包内同名目录补建缺失的内置模块；已有目录的定义、生成物和资源保持原样。 */
export function ensureModuleSeed(root = userModulesDir()): { created: string[] } {
  const created: string[] = []
  try {
    mkdirSync(root, { recursive: true })
    for (const entry of readdirSync(packageModulesDir(), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const target = join(root, entry.name)
      // 硬约束：只补缺失。目标已存在（无论用户是否改过）一律不碰，不比较内容。
      if (existsSync(target)) continue
      const source = join(packageModulesDir(), entry.name)
      try {
        const result = installModuleDirectory({
          root,
          id: entry.name,
          expectedVersion: null,
          build: (candidate) => buildModuleCandidate(candidate, source, entry.name, undefined, { validate: false }),
        })
        if (result.state === 'installed') created.push(entry.name)
      } catch {
        // 单个补建失败不阻断启动，也不删除任何用户数据。
      }
    }
  } catch {
    // 种子化失败（目录不可读/不可写等）不阻断启动，用户仍可经 UI 新建/导入。
  }
  return { created }
}
/** 目标目录名分配（目录复制与内存组装两条源共用）：`id` 被占用时递增 `id-2` / `id-3`…。 */
function nextModuleDirId(id: string, root: string, autoSuffix: boolean): { ok: true; id: string } | { ok: false; message: string } {
  const free = (candidate: string): boolean => !modulePathExists(join(root, candidate))
  if (free(id)) return { ok: true, id }
  if (!autoSuffix) return { ok: false, message: `用户目录已存在同名预设 ${id}，请先删除再新建` }
  for (let suffix = 2; ; suffix++) {
    const candidate = `${id}-${suffix}`
    if (free(candidate)) return { ok: true, id: candidate }
  }
}

/** 把 create 事务的预期失败映射回模块管理既有文案。 */
function requireInstalled(result: ModuleInstallOutcome, conflictMessage: string): void {
  if (result.state === 'conflict') throw new Error(conflictMessage)
  if (result.state === 'recovery-required') throw new Error(`模块安装失败且恢复失败；原目录保留在 ${result.backupPath}`)
}

/**
 * 引擎内组装内置空白模板：Document API 生成 `module.yml`，由安装事务暂存并交换，
 * 失败不留半个模块。
 */
function writeBlankModule(root: string, targetId: string): void {
  const result = installModuleDirectory({
    root,
    id: targetId,
    expectedVersion: null,
    build: (candidate) => {
      writeFileSync(join(candidate, MODULE_DEFINITION_FILE), blankModuleDefinitionText(targetId), 'utf8')
      finalizeModuleCandidate(candidate, targetId, undefined, { validate: false })
    },
  })
  requireInstalled(result, `目标模块已存在：${targetId}`)
}
/** 完整复制到隐藏候选；只更新定义 ID 和已知共享引擎配置位置。 */
function copyModuleDirectory(source: string, root: string, targetId: string): void {
  assertModuleTree(source)
  loadModuleSpec(source)
  const result = installModuleDirectory({
    root,
    id: targetId,
    expectedVersion: null,
    build: (candidate) => buildModuleCandidate(candidate, source, targetId, undefined, { validate: false }),
  })
  requireInstalled(result, `目标预设已存在：${targetId}`)
}

/** 从包内同名目录复制模块；autoSuffix=true 时递增目录名并同步定义身份。
 *  `blank` 没有包内目录：它由 `BLANK_MODULE_TEMPLATE` 在引擎内组装（同一条目录名规则）。 */
export function cloneBuiltinModule(id: string, autoSuffix = false, moduleRoot = userModulesDir()): { ok: true; id: string } | { ok: false; message: string } {
  try {
    assertModuleId(id)
    const blank = id === BLANK_MODULE_TEMPLATE.id
    const builtin = blank ? undefined : findModuleDir(packageModulesDir(), id)
    if (!blank && builtin === undefined) {
      return { ok: false, message: `预设 ${id} 不是包内置预设` }
    }
    const allocated = nextModuleDirId(id, moduleRoot, autoSuffix)
    if (!allocated.ok) return allocated
    assertModuleId(allocated.id)
    if (blank) writeBlankModule(moduleRoot, allocated.id)
    else copyModuleDirectory(builtin!, moduleRoot, allocated.id)
    return { ok: true, id: allocated.id }
  } catch (error) {
    return { ok: false, message: `新建预设失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 复制用户模块目录为新模块（id 自动递增：<id>-copy / <id>-copy-2 / …）。
 *  复制的是用户目录完整副本（module.yml / agent.cordis.yml / prompt-configs /
 *  内容资产 / 覆盖文件），与「从内置模板新建」互补：后者还原模板，前者备份现状。 */
export function duplicateUserModule(id: string, moduleRoot = userModulesDir()): { ok: true; id: string } | { ok: false; message: string } {
  try {
    assertModuleId(id)
    const root = resolve(moduleRoot)
    const source = assertModuleDirectory(root, id)
    let targetId = `${id}-copy`
    let target = join(root, targetId)
    for (let suffix = 2; modulePathExists(target); suffix++) {
      targetId = `${id}-copy${suffix}`
      target = join(root, targetId)
    }
    copyModuleDirectory(source, root, targetId)
    return { ok: true, id: targetId }
  } catch (error) {
    return { ok: false, message: `复制预设失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 在系统文件管理器中打开模块目录（尽力而为：无桌面环境时打开失败也返回路径供 UI 展示）。 */
export function openModuleLocation(id: string, moduleRoot = userModulesDir()): { ok: true; path: string } | { ok: false; message: string; path: string } {
  // 普通模块 id（裸目录名）或角色卡库子路径（/.characters/<cardId>）两种形态。
  const isBareId = isModuleId(id)
  const isCardPath = typeof id === 'string' && /^\/\.[a-zA-Z0-9_-]+\/[^/\\]+$/.test(id)
  if (!isBareId && !isCardPath) {
    return { ok: false, message: `非法预设 id：${id}`, path: '' }
  }
  const dir = resolve(join(moduleRoot, id))
  const rootResolved = resolve(moduleRoot)
  if (dir !== rootResolved && !dir.startsWith(rootResolved + sep)) {
    return { ok: false, message: `预设路径越界：${id}`, path: dir }
  }
  if (!existsSync(dir)) {
    return { ok: false, message: `预设 ${id} 不存在`, path: dir }
  }
  try {
    if (isBareId) assertModuleDirectory(moduleRoot, id)
    const command = process.platform === 'win32' ? 'explorer'
      : process.platform === 'darwin' ? 'open' : 'xdg-open'
    const child = spawn(command, [dir], { detached: true, stdio: 'ignore' })
    child.unref()
    return { ok: true, path: dir }
  } catch (error) {
    return { ok: false, message: `打开目录失败：${error instanceof Error ? error.message : String(error)}`, path: dir }
  }
}