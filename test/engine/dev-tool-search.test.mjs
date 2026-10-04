/**
 * dev-tool-search —— 工具面按需发现与解锁的行为验收。
 *
 * 覆盖：目录打分与排序（精确名优先、按命中 token 数、截断）、**运行时分组摘要**
 * （替代手工能力索引，工具增删不需要改代码）、解锁回报与去重、无 agent /
 * 目录抛错时的降级。
 *
 * 真值源：分组与排序期望值由 `groupKeyOf` 的规则手工算出；目录样本是实测的
 * 156 个工具名里的已知良好子集（`mcp__github__create_pull_request`、`task_board_create` …）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MAX_RESULTS, apply, groupKeyOf, queryTokens, scoreTools, summarizeCatalog, unlockNames } from '../../engine/dev-tool-search.mjs'

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

test('dev-tool-search：打分是「精确名优先，再按命中 token 数」，不是 AND 过滤', () => {
  const wanted = queryTokens('web')
  const scored = scoreTools(catalog, wanted)
  assert.deepEqual(scored.map((entry) => entry.name), ['web_fetch', 'web_search'], '同分按名字字典序')
  assert.equal(scored.every((entry) => entry.score === 1), true)

  // 长自然语言查询在 AND 口径下会命中零个；打分口径下必须仍有结果。
  const long = scoreTools(catalog, queryTokens('create pull request github'))
  assert.ok(long.length > 0, '长查询不得返回空')
  assert.equal(long[0].name, 'mcp__github__create_pull_request', '命中 token 最多者排最前')

  // 精确名命中必须压过命中数更多的工具。
  const exact = scoreTools(
    [
      { name: 'web_search', description: 'web search the internet' },
      { name: 'bash', description: 'web_search helper' },
    ],
    queryTokens('web_search'),
  )
  assert.equal(exact[0].name, 'web_search')
  assert.equal(exact[0].exact, true)
  assert.equal(exact[1].exact, false)
})

test('dev-tool-search：无查询分词时返回空，交给调用方区分「没给查询」与「没搜到」', () => {
  assert.deepEqual(scoreTools(catalog, []), [])
  assert.deepEqual(scoreTools(catalog, queryTokens('   ')), [])
  assert.deepEqual(scoreTools(undefined, queryTokens('web')), [], '目录缺失不得抛错')
  assert.deepEqual(queryTokens('Web, 子代理_2'), ['web', '子代理_2'], '大小写归一、保留下划线与 Unicode')
  assert.deepEqual(unlockNames(['a', 'a', '', 7, ' b ']), ['a', 'b'], '去重保序、剔非字符串')
  assert.deepEqual(unlockNames('web_search'), [], '非数组一律空（模型传字符串是常见错误）')
})

test('dev-tool-search：分组键把 MCP 折到服务级、其余折到首段', () => {
  assert.equal(groupKeyOf('mcp__github__create_pull_request'), 'mcp__github__*')
  assert.equal(groupKeyOf('mcp__mcp-server-chart__generate_pie_chart'), 'mcp__mcp-server-chart__*')
  assert.equal(groupKeyOf('task_board_create'), 'task_*')
  assert.equal(groupKeyOf('read_image'), 'read_*')
  assert.equal(groupKeyOf('pwsh'), 'pwsh')
  assert.equal(groupKeyOf(''), undefined)
  assert.equal(groupKeyOf(undefined), undefined)
})

test('dev-tool-search：目录摘要由运行时折叠，长尾并成「其他」而不是无限增长', () => {
  const summary = summarizeCatalog(catalog)
  assert.equal(summary.total, catalog.length, '总数等于可见目录项数')
  assert.match(summary.text, /mcp__github__\*\(1\)/)
  assert.match(summary.text, /web_\*\(2\)/, '同前缀合并计数')
  assert.match(summary.text, /pwsh\(1\)/, '无前缀单名自成一组')
  assert.equal(summarizeCatalog([]).total, 0)
  assert.equal(summarizeCatalog(undefined).total, 0)

  // 超过分组上限时并入「其他」，条数不随工具数线性增长。
  const many = Array.from({ length: 80 }, (_, index) => ({ name: `g${index}_tool`, description: '' }))
  const big = summarizeCatalog(many)
  assert.equal(big.total, 80)
  assert.match(big.text, /其他 \d+ 组\(/)
  assert.ok(big.text.length < 400, `摘要必须保持紧凑，实际 ${big.text.length} 字符`)
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

test('dev-tool-search：描述如实告知常驻集与三种用法，且不内联一份手工工具清单', () => {
  const description = recordingCtx(() => catalog).description
  for (const name of ['pwsh', 'read', 'write', 'edit', 'glob', 'grep', 'todo_write', 'skill_search', 'skill_load']) {
    assert.ok(description.includes(name), `描述应告知常驻工具 ${name}`)
  }
  assert.match(description, /call with NO arguments/, '必须教「空查询看目录」这条路径')
  assert.match(description, /`toolNames`/, '必须教解锁路径')
  // 手工索引的教训：写死名字会随工具增删腐化，且错名会让模型照着错名字解锁。
  // 描述里只应有常驻集那几个名字 + 一个**格式示例**；不得再内联可解锁工具清单。
  for (const stale of ['task_board_create', 'mnemon_recall', 'ssh_exec', 'web_search', 'subagent_fork']) {
    assert.equal(description.includes(stale), false, `描述不得内联可解锁工具名 ${stale}`)
  }
  assert.match(description, /<prefix>_\*\(count\)/, '只给分组示例的格式，不给会腐化的具体计数')
})
