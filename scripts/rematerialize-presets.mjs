#!/usr/bin/env node
/**
 * rematerialize-presets.mjs — 从完整 module.yml 原地恢复 rules/ 切片，清理已退役产物。
 * 已有模块原地校验，不交换目录，不重写用户正文、记忆或其他资产。
 *
 * 缺少 modules/composition 的定义跳过；旧规则格式需要显式离线迁移。
 *
 * 用法：
 *   node scripts/rematerialize-presets.mjs [--dsh-home <dir>] [--dry-run]
 * 退出码：任一模块物化失败或校验不通过 = 1（其余模块继续处理）。
 *
 * 文件名与 npm script 名（`rematerialize:presets`）沿用历史命名；它服务的是本插件的
 * 模块根 `<DSH_HOME>/.prompt-tool/modules`。原先的「预设内嵌 skills 比对 / --refresh-skills」
 * 一段已随该机制退场删除——插件不再分发预设或内嵌技能。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDocument } from 'yaml'

const LIB_ENTRY = new URL('../lib/index.mjs', import.meta.url)

function parseArgs(argv) {
  const out = { dshHome: undefined, dryRun: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry-run' || arg === '-n') out.dryRun = true
    else if (arg === '--dsh-home') {
      const value = argv[index + 1]
      if (value === undefined || value.trim().length === 0) throw new Error('--dsh-home 需要目录参数')
      out.dshHome = value
      index += 1
    } else if (arg.startsWith('--dsh-home=')) out.dshHome = arg.slice('--dsh-home='.length)
    else throw new Error(`未知参数 ${arg}（支持 --dsh-home <dir> / --dry-run）`)
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
// DSH_HOME 必须在 import lib 之前设置：paths.ts 在模块加载时计算模块根。
if (args.dshHome !== undefined && args.dshHome.trim().length > 0) process.env.DSH_HOME = resolve(args.dshHome)
if (!existsSync(fileURLToPath(LIB_ENTRY))) {
  console.error(`rematerialize-presets: 缺少构建产物 ${fileURLToPath(LIB_ENTRY)}，请先运行 pnpm build`)
  process.exit(1)
}
const { writeModule, userModulesDir } = await import(LIB_ENTRY.href)

// 逐模块重新物化：插件格式（modules/params）走 writeModule；手写或其他格式跳过。
const moduleRoot = userModulesDir()
const materializedIds = []
const failures = []
let skipped = 0
// 不经过会 ensure 切片的列表/加载入口，保证 --dry-run 完全只读。
const modules = existsSync(moduleRoot) ? readdirSync(moduleRoot, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && /^[a-z0-9][a-z0-9-]*$/.test(entry.name))
  .map(entry => ({ id: entry.name })) : []
for (const module of modules) {
  const dir = join(moduleRoot, module.id)
  let spec
  try {
    const doc = parseDocument(readFileSync(join(dir, 'module.yml'), 'utf8'), { logLevel: 'silent' })
    if (doc.errors.length > 0) throw doc.errors[0]
    spec = doc.toJS()
  } catch (error) {
    failures.push(`${module.id}: 读取 module.yml 失败：${error instanceof Error ? error.message : String(error)}`)
    continue
  }
  const pluginFormat = spec !== null && typeof spec === 'object' && (Array.isArray(spec.modules) || typeof spec.composition === 'string')
  if (!pluginFormat) {
    skipped += 1
    console.log(`skip ${module.id}: 定义缺少 modules/composition`)
    continue
  }
  if (args.dryRun) {
    console.log(`[dry-run] would materialize ${module.id}`)
    continue
  }
  try {
    writeModule('', {
      modulesRoot: moduleRoot,
      moduleId: module.id,
      warn: (message) => console.warn(message),
    })
    materializedIds.push(module.id)
    console.log(`materialized ${module.id}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // 运行中的宿主持有模块目录句柄时写盘会 EPERM/EBUSY；提示重启后重跑。
    const locked = /EPERM|EBUSY|EACCES/.test(message)
    failures.push(`${module.id}: ${message}${locked ? '（目录被运行中的宿主进程锁定，重启 DSH 后重跑本脚本）' : ''}`)
  }
}

// 恢复后校验：切片存在且旧宿主装配产物已退役。
if (!args.dryRun && materializedIds.length > 0) {
  for (const id of materializedIds) {
    if (!existsSync(join(moduleRoot, id, 'rules', '_settings.yml'))) failures.push(`${id}: 缺少 rules/_settings.yml`)
    for (const name of ['configs', 'rules.yml', 'agent.cordis.yml', 'custom-tools', 'subagent-tools']) {
      if (existsSync(join(moduleRoot, id, name))) failures.push(`${id}: 旧产物 ${name} 未清理`)
    }
  }
}

for (const failure of failures) console.error(`FAIL ${failure}`)
console.log(
  `rematerialize-presets: ${modules.length} module(s) scanned, `
  + `${args.dryRun ? 0 : materializedIds.length} materialized, ${skipped} skipped, ${failures.length} failed`
  + `${args.dryRun ? ' (dry-run)' : ''}`,
)
process.exit(failures.length > 0 ? 1 : 0)
