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
 * 旧版数据迁移：默认先执行 scripts/migrate-presets.mjs（旧 worldBook 段、扁平
 * 模型键、旧 persona 卡、旧模块名、overrides 文件；写盘前备份 .bak），再物化；
 * `--no-migrate` 跳过。手写/官方格式预设（preset.yml 无 modules/params，如
 * liangshen）整体跳过，不覆盖用户手写组合。
 *
 * 用法：
 *   node scripts/rematerialize-presets.mjs [--dsh-home <dir>] [--dry-run] [--no-migrate]
 * 退出码：任一预设物化失败或校验不通过 = 1（其余预设继续处理）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const MIGRATE_SCRIPT = join(HERE, 'migrate-presets.mjs')
const LIB_ENTRY = new URL('../lib/index.mjs', import.meta.url)
const RENDER_STAMP_PREFIX = '# prompt-tool:render v'

function parseArgs(argv) {
  const out = { dshHome: undefined, dryRun: false, migrate: true }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry-run' || arg === '-n') out.dryRun = true
    else if (arg === '--no-migrate') out.migrate = false
    else if (arg === '--dsh-home') {
      const value = argv[index + 1]
      if (value === undefined || value.trim().length === 0) throw new Error('--dsh-home 需要目录参数')
      out.dshHome = value
      index += 1
    } else if (arg.startsWith('--dsh-home=')) out.dshHome = arg.slice('--dsh-home='.length)
    else throw new Error(`未知参数 ${arg}（支持 --dsh-home <dir> / --dry-run / --no-migrate）`)
  }
  return out
}

/** 读生成目录内容资产；文件不存在返回 undefined（调用方回退模板内容）。 */
function readGenerated(dir, name) {
  const file = join(dir, name)
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined
}

const args = parseArgs(process.argv.slice(2))
// DSH_HOME 必须在 import lib 之前设置：paths.ts 在模块加载时计算 DEFAULT_PRESET_DIR。
if (args.dshHome !== undefined && args.dshHome.trim().length > 0) process.env.DSH_HOME = resolve(args.dshHome)
if (!existsSync(fileURLToPath(LIB_ENTRY))) {
  console.error(`rematerialize-presets: 缺少构建产物 ${fileURLToPath(LIB_ENTRY)}，请先运行 pnpm build`)
  process.exit(1)
}
const { writePreset, listPresets, loadPresetSpec, resolvePresetParams, userPresetsDir } = await import(LIB_ENTRY.href)

// 1) 旧版数据迁移（子进程复用既有 CLI：dry-run / 退出码 / .bak 备份语义一致）。
if (args.migrate) {
  const migrateArgs = [MIGRATE_SCRIPT]
  if (args.dryRun) migrateArgs.push('--dry-run')
  try {
    execFileSync(process.execPath, migrateArgs, { stdio: 'inherit', env: process.env })
  } catch {
    console.error('rematerialize-presets: 离线迁移失败，已中止物化（原文件保留，迁移脚本写盘前已备份 .bak-*）')
    process.exit(1)
  }
}

// 2) 逐预设重新物化：插件格式（modules/params）走 writePreset；手写/官方格式跳过。
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

// 3) 物化后校验：组合版本戳与共享引擎标记存在（失败计入退出码）。
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
  + `${args.dryRun ? 0 : materializedIds.length} materialized, ${skipped} skipped, ${failures.length} failed`
  + `${args.dryRun ? ' (dry-run)' : ''}`,
)
process.exit(failures.length > 0 ? 1 : 0)
