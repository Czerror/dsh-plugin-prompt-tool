import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolatedHome } from '../fixtures/host-harness.mjs'
import { registerSoulLedgerTools } from '../../src/runtime/soul-ledger-tools.ts'
import { appendModuleLine } from '../../src/host/module-files.ts'
import { resolveModuleToolTarget } from '../../src/host/module-tool-target.ts'
import { readSoulLedgerProjection } from '../../src/host/soul-ledger.ts'
import { installModulePackage, moduleImportPreview } from '../../src/host/module-package.ts'
import { renderSoulSelf } from '../../src/host/soul-self.ts'

const { moduleRoot } = isolatedHome('pt-soul-ledger-')
function fixture(t, id) {
  const dir = join(moduleRoot, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'module.yml'), `id: ${id}\nmodules: []\nrules: []\n`)
  const tools = new Map()
  let preExecute
  const off = registerSoulLedgerTools({ inject: (_deps, callback) => ({ dispose: callback({ on: (_name, handler) => { preExecute = handler; return () => {} }, tools: { register: tool => {
    tools.set(tool.name, tool)
    return () => tools.delete(tool.name)
  } } }) }) }, { target: (exec, moduleId) => resolveModuleToolTarget(exec, moduleRoot, () => [], moduleId) })
  t.after(off)
  const call = (args, by = 'session-lead', signal = new AbortController().signal) => tools.get('soul_ledger').execute({ moduleId: id, ...args }, { agent: { session: { id: by } }, signal })
  return { dir, call, gate: (...args) => preExecute(...args) }
}

test('账本稳定引用区分重复旧行，读取只读且首次写前固定历史分界', async t => {
  const { dir, call } = fixture(t, 'ledger-references')
  mkdirSync(join(dir, 'data'))
  const file = join(dir, 'data', '02-soul.jsonl')
  const old = '{"t":"2026-01-01","by":"legacy","type":"shelved","text":"OLD"}\n'
  writeFileSync(file, old + old)
  const before = readSoulLedgerProjection(dir)
  assert.equal(before.initialized, false)
  assert.equal(before.pendingReview, 2)
  assert.equal(before.open, 0)
  assert.notEqual(before.entries[0].id, before.entries[1].id)
  assert.equal(existsSync(join(dir, 'data', '.soul-ledger-v2.json')), false)
  await call({ action: 'append', type: 'shelved', text: 'NEW' })
  const after = readSoulLedgerProjection(dir)
  assert.equal(after.initialized, true)
  assert.equal(after.pendingReview, 2)
  assert.equal(after.open, 1)
  assert.deepEqual(after.entries.slice(0, 2).map(row => row.id), before.entries.map(row => row.id))
  assert.equal(readFileSync(file, 'utf8').startsWith(old + old), true)
  assert.deepEqual(readSoulLedgerProjection(dir), after)
  const other = fixture(t, 'ledger-other-module')
  mkdirSync(join(other.dir, 'data'))
  writeFileSync(join(other.dir, 'data/02-soul.jsonl'), readFileSync(file))
  writeFileSync(join(other.dir, 'data/.soul-ledger-v2.json'), readFileSync(join(dir, 'data/.soul-ledger-v2.json')))
  await assert.rejects(other.call({ action: 'close', targetId: before.entries[0].id, outcome: 'completed', reason: 'CROSS MODULE' }, 'legacy'), /引用/)
})

