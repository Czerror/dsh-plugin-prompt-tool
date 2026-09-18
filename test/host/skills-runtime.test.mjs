import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import { createScope } from '@deepseek-ai/dsh-scope'

const sandbox = mkdtempSync(join(process.cwd(), 'pt-skills-runtime-'))
process.env.DSH_HOME = join(sandbox, 'home')
process.env.DSH_AGENTS_HOME = join(sandbox, 'agents')
process.env.DSH_BUNDLED_SKILL_DIR = join(sandbox, 'bundled')
const { createSkillsRuntime } = await import('../../src/host/skills-runtime.ts')
const { skillsStatePath, writeSkillsState } = await import('../../src/host/skills-config.ts')
after(() => rmSync(sandbox, { recursive: true, force: true }))

function write(root, name, flat = false) {
  const path = flat ? join(root, `${name}.md`) : join(root, name, 'SKILL.md')
  mkdirSync(flat ? root : join(root, name), { recursive: true })
  writeFileSync(path, `---\nname: ${name}\ndescription: ${name}\n---\nbody\n`)
  return path
}

function rig(label) {
  const ctx = new Context()
  const registry = new SkillRegistry(ctx)
  const effects = []
  const warnings = []
  const home = join(sandbox, label)
  const runtime = createSkillsRuntime({ skills: registry, get: ctx.get.bind(ctx),
    logger: { warn: (message) => warnings.push(message) },
    effect: (start) => { const close = start(); effects.push(close); return close },
    on: (...args) => { const close = ctx.on(...args); effects.push(close); return close },
  }, { dshHome: home })
  return { ctx, registry, runtime, home, warnings, close: async () => { for (const close of effects.reverse()) await close() } }
}

test('运行时同步保存并串行替换引用 provider，坏状态保留有效配置、删除重置，关闭释放全部监听', async () => {
  const h = rig('state')
  const first = join(sandbox, 'first')
  const second = join(sandbox, 'second')
  write(first, 'first-skill')
  write(second, 'second-skill')
  let changes = 0
  const stop = h.ctx.on('skills/change', () => { changes++ })
  try {
    assert.equal(h.runtime.setFolders([first]).ok, true)
    assert.equal(h.runtime.setFolders([second]).ok, true)
    assert.deepEqual((await h.runtime.snapshot()).skills.map((entry) => entry.name), ['second-skill'])
    writeFileSync(skillsStatePath(h.home), 'version: 4\nfolders: [broken\n')
    assert.deepEqual((await h.runtime.snapshot()).skills.map((entry) => entry.name), ['second-skill'])
    await h.runtime.snapshot()
    assert.equal(h.warnings.filter((message) => message.includes('保留上一次有效状态')).length, 1)
    writeFileSync(skillsStatePath(h.home), 'version: 4\nfolders: []\n')
    assert.deepEqual((await h.runtime.snapshot()).skills, [])
    h.runtime.setFolders([first])
    await h.runtime.snapshot()
    rmSync(skillsStatePath(h.home))
    assert.deepEqual((await h.runtime.snapshot()).skills, [])
    h.runtime.setFolders([second])
    await h.runtime.snapshot()
    await h.close()
    const before = changes
    write(second, 'after-close')
    writeSkillsState({ folders: [first] }, skillsStatePath(h.home))
    await delay(350)
    assert.equal(changes, before)
    assert.deepEqual(await h.registry.list(), [])
  } finally { await h.close(); stop() }
})

test('同 cwd 的主/子 scope 由真实 registry 决定胜出，未注册、虚拟与不完整快照分别呈现', async () => {
  const h = rig('scope')
  const globalRoot = join(sandbox, 'global-root')
  const scopedRoot = join(sandbox, 'scoped-root')
  const globalPath = write(globalRoot, 'shared')
  const scopedPath = write(scopedRoot, 'shared')
  write(join(h.home, 'skills'), 'unregistered')
  const parentKey = {}
  const childKey = {}
  const parent = createScope(h.ctx, parentKey)
  const child = createScope(h.ctx, childKey, { parent: parentKey })
  let provider
  parent.ctx.skills.registerProvider((control) => {
    provider = new FileSystemSkillProvider(parent.ctx, control, { providerName: 'session-files', includeDefaultRoots: false, customSkillDirs: [scopedRoot], watch: false })
    return provider
  })
  let stopFailure
  try {
    h.runtime.setFolders([globalRoot])
    const global = await h.runtime.snapshot({ cwd: sandbox })
    assert.equal(global.skills.find((entry) => entry.path === globalPath).availability, 'active')
    assert.equal(global.skills.find((entry) => entry.name === 'unregistered').availability, 'unregistered')
    for (const scope of [parentKey, childKey]) {
      const snapshot = await h.runtime.snapshot({ cwd: sandbox, scope })
      assert.equal(snapshot.skills.find((entry) => entry.path === globalPath).availability, 'shadowed')
      const active = snapshot.skills.find((entry) => entry.path === scopedPath)
      assert.deepEqual([active.availability, active.provider, active.canSetPolicy], ['active', 'session-files', false])
    }
    stopFailure = h.registry.registerProvider(() => ({ name: 'incomplete', list: async () => ({ complete: false, candidates: [
      { name: 'virtual', description: 'virtual', invocation: { modelInvocable: true, userInvocable: true }, source: 'runtime', provider: 'incomplete', rank: 500, locator: 'virtual' },
    ] }), get: async () => undefined }))
    const incomplete = await h.runtime.snapshot({ cwd: sandbox, scope: childKey })
    assert.equal(incomplete.complete, false)
    assert.ok(incomplete.skills.every((entry) => entry.availability === 'unknown'))
    assert.deepEqual([incomplete.skills.find((entry) => entry.name === 'virtual').source, incomplete.skills.find((entry) => entry.name === 'virtual').canDelete], ['other', false])
  } finally {
    stopFailure?.()
    await child.dispose()
    await parent.dispose()
    await provider.dispose()
    await h.close()
  }
})

