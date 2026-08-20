import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { applyPromptConfigs, createPromptConfigs as createPromptConfigsCore, inject, loadPromptConfigFiles, parsePromptConfigYaml } from '../../engine/prompt-config-engine.mjs'

/** 引擎测试夹具使用包内 engine 目录作为自定义策略探测目录;内置策略不依赖 strategyDir。 */
const STRATEGY_DIR = new URL('../../engine/', import.meta.url).href
const createPromptConfigs = (specs, options = {}) =>
  createPromptConfigsCore(specs, { strategyDir: STRATEGY_DIR, ...options })

const userTask = {
  id: 'task-1',
  role: 'user',
  content: [{ type: 'text', text: '写一个工具' }],
  source: { kind: 'user' },
}

function makeHarness(configs, services = {}) {
  const listeners = new Map()
  const warnings = []
  const ctx = { on(name, handler) { listeners.set(name, handler) }, get(name) { return services[name] }, logger: { warn(message) { warnings.push(message) } } }
  applyPromptConfigs(ctx, Array.isArray(configs) ? configs : createPromptConfigs(configs))
  const handler = listeners.get('agent/pre-step')
  assert.ok(handler, 'pre-step listener registered')
  const step = async (agent, messages = [userTask], kind = 'ok') =>
    handler({ agent }, async () => ({ kind, messages }))
  return { step, warnings }
}

const agent = (overrides = {}) => ({
  session: {
    id: 's1',
    header: { delegationDepth: 0 },
    events: [],
  },
  options: { model: 'deepseek-v4-flash-7013' },
  ...overrides,
})

test('parsePromptConfigYaml 解析嵌套 identity 与 block scalar 文本', () => {
  const doc = parsePromptConfigYaml([
    'id: prompt-injector',
    'strategy: custom-fallback',
    'params:',
    '  text: |-',
    '    line one',
    '    line two',
    'identity:',
    '  field: plugin',
    '  value: prompt-injector',
    '# full-line comment',
  ].join('\n'))
  assert.equal(doc.id, 'prompt-injector')
  assert.equal(doc.strategy, 'custom-fallback')
  assert.equal(createPromptConfigs([{ id: 'legacy', strategy: 'custom-fallback' }])[0].strategy, 'custom-fallback')
  assert.equal(createPromptConfigs([{ id: 'legacy', strategy: 'anchor-fallback' }])[0].strategy, 'anchor-fallback') // 已移除兼容别名归一化，策略名原样透传（bindResolver 阶段 fail loud）
  assert.equal(doc.params.text, 'line one\nline two')
  assert.deepEqual(doc.identity, { field: 'plugin', value: 'prompt-injector' })
})

