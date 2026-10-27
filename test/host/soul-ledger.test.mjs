import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolatedHome } from '../fixtures/host-harness.mjs'
import { registerSoulLedgerTools } from '../../src/runtime/soul-ledger-tools.ts'
import { appendModuleLine } from '../../src/host/module-files.ts'
import { resolveModuleToolTarget } from '../../src/host/module-tool-target.ts'

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
