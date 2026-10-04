#!/usr/bin/env node
/**
 * rematerialize-presets.mjs — 从完整 module.yml 恢复 rules/，清理已退役产物。
 * 已有模块原地校验，不交换目录，不重写用户正文、记忆或其他资产。
 *
 * 缺少 modules/composition 的定义跳过；旧规则格式需要显式离线迁移。
 *
 * 用法：
 *   node scripts/rematerialize-presets.mjs [--dsh-home <dir>] [--dry-run] [--refresh-skills]
 * 退出码：任一预设物化失败或校验不通过 = 1（其余预设继续处理）。
 *
 * 预设内嵌 skills（官方 cordis 谱系的 `skill-filesystem-cordis` 行按 `baseUrl/skills/`
 * 读取）：writePreset 不管理它，建预设时复制一次后即冻结。本脚本默认只比对包内
 * 模板并报告漂移，不覆盖用户副本；显式 `--refresh-skills` 才暂存模板与独有文件的
 * 合并树，再把原目录改名为 `skills.bak-<时间戳>`（可恢复）并切换到新树。
 */
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDocument } from 'yaml'

const LIB_ENTRY = new URL('../lib/index.mjs', import.meta.url)
const root = fileURLToPath(new URL('..', import.meta.url))
const SKILLS_DIR = 'skills'
const SKILLS_BACKUP_PREFIX = 'skills.bak-'

function parseArgs(argv) {
  const out = { dshHome: undefined, dryRun: false, refreshSkills: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry-run' || arg === '-n') out.dryRun = true
    else if (arg === '--refresh-skills') out.refreshSkills = true
    else if (arg === '--dsh-home') {
      const value = argv[index + 1]
      if (value === undefined || value.trim().length === 0) throw new Error('--dsh-home 需要目录参数')
      out.dshHome = value
      index += 1
    } else if (arg.startsWith('--dsh-home=')) out.dshHome = arg.slice('--dsh-home='.length)
    else throw new Error(`未知参数 ${arg}（支持 --dsh-home <dir> / --dry-run / --refresh-skills）`)
  }
  return out
}

/** 递归读文件树为「相对路径 → 字节」；目录不存在返回 undefined。 */
function readTree(dir) {
  if (!existsSync(dir)) return undefined
  const files = new Map()
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const rel = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full, rel)
      else if (entry.isFile()) files.set(rel, readFileSync(full))
    }
  }
  walk(dir, '')
  return files
}

/**
 * 预设内嵌 skills 与包内模板 `preset/<id>/skills` 的漂移；模板不含 skills 时返回
 * undefined。只报差异：缺失/内容不同/预设独有（独有文件永不删除）。
 */
function skillsDrift(presetId, presetDir) {
  const templateDir = join(root, 'preset', presetId, SKILLS_DIR)
  const template = readTree(templateDir)
  if (template === undefined) return undefined
  const local = readTree(join(presetDir, SKILLS_DIR)) ?? new Map()
  const missing = [...template.keys()].filter((rel) => !local.has(rel))
  const differing = [...template.keys()].filter((rel) => local.has(rel) && !template.get(rel).equals(local.get(rel)))
  const extra = [...local.keys()].filter((rel) => !template.has(rel))
  if (missing.length === 0 && differing.length === 0 && extra.length === 0) return undefined
  return { presetId, templateDir, skillsDir: join(presetDir, SKILLS_DIR), missing, differing, extra }
}

const args = parseArgs(process.argv.slice(2))
// DSH_HOME 必须在 import lib 之前设置：paths.ts 在模块加载时计算 DEFAULT_PRESET_DIR。
if (args.dshHome !== undefined && args.dshHome.trim().length > 0) process.env.DSH_HOME = resolve(args.dshHome)
if (!existsSync(fileURLToPath(LIB_ENTRY))) {
  console.error(`rematerialize-presets: 缺少构建产物 ${fileURLToPath(LIB_ENTRY)}，请先运行 pnpm build`)
  process.exit(1)
}
const { writeModule, userModulesDir } = await import(LIB_ENTRY.href)

// 逐模块重新物化：插件格式（modules/params）走 writePreset；手写/官方格式跳过。
const presetRoot = userModulesDir()
const materializedIds = []
const failures = []
let skipped = 0
// 不经过会 ensure 切片的列表/加载入口，保证 --dry-run 完全只读。
const presets = existsSync(presetRoot) ? readdirSync(presetRoot, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && /^[a-z0-9][a-z0-9-]*$/.test(entry.name))
  .map(entry => ({ id: entry.name })) : []
