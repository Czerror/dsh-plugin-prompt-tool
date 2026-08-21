import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply as applyToolFilter } from '../../engine/tool-filter.mjs'

/** 收集 ctx.on 注册的监听器（按注册顺序）。 */
function makeCtx() {
  const listeners = new Map()
  const ctx = {
    logger: { warn: () => {} },
    on(type, handler, opts) {
      const list = listeners.get(type) ?? []
      list.push({ handler, opts })
      listeners.set(type, list)
    },
  }
  // 测试辅助：把监听器表挂到 ctx 上供 runAssemble 读取。
  ctx.listeners = listeners
  return { ctx }
}

const makeSession = (depth = 0) => ({ id: `s-${Math.random()}`, header: { delegationDepth: depth } })
const makeAgent = (session) => ({ session })
const tool = (name) => ({ name, description: `tool ${name}` })
const assembled = (tools) => ({ sections: [], contexts: [], tools, variables: {} })

/** 直接调用 assemble 瀑布的最终处理结果。 */
async function runAssemble(ctx, agent, assembly) {
  const listeners = ctx.listeners?.get('system-prompt/assemble') ?? []
  const handler = listeners[0]?.handler
  assert.ok(handler, 'tool-filter 应注册 system-prompt/assemble 监听器')
  // listener 内部先 await next() 再处理：next 直接返回原 assembly（无其他层）。
  return handler(assembly, { agent }, async () => assembly)
}

test('tool-filter：allow 白名单只保留列表内工具（含自定义插件工具）', async () => {
  const { ctx } = makeCtx()
  applyToolFilter(ctx, { allow: ['bash', 'my-custom-tool'] })
  const agent = makeAgent(makeSession(0))
  const out = await runAssemble(ctx, agent, assembled([tool('bash'), tool('read'), tool('my-custom-tool'), tool('web_search')]))
  assert.deepEqual(out.tools.map((t) => t.name), ['bash', 'my-custom-tool'])
})

test('tool-filter：deny 黑名单移除列表内工具', async () => {
  const { ctx } = makeCtx()
  applyToolFilter(ctx, { deny: ['web_search', 'bash'] })
  const agent = makeAgent(makeSession(0))
  const out = await runAssemble(ctx, agent, assembled([tool('bash'), tool('read'), tool('web_search')]))
  assert.deepEqual(out.tools.map((t) => t.name), ['read'])
})

test('tool-filter：allow+deny 同用时 deny 在 allow 内再剔除', async () => {
  const { ctx } = makeCtx()
  applyToolFilter(ctx, { allow: ['bash', 'read', 'web_search'], deny: ['web_search'] })
  const agent = makeAgent(makeSession(0))
  const out = await runAssemble(ctx, agent, assembled([tool('bash'), tool('read'), tool('web_search')]))
  assert.deepEqual(out.tools.map((t) => t.name), ['bash', 'read'])
})

test('tool-filter：两者都空 = 不过滤（官方默认）', async () => {
  const { ctx } = makeCtx()
  applyToolFilter(ctx, {})
  const agent = makeAgent(makeSession(0))
  const input = assembled([tool('bash'), tool('read')])
  const out = await runAssemble(ctx, agent, input)
  assert.deepEqual(out.tools.map((t) => t.name), ['bash', 'read'])
})

test('tool-filter：includeSubagents=false 时子代理跳过（保持完整目录）', async () => {
  const { ctx } = makeCtx()
  applyToolFilter(ctx, { allow: ['bash'], includeSubagents: false })
  const agent = makeAgent(makeSession(1))
  const out = await runAssemble(ctx, agent, assembled([tool('bash'), tool('read')]))
  assert.deepEqual(out.tools.map((t) => t.name), ['bash', 'read'], '子代理不被过滤')
})

test('tool-filter：includeSubagents=true 时子代理同样过滤', async () => {
  const { ctx } = makeCtx()
  applyToolFilter(ctx, { allow: ['bash'], includeSubagents: true })
  const agent = makeAgent(makeSession(1))
  const out = await runAssemble(ctx, agent, assembled([tool('bash'), tool('read')]))
  assert.deepEqual(out.tools.map((t) => t.name), ['bash'])
})

test('tool-filter：enabled=false 完全禁用', async () => {
  const { ctx } = makeCtx()
  applyToolFilter(ctx, { allow: ['bash'], enabled: false })
  const listeners = ctx.listeners?.get('system-prompt/assemble') ?? []
  assert.equal(listeners.length, 0, 'enabled=false 不注册监听器')
})

test('tool-filter：配置错误 fail loud', () => {
  const { ctx } = makeCtx()
  assert.throws(() => applyToolFilter(ctx, { allow: 'bash' }), /allow must be an array/)
})