test('官方 flat 可操作、链接仅由 registry 补充为只读；edit/write 观测同步失效当前 provider', async () => {
  const h = rig('flat')
  const root = join(sandbox, 'flat-root')
  const flat = write(root, 'flat-skill', true)
  const outside = join(sandbox, 'linked-target')
  write(outside, 'linked-skill')
  symlinkSync(join(outside, 'linked-skill'), join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  try {
    h.runtime.setFolders([root])
    const snapshot = await h.runtime.snapshot()
    const flatEntry = snapshot.skills.find((entry) => entry.name === 'flat-skill')
    const linked = snapshot.skills.find((entry) => entry.name === 'linked-skill')
    assert.deepEqual([flatEntry.canSetPolicy, flatEntry.canDelete], [true, true])
    assert.deepEqual([linked.availability, linked.canSetPolicy, linked.canDelete], ['active', false, false])
    assert.equal(h.runtime.setPolicy('flat-skill', flat, { side: 'model', enabled: false }).ok, true)
    assert.equal((await h.registry.list()).find((entry) => entry.name === 'flat-skill').invocation.modelInvocable, false)
    const fresh = write(root, 'observed-write', true)
    h.ctx.emit('fs/observed', { displayPath: fresh }, { present: true }, { name: 'write' })
    assert.equal((await h.registry.list()).some((entry) => entry.name === 'observed-write'), true)
    assert.equal(h.runtime.deleteSkill('linked-skill', linked.path).ok, false)
    assert.equal(h.runtime.deleteSkill('flat-skill', flat).ok, true)
    assert.equal(existsSync(flat), false)
  } finally { await h.close() }
})

test('官方 watcher 启动失败保留可读取候选并向管理快照传播 complete=false', async () => {
  const { createRequire } = await import('node:module')
  const officialRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-skill-filesystem'))
  const chokidar = officialRequire('chokidar').default
  const original = chokidar.watch
  const h = rig('watch-failure')
  const root = join(sandbox, 'watch-failure-root')
  write(root, 'readable')
  chokidar.watch = () => {
    const watcher = new EventEmitter()
    watcher.close = async () => {}
    setImmediate(() => watcher.emit('error', new Error('test watcher failure')))
    return watcher
  }
  try {
    h.runtime.setFolders([root])
    const snapshot = await h.runtime.snapshot()
    assert.equal(snapshot.complete, false)
    assert.equal(snapshot.skills.find((entry) => entry.name === 'readable').availability, 'unknown')
    assert.equal((await h.registry.get('readable')).content, 'body')
  } finally { chokidar.watch = original; await h.close() }
})

test('技能视图回退：带 scope 的视图为空时改用全局视图，条目不再被判成未注册', async (t) => {
  // 复现故障现场：宿主 registry 带 scope 时只读该视图层，技能装在全局层时整表为空，
  // 空 resolved 会让 withSkillWinners 把每个条目判成 unregistered，技能页于是整页
  // 显示「当前会话未注册」。
  const h = rig('scope-fallback')
  const root = join(sandbox, 'scope-fallback-skills')
  const skillPath = write(root, 'fallback-skill')
  h.runtime.setFolders([root])

  const views = []
  t.mock.method(h.registry, 'snapshot', async (view = {}) => {
    views.push(view)
    return view.scope === undefined
      ? { skills: [{ name: 'fallback-skill', path: skillPath, provider: 'filesystem' }], complete: true }
      : { skills: [], complete: true }
  })

  const result = await h.runtime.snapshot({ cwd: root, scope: 'agent:test' })
  const entry = result.skills.find((item) => item.name === 'fallback-skill')
  assert.ok(entry, '本地扫描条目必须保留')
  assert.equal(entry.availability, 'active', '回退全局视图后应为 active')
  assert.equal(views.length, 2, '视图为空才追加一次全局查询')
  assert.equal(views[0].scope, 'agent:test', '首次查询带 scope')
  assert.equal(views[1].scope, undefined, '回退查询不得带 scope')
  await h.close()
})

test('注册表为空而本地有条目时不作否决：条目保留 unknown，不整页误报未注册', async (t) => {
  // 复现真实故障：插件这一层只有引用 provider，看不到宿主注册的官方 provider，
  // 注册表于是整体为空。此时「观测完整但没有条目」并不等于「技能都没注册」——
  // 参照实现 dsh-web 的 collectSkills 同样只把注册表当补充，不作否决。
  const h = rig('registry-silent')
  write(join(h.home, 'skills'), 'silent-registry-skill')
  // 打桩成「观测完整但一条都不报」，复现插件层的真实处境。
  t.mock.method(h.registry, 'snapshot', async () => ({ skills: [], complete: true }))
  const snapshot = await h.runtime.snapshot()
  const entry = snapshot.skills.find((item) => item.name === 'silent-registry-skill')
  assert.ok(entry, '本地扫描必须列出该技能')
  assert.equal(entry.availability, 'unknown', '注册表无信息时不得判成未注册')
  assert.equal(snapshot.complete, false, '注册表未提供信息时观测不算完整')
  await h.close()
})
