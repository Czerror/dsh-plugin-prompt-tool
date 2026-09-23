import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs, { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'
import { parseDocument } from 'yaml'

const sandbox = mkdtempSync(join(process.cwd(), 'pt-skills-content-'))
process.env.DSH_HOME = join(sandbox, 'home')
process.env.DSH_AGENTS_HOME = join(sandbox, 'agents')
process.env.DSH_BUNDLED_SKILL_DIR = join(sandbox, 'bundled')
const { createSkillsRuntime } = await import('../../src/host/skills-runtime.ts')
const { registerSettingsBridge } = await import('../../src/runtime/settings-bridge.ts')
const { BRIDGE_ENDPOINTS, SETTINGS_BRIDGE_PREFIX } = await import('../../src/shared/bridge-contract.ts')
const { MAX_SKILL_CONTENT_BYTES } = await import('../../src/shared/skills.ts')
after(() => rmSync(sandbox, { recursive: true, force: true }))

const original = '---\r\n# 保留注释\r\nname: demo\r\ndescription: 初始描述 # 行尾注释\r\nunknown: { keep: true }\r\nuser-invocable: yes\r\n---\r\n# 原始正文\r\n'
const body = '# 原始正文\r\n'
const updated = '# 编辑后的正文\r\n'
const description = '更新描述'
let sequence = 0

function marker(root, folder = 'demo', content = original) {
  const path = join(root, folder, 'SKILL.md')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

function harness(t) {
  const home = join(sandbox, `home-${++sequence}`)
  const ctx = new Context()
  const registry = new SkillRegistry(ctx)
  const effects = []
  const runtime = createSkillsRuntime({
    skills: registry, logger: ctx.logger, get: ctx.get.bind(ctx),
    effect(create) { const dispose = create(); effects.push(dispose); return dispose },
    on(...args) { const dispose = ctx.on(...args); effects.push(dispose); return dispose },
  }, { dshHome: home })
  t.after(async () => {
    for (const dispose of effects.reverse()) await dispose()
    await ctx.fiber.dispose()
  })
  const handlers = new Map()
  const cwd = join(home, 'project')
  const state = {
    skillsRoot: runtime.skillsRoot, get folders() { return runtime.folders },
    listSkills: runtime.listSkills, snapshot: runtime.snapshot, setSkillPolicy: runtime.setPolicy,
    readSkillContent: runtime.readContent, writeSkillContent: runtime.writeContent,
    deleteSkill: runtime.deleteSkill, patchSkillFolders: runtime.setFolders,
  }
  let changes = 0
  const services = {
    get: (name) => name === 'skills' ? registry : name === 'agents'
      ? { get: (id) => id === 'live' ? { session: { header: { cwd } } } : undefined } : undefined,
    settings: { describe: () => [], get: () => undefined, mutate: async () => {} },
    webServer: { register: ({ path, handler }) => { handlers.set(path, handler); return () => {} } },
    effect: (fn) => { const dispose = fn(); if (dispose) effects.push(dispose) },
  }
  registerSettingsBridge({ skills: registry, inject: (_deps, callback) => callback(services) }, 'prompt-tool',
    () => ({ available: true, providers: [] }), () => state, () => '', () => { changes++ })
  const post = async (endpoint, payload, overrides = {}) => {
    let status
    let body
    const handler = handlers.get(SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS[endpoint])
    assert.equal(typeof handler, 'function', `${endpoint} 必须注册`)
    await handler({
      method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(payload)) }, ...overrides,
    }, { writeHead(code) { status = code }, end(raw) { body = JSON.parse(raw) } })
    return { status, body }
  }
  return { runtime, home, cwd, post, get changes() { return changes } }
}

