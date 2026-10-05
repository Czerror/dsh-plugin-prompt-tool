// verify-package.mjs — 发版前打包完整性验证。
//
// 用法:pnpm verify:pack
//
// 常规 test 跑的是仓库源码，看不见 package.json#files 的漏配——漏掉一个目录要等装完才发现。
// 本脚本把包真的打出来验证，任一情况失败即退出码 1：
//   1. 必需目录（lib / engine / modules / skills / templates）或顶层文件缺失；
//   2. 解包后与仓库逐文件 SHA256 不一致，或文件数不等（内容漂移）；
//   3. tarball 装进临时项目后，包内引擎加载不了主入口、编译不了规则，或模块库与随包技能缺失。
//
// 写盘范围仅限系统临时目录，结束后清理；不触碰仓库与运行中的 DSH。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
/** 必须有内容的目录；缺一个就说明 package.json#files 漏配。 */
const REQUIRED_DIRS = ['lib', 'engine', 'modules', 'skills', 'templates']
const REQUIRED_FILES = ['cordis.patch.yml', 'package.json', 'README.md', 'LICENSE']

/** 在临时项目里跑：主入口可用 + 包内引擎真编译一条规则 + 模块库与技能随包。 */
const SMOKE = `import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const pluginRoot = 'node_modules/dsh-plugin-prompt-tool'
const plugin = await import('dsh-plugin-prompt-tool')
if (plugin.name !== 'prompt-tool' || typeof plugin.apply !== 'function') throw new Error('主入口导出不完整')
const { compileRules } = await import(pathToFileURL(join(pluginRoot, 'engine/rule-spec.mjs')).href)
const rules = [{ id: 'smoke', then: [{ id: 's', kind: 'inject-text', config: { layer: 'pre-step', strategy: 'static', text: 'hi' } }] }]
const compiled = compileRules(rules)
if (compiled.length !== 1 || compiled[0].actions.length !== 1) throw new Error('包内引擎编译规则失败')
const modules = readdirSync(join(pluginRoot, 'engine/compositions/source/local')).filter((name) => name.endsWith('.yml'))
if (!modules.includes('rule-engine.yml')) throw new Error('组合模块库缺少 rule-engine')
if (!existsSync(join(pluginRoot, 'skills/dsh-module/SKILL.md'))) throw new Error('随包技能缺失')
console.log('smoke: 主入口 + 包内引擎编译 + 组合模块库 + 随包技能 均通过')
`

const failures = []
const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const listFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name)
  return entry.isDirectory() ? listFiles(path) : [path]
})
/**
 * npm / pnpm 在 Windows 上是 .cmd，Node 拒绝直接 execFile，因此经 shell 执行；
 * 命令拼成**单个字符串**（不传 args 数组）——带 args 数组的 shell 调用已弃用（DEP0190）。
 * 参数全部是本脚本控制的常量路径，无外部输入。
 */
const quote = (value) => `"${value}"`
const run = (command, options = {}) => execFileSync(command, { stdio: 'pipe', windowsHide: true, shell: true, ...options })

const work = mkdtempSync(join(tmpdir(), 'dsh-verify-pack-'))
try {
  const packDir = join(work, 'pack')
  mkdirSync(packDir)
  run(`npm pack --pack-destination ${quote(packDir)}`, { cwd: root })
  const tarball = readdirSync(packDir).find((name) => name.endsWith('.tgz'))
  if (tarball === undefined) throw new Error('npm pack 没有产出 tarball')

  const unpacked = join(work, 'unpacked')
  mkdirSync(unpacked)
  run(`tar -xzf ${quote(join(packDir, tarball))} -C ${quote(unpacked)}`)
  const pkg = join(unpacked, 'package')

  for (const name of REQUIRED_DIRS) {
    const packed = join(pkg, name)
    if (!statSync(packed, { throwIfNoEntry: false })?.isDirectory()) {
      failures.push(`包内缺少目录 ${name}/`)
      continue
    }
    const repoFiles = listFiles(join(root, name))
    const packedCount = listFiles(packed).length
    if (repoFiles.length !== packedCount) failures.push(`${name}/: 文件数 ${packedCount} ≠ 仓库 ${repoFiles.length}`)
    for (const file of repoFiles) {
      const local = relative(root, file)
      const target = join(pkg, local)
      if (!statSync(target, { throwIfNoEntry: false })?.isFile()) {
        failures.push(`包内缺少 ${local}`)
        continue
      }
      if (digest(file) !== digest(target)) failures.push(`内容不一致 ${local}`)
    }
  }
  for (const name of REQUIRED_FILES) {
    if (!statSync(join(pkg, name), { throwIfNoEntry: false })?.isFile()) failures.push(`包内缺少 ${name}`)
  }

  const project = join(work, 'project')
  mkdirSync(project)
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'verify-pack', private: true, type: 'module' }))
  run(`pnpm add ${quote(join(packDir, tarball))}`, { cwd: project })
  writeFileSync(join(project, 'smoke.mjs'), SMOKE)
  process.stdout.write(run(`${quote(process.execPath)} smoke.mjs`, { cwd: project, encoding: 'utf8' }))
} catch (error) {
  failures.push(String(error?.message ?? error))
} finally {
  rmSync(work, { recursive: true, force: true })
}

console.log(`打包完整性：必需目录 ${REQUIRED_DIRS.length} 个、顶层文件 ${REQUIRED_FILES.length} 个；失败 ${failures.length} 项。`)
for (const failure of failures) console.error(`- ${failure}`)
if (failures.length > 0) process.exitCode = 1
