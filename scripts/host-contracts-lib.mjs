// host-contracts-lib.mjs — 宿主契约验证的共享判定。
//
// 供 scripts/verify-host-contracts.mjs（CLI 报告）使用。这里不读仓库外的私有源码，也不安装依赖。
import { readFileSync } from 'node:fs'
import semver from 'semver'
import ts from 'typescript'
import { HOST_CAPABILITY_PACKAGES } from '../engine/host-package.mjs'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/** 官方包作用域；本插件只消费这个作用域下的宿主能力。 */
export const OFFICIAL_SCOPE = '@deepseek-ai/'

/** 已验证的最低宿主契约；范围可以开放上界，锁文件固定本地验证输入。 */
export const DSH_BASELINE = '0.2.2-rc.2'
export { DSH_SOURCE_SHA } from './harness-source.mjs'

/** 比较发布类型的档位键与插件分组；只解析声明，不执行宿主包或手抄数值。 */
export function officialOrderContractProblems(officialSource, pluginSource) {
  const parse = (source, filename) => {
    const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true)
    if (file.parseDiagnostics.length > 0) throw new Error(filename + ': 无法解析档位声明')
    return file
  }
  const official = parse(officialSource, 'dsh-system-prompt.d.ts')
  const plugin = parse(pluginSource, 'official-orders.ts')
  const declaration = (file, name) => {
    const matches = file.statements.filter(ts.isVariableStatement)
      .flatMap((statement) => [...statement.declarationList.declarations])
      .filter((node) => ts.isIdentifier(node.name) && node.name.text === name)
    if (matches.length !== 1) throw new Error(name + ': 应有唯一档位声明')
    return matches[0]
  }
  const nameOf = (node) => {
    if (node && (ts.isIdentifier(node) || ts.isStringLiteralLike(node))) return node.text
    throw new Error('档位声明包含非字面量键')
  }
  const unwrap = (node) => {
    while (node && (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node))) node = node.expression
    return node
  }
  const problems = []
  for (const [table, groups] of [
    ['SECTION_ORDERS', 'OFFICIAL_SECTION_ORDER_GROUPS'],
    ['CONTEXT_ORDERS', 'OFFICIAL_CONTEXT_ORDER_GROUPS'],
  ]) {
    const type = declaration(official, table).type
    if (!type || !ts.isTypeLiteralNode(type)) throw new Error(table + ': 应为档位键类型声明')
    const expected = new Set(type.members.map((member) => nameOf(member.name)))
    const array = unwrap(declaration(plugin, groups).initializer)
    if (!array || !ts.isArrayLiteralExpression(array)) throw new Error(groups + ': 应为分组数组')
    const names = array.elements.flatMap((group) => {
      if (!ts.isObjectLiteralExpression(group)) throw new Error(groups + ': 应为分组对象')
      const property = group.properties.find((entry) => entry.name && nameOf(entry.name) === 'names')
      const values = property && ts.isPropertyAssignment(property) ? unwrap(property.initializer) : undefined
      if (!values || !ts.isArrayLiteralExpression(values)) throw new Error(groups + ': 缺少 names 字面量数组')
      return values.elements.map((value) => {
        if (!ts.isStringLiteralLike(value)) throw new Error(groups + ': 档位名应为字符串字面量')
        return value.text
      })
    })
    const actual = new Set(names)
    const missing = [...expected].filter((name) => !actual.has(name)).sort()
    const extra = [...actual].filter((name) => !expected.has(name)).sort()
    if (missing.length > 0) problems.push(table + ': 插件分组缺少官方档位 ' + missing.join(', '))
    if (extra.length > 0) problems.push(table + ': 插件分组多出非官方档位 ' + extra.join(', '))
  }
  return problems
}

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
export function dependencyVersionProblems(name, section, version, selectedManifest = manifest, locked, sourcePackage) {
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
    const sourceVersion = sourcePackage && locked.version?.split('(')[0] === `file:${sourcePackage.path}` ? sourcePackage.version : undefined
    const lockedVersion = sourceVersion ?? (typeof locked.version === 'string' ? locked.version.split('(')[0] : undefined)
    if (!isExactBaseline(version, lockedVersion)) problems.push(`安装版本 ${version} 不等于锁定版本 ${String(lockedVersion)}`)
    if (section !== 'peerDependencies' && locked.specifier !== (sourceVersion ? `file:${sourcePackage.path}` : range)) {
      problems.push(`锁文件声明 ${String(locked.specifier)} 与 ${section} 范围 ${range} 不一致`)
    }
  }
  return problems
}

/**
 * `engines.dsh` 声明（作者声明的兼容 DSH 版本，SemVer 范围）与已安装官方包的符合性。
 *
 * 为什么必须有：DSH 在插件安装与 profile 启动时按该字段决定是否拒绝加载，缺省才回退到
 * `@deepseek-ai/dsh*` 的 peer 范围合取。声明一旦与实际问题不符，用户拿到的是安装拒绝
 * 或静默的错配运行。
 * @param range - `package.json` 的 `engines.dsh`；未声明时返回空数组（由 peer 范围兜底）。
 * @param installedVersions - 官方 dsh 包名到实际安装版本的映射。
 * @returns 逐条问题描述；空数组表示通过。
 */
export function enginesDshProblems(range, installedVersions) {
  if (range === undefined) return []
  const problems = []
  if (typeof range !== 'string' || !semver.validRange(range)) {
    problems.push(`engines.dsh 不是合法 SemVer 范围：${JSON.stringify(range)}`)
    return problems
  }
  for (const [name, version] of Object.entries(installedVersions)) {
    if (!peerRangeAccepts(range, version)) problems.push(`engines.dsh ${range} 不接受 ${name} 的安装版本 ${version}`)
  }
  const minimum = semver.minVersion(range)
  if (minimum === null || semver.lt(minimum, DSH_BASELINE)) {
    problems.push(`engines.dsh 的下限不得低于已验证的宿主基线 ${DSH_BASELINE}`)
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
  const add = (specifier, typeOnly, hostCapability = false) => {
    if (typeof specifier !== 'string' || specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) return
    edges.push({ name: packageNameOf(specifier), specifier, typeOnly, ...(hostCapability ? { hostCapability: true } : {}) })
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
      || (ts.isIdentifier(node.expression) && ['require', 'importHostPackage', 'importHostCapability'].includes(node.expression.text)))) {
      const argument = node.arguments[0]
      const hostCapability = ts.isIdentifier(node.expression) && node.expression.text === 'importHostCapability'
      if (argument && ts.isStringLiteralLike(argument)) add(argument.text, false, hostCapability)
      else if (argument && ts.isIdentifier(argument)) add(constants.get(argument.text), false, hostCapability)
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
  if (edge.hostCapability && !client && !typeOnly) return HOST_CAPABILITY_PACKAGES.includes(name) ? []
    : [`${specifier}: 未登记的可选宿主能力；不能绕过依赖声明`]
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
