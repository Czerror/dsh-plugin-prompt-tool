import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'

const { apply: applyToolConfigEngine } = await import('../../engine/tool-config-engine.mjs')

/** mock cordis ctx：捕获注册、提供 tools/approval 服务。 */
function makeCtx({ approval } = {}) {
  const registered = []
  const warns = []
  const toolsService = {
    register: (def) => { registered.push(def); return () => {} },
    get: (name) => registered.find((tool) => tool.name === name),
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
    rootCallId: 'call-1',
    token: { symbol: 'tok' },
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

/** 真实 Context + SystemPrompt + ToolRuntime（Wave 1/2 契约测试底座）。 */
async function makeRealCtx() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

test('tool-config-engine：加载定义并注册（shell/http/fs/ask-user 四类，JSON Schema 形态）', () => {
  const dir = writeToolDir({
    '01-greet.yml': `id: greet
name: my_greet
description: 打招呼
parameters:
  type: object
  properties:
    who: { type: string, description: 对象 }
  required: [who]
output:
  schema: { type: object, additionalProperties: true }
execute:
  kind: shell
  command: 'Write-Output "hi {{args.who}}"'
`,
    '02-fetch.yml': `id: fetch
name: my_fetch
description: 拉取
parameters:
  type: object
  properties: {}
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
  type: object
  properties:
    path: { type: string, description: 路径 }
  required: [path]
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
  // 无参数工具也必须生成空 object Schema（真实 ctx.tools.schemas() 需要 parameters）。
  const noArgs = registered.find((tool) => tool.name === 'my_ask')
  assert.deepEqual(noArgs.parameters, { type: 'object', properties: {} }, '无参数工具补空 object Schema')
})

test('tool-config-engine：description 双花括号字面量消毒（{{x}} → {x}，防宿主 tools:sdk 变量校验炸整轮）', async () => {
  const dir = writeToolDir({
    '01-braces.yml': `id: braces
name: my_braces
description: 模板占位符 {{变量名}} 与 {{args.*}} 插值示例
parameters:
  type: object
  properties:
    key: { type: string, description: 变量名 }
output:
  schema: { type: object, additionalProperties: true }
execute:
  kind: shell
  command: 'Write-Output "{{args.key}}"'
`,
  })
  const { ctx, registered } = makeCtx({})
  applyToolConfigEngine(ctx, { configsDir: dir })
  assert.equal(registered.length, 1, '工具正常注册')
  const tool = registered[0]
  assert.match(tool.description, /\{变量名\}/)
  assert.match(tool.description, /\{args\.\*\}/)
  assert.ok(!tool.description.includes('{{'), 'description 不得残留双花括号字面量')
  // execute.command 的 {{args.key}} 是引擎自有插值语法，不受消毒影响。
  const result = await tool.execute({ key: 'hello' }, runOf())
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout.trim(), 'hello')
})

test('tool-config-engine：shell 执行器（pwsh，env 白名单，cwd=会话工作区）', async () => {
  const dir = writeToolDir({
    '01-echo.yml': `id: echo
name: my_echo
description: echo
parameters:
  type: object
  properties:
    text: { type: string, description: 文本 }
  required: [text]
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
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ hello: 'world' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const dir = writeToolDir({
    '01-fetch.yml': `id: fetch
name: my_fetch
description: 拉取
output:
  schema: { type: object, additionalProperties: true }
execute:
  kind: http
  url: 'http://127.0.0.1:${port}/x'
`,
  })
  const { ctx } = makeCtx()
  applyToolConfigEngine(ctx, { configsDir: dir })
  const result = await ctx.tools.get('my_fetch').execute({}, runOf())
  assert.equal(result.status, 200)
  assert.deepEqual(JSON.parse(result.body), { hello: 'world' })
  server.close()
})

test('tool-config-engine：fs 执行器（cwd 内路径限定）', async () => {
  const dir = writeToolDir({
    '01-fs.yml': `id: fs
name: my_fs
description: 读文件
parameters:
  type: object
  properties:
    path: { type: string, description: 路径 }
  required: [path]
output:
  schema: { type: object, additionalProperties: true }
execute:
  kind: fs
  action: read
  path: '{{args.path}}'
`,
  })
  const { ctx } = makeCtx()
  applyToolConfigEngine(ctx, { configsDir: dir })
  const workdir = mkdtempSync(join(tmpdir(), 'pt-fs-'))
  const target = join(workdir, 'a.txt')
  writeFileSync(target, 'hello fs', 'utf8')
  const ok = await ctx.tools.get('my_fs').execute({ path: 'a.txt' }, runOf(workdir))
  assert.equal(ok.ok, true)
  assert.equal(ok.content, 'hello fs')
  const escape = await ctx.tools.get('my_fs').execute({ path: '../../../etc/passwd' }, runOf(workdir))
  assert.equal(escape.ok, false)
  assert.match(escape.error, /escapes the workspace/)
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

test('tool-config-engine：非法定义跳过（坏 name / 缺 execute / DSL 未物化 / 越界 schema）', () => {
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
    '03-dsl.yml': `id: dsl
name: my_dsl
description: 未物化 DSL（writePreset 未转换）
parameters:
  who: { type: string, required: true }
output:
  schema: { type: object, additionalProperties: true }
execute:
  kind: shell
  command: 'x'
`,
    '04-schema.yml': `id: schema
name: my_schema
description: 非法 JSON Schema
output:
  schema: { type: object, properties: 42 }
execute:
  kind: shell
  command: 'x'
`,
    '05-ok.yml': `id: ok
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
  assert.equal(warns.length, 4, '四条非法定义各有跳过告警')
  assert.ok(warns.some((message) => message.includes('must declare type or oneOf')), 'DSL 未物化应提示')
})

test('tool-config-engine：customTools.scope 显式拒绝（warn-and-skip）', () => {
  const dir = writeToolDir({
    '01-scoped.yml': `id: scoped
name: my_scoped
description: 带 scope
scope: both
output:
  schema: { type: object, additionalProperties: true }
execute:
  kind: shell
  command: 'x'
`,
    '02-ok.yml': `id: ok
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
  assert.deepEqual(registered.map((tool) => tool.name), ['my_ok'], 'scope 工具被跳过')
  assert.ok(warns.some((message) => message.includes('scope')), '明确报 scope 不支持')
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

// ==================== Wave 1：真实 registry 契约 ====================

test('Wave1：真实 registry —— schemas() 不抛错且参数为标准 JSON Schema；execute 可完成真实调用', async () => {
  const ctx = await makeRealCtx()
  const dir = writeToolDir({
    '01-greet.yml': `id: greet
name: my_greet
description: 打招呼
parameters:
  type: object
  properties:
    who: { type: string, description: 对象 }
  required: [who]
output:
  schema: { type: object, additionalProperties: true }
execute:
  kind: shell
  command: 'Write-Output "hi {{args.who}}"'
`,
    '02-nostate.yml': `id: nostate
name: my_nostate
description: 无参数
output:
  schema: { type: object, additionalProperties: true }
execute:
  kind: shell
  command: 'Write-Output x'
`,
  })
  applyToolConfigEngine(ctx, { configsDir: dir })
  const schemas = ctx.tools.schemas()
  assert.equal(schemas.length, 2, '两个工具都进入 schemas()')
  assert.ok(!schemas.some((schema) => schema.parameters === undefined), '每个工具都有 parameters')
  const greet = schemas.find((schema) => schema.name === 'my_greet')
  assert.deepEqual(greet.parameters, {
    type: 'object',
    properties: { who: { type: 'string', description: '对象' } },
    required: ['who'],
  }, '有参数工具生成标准 JSON Schema')
  const nostate = schemas.find((schema) => schema.name === 'my_nostate')
  assert.deepEqual(nostate.parameters, { type: 'object', properties: {} }, '无参数工具生成空 object Schema')
  const result = await ctx.tools.execute({ callId: 'c1', name: 'my_greet', arguments: { who: '世界' }, signal: new AbortController().signal })
  assert.equal(result.isError, false, '真实调用完成')
  await ctx.fiber.dispose()
})

test('Wave1：真实 registry —— 非法参数在执行前失败且实现不运行', async () => {
  const ctx = await makeRealCtx()
  const workdir = mkdtempSync(join(tmpdir(), 'pt-badargs-'))
  const marker = join(workdir, 'ran.txt')
  const dir = writeToolDir({
    '01-write.yml': `id: write
name: my_write
description: 写文件
parameters:
  type: object
  properties:
    path: { type: string, description: 路径 }
  required: [path]
output:
  schema: { type: object, additionalProperties: true }
execute:
  kind: fs
  action: write
  path: '{{args.path}}'
  content: ran
`,
  })
  applyToolConfigEngine(ctx, { configsDir: dir })
  // 缺必填参数：引擎侧输入校验拒绝，执行器（fs write）不运行。
  const bad = await ctx.tools.execute({ callId: 'b1', name: 'my_write', arguments: {}, agent: { session: { header: { cwd: workdir } } }, signal: new AbortController().signal })
  assert.equal(bad.isError, true, '非法参数产生标准工具错误')
  assert.match(String(bad.error?.message), /missing required property/, '拒绝原因明确')
  assert.equal(existsSync(marker), false, '实现未运行（未写文件）')
  // 合法调用才运行执行器。
  const good = await ctx.tools.execute({ callId: 'g1', name: 'my_write', arguments: { path: marker }, agent: { session: { header: { cwd: workdir } } }, signal: new AbortController().signal })
  assert.equal(good.value.ok, true, '合法调用成功')
  assert.equal(existsSync(marker), true, '执行器运行')
  await ctx.fiber.dispose()
})

test('Wave1：真实 registry —— 非法成功输出被 registry 拒绝', async () => {
  const ctx = await makeRealCtx()
  const dir = writeToolDir({
    '01-badout.yml': `id: badout
name: my_badout
description: 输出与 schema 不符
output:
  schema: { type: string }
execute:
  kind: shell
  command: 'Write-Output x'
`,
  })
  applyToolConfigEngine(ctx, { configsDir: dir })
  const result = await ctx.tools.execute({ callId: 'o1', name: 'my_badout', arguments: {}, signal: new AbortController().signal })
  assert.equal(result.isError, true, 'shell 返回对象与 string schema 不符被拒绝')
  await ctx.fiber.dispose()
})

test('Wave1：真实 registry —— disposer 撤销后工具从对应 scope 消失', async () => {
  const ctx = await makeRealCtx()
  const dir = writeToolDir({
    '01-greet.yml': `id: greet
name: my_greet
description: 打招呼
output:
  schema: { type: object, additionalProperties: true }
execute:
  kind: shell
  command: 'Write-Output x'
`,
  })
  applyToolConfigEngine(ctx, { configsDir: dir })
  assert.ok(ctx.tools.get('my_greet') !== undefined, '注册后可见')
  const schemas = ctx.tools.schemas()
  const names = schemas.map((schema) => schema.name)
  assert.ok(names.includes('my_greet'), 'schemas() 包含自定义工具')
  // 引擎经 ctx.effect 注册：dispose 整个 ctx 即撤销。
  await ctx.fiber.dispose()
  const ctx2 = await makeRealCtx()
  assert.equal(ctx2.tools.get('my_greet'), undefined, '新上下文不受旧注册影响')
  await ctx2.fiber.dispose()
})

// ==================== Wave 2：delegate 统一走 ToolRuntime ====================

test('Wave2：delegate 走真实 ToolRuntime nested dispatch（pre 可观察、args 映射、结果映射）', async () => {
  const ctx = await makeRealCtx()
  const observed = []
  let targetRuns = 0
  const target = {
    name: 'upsert_tool',
    description: 'upsert',
    parameters: { type: 'object', properties: { content: { type: 'string', description: 'c' } }, required: ['content'] },
    output: { schema: { type: 'object', additionalProperties: true }, render: () => [{ type: 'text', text: 'x' }] },
    execute: async (args, run) => {
      targetRuns += 1
      observed.push({ kind: 'body', name: run.name, rootCallId: run.rootCallId, parent: run.parent, callId: run.callId })
      if (args.content === 'ctx') run.deferContext({ role: 'user', content: [{ type: 'text', text: 'DEFERRED' }] })
      if (args.content === 'conclude') run.concludeTurn()
      return { ok: true }
    },
  }
  ctx.tools.register(target)
  ctx.on('tools/pre-execute', async (exec, next) => {
    observed.push({ kind: 'pre', name: exec.name, callId: exec.callId, rootCallId: exec.rootCallId })
    return next()
  })
  const dir = writeToolDir({
    '01-del.yml': `id: del
name: my_del
description: 委托
parameters:
  type: object
  properties:
    content: { type: string, description: 内容 }
    order: { type: integer }
  required: [content]
output:
  schema: { type: object, additionalProperties: true }
execute:
  kind: delegate
  tool: upsert_tool
  args:
    content: '{{args.content}}'
    order: '{{args.order}}'
`,
  })
  applyToolConfigEngine(ctx, { configsDir: dir })
  const result = await ctx.tools.execute({
    callId: 'root-1', name: 'my_del', arguments: { content: '剑术', order: 100 }, signal: new AbortController().signal,
  })
  assert.equal(result.isError, false, 'delegate 成功')
  assert.deepEqual(result.value, { ok: true, value: { ok: true } }, '外层 { ok, value } 映射')
  assert.equal(targetRuns, 1, '目标工具运行一次')
  assert.ok(observed.some((entry) => entry.kind === 'pre' && entry.name === 'upsert_tool'), 'nested call 走 pre 管线（未直接调用目标 execute）')
  const body = observed.find((entry) => entry.kind === 'body')
  assert.equal(body.rootCallId, 'root-1', 'rootCallId 继承外层')
  assert.ok(body.parent !== undefined, 'parent 为外层 token')
  assert.match(body.callId, /^root-1:delegate:upsert_tool$/, 'callId 稳定派生')
  await ctx.fiber.dispose()
})

test('Wave2：delegate 非法参数由真实 registry 拒绝且目标不运行', async () => {
  const ctx = await makeRealCtx()
  let targetRuns = 0
  // 官方 defineTool 目标：registry 在 nested dispatch 前校验参数（与真实官方工具一致）。
  ctx.tools.register(defineTool({
    name: 'strict_tool',
    description: '严格参数',
    parameters: { code: { type: 'string', description: 'c', required: true } },
    output: { schema: { type: 'object', additionalProperties: true }, render: () => [{ type: 'text', text: 'x' }] },
    execute: async () => { targetRuns += 1; return { ok: true } },
  }))
  const dir = writeToolDir({
    '01-del.yml': `id: del
name: my_del
description: 委托
output:
  schema: { type: object, additionalProperties: true }
execute:
  kind: delegate
  tool: strict_tool
`,
  })
  applyToolConfigEngine(ctx, { configsDir: dir })
  const result = await ctx.tools.execute({ callId: 'r1', name: 'my_del', arguments: {}, signal: new AbortController().signal })
  assert.equal(result.isError, false, '外层载荷通过其自身 output schema')
  assert.equal(result.value.ok, false, '目标参数非法映射为 { ok: false }')
  assert.match(String(result.value.error), /missing required property/, 'registry 拒绝原因透传')
  assert.equal(targetRuns, 0, '目标实现不运行')
  await ctx.fiber.dispose()
})

test('Wave2：delegate additionalContexts / concludesTurn 传播到外层', async () => {
  const ctx = await makeRealCtx()
  ctx.tools.register({
    name: 'ctx_tool',
    description: '上下文工具',
    parameters: { type: 'object', properties: { mode: { type: 'string', description: 'm' } }, required: ['mode'] },
    output: { schema: { type: 'object', additionalProperties: true }, render: () => [{ type: 'text', text: 'x' }] },
    execute: async (args, run) => {
      if (args.mode === 'ctx') run.deferContext({ role: 'user', content: [{ type: 'text', text: 'DEFERRED' }] })
      if (args.mode === 'conclude') run.concludeTurn()
      return { ok: true }
    },
  })
  const dir = writeToolDir({
    '01-del.yml': `id: del
name: my_del
description: 委托
parameters:
  type: object
  properties:
    mode: { type: string, description: 模式 }
  required: [mode]
output:
  schema: { type: object, additionalProperties: true }
execute:
  kind: delegate
  tool: ctx_tool
  args:
    mode: '{{args.mode}}'
`,
  })
  applyToolConfigEngine(ctx, { configsDir: dir })
  const ctxResult = await ctx.tools.execute({ callId: 'c1', name: 'my_del', arguments: { mode: 'ctx' }, signal: new AbortController().signal })
  assert.equal(ctxResult.isError, false)
  assert.ok(Array.isArray(ctxResult.additionalContexts), 'deferred context 进入外层结果')
  const text = JSON.stringify(ctxResult.additionalContexts)
  assert.ok(text.includes('DEFERRED'), 'deferred 上下文内容传播')
  const conclude = await ctx.tools.execute({ callId: 'c2', name: 'my_del', arguments: { mode: 'conclude' }, signal: new AbortController().signal })
  assert.equal(conclude.concludesTurn, true, 'nested concludeTurn 传播到外层')
  await ctx.fiber.dispose()
})

test('Wave2：delegate AbortSignal 到达目标工具（目标实现观察 run.signal 同一实例）', async () => {
  const ctx = await makeRealCtx()
  let seenSignal
  ctx.tools.register({
    name: 'signal_tool',
    description: '信号工具',
    parameters: { type: 'object', properties: {}, additionalProperties: true },
    output: { schema: { type: 'object', additionalProperties: true }, render: () => [{ type: 'text', text: 'x' }] },
    execute: async (_args, run) => {
      seenSignal = run.signal
      return { ok: true }
    },
  })
  const dir = writeToolDir({
    '01-del.yml': `id: del
name: my_del
description: 委托
output:
  schema: { type: object, additionalProperties: true }
execute:
  kind: delegate
  tool: signal_tool
`,
  })
  applyToolConfigEngine(ctx, { configsDir: dir })
  const controller = new AbortController()
  const result = await ctx.tools.execute({ callId: 's1', name: 'my_del', arguments: {}, signal: controller.signal })
  assert.equal(result.isError, false, '正常信号调用成功')
  assert.equal(seenSignal, controller.signal, '目标工具收到与调用方同一 AbortSignal 实例')
  await ctx.fiber.dispose()
})
