import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, existsSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolatedHome } from '../fixtures/host-harness.mjs'
import { createSoulMaintenanceProvider } from '../../src/runtime/soul-maintenance.ts'

const { moduleRoot } = isolatedHome('pt-soul-maintenance-')
function setup(id) {
  const dir = join(moduleRoot, id)
  mkdirSync(join(dir, 'data'), { recursive: true })
  writeFileSync(join(dir, 'module.yml'), `id: ${id}\nmodules: []\nrules: []\n`)
  writeFileSync(join(dir, 'data', 'SELF.src.md'), '# SELF\n维护自己的书房。')
  let wakes = 0
  const activity = new AbortController()
  const agent = { session: { id: id + '-agent', header: { delegationDepth: 0 } }, runMaintenance: task => task(activity.signal), followup: message => { assert.ok(message.content[0].text.length); wakes++ } }
  return { agent, sourceModuleId: id, sourceModuleDir: dir, wakes: () => wakes, cancel: () => activity.abort() }
}

test('同模块心跳只有一个串行owner，默认维护索引与SELF不唤醒，重挂不重复任务', async t => {
  const f = setup('maintain-main')
  let reads = 0, resolve
  const provider = createSoulMaintenanceProvider({ refreshRetrieval: async (_agent, _id, signal) => {
    reads++
    await new Promise(done => { resolve = done })
    signal.throwIfAborted()
    return { state: 'ready', files: 2, sessions: 1, events: 4 }
  } })
  t.after(() => provider.dispose())
  const a = provider.mount({}, { enabled: true, intervalMs: 60000, wake: false, audience: 'all', budgetBytes: 12288 }, f)
  const b = provider.mount({}, { enabled: true, intervalMs: 60000, wake: false, audience: 'all', budgetBytes: 12288 }, { ...f, agent: { ...f.agent, session: { ...f.agent.session, id: 'second-agent' } } })
  const pending = provider.tick(f.sourceModuleId)
  await Promise.resolve()
  assert.equal(reads, 1)
  resolve()
  await pending
  assert.equal(provider.status(f.sourceModuleId).state, 'ready')
  assert.match(readFileSync(join(f.sourceModuleDir, 'data', '.soul', 'SELF.md'), 'utf8'), /文件 2/)
  assert.equal(f.wakes(), 0)
  a()
  assert.equal(provider.status(f.sourceModuleId).state, 'ready')
  b()
  assert.equal(provider.status(f.sourceModuleId).state, 'disabled')
})

test('心跳读取失败可诊断且可恢复，失败不锁死后续维护或覆盖旧SELF', async t => {
  const f = setup('maintain-failure')
  const snapshot = join(f.sourceModuleDir, 'data', '.soul', 'SELF.md')
  mkdirSync(snapshot, { recursive: true })
  let reads = 0
  const provider = createSoulMaintenanceProvider({ refreshRetrieval: async () => { reads++; return { state: 'ready', files: 1 } } })
  t.after(() => provider.dispose())
  assert.throws(() => provider.mount({}, { enabled: true, intervalMs: 2 ** 31, wake: false, audience: 'all', budgetBytes: 12288 }, f), /间隔/)
  provider.mount({}, { enabled: true, intervalMs: 60000, wake: false, audience: 'all', budgetBytes: 12288 }, f)
  await provider.tick(f.sourceModuleId)
  assert.equal(provider.status(f.sourceModuleId).state, 'failed')
  rmdirSync(snapshot)
  writeFileSync(snapshot, 'OLD SELF')
  await provider.tick(f.sourceModuleId)
  assert.equal(reads, 1, '修复来源后必须重新执行维护')
  assert.equal(provider.status(f.sourceModuleId).state, 'ready')
  const previous = readFileSync(snapshot, 'utf8')
  writeFileSync(join(f.sourceModuleDir, 'data', 'SELF.src.md'), 'X'.repeat(13000))
  await provider.tick(f.sourceModuleId)
  assert.equal(provider.status(f.sourceModuleId).state, 'failed')
  assert.equal(readFileSync(snapshot, 'utf8'), previous)
})

test('心跳关闭后迟到索引结果不写SELF、不唤醒；显式唤醒独立于维护且受众生效', async t => {
  const f = setup('maintain-cancel')
  let done
  const provider = createSoulMaintenanceProvider({ refreshRetrieval: async () => { await new Promise(resolve => { done = resolve }); return { state: 'ready', files: 1 } } })
  t.after(() => provider.dispose())
  const config = { enabled: true, intervalMs: 60000, wake: true, audience: 'all', budgetBytes: 12288 }
  const off = provider.mount({}, config, f)
  const pending = provider.tick(f.sourceModuleId)
  await Promise.resolve()
  off()
  done()
  await pending
  assert.equal(existsSync(join(f.sourceModuleDir, 'data', '.soul', 'SELF.md')), false)
  assert.equal(f.wakes(), 0)
  const cancelled = setup('maintain-user-cancel')
  const cancelOff = provider.mount({}, config, cancelled)
  const cancelledPending = provider.tick(cancelled.sourceModuleId)
  await Promise.resolve()
  cancelled.cancel()
  done()
  await cancelledPending
  assert.equal(provider.status(cancelled.sourceModuleId).state, 'cancelled')
  assert.equal(existsSync(join(cancelled.sourceModuleDir, 'data', '.soul', 'SELF.md')), false)
  assert.equal(cancelled.wakes(), 0)
  cancelOff()
  const wake = createSoulMaintenanceProvider({ refreshRetrieval: async () => ({ state: 'ready', files: 1 }) })
  t.after(() => wake.dispose())
  const mismatch = wake.mount({}, { ...config, audience: 'subagent' }, f)
  await wake.tick(f.sourceModuleId)
  assert.equal(f.wakes(), 0)
  mismatch()
  wake.mount({}, config, f)
  await wake.tick(f.sourceModuleId)
  assert.equal(f.wakes(), 1)
  assert.equal(wake.status(f.sourceModuleId).state, 'ready')
})
