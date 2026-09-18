import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'

const sandbox = mkdtempSync(join(tmpdir(), 'pt-skills-bridge-framework-'))
process.env.DSH_HOME = join(sandbox, 'home')
process.env.DSH_AGENTS_HOME = join(sandbox, 'agents')
process.env.DSH_BUNDLED_SKILL_DIR = join(sandbox, 'bundled')
const { createSkillsRuntime } = await import('../../src/host/skills-runtime.ts')
const { registerSettingsBridge } = await import('../../src/runtime/settings-bridge.ts')
const { readSkillInvocation } = await import('../../src/host/skills-policy.ts')
const { BRIDGE_ENDPOINTS, SETTINGS_BRIDGE_PREFIX } = await import('../../src/shared/bridge-contract.ts')
after(() => rmSync(sandbox, { recursive: true, force: true }))

function marker(root, folder, name = folder) {
  const path = join(root, folder, 'SKILL.md')
  mkdirSync(join(root, folder, 'references'), { recursive: true })
  writeFileSync(path, `---\nname: ${name}\ndescription: ${name}\n---\n# ${name}\n`)
  writeFileSync(join(root, folder, 'references', 'keep.txt'), `resource ${name}`)
  return path
}

function harness(home) {
  const ctx = new Context()
  const registry = new SkillRegistry(ctx)
  const effects = []
  const runtime = createSkillsRuntime({
    skills: registry, logger: ctx.logger, get: ctx.get.bind(ctx),
    effect(create) { const dispose = create(); effects.push(dispose); return dispose },
    on(...args) { const dispose = ctx.on(...args); effects.push(dispose); return dispose },
  }, { dshHome: home })
  const handlers = new Map()
  const state = {
    skillsRoot: runtime.skillsRoot,
    get folders() { return runtime.folders },
    listSkills: runtime.listSkills,
    snapshot: runtime.snapshot,
    setSkillPolicy: runtime.setPolicy,
    deleteSkill: runtime.deleteSkill,
    patchSkillFolders: runtime.setFolders,
  }
  const scoped = {
    get: (name) => name === 'skills' ? registry : undefined,
    settings: { describe: () => [], get: () => undefined, mutate: async () => {} },
    webServer: { register: ({ path, handler }) => { handlers.set(path, handler); return () => {} } },
    effect: (fn) => fn(),
  }
  registerSettingsBridge({ skills: registry, inject: (_deps, callback) => callback(scoped) }, 'prompt-tool',
    () => ({ available: true, providers: [] }), () => state, () => '', runtime.invalidate)
  const post = async (endpoint, payload = {}) => {
    let status
    let body
    await handlers.get(SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS[endpoint])({
      method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(payload)) },
    }, {
      writeHead(code) { status = code },
      end(raw) { body = JSON.parse(raw) },
    })
    return { status, body }
  }
  return { post, runtime, registry, close: async () => { for (const dispose of effects.reverse()) await dispose() } }
}

test('引用技能通过真实 handler 单端启停、按路径删除，同名用户技能与资源保留', async () => {
  const home = join(sandbox, 'operations-home')
  const userMarker = marker(join(home, 'skills'), 'same', 'same-name')
  const reference = join(sandbox, 'operations-reference')
  const referencedMarker = marker(reference, 'same', 'same-name')
  const userBefore = readFileSync(userMarker, 'utf8')
  const h = harness(home)
  try {
    assert.equal((await h.post('skillsFolders', { folders: [reference] })).status, 200)
    const list = await h.post('skillsList')
    assert.equal(list.body.value.complete, true)
    const entry = list.body.value.skills.find((skill) => skill.path === referencedMarker)
    assert.equal(entry.canSetPolicy, true)
    assert.equal(entry.canDelete, true)
    for (const side of ['model', 'user']) {
      const saved = await h.post('skillPolicy', { name: entry.name, path: entry.path, side, enabled: false })
      assert.equal(saved.status, 200, saved.body.message)
    }
    assert.deepEqual(readSkillInvocation(referencedMarker).invocation, { modelInvocable: false, userInvocable: false })
    assert.equal(readFileSync(userMarker, 'utf8'), userBefore)
    const restored = await h.post('skillPolicy', { name: entry.name, path: entry.path, side: 'model', enabled: true })
    assert.equal(restored.status, 200)
    assert.deepEqual(readSkillInvocation(referencedMarker).invocation, { modelInvocable: true, userInvocable: false })
    const rejected = await h.post('skillPolicy', { name: entry.name, path: entry.path, side: 'model', enabled: 'false' })
    assert.equal(rejected.status, 400)
    const removed = await h.post('skillDelete', { name: entry.name, path: entry.path })
    assert.equal(removed.status, 200, removed.body.message)
    assert.equal(existsSync(referencedMarker), false)
    assert.equal(readFileSync(join(removed.body.value.path, 'references', 'keep.txt'), 'utf8'), 'resource same-name')
    assert.equal(readFileSync(userMarker, 'utf8'), userBefore)
    assert.equal((await h.registry.list()).some((skill) => skill.path === referencedMarker), false)
  } finally { await h.close() }
})