test('技能描述与正文分别读取保存，保留元数据注释；无变化不落盘', async (t) => {
  const h = harness(t)
  const path = marker(h.runtime.skillsRoot)
  assert.equal(h.runtime.listSkills().find((entry) => entry.path === path).canEdit, true)
  const read = h.runtime.readContent('demo', path)
  assert.equal(read.ok, true, read.message)
  assert.equal(read.content, body)
  assert.equal(read.description, '初始描述')
  assert.match(read.revision, /^[a-f0-9]{64}$/)
  const before = statSync(path).mtimeMs
  const unchanged = h.runtime.writeContent('demo', path, body, read.description, read.revision)
  assert.equal(unchanged.ok, true, unchanged.message)
  assert.equal(unchanged.changed, false)
  assert.equal(statSync(path).mtimeMs, before)
  const saved = h.runtime.writeContent('demo', path, updated, description, read.revision)
  assert.equal(saved.ok, true, saved.message)
  assert.equal(saved.changed, true)
  assert.notEqual(saved.revision, read.revision)
  assert.equal(saved.content, updated)
  assert.equal(saved.description, description)
  const raw = readFileSync(path, 'utf8')
  assert.ok(raw.endsWith(updated))
  assert.match(raw, /# 保留注释\r\n/)
  assert.match(raw, /# 行尾注释\r\n/)
  const header = parseDocument(/^---\r\n([\s\S]*?)\r\n---/.exec(raw)[1]).toJS()
  assert.deepEqual(header, { name: 'demo', description, unknown: { keep: true }, 'user-invocable': 'yes' })
  assert.deepEqual(readdirSync(dirname(path)), ['SKILL.md'])
  assert.equal(h.runtime.listSkills().find((entry) => entry.path === path).description, '更新描述')
})

test('只改正文时原头逐字保留，只改描述时正文逐字保留，正文中的 YAML 不变成元数据', (t) => {
  const h = harness(t)
  const path = marker(h.runtime.skillsRoot)
  const read = h.runtime.readContent('demo', path)
  const markdown = '---\nname: another\n---\n# 文档里的示例\n'
  const saved = h.runtime.writeContent('demo', path, markdown, read.description, read.revision)
  assert.equal(saved.ok, true, saved.message)
  assert.equal(readFileSync(path, 'utf8'), original.slice(0, -body.length) + markdown)
  const described = h.runtime.writeContent('demo', path, markdown, description, saved.revision)
  assert.equal(described.ok, true, described.message)
  assert.equal(h.runtime.readContent('demo', path).content, markdown)
  assert.ok(readFileSync(path, 'utf8').endsWith(markdown))
  assert.equal(h.runtime.listSkills().find((entry) => entry.path === path).name, 'demo')
  const external = readFileSync(path, 'utf8').replace('keep: true', 'keep: false')
  writeFileSync(path, external)
  const conflicted = h.runtime.writeContent('demo', path, markdown, '再次编辑', described.revision)
  assert.equal(conflicted.ok, false)
  assert.match(conflicted.message, /冲突/)
  assert.equal(readFileSync(path, 'utf8'), external, '只改元数据也必须使完整原文版本失效')
  const noNewline = '---\nname: demo\ndescription: D\n---'
  const empty = marker(h.runtime.skillsRoot, 'empty-body', noNewline)
  const emptyRead = h.runtime.readContent('demo', empty)
  assert.equal(emptyRead.content, '')
  assert.equal(h.runtime.writeContent('demo', empty, '正文', 'D', emptyRead.revision).ok, true)
  assert.equal(readFileSync(empty, 'utf8'), noNewline + '\n正文')
})

test('编辑正文不显示头部后的分隔空行，保存保留分隔及正文内部空行和缩进', (t) => {
  const h = harness(t)
  for (const [folder, newline] of [['lf', '\n'], ['crlf', '\r\n']]) {
    const head = ['---', 'name: demo', 'description: D', '---', '', ' \t', ''].join(newline)
    const markdown = ['    保留缩进', '', '正文', ''].join(newline)
    const path = marker(h.runtime.skillsRoot, folder, head + markdown)
    const read = h.runtime.readContent('demo', path)
    assert.equal(read.content, markdown)
    const unchanged = h.runtime.writeContent('demo', path, read.content, read.description, read.revision)
    assert.equal(unchanged.changed, false)
    assert.equal(readFileSync(path, 'utf8'), head + markdown)
    const saved = h.runtime.writeContent('demo', path, markdown + '结尾', 'New', read.revision)
    assert.equal(saved.ok, true, saved.message)
    assert.ok(readFileSync(path, 'utf8').endsWith(['---', '', ' \t', ''].join(newline) + markdown + '结尾'))
    assert.equal(h.runtime.readContent('demo', path).content, markdown + '结尾')
  }
})

test('缺少描述仍可修复，来源身份与内容冲突都先拒绝', (t) => {
  const h = harness(t)
  const path = marker(h.runtime.skillsRoot, 'demo', '---\nname: demo\n---\nBody')
  const entry = h.runtime.listSkills().find((skill) => skill.path === path)
  assert.equal(entry.valid, false)
  assert.equal(entry.canSetPolicy, false)
  assert.equal(entry.canEdit, true)
  const read = h.runtime.readContent('demo', path)
  assert.equal(read.ok, true, read.message)
  assert.equal(read.description, '')
  const saved = h.runtime.writeContent('demo', path, body, '初始描述', read.revision)
  assert.equal(saved.ok, true, saved.message)
  assert.equal(h.runtime.listSkills().find((skill) => skill.path === path).valid, true)
  const repaired = readFileSync(path, 'utf8')
  const stale = h.runtime.writeContent('demo', path, updated, description, read.revision)
  assert.equal(stale.ok, false)
  assert.match(stale.message, /冲突/)
  assert.equal(readFileSync(path, 'utf8'), repaired)
  assert.equal(h.runtime.readContent('other', path).ok, false)
  assert.equal(h.runtime.writeContent('other', path, updated, description, saved.revision).ok, false)
  const outside = marker(join(h.home, 'outside'))
  assert.equal(h.runtime.readContent('demo', outside).ok, false)
  assert.equal(h.runtime.writeContent('demo', outside, updated, description, saved.revision).ok, false)
  assert.equal(readFileSync(outside, 'utf8'), original)
})

test('修复描述保留原文有效名称，不把清单回退目录名当成改名基准；坏策略明确拒绝', (t) => {
  const h = harness(t)
  for (const [folder, source] of [
    ['legacy-folder', '---\nname: actual-skill\n---\nBody'],
    ['policy-folder', '---\nname: actual-skill\ndescription: Demo\nuser-invocable: invalid\n---\nBody'],
  ]) {
    const path = marker(h.runtime.skillsRoot, folder, source)
    const entry = h.runtime.listSkills().find((skill) => skill.path === path)
    assert.equal(entry.name, folder)
    const read = h.runtime.readContent(entry.name, path)
    if (folder === 'policy-folder') {
      assert.equal(read.ok, false)
      assert.match(read.message, /boolean/)
      assert.equal(readFileSync(path, 'utf8'), source)
      continue
    }
    assert.equal(read.ok, true, read.message)
    const saved = h.runtime.writeContent(entry.name, path, read.content, 'Repaired', read.revision)
    assert.equal(saved.ok, true, saved.message)
    const repaired = '---\nname: actual-skill\ndescription: Repaired\n---\nBody'
    assert.equal(readFileSync(path, 'utf8'), repaired)
    assert.equal(h.runtime.listSkills().find((skill) => skill.path === path).name, 'actual-skill')
    assert.equal(h.runtime.readContent('actual-skill', path).content, 'Body')
  }
})

test('缺失或损坏 YAML、无效名称、策略与别名拒绝读取和写入，不盲目重建元数据', (t) => {
  const h = harness(t)
  for (const source of [
    '# 无 frontmatter', '---\n[demo]\n---\n正文', '---\nname: [\n---\n正文',
    '---\nname: demo\ndescription: &d 描述\nunknown: *d\n---\n正文',
    original.replace('name: demo', 'name: invalid_name'),
    original.replace('user-invocable: yes', 'user-invocable: invalid'),
    original.replace('user-invocable: yes', 'userInvocable: true'),
  ]) {
    const path = marker(h.runtime.skillsRoot, 'demo', source)
    assert.equal(h.runtime.readContent('demo', path).ok, false, source)
    const saved = h.runtime.writeContent('demo', path, updated, description, 'a'.repeat(64))
    assert.equal(saved.ok, false)
    assert.equal(readFileSync(path, 'utf8'), source)
    assert.deepEqual(readdirSync(dirname(path)), ['SKILL.md'])
  }
})

test('描述类型、空值与长度和整个技能文件大小都在写盘前校验', (t) => {
  const h = harness(t)
  const path = marker(h.runtime.skillsRoot)
  const read = h.runtime.readContent('demo', path)
  for (const [content, desc] of [[body, ''], [body, 42], [body, ' '.repeat(8193)], [42, description],
    ['中'.repeat(MAX_SKILL_CONTENT_BYTES / 2), description], ['a'.repeat(MAX_SKILL_CONTENT_BYTES), description]]) {
    assert.equal(h.runtime.writeContent('demo', path, content, desc, read.revision).ok, false)
    assert.equal(readFileSync(path, 'utf8'), original)
    assert.deepEqual(readdirSync(dirname(path)), ['SKILL.md'])
  }
})

test('当前引用白名单、官方目录、只读文件和链接限制均由服务端重新判断', (t) => {
  const h = harness(t)
  const reference = join(h.home, 'reference')
  const path = marker(reference)
  h.runtime.setFolders([reference])
  const read = h.runtime.readContent('demo', path)
  assert.equal(read.ok, true, read.message)
  h.runtime.setFolders([])
  assert.equal(h.runtime.readContent('demo', path).ok, false)
  assert.equal(h.runtime.writeContent('demo', path, updated, description, read.revision).ok, false)
  const bundled = marker(process.env.DSH_BUNDLED_SKILL_DIR, `bundled-${sequence}`)
  assert.equal(h.runtime.readContent('demo', bundled).ok, true)
  assert.equal(h.runtime.writeContent('demo', bundled, updated, description, read.revision).ok, false)
  const local = marker(h.runtime.skillsRoot)
  chmodSync(local, 0o444)
  try {
    assert.equal(h.runtime.listSkills().find((entry) => entry.path === local).canEdit, false)
    assert.equal(h.runtime.readContent('demo', local).ok, true)
    assert.equal(h.runtime.writeContent('demo', local, updated, description, read.revision).ok, false)
  } finally { chmodSync(local, 0o666) }
  const linkedRoot = join(h.home, 'linked-root')
  symlinkSync(reference, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir')
  h.runtime.setFolders([linkedRoot])
  const linked = join(linkedRoot, 'demo', 'SKILL.md')
  assert.equal(h.runtime.listSkills().find((entry) => entry.path === linked).canEdit, false)
  assert.equal(h.runtime.readContent('demo', linked).ok, false)
  assert.equal(h.runtime.writeContent('demo', linked, updated, description, read.revision).ok, false)
  assert.equal(readFileSync(path, 'utf8'), original)
  const systemRoot = join(h.home, '.system', 'skills')
  const system = marker(systemRoot)
  h.runtime.setFolders([systemRoot])
  assert.equal(h.runtime.listSkills().find((entry) => entry.path === system).canEdit, false)
  assert.equal(h.runtime.writeContent('demo', system, updated, description, read.revision).ok, false)
  const oversized = marker(h.runtime.skillsRoot, 'oversized', original + '中'.repeat(MAX_SKILL_CONTENT_BYTES / 2))
  assert.equal(h.runtime.readContent('demo', oversized).ok, false)
  assert.equal(h.runtime.writeContent('demo', oversized, updated, description, read.revision).ok, false)
})

test('二次核对发现外部修改时保留新原文并清理暂存；读取失败不返回空文本', (t) => {
  const h = harness(t)
  const path = marker(h.runtime.skillsRoot)
  const read = h.runtime.readContent('demo', path)
  const newer = original.replace('原始正文', '外部修改')
  const originalWrite = fs.writeFileSync
  t.mock.method(fs, 'writeFileSync', (target, ...args) => {
    const result = originalWrite(target, ...args)
    if (String(target).includes('.SKILL.md.tmp-')) originalWrite(path, newer)
    return result
  })
  syncBuiltinESMExports()
  try {
    const saved = h.runtime.writeContent('demo', path, updated, description, read.revision)
    assert.equal(saved.ok, false)
    assert.match(saved.message, /冲突/)
    assert.equal(readFileSync(path, 'utf8'), newer)
    assert.deepEqual(readdirSync(dirname(path)), ['SKILL.md'])
  } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
  const originalRead = fs.readFileSync
  t.mock.method(fs, 'readFileSync', (target, ...args) => {
    if (target === path) throw new Error('读取失败测试')
    return originalRead(target, ...args)
  })
  syncBuiltinESMExports()
  try {
    assert.equal(h.runtime.readContent('demo', path).ok, false)
    assert.equal(h.runtime.writeContent('demo', path, updated, description, read.revision).ok, false)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
  assert.equal(readFileSync(path, 'utf8'), newer)
})

test('真实 bridge 统一读写载荷、会话 cwd、输入验证与 loopback 守卫', async (t) => {
  const h = harness(t)
  const path = marker(join(h.cwd, '.dsh', 'skills'))
  const identity = { name: 'demo', path, sessionId: 'live' }
  const list = await h.post('skillsList', { sessionId: 'live' })
  assert.equal(list.body.value.skills.some((entry) => entry.path === path && entry.canEdit), true)
  const missingSession = await h.post('skillRead', { name: 'demo', path })
  assert.equal(missingSession.status, 409)
  const read = await h.post('skillRead', identity)
  assert.equal(read.status, 200, read.body.message)
  assert.equal(read.body.ok, true)
  assert.equal(read.body.value.content, body)
  assert.equal(read.body.value.description, '初始描述')
  assert.deepEqual(Object.keys(read.body.value).sort(), ['content', 'description', 'revision'])
  const saved = await h.post('skillWrite', { ...identity, content: updated, description, expectedRevision: read.body.value.revision })
  assert.equal(saved.status, 200, saved.body.message)
  assert.equal(saved.body.ok, true)
  assert.equal(saved.body.value.content, updated)
  assert.equal(saved.body.value.description, description)
  assert.equal(h.changes, 1)
  const conflict = await h.post('skillWrite', { ...identity, content: body, description, expectedRevision: read.body.value.revision })
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body.ok, false)
  assert.equal(typeof conflict.body.code, 'string')
  assert.equal(typeof conflict.body.message, 'string')
  for (const body of [null, {}, { ...identity, sessionId: 42 }, { ...identity, path: [] }, { ...identity, name: '' }]) {
    assert.equal((await h.post('skillRead', body)).status, 400)
  }
  for (const body of [identity, { ...identity, content: 42, description, expectedRevision: 'a'.repeat(64) },
    { ...identity, content: updated, description, expectedRevision: 'wrong' },
    { ...identity, content: updated, expectedRevision: 'a'.repeat(64) },
    { ...identity, content: updated, description: 42, expectedRevision: 'a'.repeat(64) },
    { ...identity, content: updated, description: '', expectedRevision: 'a'.repeat(64) },
    { ...identity, content: '中'.repeat(MAX_SKILL_CONTENT_BYTES / 2), description, expectedRevision: 'a'.repeat(64) }]) {
    assert.equal((await h.post('skillWrite', body)).status, 400)
  }
  assert.equal((await h.post('skillRead', identity, { method: 'GET' })).status, 405)
  assert.equal((await h.post('skillWrite', identity, { headers: { host: 'localhost', origin: 'https://example.com' } })).status, 403)
  assert.equal(h.runtime.readContent('demo', path, h.cwd).content, updated)
  assert.equal(h.changes, 1)
})
