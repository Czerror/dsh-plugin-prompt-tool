import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'

const { apply: applyToolConfigEngine } = await import('../../engine/tool-config-engine.mjs')

/** mock cordis ctx：捕获注册、提供 tools/approval 服务。 */
function makeCtx({ approval, delegatedTool } = {}) {
  const registered = []
  const warns = []
  const toolsService = {
    register: (def) => { registered.push(def); return () => {} },
    get: (name) => registered.find((tool) => tool.name === name)
      ?? (delegatedTool !== undefined && name === delegatedTool.name ? delegatedTool : undefined),
  }
  const ctx = {
    tools: toolsService,
    get: (name) => (name === 'tools' ? toolsService : name === 'approval' ? approval : undefined),
    effect: (fn) => fn(),
    logger: {
      info: () => {},
      warn: (message) => { warns.push(String(message)) },
    },
  }
  return { ctx, registered, warns }
}

/** 最小 ToolRunContext（引擎 execute 消费的字段）。 */
function runOf(cwd = process.cwd()) {
  return {
    name: 'x',
    callId: 'call-1',
    agent: { session: { header: { cwd } } },
    parent: undefined,
    signal: new AbortController().signal,
    arguments: {},
    deferContext: () => {},
    concludeTurn: () => {},
  }
}

function writeToolDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'pt-ctools-'))
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, 'utf8')
  }
  return dir
}

test('tool-config-engine：加载定义并注册（shell/http/fs/ask-user 四类）', () => {
  const dir = writeToolDir({
    '01-greet.yml': `id: greet
name: my_greet
description: 打招呼
parameters:
  who: { type: string, required: true, description: 对象 }
output:
  schema: { type: object, additionalProperties: false, properties: { ok: { type: boolean } } }
execute:
  kind: shell
  command: 'Write-Output "hi {{args.who}}"'
`,
    '02-fetch.yml': `id: fetch
name: my_fetch
description: 拉取
output:
  schema: { type: object, additionalProperties: false, properties: { status: { type: number } } }
execute:
  kind: http
  url: 'https://example.invalid/x'
`,
    '03-fs.yml': `id: fs
name: my_fs
description: 读文件
parameters:
  path: { type: string, required: true, description: 路径 }
output:
  schema: { type: object, additionalProperties: true }
execute:
  kind: fs
  action: read
  path: '{{args.path}}'
`,
    '04-ask.yml': `id: ask
name: my_ask
description: 询问
output:
  schema: { type: object, additionalProperties: true }
execute:
  kind: ask-user
  question: 继续吗
`,
  })
  const { ctx, registered, warns } = makeCtx({ approval: { request: async () => 'allowed-once' } })
  applyToolConfigEngine(ctx, { configsDir: dir })
  assert.equal(registered.length, 4, '四类工具全部注册')
  assert.deepEqual(registered.map((tool) => tool.name), ['my_greet', 'my_fetch', 'my_fs', 'my_ask'])
  assert.equal(warns.length, 0, '无跳过告警')
})

test('tool-config-engine：shell 执行器（pwsh，env 白名单，cwd=会话工作区）', async () => {
  const dir = writeToolDir({
    '01-echo.yml': `id: echo
name: my_echo
description: echo
parameters:
  text: { type: string, required: true, description: 文本 }
output:
  schema: { type: object, additionalProperties: true }
execute:
  kind: shell
  command: 'Write-Output "got {{args.text}}"'
`,
  })
  const { ctx } = makeCtx()
  applyToolConfigEngine(ctx, { configsDir: dir })
  const result = await ctx.tools.get('my_echo').execute({ text: '你好' }, runOf())
  assert.equal(result.exitCode, 0)
  assert.match(result.stdout, /got 你好/)
})

