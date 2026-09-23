import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { applyPromptConfigs, createPromptConfigs as createPromptConfigsCore, inject, loadPromptConfigFiles, parsePromptConfigYaml } from '../../engine/prompt-config-engine.mjs'
import { getEngineMeta, KNOWN_STRATEGIES } from '../../engine/schema.mjs'
import { TURN_STOP_MAX_PER_SESSION } from '../../engine/layers.mjs'
import { extractText } from '../../engine/shared.mjs'
import { setSessionVar } from '../../engine/session-vars.mjs'
// 官方渲染器：回归「我方解析后的出口文本不再触发官方严格插值抛错」。
import { renderContextSections, renderPrompt } from '@deepseek-ai/dsh-system-prompt'

/** 引擎测试夹具使用包内 engine 目录作为自定义策略探测目录;内置策略不依赖 strategyDir。 */
const STRATEGY_DIR = new URL('../../engine/', import.meta.url).href
const createPromptConfigs = (specs, options = {}) =>
  createPromptConfigsCore(specs, { strategyDir: STRATEGY_DIR, ...options })

test('九层契约只公开各入口可消费的策略、匹配对象和内容字段', () => {
  const { layerContracts } = getEngineMeta()
  assert.equal(Object.keys(layerContracts).length, 9)
  assert.deepEqual(layerContracts['pre-step'].subjects, ['userMessage'])
  assert.deepEqual(layerContracts['tool-pipeline'].subjects, ['toolArgs', 'toolResult'])
  assert.deepEqual(layerContracts['runtime-context'].strategies, ['static', 'placeholder'])
  assert.deepEqual(layerContracts['agent-request'].strategies, ['static'])
  assert.equal(layerContracts['agent-request'].content, 'request')
  assert.equal(layerContracts['agent-request'].variables, false)
  assert.equal(layerContracts['subagent-end'].content, 'subagent-result')
  assert.deepEqual(layerContracts['subagent-end'].params.action.values, ['observe', 'inject-main'])
  for (const [layer, contract] of Object.entries(layerContracts)) {
    assert.equal(contract.messageMetadata, layer === 'pre-step')
  }
})

test('局部参数校验拒绝静默失效值，保留扩展键和工具名数组兼容', () => {
  for (const spec of [
    { layer: 'subagent-start', subject: 'toolArgs' },
    { layer: 'llm-stream', params: { mode: 'typo' } },
    { layer: 'tool-pipeline', params: { preDecision: 'dnye' } },
    { layer: 'tool-pipeline', params: { postAction: 'typo' } },
    { layer: 'tool-pipeline', params: { toolNames: ['read', 1] } },
    { layer: 'system-section', params: { complete: 'true' } },
    { layer: 'runtime-context', params: { contextName: 1 } },
    { layer: 'subagent-end', params: { action: 'replace' } },
    { layer: 'pre-step', params: [] },
  ]) assert.throws(() => createPromptConfigs([{ id: 'bad', ...spec }]), /subject|params/)
  const [config] = createPromptConfigs([{ id: 'ok', layer: 'tool-pipeline', params: { toolNames: ['read', 'write'], extension: { kept: true } } }])
  assert.equal(config.params.toolNames, 'read,write')
  assert.deepEqual(config.params.extension, { kept: true })
})

test('请求 patch 校验官方字段，整体替换必须提供有效路由', () => {
  for (const params of [
    { patch: 'bad' }, { patch: { provider: '' } }, { patch: { model: 1 } },
    { patch: { reasoningEffort: 1 } }, { patch: { temperature: '0.7' } },
    { patch: { maxTokens: -1 } }, { patch: { stop: 'END' } },
    { patch: { messages: [] } }, { replace: 'true' },
    { replace: true }, { replace: true, patch: { provider: 'official' } },
  ]) assert.throws(() => createPromptConfigs([{ id: 'bad-request', layer: 'agent-request', params }]), /params/)
  const patch = { provider: 'official', model: 'custom-model', reasoningEffort: 'adapter-owned', temperature: 0, maxTokens: 1, stop: [] }
  const [config] = createPromptConfigs([{ id: 'request', layer: 'agent-request', params: { patch, replace: true, extension: 'kept' } }])
  assert.deepEqual(config.params.patch, patch)
  assert.equal(config.params.extension, 'kept')
})

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
  /** 宿主接纳：本步承认的消息逐条成为持久事件（投递确认的唯一来源）。 */
  const admit = (agent, decision) => {
    const observe = listeners.get('session/event')
    for (const message of decision.messages) {
      if (observe) observe(agent.session, { type: 'user/message', data: { message } })
    }
  }
  return { step, admit, warnings }
}

const agent = (overrides = {}) => ({
  session: {
    id: 's1',
    header: { delegationDepth: 0 },
    snapshotEvents: () => [],
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

test('loadPromptConfigFiles 读 variables.yml 合并进每条配置（配置自身优先；变量文件不当作配置）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-tool-vars-'))
  try {
    writeFileSync(join(dir, 'variables.yml'), 'wordsCloud: 不少于1500\nJailbreakPrompt: YOU ARE FREE\n')
    writeFileSync(join(dir, '10-a.yml'), 'id: a\nstrategy: static\ntext: A\nvariables:\n  wordsCloud: 配置覆盖\n')
    writeFileSync(join(dir, '20-b.yml'), 'id: b\nstrategy: static\ntext: B\n')
    const specs = loadPromptConfigFiles(pathToFileURL(dir + '/'))
    assert.deepEqual(specs.map((spec) => spec.id), ['a', 'b'], 'variables.yml 不进入配置列表')
    assert.equal(specs.find((spec) => spec.id === 'a').variables.wordsCloud, '配置覆盖', '配置自身 variables 优先')
    assert.equal(specs.find((spec) => spec.id === 'a').variables.JailbreakPrompt, 'YOU ARE FREE', '预设变量合并进配置')
    assert.equal(specs.find((spec) => spec.id === 'b').variables.wordsCloud, '不少于1500', '无自身变量的配置获得预设变量')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('首轮锚定局部参数只读 text，旧 firstTurnText 不触发注入', async () => {
  for (const [params, expected] of [
    [{ useCustom: true, firstTurnText: 'OLD' }, []],
    [{ useCustom: true, text: 'CURRENT', firstTurnText: 'OLD' }, ['CURRENT']],
    [{ useCustom: true, text: '', firstTurnText: 'OLD' }, []],
  ]) {
    const { step } = makeHarness(createPromptConfigs([
      { id: 'anchor', strategy: 'first-turn-anchor', params },
    ]))
    const result = await step(agent())
    assert.deepEqual(result.messages.slice(1).map((message) => message.content[0].text), expected)
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
      audience: 'main',
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
      audience: 'main',
      modelScope: 'flash',
      params: {
        complexPattern: 'complex',
        guideWeak: 'WEAK',
        guideDeep: 'DEEP',
      },
    },
  ]))
  const decision = await step(agent({ session: {
    id: 's2',
    header: { delegationDepth: 0 },
    snapshotEvents: () => [{ type: 'tool/call', seq: 1, time: 1, data: {} }],
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

test('custom-fallback 多词确认：reasoning 以派生确认词任一开头即注入（deep 档 Let…）', async () => {
  const { step } = makeHarness(createPromptConfigs([{
    id: 'prompt-injector',
    enabled: true,
    strategy: 'custom-fallback',
    position: 'before-all',
    dedupe: 'session',
    promotion: 'none',
    modelScope: 'all',
    params: { text: 'PRESET', anchorWords: ['we', 'let'] },
  }]))
  const sessionWith = (id, text) => agent({ session: {
    id,
    header: { delegationDepth: 0 },
    snapshotEvents: () => [{ type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text }] } } }],
  } })
  // deep 锚句信号（Let… 开头）→ 确认注入。
  const withLet = await step(sessionWith('s-cf-let', 'Let me think through the design before changing anything'))
  assert.equal(withLet.messages.length, 2, '确认后注入一条')
  assert.equal(withLet.messages[0].content[0].text, 'PRESET', '注入消息在 before-all 位置')
  // build/fix 锚句信号（We… 开头）→ 同样命中。
  const withWe = await step(sessionWith('s-cf-we', 'We need to build it directly and verify it'))
  assert.equal(withWe.messages.length, 2)
  assert.equal(withWe.messages[0].content[0].text, 'PRESET')
  // 不匹配开头 → 未确认且仅一轮 → 不注入（两轮兜底前）。
  const noMatch = await step(sessionWith('s-cf-no', 'Hmm, let me consider the options'))
  assert.equal(noMatch.messages.length, 1, '未确认首轮不注入')
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
    sourceKind: 'instruction-hint',
  }]))
  const withEvent = agent({ session: {
    id: 's3',
    header: { delegationDepth: 0 },
    snapshotEvents: () => [
      { type: 'tool/call', seq: 1, time: 1, data: {} },
      { type: 'user/message', data: { source: { kind: 'instruction-hint', form: 'hint' } } },
    ],
  } })
  const decision = await step(withEvent)
  assert.equal(decision.messages.length, 1)
})

