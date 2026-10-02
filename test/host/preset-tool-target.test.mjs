import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
const sandbox = mkdtempSync(join(process.cwd(), 'pt-tool-target-home-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = sandbox
const { registerWorldBookTools } = await import('../../src/runtime/world-book-tools.ts')
const { registerCharacterTools } = await import('../../src/runtime/character-tools.ts')
const { resolvePresetToolTarget } = await import('../../src/host/preset-tool-target.ts')
after(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(sandbox, { recursive: true, force: true })
})

function fixture(rebuild = async () => {}) {
  const root = mkdtempSync(join(sandbox, 'presets-'))
  for (const id of ['preset-a', 'preset-b']) {
    mkdirSync(join(root, id))
    writeFileSync(join(root, id, 'module.yml'), `id: ${id}\nmodules: []\npromptConfigs: []\n`)
  }
  const tools = new Map()
  const bindings = new Map()
  const registry = { composedPreset: (ctx) => bindings.get(ctx) }
  const ctx = {
    get: (key) => key === 'agentPresets' ? registry : undefined,
    inject: (_deps, callback) => {
      const dispose = callback({ tools: { register: (tool) => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } } })
      return { dispose }
    },
  }
  const host = {
    target: (exec) => resolvePresetToolTarget(ctx, exec, root, (id) => ['preset-a', 'preset-b'].includes(id)),
    rebuild,
  }
  const disposers = [registerWorldBookTools(ctx, host), registerCharacterTools(ctx, host)]
  const execute = (name, args, preset) => {
    const agent = { ctx: {} }
    bindings.set(agent.ctx, preset)
    return tools.get(name).execute(args, { agent })
  }
  return { root, execute, tools, dispose: () => { disposers.forEach((dispose) => dispose()); rmSync(root, { recursive: true, force: true }) } }
}

test('预设工具写入执行 Agent 的 A/B 绑定，子代理继承 A，卸载释放贡献', async () => {
  const rebuilt = []
  const f = fixture(async (id) => { rebuilt.push(id) })
  try {
    await f.execute('world_book_upsert', { id: 'a', name: 'A', content: 'A' }, 'preset-a')
    await f.execute('world_book_upsert', { id: 'child', name: '子代理', content: 'A child' }, 'preset-a')
    await f.execute('world_book_upsert', { id: 'b', name: 'B', content: 'B' }, 'preset-b')
    const card = await f.execute('character_import', { name: 'alice', content: JSON.stringify({ id: 'alice', name: 'Alice', promptConfigs: [{ id: 'intro', text: 'Alice intro' }] }) }, 'preset-a')
    await f.execute('character_apply', { id: card.id }, 'preset-a')
    const read = (id) => parse(readFileSync(join(f.root, id, 'module.yml'), 'utf8')).promptConfigs.map((row) => row.id).sort()
    assert.deepEqual(read('preset-a'), ['a', 'chara-alice-intro', 'child'])
    assert.deepEqual(read('preset-b'), ['b'])
    assert.deepEqual(rebuilt, ['preset-a', 'preset-a', 'preset-b', 'preset-a'])
  } finally { f.dispose() }
  assert.equal(f.tools.size, 0)
})

test('未绑定和非受管预设不能通过模型工具读写用户预设', async () => {
  const f = fixture()
  try {
    const before = readFileSync(join(f.root, 'preset-b', 'module.yml'), 'utf8')
    await assert.rejects(f.execute('world_book_upsert', { id: 'no', name: 'no', content: 'no' }, undefined), /不可写/)
    await assert.rejects(f.execute('character_list', {}, 'system'), /不可写/)
    writeFileSync(join(f.root, 'preset-a', 'module.yml'), 'id: foreign\nmodules: []\n')
    await assert.rejects(f.execute('world_book_list', {}, 'preset-a'), /身份不匹配/)
    assert.equal(readFileSync(join(f.root, 'preset-b', 'module.yml'), 'utf8'), before)
  } finally { f.dispose() }
})

test('预设工具等待重建；重建失败保留已保存定义并向调用方报错', async () => {
  let release
  let settled = false
  const f = fixture(() => new Promise((_resolve, reject) => { release = reject }))
  try {
    const pending = f.execute('world_book_upsert', { id: 'saved', name: 'saved', content: 'saved' }, 'preset-a')
    pending.then(() => { settled = true }, () => { settled = true })
    await Promise.resolve()
    assert.equal(settled, false)
    release(new Error('注册失败'))
    await assert.rejects(pending, /已保存.*注册失败/)
    assert.equal(parse(readFileSync(join(f.root, 'preset-a', 'module.yml'), 'utf8')).promptConfigs[0].id, 'saved')
  } finally { f.dispose() }
})
