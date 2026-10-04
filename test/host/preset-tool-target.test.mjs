/**
 * 模型工具的写入目标缝：目标来自**该 Agent 的运行时配装记录**（启用表 ∩ 磁盘），
 * 与宿主「这个会话绑定了哪个官方预设」无关——模块早已与官方预设解耦。
 *
 * 真值源是调用方给出的**提示词层字面量列表**，不是被测实现自己算出的另一份结果；
 * 断言落在调用方观察到的写盘落点上。
 */
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
const { resolveModuleToolTarget } = await import('../../src/host/module-tool-target.ts')
after(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(sandbox, { recursive: true, force: true })
})

function fixture(rebuild = async () => {}) {
  const root = mkdtempSync(join(sandbox, 'layers-'))
  for (const id of ['layer-a', 'layer-b']) {
    mkdirSync(join(root, id))
    writeFileSync(join(root, id, 'module.yml'), `id: ${id}\nmodules: []\nrules: []\n`)
  }
  const tools = new Map()
  /** 配装记录桩：sessionId → 该 Agent 实际装上的提示词层，顺序即启用表顺序。 */
  const mounted = new Map()
  let sessions = 0
  const ctx = {
    get: () => undefined,
    inject: (_deps, callback) => {
      const dispose = callback({ tools: { register: (tool) => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } } })
      return { dispose }
    },
  }
  const host = {
    target: (exec) => resolveModuleToolTarget(exec, root, (sessionId) => mounted.get(sessionId) ?? []),
    rebuild,
  }
  const disposers = [registerWorldBookTools(ctx, host), registerCharacterTools(ctx, host)]
  const execute = (name, args, layers) => {
    const agent = { id: `session-${++sessions}`, ctx: {} }
    mounted.set(agent.id, layers)
    return tools.get(name).execute(args, { agent })
  }
  return { root, execute, tools, dispose: () => { disposers.forEach((dispose) => dispose()); rmSync(root, { recursive: true, force: true }) } }
}

test('模型工具写入该 Agent 配装的提示词层；装了多层时取启用表第一个', async () => {
  const rebuilt = []
  const f = fixture(async (id) => { rebuilt.push(id) })
  try {
    await f.execute('world_book_upsert', { id: 'a', name: 'A', content: 'A' }, ['layer-a'])
    await f.execute('world_book_upsert', { id: 'child', name: '子代理', content: 'A child' }, ['layer-a'])
    await f.execute('world_book_upsert', { id: 'b', name: 'B', content: 'B' }, ['layer-b'])
    // 同一个 Agent 装了两层：写进启用表里的第一层，第二层不受影响。
    await f.execute('world_book_upsert', { id: 'multi', name: 'M', content: 'M' }, ['layer-a', 'layer-b'])
    const card = await f.execute('character_import', { name: 'alice', content: JSON.stringify({ id: 'alice', name: 'Alice', rules: [{ id: 'intro', then: [{ id: 'inject', kind: 'inject-text', config: { id: 'intro', text: 'Alice intro' } }] }] }) }, ['layer-a'])
    assert.equal(card.id, 'alice')
    assert.equal(f.tools.has('character_apply'), false)
    assert.equal(f.tools.has('character_list'), false)
    const read = (id) => parse(readFileSync(join(f.root, id, 'module.yml'), 'utf8')).rules.map((row) => row.id).sort()
    assert.deepEqual(read('layer-a'), ['a', 'child', 'multi'])
    assert.deepEqual(read('layer-b'), ['b'])
    assert.deepEqual(read('alice'), ['intro'])
    assert.deepEqual(rebuilt, ['layer-a', 'layer-a', 'layer-b', 'layer-a'])
  } finally { f.dispose() }
  assert.equal(f.tools.size, 0)
})

test('未配装提示词层的会话不能通过模型工具写入', async () => {
  const f = fixture()
  try {
    const before = readFileSync(join(f.root, 'layer-b', 'module.yml'), 'utf8')
    // 空配装：启用表为空（或写盘关闭）时上层就是这么返回的。
    await assert.rejects(f.execute('world_book_upsert', { id: 'no', name: 'no', content: 'no' }, []), /未配装/)
    // 无 Agent 的调用来源没有配装记录。
    await assert.rejects(f.execute('character_import', { name: 'alice', content: '{}' }, undefined), /未配装/)
    // 配装记录指向磁盘上已消失的目录：路径校验兜住，不静默新建。
    await assert.rejects(f.execute('world_book_list', {}, ['ghost']), /不存在/)
    // 目录身份与声明不一致：仍按既有身份校验拒绝。
    writeFileSync(join(f.root, 'layer-a', 'module.yml'), 'id: foreign\nmodules: []\n')
    await assert.rejects(f.execute('world_book_list', {}, ['layer-a']), /身份不匹配/)
    assert.equal(readFileSync(join(f.root, 'layer-b', 'module.yml'), 'utf8'), before)
  } finally { f.dispose() }
})

test('模型工具等待重建；重建失败保留已保存定义并向调用方报错', async () => {
  let release
  let settled = false
  const f = fixture(() => new Promise((_resolve, reject) => { release = reject }))
  try {
    const pending = f.execute('world_book_upsert', { id: 'saved', name: 'saved', content: 'saved' }, ['layer-a'])
    pending.then(() => { settled = true }, () => { settled = true })
    await Promise.resolve()
    assert.equal(settled, false)
    release(new Error('重建失败'))
    await assert.rejects(pending, /已保存.*重建失败/)
    assert.equal(parse(readFileSync(join(f.root, 'layer-a', 'module.yml'), 'utf8')).rules[0].id, 'saved')
  } finally { f.dispose() }
})
