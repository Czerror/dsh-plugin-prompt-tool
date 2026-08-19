import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply as applyCustomBash } from '../../../engine/custom-bash.mjs'

function makeTool({ timeoutMs = 30, exitCode = 0, output = '', pending = false } = {}) {
  let registered
  const ctx = {
    subprocess: {
      resolveExecutable: async (path) => `resolved:${path}`,
      spawn: (spec) => {
        const done = new Promise((resolve) => {
          spec.signal?.addEventListener('abort', () => resolve({ exitCode: null, signal: 'SIGTERM' }), { once: true })
          if (!pending) resolve({ exitCode, signal: null })
        })
        return {
          done,
          collected: {
            stdout: { readFrom: () => ({ text: output }) },
            stderr: { readFrom: () => ({ text: '' }) },
          },
        }
      },
    },
    tools: { register: (tool) => { registered = tool } },
  }
  applyCustomBash(ctx, { bashPath: 'C:/git/bin/bash.exe', timeoutMs })
  assert.ok(registered)
  return registered
}

test('timeoutMs 到期后终止进程树并报告超时', async () => {
  const tool = makeTool({ timeoutMs: 20, pending: true })
  await assert.rejects(
    () => tool.execute({ command: 'sleep 100' }, {}),
    /bash timed out after 20ms/,
  )
})

test('exec.signal 中止时报告 aborted 而不是超时', async () => {
  const tool = makeTool({ timeoutMs: 1000, pending: true })
  const controller = new AbortController()
  setTimeout(() => controller.abort(new Error('caller abort')), 10)
  await assert.rejects(
    () => tool.execute({ command: 'sleep 100' }, { signal: controller.signal }),
    /bash aborted: caller abort/,
  )
})

test('正常退出返回输出文本', async () => {
  const tool = makeTool({ exitCode: 0, output: 'hello' })
  const result = await tool.execute({ command: 'echo hello' }, {})
  assert.deepEqual(result, { text: 'hello' })
})

import { apply as applyRouterFirstTurn } from '../../../engine/router-first-turn.mjs'

const FLASH_PERSONA = [
  'You are a helpful assistant.',
  'Before acting, decide the task type (build or fix) and adopt the matching style: build → hands-on production; fix → inspect-and-plan.',
  'Before acting, briefly review what you have already done in this session and continue from where you left off; do not repeat completed steps. Do not run environment checks (echo, whoami, uname, node --version, date) or exhaustive grep/glob scans.',
  'Think deeply first, then produce.',
].join('\n')

function makeStep({ events = [], delegationDepth = 0, model = 'deepseek-v4-pro-8013' } = {}) {
  const listeners = new Map()
  const ctx = { on(name, handler) { listeners.set(name, handler) } }
  applyRouterFirstTurn(ctx, { flashPersona: FLASH_PERSONA, hideSectionPrefixes: ['mnemon:'] })
  const handler = listeners.get('system-prompt/assemble')
  assert.ok(handler)
  const agent = { session: { id: 's1', header: { delegationDepth }, events }, options: { model } }
  return async (assembled) => handler(undefined, { agent }, async () => assembled)
}

test('Pro 首轮替换 persona，保留 plan 与第三方 section，隐藏 mnemon 段，contexts 交给 context-gate', async () => {
  const step = makeStep()
  const out = await step({
    sections: [
      { name: 'persona', text: 'OLD PERSONA', order: 0 },
      { name: 'plan-mode', text: 'PLAN TEXT', order: 10 },
      { name: 'mnemon:runtime-memory', text: 'MEMORY', order: 145 },
    ],
    contexts: [{ name: 'auto', text: 'AUTO' }],
    tools: [{ name: 'bash' }],
  })
  assert.deepEqual(out.sections.map((s) => s.name), ['plan-mode', 'router-persona'])
  assert.equal(out.sections.at(-1).text, 'You are a helpful software engineer assistant.')
  assert.deepEqual(out.contexts, [{ name: 'auto', text: 'AUTO' }])
  assert.deepEqual(out.tools, [{ name: 'bash' }])
})

test('Flash 主会话首轮使用 router 的 Flash 弱路由人设', async () => {
  const step = makeStep({ model: 'deepseek-v4-flash-7013' })
  const out = await step({
    sections: [{ name: 'persona', text: 'OLD' }],
    contexts: [],
  })
  const persona = out.sections.find((s) => s.name === 'router-persona')
  assert.ok(persona)
  assert.match(persona.text, /decide the task type \(build or fix\)/)
  assert.match(persona.text, /Do not run environment checks/)
  assert.match(persona.text, /Think deeply first, then produce\./)
})

