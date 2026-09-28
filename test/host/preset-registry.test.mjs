import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const sandbox = mkdtempSync(join(process.cwd(), 'pt-registry-home-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = sandbox
const { createPresetRegistrySync } = await import('../../src/host/preset-registry.ts')
after(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(sandbox, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(sandbox, 'presets-'))
  const records = new Map()
  const calls = []
  const registry = {
    register: async (definition) => {
      if (records.has(definition.id)) throw new Error('Duplicate agent preset')
      const broken = definition.plugins[0]?.name === 'broken-module' ? 'Cannot load broken-module' : undefined
      records.set(definition.id, { definition, broken })
      calls.push(['register', definition.id])
      return async () => { records.delete(definition.id); calls.push(['dispose', definition.id]) }
    },
    resolve: async (id) => ({ id, broken: records.get(id)?.broken }),
  }
  const sync = createPresetRegistrySync({ agentPresets: registry, logger: { warn() {} } }, root)
  const write = (name = 'valid-module', id = 'test') => {
    mkdirSync(join(root, id), { recursive: true })
    writeFileSync(join(root, id, 'preset.yml'), `id: ${id}\nname: Test\nmodules: []\n`)
    writeFileSync(join(root, id, 'agent.cordis.yml'), `- name: ${name}\n`)
  }
  return { root, records, calls, registry, sync, write, close: async () => { await sync.dispose(); rmSync(root, { recursive: true, force: true }) } }
}

test('注册刷新等待宿主结果，重复刷新不激活，更新及释放由声明所有者管理', async () => {
  const f = fixture()
  try {
    f.write()
    let release
    const register = f.registry.register
    f.registry.register = async (definition) => { await new Promise((resolve) => { release = resolve }); return register(definition) }
    let finished = false
    const pending = f.sync.refresh().then(() => { finished = true })
    await Promise.resolve()
    assert.equal(finished, false)
    release()
    await pending
    f.registry.register = register
    assert.equal(f.sync.owns('test'), true)
    await f.sync.refresh()
    assert.equal(f.calls.length, 1)
    f.write('updated-module')
    await f.sync.refresh()
    assert.equal(f.records.get('test').definition.plugins[0].name, 'updated-module')
    await f.sync.dispose()
    await f.sync.dispose()
    assert.equal(f.records.size, 0)
    assert.equal(f.sync.owns('test'), false)
  } finally { await f.close() }
})

test('损坏候选明确报错且保留可用旧注册，修复后可重试', async () => {
  const f = fixture()
  try {
    f.write()
    await f.sync.refresh()
    const original = f.records.get('test')
    f.write('broken-module')
    await assert.rejects(f.sync.refresh(), /Cannot load broken-module/)
    assert.equal(f.records.get('test'), original)
    assert.deepEqual([...f.records.keys()], ['test'])
    f.write('fixed-module')
    await f.sync.refresh()
    assert.equal(f.records.get('test').definition.plugins[0].name, 'fixed-module')
  } finally { await f.close() }
})

test('初次加载失败保留官方 broken 诊断，修复重试恢复可用', async () => {
  const f = fixture()
  try {
    f.write('broken-module')
    await assert.rejects(f.sync.refresh(), /Cannot load broken-module/)
    assert.equal((await f.registry.resolve('test')).broken, 'Cannot load broken-module')
    f.write('healthy-module', 'healthy')
    await f.sync.refresh(['healthy'])
    assert.equal(f.records.get('healthy').definition.plugins[0].name, 'healthy-module')
    assert.equal((await f.registry.resolve('test')).broken, 'Cannot load broken-module')
    await assert.rejects(f.sync.refresh(), /Cannot load broken-module/)
    f.write('fixed-module')
    f.write('updated-healthy-module', 'healthy')
    await f.sync.refresh(['test', 'healthy'])
    assert.equal((await f.registry.resolve('test')).broken, undefined)
    assert.equal(f.records.get('healthy').definition.plugins[0].name, 'updated-healthy-module')
    rmSync(join(f.root, 'healthy'), { recursive: true })
    await f.sync.refresh(['healthy'])
    assert.equal(f.sync.owns('healthy'), false)
    assert.equal(f.records.has('healthy'), false)
  } finally { await f.close() }
})