test('V1 投递缓存区分 plugin/kind 身份，延迟命中与持久恢复一致', async () => {
  const specs = [
    { id: 'first', sourceKind: 'second', strategy: 'static', text: 'FIRST', position: 'after-all', dedupe: 'session' },
    { id: 'second', sourceKind: 'other', strategy: 'static', text: 'SECOND', position: 'after-all', dedupe: 'session', match: { keys: ['LATER'] } },
  ]
  const events = []
  const probe = agent({ session: { id: 'identity-collision', header: {}, snapshotEvents: () => events } })
  const hot = makeHarness(createPromptConfigs(specs))
  const first = await hot.step(probe)
  assert.deepEqual(first.messages.map(message => message.source.plugin), [undefined, 'first'])
  events.push(...first.messages.map(message => ({ type: 'user/message', data: { message } })))
  hot.admit(probe, first)
  const later = [{ ...userTask, id: 'later', content: [{ type: 'text', text: 'LATER' }] }]
  const cold = makeHarness(createPromptConfigs(specs))
  for (const h of [hot, cold]) {
    const hit = await h.step(probe, later)
    assert.deepEqual(hit.messages.map(message => message.source.plugin), [undefined, 'second'])
    h.admit(probe, hit)
    assert.equal((await h.step(probe, later)).messages.length, 1, '接纳后目标只投一次')
  }
})

test('createPromptConfigs 默认 layer=pre-step；未知 layer fail loud', () => {
  assert.equal(createPromptConfigs([{ id: 'x', strategy: 'static' }])[0].layer, 'pre-step')
  assert.throws(() => createPromptConfigs([{ id: 'x', layer: 'nope' }]), /unknown layer/)
})

