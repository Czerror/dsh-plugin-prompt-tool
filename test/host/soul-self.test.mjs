import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import fs, { mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { isolatedHome } from '../fixtures/host-harness.mjs'
import { readSoulSelfSnapshot, refreshSoulSelf, renderSoulSelf } from '../../src/host/soul-self.ts'
import { createPromptConfigs } from '../../engine/schema.mjs'
import { SOUL_SELF_SERVICE } from '../../engine/service-names.mjs'

const { moduleRoot } = isolatedHome('pt-soul-self-')
const index = { state: 'ready', files: 3, sessions: 2, events: 7 }
function fixture(id) {
  const dir = join(moduleRoot, id)
  mkdirSync(join(dir, 'data'), { recursive: true })
  writeFileSync(join(dir, 'module.yml'), `id: ${id}\nmodules: []\nrules: []\n`)
  writeFileSync(join(dir, 'data', 'SELF.src.md'), '# SELF\n硬线：保护用户。\npassword=never-show-this\n')
  writeFileSync(join(dir, 'data', '02-soul.jsonl'), '{"t":"2026-01-01","by":"old-container","type":"promise","text":"OLD PROMISE"}\n')
  return dir
}

test('SELF写盘产物只含预算内骨架、账本与索引事实，真实模型策略动态呈现当前Agent身份', async () => {
  const dir = fixture('self-main')
  const result = refreshSoulSelf(dir, index, { expectedRevision: null })
  assert.equal(result.state, 'ready')
  const snapshot = readSoulSelfSnapshot(dir)
  assert.match(snapshot.content, /OLD PROMISE/)
  assert.match(snapshot.content, /3.*2.*7/)
  assert.doesNotMatch(snapshot.content, /never-show-this|old-container/)
  const service = { render: (_id, agent, signal) => renderSoulSelf(dir, agent, signal) }
  const [{ resolve }] = createPromptConfigs([{ id: 'self', strategy: 'placeholder', fill: 'soul-self', layer: 'runtime-context' }], { sourceModuleId: 'self-main' })
  const ctx = { get: name => name === SOUL_SELF_SERVICE ? service : undefined }
  const first = await resolve({ ctx, agent: { session: { id: 'session-A', header: { delegationDepth: 0 } } } })
  const second = await resolve({ ctx, agent: { session: { id: 'session-B', header: { delegationDepth: 1 } } } })
  assert.match(first.text, /session-A/)
  assert.doesNotMatch(first.text, /session-B/)
  assert.match(second.text, /session-B/)
  assert.doesNotMatch(second.text, /session-A/)
  assert.equal(readSoulSelfSnapshot(dir).revision, snapshot.revision, '动态身份不能改共享快照')
  assert.ok(Buffer.byteLength(first.text) <= 12288)
})

test('SELF快照CAS与准备失败保留旧版，超限、取消和缺失状态可观察', () => {
  const dir = fixture('self-cas')
  refreshSoulSelf(dir, index, { expectedRevision: null })
  const previous = readSoulSelfSnapshot(dir)
  assert.throws(() => refreshSoulSelf(dir, index, { expectedRevision: null }), /版本冲突/)
  assert.equal(readSoulSelfSnapshot(dir).content, previous.content)
  writeFileSync(join(dir, 'data', 'SELF.src.md'), 'A'.repeat(13000))
  assert.throws(() => refreshSoulSelf(dir, index, { expectedRevision: previous.revision }), /超预算/)
  assert.equal(readSoulSelfSnapshot(dir).content, previous.content)
  writeFileSync(join(dir, 'data', 'SELF.src.md'), '# CHANGED')
  const originalRename = fs.renameSync
  mock.method(fs, 'renameSync', (from, to) => { if (String(from).includes('.self-')) throw new Error('DISK FAILURE'); return originalRename(from, to) })
  syncBuiltinESMExports()
  try { assert.throws(() => refreshSoulSelf(dir, index, { expectedRevision: previous.revision }), /DISK FAILURE/) }
  finally { mock.restoreAll(); syncBuiltinESMExports() }
  assert.equal(readSoulSelfSnapshot(dir).content, previous.content)
  const abort = new AbortController()
  abort.abort()
  assert.throws(() => refreshSoulSelf(dir, index, { expectedRevision: previous.revision, signal: abort.signal }), /abort/i)
  assert.equal(readSoulSelfSnapshot(dir).content, previous.content)
  const missing = fixture('self-missing')
  assert.match(renderSoulSelf(missing, { session: { id: 'new-session' } }), /OLD PROMISE/)
})

test('SELF每步读取当前骨架与账本，缺失或陈旧诊断快照不阻断实时事实', t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-31T02:00:00Z') })
  const dir = fixture('self-current'), agent = { session: { id: 'current-session' } }
  const first = renderSoulSelf(dir, agent)
  assert.match(first, /2026-10-31T02:00:00.000Z/)
  assert.match(first, /待核对 1/)
  assert.match(first, /未建|unbuilt/)
  refreshSoulSelf(dir, index, { expectedRevision: null })
  const snapshot = readSoulSelfSnapshot(dir)
  const path = join(dir, 'data', 'SELF.src.md'), stamp = fs.statSync(path)
  writeFileSync(path, '# SELF\n硬线：尊重用户。\npassword=never-show-this\n')
  utimesSync(path, stamp.atime, stamp.mtime)
  t.mock.timers.tick(60000)
  const current = renderSoulSelf(dir, agent)
  assert.match(current, /尊重用户/)
  assert.doesNotMatch(current, /保护用户|never-show-this/)
  assert.match(current, /2026-10-31T02:01:00.000Z/)
  assert.equal(readSoulSelfSnapshot(dir).revision, snapshot.revision)
})

