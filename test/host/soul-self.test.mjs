import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import fs, { mkdirSync, writeFileSync } from 'node:fs'
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
  assert.match(renderSoulSelf(missing, { session: { id: 'new-session' } }), /SELF missing/)
})
