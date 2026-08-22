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

import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import { createPromptConfigs } from '../../../engine/schema.mjs'
import { wireLayers } from '../../../engine/layers.mjs'

const MAIN_PERSONA = [
  'You are a helpful assistant.',
  'Before acting, decide the task type (build or fix) and adopt the matching style: build → hands-on production; fix → inspect-and-plan.',
  'Before acting, briefly review what you have already done in this session and continue from where you left off; do not repeat completed steps. Do not run environment checks (echo, whoami, uname, node --version, date) or exhaustive grep/glob scans.',
  'Think deeply first, then produce.',
].join('\n')

/** 官方 registry + 一个第三方段（plan-mode），模拟真实宿主组装环境。 */
async function harness() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {
    includeHarnessIdentity: false,
    persona: 'DEPLOYMENT PERSONA',
  })
  ctx.systemPrompt.section({ name: 'plan-mode', order: 10, text: 'PLAN TEXT' })
  return ctx
}

/** 在 agent scope 挂载 persona 提示词配置（system-section → wireSystemSections 注册）。 */
async function mountPersona(ctx, key, spec) {
  await ctx.plugin(Object.assign((inner) => {
    const scopeCtx = createScope(inner, key).ctx
    wireLayers(scopeCtx, createPromptConfigs([spec]), () => {})
  }, { inject: ['systemPrompt'] }))
}

/** persona 模块规格（system-section + deployment:persona shadow）。 */
function personaSpec(overrides = {}) {
  return {
    id: 'persona-main',
    name: '主会话人设',
    layer: 'system-section',
    strategy: 'static',
    order: 0,
    text: MAIN_PERSONA,
    params: { sectionName: 'deployment:persona' },
    ...overrides,
  }
}

/** 组装并返回 sections 摘要。 */
async function sectionsOf(ctx, key) {
  const assembly = await ctx.systemPrompt.assemble({ scope: key })
  return assembly.sections.map((section) => `${section.name}=${section.text}`)
}

test('主会话首轮即用自定义人设（全模型通用），complete 独占（plan-mode 被清）', async () => {
  const ctx = await harness()
  const key = { agent: 'flash' }
  await mountPersona(ctx, key, personaSpec({ params: { sectionName: 'deployment:persona', complete: true } }))
  assert.deepEqual(await sectionsOf(ctx, key), [
    'deployment:persona=' + MAIN_PERSONA,
  ])
})

test('complete:false 时 shadow 生效但不独占（plan-mode 保留，standard 语义）', async () => {
  const ctx = await harness()
  const key = { agent: 'non-complete' }
  await mountPersona(ctx, key, personaSpec({ params: { sectionName: 'deployment:persona', complete: false } }))
  const sections = await sectionsOf(ctx, key)
  assert.ok(sections.some((line) => line === 'deployment:persona=' + MAIN_PERSONA))
  assert.ok(sections.some((line) => line === 'plan-mode=PLAN TEXT'))
})

test('sectionName 缺省时按配置 id 注册（非 shadow），不遮蔽全局 persona', async () => {
  const ctx = await harness()
  const key = { agent: 'unknown' }
  await mountPersona(ctx, key, personaSpec({ id: 'custom-section', params: {} }))
  const sections = await sectionsOf(ctx, key)
  assert.ok(sections.some((line) => line === 'custom-section=' + MAIN_PERSONA))
  assert.ok(sections.some((line) => line === 'deployment:persona=DEPLOYMENT PERSONA'), '全局 persona 未被遮蔽')
})

test('子代理 scope 不继承 shadow，使用全局 persona（放行语义）', async () => {
  const ctx = await harness()
  const parentKey = { agent: 'parent' }
  await mountPersona(ctx, parentKey, personaSpec({ params: { sectionName: 'deployment:persona', complete: true } }))
  const childKey = { agent: 'child' }
  const child = { options: { model: 'deepseek-v4-flash-7013' }, session: { header: { delegationDepth: 1 } } }
  const assembly = await ctx.systemPrompt.assemble({ scope: childKey, agent: child })
  const persona = assembly.sections.find((section) => section.name === 'deployment:persona')
  assert.equal(persona?.text, 'DEPLOYMENT PERSONA')
})

test('suppressRuntimeContext:true 抑制动态 context；默认保留', async () => {
  const ctx = await harness()
  ctx.systemPrompt.context({ name: 'policy', order: 1, text: 'POLICY' })
  const key = { agent: 'ctx' }
  await mountPersona(ctx, key, personaSpec({ params: { sectionName: 'deployment:persona', complete: true, suppressRuntimeContext: true } }))
  const suppressed = await ctx.systemPrompt.assemble({ scope: key, agent: { options: { model: 'deepseek-v4-flash-7013' } } })
  assert.deepEqual(suppressed.contexts, [])

  const key2 = { agent: 'ctx2' }
  await mountPersona(ctx, key2, personaSpec({ params: { sectionName: 'deployment:persona', complete: true } }))
  const kept = await ctx.systemPrompt.assemble({ scope: key2, agent: { options: { model: 'deepseek-v4-flash-7013' } } })
  assert.equal(kept.contexts[0]?.name, 'policy')
})

test('多个 complete 段 fail loud（官方语义，UI 互斥防呆）', async () => {
  const ctx = await harness()
  const key = { agent: 'dup' }
  await ctx.plugin(Object.assign((inner) => {
    const scopeCtx = createScope(inner, key).ctx
    wireLayers(scopeCtx, createPromptConfigs([
      personaSpec({ id: 'p1', params: { sectionName: 'deployment:persona', complete: true } }),
      personaSpec({ id: 'p2', params: { sectionName: 'other', complete: true } }),
    ]), () => {})
  }, { inject: ['systemPrompt'] }))
  await assert.rejects(
    () => ctx.systemPrompt.assemble({ scope: key }),
    /multiple complete prompt sections/,
  )
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
