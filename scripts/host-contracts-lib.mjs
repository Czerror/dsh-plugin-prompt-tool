// host-contracts-lib.mjs — 宿主契约验证的纯函数。
//
// 供 scripts/verify-host-contracts.mjs（CLI 报告）与 test/host/version-contract.test.mjs
// 共用，避免两处各写一份版本／路径判断。这里不读仓库外的私有源码，也不安装依赖。
import semver from 'semver'

/** 官方包作用域；本插件只消费这个作用域下的宿主能力。 */
export const OFFICIAL_SCOPE = '@deepseek-ai/'

/** 本仓库锁定的官方发布基线。 */
export const DSH_BASELINE = '0.1.5-rc.2'
export const CORDIS_BASELINE = '4.0.2'

/** dev 依赖精确基线：按包名给出必须等值命中的版本。 */
export function expectedDevBaseline(name) {
  if (name === '@deepseek-ai/cordis') return CORDIS_BASELINE
  if (name.startsWith(OFFICIAL_SCOPE)) return DSH_BASELINE
  return undefined
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

/** 精确基线命中：非 semver、rc 序号不符、alpha 混入都必须为 false。 */
export function isExactBaseline(version, expected) {
  return semver.valid(version) === expected
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