test('晋升后恢复 contexts 与 mnemon 记忆段', async () => {
  const step = makeStep({ events: [{ type: 'tool/call', seq: 1, time: 1, data: {} }] })
  const out = await step({
    sections: [{ name: 'persona', text: 'OLD' }, { name: 'mnemon:runtime-memory', text: 'MEMORY' }],
    contexts: [{ name: 'auto', text: 'AUTO' }],
  })
  assert.deepEqual(out.contexts, [{ name: 'auto', text: 'AUTO' }])
  assert.ok(out.sections.some((s) => s.name === 'mnemon:runtime-memory'))
})

test('首条 assistant 消息（无工具调用）也视为晋升并恢复 mnemon 段', async () => {
  const step = makeStep({ events: [{ type: 'assistant/message', seq: 1, time: 1, data: { message: { content: [{ type: 'text', text: 'ok' }] } } }] })
  const out = await step({
    sections: [{ name: 'persona', text: 'OLD' }, { name: 'mnemon:runtime-memory', text: 'MEMORY' }],
    contexts: [{ name: 'auto', text: 'AUTO' }],
  })
  assert.ok(out.sections.some((s) => s.name === 'mnemon:runtime-memory'))
})

test('子代理原样返回，不裁剪 section/context', async () => {
  const step = makeStep({ delegationDepth: 1 })
  const assembled = {
    sections: [{ name: 'persona', text: 'OLD' }, { name: 'plan-mode', text: 'PLAN' }],
    contexts: [{ name: 'auto', text: 'AUTO' }],
    tools: [{ name: 'mnemon_recall' }],
  }
  const out = await step(assembled)
  assert.deepEqual(out, assembled)
})

test('agent 缺失时原样返回', async () => {
  const listeners = new Map()
  applyRouterFirstTurn({ on: (name, handler) => listeners.set(name, handler) }, { flashPersona: FLASH_PERSONA })
  const handler = listeners.get('system-prompt/assemble')
  const out = await handler(undefined, {}, async () => ({ sections: [] }))
  assert.deepEqual(out, { sections: [] })
})

import {
  apply,
  buildEnv,
  injectEnvPrefix,
  normalizeEnvKeys,
} from '../../../engine/run-code-env.mjs'

/** 从注入后的 code 里把 env 对象解出来。 */
function parseInjectedEnv(code) {
  const marker = 'JSON.parse('
  const start = code.indexOf(marker) + marker.length
  const end = code.indexOf('));\n', start)
  assert.notEqual(start - marker.length, -1, 'code 应包含 JSON.parse 前缀')
  assert.notEqual(end, -1, 'code 应有结束标记 ')
  const literal = code.slice(start, end)
  return JSON.parse(JSON.parse(literal))
}

function makeHarness({
  enabled = true,
  envKeys,
  schemas = [{ name: 'run_code' }],
  shellEnv,
} = {}) {
  const listeners = new Map()
  let section
  const runTool = {
    name: 'run_code',
    execute: async (args) => ({ code: args.code }),
  }
  const ctx = {
    on(name, handler) { listeners.set(name, handler) },
    get(name) { return name === 'shellEnv' ? shellEnv : undefined },
    tools: {
      get(name) { return name === 'run_code' ? runTool : undefined },
      schemas() { return schemas },
    },
    systemPrompt: {
      section(sectionDef) { section = sectionDef },
    },
  }
  apply(ctx, { enabled, envKeys })
  const assemble = async (scope = {}) => {
    const handler = listeners.get('system-prompt/assemble')
    assert.ok(handler, '应注册 system-prompt/assemble 监听')
    return handler({}, { scope }, async () => ({}))
  }
  const execute = async (exec) => {
    const handler = listeners.get('tools/execute')
    assert.ok(handler, '应注册 tools/execute 监听')
    return handler(exec, async () => ({}))
  }
  return { runTool, assemble, execute, getSection: () => section }
}

