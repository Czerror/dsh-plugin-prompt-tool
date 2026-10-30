import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolatedHome } from '../fixtures/host-harness.mjs'
import { registerSoulStateTools } from '../../src/runtime/soul-state-tools.ts'
import { readSoulState } from '../../src/host/soul-state.ts'

const { moduleRoot } = isolatedHome('pt-soul-state-')
function fixture(t, id) {
  const dir = join(moduleRoot, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'module.yml'), `id: ${id}\nmodules: []\nrules: []\n`)
  const tools = new Map()
  const ctx = { inject: (_names, setup) => ({ dispose: setup({ tools: { register: tool => {
    tools.set(tool.name, tool); return () => tools.delete(tool.name)
  } } }) }) }
  const host = { target: (_exec, moduleId) => { if (moduleId !== id) throw new Error('模块未授权'); return { id, dir } } }
  const observe = { status: () => ({ state: 'observed' }), check: (_exec, _id, includeUpgrade) => ({ state: includeUpgrade ? 'upgrade-preview' : 'not-observed' }) }
  let off = registerSoulStateTools(ctx, host, observe)
  t.after(() => off())
  const call = (args, sessionId = 'session-a', signal = new AbortController().signal) => tools.get('soul_state').execute({ moduleId: id, ...args }, { agent: { session: { id: sessionId } }, signal })
  return { dir, call, tools, remount: () => { off(); assert.equal(tools.size, 0); off = registerSoulStateTools(ctx, host, observe) } }
}

test('soul_state以真实会话隔离mark，状态只读且重挂后保留显式标记', async t => {
  const f = fixture(t, 'state-flow')
  assert.deepEqual(await f.call({ action: 'status' }), { sessionId: 'session-a', mark: null, revision: null, observation: { state: 'observed' } })
  assert.equal(existsSync(join(f.dir, 'data')), false, '读取不能隐式初始化')
  const marked = await f.call({ action: 'mark', text: '正在核对账本', expectedRevision: null })
  assert.equal(marked.mark.text, '正在核对账本')
  assert.ok(Number.isFinite(Date.parse(marked.mark.recordedAt)))
  assert.equal(typeof marked.revision, 'string')
  assert.deepEqual((await f.call({ action: 'status' }, 'session-b')).mark, null)
  f.remount()
  assert.equal((await f.call({ action: 'status' })).mark.text, '正在核对账本')
  assert.deepEqual((await f.call({ action: 'check' })).observation, { state: 'not-observed' })
  assert.deepEqual((await f.call({ action: 'check', includeUpgrade: true })).observation, { state: 'upgrade-preview' })
  await assert.rejects(f.call({ action: 'status', includeUpgrade: true }), /只有check/)
})

test('soul_state拒绝伪造会话、旧版本和取消，重复同值不改版本或记录时间', async t => {
  const f = fixture(t, 'state-cas')
  const first = await f.call({ action: 'mark', text: '处理中', expectedRevision: null })
  const second = await f.call({ action: 'mark', text: '处理中', expectedRevision: first.revision })
  assert.deepEqual(second, first)
  await assert.rejects(f.call({ action: 'mark', text: '完成', expectedRevision: null }), /版本冲突/)
  await assert.rejects(f.call({ action: 'mark', text: '伪造', expectedRevision: first.revision, sessionId: 'session-b' }), /未知字段/)
  await assert.rejects(f.call({ action: 'mark', text: 'X'.repeat(513), expectedRevision: first.revision }), /上限|长度/)
  await assert.rejects(f.call({ action: 'mark', text: '取消', expectedRevision: first.revision }, 'session-a', AbortSignal.abort()), /abort/i)
  assert.deepEqual((await f.call({ action: 'status' })).mark, first.mark)
  writeFileSync(join(f.dir, 'module.yml'), 'id: [broken YAML\n')
  assert.deepEqual(readSoulState(f.dir, 'session-a').mark, first.mark, '只读状态允许已授权定义内容暂时损坏')
  await assert.rejects(f.call({ action: 'mark', text: '不能写', expectedRevision: first.revision }), /定义无效/)
})
