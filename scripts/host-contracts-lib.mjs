// host-contracts-lib.mjs — 宿主契约验证的共享判定。
//
// 供 scripts/verify-host-contracts.mjs（CLI 报告）与 test/host/version-contract.test.mjs
// 共用，避免两处各写一份版本／路径判断。这里不读仓库外的私有源码，也不安装依赖。
import { readFileSync } from 'node:fs'
import semver from 'semver'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/** 官方包作用域；本插件只消费这个作用域下的宿主能力。 */
export const OFFICIAL_SCOPE = '@deepseek-ai/'

/** 本仓库 package.json 显式选择的发布版本；导出名保持稳定。 */
export const DSH_BASELINE = expectedDevBaseline('@deepseek-ai/dsh-agent')
export const CORDIS_BASELINE = expectedDevBaseline('@deepseek-ai/cordis')

/** dev 依赖精确基线：按包名给出必须等值命中的版本。 */
export function expectedDevBaseline(name, selectedManifest = manifest) {
  const source = name.startsWith(`${OFFICIAL_SCOPE}dsh-`) ? '@deepseek-ai/dsh-agent' : name
  if (source !== '@deepseek-ai/dsh-agent' && source !== '@deepseek-ai/cordis') return undefined
  const version = selectedManifest.devDependencies?.[source]
  if (!isExactBaseline(version, version)) {
    throw new Error(`devDependencies.${source}: 必须声明精确 semver 发布版本，实际为 ${String(version)}`)
  }
  return version
}

/**
 * peer 范围是否接受某个实际安装版本。
 * includePrerelease：0.1.5-rc.2 这类预发布版本必须参与比较，
 * 否则 `^0.1.5-alpha.1` 会被误判为不兼容 rc.2。
 */
export function peerRangeAccepts(range, version) {
  if (!semver.valid(version)) return false
  return semver.satisfies(version, range, { includePrerelease: true })
}

/** 精确基线命中：完整 semver 必须相同，不能把解析失败或归一化结果当成精确声明。 */
export function isExactBaseline(version, expected) {
  if (typeof version !== 'string' || version !== expected) return false
  const parsed = semver.parse(version)
  return parsed !== null && version === `${parsed.version}${parsed.build.length > 0 ? `+${parsed.build.join('.')}` : ''}`
}

/** CLI 与行为测试共用的版本验证；manifest 可显式传入，不需要改写仓库文件。 */
export function dependencyVersionProblems(name, section, version, selectedManifest = manifest) {
  const range = selectedManifest[section]?.[name]
  const baseline = expectedDevBaseline(name, selectedManifest)
  const problems = []
  if (!peerRangeAccepts(range, version)) {
    problems.push(`安装版本 ${version} 不满足 ${section} 范围 ${range}`)
  }
  if (section === 'devDependencies') {
    if (!isExactBaseline(range, range)) problems.push(`dev 声明 ${range} 不是精确 semver 发布版本`)
    if (baseline !== undefined && range !== baseline) problems.push(`dev 声明 ${range} 不是精确基线 ${baseline}`)
  }
  const expected = baseline ?? (section === 'devDependencies' ? range : undefined)
  if (expected !== undefined && !isExactBaseline(version, expected)) {
    problems.push(`安装版本 ${version} 不等于基线 ${expected}`)
  }
  return problems
}

/**
 * 已安装官方包必须来自仓库内的 node_modules（.pnpm 真实目录），
 * 不能是 `link:../deepseek-harness/...` 这种开发机同级源码。
 */
export function isRepoLocalResolution(realPath, repoRoot) {
  if (typeof realPath !== 'string' || realPath.length === 0) return false
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) return false
  const normalize = (value) => value.replaceAll('\\', '/').replace(/\/+$/, '')
  const root = `${normalize(repoRoot)}/node_modules/`
  return `${normalize(realPath)}/`.startsWith(root)
}

/** 子路径导入归一到包名：@deepseek-ai/dsh-x/client → @deepseek-ai/dsh-x。 */
function packageNameOf(specifier) {
  const segments = specifier.split('/')
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
}

/**
 * 从源码文本提取模块边（静态、`import type`、side-effect、动态 import 与 require）。
 *
 * 只认真正的 import 形式：直接出现的字符串常量（bundle 名、官方行名、文案）不算消费，
 * 否则 `@deepseek-ai/dsh-persona` 这类“官方行名”会被误判成未声明的包依赖。
 */
export function moduleImports(source) {
  const names = new Set()
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1]
      if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) continue
      names.add(packageNameOf(specifier))
    }
  }
  return [...names].sort()
}

/** 只保留官方作用域的模块边。 */
export function officialImports(source) {
  return moduleImports(source).filter((name) => name.startsWith(OFFICIAL_SCOPE))
}