test('loadPromptConfigFiles 按文件名排序扫描 yml 与 json，且跳过其他文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-tool-configs-'))
  try {
    writeFileSync(join(dir, '20-b.json'), JSON.stringify({ id: 'b', strategy: 'static', text: 'B' }))
    writeFileSync(join(dir, '10-a.yml'), 'id: a\nstrategy: static\ntext: A\n')
    writeFileSync(join(dir, 'ignore.txt'), 'x')
    const specs = loadPromptConfigFiles(pathToFileURL(dir + '/'))
    assert.deepEqual(specs.map((spec) => spec.id), ['a', 'b'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('同位置多配置默认按声明顺序插入：near-anchor 与 router-guide 依次紧跟用户消息', async () => {
  const { step } = makeHarness(createPromptConfigs([
    {
      id: 'near-anchor',
      enabled: true,
      strategy: 'first-turn-anchor',
      position: 'after-user',
      dedupe: 'session',
      promotion: 'none',
      subagents: 'none',
      params: {
        buildPattern: 'build',
        complexPattern: 'complex',
        firstTurnBuild: 'BUILD',
        firstTurnInspect: 'INSPECT',
        firstTurnDeep: 'DEEP',
      },
    },
    {
      id: 'router-guide',
      enabled: true,
      strategy: 'guide-auto',
      position: 'after-user',
      dedupe: 'batch',
      promotion: 'main',
      subagents: 'none',
      modelScope: 'flash',
      params: {
        guideComplexPattern: 'complex',
        guideWeak: 'WEAK',
        guideDeep: 'DEEP',
      },
    },
  ]))
  const decision = await step(agent({ session: {
    id: 's2',
    header: { delegationDepth: 0 },
    events: [{ type: 'tool/call', seq: 1, time: 1, data: {} }],
  } }))
  assert.equal(decision.messages.length, 3)
  assert.equal(decision.messages[0].id, 'task-1')
  assert.equal(decision.messages[1].source.plugin, 'near-anchor')
  assert.equal(decision.messages[2].source.plugin, 'router-guide')
})

test('order 决定同位置插入顺序与 merged 拼接顺序', async () => {
  const { step } = makeHarness(createPromptConfigs([
  { id: 'p-later', strategy: 'static', text: 'LATER', position: 'after-user', order: 1 },
  { id: 'p-first', strategy: 'static', text: 'FIRST', position: 'after-user', order: 0 },
  { id: 'm-b', strategy: 'static', text: 'B', position: 'after-all', mergeMode: 'merged', order: 1 },
  { id: 'm-a', strategy: 'static', text: 'A', position: 'after-all', mergeMode: 'merged', order: 0 },
  ]))
  const decision = await step(agent())
  assert.equal(decision.messages[1].content[0].text, 'FIRST')
  assert.equal(decision.messages[2].content[0].text, 'LATER')
  const merged = decision.messages[3]
  assert.deepEqual(merged.content.map((block) => block.text), ['A', 'B'])
})

test('单条提示词配置 resolve 抛错时只跳过该提示词配置，其他提示词配置照常注入', async () => {
  const okConfigs = createPromptConfigs([{
    id: 'ok', enabled: true, strategy: 'static', position: 'after-all', text: 'OK',
  }])
  const { step } = makeHarness([
    {
      id: 'broken', enabled: true, strategy: 'static', position: 'after-all',
      identity: { field: 'plugin', value: 'broken' },
      resolve: () => { throw new Error('boom') },
    },
    ...okConfigs,
  ])
  const decision = await step(agent())
  assert.equal(decision.messages.length, 2)
  assert.equal(decision.messages[1].content[0].text, 'OK')
})

test('identity 归一：kind 维度去重由 sourceKind 承担（外来消息按 kind 匹配）', async () => {
  const { step } = makeHarness(createPromptConfigs([{
    id: 'instruction-hint',
    strategy: 'static',
    text: 'HINT',
    position: 'after-all',
    dedupe: 'session',
    promotion: 'include-subagents',
    subagents: 'inherit',
    sourceKind: 'instruction-hint',
  }]))
  const withEvent = agent({ session: {
    id: 's3',
    header: { delegationDepth: 0 },
    events: [
      { type: 'tool/call', seq: 1, time: 1, data: {} },
      { type: 'user/message', data: { source: { kind: 'instruction-hint', form: 'hint' } } },
    ],
  } })
  const decision = await step(withEvent)
  assert.equal(decision.messages.length, 1)
})

test('createPromptConfigs 默认 layer=pre-step；未知 layer fail loud', () => {
  assert.equal(createPromptConfigs([{ id: 'x', strategy: 'static' }])[0].layer, 'pre-step')
  assert.throws(() => createPromptConfigs([{ id: 'x', layer: 'nope' }]), /unknown layer/)
})

test('system-section 服务缺失时降级跳过，pre-step 提示词配置照常注入', async () => {
  const { step } = makeHarness(createPromptConfigs([
    { id: 'sys-section', layer: 'system-section', strategy: 'static', text: 'SYS', position: 'after-all' },
    { id: 'pre', layer: 'pre-step', strategy: 'static', text: 'PRE', position: 'after-all' },
  ]))
  const decision = await step(agent())
  assert.equal(decision.messages.length, 2)
  assert.equal(decision.messages[1].content[0].text, 'PRE')
})

test('inject 声明等待全部注入层级的宿主服务', () => {
  assert.deepEqual(inject, ['systemPrompt', 'tools', 'llm'])
})

/** 带服务桩的 harness：验证非 pre-step 层级的官方通道接线。 */
function makeWiredHarness(configSpecs, services = {}) {
  const listeners = new Map()
  const sections = []
  const contexts = []
  const disposed = []
  const ctx = {
    on(name, handler) {
      listeners.set(name, handler)
      return () => listeners.delete(name)
    },
    get(name) { return services[name] },
    effect(callback) {
      const cleanup = callback()
      if (typeof cleanup === 'function') disposed.push(cleanup)
    },
    logger: { warn() {} },
  }
  applyPromptConfigs(ctx, createPromptConfigs(configSpecs))
  return { listeners, sections, contexts, disposed }
}

test('system-section 与 runtime-context 注册到 systemPrompt 服务', () => {
  const sections = []
  const contexts = []
  const disposed = []
  const harness = makeWiredHarness([
    { id: 'sys', layer: 'system-section', strategy: 'static', text: '身份 {{WHO}}', variables: { WHO: '李雷' }, order: -50, params: { complete: true } },
    { id: 'ctx', layer: 'runtime-context', strategy: 'static', text: '环境 {{DSH_HOME}}', order: 5 },
  ], {
    systemPrompt: {
      section(def) { sections.push(def); return () => disposed.push(def.name) },
      context(def) { contexts.push(def); return () => disposed.push(def.name) },
    },
  })
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'sys')
  assert.equal(sections[0].order, -50)
  assert.equal(sections[0].complete, true)
  assert.equal(sections[0].text, '身份 李雷')
  assert.equal(contexts.length, 1)
  assert.equal(contexts[0].name, 'ctx')
  assert.equal(contexts[0].order, 5)
  assert.equal(contexts[0].text, '环境 {{DSH_HOME}}')
  // 注册 disposer 已挂到 fiber 效果表；手动执行后服务侧收到两个注销。
  assert.equal(harness.disposed.length, 2)
  for (const cleanup of harness.disposed) cleanup()
  assert.deepEqual(disposed, ['sys', 'ctx'])
})

test('agent-request 提示词配置浅合并 LlmCallConfig，并遵守 modelScope', async () => {
  const { listeners } = makeWiredHarness([
    { id: 'patch', layer: 'agent-request', strategy: 'static', params: { patch: { maxTokens: 2048, temperature: 0.5 } } },
  ])
  const handler = listeners.get('agent/request')
  assert.ok(handler)
  const pro = { agent: { session: { header: { delegationDepth: 0 } }, options: { model: 'deepseek-v4-pro-8013' } } }
  const base = async () => ({ provider: 'p', model: 'm', maxTokens: 1000 })
  assert.deepEqual(await handler(pro, base), { provider: 'p', model: 'm', maxTokens: 2048, temperature: 0.5 })
})

test('agent-request 提示词配置 replace=true 整体替换，且 flash 作用域对 Pro 透传', async () => {
  const { listeners } = makeWiredHarness([
    { id: 'replace', layer: 'agent-request', strategy: 'static', modelScope: 'flash', params: { replace: true, patch: { provider: 'r', model: 'm2' } } },
  ])
  const handler = listeners.get('agent/request')
  const base = async () => ({ provider: 'p', model: 'm', maxTokens: 1000 })
  const flash = { agent: { session: { header: { delegationDepth: 0 } }, options: { model: 'deepseek-v4-flash-7013' } } }
  assert.deepEqual(await handler(flash, base), { provider: 'r', model: 'm2' })
  const pro = { agent: { session: { header: { delegationDepth: 0 } }, options: { model: 'deepseek-v4-pro-8013' } } }
  assert.deepEqual(await handler(pro, base), { provider: 'p', model: 'm', maxTokens: 1000 })
})

test('llm-stream 提示词配置 replace 模式用提示词配置文本替代模型流，作用域外透传', async () => {
  const { listeners } = makeWiredHarness([
    { id: 'replace', layer: 'llm-stream', strategy: 'static', text: 'HI', modelScope: 'flash', params: { mode: 'replace' } },
  ])
  const handler = listeners.get('llm/stream')
  assert.ok(handler)
  const flashOptions = { provider: 'p', model: 'deepseek-v4-flash-7013', messages: [] }
  const chunks = []
  for await (const chunk of handler(flashOptions, async function* () { yield { type: 'usage', usage: {} } })) chunks.push(chunk)
  assert.equal(chunks.length, 3)
  assert.equal(chunks[0].type, 'block-start')
  assert.equal(chunks[1].text, 'HI')
  assert.deepEqual(chunks[2].block, { type: 'text', text: 'HI' })
  const proOptions = { provider: 'p', model: 'deepseek-v4-pro-8013', messages: [] }
  const passed = []
  for await (const chunk of handler(proOptions, async function* () { yield 'PASSED' })) passed.push(chunk)
  assert.deepEqual(passed, ['PASSED'])
})

test('llm-stream 提示词配置 pass 模式透传原始流', async () => {
  const { listeners } = makeWiredHarness([
    { id: 'pass', layer: 'llm-stream', strategy: 'static', text: 'X', params: { mode: 'pass' } },
  ])
  const handler = listeners.get('llm/stream')
  const chunks = []
  for await (const chunk of handler({ provider: 'p', model: 'deepseek-v4-pro-8013' }, async function* () { yield 'PASSED' })) chunks.push(chunk)
  assert.deepEqual(chunks, ['PASSED'])
})

test('tool-pipeline 提示词配置接入 pre/post 官方事件（execute 为透传包装点，未注册空壳）', async () => {
  const { listeners } = makeWiredHarness([{
    id: 'tp', layer: 'tool-pipeline', strategy: 'static', text: 'REPLACED',
    params: { toolNames: 'bash', preDecision: 'deny', denyReason: 'no bash', postAction: 'replace' },
  }])
  const exec = { name: 'bash', agent: { session: { header: { delegationDepth: 0 } }, options: { model: 'deepseek-v4-pro-8013' } } }
  const other = { name: 'read', agent: exec.agent }

  const pre = listeners.get('tools/pre-execute')
  assert.ok(pre)
  assert.deepEqual(await pre(exec, async () => ({ kind: 'allow' })), { kind: 'deny', reason: 'no bash' })
  assert.deepEqual(await pre(other, async () => ({ kind: 'allow' })), { kind: 'allow' })

  const post = listeners.get('tools/post-execute')
  assert.ok(post)
  const replaced = await post(exec, { isError: false, content: [] }, async () => ({ kind: 'accept' }))
  assert.deepEqual(replaced, { kind: 'accept', content: [{ type: 'text', text: 'REPLACED' }] })
  assert.deepEqual(await post(other, { isError: false, content: [] }, async () => ({ kind: 'accept' })), { kind: 'accept' })
})

test('configKind/order 排序：anchor 提示词配置保持文件序在前，ordered 提示词配置按 order 升序', () => {
  const runtime = createPromptConfigs([
    { id: 'z-last', configKind: 'ordered', order: 30, strategy: 'static' },
    { id: 'anchor-b', configKind: 'anchor', strategy: 'static' },
    { id: 'a-first', configKind: 'ordered', order: 10, strategy: 'static' },
    { id: 'anchor-a', configKind: 'anchor', strategy: 'static' },
    { id: 'mid', configKind: 'ordered', order: 20, strategy: 'static' },
  ])
  assert.deepEqual(runtime.map((config) => config.id), ['anchor-b', 'anchor-a', 'a-first', 'mid', 'z-last'])
})

test('同 group 且 exclusive=true 时只执行排序后的第一个 enabled 提示词配置', async () => {
  const { step } = makeHarness(createPromptConfigs([
    { id: 'mode-b', group: 'mode', exclusive: true, order: 20, enabled: true, strategy: 'static', text: 'B', position: 'after-all' },
    { id: 'mode-a', group: 'mode', exclusive: true, order: 10, enabled: true, strategy: 'static', text: 'A', position: 'after-all' },
  ]))
  const decision = await step(agent())
  assert.equal(decision.messages.length, 2)
  assert.equal(decision.messages[1].content[0].text, 'A')
})

test('config.variables 与内置 {{WORKSPACE}} 变量在注入前插值', async () => {
  const { step } = makeHarness(createPromptConfigs([{
    id: 'vars', strategy: 'static', text: '用户 {{USER}} 在工作区 {{WORKSPACE}}（cwd={{CWD}}）',
    variables: { USER: '张三' }, position: 'after-all',
  }]))
  const decision = await step(agent({ session: {
    id: 'v1', header: { delegationDepth: 0, cwd: 'D:/repo' }, events: [],
  } }))
  assert.equal(decision.messages[1].content[0].text, '用户 张三 在工作区 D:/repo（cwd=D:/repo）')
})

test('role=assistant 提示词配置按 assistant 消息构造', async () => {
  const { step } = makeHarness(createPromptConfigs([{
    id: 'asst', strategy: 'static', text: 'PREVIEW', role: 'assistant', position: 'after-all',
  }]))
  const decision = await step(agent())
  assert.equal(decision.messages[1].role, 'assistant')
  assert.equal(decision.messages[1].content[0].text, 'PREVIEW')
})

test('placeholder：env-facts 注入默认机器事实，未知 fill fail loud', async () => {
  const { step } = makeHarness(createPromptConfigs([{
    id: 'env-facts', strategy: 'placeholder', fill: 'env-facts', position: 'after-all',
  }]))
  const decision = await step(agent())
  assert.equal(decision.messages.length, 2)
  assert.match(decision.messages[1].content[0].text, /Environment facts:/)
  assert.match(decision.messages[1].content[0].text, /DSH_HOME=/)
  assert.throws(() => createPromptConfigs([{ id: 'x', strategy: 'placeholder', fill: 'nope' }]), /requires fill/)
})

test('placeholder：env-facts 支持 text 模板 + 变量完全自定义输出', async () => {
  const { step } = makeHarness(createPromptConfigs([{
    id: 'env-facts-template', strategy: 'placeholder', fill: 'env-facts', position: 'after-all',
    text: '工作区={{WORKSPACE}}，cwd={{CWD}}',
  }]))
  const decision = await step(agent({ session: {
    id: 'eft', header: { delegationDepth: 0, cwd: 'D:/repo' }, events: [],
  } }))
  assert.equal(decision.messages[1].content[0].text, '工作区=D:/repo，cwd=D:/repo')
})



/** 技能目录 stub：两个本插件技能 + 一个第三方技能。 */
const skillCatalogStub = {
  list: async () => [
    { name: 'pdf', description: 'PDF 转换与合并', whenToUse: '处理文档时使用', provider: 'prompt-tool' },
    { name: 'game-review', description: '游戏评测', provider: 'prompt-tool' },
    { name: 'third', description: '第三方技能', provider: 'other' },
  ],
}

test('placeholder：skill-catalog 服务缺失时跳过且不注入', async () => {
  const { step } = makeHarness(createPromptConfigs([
    { id: 'sk-missing', strategy: 'placeholder', fill: 'skill-catalog', position: 'after-all' },
  ]))
  const decision = await step(agent())
  assert.equal(decision.messages.length, 1)
})

test('placeholder：skill-catalog 默认注入 name+description 目录并输出统计变量', async () => {
  const { step } = makeHarness(createPromptConfigs([
    { id: 'sk-default', strategy: 'placeholder', fill: 'skill-catalog', position: 'after-all' },
  ]), { skills: skillCatalogStub })
  const decision = await step(agent())
  const text = decision.messages[1].content[0].text
  assert.match(text, /Available skills \(3\):/)
  assert.match(text, /- pdf: PDF 转换与合并/)
  assert.match(text, /- game-review: 游戏评测/)
  assert.doesNotMatch(text, /适用：处理文档时使用/)
})

test('placeholder：skill-catalog 支持 providers / fields / limit / text 模板', async () => {
  const { step } = makeHarness(createPromptConfigs([
    {
      id: 'sk-custom', strategy: 'placeholder', fill: 'skill-catalog', position: 'after-all',
      params: { providers: 'prompt-tool', fields: 'name,whenToUse', limit: 1 },
      text: '共 {{SKILL_COUNT}} 个：{{SKILL_NAMES}}\n{{SKILLS_TEXT}}',
    },
  ]), { skills: skillCatalogStub })
  const decision = await step(agent())
  assert.equal(decision.messages[1].content[0].text, '共 2 个：pdf, game-review\n- pdf: 适用：处理文档时使用')
})

test('placeholder：skill-catalog 无技能时默认跳过，emptyBehavior=text 注入提示', async () => {
  const emptyStub = { list: async () => [] }
  const skip = makeHarness(createPromptConfigs([
    { id: 'sk-empty', strategy: 'placeholder', fill: 'skill-catalog', position: 'after-all' },
  ]), { skills: emptyStub })
  assert.equal((await skip.step(agent())).messages.length, 1)
  const inject = makeHarness(createPromptConfigs([
    { id: 'sk-empty-text', strategy: 'placeholder', fill: 'skill-catalog', position: 'after-all',
      params: { emptyBehavior: 'text', emptyText: '暂无技能' } },
  ]), { skills: emptyStub })
  const decision = await inject.step(agent())
  assert.equal(decision.messages[1].content[0].text, '暂无技能')
})

test('placeholder：skill-catalog list 失败时跳过该配置并告警一次，其他配置照常注入', async () => {
  const { step, warnings } = makeHarness(createPromptConfigs([
    { id: 'sk-fail', strategy: 'placeholder', fill: 'skill-catalog', position: 'after-all' },
    { id: 'ok', strategy: 'static', text: 'OK', position: 'after-all' },
  ]), { skills: { list: async () => { throw new Error('boom') } } })
  const decision = await step(agent())
  assert.equal(decision.messages[1].content[0].text, 'OK')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /skill-catalog config sk-fail failed/)
})


test('placeholder：skill-catalog dedupe=session 每会话只注入一次', async () => {
  const { step } = makeHarness(createPromptConfigs([
    { id: 'sk-dedupe', strategy: 'placeholder', fill: 'skill-catalog', position: 'after-all', dedupe: 'session' },
  ]), { skills: skillCatalogStub })
  const session = { id: 'sk-session', header: { delegationDepth: 0 }, events: [] }
  const first = await step(agent({ session }))
  assert.equal(first.messages.length, 2)
  const second = await step(agent({ session }))
  assert.equal(second.messages.length, 1)
})

test('runtime-context placeholder：skill-catalog 每次 assembly 动态填充', async () => {
  const contexts = []
  const skills = { list: async () => [{ name: 'pdf', description: 'PDF 转换', provider: 'prompt-tool' }] }
  makeWiredHarness([
    { id: 'ctx-skill', layer: 'runtime-context', strategy: 'placeholder', fill: 'skill-catalog', order: 5,
      text: '技能={{SKILL_NAMES}}' },
  ], {
    systemPrompt: {
      section() { return () => {} },
      context(def) { contexts.push(def); return () => {} },
    },
    skills,
  })
  assert.equal(contexts.length, 1)
  assert.equal(typeof contexts[0].text, 'function')
  const text = await contexts[0].text({ agent: agent({ session: { id: 'ctx2', header: { delegationDepth: 0, cwd: 'D:/repo' }, events: [] } }) })
  assert.equal(text, '技能=pdf')
})

test('placeholder 仅允许 pre-step 或 runtime-context 层', () => {
  assert.throws(() => createPromptConfigs([{ id: 'bad', strategy: 'placeholder', fill: 'env-facts', layer: 'system-section' }]), /supports layer pre-step or runtime-context only/)
})

test('subagents=only 的 pre-step 配置：仅子代理注入，主会话跳过', async () => {
  const { step } = makeHarness(createPromptConfigs([
    { id: 'sub-only', strategy: 'static', text: 'SUB', position: 'after-all', subagents: 'only' },
  ]))
  const main = await step(agent())
  assert.equal(main.messages.length, 1)
  const delegated = await step(agent({ session: {
    id: 'sub1', header: { delegationDepth: 1 }, events: [],
  } }))
  assert.equal(delegated.messages.length, 2)
  assert.equal(delegated.messages[1].content[0].text, 'SUB')
})

test('subagents=only 的 agent-request 配置：仅子代理 patch，主会话透传', async () => {
  const { listeners } = makeWiredHarness([
    { id: 'req-only', layer: 'agent-request', strategy: 'static', subagents: 'only', params: { patch: { maxTokens: 1234 } } },
  ])
  const handler = listeners.get('agent/request')
  const base = async () => ({ provider: 'p', model: 'm', maxTokens: 1000 })
  const mainAgent = { session: { header: { delegationDepth: 0 } }, options: { model: 'deepseek-v4-pro-8013' } }
  assert.deepEqual(await handler({ agent: mainAgent }, base), { provider: 'p', model: 'm', maxTokens: 1000 })
  const subAgent = { session: { header: { delegationDepth: 1 } }, options: { model: 'deepseek-v4-pro-8013' } }
  assert.deepEqual(await handler({ agent: subAgent }, base), { provider: 'p', model: 'm', maxTokens: 1234 })
})

test('createPromptConfigs 对未知 strategy 配置 fail loud', () => {
  // 未声明 strategyDir 时,模板专属/未知策略必须 fail loud(挂载期暴露)。
  assert.throws(() => createPromptConfigsCore([{ id: 'x', strategy: 'nope' }]), /unknown strategy/)
  // 声明 strategyDir 后允许懒加载;策略模块本身缺失的错误在 resolve 时刻暴露。
  const config = createPromptConfigs([{ id: 'x', strategy: 'nope' }])[0]
  assert.equal(config.strategy, 'nope')
  assert.equal(typeof config.resolve, 'function')
})

test('config 文件目录不存在时 loadPromptConfigFiles fail loud', () => {
  assert.throws(() => loadPromptConfigFiles(new URL('./missing/', import.meta.url)), /configsDir .* not readable/)
})

const assistantReasoning = (text) => ({
  type: 'assistant/message',
  data: { message: { content: [{ type: 'reasoning', text }] } },
})

test('custom-fallback 支持自定义锚定词：命中「我是xxx」立即注入一次', async () => {
  const { step } = makeHarness(createPromptConfigs([{
    id: 'anchor-custom',
    strategy: 'custom-fallback',
    position: 'before-all',
    dedupe: 'session',
    promotion: 'main',
    subagents: 'inherit',
    sourceKind: 'plugin',
    params: { text: 'CONFIG_TEXT', firstTurnWord: '我是xxx' },
  }]))
  const decision = await step(agent({ session: {
    id: 'ac1', header: { delegationDepth: 0 },
    events: [assistantReasoning('我是xxx，开始分析')],
  } }))
  assert.equal(decision.messages.length, 2)
  assert.equal(decision.messages[0].content[0].text, 'CONFIG_TEXT')
})

test('custom-fallback 自定义锚定词未命中时按两轮兜底', async () => {
  const { step } = makeHarness(createPromptConfigs([{
    id: 'anchor-custom2',
    strategy: 'custom-fallback',
    position: 'before-all',
    dedupe: 'session',
    promotion: 'main',
    subagents: 'inherit',
    sourceKind: 'plugin',
    params: { text: 'FALLBACK_TEXT', firstTurnWord: '锚点A' },
  }]))
  const oneRound = await step(agent({ session: {
    id: 'ac2', header: { delegationDepth: 0 },
    events: [assistantReasoning('我是别的开头')],
  } }))
  assert.equal(oneRound.messages.length, 1)
  const twoRounds = await step(agent({ session: {
    id: 'ac3', header: { delegationDepth: 0 },
    events: [assistantReasoning('我是别的开头'), assistantReasoning('第二轮回合')],
  } }))
  assert.equal(twoRounds.messages.length, 2)
  assert.equal(twoRounds.messages[0].content[0].text, 'FALLBACK_TEXT')
})

test('texts 数组：单条提示词配置注入为一条消息的多个 text 内容块', async () => {
  const { step } = makeHarness(createPromptConfigs([{
    id: 'texts',
    strategy: 'static',
    texts: ['第一段 {{WHO}}', '第二段'],
    variables: { WHO: '李雷' },
    position: 'after-all',
  }]))
  const decision = await step(agent())
  assert.equal(decision.messages.length, 2)
  assert.equal(decision.messages[1].content.length, 2)
  assert.equal(decision.messages[1].content[0].text, '第一段 李雷')
  assert.equal(decision.messages[1].content[1].text, '第二段')
})

test('merged：同一位置的多条提示词配置合并为一条消息（分组键=位置）', async () => {
  const { step } = makeHarness(createPromptConfigs([
    { id: 'part-a', strategy: 'static', text: 'A', position: 'after-all', mergeMode: 'merged' },
    { id: 'part-b', strategy: 'static', text: 'B', position: 'after-all', mergeMode: 'merged' },
    { id: 'alone', strategy: 'static', text: 'C', position: 'after-all' },
  ]))
  const decision = await step(agent())
  assert.equal(decision.messages.length, 3)
  assert.deepEqual(decision.messages[1].content.map((block) => block.text), ['A', 'B'])
  assert.equal(decision.messages[1].source.plugin, 'merged:after-all')
  assert.equal(decision.messages[2].content[0].text, 'C')
})

test('merged 持久幂等：事件流已有同位置合并消息时组内配置全部跳过', async () => {
  const { step } = makeHarness(createPromptConfigs([
    { id: 'part-a2', strategy: 'static', text: 'A', position: 'after-all', dedupe: 'session', mergeMode: 'merged' },
    { id: 'part-b2', strategy: 'static', text: 'B', position: 'after-all', dedupe: 'session', mergeMode: 'merged' },
  ]))
  const withEvent = agent({ session: {
    id: 'mg1', header: { delegationDepth: 0 },
    events: [{ type: 'user/message', data: { source: { kind: 'plugin', plugin: 'merged:after-all' } } }],
  } })
  const decision = await step(withEvent)
  assert.equal(decision.messages.length, 1)
})

test('mergeMode=separate（默认）：同位置多条配置先后插入为独立消息', async () => {
  const { step } = makeHarness(createPromptConfigs([
    { id: 'sep-a', strategy: 'static', text: 'A', position: 'after-all' },
    { id: 'sep-b', strategy: 'static', text: 'B', position: 'after-all' },
  ]))
  const decision = await step(agent())
  assert.equal(decision.messages.length, 3)
  assert.equal(decision.messages[1].content[0].text, 'A')
  assert.equal(decision.messages[2].content[0].text, 'B')
})

test('parsePromptConfigYaml 解析 texts 数组标量', () => {
  const doc = parsePromptConfigYaml('id: x\ntexts: ["A", "B"]\n')
  assert.deepEqual(doc.texts, ['A', 'B'])
})

test('system-section：merged 模式同位置拼接为单个 section', () => {
  const sections = []
  makeWiredHarness([
    { id: 'sys-a', layer: 'system-section', strategy: 'static', text: 'A', order: 10, mergeMode: 'merged' },
    { id: 'sys-b', layer: 'system-section', strategy: 'static', texts: ['B1', 'B2'], order: 10, mergeMode: 'merged' },
  ], {
    systemPrompt: { section(def) { sections.push(def); return () => {} }, context() { return () => {} } },
  })
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'sys-a')
  assert.equal(sections[0].order, 10)
  assert.equal(sections[0].text, 'A\n\nB1\n\nB2')
})

