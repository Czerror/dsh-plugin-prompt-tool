#!/usr/bin/env node
/**
 * rematerialize-presets.mjs — 离线重新物化 <DSH_HOME>/.agent-presets 下的预设与共享引擎。
 *
 * 背景：插件只在启动/切换预设时按需重建生成产物；仓库引擎契约、组合库或
 * RENDER_VERSION 升级后，用户目录里已存在的产物不会自动刷新。本脚本以各预设
 * preset.yml 为单一来源重跑 writePreset（等价于把「切换一次预设」对每个预设
 * 各做一遍），产物：
 *   - <preset>/agent.cordis.yml（组合，带 render 版本戳）
 *   - <preset>/prompt-configs/*.yml、custom-tools/*.yml、subagent-tools/policy.yml
 *   - <preset>/preset.md、agents.md、agents-instruction.md
 *   - <presetRoot>/.engine/（共享引擎；指纹未变时 writePreset 内部跳过重刷）
 *
 * 手写/官方格式预设（preset.yml 无 modules/params，如 liangshen）整体跳过，
 * 不覆盖用户手写组合。本项目不含旧参数/旧内容迁移代码：物化只按当前契约重跑。
 *
 * 用法：
 *   node scripts/rematerialize-presets.mjs [--dsh-home <dir>] [--dry-run] [--refresh-skills]
 * 退出码：任一预设物化失败或校验不通过 = 1（其余预设继续处理）。
 *
 * 预设内嵌 skills（官方 cordis 谱系的 `skill-filesystem-cordis` 行按 `baseUrl/skills/`
 * 读取）：writePreset 不管理它，建预设时复制一次后即冻结。本脚本默认只比对包内
 * 模板并报告漂移，不覆盖用户副本；显式 `--refresh-skills` 才刷新，且先把原目录
 * 改名为 `skills.bak-<时间戳>`（可恢复），预设独有的文件不删除。
 */
import { cpSync, existsSync, readFileSync, readdirSync, renameSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const LIB_ENTRY = new URL('../lib/index.mjs', import.meta.url)
const RENDER_STAMP_PREFIX = '# prompt-tool:render v'
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

/** 读生成目录内容资产；文件不存在返回 undefined（调用方回退模板内容）。 */
function readGenerated(dir, name) {
  const file = join(dir, name)
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined
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
const { writePreset, listPresets, loadPresetSpec, resolvePresetParams, userPresetsDir } = await import(LIB_ENTRY.href)

// 逐预设重新物化：插件格式（modules/params）走 writePreset；手写/官方格式跳过。
const presetRoot = userPresetsDir()
const materializedIds = []
const failures = []
let skipped = 0
const presets = listPresets()
for (const [index, preset] of presets.entries()) {
  const dir = join(presetRoot, preset.id)
  let spec
  try {
    spec = loadPresetSpec(dir)
  } catch (error) {
    failures.push(`${preset.id}: 读取 preset.yml 失败：${error instanceof Error ? error.message : String(error)}`)
    continue
  }
  const pluginFormat = Array.isArray(spec.modules) || (spec.params !== null && typeof spec.params === 'object')
  if (!pluginFormat) {
    skipped += 1
    console.log(`skip ${preset.id}: 手写/官方格式预设（无 modules/params），不覆盖其组合`)
    continue
  }
  // 内容资产优先取生成目录文件（用户编辑产物），回退 preset.yml content 段（模板默认）。
  const prompt = readGenerated(dir, 'preset.md')
    ?? (typeof spec.content?.presetText === 'string' ? spec.content.presetText : '')
  const agentsText = readGenerated(dir, 'agents.md')
    ?? (typeof spec.content?.agentsText === 'string' ? spec.content.agentsText : '')
  const order = Number.isFinite(spec.order) ? spec.order : index
  // 引擎参数按 preset.yml 单一来源解析后再传入：不传会让 writePreset 的 runtimeOf
  // 默认值（firstTurnAnchor=false / injectPrompt=true / 模型键空串）覆盖 preset.yml，
  // 渲染出与在线 rebuildPreset（runtime 先 reloadPresetParams）不一致的组合。
  const params = resolvePresetParams(spec, {})
  if (args.dryRun) {
    console.log(`[dry-run] would materialize ${preset.id}`)
    continue
  }
  try {
    writePreset(prompt, {
      ...params,
      presetDir: presetRoot,
      presetTemplate: preset.id,
      presetOrder: order,
      promptConfigs: [],
      agentsInstructionText: agentsText,
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
//    默认只报告；--refresh-skills 先备份再按模板刷新（预设独有文件不删除）。
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
  if (args.refreshSkills && args.dryRun) {
    console.log(`[dry-run] would refresh skills ${drift.presetId}: ${parts.join('、')}（${sample}）`)
    continue
  }
  if (!args.refreshSkills) {
    console.log(`stale skills ${drift.presetId}: ${parts.join('、')}（${sample}）；加 --refresh-skills 先备份再按包内模板刷新`)
    continue
  }
  try {
    let backupDir
    if (existsSync(drift.skillsDir)) {
      backupDir = join(presetRoot, drift.presetId, `${SKILLS_BACKUP_PREFIX}${Date.now().toString(36)}`)
      renameSync(drift.skillsDir, backupDir)
    }
    cpSync(drift.templateDir, drift.skillsDir, { recursive: true, force: true })
    console.log(`refreshed skills ${drift.presetId}${backupDir === undefined ? '' : `（原副本已备份为 ${relative(presetRoot, backupDir)}）`}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // 运行中的宿主会在 skills 目录里持有句柄，改名同样会 EPERM/EBUSY。
    const locked = /EPERM|EBUSY|EACCES/.test(message)
    failures.push(`${drift.presetId}: 刷新预设内嵌 skills 失败：${message}${locked ? '（目录被运行中的宿主进程锁定，重启 DSH 后重跑本脚本）' : ''}`)
  }
}

// 4) 物化后校验：组合版本戳与共享引擎标记存在（失败计入退出码）。
if (!args.dryRun && materializedIds.length > 0) {
  const marker = join(presetRoot, '.engine', '.pt-engine-fingerprint')
  if (!existsSync(marker)) failures.push('共享引擎缺少 .engine/.pt-engine-fingerprint')
  for (const id of materializedIds) {
    const composition = join(presetRoot, id, 'agent.cordis.yml')
    let raw = ''
    try {
      raw = readFileSync(composition, 'utf8')
    } catch {
      failures.push(`${id}: 缺少 agent.cordis.yml`)
      continue
    }
    if (!raw.includes(RENDER_STAMP_PREFIX)) failures.push(`${id}: agent.cordis.yml 缺少 render 版本戳`)
    if (raw.includes('../engine/') || raw.includes('./engine/')) failures.push(`${id}: agent.cordis.yml 仍引用旧布局 engine/ 目录`)
  }
}

for (const failure of failures) console.error(`FAIL ${failure}`)
console.log(
  `rematerialize-presets: ${presets.length} preset(s) scanned, `
  + `${args.dryRun ? 0 : materializedIds.length} materialized, ${skipped} skipped, ${staleSkills.length} stale skills, ${failures.length} failed`
  + `${args.dryRun ? ' (dry-run)' : ''}`,
)
process.exit(failures.length > 0 ? 1 : 0)
