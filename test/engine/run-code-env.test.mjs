/**
 * run-code-env：注入配置按真实调用 Agent 键控的回归。
 *
 * 官方 ToolRuntime 的 run_code 是进程内单例，多个 Agent 共用同一个定义对象；
 * 真值源是「apply 注册的 Agent 配置」与「本次执行 exec.agent」的对应关系。
 * 断言停在公共行为上：交给原 execute 的 code 是否带 env 前缀、带的是谁的 env。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../../engine/run-code-env.mjs'

const ALPHA = 'DSH_TEST_ENV_ALPHA'
const BETA = 'DSH_TEST_ENV_BETA'
const alice = { id: 'alice', session: { header: { cwd: '/workspace/alice' } } }
const bob = { id: 'bob', session: { header: { cwd: '/workspace/bob' } } }
const execFor = (agent) => ({ name: 'run_code', agent })

/** 两个键互不相同，且都不是 SENSITIVE_ENV_RE 的凭据形态名。 */
function setTestEnv(t) {
  process.env[ALPHA] = 'alpha'
  process.env[BETA] = 'beta'
  t.after(() => {
    delete process.env[ALPHA]
    delete process.env[BETA]
  })
}

/** 最小 fake：一个可挂/可晚到的 run_code 工具、事件表与系统段记录。 */
function makeHarness() {
  const listeners = new Map()
  let tool
  const ctx = {
    tools: {
      get: (name) => (name === 'run_code' ? tool : undefined),
      schemas: () => (tool === undefined ? [] : [{ name: 'run_code' }]),
    },
    on: (event, handler) => {
      const registered = listeners.get(event) ?? []
      registered.push(handler)
      listeners.set(event, registered)
      return () => {}
    },
    systemPrompt: { section: () => () => {} },
    get: () => undefined,
  }
  return {
    ctx,
    mount(value) { tool = value },
    async emit(event) {
      for (const handler of listeners.get(event) ?? []) await handler()
    },
  }
}

function makeTool() {
  const calls = []
  const tool = {
    name: 'run_code',
    async execute(args) {
      calls.push(args)
      return { logs: [], result: args.code }
    },
  }
  return { tool, calls }
}

/** 从注入前缀里取回 env 对象；期望值来自测试自己设置的进程环境。 */
function injectedEnv(code) {
  const literal = /JSON\.parse\(("(?:[^"\\]|\\.)*")\)\);/.exec(code)?.[1]
  assert.ok(literal, 'run_code code 应带冻结 env 前缀')
  return JSON.parse(JSON.parse(literal))
}

test('run-code-env：两个 Agent 各取自己的 envKeys，首挂不固化', async (t) => {
  setTestEnv(t)
  const h = makeHarness()
  const { tool, calls } = makeTool()
  h.mount(tool)

  apply(h.ctx, { enabled: true, envKeys: [ALPHA] }, { agent: alice })
  apply(h.ctx, { enabled: true, envKeys: [BETA] }, { agent: bob })

  // 官方在策略前已深冻结 arguments：wrapper 必须 spread 出新对象。
  await tool.execute(Object.freeze({ code: 'alice code' }), execFor(alice))
  await tool.execute({ code: 'bob code' }, execFor(bob))

  const first = injectedEnv(calls[0].code)
  const second = injectedEnv(calls[1].code)
  assert.equal(first[ALPHA], 'alpha')
  assert.equal(first[BETA], undefined)
  assert.equal(first.DSH_WORKSPACE, '/workspace/alice')
  assert.equal(second[BETA], 'beta')
  assert.equal(second[ALPHA], undefined)
  assert.equal(second.DSH_WORKSPACE, '/workspace/bob')
})

