#!/usr/bin/env node
/**
 * link-profile.mjs —— 将 dsh-web-ui 全家桶各包链接到 dsh profile 全局兜底层
 * `<DSH_HOME>/profiles/node_modules/@linxin666/`。
 *
 * dsh loader 解析 cordis.patch.yml 的 `name:` 条目时走 Node 包解析：从 profile
 * 目录向上逐级找 node_modules，最终命中 `profiles/node_modules` 兜底层。聚合包
 * `@linxin666/dsh-web-ui-all` 的 patch 引用了全部子包，子包链接必须放在这一层；
 * 缺链接时启动报 `Cannot find package '@linxin666/...' imported from <profile>`。
 *
 * 自 dsh-web-ui 的 scripts/link-profile.mjs 引入，差异：
 *   - 定位 .dsh 目录：`--dsh-home <dir>` > `DSH_HOME` 环境变量（非空白）> `~/.dsh`
 *     （与官方 @deepseek-ai/dsh-home-paths 的 resolveDshHome 语义一致：Windows 用
 *     os.homedir() 不读 HOME 环境变量，支持 `~` 展开；本机真实目录
 *     `D:\AI\DeepSeek harness\.dsh` 由 DSH_HOME 提供，裸跑无 DSH_HOME 时务必显式传）；
 *   - 定位 dsh-web-ui 仓库：`--repo <dir>` > `DSH_WEB_UI_REPO` 环境变量 >
 *     从兜底层 `dsh-web-ui-all` 链接目标反推（target/packages/dsh-web-ui-all）。
 *
 * 幂等：缺的补、指向错的换、真实文件跳过。用法：
 *   node scripts/link-profile.mjs [--dsh-home <dir>] [--repo <dir>] [--dry-run]
 */
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync,
  rmdirSync, symlinkSync, unlinkSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve as resolvePath } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const FAMILY_SCOPE = '@linxin666/'

