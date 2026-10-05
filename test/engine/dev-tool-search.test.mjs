/**
 * dev-tool-search —— 工具面按需发现与解锁的行为验收。
 *
 * 覆盖：**运行时分组摘要**、目录概览与命中渲染、搜索超限截断、解锁回报与去重、
 * 无 agent / 目录抛错时的降级。
 *
 * 真值源：目录样本是实测的 156 个工具名里的已知良好子集
 * （`mcp__github__create_pull_request`、`task_board_create` …）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MAX_RESULTS, apply, groupKeyOf, unlockNames } from '../../engine/dev-tool-search.mjs'

/** 目录样本（真实工具名 + 一行描述）。 */
const catalog = [
  { name: 'web_search', description: 'Search the web' },
  { name: 'web_fetch', description: 'Fetch a URL' },
  { name: 'subagent', description: 'Delegate to a subagent' },
  { name: 'read_image', description: 'Read an image file' },
  { name: 'pwsh', description: 'Run a shell command' },
  { name: 'mcp__github__create_pull_request', description: 'Create a pull request on GitHub' },
  { name: 'task_board_create', description: 'Create a board task' },
]

/** 记录型 ctx 桩：捕获注册的工具定义，供 execute 驱动。 */
function recordingCtx(schemasImpl) {
  const registered = []
  const ctx = {
    tools: {
      register: (definition) => { registered.push(definition); return () => {} },
      schemas: schemasImpl,
    },
  }
  apply(ctx)
  assert.equal(registered.length, 1, 'apply 只应注册一个工具')
  return registered[0]
}

const run = (definition, args, exec) => definition.execute(args, exec)

test('dev-tool-search：注册名为 dev_tool_search 的工具，参数是可选的 query / toolNames', () => {
  const definition = recordingCtx(() => catalog)
  assert.equal(definition.name, 'dev_tool_search')
  const parameters = definition.parameters
  assert.deepEqual(Object.keys(parameters.properties).sort(), ['query', 'toolNames'])
  assert.deepEqual(parameters.required, [], '两个参数都可选——只解锁不搜、只搜不解锁、都不给都有定义')
  assert.equal(parameters.properties.toolNames.items.type, 'string')
  assert.equal(parameters.additionalProperties, false)
})

test('dev-tool-search：非法 toolNames 与无名工具的分组键', () => {
  assert.deepEqual(unlockNames('web_search'), [], '非数组一律空（模型传字符串是常见错误）')
  assert.equal(groupKeyOf(''), undefined)
})

test('dev-tool-search：空查询返回目录概览，命中渲染名字与截断描述', async () => {
  const definition = recordingCtx(() => catalog)
  const overview = await run(definition, {}, { agent: {} })
  assert.match(overview.text, /Catalog groups \(\d+ tools\): /)
  assert.match(overview.text, /Search with `query`/)
  assert.doesNotMatch(overview.text, /Search the web/, '概览不得回工具描述')

  const hit = await run(definition, { query: 'web' }, { agent: {} })
  assert.match(hit.text, /Matching tools \(2\)/)
  assert.match(hit.text, /- web_search: Search the web/)
  assert.match(hit.text, /Unlock with dev_tool_search/)
  assert.doesNotMatch(hit.text, /parameters/, '不回 parameters')

  const miss = await run(definition, { query: 'zzzz' }, { agent: {} })
  assert.match(miss.text, /No tools match "zzzz"/)
  assert.match(miss.text, /unlock it directly by exact name/, '空结果必须教解锁路径')
})

test('dev-tool-search：搜索超限给出收窄提示', async () => {
  const many = Array.from({ length: MAX_RESULTS + 5 }, (_, index) => ({ name: `web_tool_${index}`, description: 'web' }))
  const definition = recordingCtx(() => many)
  const truncated = await run(definition, { query: 'web' }, { agent: {} })
  assert.match(truncated.text, new RegExp(`Matching tools \\(${MAX_RESULTS} of ${many.length}\\)`))
  assert.match(truncated.text, new RegExp(`truncated at ${MAX_RESULTS}`))
})

test('dev-tool-search：解锁回报去重、不需要目录，且只解锁时不搜目录', async () => {
  let calls = 0
  const definition = recordingCtx(() => { calls += 1; throw new Error('catalog down') })
  // 解锁不依赖目录：即便目录抛错也必须回报成功（引擎只读持久调用参数）。
  const unlock = await run(definition, { toolNames: ['web_search', 'web_search', '', 42, 'subagent'] }, { agent: {} })
  assert.match(unlock.text, /Unlocked for the next request: web_search, subagent/)
  assert.equal(calls, 0, '只解锁时不得触碰目录')

  const both = await run(definition, { query: 'web', toolNames: ['todo_write'] }, { agent: {} })
  assert.match(both.text, /Unlocked for the next request: todo_write/)
  assert.match(both.text, /catalog search unavailable: catalog down/, '同一次调用里解锁成功、搜索降级')
})

test('dev-tool-search：无 agent 照常搜索，目录抛错降级为一行说明而不上抛', async () => {
  let seenScope
  const definition = recordingCtx((scope) => { seenScope = scope; return catalog })
  const noAgent = await run(definition, { query: 'web' }, undefined)
  assert.match(noAgent.text, /Matching tools/)
  assert.equal(seenScope, undefined, '无 exec 时按 undefined scope 查询，不崩')

  const scope = { id: 'agent-1' }
  await run(definition, { query: 'web' }, { agent: scope })
  assert.equal(seenScope, scope, '必须用执行中的 agent 作观察作用域，否则 preset 工具搜不到')

  const broken = recordingCtx(() => { throw new Error('catalog down') })
  const degraded = await run(broken, { query: 'web' }, { agent: {} })
  assert.match(degraded.text, /catalog search unavailable: catalog down/)
})

test('dev-tool-search：描述如实告知常驻集与三种用法', () => {
  const description = recordingCtx(() => catalog).description
  for (const name of ['pwsh', 'read', 'write', 'edit', 'glob', 'grep', 'todo_write', 'skill_search', 'skill_load']) {
    assert.ok(description.includes(name), `描述应告知常驻工具 ${name}`)
  }
  assert.match(description, /call with NO arguments/, '必须教「空查询看目录」这条路径')
  assert.match(description, /`toolNames`/, '必须教解锁路径')
  assert.match(description, /<prefix>_\*\(count\)/, '只给分组示例的格式，不给会腐化的具体计数')
})