test('system-section 服务缺失时降级跳过，pre-step 提示词配置照常注入', async () => {
  const { step } = makeHarness(createPromptConfigs([
    { id: 'sys-section', layer: 'system-section', strategy: 'static', text: 'SYS' },
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
function makeWiredHarness(configSpecs, services = {}, options = {}) {
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
  applyPromptConfigs(ctx, createPromptConfigs(configSpecs, options))
  return { listeners, sections, contexts, disposed }
}

async function assembleRuntimeContexts(definitions, listeners, currentAgent = agent()) {
  const context = { agent: currentAgent }
  const assembly = { contexts: definitions.map(def => ({ name: def.name, text: typeof def.text === 'function' ? def.text(context) : def.text })) }
  assert.ok(assembly.contexts.every(entry => typeof entry.text === 'string'), '官方 provider 必须同步返回文本')
  return (await listeners.get('system-prompt/assemble')(assembly, context, async () => assembly)).contexts
}

test('官方变量注册：事实按 assembly 求值、非法名改写为别名、未声明引用剥离', () => {
  const providers = new Map()
  const sections = []
  makeWiredHarness([
    {
      id: 'facts',
      layer: 'system-section',
      strategy: 'static',
      order: 0,
      text: '时间 {{time}} 用户 {{lastusermessage}} 视角 {{POV}} 未声明 {{missing}}',
      variables: { POV: '视角值' },
    },
    // 大小写变体统一注册到规范小写名（不额外生成别名）。
    { id: 'case', layer: 'system-section', strategy: 'static', order: 1, text: '再取一次 {{lastUserMessage}}' },
  ], {
    systemPrompt: {
      variable(name, provider) { providers.set(name, provider); return () => providers.delete(name) },
      section(def) { sections.push(def); return () => {} },
      context() { return () => {} },
    },
  })

  assert.ok(providers.has('time'), '时间事实注册为官方变量')
  assert.ok(providers.has('lastusermessage'), '会话消息事实注册为官方变量')
  assert.ok(![...providers.keys()].some((name) => name.startsWith('sv_lastusermessage')), '大小写变体不生成别名')
  const alias = [...providers.keys()].find((name) => name.startsWith('sv_'))
  assert.ok(alias !== undefined, '非法官方名（大写 POV）改写为 sv_ 别名')

  const text = sections[0].text
  assert.match(text, /\{\{time\}\}/, '事实保留引用，交由官方按 assembly 求值（不再注册期冻结）')
  assert.match(text, /\{\{lastusermessage\}\}/)
  assert.match(text, new RegExp(`\\{\\{${alias}\\}\\}`), '别名改写生效')
  assert.doesNotMatch(text, /\{\{POV\}\}/, '非法原名不再出现在注册文本里')
  assert.doesNotMatch(text, /missing/, '未声明引用被剥离')

  const session = {
    id: 's1',
    header: {},
    snapshotEvents: () => [{ type: 'user/message', data: { message: { content: [{ type: 'text', text: '最新用户' }] } } }],
  }
  const context = { agent: { session } }
  assert.equal(providers.get('lastusermessage')(context), '最新用户', '事实随会话现算')
  assert.match(providers.get('time')(context), /^\d{2}:\d{2}$/)
  assert.equal(providers.get(alias)(context), '视角值', '声明值兜底')
  setSessionVar(session, 'POV', '会话覆盖')
  assert.equal(providers.get(alias)(context), '会话覆盖', '会话变量优先于声明值')

  // 官方渲染器能直接解析（白名单引用不被剥离）。
  assert.doesNotThrow(() => renderPrompt({
    sections: [{ name: 'facts', text }],
    variables: Object.fromEntries([...providers].map(([name, provider]) => [name, provider(context)])),
  }))
})

test('官方插值通道出口：无法解析的引用被剥离，官方 renderPrompt/renderContextSections 不再抛错', () => {
  const sections = []
  const contexts = []
  makeWiredHarness([
    {
      id: 'sys',
      layer: 'system-section',
      strategy: 'static',
      order: 0,
      text: 'A {{缺失名}} B {{}} C {{// {x}\n注释 }} D {{roll 1d6}} E {{wordsCloud}}',
      variables: { wordsCloud: '1500' },
    },
    { id: 'ctx', layer: 'runtime-context', strategy: 'static', order: 0, text: '未知 {{缺失名}} 与 {{}}' },
  ], {
    systemPrompt: {
      section(def) { sections.push(def); return () => {} },
      context(def) { contexts.push(def); return () => {} },
    },
  })

  const sectionText = typeof sections[0].text === 'function' ? sections[0].text({}) : sections[0].text
  const contextText = contexts[0].text
  assert.doesNotMatch(sectionText, /\{\{缺失名\}\}/, '未命中引用整段剥离')
  assert.doesNotMatch(sectionText, /\{\{\}\}/, '空引用剥离')
  assert.doesNotMatch(sectionText, /\{\{/, '出口不留开括号组')
  assert.match(sectionText, /1500/, '已声明变量照常解析')
  assert.match(sectionText, /D \d+ E/, 'ST 形态宏归一后照常求值')
  assert.doesNotMatch(contextText, /缺失名|\{\{/, 'runtime-context 出口同样清洗')

  // 反证：原始文本确实会被官方严格插值拦下（中文名判畸形、合法名判未注册）——出口清洗才是关键。
  assert.throws(
    () => renderPrompt({ sections: [{ name: 'raw', text: 'A {{缺失名}}' }], variables: {} }),
    /malformed prompt variable reference/,
  )
  assert.throws(
    () => renderPrompt({ sections: [{ name: 'raw', text: 'A {{missingname}}' }], variables: {} }),
    /unknown prompt variable/,
  )
  assert.throws(
    () => renderContextSections({ contexts: [{ name: 'raw', text: 'A {{missingname}}' }], variables: {} }),
    /unknown prompt variable/,
  )
  // 出口文本经官方渲染器不再抛错（0.1.6 的 runtime-context 没有 interpolate:false，只能靠这里）。
  assert.equal(renderPrompt({ sections: [{ name: 'sys', text: sectionText }], variables: {} }), sectionText)
  assert.doesNotThrow(() => renderContextSections({ contexts: [{ name: 'ctx', text: contextText }], variables: {} }))
})

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
  // 内置路径变量在静态层就解析：官方严格插值不认大写名字，残留 {{DSH_HOME}} 会判畸形引用。
  assert.equal(contexts[0].text, `环境 ${process.env.DSH_HOME ?? (process.env.USERPROFILE ? `${process.env.USERPROFILE}\\.dsh` : '')}`)
  // 来源存活标记及两个服务 disposer 均挂到 fiber；服务侧仍只收到两个注销。
  assert.equal(harness.disposed.length, 3)
  for (const cleanup of harness.disposed) cleanup()
  assert.deepEqual(disposed, ['sys', 'ctx'])
})

test('system-section：官方/旧人设段名一律按普通段注册，complete 与 audience 语义透传', () => {
  const configs = createPromptConfigs([
    { id: 'sub-persona', layer: 'system-section', strategy: 'static', text: 'SUB', audience: 'subagent', params: { sectionName: 'deployment:persona-prefix' } },
  ])
  assert.equal(configs[0].audience, 'subagent')
  const sections = []
  makeWiredHarness([
    { id: 'main-persona', layer: 'system-section', strategy: 'static', text: 'MAIN', order: 0, params: { sectionName: 'deployment:persona-prefix', complete: true } },
    { id: 'sub-persona', layer: 'system-section', strategy: 'static', text: 'SUB', order: 0, audience: 'subagent', params: { sectionName: 'deployment:persona-suffix' } },
    { id: 'legacy-persona', layer: 'system-section', strategy: 'static', text: 'LEGACY', order: 10, params: { sectionName: 'deployment:persona' } },
  ], { systemPrompt: { section: (def) => { sections.push(def); return () => {} } } })
  assert.deepEqual(sections.map((section) => section.name).sort(), ['deployment:persona', 'deployment:persona-prefix', 'deployment:persona-suffix'], '人设语义归官方 dsh-persona 行，引擎按普通段注册')
  const prefix = sections.find((section) => section.name === 'deployment:persona-prefix')
  const suffix = sections.find((section) => section.name === 'deployment:persona-suffix')
  assert.equal(prefix.complete, true, 'complete 仍按 system-section 语义透传')
  assert.equal(prefix.text, 'MAIN')
  const mainCtx = { agent: { session: { header: { delegationDepth: 0 } }, options: { model: 'x' } } }
  const subCtx = { agent: { session: { header: { delegationDepth: 1 } }, options: { model: 'x' } } }
  assert.equal(suffix.text(mainCtx), '', 'audience=subagent 主会话不注入')
  assert.equal(suffix.text(subCtx), 'SUB', 'audience=subagent 子代理注入')
})

test('system-section：persona 段不再有专属分支（无主段合并/子代理替换语义）', () => {
  const sections = []
  makeWiredHarness([
    { id: 'main-persona', layer: 'system-section', strategy: 'static', text: 'MAIN', order: 0, params: { sectionName: 'persona' } },
  ], { systemPrompt: { section: (def) => { sections.push(def); return () => {} } } })
  assert.equal(sections.length, 1)
  assert.equal(sections[0].text, 'MAIN', '无子代理卡 = 静态文本（子代理经 scope 链继承主会话）')
})

test('system-section 非 persona audience 段：text 函数按 agent scope 过滤', () => {
  const sections = []
  makeWiredHarness([
    { id: 'sub-tools', layer: 'system-section', strategy: 'static', text: 'SUB-TOOLS', order: 10, audience: 'subagent' },
  ], { systemPrompt: { section: (def) => { sections.push(def); return () => {} } } })
  assert.equal(sections.length, 1)
  const mainCtx = { agent: { session: { header: { delegationDepth: 0 } }, options: { model: 'x' } } }
  const subCtx = { agent: { session: { header: { delegationDepth: 1 } }, options: { model: 'x' } } }
  assert.equal(sections[0].text(mainCtx), '', '主会话不注入')
  assert.equal(sections[0].text(subCtx), 'SUB-TOOLS', '子代理注入')
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

test('tool-pipeline 条件判定：工具参数命中才裁决，未命中透传', async () => {
  const { listeners } = makeWiredHarness([{
    id: 'no-review-reports', layer: 'tool-pipeline', strategy: 'static', text: 'x',
    params: { toolNames: 'write,edit', preDecision: 'deny', denyReason: '审查结论写入 PLAN' },
    match: { keys: ['.scratch/reviews/'] },
  }])
  const agentStub = { session: { header: { delegationDepth: 0 } }, options: { model: 'deepseek-v4-pro-8013' } }
  const pre = listeners.get('tools/pre-execute')
  const hitPath = { name: 'write', arguments: { file_path: '.scratch/reviews/x.md' }, agent: agentStub }
  const missPath = { name: 'write', arguments: { file_path: 'docs/plan.md' }, agent: agentStub }
  const missTool = { name: 'read', arguments: { file_path: '.scratch/reviews/x.md' }, agent: agentStub }

  assert.deepEqual(await pre(hitPath, async () => ({ kind: 'allow' })), { kind: 'deny', reason: '审查结论写入 PLAN' })
  assert.deepEqual(await pre(missPath, async () => ({ kind: 'allow' })), { kind: 'allow' })
  assert.deepEqual(await pre(missTool, async () => ({ kind: 'allow' })), { kind: 'allow' })
})

test('tool-pipeline 条件判定：数组 toolNames 归一化，不扩大成全工具门', async () => {
  const { listeners } = makeWiredHarness([{
    id: 'array-names', layer: 'tool-pipeline', strategy: 'static', text: 'x',
    params: { toolNames: ['write'], preDecision: 'deny', denyReason: 'no write' },
  }])
  const agentStub = { session: { header: { delegationDepth: 0 } }, options: { model: 'deepseek-v4-pro-8013' } }
  const pre = listeners.get('tools/pre-execute')
  assert.deepEqual(await pre({ name: 'read', arguments: {}, agent: agentStub }, async () => ({ kind: 'allow' })), { kind: 'allow' })
  assert.deepEqual(await pre({ name: 'write', arguments: {}, agent: agentStub }, async () => ({ kind: 'allow' })), { kind: 'deny', reason: 'no write' })
})

test('tool-pipeline 条件判定：post 侧按工具结果文本裁决', async () => {
  const { listeners } = makeWiredHarness([{
    id: 'flag-unregistered', layer: 'tool-pipeline', strategy: 'static', text: 'SEEN',
    params: { toolNames: 'grep', postAction: 'replace' },
    subject: 'toolResult',
    match: { keys: ['未注册'] },
  }])
  const agentStub = { session: { header: { delegationDepth: 0 } }, options: { model: 'deepseek-v4-pro-8013' } }
  const exec = { name: 'grep', arguments: { pattern: 'x' }, agent: agentStub }
  const post = listeners.get('tools/post-execute')
  assert.deepEqual(
    await post(exec, { content: [{ type: 'text', text: '技能状态：未注册' }] }, async () => ({ kind: 'accept' })),
    { kind: 'accept', content: [{ type: 'text', text: 'SEEN' }] },
  )
  assert.deepEqual(
    await post(exec, { content: [{ type: 'text', text: '一切正常' }] }, async () => ({ kind: 'accept' })),
    { kind: 'accept' },
  )
})

test('tool-pipeline 条件判定：组合逻辑生效（all 要求主副键同时命中）', async () => {
  const { listeners } = makeWiredHarness([{
    id: 'combo', layer: 'tool-pipeline', strategy: 'static', text: 'x',
    params: { preDecision: 'deny', denyReason: 'combo' },
    match: { keys: ['.scratch/'], secondaryKeys: ['reviews'], logic: 'all' },
  }])
  const agentStub = { session: { header: { delegationDepth: 0 } }, options: { model: 'deepseek-v4-pro-8013' } }
  const pre = listeners.get('tools/pre-execute')
  const partial = { name: 'write', arguments: { file_path: '.scratch/plan/x.md' }, agent: agentStub }
  const both = { name: 'write', arguments: { file_path: '.scratch/reviews/x.md' }, agent: agentStub }
  assert.deepEqual(await pre(partial, async () => ({ kind: 'allow' })), { kind: 'allow' })
  assert.deepEqual(await pre(both, async () => ({ kind: 'allow' })), { kind: 'deny', reason: 'combo' })
})

test('turn-stop：命中条件时强制续跑一次，同一轮不越过每轮上限', async () => {
  const steered = []
  const { listeners } = makeWiredHarness([{
    id: 'keep-going', layer: 'turn-stop', strategy: 'static', text: '继续本轮',
    match: { keys: ['还没做完'] },
  }])
  const listener = listeners.get('agent/turn-stopping')
  assert.ok(listener)
  const agentStub = {
    session: {
      id: 'session-turn-stop',
      header: { delegationDepth: 0 },
      snapshotEvents: () => [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '还没做完' }] } } }],
    },
    options: { model: 'deepseek-v4-pro-8013' },
    steer(message) { steered.push(message) },
  }
  await listener({ agent: agentStub, turn: 1 })
  assert.equal(steered.length, 1)
  assert.equal(steered[0].role, 'user')
  assert.equal(steered[0].content[0].text, '继续本轮')

  await listener({ agent: agentStub, turn: 1 })
  assert.equal(steered.length, 1, '同一轮第二次不再续跑')
})

test('turn-stop：会话级上限拦住连续续跑（死循环护栏）', async () => {
  const steered = []
  const { listeners } = makeWiredHarness([{
    id: 'loop-guard', layer: 'turn-stop', strategy: 'static', text: 'go',
    match: { keys: ['继续'] },
  }])
  const listener = listeners.get('agent/turn-stopping')
  const agentStub = {
    session: {
      id: 'session-loop-guard',
      header: { delegationDepth: 0 },
      snapshotEvents: () => [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '继续' }] } } }],
    },
    options: {},
    steer(message) { steered.push(message) },
  }
  for (let turn = 1; turn <= 10; turn += 1) await listener({ agent: agentStub, turn })
  assert.equal(steered.length, TURN_STOP_MAX_PER_SESSION)
})