test('账本收口只追加完成或取消，按当前主导授权且同结果幂等', async t => {
  const { dir, call } = fixture(t, 'ledger-close')
  await call({ action: 'append', type: 'lead', text: 'LEAD', ref: 'USER' })
  await call({ action: 'append', type: 'promise', text: 'PROMISE' })
  await call({ action: 'append', type: 'shelved', text: 'SHELVED' }, 'worker')
  const [promise, shelved] = readSoulLedgerProjection(dir).items
  const file = join(dir, 'data', '02-soul.jsonl')
  const old = readFileSync(file, 'utf8')
  await assert.rejects(call({ action: 'close', targetId: promise.id, outcome: 'completed', reason: 'DONE' }, 'worker'), /主导/)
  await assert.rejects(call({ action: 'close', targetId: shelved.id, outcome: 'cancelled', reason: 'NO LONGER NEEDED' }, 'other'), /作者|主导/)
  const closed = await call({ action: 'close', targetId: promise.id, outcome: 'completed', reason: 'DONE', ref: 'test:evidence' })
  assert.equal(closed.entry.type, 'close')
  assert.equal(closed.entry.by, 'session-lead')
  assert.equal(closed.entry.targetId, promise.id)
  assert.equal(closed.entry.outcome, 'completed')
  assert.equal(closed.entry.ref, 'test:evidence')
  assert.equal(readSoulLedgerProjection(dir).open, 1)
  const once = readFileSync(file, 'utf8')
  assert.deepEqual(await call({ action: 'close', targetId: promise.id, outcome: 'completed', reason: 'SECOND' }), closed)
  assert.equal(readFileSync(file, 'utf8'), once)
  await assert.rejects(call({ action: 'close', targetId: promise.id, outcome: 'cancelled', reason: 'CHANGED' }), /已收口/)
  await assert.rejects(call({ action: 'close', targetId: 'forged', outcome: 'completed', reason: 'FAKE' }), /引用/)
  await assert.rejects(call({ action: 'append', type: 'close', text: 'BYPASS' }), /类型|type/)
  await call({ action: 'close', targetId: shelved.id, outcome: 'cancelled', reason: 'STOP' }, 'worker')
  assert.equal(readSoulLedgerProjection(dir).open, 0)
  assert.equal(readFileSync(file, 'utf8').startsWith(old), true)
  await call({ action: 'append', type: 'lead', text: 'HANDOFF', ref: 'USER' }, 'new-lead')
  await assert.rejects(call({ action: 'close', targetId: promise.id, outcome: 'completed', reason: 'RETRY' }), /主导/)
})

test('账本分页绑定内容版本与视图，旧游标失效且普通fact不改变待办版本', async t => {
  const { dir, call } = fixture(t, 'ledger-pages')
  for (let index = 0; index < 5; index++) await call({ action: 'append', type: 'shelved', text: `ITEM ${index}` })
  const first = await call({ action: 'list', view: 'pending', limit: 2 })
  assert.equal(first.total, 5)
  assert.deepEqual(first.entries.map(row => row['概要']), ['ITEM 0', 'ITEM 1'])
  assert.ok(first.nextCursor)
  const second = await call({ action: 'list', view: 'pending', limit: 2, cursor: first.nextCursor })
  const last = await call({ action: 'list', view: 'pending', limit: 2, cursor: second.nextCursor })
  assert.deepEqual([...first.entries, ...second.entries, ...last.entries].map(row => row['概要']), ['ITEM 0', 'ITEM 1', 'ITEM 2', 'ITEM 3', 'ITEM 4'])
  assert.equal(last.nextCursor, undefined)
  await assert.rejects(call({ action: 'list', view: 'pending-review', limit: 2, cursor: first.nextCursor }), /游标/)
  const version = readSoulLedgerProjection(dir).pendingVersion
  await call({ action: 'append', type: 'fact', text: 'NOT A TASK' })
  assert.equal(readSoulLedgerProjection(dir).pendingVersion, version)
  await assert.rejects(call({ action: 'list', view: 'pending', limit: 2, cursor: first.nextCursor }), /游标/)
  assert.deepEqual((await call({ action: 'list', limit: 1 })).entries.map(row => row['概要']), ['NOT A TASK'])
})

