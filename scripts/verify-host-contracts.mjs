// verify-host-contracts.mjs — 官方发布包基线验证。
//
// 用法:node scripts/verify-host-contracts.mjs
//
// 报告每个直接官方依赖的声明范围、实际安装版本、解析目标，并在下列任一情况下失败：
//   1. 声明的官方包未安装，或安装版本不满足声明范围；
//   2. 安装版本与锁文件不一致，或声明丢失最低宿主版本；
//   3. 解析目标落在仓库 node_modules 之外（典型为 ../deepseek-harness 源码 link）；
//   4. src/engine 的类型、Client 值或 Host 值导入不符合各自依赖契约；
//   5. `dsh.client.inject` 声明的包没有对应的开发依赖；
//   6. `engines.dsh` 不接受某个已安装官方 dsh 包的版本，或下限低于已验证的宿主基线。
//   7. 插件官方档位分组与已安装发布类型的键集合不一致。
//
// 只读：不写盘、不安装、不触碰当前运行中的 DSH。
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { parse } from 'yaml'
import {
  OFFICIAL_SCOPE,
  DSH_SOURCE_SHA,
  peerRangeAccepts,
  dependencyVersionProblems,
  enginesDshProblems,
  isRepoLocalResolution,
  moduleImportEdges,
  importContractProblems,
  officialOrderContractProblems,
} from './host-contracts-lib.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const lock = parse(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'))
const lockedImporter = lock.importers?.['.'] ?? {}
const source = JSON.parse(readFileSync(join(root, '.scratch/harness/source.json'), 'utf8'))

const failures = []
const rows = []
if (source.sha !== DSH_SOURCE_SHA) failures.push('固定源码 SHA 不匹配')
const integrity = bytes => `sha512-${createHash('sha512').update(bytes).digest('base64')}`
for (const [name, item] of Object.entries(source.packages)) {
  if (integrity(readFileSync(join(root, item.path))) !== item.integrity) failures.push(`${name}: tarball integrity 不匹配`)
  const records = Object.entries(lock.packages ?? {}).filter(([key]) => key.startsWith(`${name}@file:${item.path}`))
  for (const [, record] of records) {
    if (record.resolution?.integrity !== item.integrity) failures.push(`${name}: 锁文件 integrity 不匹配`)
  }
}
for (const [name, item] of Object.entries(source.patches)) {
  if (integrity(readFileSync(join(root, item.path))) !== item.integrity) failures.push(`${name}: 官方 patch integrity 不匹配`)
  const hash = createHash('sha256').update(readFileSync(join(root, item.path))).digest('hex')
  if (lock.patchedDependencies?.[name] !== hash) failures.push(`${name}: 锁文件未使用官方 patch`)
}

// 从根图逐包解析依赖与 peer，拒绝同号但落到另一棵树的实例。
const visited = new Set()
function verifyGraph(directory) {
  const actual = realpathSync(directory)
  if (visited.has(actual)) return
  visited.add(actual)
  const pkg = JSON.parse(readFileSync(join(actual, 'package.json'), 'utf8'))
  const input = source.packages[pkg.name]
  if (input && lock.packages?.[`${pkg.name}@file:${input.path}`]?.resolution?.integrity !== input.integrity) failures.push(`${pkg.name}: 缺少固定源码完整性记录`)
  if (input?.entry && createHash('sha256').update(readFileSync(join(actual, input.entry))).digest('hex') !== input.entryHash) failures.push(`${pkg.name}: 安装入口不等于固定源码构建入口`)
  const resolver = createRequire(join(actual, 'package.json'))
  for (const [name, range] of Object.entries({ ...pkg.dependencies, ...pkg.peerDependencies })) {
    if (!name.startsWith(OFFICIAL_SCOPE) && name !== '@earendil-works/pi-ai') continue
    let path
    try {
      path = (resolver.resolve.paths(name) ?? []).map(base => join(base, name)).find(base => existsSync(join(base, 'package.json')))
      if (!path) throw new Error('missing package')
    } catch {
      if (!pkg.peerDependenciesMeta?.[name]?.optional) failures.push(`${pkg.name}: 无法解析 ${name}`)
      continue
    }
    const dependency = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'))
    if (dependency.name !== name || !peerRangeAccepts(range, dependency.version)) failures.push(`${pkg.name}: ${name}@${dependency.version} 不满足 ${range}`)
    if (!isRepoLocalResolution(realpathSync(path), root)) failures.push(`${pkg.name}: ${name} 不在根安装图`)
    const expected = source.packages[name]
    if (expected && dependency.version !== expected.version) failures.push(`${pkg.name}: ${name} 未命中固定源码版本`)
    if (name === '@earendil-works/pi-ai' && dependency.version !== '1.3.0') failures.push('PI 必须为官方实际 1.3.0')
    if (expected) {
      const records = Object.entries(lock.packages ?? {}).filter(([key]) => key === `${name}@file:${expected.path}`)
      if (records.length !== 1 || records[0][1].resolution?.integrity !== expected.integrity) failures.push(`${name}: 缺少唯一源码锁定记录`)
      verifyGraph(path)
    }
  }
}