for (const preset of presets) {
  const dir = join(presetRoot, preset.id)
  let spec
  try {
    const doc = parseDocument(readFileSync(join(dir, 'module.yml'), 'utf8'), { logLevel: 'silent' })
    if (doc.errors.length > 0) throw doc.errors[0]
    spec = doc.toJS()
  } catch (error) {
    failures.push(`${preset.id}: 读取 module.yml 失败：${error instanceof Error ? error.message : String(error)}`)
    continue
  }
  const pluginFormat = spec !== null && typeof spec === 'object' && (Array.isArray(spec.modules) || typeof spec.composition === 'string')
  if (!pluginFormat) {
    skipped += 1
    console.log(`skip ${preset.id}: 定义缺少 modules/composition`)
    continue
  }
  if (args.dryRun) {
    console.log(`[dry-run] would materialize ${preset.id}`)
    continue
  }
  try {
    writeModule('', {
      modulesRoot: presetRoot,
      moduleId: preset.id,
      warn: (message) => console.warn(message),
    })
    materializedIds.push(preset.id)
    console.log(`materialized ${preset.id}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // 运行中的宿主会锁住预设内 skills 目录（watcher），目录替换必然 EPERM/EBUSY。
    const locked = /EPERM|EBUSY|EACCES/.test(message)
    failures.push(`${preset.id}: ${message}${locked ? '（目录被运行中的宿主进程锁定，重启 DSH 后重跑本脚本）' : ''}`)
  }
}

// 3) 预设内嵌 skills 与包内模板比对：writePreset 不管这份副本，包更新后它会静默过期。
//    默认只报告；--refresh-skills 暂存合并树后备份切换（预设独有文件不删除）。
const staleSkills = []
for (const preset of presets) {
  const drift = skillsDrift(preset.id, join(presetRoot, preset.id))
  if (drift !== undefined) staleSkills.push(drift)
}
for (const drift of staleSkills) {
  const parts = []
  if (drift.missing.length > 0) parts.push(`${drift.missing.length} 个包内文件缺失`)
  if (drift.differing.length > 0) parts.push(`${drift.differing.length} 个内容不同`)
  if (drift.extra.length > 0) parts.push(`${drift.extra.length} 个预设独有`)
  const sample = [...drift.missing, ...drift.differing, ...drift.extra].slice(0, 3).join(', ')
  if (drift.missing.length === 0 && drift.differing.length === 0) {
    console.log(`stale skills ${drift.presetId}: ${parts.join('、')}（${sample}）；仅预设独有文件，无需刷新`)
    continue
  }
  if (args.refreshSkills && args.dryRun) {
    console.log(`[dry-run] would refresh skills ${drift.presetId}: ${parts.join('、')}（${sample}）`)
    continue
  }
  if (!args.refreshSkills) {
    console.log(`stale skills ${drift.presetId}: ${parts.join('、')}（${sample}）；加 --refresh-skills 先备份再按包内模板刷新`)
    continue
  }
  let tempDir
  try {
    const local = lstatSync(drift.skillsDir, { throwIfNoEntry: false })
    if (local !== undefined && !local.isDirectory()) throw new Error(`拒绝刷新非普通 skills 目录：${drift.skillsDir}`)
    tempDir = mkdtempSync(join(presetRoot, drift.presetId, '.skills-refresh-'))
    const copyOptions = { recursive: true, dereference: false, verbatimSymlinks: true }
    cpSync(drift.templateDir, tempDir, copyOptions)
    if (local !== undefined) {
      // 模板先入暂存树，只合入用户独有项；同名目录合并，不穿过任一侧的符号链接。
      cpSync(drift.skillsDir, tempDir, {
        ...copyOptions,
        filter: (source, target) => {
          const existing = lstatSync(target, { throwIfNoEntry: false })
          return existing === undefined || (existing.isDirectory() && lstatSync(source).isDirectory())
        },
      })
    }
    let backupDir
    if (local !== undefined) {
      backupDir = join(presetRoot, drift.presetId, `${SKILLS_BACKUP_PREFIX}${Date.now().toString(36)}`)
      if (lstatSync(backupDir, { throwIfNoEntry: false }) !== undefined) throw new Error(`备份路径已存在：${backupDir}`)
      renameSync(drift.skillsDir, backupDir)
    }
    try {
      renameSync(tempDir, drift.skillsDir)
    } catch (error) {
      if (backupDir !== undefined) {
        try {
          if (lstatSync(drift.skillsDir, { throwIfNoEntry: false }) !== undefined) throw new Error('skills 路径已被占用，拒绝覆盖')
          renameSync(backupDir, drift.skillsDir)
        } catch (restoreError) {
          throw new Error(`${String(error)}；回退失败：${String(restoreError)}；原副本保留在 ${backupDir}`, { cause: error })
        }
      }
      throw error
    }
    tempDir = undefined
    console.log(`refreshed skills ${drift.presetId}${backupDir === undefined ? '' : `（原副本已备份为 ${relative(presetRoot, backupDir)}）`}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // 运行中的宿主会在 skills 目录里持有句柄，改名同样会 EPERM/EBUSY。
    const locked = /EPERM|EBUSY|EACCES/.test(message)
    failures.push(`${drift.presetId}: 刷新预设内嵌 skills 失败：${message}${locked ? '（目录被运行中的宿主进程锁定，重启 DSH 后重跑本脚本）' : ''}`)
  } finally {
    if (tempDir !== undefined) rmSync(tempDir, { recursive: true, force: true })
  }
}

// 4) 恢复后校验：切片存在且旧宿主装配产物已退役。
if (!args.dryRun && materializedIds.length > 0) {
  for (const id of materializedIds) {
    if (!existsSync(join(presetRoot, id, 'rules', '_settings.yml'))) failures.push(`${id}: 缺少 rules/_settings.yml`)
    for (const name of ['configs', 'rules.yml', 'agent.cordis.yml', 'custom-tools', 'subagent-tools']) {
      if (existsSync(join(presetRoot, id, name))) failures.push(`${id}: 旧产物 ${name} 未清理`)
    }
  }
}

for (const failure of failures) console.error(`FAIL ${failure}`)
console.log(
  `rematerialize-presets: ${presets.length} preset(s) scanned, `
  + `${args.dryRun ? 0 : materializedIds.length} materialized, ${skipped} skipped, ${staleSkills.length} stale skills, ${failures.length} failed`
  + `${args.dryRun ? ' (dry-run)' : ''}`,
)
process.exit(failures.length > 0 ? 1 : 0)