test('tool-config-engine：http 执行器（本地服务 + 超时）', async () => {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ path: req.url }))
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  const port = server.address().port
  try {
    const dir = writeToolDir({
      '01-http.yml': `id: http
name: my_http
description: 请求
parameters:
  q: { type: string, required: true, description: 查询 }
output:
  schema: { type: object, additionalProperties: true }
execute:
  kind: http
  url: 'http://127.0.0.1:${port}/search?q={{args.q}}'
`,
    })
    const { ctx } = makeCtx()
    applyToolConfigEngine(ctx, { configsDir: dir })
    const result = await ctx.tools.get('my_http').execute({ q: '剑' }, runOf())
    assert.equal(result.status, 200)
    assert.equal(result.ok, true)
    assert.ok(result.body.includes('/search?q='), '查询参数已传递')
    assert.ok(decodeURIComponent(result.body).includes('剑'), '中文参数经 URL 编码往返')
  } finally {
    server.close()
  }
})

test('tool-config-engine：fs 执行器（写/读 + 越界拒绝）', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pt-ctools-cwd-'))
  const dir = writeToolDir({
    '01-fs.yml': `id: fs
name: my_fs
description: 文件
parameters:
  action: { type: string, required: true }
  path: { type: string, required: true }
  content: { type: string }
output:
  schema: { type: object, additionalProperties: true }
execute:
  kind: fs
  action: '{{args.action}}'
  path: '{{args.path}}'
  content: '{{args.content}}'
`,
  })
  const { ctx } = makeCtx()
  applyToolConfigEngine(ctx, { configsDir: dir })
  const tool = ctx.tools.get('my_fs')
  const wrote = await tool.execute({ action: 'write', path: 'a.txt', content: 'hello' }, runOf(cwd))
  assert.equal(wrote.ok, true)
  const read = await tool.execute({ action: 'read', path: 'a.txt' }, runOf(cwd))
  assert.equal(read.content, 'hello')
  const escaped = await tool.execute({ action: 'read', path: '../secret.txt' }, runOf(cwd))
  assert.equal(escaped.ok, false, '越界路径被拒绝')
  assert.match(escaped.error, /escapes the workspace/)
})

test('tool-config-engine：delegate 执行器（委托已注册工具）', async () => {
  const delegated = {
    name: 'real_tool',
    execute: async (args) => ({ doubled: Number(args.n) * 2 }),
  }
  const dir = writeToolDir({
    '01-delegate.yml': `id: del
name: my_del
description: 委托
parameters:
  n: { type: number, required: true }
output:
  schema: { type: object, additionalProperties: true }
execute:
  kind: delegate
  tool: real_tool
`,
  })
  const { ctx } = makeCtx({ delegatedTool: delegated })
  applyToolConfigEngine(ctx, { configsDir: dir })
  const result = await ctx.tools.get('my_del').execute({ n: 21 }, runOf())
  assert.equal(result.ok, true)
  assert.equal(result.value.doubled, 42)
})

test('tool-config-engine：delegate args 映射（完整引用透传类型 + 部分引用插值 + 固定值）', async () => {
  const delegated = {
    name: 'upsert_tool',
    execute: async (targetArgs) => targetArgs,
  }
  const dir = writeToolDir({
    '01-delegate-args.yml': `id: del
name: my_del
description: 委托
parameters:
  keys: { type: array, items: { type: string } }
  content: { type: string, required: true }
  order: { type: integer }
output:
  schema: { type: object, additionalProperties: true }
execute:
  kind: delegate
  tool: upsert_tool
  args:
    name: '条目-{{args.content}}'
    content: '{{args.content}}'
    keys: '{{args.keys}}'
    constant: true
    order: '{{args.order}}'
`,
  })
  const { ctx } = makeCtx({ delegatedTool: delegated })
  applyToolConfigEngine(ctx, { configsDir: dir })
  const result = await ctx.tools.get('my_del').execute({ keys: ['剑', '刃'], content: '剑术', order: 100 }, runOf())
  assert.equal(result.ok, true)
  assert.deepEqual(result.value, {
    name: '条目-剑术',
    content: '剑术',
    keys: ['剑', '刃'],
    constant: true,
    order: 100,
  }, '完整引用透传数组/数字类型，部分引用插值，固定值原样')
})

