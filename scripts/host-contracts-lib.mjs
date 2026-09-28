// host-contracts-lib.mjs — 宿主契约验证的共享判定。
//
// 供 scripts/verify-host-contracts.mjs（CLI 报告）使用。这里不读仓库外的私有源码，也不安装依赖。
import { readFileSync } from 'node:fs'
import semver from 'semver'
import ts from 'typescript'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/** 官方包作用域；本插件只消费这个作用域下的宿主能力。 */
export const OFFICIAL_SCOPE = '@deepseek-ai/'

/** 已验证的最低宿主契约；范围可以开放上界，锁文件固定本地验证输入。 */
export const DSH_BASELINE = '0.2.0-rc.1'

/**
 * peer 范围是否接受某个实际安装版本。
 * includePrerelease：0.1.5-rc.2 这类预发布版本必须参与比较，
 * 否则 `^0.1.5-alpha.1` 会被误判为不兼容 rc.2。
 */
export function peerRangeAccepts(range, version) {
  if (typeof range !== 'string' || !semver.validRange(range) || !semver.valid(version)) return false
  return semver.satisfies(version, range, { includePrerelease: true })
}

/** 精确基线命中：完整 semver 必须相同，不能把解析失败或归一化结果当成精确声明。 */
export function isExactBaseline(version, expected) {
  if (typeof version !== 'string' || version !== expected) return false
  const parsed = semver.parse(version)
  return parsed !== null && version === `${parsed.version}${parsed.build.length > 0 ? `+${parsed.build.join('.')}` : ''}`
}

/** CLI 与行为测试共用的版本验证；manifest 可显式传入，不需要改写仓库文件。 */
export function dependencyVersionProblems(name, section, version, selectedManifest = manifest, locked) {
  const range = selectedManifest[section]?.[name]
  const problems = []
  if (!peerRangeAccepts(range, version)) {
    problems.push(`安装版本 ${version} 不满足 ${section} 范围 ${range}`)
  }
  if (name.startsWith(`${OFFICIAL_SCOPE}dsh-`)) {
    const minimum = typeof range === 'string' && semver.validRange(range) ? semver.minVersion(range) : null
    if (minimum === null || semver.lt(minimum, DSH_BASELINE)) {
      problems.push(`声明范围必须保留最低宿主版本 ${DSH_BASELINE}`)
    }
  }
  if (locked !== undefined) {
    const lockedVersion = typeof locked.version === 'string' ? locked.version.split('(')[0] : undefined
    if (!isExactBaseline(version, lockedVersion)) problems.push(`安装版本 ${version} 不等于锁定版本 ${String(lockedVersion)}`)
    if (section !== 'peerDependencies' && locked.specifier !== range) {
      problems.push(`锁文件声明 ${String(locked.specifier)} 与 ${section} 范围 ${range} 不一致`)
    }
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
export function moduleImportEdges(source, filename = 'source.ts') {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true)
  const constants = new Map()
  const edges = []
  const add = (specifier, typeOnly) => {
    if (typeof specifier !== 'string' || specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) return
    edges.push({ name: packageNameOf(specifier), specifier, typeOnly })
  }
  const collectConstants = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isStringLiteralLike(node.initializer)) {
      constants.set(node.name.text, node.initializer.text)
    }
    ts.forEachChild(node, collectConstants)
  }
  collectConstants(file)
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const clause = node.importClause
      const bindings = clause?.namedBindings
      const typeOnly = clause?.isTypeOnly === true || (clause?.name === undefined && bindings && ts.isNamedImports(bindings)
        && bindings.elements.length > 0 && bindings.elements.every((entry) => entry.isTypeOnly))
      add(node.moduleSpecifier.text, Boolean(typeOnly))
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const typeOnly = node.isTypeOnly || (node.exportClause && ts.isNamedExports(node.exportClause)
        && node.exportClause.elements.length > 0 && node.exportClause.elements.every((entry) => entry.isTypeOnly))
      add(node.moduleSpecifier.text, Boolean(typeOnly))
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
      add(node.argument.literal.text, true)
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && ['require', 'importHostPackage'].includes(node.expression.text)))) {
      const argument = node.arguments[0]
      if (argument && ts.isStringLiteralLike(argument)) add(argument.text, false)
      else if (argument && ts.isIdentifier(argument)) add(constants.get(argument.text), false)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return edges
}

export function moduleImports(source) {
  return [...new Set(moduleImportEdges(source).map((edge) => edge.name))].sort()
}

/** 只保留官方作用域的模块边。 */
export function officialImports(source) {
  return moduleImports(source).filter((name) => name.startsWith(OFFICIAL_SCOPE))
}

/** 分类消费面；服务名 inject 与包名 inject 都不构成运行时模块导入。 */
export function importContractProblems(edge, client, selectedManifest = manifest) {
  if (!edge.name.startsWith(OFFICIAL_SCOPE)) return []
  const { name, specifier, typeOnly } = edge
  const dev = selectedManifest.devDependencies?.[name]
  if (client || typeOnly) {
    const problems = dev === undefined ? [`${specifier}: 类型或浏览器输入缺少 devDependencies 声明`] : []
    if (client && !typeOnly && name.startsWith(`${OFFICIAL_SCOPE}dsh-`)) {
      problems.push(`${specifier}: Client 禁止运行时加载 Harness 包；使用本地控件、公开服务或槽位`)
    }
    return problems
  }
  if (name === '@deepseek-ai/schemastery' && selectedManifest.dependencies?.[name] !== undefined) return []
  return selectedManifest.peerDependencies?.[name] !== undefined && dev !== undefined ? []
    : [`${specifier}: Host 运行时宿主包必须声明 peerDependencies 与 devDependencies，保证共享实例`]
}
