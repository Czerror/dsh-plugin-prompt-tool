// verify-host-contracts.mjs — 官方发布包基线验证。
//
// 用法:node scripts/verify-host-contracts.mjs
//
// 报告每个直接官方依赖的声明范围、实际安装版本、解析目标，并在下列任一情况下失败：
//   1. 声明的官方包未安装，或安装版本不满足声明范围；
//   2. 官方 dev 依赖不是精确 semver，DSH 包偏离 devDependencies 中 dsh-agent 的
//      已选发布版本，或 Cordis 偏离自身显式选择；
//   3. 解析目标落在仓库 node_modules 之外（典型为 ../deepseek-harness 源码 link）；
//   4. 源码里出现未在 package.json 声明的官方包 import；
//   5. `dsh.client.inject` 声明的包没有对应的 peer 声明。
//
// 只读：不写盘、不安装、不触碰当前运行中的 DSH。
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  OFFICIAL_SCOPE,
  dependencyVersionProblems,
  isRepoLocalResolution,
  officialImports,
} from './host-contracts-lib.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

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

    const problems = dependencyVersionProblems(name, section, installed.version, manifest)
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

// 源码消费面：出现官方包 import 却没有声明，说明依赖边缺失。
const declared = new Set([
  ...Object.keys(manifest.peerDependencies ?? {}),
  ...Object.keys(manifest.devDependencies ?? {}),
  ...Object.keys(manifest.dependencies ?? {}),
])
function sourceFiles(dir) {
  const files = []
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    if (item.isDirectory()) files.push(...sourceFiles(join(dir, item.name)))
    else if (/\.(?:ts|tsx|mts)$/.test(item.name)) files.push(join(dir, item.name))
  }
  return files
}
for (const file of sourceFiles(join(root, 'src'))) {
  for (const name of officialImports(readFileSync(file, 'utf8'))) {
    if (declared.has(name)) continue
    failures.push(`${relative(root, file)}: 使用 ${name} 但 package.json 未声明该官方包`)
  }
}

// client 装配面：inject 的每个包都必须是 peer（宿主提供），不能是插件私有依赖。
for (const name of manifest.dsh?.client?.inject ?? []) {
  if (manifest.peerDependencies?.[name] === undefined) {
    failures.push(`dsh.client.inject: ${name} 缺少 peerDependencies 声明`)
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