function installedPackage(name) {
  const dir = join(root, 'node_modules', ...name.split('/'))
  const file = join(dir, 'package.json')
  if (!existsSync(file)) return undefined
  let version
  try {
    version = JSON.parse(readFileSync(file, 'utf8')).version
  } catch (error) {
    failures.push(`${name}: package.json 无法解析（${String(error?.message ?? error)}）`)
    return undefined
  }
  return { dir, version, name: JSON.parse(readFileSync(file, 'utf8')).name, realPath: realpathSync(dir) }
}

function shortTarget(target) {
  const relativeTarget = relative(root, target)
  return relativeTarget.startsWith('..') ? target : relativeTarget
}

for (const section of ['peerDependencies', 'devDependencies', 'dependencies']) {
  for (const [name, range] of Object.entries(manifest[section] ?? {})) {
    if (!name.startsWith(OFFICIAL_SCOPE)) continue
    const installed = installedPackage(name)
    if (installed === undefined) {
      failures.push(`${section}.${name}: 未安装（node_modules/${name} 缺失）`)
      rows.push({ name, section, range, version: '—', target: '未解析', status: '缺少安装' })
      continue
    }

    const locked = section === 'peerDependencies'
      ? lockedImporter.devDependencies?.[name] ?? lockedImporter.dependencies?.[name]
      : lockedImporter[section]?.[name] ?? lockedImporter.dependencies?.[name]
    const sourcePackage = source.packages[name]
    const problems = dependencyVersionProblems(name, section, installed.version, manifest, locked, sourcePackage)
    if (installed.name !== name) problems.push(`安装包名不匹配：${installed.name}`)
    if (!sourcePackage) problems.push('固定源码产物缺少该官方包')
    if (locked === undefined) problems.push('锁文件缺少直接依赖记录')
    if (!isRepoLocalResolution(installed.realPath, root)) {
      problems.push(`解析目标在仓库 node_modules 之外（${installed.realPath}）`)
    }
    verifyGraph(installed.dir)
    if (problems.length > 0) failures.push(`${section}.${name}: ${problems.join('；')}`)
    rows.push({
      name,
      section,
      range,
      version: installed.version,
      target: shortTarget(installed.realPath),
      status: problems.length > 0 ? 'FAIL' : 'ok',
    })
  }
}

// rg 遵守忽略规则；AST 区分纯类型、运行时 import 和引擎 importHostPackage。
const sourceFiles = execFileSync('rg', [
  '--files', '--max-depth', '8', '-g', '!node_modules', '-g', '!lib', '-g', '!dist',
  join(root, 'src'), join(root, 'engine'),
], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/).filter((file) => /\.(?:[cm]?[jt]s|tsx)$/.test(file))
for (const file of sourceFiles) {
  const local = relative(root, file).replaceAll('\\', '/')
  for (const edge of moduleImportEdges(readFileSync(file, 'utf8'), file)) {
    for (const problem of importContractProblems(edge, local.startsWith('src/client/'), manifest)) {
      failures.push(`${local}: ${problem}`)
    }
  }
}