test('run-code-env：一个 Agent dispose 后另一个仍工作，被撤者不再注入', async (t) => {
  setTestEnv(t)
  const h = makeHarness()
  const { tool, calls } = makeTool()
  h.mount(tool)

  const disposeAlice = apply(h.ctx, { enabled: true, envKeys: [ALPHA] }, { agent: alice })
  apply(h.ctx, { enabled: true, envKeys: [BETA] }, { agent: bob })

  await tool.execute({ code: 'before' }, execFor(alice))
  assert.equal(injectedEnv(calls[0].code)[ALPHA], 'alpha')

  disposeAlice()
  await tool.execute({ code: 'bob after' }, execFor(bob))
  assert.equal(injectedEnv(calls[1].code)[BETA], 'beta')

  await tool.execute({ code: 'alice after' }, execFor(alice))
  assert.equal(calls[2].code, 'alice after', 'dispose 后该 Agent 不得回落到首挂或其他 Agent 的配置')
})

test('run-code-env：重复 apply 不重复包装，同一 Agent 的 envKeys 取并集', async (t) => {
  setTestEnv(t)
  const h = makeHarness()
  const { tool, calls } = makeTool()
  h.mount(tool)

  apply(h.ctx, { enabled: true, envKeys: [ALPHA] }, { agent: alice })
  apply(h.ctx, { enabled: true, envKeys: [BETA] }, { agent: alice })
  await tool.execute({ code: 'both' }, execFor(alice))

  const env = injectedEnv(calls[0].code)
  assert.equal(env[ALPHA], 'alpha')
  assert.equal(env[BETA], 'beta')
  assert.equal(calls[0].code.split('const env = Object.freeze(JSON.parse(').length - 1, 1, '只允许一层包装')
})

test('run-code-env：只注册 Agent 配置时，无 agent 执行不注入', async (t) => {
  setTestEnv(t)
  const h = makeHarness()
  const { tool, calls } = makeTool()
  h.mount(tool)

  apply(h.ctx, { enabled: true, envKeys: [ALPHA] }, { agent: alice })
  await tool.execute({ code: 'plain' }, { name: 'run_code' })

  assert.equal(calls[0].code, 'plain')
})

test('run-code-env：无 agent 的 apply 是 default 配置，只服务无 agent 执行', async (t) => {
  setTestEnv(t)
  const h = makeHarness()
  const { tool, calls } = makeTool()
  h.mount(tool)

  apply(h.ctx, { enabled: true, envKeys: [ALPHA] })
  apply(h.ctx, { enabled: true, envKeys: [BETA] }, { agent: alice })

  await tool.execute({ code: 'default' }, { name: 'run_code' })
  await tool.execute({ code: 'agent' }, execFor(alice))

  assert.equal(injectedEnv(calls[0].code)[ALPHA], 'alpha')
  assert.equal(injectedEnv(calls[1].code)[BETA], 'beta')
  assert.equal(injectedEnv(calls[1].code)[ALPHA], undefined, '具名 Agent 不混入 default')
})

test('run-code-env：宿主替换 run_code 定义后配置迁移到新工具', async (t) => {
  setTestEnv(t)
  const h = makeHarness()
  const first = makeTool()
  h.mount(first.tool)
  apply(h.ctx, { enabled: true, envKeys: [ALPHA] }, { agent: alice })
  const second = makeTool()
  h.mount(second.tool)
  await h.emit('tools/change')
  await second.tool.execute({ code: 'new transport' }, execFor(alice))
  assert.equal(injectedEnv(second.calls[0].code)[ALPHA], 'alpha')
})

test('run-code-env：run_code 晚到时由 tools/change 补装，仍按 Agent 分发', async (t) => {
  setTestEnv(t)
  const h = makeHarness()
  const { tool, calls } = makeTool()

  apply(h.ctx, { enabled: true, envKeys: [ALPHA] }, { agent: alice })
  apply(h.ctx, { enabled: true, envKeys: [BETA] }, { agent: bob })
  h.mount(tool)
  await h.emit('tools/change')

  await tool.execute({ code: 'a' }, execFor(alice))
  await tool.execute({ code: 'b' }, execFor(bob))
  assert.equal(injectedEnv(calls[0].code)[ALPHA], 'alpha')
  assert.equal(injectedEnv(calls[1].code)[BETA], 'beta')
})
