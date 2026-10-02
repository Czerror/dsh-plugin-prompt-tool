/**
 * 预设登记 seam：登记只是让宿主找得到 id 的**空壳**，装配不归官方 Loader。
 *
 * 真值源是存储根里的目录事实（`module.yml` 存在与否）与宿主侧的登记调用记录；
 * 断言落在调用方观察到的行为上：登记了什么、什么时候撤销、失败时旧登记是否还在。
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const sandbox = mkdtempSync(join(process.cwd(), 'pt-registry-home-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = sandbox
const { createModuleRegistrySync } = await import('../../src/host/module-registry.ts')
after(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(sandbox, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(sandbox, 'presets-'))
  const records = new Map()
  const calls = []
  /** 宿主侧登记：登记即"已解析"，除非测试显式让 register 抛错。 */
  let failing = false
  const registry = {
    register: async (definition) => {
      if (failing) throw new Error('host register rejected')
      if (records.has(definition.id)) throw new Error('Duplicate agent preset')
      records.set(definition.id, { definition })
      calls.push(['register', definition.id])
      return async () => { records.delete(definition.id); calls.push(['dispose', definition.id]) }
    },
    resolve: async (id) => ({ id, ...(records.has(id) ? {} : { broken: 'not registered' }) }),
  }
  const warnings = []
  const sync = createModuleRegistrySync({ agentPresets: registry, logger: { warn: (m) => { warnings.push(m) } } }, root)
  const write = (id, meta = {}) => {
    mkdirSync(join(root, id), { recursive: true })
    writeFileSync(join(root, id, 'module.yml'), `${JSON.stringify({ id, name: meta.name ?? id, ...meta }, null, 2)}\n`)
  }
  return {
    root, records, calls, warnings, write, sync,
    setFailing: (value) => { failing = value },
    close: async () => { await sync.dispose(); rmSync(root, { recursive: true, force: true }) },
  }
}

test('登记空壳组合：宿主解析通过，组合本体不再来自 agent.cordis.yml', async () => {
  const f = fixture()
  try {
    f.write('alpha', { name: 'Alpha 预设', description: '说明', order: 3 })
    // 组合本体存在也不被读取：登记内容必须是空组合。
    writeFileSync(join(f.root, 'alpha', 'agent.cordis.yml'), '- name: broken-module\n')
    await f.sync.refresh()
    const definition = f.records.get('alpha').definition
    assert.deepEqual(definition.plugins, [], '登记的组合本体为空')
    assert.equal(definition.id, 'alpha')
    assert.equal(definition.name, 'Alpha 预设')
    assert.equal(definition.description, '说明')
    assert.equal(definition.order, 3)
    assert.equal(f.sync.owns('alpha'), true)
  } finally { await f.close() }
})

test('刷新幂等、元数据变更重登记、目录删除撤销登记', async () => {
  const f = fixture()
  try {
    f.write('alpha')
    await f.sync.refresh()
    await f.sync.refresh()
    assert.deepEqual(f.calls, [['register', 'alpha']], '同一定义重复刷新不重登记')

    f.write('alpha', { name: '改名后' })
    await f.sync.refresh()
    assert.deepEqual(f.calls, [['register', 'alpha'], ['dispose', 'alpha'], ['register', 'alpha']], '元数据变更重登记')
    assert.equal(f.records.get('alpha').definition.name, '改名后')

    rmSync(join(f.root, 'alpha'), { recursive: true })
    await f.sync.refresh()
    assert.equal(f.records.has('alpha'), false, '目录删除后撤销登记')
    assert.equal(f.sync.owns('alpha'), false, '身份判定随目录消失')
  } finally { await f.close() }
})

test('登记失败：按目录事实报告并保留可重试的路径，不留下假身份', async () => {
  const f = fixture()
  try {
    f.write('alpha')
    f.setFailing(true)
    await assert.rejects(f.sync.refresh(), /预设登记刷新失败/)
    assert.equal(f.records.has('alpha'), false, '失败不产生登记')
    assert.equal(f.warnings.some((line) => line.includes('alpha 登记失败')), true, '失败被报告')

    // 宿主恢复后重试成功；身份判定始终只看存储根。
    f.setFailing(false)
    await f.sync.refresh()
    assert.equal(f.records.has('alpha'), true)
    assert.equal(f.sync.owns('alpha'), true)
    f.write('beta')
    await f.sync.refresh()
    assert.deepEqual([...f.records.keys()].sort(), ['alpha', 'beta'])
  } finally { await f.close() }
})

test('释放：撤销全部登记，且可重复调用', async () => {
  const f = fixture()
  try {
    f.write('alpha')
    f.write('beta')
    await f.sync.refresh()
    assert.equal(f.records.size, 2)
    await f.sync.dispose()
    await f.sync.dispose()
    assert.equal(f.records.size, 0)
    assert.equal(f.sync.owns('alpha'), false, '释放后不再声明身份')
  } finally { await f.close() }
})