// 包名边仍参与 factory 到达；开发依赖提供发布类型，服务等待由 Cordis inject 负责。
for (const name of manifest.dsh?.client?.inject ?? []) {
  if (manifest.devDependencies?.[name] === undefined) {
    failures.push(`dsh.client.inject: ${name} 缺少 devDependencies 声明`)
  }
}
for (const specifier of manifest.dsh?.client?.external ?? []) {
  if (specifier.startsWith(`${OFFICIAL_SCOPE}dsh-`)) {
    failures.push(`dsh.client.external: 禁止把 Harness 功能包 ${specifier} 作为运行时模块请求`)
  }
}

// engines.dsh 是安装与 profile 启动的拒绝依据；声明必须覆盖实际安装的全部官方 dsh 包。
const dshVersions = {}
for (const [name] of Object.entries(manifest.devDependencies ?? {})) {
  if (!name.startsWith(`${OFFICIAL_SCOPE}dsh-`)) continue
  const installed = installedPackage(name)
  if (installed !== undefined) dshVersions[name] = installed.version
}
for (const problem of enginesDshProblems(manifest.engines?.dsh, dshVersions)) {
  failures.push(`engines.dsh: ${problem}`)
}

// 以已安装发布类型为真值，不读取同版本号的源码 checkout，也不执行宿主运行时。
const promptPackage = installedPackage('@deepseek-ai/dsh-system-prompt')
if (promptPackage !== undefined) {
  try {
    const promptManifest = JSON.parse(readFileSync(join(promptPackage.dir, 'package.json'), 'utf8'))
    const typesFile = promptManifest.types
    if (typeof typesFile !== 'string') throw new Error('发布包缺少 types 入口')
    const officialSource = readFileSync(join(promptPackage.dir, typesFile), 'utf8')
    const pluginSource = readFileSync(join(root, 'src/shared/official-orders.ts'), 'utf8')
    for (const problem of officialOrderContractProblems(officialSource, pluginSource)) {
      failures.push(`official-orders: ${problem}`)
    }
    console.log(`官方档位来源：@deepseek-ai/dsh-system-prompt@${promptPackage.version} ${shortTarget(realpathSync(join(promptPackage.dir, typesFile)))}`)
  } catch (error) {
    failures.push(`official-orders: 无法验证发布类型（${String(error?.message ?? error)}）`)
  }
}

const width = (values) => values.reduce((max, value) => Math.max(max, value.length), 0)
const columns = ['包', '声明', '范围', '安装版本', '解析目标', '状态']
const nameWidth = width([columns[0], ...rows.map((row) => row.name)])
const sectionWidth = width([columns[1], ...rows.map((row) => row.section)])
const rangeWidth = width([columns[2], ...rows.map((row) => row.range)])
const versionWidth = width([columns[3], ...rows.map((row) => row.version)])
const targetWidth = width([columns[4], ...rows.map((row) => row.target)])
console.log(
  [columns[0].padEnd(nameWidth), columns[1].padEnd(sectionWidth), columns[2].padEnd(rangeWidth), columns[3].padEnd(versionWidth), columns[4].padEnd(targetWidth), columns[5]].join('  '),
)
for (const row of rows) {
  console.log(
    [row.name.padEnd(nameWidth), row.section.padEnd(sectionWidth), row.range.padEnd(rangeWidth), row.version.padEnd(versionWidth), row.target.padEnd(targetWidth), row.status].join('  '),
  )
}
console.log(`\n检查官方包 ${rows.length} 个；失败 ${failures.length} 项。`)
for (const failure of failures) console.error(`- ${failure}`)
if (failures.length > 0) process.exitCode = 1