/** 展开 `~`、`~/`、`~\` 前缀（与官方 @deepseek-ai/dsh-home-paths 的 expandHomePath 一致）。 */
function expandHomePath(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * 纯决策：解析 dsh home。优先级 `--dsh-home` > `$DSH_HOME`（空白视为未设置）> `~/.dsh`，
 * 与官方 resolveDshHome 语义一致。
 */
export function resolveDshHomeArg(args, env = process.env) {
  const fromArgs = argValue(args, '--dsh-home')
  const fromEnv = env.DSH_HOME
  const raw = fromArgs ?? (fromEnv !== undefined && fromEnv.trim() ? fromEnv : join(homedir(), '.dsh'))
  return resolvePath(expandHomePath(raw))
}

/**
 * 纯决策：链接点当前状态 + 期望 target 下应执行什么动作。
 * @param {'missing'|'symlink'|'file'|'dir'} existing
 * @param {string} target
 * @param {string|null} currentTarget
 * @returns {'create'|'keep'|'replace'|'skip-report'}
 */
export function decideLinkAction(existing, target, currentTarget) {
  if (existing === 'missing') return 'create'
  if (existing === 'symlink') return currentTarget === target ? 'keep' : 'replace'
  return 'skip-report'
}

/** 遍历 dsh-web-ui 仓库中所有 name 以 @linxin666/ 开头的包（packages/* 与 packages/skins/*）。 */
export function familyPackages(repoRoot) {
  const found = []
  for (const base of ['packages', join('packages', 'skins')]) {
    const absBase = resolvePath(repoRoot, base)
    if (!existsSync(absBase)) continue
    for (const entry of readdirSync(absBase).sort()) {
      const dir = resolvePath(absBase, entry)
      const pkgPath = join(dir, 'package.json')
      if (!existsSync(pkgPath)) continue
      let name
      try { name = JSON.parse(readFileSync(pkgPath, 'utf8')).name } catch { continue }
      if (name && name.startsWith(FAMILY_SCOPE)) {
        found.push({ name: name.slice(FAMILY_SCOPE.length), dir })
      }
    }
  }
  return found
}

/** 从兜底层/各 profile 的 dsh-web-ui-all 链接目标反推仓库根。dshHome 为 .dsh 目录。 */
export function repoFromLinks(dshHome) {
  const profilesDir = join(dshHome, 'profiles')
  if (!existsSync(profilesDir)) return undefined
  const candidates = [join(profilesDir, 'node_modules', FAMILY_SCOPE, 'dsh-web-ui-all')]
  for (const entry of readdirSync(profilesDir)) {
    candidates.push(join(profilesDir, entry, 'node_modules', FAMILY_SCOPE, 'dsh-web-ui-all'))
  }
  for (const p of candidates) {
    try {
      const t = readlinkSync(p)
      const abs = resolvePath(dirname(p), t)
      if (basename(dirname(abs)) === 'packages') return dirname(dirname(abs))
    } catch { /* 链接缺失或损坏，试下一个 */ }
  }
  return undefined
}

function argValue(args, flag) {
  const i = args.indexOf(flag)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined
}

function main() {
  const args = process.argv.slice(2)
  const DRY = args.includes('--dry-run')
  const report = (msg) => console.log(`[link-profile] ${msg}`)

  const dshHome = resolveDshHomeArg(args)
  if (!dshHome) {
    console.error('[link-profile] cannot determine .dsh dir; pass --dsh-home <dir> or set DSH_HOME')
    process.exit(1)
  }
  const repo = argValue(args, '--repo') ?? process.env.DSH_WEB_UI_REPO ?? repoFromLinks(dshHome)
  if (!repo) {
    console.error('[link-profile] cannot locate dsh-web-ui repo; pass --repo <dir> or set DSH_WEB_UI_REPO')
    process.exit(1)
  }

  const LINK_DIR = join(dshHome, 'profiles', 'node_modules', FAMILY_SCOPE)
  const packages = familyPackages(repo)
  report(`dsh home: ${dshHome}`)
  report(`repo: ${repo}`)
  report(`found ${packages.length} family package(s)`)
  if (DRY) report('--dry-run: no changes will be made')

  if (!existsSync(LINK_DIR)) {
    if (DRY) {
      report(`would create link dir: ${LINK_DIR}`)
      process.exit(0)
    }
    mkdirSync(LINK_DIR, { recursive: true })
    report(`created link dir: ${LINK_DIR}`)
  }

  let changed = 0
  for (const { name, dir } of packages) {
    const linkPath = join(LINK_DIR, name)
    // Windows 无 Developer Mode 时不能建符号链接，用目录 junction（要求绝对 target）。
    const WIN32 = process.platform === 'win32'
    const target = WIN32 ? dir : relative(LINK_DIR, dir)
    let existing = 'missing'
    let linkIsJunctionDir = false
    try {
      const st = lstatSync(linkPath)
      existing = st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : 'file'
      if (existing === 'symlink' && st.isDirectory()) linkIsJunctionDir = true
    } catch {}
    let current = null
    if (existing === 'symlink') {
      try { current = readlinkSync(linkPath) } catch {}
    }
    const action = decideLinkAction(existing, target, current)
    if (action === 'keep') continue
    if (action === 'skip-report') {
      report(`skipped (not a symlink, untouched): ${linkPath}`)
      continue
    }
    if (action === 'create') {
      if (DRY) { report(`would link ${name} -> ${target}`); changed++; continue }
      symlinkSync(target, linkPath, WIN32 ? 'junction' : undefined)
      report(`linked ${name} -> ${target}`)
    } else {
      if (DRY) { report(`would replace ${name} -> ${current ?? '(broken)'}`); changed++; continue }
      if (linkIsJunctionDir) rmdirSync(linkPath)
      else unlinkSync(linkPath)
      symlinkSync(target, linkPath, WIN32 ? 'junction' : undefined)
      report(`replaced ${name} -> ${target} (was ${current ?? '(broken)'})`)
    }
    changed++
  }

  report(changed === 0 ? 'nothing to do' : `${changed} link(s) ${DRY ? 'would be ' : ''}updated`)
}

if (resolvePath(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main()
}