test('turn-stop：未命中条件时不续跑', async () => {
  const steered = []
  const { listeners } = makeWiredHarness([{
    id: 'no-match', layer: 'turn-stop', strategy: 'static', text: 'x',
    match: { keys: ['绝不会出现的锚点'] },
  }])
  const listener = listeners.get('agent/turn-stopping')
  const agentStub = {
    session: {
      id: 'session-no-match',
      header: { delegationDepth: 0 },
      snapshotEvents: () => [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '做完了' }] } } }],
    },
    options: {},
    steer(message) { steered.push(message) },
  }
  await listener({ agent: agentStub, turn: 1 })
  assert.equal(steered.length, 0)
})

test('subagent-start：命中条件时向子代理注入，未命中零注入', async () => {
  const injected = []
  const child = { session: { header: { delegationDepth: 1 } }, options: {}, inject(message) { injected.push(message) } }
  const { listeners } = makeWiredHarness([{
    id: 'sub-brief', layer: 'subagent-start', strategy: 'static', text: '先取证再动手',
    match: { keys: ['child-1'] },
  }], { agents: { get: () => child } })
  const listener = listeners.get('subagent/start')
  assert.ok(listener)
  listener({ id: 'child-1', runId: 'r1' })
  assert.equal(injected.length, 1)
  assert.equal(injected[0].content[0].text, '先取证再动手')

  listener({ id: 'child-2', runId: 'r2' })
  assert.equal(injected.length, 1, '未命中条件不注入')
})

