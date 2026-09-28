// verify-host-contracts.mjs — 官方发布包基线验证。
//
// 用法:node scripts/verify-host-contracts.mjs
//
// 报告每个直接官方依赖的声明范围、实际安装版本、解析目标，并在下列任一情况下失败：
//   1. 声明的官方包未安装，或安装版本不满足声明范围；
//   2. 安装版本与锁文件不一致，或声明丢失最低宿主版本；
//   3. 解析目标落在仓库 node_modules 之外（典型为 ../deepseek-harness 源码 link）；
//   4. src/engine 的类型、Client 值或 Host 值导入不符合各自依赖契约；
//   5. `dsh.client.inject` 声明的包没有对应的开发依赖。
//
// 只读：不写盘、不安装、不触碰当前运行中的 DSH。
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import {
  OFFICIAL_SCOPE,
  dependencyVersionProblems,
  isRepoLocalResolution,
  moduleImportEdges,
  importContractProblems,
} from './host-contracts-lib.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const lockedImporter = parse(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')).importers?.['.'] ?? {}

const failures = []
const rows = []

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
  return { dir, version, realPath: realpathSync(dir) }
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
      : lockedImporter[section]?.[name]
    const problems = dependencyVersionProblems(name, section, installed.version, manifest, locked)
    if (locked === undefined) problems.push('锁文件缺少直接依赖记录')
    if (!isRepoLocalResolution(installed.realPath, root)) {
      problems.push(`解析目标在仓库 node_modules 之外（${installed.realPath}）`)
    }
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
