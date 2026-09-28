#!/usr/bin/env node
/**
 * repair-profile.mjs —— 只读诊断 profile 的包解析失败。
 *
 * 为什么需要独立工具：dsh 解析 `dsh.profile.bundles` 时按 Node 包解析从 profile 目录向上找
 * `node_modules`，解析失败只打印 `skipping profile bundle` 并**跳过整个 bundle**——插件的
 * 任何插件代码（能力诊断、预设种子补建、注册）都不会执行。这类「插件根本没加载」
 * 的零号故障因此只能由独立于插件的工具处理，本脚本即此工具。
 *
 * profile 与 node_modules 全部只读。安装、链接和装配由官方 plugin_manager 管理。
 *
 * 判据与 dsh 一致：`createRequire(<profile>/package.json).resolve.paths(name)` 中任一
 * `join(search, name)/package.json` 存在即视为可解析（见 app-boot `resolveBundleDir`）。
 * 额外报出「链接目标是否存在」——本次真实故障正是「链接在、目标不在」，只看链接本身会漏。
 *
 * 仅报告缺失、悬空与异常解析；保留 --dry-run 作为旧调用方兼容参数。用法：
 *   node scripts/repair-profile.mjs [--dsh-home <dir>] [--profile <name>] [--dry-run]
 * 退出码：0 = 全部健康；1 = 存在需通过官方管理器处理的项。
 */
import {
  existsSync, lstatSync, readdirSync, readFileSync, readlinkSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const MANIFEST = 'package.json'

/** 展开 `~`、`~/`、`~\` 前缀（与官方 @deepseek-ai/dsh-home-paths 的 expandHomePath 一致）。 */
function expandHomePath(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

function argValue(args, flag) {
  const index = args.indexOf(flag)
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined
}

/**
 * 解析 dsh home：`--dsh-home` > `$DSH_HOME`（空白视为未设置）> `~/.dsh`，与官方
 * `resolveDshHome` 语义一致（Windows 用 `os.homedir()`，不读 HOME 环境变量）。
 * @param {string[]} args
 * @param {Record<string, string|undefined>} env
 * @returns {string} 绝对路径
 */
export function resolveDshHomeArg(args, env = process.env) {
  const fromArgs = argValue(args, '--dsh-home')
  const fromEnv = env.DSH_HOME
  const raw = fromArgs ?? (fromEnv !== undefined && fromEnv.trim() ? fromEnv : join(homedir(), '.dsh'))
  return resolvePath(expandHomePath(raw))
}

/**
 * 按 dsh 的口径判断一个包名能否从某锚点解析。
 * @param {string} anchorPath 锚点文件（profile 的 package.json）
 * @param {string} name 包名
 * @returns {string|undefined} 命中的包目录，未命中为 undefined
 */
export function dshResolvable(anchorPath, name) {
  let searchPaths = []
  try {
    searchPaths = createRequire(anchorPath).resolve.paths(name) ?? []
  } catch {
    return undefined
  }
  for (const search of searchPaths) {
    const candidate = join(search, name)
    if (existsSync(join(candidate, MANIFEST))) return candidate
  }
  return undefined
}

/**
 * 分类一个链接点的现状（纯函数，便于单测）。
 * @param {string} linkPath
 * @returns {{kind:'missing'|'symlink'|'file'|'dir', currentTarget?:string, resolvedTarget?:string, targetExists?:boolean, isJunction?:boolean}}
 */
export function classifyEntry(linkPath) {
  let stats
  try {
    stats = lstatSync(linkPath)
  } catch {
    return { kind: 'missing' }
  }
  if (!stats.isSymbolicLink()) return { kind: stats.isDirectory() ? 'dir' : 'file' }
  let currentTarget = null
  try { currentTarget = readlinkSync(linkPath) } catch { /* 读不到按悬空处理 */ }
  const resolvedTarget = currentTarget === null ? undefined : resolvePath(dirname(linkPath), currentTarget)
  return {
    kind: 'symlink',
    currentTarget: currentTarget ?? undefined,
    resolvedTarget,
    targetExists: resolvedTarget !== undefined && existsSync(join(resolvedTarget, MANIFEST)),
    // Windows 的 junction 在 lstat 下同时呈现为符号链接与目录；删除方式不同。
    isJunction: stats.isDirectory(),
  }
}

/** 从 manifest 的 dependencies 提取 `link:` 声明的期望目标（绝对路径）。 */
export function linkTargetsOf(manifest, profileDir) {
  const targets = new Map()
  const deps = manifest?.dependencies
  if (deps === null || typeof deps !== 'object') return targets
  for (const [name, spec] of Object.entries(deps)) {
    if (typeof spec !== 'string' || !spec.startsWith('link:')) continue
    const raw = spec.slice('link:'.length)
    if (raw.length === 0) continue
    targets.set(name, resolvePath(profileDir, raw))
  }
  return targets
}

/** 一个 profile 需要体检的包名集合：bundles ∪ dependencies。 */
function trackedNames(manifest) {
  const names = new Set()
  const bundles = manifest?.dsh?.profile?.bundles
  if (Array.isArray(bundles)) for (const name of bundles) if (typeof name === 'string' && name) names.add(name)
  const deps = manifest?.dependencies
  if (deps !== null && typeof deps === 'object') for (const name of Object.keys(deps)) names.add(name)
  return [...names].sort()
}

/**
 * 体检一个 profile（只读）。
 * @returns {{name:string, dir:string, entries:Array<object>}}
 */
export function diagnoseProfile(dshHome, profileName) {
  const dir = join(dshHome, 'profiles', profileName)
  const anchor = join(dir, MANIFEST)
  let manifest = {}
  try {
    manifest = JSON.parse(readFileSync(anchor, 'utf8'))
  } catch {
    return { name: profileName, dir, entries: [{ name: '(manifest)', status: 'unreadable', detail: `无法读取 ${anchor}` }] }
  }
  const targets = linkTargetsOf(manifest, dir)
  const entries = []
  for (const name of trackedNames(manifest)) {
    const linkPath = join(dir, 'node_modules', name)
    const entry = classifyEntry(linkPath)
    const resolved = dshResolvable(anchor, name)
    const declared = targets.get(name)
    let status
    let detail
    // 只有「声明为 link: 却被真实条目占位」才需要人工介入；普通依赖在 node_modules 下
    // 本就是真实目录或符号链接（pnpm 布局），不算异常。
    if (declared !== undefined && (entry.kind === 'file' || entry.kind === 'dir')) {
      status = 'blocked'
      detail = `声明为 link: 却被真实${entry.kind === 'dir' ? '目录' : '文件'}占位（不删除，请人工处理）：${linkPath}`
    } else if (entry.kind === 'symlink' && entry.targetExists === false) {
      status = 'broken-link'
      detail = `链接悬空：${entry.currentTarget} → ${entry.resolvedTarget ?? '(无法解析)'}（目标无 ${MANIFEST}）`
    } else if (resolved === undefined) {
      status = entry.kind === 'missing' ? 'missing' : 'unresolvable'
      detail = entry.kind === 'missing' ? `私有层缺链接：${linkPath}` : `无法从 profile 解析（链接存在但解析失败）：${linkPath}`
    } else if (resolved !== linkPath) {
      status = 'ok-via-ancestor'
      detail = `私有层未命中，由上层解析兜住：${resolved}`
    } else {
      status = 'ok'
      detail = resolved
    }
    entries.push({
      name, status, detail, linkPath,
      ...(declared === undefined ? {} : { declaredTarget: declared }),
    })
  }
  return { name: profileName, dir, entries }
}

/** 列出 `--dsh-home` 下的全部 profile 名。 */
export function listProfiles(dshHome) {
  const dir = join(dshHome, 'profiles')
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(dir, name, MANIFEST)))
    .sort()
}