test('system-section：separate 模式同 order 保持独立 section（官方按 order 再拼接）', () => {
  const sections = []
  makeWiredHarness([
    { id: 'sep-1', layer: 'system-section', strategy: 'static', text: 'A', order: 20 },
    { id: 'sep-2', layer: 'system-section', strategy: 'static', text: 'B', order: 20 },
  ], {
    systemPrompt: { section(def) { sections.push(def); return () => {} }, context() { return () => {} } },
  })
  assert.deepEqual(sections.map((section) => section.text), ['A', 'B'])
})

test('runtime-context：merged 模式同样支持拼接与 order 顺序', () => {
  const contexts = []
  makeWiredHarness([
    { id: 'ctx-b', layer: 'runtime-context', strategy: 'static', text: 'B', order: 5, mergeMode: 'merged' },
    { id: 'ctx-a', layer: 'runtime-context', strategy: 'static', text: 'A', order: 4, mergeMode: 'merged' },
  ], {
    systemPrompt: { section() { return () => {} }, context(def) { contexts.push(def); return () => {} } },
  })
  assert.equal(contexts.length, 1)
  assert.equal(contexts[0].text, 'A\n\nB')
})

test('runtime-context placeholder：注册函数 provider，assembly 时动态填充', async () => {
  const contexts = []
  makeWiredHarness([
    { id: 'ctx-env', layer: 'runtime-context', strategy: 'placeholder', fill: 'env-facts', order: 5,
      text: '工作区={{WORKSPACE}}' },
  ], {
    systemPrompt: {
      section() { return () => {} },
      context(def) { contexts.push(def); return () => {} },
    },
  })
  assert.equal(contexts.length, 1)
  assert.equal(typeof contexts[0].text, 'function')
  const text = await contexts[0].text({ agent: agent({ session: { id: 'ctx1', header: { delegationDepth: 0, cwd: 'D:/repo' }, events: [] } }) })
  assert.equal(text, '工作区=D:/repo')
})

test('vendored yaml 完整解析：支持列表、行尾注释与引号转义', () => {
  const doc = parsePromptConfigYaml([
    'id: full-yaml',
    'enabled: true',
    'priority: 2',
    'text: |-',
    '  line one # 不是注释',
    '  line "two"',
    'texts:',
    '  - 第一段   # 行尾注释',
    '  - 第二段',
    'params:',
    '  patch:',
    '    maxTokens: 4096',
    '    temperature: 0.3',
  ].join('\n'))
  assert.equal(doc.id, 'full-yaml')
  assert.equal(doc.enabled, true)
  assert.equal(doc.priority, 2)
  assert.equal(doc.text, 'line one # 不是注释\nline "two"')
  assert.deepEqual(doc.texts, ['第一段', '第二段'])
  assert.deepEqual(doc.params.patch, { maxTokens: 4096, temperature: 0.3 })
})
