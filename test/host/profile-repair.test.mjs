import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import {
  classifyEntry,
  diagnoseProfile,
  dshResolvable,
  linkTargetsOf,
  listProfiles,
  repairProfiles,
  resolveDshHomeArg,
} from '../../scripts/repair-profile.mjs'

const WIN32 = process.platform === 'win32'
const tempRoots = []
test.after(() => { for (const root of tempRoots) rmSync(root, { recursive: true, force: true }) })

function makeHome() {
  const home = mkdtempSync(join(process.cwd(), 'pt-repair-'))
  tempRoots.push(home)
  const profileDir = join(home, 'profiles', 'web')
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  return { home, profileDir }
}

function writeManifest(profileDir, { bundles = [], dependencies = {} } = {}) {
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dsh: { profile: { bundles } },
    dependencies,
  }, null, 2))
}

/** 造一个最小可解析的包目录。 */
function makePackage(dir) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }))
  return dir
}

function makeLink(target, linkPath) {
  symlinkSync(target, linkPath, WIN32 ? 'junction' : undefined)
}

test('dshResolvable 与 dsh 同口径：命中私有层', () => {
  const { profileDir } = makeHome()
  writeManifest(profileDir, { bundles: ['fixture-pkg'] })
  const pkgDir = makePackage(join(profileDir, 'node_modules', 'fixture-pkg'))
  assert.equal(dshResolvable(join(profileDir, 'package.json'), 'fixture-pkg'), pkgDir)
  assert.equal(dshResolvable(join(profileDir, 'package.json'), 'absent-pkg'), undefined)
})

test('链接在但目标不存在：诊断为 broken-link 并被修复（本次故障的直接回归）', () => {
  const { home, profileDir } = makeHome()
  const realTarget = makePackage(join(home, 'repo', 'dsh-plugin-prompt-tool'))
  writeManifest(profileDir, {
    bundles: ['dsh-plugin-prompt-tool'],
    dependencies: { 'dsh-plugin-prompt-tool': `link:${realTarget}` },
  })
  const linkPath = join(profileDir, 'node_modules', 'dsh-plugin-prompt-tool')
  // 链接指向**别处**（随后该处被移走）→ 悬空；正确目标仍在，修复才有意义。
  const wrongTarget = makePackage(join(home, 'elsewhere', 'dsh-plugin-prompt-tool'))
  makeLink(wrongTarget, linkPath)
  rmSync(join(home, 'elsewhere'), { recursive: true, force: true })

  const before = classifyEntry(linkPath)
  assert.equal(before.kind, 'symlink')
  assert.equal(before.targetExists, false, '必须识别「链接在、目标不在」')
  const diagnosed = diagnoseProfile(home, 'web').entries.find((entry) => entry.name === 'dsh-plugin-prompt-tool')
  assert.equal(diagnosed.status, 'broken-link')
  assert.equal(diagnosed.fixable, true)

  const result = repairProfiles({ dshHome: home, profile: 'web', log: () => {} })
  assert.equal(result.failures, 0)
  assert.equal(result.changed, 1)
  assert.equal(dshResolvable(join(profileDir, 'package.json'), 'dsh-plugin-prompt-tool'), linkPath)
  assert.equal(classifyEntry(linkPath).targetExists, true, '修复后目标必须存在')
})

test('缺链接且 dependencies 声明 link: 时补建；dry-run 零写入', () => {
  const { home, profileDir } = makeHome()
  const realTarget = makePackage(join(home, 'repo', 'plugin-a'))
  writeManifest(profileDir, { bundles: ['plugin-a'], dependencies: { 'plugin-a': `link:${realTarget}` } })
  const linkPath = join(profileDir, 'node_modules', 'plugin-a')

  const dry = repairProfiles({ dshHome: home, profile: 'web', dryRun: true, log: () => {} })
  assert.equal(dry.changed, 1, 'dry-run 应报告将修复的项')
  assert.equal(classifyEntry(linkPath).kind, 'missing', 'dry-run 不得写入')

  const real = repairProfiles({ dshHome: home, profile: 'web', log: () => {} })
  assert.equal(real.changed, 1)
  assert.equal(dshResolvable(join(profileDir, 'package.json'), 'plugin-a'), linkPath)
})