/**
 * 只读体检指定 profile；保留函数名与 changed 字段兼容旧调用方。
 * @param {{dshHome:string, profile?:string, dryRun?:boolean, log?:(m:string)=>void}} options
 * @returns {{changed:number, failures:number, reports:Array<object>}}
 */
export function repairProfiles(options) {
  const { dshHome, profile, log = (message) => console.log(message) } = options
  const names = profile === undefined ? listProfiles(dshHome) : [profile]
  const reports = []
  let failures = 0
  for (const name of names) {
    const report = diagnoseProfile(dshHome, name)
    reports.push(report)
    log(`[repair-profile] profile ${name}: ${report.dir}`)
    for (const entry of report.entries) {
      // `ok-via-ancestor` 是「私有层未命中、由上层兜住」：不是失败，也不该打 FAIL 标记。
      const mark = entry.status === 'ok' ? '  ok  ' : entry.status === 'ok-via-ancestor' ? ' note ' : ' FAIL '
      log(`[repair-profile]${mark}${entry.name}: ${entry.status} — ${entry.detail}`)
      if (entry.status !== 'ok' && entry.status !== 'ok-via-ancestor') failures++
    }
  }
  if (failures > 0) {
    log(`[repair-profile] 请在目标 profile "${profile ?? '<name>'}" 中通过官方 plugin_manager 检查并重新安装插件；本工具未修改 profile 或包链接。`)
  }
  return { changed: 0, failures, reports }
}

function main() {
  const args = process.argv.slice(2)
  const profileFlag = args.indexOf('--profile')
  const profile = profileFlag >= 0 && profileFlag + 1 < args.length ? args[profileFlag + 1] : undefined
  const dshHome = resolveDshHomeArg(args)
  if (!existsSync(join(dshHome, 'profiles'))) {
    console.error(`[repair-profile] no profiles directory under ${dshHome}; pass --dsh-home <dir> or set DSH_HOME`)
    process.exit(1)
  }
  const { failures } = repairProfiles({ dshHome, profile })
  console.log(`[repair-profile] dsh home: ${dshHome} (read-only)`)
  console.log(`[repair-profile] ${failures} need attention`)
  process.exit(failures > 0 ? 1 : 0)
}

if (resolvePath(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main()
}