test('SELF读取期间同戳等长改写会重取，持续变化明确不可用而不发布旧候选', t => {
  const dir = fixture('self-racing'), sourcePath = join(dir, 'data', 'SELF.src.md')
  const original = fs.readFileSync
  let reads = 0
  const patch = t.mock.method(fs, 'readFileSync', (path, ...args) => {
    const result = original(path, ...args)
    if (String(path) === sourcePath && ++reads === 1) writeFileSync(sourcePath, '# SELF\n硬线：尊重用户。\npassword=never-show-this\n')
    return result
  })
  syncBuiltinESMExports()
  try {
    const text = renderSoulSelf(dir, { session: { id: 'race' } })
    assert.match(text, /尊重用户/)
    assert.doesNotMatch(text, /保护用户/)
  } finally { patch.mock.restore(); syncBuiltinESMExports() }
  const unstable = t.mock.method(fs, 'readFileSync', (path, ...args) => {
    const result = original(path, ...args)
    if (String(path) === sourcePath) writeFileSync(sourcePath, String(result).includes('尊重') ? '# SELF\n硬线：保护用户。' : '# SELF\n硬线：尊重用户。')
    return result
  })
  syncBuiltinESMExports()
  try {
    const text = renderSoulSelf(dir, { session: { id: 'race' } })
    assert.match(text, /unavailable/)
    assert.doesNotMatch(text, /当前权威事实/)
  } finally { unstable.mock.restore(); syncBuiltinESMExports() }
})

test('SELF降级报告来源时间与安全原因，旧无时间快照不冒充当前事实', t => {
  const dir = fixture('self-degraded'), agent = { session: { id: 'degraded' } }
  refreshSoulSelf(dir, index, { expectedRevision: null })
  writeFileSync(join(dir, 'data', '02-soul.jsonl'), '{SECRET BROKEN RAW')
  const text = renderSoulSelf(dir, agent)
  assert.match(text, /degraded/)
  assert.match(text, /来源时间：\d{4}-/)
  assert.match(text, /原因：账本或骨架数据不可读取/)
  assert.doesNotMatch(text, /SECRET BROKEN RAW/)
  writeFileSync(join(dir, 'data', '.soul', 'SELF.md'), '# OLD SNAPSHOT\n## 活体（当前权威事实）\n- 未结 99条')
  const legacy = renderSoulSelf(dir, agent)
  assert.match(legacy, /来源时间：unknown/)
  assert.doesNotMatch(legacy, /当前权威事实/)
  const original = fs.readFileSync
  const denied = t.mock.method(fs, 'readFileSync', (path, ...args) => {
    if (String(path) === join(dir, 'data', '02-soul.jsonl')) throw Object.assign(new Error('PRIVATE ACCESS'), { code: 'EACCES' })
    return original(path, ...args)
  })
  syncBuiltinESMExports()
  try { assert.throws(() => renderSoulSelf(dir, agent), /PRIVATE ACCESS/) }
  finally { denied.mock.restore(); syncBuiltinESMExports() }
})

test('SELF最低预算保留骨架和身份，长运行状态与事项按摘要有界呈现', () => {
  const dir = fixture('self-small'), source = '# SELF\n硬线：保护用户。'
  writeFileSync(join(dir, 'data', 'SELF.src.md'), source)
  const text = renderSoulSelf(dir, { session: { id: 'minimum-session' } }, undefined, 1024, undefined, ['- 显式状态：' + '中'.repeat(512)])
  assert.ok(Buffer.byteLength(text) <= 1024)
  assert.ok(text.includes(source))
  assert.match(text, /minimum-session/)
  assert.match(text, /摘要|未展示/)
})

test('SELF快照准备后来源改变时拒绝rename并保留旧诊断', t => {
  const dir = fixture('self-final-version'), sourcePath = join(dir, 'data', 'SELF.src.md')
  refreshSoulSelf(dir, index, { expectedRevision: null })
  const previous = readSoulSelfSnapshot(dir)
  const write = fs.writeFileSync
  const change = t.mock.method(fs, 'writeFileSync', (path, ...args) => {
    const result = write(path, ...args)
    if (String(path).replaceAll('\\', '/').includes('/.soul/.self-')) write(sourcePath, '# LATE CHANGE')
    return result
  })
  syncBuiltinESMExports()
  try { assert.throws(() => refreshSoulSelf(dir, index, { expectedRevision: previous.revision }), /来源版本冲突/) }
  finally { change.mock.restore(); syncBuiltinESMExports() }
  assert.equal(readSoulSelfSnapshot(dir).content, previous.content)
})