test('run_code 执行时自动注入冻结 env 全局（含白名单系统变量）', async () => {
  const { runTool, assemble } = makeHarness()
  await assemble({ scope: 'agent-scope' })
  const result = await runTool.execute(
    { code: 'return 1', description: 'probe' },
    { agent: { session: { header: { cwd: 'C:/work' } } } },
  )
  assert.match(result.code, /^const env = Object\.freeze\(JSON\.parse\(/)
  const env = parseInjectedEnv(result.code)
  assert.equal(env.DSH_WORKSPACE, 'C:/work')
  if (process.env.PATH !== undefined) {
    assert.equal(env.PATH, process.env.PATH)
  }
  assert.equal(env.PASSWORD, undefined)
  assert.equal(env.DEEPSEEK_API_KEY, undefined)
})

test('敏感名键（KEY/PASSWORD/SECRET/TOKEN）永远不会进入 env', async () => {
  const probeKey = 'RUN_CODE_ENV_TEST_TOKEN'
  process.env[probeKey] = 'should-never-leak'
  try {
    const { runTool, assemble } = makeHarness({ envKeys: [probeKey] })
    await assemble()
    const result = await runTool.execute({ code: 'return 1', description: 'probe' }, { agent: undefined })
    const env = parseInjectedEnv(result.code)
    assert.equal(env[probeKey], undefined)
  } finally {
    delete process.env[probeKey]
  }
})

test('受管 DSH_* 快照与白名单合并', async () => {
  const shellEnv = { collect: () => ({ DSH_HOME: '/managed/dsh', DSH_SESSION_ID: 's1' }) }
  const { runTool, assemble } = makeHarness({ shellEnv })
  await assemble()
  const result = await runTool.execute({ code: 'return 1', description: 'probe' }, { agent: { session: { header: {} } } })
  const env = parseInjectedEnv(result.code)
  assert.equal(env.DSH_HOME, '/managed/dsh')
  assert.equal(env.DSH_SESSION_ID, 's1')
})

test('shellEnv 缺失时 DSH_HOME 回退到宿主进程环境变量的真实位置', async () => {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = 'D:/AI/DeepSeek harness/.dsh'
  try {
    const { runTool, assemble } = makeHarness()
    await assemble()
    const result = await runTool.execute({ code: 'return 1', description: 'probe' }, { agent: { session: { header: {} } } })
    const env = parseInjectedEnv(result.code)
    assert.equal(env.DSH_HOME, 'D:/AI/DeepSeek harness/.dsh')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('shellEnv 的受管 DSH_HOME 优先于进程环境 fallback', async () => {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = 'D:/stale/dsh'
  try {
    const shellEnv = { collect: () => ({ DSH_HOME: 'D:/managed/dsh' }) }
    const { runTool, assemble } = makeHarness({ shellEnv })
    await assemble()
    const result = await runTool.execute({ code: 'return 1', description: 'probe' }, { agent: { session: { header: {} } } })
    const env = parseInjectedEnv(result.code)
    assert.equal(env.DSH_HOME, 'D:/managed/dsh')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('tools/execute 是首条 run_code 的兜底 patch 通道', async () => {
  const { runTool, execute } = makeHarness()
  await execute({ name: 'run_code', agent: { session: { header: {} } } })
  const result = await runTool.execute({ code: 'return 2', description: 'probe' }, { agent: undefined })
  assert.match(result.code, /^const env = Object\.freeze/)
})

test('enabled=false 时不 patch、不注册提示段', async () => {
  const { runTool, assemble, getSection } = makeHarness({ enabled: false })
  await assemble()
  const result = await runTool.execute({ code: 'return 3', description: 'probe' }, { agent: undefined })
  assert.equal(result.code, 'return 3')
  assert.equal(getSection(), undefined)
})

test('native（无 run_code schema）时提示段为空', async () => {
  const { assemble, getSection } = makeHarness({ schemas: [] })
  await assemble()
  const section = getSection()
  assert.ok(section)
  assert.equal(section.text({ scope: 'agent-scope' }), '')
})

test('PTC 时提示段列出 env 用法与可用键', async () => {
  const { getSection } = makeHarness()
  const text = getSection().text({ scope: 'agent-scope' })
  assert.match(text, /run_code environment/)
  assert.match(text, /env\./)
  assert.match(text, /DSH_WORKSPACE/)
})

test('normalizeEnvKeys：缺省/空数组回退默认，去重并保留自定义', () => {
  assert.deepEqual(normalizeEnvKeys(undefined), [
    'PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'USERNAME', 'COMPUTERNAME',
    'OS', 'TEMP', 'TMP', 'SystemRoot', 'ProgramFiles', 'ProgramFiles(x86)',
    'LOCALAPPDATA', 'APPDATA',
  ])
  assert.equal(normalizeEnvKeys([]).includes('PATH'), true)
  assert.deepEqual(normalizeEnvKeys(['FOO', 'FOO', 'BAR']), ['FOO', 'BAR'])
})

test('injectEnvPrefix 生成可解析且原始 code 保持在最后一行', () => {
  const code = injectEnvPrefix('return env.HOME', { HOME: 'C:/Users/x' })
  assert.match(code, /^const env = Object\.freeze\(JSON\.parse\(/)
  assert.ok(code.endsWith('\nreturn env.HOME'))
  assert.equal(parseInjectedEnv(code).HOME, 'C:/Users/x')
})

test('buildEnv 直接调用同样合并 shellEnv 与工作区', () => {
  const ctx = {
    get(name) {
      if (name === 'shellEnv') return { collect: () => ({ DSH_HOME: '/h' }) }
      return undefined
    },
  }
  const env = buildEnv(ctx, ['HOME'], { session: { header: { cwd: '/repo' } } })
  assert.equal(env.DSH_HOME, '/h')
  assert.equal(env.DSH_WORKSPACE, '/repo')
  if (process.env.HOME !== undefined) assert.equal(env.HOME, process.env.HOME)
})