test('正式导入复制私有数据后已收口引用保持，list和SELF及继续追加可用', async t => {
  const { dir, call } = fixture(t, 'ledger-import-stable')
  await call({ action: 'append', type: 'shelved', text: 'DONE' }, 'worker')
  const targetId = readSoulLedgerProjection(dir).items[0].id
  await call({ action: 'close', targetId, outcome: 'completed', reason: 'EVIDENCE' }, 'worker')
  writeFileSync(join(dir, 'data/SELF.src.md'), '# SELF')
  const before = readFileSync(join(dir, 'data/02-soul.jsonl'), 'utf8')
  const files = [{ path: 'module.yml', content: readFileSync(join(dir, 'module.yml'), 'utf8') }]
  const request = { targetId: 'ledger-import-stable', overwrite: true }
  const preview = moduleImportPreview(moduleRoot, files, request)
  await installModulePackage(moduleRoot, files, { ...request, expectedSourceDigest: preview.sourceDigest, expectedPreviewRevision: preview.previewRevision })
  assert.equal(readSoulLedgerProjection(dir).open, 0)
  assert.equal((await call({ action: 'list' })).total, 2)
  assert.match(renderSoulSelf(dir, { session: { id: 'worker', header: {} } }), /未结 0/)
  await call({ action: 'append', type: 'fact', text: 'AFTER IMPORT' })
  assert.equal(readFileSync(join(dir, 'data/02-soul.jsonl'), 'utf8').startsWith(before), true)
  assert.equal(readSoulLedgerProjection(dir).entries[0].id, targetId)
})

test('账本来源替换、伪造历史收口和历史分界写入失败均拒绝新变更', async t => {
  const { dir, call } = fixture(t, 'ledger-replacement')
  await call({ action: 'append', type: 'shelved', text: 'KEEP' }, 'worker')
  const original = readSoulLedgerProjection(dir).items[0].id
  const file = join(dir, 'data', '02-soul.jsonl')
  const replacement = join(dir, 'data', 'replacement.jsonl')
  writeFileSync(replacement, readFileSync(file, 'utf8').replace('KEEP', 'EDIT'))
  renameSync(replacement, file)
  await assert.rejects(call({ action: 'close', targetId: original, outcome: 'completed', reason: 'OLD REF' }, 'worker'), /引用/)
  const targetId = readSoulLedgerProjection(dir).items[0].id
  writeFileSync(file, readFileSync(file, 'utf8') + JSON.stringify({ t: '2026-01-02', by: 'intruder', type: 'close', '概要': 'FAKE', targetId, outcome: 'completed' }) + '\n')
  assert.throws(() => readSoulLedgerProjection(dir), /收口/)
  const blocked = fixture(t, 'ledger-metadata-failure')
  mkdirSync(join(blocked.dir, 'data'))
  const old = '{"t":"2026-01-01","by":"legacy","type":"shelved","text":"OLD"}\n'
  writeFileSync(join(blocked.dir, 'data', '02-soul.jsonl'), old)
  mkdirSync(join(blocked.dir, 'data', '.soul-ledger-v2.json'))
  await assert.rejects(blocked.call({ action: 'append', type: 'fact', text: 'NO' }), /普通文件/)
  assert.equal(readFileSync(join(blocked.dir, 'data', '02-soul.jsonl'), 'utf8'), old)
})

test('账本正式工具绑定真实身份，主导可承诺且兼容旧text与新概要，历史只追加', async t => {
  const { dir, call } = fixture(t, 'ledger-main')
  mkdirSync(join(dir, 'data'))
  const old = '{"t":"2026-01-01","by":"legacy","type":"fact","text":"OLD FACT"}\n'
  writeFileSync(join(dir, 'data', '02-soul.jsonl'), old)
  const fact = await call({ action: 'append', type: 'fact', text: 'NEW FACT', ref: 'file:source' }, 'worker')
  assert.equal(fact.entry.by, 'worker')
  assert.equal(fact.entry['概要'], 'NEW FACT')
  await assert.rejects(call({ action: 'append', type: 'promise', '概要': 'PROMISE' }, 'worker'), /主导/)
  await call({ action: 'append', type: 'lead', '概要': '用户指定接手', ref: '用户本轮指定' })
  await call({ action: 'append', type: 'promise', '概要': 'PROMISE' })
  const list = await call({ action: 'list', limit: 4 })
  assert.deepEqual(list.entries.map(row => row['概要']), ['OLD FACT', 'NEW FACT', '用户指定接手', 'PROMISE'])
  assert.equal(readFileSync(join(dir, 'data', '02-soul.jsonl'), 'utf8').startsWith(old), true)
  assert.equal(list.entries[0].text, 'OLD FACT', '旧行字段保持，只在读投影提供概要')
})

