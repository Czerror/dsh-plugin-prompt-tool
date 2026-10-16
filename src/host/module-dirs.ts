/**
 * 模块目录的定位与身份判定：包内与用户目录候选、模块模板目录解析、可写目录判据。
 * 从原 `manifest.ts`（1106 行、34 个导出）按簇拆出——这些判据不读模块定义，
 * 与 module.yml 的解析分开后，依赖图才保持单向。
 */
import { existsSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MODULE_DEFINITION_FILE, modulesDir } from './paths.ts'
import { assertModuleDirectory, modulePathExists } from './module-install.ts'

/**
 * 模块目录确实存在于本插件存储根（身份判定与官方登记状态无关）。
 *
 * 启用表过滤、工具写入目标、TUI 目标共用这一条判据：本插件管理的模块 = 存储根里含
 * `module.yml` 的目录，与「宿主有没有把它登记成官方预设」是两回事。
 */
export function moduleDirExists(root: string, id: string): boolean {
  return statSync(join(root, id, MODULE_DEFINITION_FILE), { throwIfNoEntry: false }) !== undefined
}

/**
 * 包根 `modules/` 目录：随包分发的**内置模块库**（模块目录形态与存储根同构）。
 *
 * 兼容源码运行（`src/host/`）与打包运行（`lib/`）。旧的内置预设目录 `preset/` 已整体
 * 退场——那些是官方预设形态的遗留，重构后不再读取也不再维护。
 */
export function packageModulesDir(): string {
  const candidates = [
    new URL('../modules/', import.meta.url),
    new URL('../../modules/', import.meta.url),
  ]
  for (const candidate of candidates) {
    const dir = fileURLToPath(candidate)
    if (existsSync(dir)) return dir
  }
  throw new Error('prompt-tool: cannot locate package modules/ directory')
}
/** 包根 engine/ 目录(插件引擎,与配置文件夹分离):兼容源码与打包运行。 */
export function packageEngineDir(): string {
  const candidates = [
    new URL('../engine/', import.meta.url),
    new URL('../../engine/', import.meta.url),
  ]
  for (const candidate of candidates) {
    const dir = fileURLToPath(candidate)
    if (existsSync(join(dir, 'rule-engine.mjs'))) return dir
  }
  throw new Error('prompt-tool: cannot locate package engine/ directory')
}
/** 模块根：本插件的存储根（~/.dsh/.prompt-tool），导入/新建/种子化的模块都放这里。 */
export function userModulesDir(): string {
  return modulesDir()
}

/** 只按合法目录身份定位；现存坏身份必须报错，不能绕到同名模板。 */
export function findModuleDir(scanDir: string, template: string): string | undefined {
  const exact = assertModuleDirectory(scanDir, template, true)
  return modulePathExists(exact) ? exact : undefined
}

/**
 * 解析模块模板目录：当前模块根优先，包内模板回退；不读取其他部署根的同名模块。
 * 目录名与声明的 module.yml id 一致；不扫描其他目录的 id 别名。
 */
export function resolveModuleDir(template: string, moduleRoot = userModulesDir()): string {
  const found = findModuleDir(moduleRoot, template) ?? findModuleDir(packageModulesDir(), template)
  return found ?? join(packageModulesDir(), template)
}

/**
 * 目标是否为**用户模块**（在用户模块根之下）：system 目录只读，写通道据此拒绝。
 * 读通道不受影响；路径先解析真实相对关系，不用客户端 ID 拼路径。
 *
 * 语义边界：它判的是**目录**可写，不是「这次操作可写」——同一目录上的操作资格由各自的门决定。
 * 判据本身不读盘，纯路径比较。
 */
export function isEditableModuleDir(dir: string, moduleRoot = userModulesDir()): boolean {
  const root = resolve(moduleRoot)
  const target = resolve(dir)
  return target !== root && target.startsWith(root + sep)
}