test('tool-config-engine：ask-user 执行器（approval 结果文本化）', async () => {
  const dir = writeToolDir({
    '01-ask.yml': `id: ask
name: my_ask
description: 询问
output:
  schema: { type: object, additionalProperties: true }
execute:
  kind: ask-user
  question: 继续吗
`,
  })
  const { ctx } = makeCtx({ approval: { request: async () => 'rejected' } })
  applyToolConfigEngine(ctx, { configsDir: dir })
  const result = await ctx.tools.get('my_ask').execute({}, runOf())
  assert.equal(result.answer, 'rejected')
})

test('tool-config-engine：requireApproval 门（shell 无 approval 服务拒绝）', async () => {
  const dir = writeToolDir({
    '01-shell.yml': `id: s
name: my_s
description: 命令
output:
  schema: { type: object, additionalProperties: true }
execute:
  kind: shell
  command: 'Write-Output x'
`,
  })
  const { ctx } = makeCtx() // 无 approval 服务
  applyToolConfigEngine(ctx, { configsDir: dir, requireApproval: ['shell'] })
  const result = await ctx.tools.get('my_s').execute({}, runOf())
  assert.equal(result.ok, false)
  assert.match(result.error, /no approval channel/)
})

test('tool-config-engine：非法定义跳过（坏 name / 缺 execute / 越界 schema）', () => {
  const dir = writeToolDir({
    '01-bad.yml': `id: bad
name: 'Bad Name!'
description: 非法
output:
  schema: { type: object, additionalProperties: false, properties: {} }
execute:
  kind: shell
  command: 'x'
`,
    '02-missing-exec.yml': `id: missing
name: my_missing
description: 无执行器
output:
  schema: { type: object, additionalProperties: true }
`,
    '03-schema.yml': `id: schema
name: my_schema
description: 非法 schema
parameters:
  bad: { type: object }
output:
  schema: { type: object, additionalProperties: true }
execute:
  kind: shell
  command: 'x'
`,
    '04-ok.yml': `id: ok
name: my_ok
description: 合法
output:
  schema: { type: object, additionalProperties: true }
execute:
  kind: shell
  command: 'x'
`,
  })
  const { ctx, registered, warns } = makeCtx()
  applyToolConfigEngine(ctx, { configsDir: dir })
  assert.deepEqual(registered.map((tool) => tool.name), ['my_ok'], '仅合法工具注册')
  assert.equal(warns.length, 3, '三条非法定义各有跳过告警')
})

test('tool-config-engine：enabled=false 的工具不注册（模块卡片开关语义）', () => {
  const dir = writeToolDir({
    '01-on.yml': `id: on
name: my_on
description: 启用
output:
  schema: { type: object, additionalProperties: true }
execute:
  kind: shell
  command: 'x'
`,
    '02-off.yml': `id: off
name: my_off
description: 停用
enabled: false
output:
  schema: { type: object, additionalProperties: true }
execute:
  kind: shell
  command: 'x'
`,
  })
  const { ctx, registered } = makeCtx()
  applyToolConfigEngine(ctx, { configsDir: dir })
  assert.deepEqual(registered.map((tool) => tool.name), ['my_on'], 'enabled=false 跳过注册')
})

test('tool-config-engine：13+ 工具按 4 位零填充文件名稳定排序注册', () => {
  const files = {}
  for (let index = 0; index < 13; index += 1) {
    const prefix = String(index).padStart(4, '0')
    files[`${prefix}-tool-${index}.yml`] = `id: tool-${index}
name: tool_${index}
description: 工具 ${index}
output:
  schema: { type: object, additionalProperties: true }
execute:
  kind: fs
  action: read
  path: '.'
`
  }
  const dir = writeToolDir(files)
  const { ctx, registered } = makeCtx()
  applyToolConfigEngine(ctx, { configsDir: dir })
  assert.equal(registered.length, 13)
  // 字典序 = 数值序：第 13 个工具（tool_12）落在最后，00/10 前缀不串位。
  assert.deepEqual(registered.map((tool) => tool.name), Array.from({ length: 13 }, (_, index) => `tool_${index}`))
})

test('tool-config-engine：相对 configsDir 越出预设根 fail loud', () => {
  const { ctx, warns } = makeCtx()
  applyToolConfigEngine(ctx, { configsDir: '../../../../outside' })
  assert.ok(warns.some((message) => message.includes('escapes preset root')), '越界相对目录应被拒绝')
})