test('账本拒绝伪造、覆盖、通用追加旁路、非主导承诺及取消，lead经官方审批门', async t => {
  const { dir, call, gate } = fixture(t, 'ledger-guards')
  await call({ action: 'append', type: 'fact', '概要': 'KEEP' })
  const file = join(dir, 'data', '02-soul.jsonl')
  const before = readFileSync(file, 'utf8')
  for (const extra of [{ by: 'other' }, { t: '2000-01-01' }, { overwrite: true }]) {
    await assert.rejects(call({ action: 'append', type: 'fact', '概要': 'BAD', ...extra }), /未知字段|unexpected/)
  }
  for (const path of ['data/02-soul.jsonl', 'data/02-墨.jsonl', 'data/02-SOUL.jsonl']) assert.throws(() => appendModuleLine(dir, path, '{"type":"promise"}'), /账本/)
  await assert.rejects(call({ action: 'append', type: 'fact', '概要': 'BAD' }, ''), /真实会话/)
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(call({ action: 'append', type: 'fact', '概要': 'BAD' }, 'worker', abort.signal), /abort/i)
  assert.equal(readFileSync(file, 'utf8'), before)
  const exec = { name: 'soul_ledger', arguments: { action: 'append', type: 'lead' }, signal: new AbortController().signal }
  assert.equal((await gate(exec, async () => ({ kind: 'allow' }))).kind, 'ask')
  assert.deepEqual(await gate(exec, async () => ({ kind: 'deny', reason: 'DENIED' })), { kind: 'deny', reason: 'DENIED' })
  assert.equal((await gate({ ...exec, arguments: { action: 'list' } }, async () => ({ kind: 'allow' }))).kind, 'allow')
})

test('账本读取和写入有界，坏历史与链接失败不改盘，缺尾换行仍保留原文', async t => {
  const { dir, call } = fixture(t, 'ledger-bounds')
  mkdirSync(join(dir, 'data'))
  const file = join(dir, 'data', '02-soul.jsonl')
  const old = '{"t":"2026-01-01","by":"legacy","type":"fact","text":"NO FINAL NEWLINE"}'
  writeFileSync(file, old)
  await call({ action: 'append', type: 'fact', '概要': 'AFTER' })
  assert.equal(readFileSync(file, 'utf8').startsWith(old + '\n'), true)
  assert.deepEqual((await call({ action: 'list', limit: 1 })).entries.map(row => row['概要']), ['AFTER'])
  await assert.rejects(call({ action: 'list', limit: 101 }), /1–100/)
  await assert.rejects(call({ action: 'append', type: 'fact', '概要': 'x'.repeat(8193) }), /8 KiB/)
  writeFileSync(file, '{BAD JSON}\n')
  await assert.rejects(call({ action: 'append', type: 'fact', '概要': 'MUST NOT APPEND' }), /JSON/)
  assert.equal(readFileSync(file, 'utf8'), '{BAD JSON}\n')
  const linked = fixture(t, 'ledger-linked')
  symlinkSync(join(dir, 'data'), join(linked.dir, 'data'), 'junction')
  await assert.rejects(linked.call({ action: 'append', type: 'fact', '概要': 'MUST NOT APPEND' }), /链接|link/)
  assert.equal(readFileSync(file, 'utf8'), '{BAD JSON}\n')
})
