// sync-harness-deps.mjs — 把官方包开发依赖钉到当前发布通道的最新版本。
//
// 用法:
//   node scripts/sync-harness-deps.mjs           # 改写 package.json 的 devDependencies，然后 pnpm install
//   node scripts/sync-harness-deps.mjs --check   # 只比对：落后退出 1，registry 不可达退出 2
//
// 为什么需要它:官方按通道发布预发布版(`alpha` tag, vendor 包用 `dsh-<版本>` tag),
// 而 semver 的普通范围语法匹配不到预发布版——实测 `>=0.2.0-rc.1` 覆盖 0.2.0-rc.1/rc.2
// 却**不**覆盖 0.2.1-alpha.1,也没有任何范围写法能同时覆盖 rc 线与 alpha 线。于是
// devDependencies 会静默停在旧世代,typecheck 也就一直对着旧类型面跑。本脚本从
// registry 的 dist-tags 解析目标版本,写成确切版本号,并可用 --check 检测漂移。
//
// 只动 devDependencies 里的官方包:
//   - peerDependencies 的 `>=` 下限不改——宿主用 includePrerelease 判定,
//     该下限覆盖后续所有版本(含 0.3/1.0 的预发布),改窄反而伤兼容;
//   - dependencies 里的 @deepseek-ai/schemastery 是随包发布的运行时依赖,走稳定通道。
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import semver from 'semver'

const root = fileURLToPath(new URL('..', import.meta.url))
const manifestPath = join(root, 'package.json')
const checkOnly = process.argv.includes('--check')
const OFFICIAL_SCOPE = '@deepseek-ai/'

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const devDependencies = manifest.devDependencies ?? {}
const names = Object.keys(devDependencies).filter(name => name.startsWith(OFFICIAL_SCOPE)).sort()
if (names.length === 0) {
  console.error('sync-harness-deps: package.json 的 devDependencies 里没有官方包')
  process.exit(2)
}

/** 读一个包的所有发布通道标签;registry 不可达时抛错。 */
async function distTags(name) {
  const url = `https://registry.npmjs.org/${name.replace('/', '%2F')}`
  const response = await fetch(url, { headers: { accept: 'application/vnd.npm.install-v1+json' } })
  if (response.status === 404) throw new Error(`官方已不再发布 ${name},请从 devDependencies 移除`)
  if (!response.ok) throw new Error(`registry 查询 ${name} 失败: HTTP ${response.status}`)
  return (await response.json())['dist-tags'] ?? {}
}

/** 目标版本 = alpha 通道、vendor 的 dsh-<版本> 通道与 latest 里最高的那个。 */
function targetVersion(tags) {
  const candidates = [
    tags.alpha,
    ...Object.entries(tags).filter(([tag]) => tag.startsWith('dsh-')).map(([, version]) => version),
    tags.latest,
  ].filter(version => typeof version === 'string' && semver.valid(version) !== null)
  if (candidates.length === 0) throw new Error('没有任何可解析的发布通道标签')
  return candidates.sort(semver.rcompare)[0]
}

const failures = []
const changes = []
let unreachable = false

for (const name of names) {
  const declared = devDependencies[name]
  let target
  try {
    target = targetVersion(await distTags(name))
  } catch (error) {
    const message = String(error?.message ?? error)
    failures.push(`${name}: ${message}`)
    if (message.startsWith('registry 查询')) unreachable = true
    continue
  }
  if (declared === target) continue
  const pinned = semver.valid(String(declared).replace(/^[^\d]*/u, ''))
  if (pinned !== null && semver.lt(target, pinned)) {
    failures.push(`${name}: registry 目标 ${target} 低于已声明 ${declared},拒绝降级`)
    continue
  }
  changes.push({ name, declared, target })
}

for (const { name, declared, target } of changes) console.log(`${checkOnly ? '落后' : '更新'} ${name}: ${declared} → ${target}`)
for (const failure of failures) console.error(`sync-harness-deps: ${failure}`)

if (failures.length > 0) process.exit(unreachable && changes.length === 0 ? 2 : 1)
if (changes.length === 0) {
  console.log(`官方开发依赖已是最新(${names.length} 个包)`)
  process.exit(0)
}
if (checkOnly) {
  console.error(`sync-harness-deps: ${changes.length} 个官方开发依赖落后,跑 pnpm sync:harness 跟进`)
  process.exit(1)
}

for (const { name, target } of changes) devDependencies[name] = target
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`已改写 package.json 的 ${changes.length} 个官方开发依赖,开始 pnpm install`)

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const installed = spawnSync(pnpm, ['install'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
if (installed.status !== 0) {
  console.error('sync-harness-deps: pnpm install 失败,package.json 已改写但依赖未就位')
  process.exit(installed.status ?? 1)
}
// pnpm 增量安装会保留上一代的 .pnpm 目录,并把旧实例留在提升目录里。TypeScript 从
// .pnpm 内部解析时命中的就是那个旧实例,于是新版的 `declare module` 类型增强合并不上
// (实测表现为 ClientRemote 缺少 agentPresets 命名空间)。这里只报警不动盘:仓库
// node_modules 可能正被运行中的 DSH 使用。
const stale = []
for (const { name, target } of changes) {
  const hoisted = join(root, 'node_modules', '.pnpm', 'node_modules', ...name.split('/'), 'package.json')
  if (!existsSync(hoisted)) continue
  const version = JSON.parse(readFileSync(hoisted, 'utf8')).version
  if (version !== target) stale.push(`${name}: 提升目录仍是 ${version},目标 ${target}`)
}
if (stale.length > 0) {
  console.warn('sync-harness-deps: 检测到上一代实例残留在 node_modules/.pnpm 提升目录,官方类型的声明合并会失败。')
  console.warn('  先停掉正在使用本仓库的 DSH,再删 node_modules 后重跑 pnpm install:')
  for (const line of stale) console.warn(`  ${line}`)
}
console.log('依赖已同步,接着跑 pnpm verify:host 确认声明与安装版本一致')