test('subagent-end：命中只观察，不产生注入', async () => {
  const injected = []
  const child = { session: { header: { delegationDepth: 1 } }, options: {}, inject(message) { injected.push(message) } }
  const { listeners } = makeWiredHarness([{
    id: 'sub-end-watch', layer: 'subagent-end', strategy: 'static', text: 'x',
    match: { keys: ['child-1'] },
  }], { agents: { get: () => child } })
  const listener = listeners.get('subagent/end')
  assert.ok(listener)
  listener({ id: 'child-1', runId: 'r1' })
  assert.equal(injected.length, 0)
})

test('条件层拒绝不适用的字段：subagent-start 不接受 audience', () => {
  assert.throws(
    () => createPromptConfigs([{ id: 'bad-audience', layer: 'subagent-start', audience: 'main' }]),
    /does not support/,
  )
})

test('pre-step 条件判定：用户消息命中才注入，未命中不占用 session 去重', async () => {
  const harness = makeHarness(createPromptConfigs([{
    id: 'bug-only', layer: 'pre-step', strategy: 'static', dedupe: 'session', text: '先取证再动手',
    match: { keys: ['报错'] },
  }]))
  const probe = agent({ session: { id: 's-condition', header: { delegationDepth: 0 }, snapshotEvents: () => [] } })
  // after-user 的插入锚点是 source.kind === 'user' 的消息。
  const say = (id, text) => [{ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }]

  const miss = await harness.step(probe, say('u1', '帮我加个按钮'))
  assert.equal(miss.messages.length, 1, '未命中时不注入')

  const hit = await harness.step(probe, say('u2', '这东西报错了'))
  assert.ok(
    hit.messages.some((message) => JSON.stringify(message).includes('先取证再动手')),
    '未命中不写入 session 去重，条件恢复后仍能注入',
  )
  const unconfirmed = await harness.step(probe, say('u3', '又报错了'))
  assert.equal(unconfirmed.messages.length, 2, '宿主未确认接纳前不算已投递（候选可能被外层门控剥离）')

  harness.admit(probe, hit)
  const repeat = await harness.step(probe, say('u4', '还报错'))
  assert.equal(repeat.messages.length, 1, '宿主接纳后 session 去重照常生效')
})

test('R2 条件未命中的 ST 赋值模板不执行副作用，命中才按 order 生效', async () => {
  const specs = [
    { id: 'never-set', layer: 'pre-step', strategy: 'static', order: 0, position: 'after-all',
      texts: ['{{setvar::x::BAD}}'], params: { stMacros: true }, match: { keys: ['NEVER'] } },
    { id: 'reader', layer: 'pre-step', strategy: 'static', order: 1, position: 'after-all',
      texts: ['[{{getvar::x::EMPTY}}]'], params: { stMacros: true } },
  ]
  const textsOf = (decision) => decision.messages
    .flatMap((message) => message.content ?? [])
    .map((block) => block.text)
  const say = (id, text) => [{ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }]

  const miss = await makeHarness(createPromptConfigs(specs)).step(agent(), say('u1', '普通请求'))
  assert.deepEqual(textsOf(miss), ['普通请求', '[EMPTY]'], '未命中的 setter 不得改动变量帧')

  const hit = await makeHarness(createPromptConfigs(specs)).step(agent(), say('u2', 'NEVER 条件命中'))
  assert.deepEqual(textsOf(hit), ['NEVER 条件命中', '[BAD]'], '命中时 setter 按 order 先行求值（setvar 本身无输出），reader 可读')
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
    id: 'v1', header: { delegationDepth: 0, cwd: 'D:/repo' }, snapshotEvents: () => [],
  } }))
  assert.equal(decision.messages[1].content[0].text, '用户 张三 在工作区 D:/repo（cwd=D:/repo）')
})

test('role=assistant 的旧配置拒绝加载，策略 patch 仍在出口降级并保留原角色', async () => {
  assert.throws(() => createPromptConfigs([
    { id: 'asst', strategy: 'static', text: 'PREVIEW', role: 'assistant' },
  ]), /unknown role/)
  const { step } = makeHarness(createPromptConfigs([{
    id: 'asst', strategy: 'static', templateFile: 'patch.json', position: 'after-all',
  }], { loadTemplate: () => ({ text: 'PREVIEW', role: 'assistant' }) }))
  const decision = await step(agent())
  assert.equal(decision.messages[1].role, 'user')
  assert.equal(decision.messages[1].source.requestedRole, 'assistant')
  assert.equal(decision.messages[1].content[0].text, 'PREVIEW')
})

test('placeholder：instruction-hint 探测 cwd→项目根完整链、使用建议式措辞且消息 id 唯一', async () => {
  const files = new Map([
    ['/repo/.git', { type: 'directory' }],
    ['/repo/AGENTS.md', { type: 'file' }],
    ['/repo/sub/CLAUDE.md', { type: 'file' }],
  ])
  const fs = {
    resolve: async (path) => path,
    stat: async (path) => files.get(path),
  }
  const { step } = makeHarness(createPromptConfigs([{
    id: 'instruction-hint', strategy: 'placeholder', fill: 'instruction-hint',
    position: 'after-all', promotion: 'none', dedupe: 'none',
  }]), { fs })
  const session = { id: 'hint-session', header: { delegationDepth: 0, cwd: '/repo/sub' }, snapshotEvents: () => [] }
  const first = await step(agent({ session }))
  const second = await step(agent({ session }))
  const hint = first.messages[1]
  assert.match(hint.id, /^instruction-hint-hint-session-[0-9a-f-]+$/)
  assert.notEqual(hint.id, second.messages[1].id, '重复探测使用唯一 id，避免宿主重启竞态导致历史冲突')
  assert.match(hint.content[0].text, /Reference documents exist: \/repo\/sub\/CLAUDE\.md, AGENTS\.md/)
  assert.match(hint.content[0].text, /Reading the relevant file .* is recommended/)
  assert.doesNotMatch(hint.content[0].text, /Do NOT assume|read .* first and follow/i)
})