test('删除与策略写入拒绝未引用、已移除及身份不匹配的目标', async () => {
  const home = join(sandbox, 'authorization-home')
  const reference = join(sandbox, 'authorization-reference')
  const path = marker(reference, 'demo')
  const before = readFileSync(path, 'utf8')
  const h = harness(home)
  try {
    for (const endpoint of ['skillDelete', 'skillPolicy']) {
      const response = await h.post(endpoint, { name: 'demo', path, side: 'model', enabled: false })
      assert.equal(response.body.ok, false)
    }
    assert.equal((await h.post('skillsFolders', { folders: [reference] })).status, 200)
    assert.equal((await h.post('skillDelete', { name: 'other', path })).body.ok, false)
    assert.equal((await h.post('skillDelete', { name: 'demo', path: join(reference, 'demo', '..', 'outside', 'SKILL.md') })).body.ok, false)
    assert.equal((await h.post('skillDelete', { folder: 'demo' })).status, 400)
    assert.equal((await h.post('skillDelete', { name: 'demo', path, sessionId: 42 })).status, 400)
    assert.equal((await h.post('skillsFolders', { folders: [] })).status, 200)
    assert.equal((await h.post('skillDelete', { name: 'demo', path })).body.ok, false)
    assert.equal((await h.post('skillPolicy', { name: 'demo', path, side: 'model', enabled: false })).body.ok, false)
    assert.equal(readFileSync(path, 'utf8'), before)
    assert.equal(readFileSync(join(reference, 'demo', 'references', 'keep.txt'), 'utf8'), 'resource demo')
    const empty = await h.post('skillsList')
    assert.equal(empty.body.value.complete, true)
    assert.deepEqual(empty.body.value.skills, [])
  } finally { await h.close() }
})

test('显式引用另一个工作区的用户技能根也允许管理其普通技能', async () => {
  const reference = join(sandbox, 'other-workspace', '.agents', 'skills')
  const path = marker(reference, 'explicit-reference')
  const h = harness(join(sandbox, 'explicit-home'))
  try {
    assert.equal((await h.post('skillsFolders', { folders: [reference] })).status, 200)
    const list = await h.post('skillsList')
    assert.equal(list.body.value.skills.find((skill) => skill.path === path).canDelete, true)
    const removed = await h.post('skillDelete', { name: 'explicit-reference', path })
    assert.equal(removed.status, 200, removed.body.message)
    assert.equal(existsSync(path), false)
  } finally { await h.close() }
})

test('注册表读取失败时 bridge 返回未确认资产，不让页面或已提交写入误报失败', async (t) => {
  const root = join(sandbox, 'snapshot-reference')
  const path = marker(root, 'readable')
  const h = harness(join(sandbox, 'snapshot-home'))
  try {
    await h.post('skillsFolders', { folders: [root] })
    t.mock.method(h.registry, 'snapshot', async () => { throw new Error('registry unavailable') })
    const list = await h.post('skillsList')
    assert.equal(list.status, 200)
    assert.equal(list.body.value.complete, false)
    assert.equal(list.body.value.skills.find((entry) => entry.path === path).availability, 'unknown')
    const saved = await h.post('skillPolicy', { name: 'readable', path, side: 'model', enabled: false })
    assert.equal(saved.status, 200)
    assert.equal(saved.body.value.complete, false)
    assert.equal(readSkillInvocation(path).invocation.modelInvocable, false)
  } finally { await h.close() }
})