test('link: 声明被真实条目占位：报告 blocked、绝不删除、计入需人工项', () => {
  const { home, profileDir } = makeHome()
  const target = makePackage(join(home, 'repo', 'plugin-b'))
  writeManifest(profileDir, { bundles: ['plugin-b'], dependencies: { 'plugin-b': `link:${target}` } })
  writeFileSync(join(profileDir, 'node_modules', 'plugin-b'), 'occupied')

  const blocked = diagnoseProfile(home, 'web').entries.find((entry) => entry.name === 'plugin-b')
  assert.equal(blocked.status, 'blocked')
  assert.equal(blocked.fixable, false)

  const result = repairProfiles({ dshHome: home, profile: 'web', log: () => {} })
  assert.equal(result.failures, 1, 'blocked 必须计入需人工项')
  assert.ok(readdirSync(join(profileDir, 'node_modules')).includes('plugin-b'), '真实条目不得被删除')
})

test('普通依赖的真实目录不算异常：可解析即 ok（pnpm 布局）', () => {
  const { home, profileDir } = makeHome()
  writeManifest(profileDir, { bundles: ['plain-dep'], dependencies: { 'plain-dep': '^1.0.0' } })
  makePackage(join(profileDir, 'node_modules', 'plain-dep'))
  const entry = diagnoseProfile(home, 'web').entries.find((item) => item.name === 'plain-dep')
  assert.equal(entry.status, 'ok')
  assert.equal(repairProfiles({ dshHome: home, profile: 'web', log: () => {} }).failures, 0)
})

test('健康项保持不动：二次运行 changed 为 0', () => {
  const { home, profileDir } = makeHome()
  const target = makePackage(join(home, 'repo', 'plugin-c'))
  writeManifest(profileDir, { bundles: ['plugin-c'], dependencies: { 'plugin-c': `link:${target}` } })
  makeLink(target, join(profileDir, 'node_modules', 'plugin-c'))
  const first = repairProfiles({ dshHome: home, profile: 'web', log: () => {} })
  assert.equal(first.changed, 0)
  assert.equal(first.failures, 0)
  const second = repairProfiles({ dshHome: home, profile: 'web', log: () => {} })
  assert.equal(second.changed, 0, '幂等：健康项不得被重写')
})

test('纯函数：linkTargetsOf 只认 link: 声明，listProfiles 只列含 manifest 的目录', () => {
  const profileDir = resolvePath('D:/home/profiles/web')
  const targets = linkTargetsOf({ dependencies: { a: 'link:/abs/a', b: '^1.0.0', c: 'link:./rel' } }, profileDir)
  assert.deepEqual([...targets.keys()].sort(), ['a', 'c'])
  assert.equal(targets.get('a'), resolvePath('D:/abs/a'))
  assert.equal(targets.get('c'), resolvePath(profileDir, 'rel'))

  const { home, profileDir: web } = makeHome()
  writeManifest(web)
  mkdirSync(join(home, 'profiles', 'empty-dir'), { recursive: true })
  assert.deepEqual(listProfiles(home), ['web'])
})

test('resolveDshHomeArg 优先级与官方 resolveDshHome 一致（自移除的 link-profile 迁入）', () => {
  // $DSH_HOME 命中
  assert.equal(resolveDshHomeArg([], { DSH_HOME: 'D:\\AI\\DeepSeek harness\\.dsh' }), 'D:\\AI\\DeepSeek harness\\.dsh')
  // --dsh-home 最高，且支持 ~ 展开
  assert.equal(resolveDshHomeArg(['--dsh-home', '~/x'], { DSH_HOME: '/other' }), join(homedir(), 'x'))
  // 空白 DSH_HOME 视为未设置 → ~/.dsh（不读 HOME）
  assert.equal(resolveDshHomeArg([], { DSH_HOME: '   ', HOME: 'Z:\\fake' }), join(homedir(), '.dsh'))
  // 无任何来源 → ~/.dsh
  assert.equal(resolveDshHomeArg([], {}), join(homedir(), '.dsh'))
})