test('placeholder：instruction-hint + params.file 注入绑定文件正文，缺失/空文件不注入', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-file-fill-'))
  try {
    const file = join(dir, 'AGENTS.md')
    writeFileSync(file, 'RULES BODY\n', 'utf8')
    const { step } = makeHarness(createPromptConfigs([{
      id: 'agents-file-test', strategy: 'placeholder', fill: 'instruction-hint',
      position: 'after-all', promotion: 'none', dedupe: 'none',
      sourceKind: 'instruction-file', form: 'instructions',
      params: { file, displayPath: 'AGENTS.md' },
    }]))
    const session = { id: 'file-fill', header: { delegationDepth: 0, cwd: dir }, snapshotEvents: () => [] }
    const decision = await step(agent({ session }))
    const injected = decision.messages.filter((message) => message?.source?.kind === 'instruction-file')
    assert.equal(injected.length, 1)
    assert.equal(injected[0].content[0].text, 'Instructions from: AGENTS.md\n\nRULES BODY')

    writeFileSync(file, '   \n', 'utf8')
    const empty = await step(agent({ session }))
    assert.equal(empty.messages.some((message) => message?.source?.kind === 'instruction-file'), false, '空文件不注入')

    rmSync(file, { force: true })
    const missing = await step(agent({ session }))
    assert.equal(missing.messages.some((message) => message?.source?.kind === 'instruction-file'), false, '文件缺失不注入')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('placeholder：env-facts 按 envKeys 白名单注入机器事实，未知 fill fail loud', async () => {
  const { step } = makeHarness(createPromptConfigs([{
    id: 'env-facts', strategy: 'placeholder', fill: 'env-facts', position: 'after-all',
    // 白名单归配置（组合源/预设），引擎不再内置默认键。
    params: { envKeys: 'DSH_HOME,DSH_WORKSPACE' },
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
    id: 'eft', header: { delegationDepth: 0, cwd: 'D:/repo' }, snapshotEvents: () => [],
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


test('placeholder：skill-catalog dedupe=session 每会话只注入一次（以宿主接纳确认）', async () => {
  const harness = makeHarness(createPromptConfigs([
    { id: 'sk-dedupe', strategy: 'placeholder', fill: 'skill-catalog', position: 'after-all', dedupe: 'session' },
  ]), { skills: skillCatalogStub })
  const session = { id: 'sk-session', header: { delegationDepth: 0 }, snapshotEvents: () => [] }
  const first = await harness.step(agent({ session }))
  assert.equal(first.messages.length, 2)
  assert.equal((await harness.step(agent({ session }))).messages.length, 2, '未确认接纳前不记账')
  harness.admit(agent({ session }), first)
  const second = await harness.step(agent({ session }))
  assert.equal(second.messages.length, 1)
})

test('runtime-context placeholder：skill-catalog 每次 assembly 动态填充', async () => {
  const contexts = []
  const skills = { list: async () => [{ name: 'pdf', description: 'PDF 转换', provider: 'prompt-tool' }] }
  const { listeners } = makeWiredHarness([
    { id: 'ctx-skill', layer: 'runtime-context', strategy: 'placeholder', fill: 'skill-catalog', order: 5,
      text: '技能={{SKILL_NAMES}}' },
  ], {
    systemPrompt: {
      variable() { return () => {} },
      section() { return () => {} },
      context(def) { contexts.push(def); return () => {} },
    },
    skills,
  })
  assert.equal(contexts.length, 1)
  const result = await assembleRuntimeContexts(contexts, listeners, agent({ session: { id: 'ctx2', header: { delegationDepth: 0, cwd: 'D:/repo' }, snapshotEvents: () => [] } }))
  assert.equal(result[0].text, '技能=pdf')
})

test('placeholder 仅允许 pre-step 或 runtime-context 层', () => {
  assert.throws(() => createPromptConfigs([{ id: 'bad', strategy: 'placeholder', fill: 'env-facts', layer: 'system-section' }]), /only takes effect on layer/)
  // 策略 × 层：非 static 策略只在消费它的层生效，其他层声明即挂载期报错（不再静默无效）。
  assert.throws(() => createPromptConfigs([{ id: 'bad-world', strategy: 'world-book', layer: 'tool-pipeline' }]), /only takes effect on layer/)
  assert.throws(() => createPromptConfigs([{ id: 'bad-anchor', strategy: 'first-turn-anchor', layer: 'turn-stop' }]), /only takes effect on layer/)
  assert.throws(() => createPromptConfigs([{ id: 'bad-hint', strategy: 'instruction-hint', layer: 'subagent-start' }]), /only takes effect on layer/)
  // 合法组合不受影响：static 全层可用，条件策略留在 pre-step。
  assert.equal(createPromptConfigs([{ id: 'ok-static', strategy: 'static', layer: 'turn-stop' }])[0].layer, 'turn-stop')
  assert.equal(createPromptConfigs([{ id: 'ok-world', strategy: 'world-book', layer: 'pre-step' }])[0].layer, 'pre-step')
})

test('audience=subagent 的 pre-step 配置：仅子代理注入，主会话跳过', async () => {
  const { step } = makeHarness(createPromptConfigs([
    { id: 'sub-only', strategy: 'static', text: 'SUB', position: 'after-all', audience: 'subagent' },
  ]))
  const main = await step(agent())
  assert.equal(main.messages.length, 1)
  const delegated = await step(agent({ session: {
    id: 'sub1', header: { delegationDepth: 1 }, snapshotEvents: () => [],
  } }))
  assert.equal(delegated.messages.length, 2)
  assert.equal(delegated.messages[1].content[0].text, 'SUB')
})

test('audience=main 的 pre-step 配置：仅主会话注入，子代理跳过', async () => {
  const { step } = makeHarness(createPromptConfigs([
    { id: 'main-only', strategy: 'static', text: 'MAIN', position: 'after-all', audience: 'main' },
  ]))
  const main = await step(agent({ session: {
    id: 'm1', header: { delegationDepth: 0 }, snapshotEvents: () => [],
  } }))
  assert.equal(main.messages.length, 2)
  assert.equal(main.messages[1].content[0].text, 'MAIN')
  const delegated = await step(agent({ session: {
    id: 'sub2', header: { delegationDepth: 1 }, snapshotEvents: () => [],
  } }))
  assert.equal(delegated.messages.length, 1)
})

test('audience=subagent 的 agent-request 配置：仅子代理 patch，主会话透传', async () => {
  const { listeners } = makeWiredHarness([
    { id: 'req-only', layer: 'agent-request', strategy: 'static', audience: 'subagent', params: { patch: { maxTokens: 1234 } } },
  ])
  const handler = listeners.get('agent/request')
  const base = async () => ({ provider: 'p', model: 'm', maxTokens: 1000 })
  const mainAgent = { session: { header: { delegationDepth: 0 } }, options: { model: 'deepseek-v4-pro-8013' } }
  assert.deepEqual(await handler({ agent: mainAgent }, base), { provider: 'p', model: 'm', maxTokens: 1000 })
  const subAgent = { session: { header: { delegationDepth: 1 } }, options: { model: 'deepseek-v4-pro-8013' } }
  assert.deepEqual(await handler({ agent: subAgent }, base), { provider: 'p', model: 'm', maxTokens: 1234 })
})

test('audience=main 的 agent-request 配置：仅主会话 patch，子代理透传', async () => {
  const { listeners } = makeWiredHarness([
    { id: 'req-main', layer: 'agent-request', strategy: 'static', audience: 'main', params: { patch: { maxTokens: 5678 } } },
  ])
  const handler = listeners.get('agent/request')
  const base = async () => ({ provider: 'p', model: 'm', maxTokens: 1000 })
  const mainAgent = { session: { header: { delegationDepth: 0 } }, options: { model: 'deepseek-v4-pro-8013' } }
  assert.deepEqual(await handler({ agent: mainAgent }, base), { provider: 'p', model: 'm', maxTokens: 5678 })
  const subAgent = { session: { header: { delegationDepth: 1 } }, options: { model: 'deepseek-v4-pro-8013' } }
  assert.deepEqual(await handler({ agent: subAgent }, base), { provider: 'p', model: 'm', maxTokens: 1000 })
})

test('层能力矩阵校验：矩阵 false 字段在对应层显式提供时 fail loud', () => {
  assert.throws(
    () => createPromptConfigs([{ id: 'bad', layer: 'llm-stream', audience: 'main' }]),
    /layer "llm-stream" does not support field\(s\): audience/,
  )
  assert.throws(
    () => createPromptConfigs([{ id: 'bad2', layer: 'system-section', modelScope: 'flash' }]),
    /layer "system-section" does not support field\(s\): modelScope/,
  )
  assert.throws(
    () => createPromptConfigs([{ id: 'bad3', layer: 'agent-request', position: 'after-user' }]),
    /layer "agent-request" does not support field\(s\): position/,
  )
  // audience: null（UI 写回的「公用」）不算显式提供，应放行。
  const ok = createPromptConfigs([{ id: 'ok', layer: 'llm-stream', audience: null }])
  assert.equal(ok[0].audience, null)
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
    sourceKind: 'plugin',
    params: { text: 'CONFIG_TEXT', firstTurnWord: '我是xxx' },
  }]))
  const decision = await step(agent({ session: {
    id: 'ac1', header: { delegationDepth: 0 },
    snapshotEvents: () => [assistantReasoning('我是xxx，开始分析')],
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
    sourceKind: 'plugin',
    params: { text: 'FALLBACK_TEXT', firstTurnWord: '锚点A' },
  }]))
  const oneRound = await step(agent({ session: {
    id: 'ac2', header: { delegationDepth: 0 },
    snapshotEvents: () => [assistantReasoning('我是别的开头')],
  } }))
  assert.equal(oneRound.messages.length, 1)
  const twoRounds = await step(agent({ session: {
    id: 'ac3', header: { delegationDepth: 0 },
    snapshotEvents: () => [assistantReasoning('我是别的开头'), assistantReasoning('第二轮回合')],
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
    snapshotEvents: () => [{ type: 'user/message', data: { source: { kind: 'plugin', plugin: 'merged:after-all' } } }],
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

test('runtime-context placeholder：注册同步占位，assembly 时动态填充', async () => {
  const contexts = []
  const { listeners } = makeWiredHarness([
    { id: 'ctx-env', layer: 'runtime-context', strategy: 'placeholder', fill: 'env-facts', order: 5,
      text: '工作区={{WORKSPACE}}' },
  ], {
    systemPrompt: {
      variable() { return () => {} },
      section() { return () => {} },
      context(def) { contexts.push(def); return () => {} },
    },
  })
  assert.equal(contexts.length, 1)
  const result = await assembleRuntimeContexts(contexts, listeners, agent({ session: { id: 'ctx1', header: { delegationDepth: 0, cwd: 'D:/repo' }, snapshotEvents: () => [] } }))
  assert.equal(result[0].text, '工作区=D:/repo')
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

test('world-book selectiveLogic：all 副键全中 / not 排除 / any 任一命中（anchor-match 引擎）', async () => {
  const { step } = makeHarness(createPromptConfigs([
    { id: 'lore-all', strategy: 'world-book', layer: 'pre-step', position: 'before-all', texts: ['ALL'], params: { keys: ['剑'], secondaryKeys: ['鞘', '刃'], selectiveLogic: 3 } },
    { id: 'lore-not', strategy: 'world-book', layer: 'pre-step', position: 'before-all', texts: ['NOT'], params: { keys: ['盾'], secondaryKeys: ['破'], selectiveLogic: 1 } },
    { id: 'lore-any', strategy: 'world-book', layer: 'pre-step', position: 'before-all', texts: ['ANY'], params: { keys: ['弓'], secondaryKeys: ['矢'] } },
  ]))
  const stub = agent()
  const run = async (texts) => {
    const messages = texts.map((text, index) => ({
      id: `m-${index}`, role: 'user',
      content: [{ type: 'text', text }], source: { kind: 'user' },
    }))
    const decision = await step(stub, messages)
    return decision.messages.map((message) => extractText(message)).join('|')
  }
  assert.ok((await run(['剑与鞘刃'])).includes('ALL'), 'all：副键全中注入')
  assert.ok(!(await run(['剑与鞘'])).includes('ALL'), 'all：缺副键不注入')
  assert.ok(!(await run(['破盾'])).includes('NOT'), 'not：副键命中排除')
  assert.ok((await run(['盾牌'])).includes('NOT'), 'not：副键未命中注入')
  assert.ok((await run(['弓'])).includes('ANY'), 'any：主键命中注入')
  assert.ok(!(await run(['无关'])).includes('ALL'), '无命中不注入')
})

test('会话变量：session_var 设置后 pre-step 注入 {{key}} 替换为会话值（覆盖预设默认）', async () => {
  const { step } = makeHarness(createPromptConfigs([
    { id: 'var-probe', strategy: 'static', layer: 'pre-step', position: 'before-all', texts: ['心情：{{心情}}｜接受值：{{接受值}}'] },
  ]))
  const stub = agent()
  const session = stub.session
  const run = async () => {
    const decision = await step(stub)
    return decision.messages.map((message) => extractText(message)).join('|')
  }
  assert.ok((await run()).includes('心情：{{心情}}'), '无会话变量且无预设值 → 保留字面（宽容语义）')
  setSessionVar(session, '心情', '😊')
  setSessionVar(session, '接受值', '42')
  const injected = await run()
  assert.ok(injected.includes('心情：😊'), '会话变量替换注入')
  assert.ok(injected.includes('接受值：42'))
  // 配置自身 variables 优先于会话变量（显式配置值胜）。
  const { step: step2 } = makeHarness(createPromptConfigs([
    { id: 'var-own', strategy: 'static', layer: 'pre-step', position: 'before-all', texts: ['{{心情}}'], variables: { 心情: '配置值' } },
  ]))
  const stub2 = agent()
  setSessionVar(stub2.session, '心情', '会话值')
  const decision2 = await step2(stub2)
  const injected2 = decision2.messages.map((message) => extractText(message)).join('|')
  assert.ok(injected2.includes('会话值'), '会话变量覆盖配置 variables（配置自身不高于会话）')
})

test('createPromptConfigs：重复 ID 挂载前 fail loud（后者覆盖前者会静默丢卡）', () => {
  assert.throws(
    () => createPromptConfigs([
      { id: 'dup', strategy: 'static', text: 'A' },
      { id: 'other', strategy: 'static', text: 'B' },
      { id: 'dup', strategy: 'static', text: 'A2' },
    ]),
    /duplicate prompt config id "dup"/,
  )
})

test('createPromptConfigs：templateFile 越出预设根 fail loud（防任意文件进入模型上下文）', () => {
  assert.throws(
    () => createPromptConfigs([{ id: 'bad', strategy: 'static', templateFile: 'D:/Windows/win.ini' }]),
    /escapes preset root/,
  )
  assert.throws(
    () => createPromptConfigs([{ id: 'bad', strategy: 'static', templateFile: '../../../etc/passwd' }]),
    /escapes preset root/,
  )
})

test('createPromptConfigs：注入 presetRoot 后按预设根解析与校验 templateFile', () => {
  const base = mkdtempSync(join(tmpdir(), 'pt-preset-root-'))
  const root = join(base, 'presets')
  const presetDir = join(root, 'pt-demo')
  mkdirSync(join(presetDir, 'assets'), { recursive: true })
  writeFileSync(join(presetDir, 'assets', 't.txt'), 'TEMPLATE-BODY')
  writeFileSync(join(base, 'outside.txt'), 'OUTSIDE')
  try {
    const templatePresetRoot = pathToFileURL(root)
    // 注入基准时，相对 templateFile 仍按历史引擎位置 <预设根>/.engine/ 解析 —— 用户预设
    // 与提示词配置无需改写，越界校验基准则换成注入的预设根。基准按目录语义补尾斜杠，
    // 与引擎 apply 的归一一致（裸 URL 会被相对解析吃掉最后一段路径）。
    const templateBaseUrl = new URL('.engine/prompt-config-engine.mjs', `${templatePresetRoot.href}/`)
    assert.doesNotThrow(
      () => createPromptConfigs(
        [{ id: 'ok', strategy: 'static', templateFile: '../pt-demo/assets/t.txt' }],
        { templateBaseUrl, templatePresetRoot },
      ),
      '预设根内的历史形态 templateFile 必须可解析',
    )
    assert.throws(
      () => createPromptConfigs(
        [{ id: 'bad', strategy: 'static', templateFile: '../../outside.txt' }],
        { templateBaseUrl, templatePresetRoot },
      ),
      /escapes preset root/,
      '越出注入预设根必须被拒',
    )
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('wireLayers 只装配实际声明的插入点：未声明 seam 无监听器', () => {
  // 只声明 pre-step：applyPromptConfigs 应只注册 pre-step 相关监听，
  // 其余五个非 pre-step 层级（agent/request / llm/stream / tools/* / system-prompt）无监听器。
  const listeners = []
  const ctx = {
    on(name) { listeners.push(name) },
    get() { return undefined },
    logger: { warn() {} },
  }
  applyPromptConfigs(ctx, createPromptConfigs([
    { id: 'pre', strategy: 'static', layer: 'pre-step', text: 'A' },
  ]), { prepend: true })
  const declared = new Set(listeners)
  assert.ok(declared.has('agent/pre-step'), 'pre-step 应注册')
  for (const seam of ['agent/request', 'llm/stream', 'tools/pre-execute', 'tools/post-execute', 'system-prompt/assemble']) {
    assert.equal(declared.has(seam), false, `${seam} 未声明时不应有监听器`)
  }
})

// 由 meta.test.mjs 并入（2026-09-17 测试归一精简）：引擎能力矩阵与内置策略集合契约。

test('getEngineMeta 返回引擎能力矩阵，内置策略集合稳定', () => {
  const meta = getEngineMeta()
  assert.ok(meta.layers.includes('pre-step'))
  assert.ok(meta.layers.includes('tool-pipeline'))
  assert.ok(meta.strategies.includes('custom-fallback'))
  assert.ok(!meta.strategies.includes('anchor-fallback'))
  assert.ok(!meta.strategies.includes('we-fallback'))
  assert.deepEqual(meta.strategies, ['custom-fallback', 'first-turn-anchor', 'guide-auto', 'placeholder', 'static', 'world-book'])
  assert.ok(meta.fills.includes('instruction-hint'))
  assert.ok(meta.fills.includes('skill-catalog'))
  assert.ok(meta.layerFieldPolicies['pre-step'].position === true)
  assert.ok(meta.layerFieldPolicies['agent-request'].order === true)
  assert.ok(meta.layerLabels['pre-step'].title.length > 0)
  assert.deepEqual([...KNOWN_STRATEGIES].sort(), meta.strategies)
})

// R6（2026-09-20）：模板专属策略在 runtime-context 被真实消费，且相对 strategyDir 可解析。

test('runtime-context 模板专属策略：assembly 时调用 resolve 返回动态内容', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-strategy-'))
  try {
    writeFileSync(join(dir, 'dynamic.mjs'), [
      'export const createResolver = (config) => (args) => ({ text: `动态:${config.id}:${args.messages.length}` })',
      '',
    ].join('\n'))
    const contexts = []
    const { disposed, listeners } = makeWiredHarness([
      { id: 'ctx-dynamic', layer: 'runtime-context', strategy: 'dynamic', order: 5 },
    ], {
      systemPrompt: {
        variable() { return () => {} },
        section() { return () => {} },
        context(def) {
          contexts.push(def)
          return () => { contexts.length = 0 }
        },
      },
    }, { strategyDir: pathToFileURL(dir).href })
    // 官方注册只含同步文本；异步模板策略在 waterfall 被实际消费。
    assert.equal(contexts.length, 1)
    assert.equal((await assembleRuntimeContexts(contexts, listeners))[0].text, '动态:ctx-dynamic:0')
    // 释放：provider 随 disposer 撤销，不留下后台注册。
    assert.equal(typeof disposed.at(-1), 'function')
    disposed.at(-1)()
    assert.equal(contexts.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('apply：相对 strategyDir 在入口解析为绝对 URL，与绝对写法指向同一模块', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pt-engine-apply-'))
  try {
    // 真实预设布局：engine/ 与 strategies/、prompt-configs/ 同级，故相对写法是 ../strategies。
    cpSync(new URL('../../engine/', import.meta.url), join(root, 'engine'), { recursive: true })
    mkdirSync(join(root, 'strategies'))
    writeFileSync(join(root, 'strategies', 'dynamic.mjs'), [
      'export const createResolver = (config) => () => ({ text: `DYN:${config.id}` })',
      '',
    ].join('\n'))
    mkdirSync(join(root, 'prompt-configs'))
    writeFileSync(join(root, 'prompt-configs', '00-dynamic.yml'), [
      'id: dyn-ctx',
      'layer: runtime-context',
      'strategy: dynamic',
      'order: 1',
      '',
    ].join('\n'))
    const { apply } = await import(pathToFileURL(join(root, 'engine', 'prompt-config-engine.mjs')).href)
    const run = async (strategyDir) => {
      const contexts = []
      const listeners = new Map()
      const ctx = {
        on(name, handler) { listeners.set(name, handler); return () => {} },
        get(name) {
          return name === 'systemPrompt'
            ? { variable() { return () => {} }, section() { return () => {} }, context(def) { contexts.push(def); return () => {} } }
            : undefined
        },
        effect(callback) { callback() },
        logger: { warn() {} },
      }
      apply(ctx, { configsDir: '../prompt-configs', strategyDir })
      assert.equal(contexts.length, 1)
      return (await assembleRuntimeContexts(contexts, listeners))[0].text
    }
    // 相对 ../strategies 不再抛 ERR_INVALID_URL，且与绝对 URL 求值一致。
    assert.equal(await run('../strategies'), 'DYN:dyn-ctx')
    assert.equal(await run(pathToFileURL(join(root, 'strategies')).href), 'DYN:dyn-ctx')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
