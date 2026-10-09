import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { applyPromptConfigs, confirmDelivered, runPreStepBatch } from '../../engine/executor.mjs'
import { wireLayers } from '../../engine/layers.mjs'
import { createPromptConfigs as createPromptConfigsCore } from '../../engine/schema.mjs'
import { registerAction } from '../../engine/actions.mjs'

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

test('F30：批内无 user 消息时 after-user 跳过并告警一次，同批其余位置照注入，下一含 user 的批仍注入', async () => {
  const configs = [
    { id: 'head', layer: 'pre-step', strategy: 'static', position: 'before-all', text: 'HEAD' },
    { id: 'tail', layer: 'pre-step', strategy: 'static', position: 'after-all', text: 'TAIL' },
    { id: 'anchor', layer: 'pre-step', strategy: 'static', text: 'ANCHOR' },
  ]
  const harness = makeHarness(createPromptConfigs(configs))
  const probe = agent({ session: { id: 's-anchor', header: { delegationDepth: 0 }, snapshotEvents: () => [] } })
  const say = (id) => [{ id, role: 'user', content: [{ type: 'text', text: '用户消息' }], source: { kind: 'user' } }]
  const texts = (decision) => decision.messages.flatMap(message => message.content.map(block => block.text))

  // 无锚点批（宿主内部消息，如压缩摘要）：after-user 跳过不注入，其余位置照常。
  const noUser = [{ id: 'u0', role: 'user', content: [{ type: 'text', text: '摘要' }], source: { kind: 'agent-summary' } }]
  const skipped = await harness.step(probe, noUser)
  assert.deepEqual(texts(skipped), ['HEAD', '摘要', 'TAIL'], '缺锚点只影响 after-user')
  assert.deepEqual(harness.warnings.filter(message => message.includes('after-user')), [
    'prompt-config-engine: after-user config(s) anchor skipped this batch — no user message anchor',
  ], '恰一条告警且含配置 id')

  // 下一批有真实用户消息：同样的 after-user 配置仍注入（逐批跳过，不是永久丢失）。
  const anchored = await harness.step(probe, say('u1'))
  assert.deepEqual(texts(anchored), ['HEAD', '用户消息', 'ANCHOR', 'TAIL'], '含 user 的批恢复注入且紧跟锚点')
  assert.equal(harness.warnings.filter(message => message.includes('after-user')).length, 1, '恢复注入不再重复告警')
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

test('group + exclusive 是静默互斥：同组只运行声明序第一个，且不返回错误码', async () => {
  // PLAN 的 T8 verify 原话是「两条 complete 互斥仍返回同一错误码」——实证查证后不存在
  // 这样一处校验（engine/executor.mjs 的 claimedGroups 是纯过滤，不产生错误码）。
  // 按用户拍板，这条 verify 改断言真实语义：同 group 且 exclusive=true 时，
  // 只有列表里第一个启用的配置运行；其余同组独占配置被安静丢弃，不抛错、不返回 code。
  const specs = [
    { id: 'a-excl', strategy: 'static', text: 'A', position: 'after-user', group: 'g1', exclusive: true },
    { id: 'b-excl', strategy: 'static', text: 'B', position: 'after-user', group: 'g1', exclusive: true },
    { id: 'c-disabled', strategy: 'static', text: 'C', position: 'after-user', group: 'g1', exclusive: true, enabled: false },
    { id: 'd-other', strategy: 'static', text: 'D', position: 'after-user', group: 'g2', exclusive: true },
    { id: 'e-shared', strategy: 'static', text: 'E', position: 'after-user', group: 'g1' },
  ]
  const { step, warnings } = makeHarness(createPromptConfigs(specs))
  const decision = await step(agent())
  assert.deepEqual(
    decision.messages.filter((message) => message.source?.plugin !== undefined).map((message) => message.source.plugin),
    ['a-excl', 'd-other', 'e-shared'],
    '同组独占只留声明序第一个；非独占成员与其它组不受影响',
  )
  assert.equal(decision.code, undefined, '静默互斥不产生错误码')
  assert.deepEqual(warnings, [], '静默互斥不告警')
})

test('createPromptConfigs 默认 layer=pre-step；未知 layer fail loud', () => {
  assert.equal(createPromptConfigs([{ id: 'x', strategy: 'static' }])[0].layer, 'pre-step')
  assert.throws(() => createPromptConfigs([{ id: 'x', layer: 'nope' }]), /unknown layer/)
})

test('配置层直读不受规则动作白名单影响：group/exclusive 与 params.complete 仍合法', () => {
  // F24/F27 的拒绝只落在 rule-spec 的动作侧（normalizeActionGates / 逐动作校验），
  // 不能搬进这里：配置层 group 是合法字段，prompt-configs 直读路径不看层语义。
  assert.equal(createPromptConfigs([{ id: 'cfg-group', strategy: 'static', text: 'G', position: 'after-user', group: 'g1', exclusive: true }]).length, 1)
  assert.equal(createPromptConfigs([{ id: 'cfg-complete', strategy: 'static', layer: 'pre-step', text: 'C', params: { complete: true } }]).length, 1)
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

test('decision 动作承担工具链：pre 定向裁决 allow/deny、post 定向替换结果', async () => {
  // 原用例走 inject-text 的 tool-pipeline 配置；该层已无注入通道（规则路径与公开动作路径
  // 一致拒绝，见 test/engine/rules.test.mjs），工具链行为由 decision 动作承担同一组通道与定向。
  const listeners = new Map()
  const ctx = { on(name, handler) { listeners.set(name, handler); return () => listeners.delete(name) }, get() {}, logger: { warn() {} } }
  registerAction(ctx, { id: 'tp', kind: 'decision', phase: 'pre', decision: 'deny', reason: 'no bash', toolNames: 'bash' })
  registerAction(ctx, { id: 'tp-post', kind: 'decision', phase: 'post', action: 'replace', text: 'REPLACED', toolNames: 'bash' })
  const exec = { name: 'bash', agent: { session: { header: { delegationDepth: 0 } }, options: { model: 'deepseek-v4-pro-8013' } }, arguments: { command: 'ls' } }
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
  // source.kind 必须是**生产者名**：会话格式 v4 把裸 `plugin` 列为退役包装，
  // 写了它整条 `agent/inbox/spliced` 会被 codec 拒绝，子代理启动直接失败（真机踩过）。
  assert.match(injected[0].source.kind, /^plugin:/, '注入消息的 kind 必须是生产者名而不是裸 plugin')
  assert.notEqual(injected[0].source.kind, 'plugin')

  listener({ id: 'child-2', runId: 'r2' })
  assert.equal(injected.length, 1, '未命中条件不注入')
})

test('inject-text 配置默认来源统一为生产者身份：注入消息的 kind 带 plugin 前缀且不是裸 plugin', async () => {
  // 真机踩过：sourceKind 默认取裸规则 id，注入消息的 kind 因此没有 `plugin:` 前缀，
  // 会话格式 v4 把裸 `plugin` 列为退役包装，整条 `agent/inbox/spliced` 会被 codec 拒绝。
  const harness = makeHarness(createPromptConfigs([{
    id: 'readonly-probe', layer: 'pre-step', strategy: 'static', audience: 'subagent',
    text: '只读档：你在做只读任务', dedupe: 'session',
  }]))
  const probe = agent({ session: { id: 's-src', header: { delegationDepth: 1 }, snapshotEvents: () => [] } })
  const task = [{ id: 'u1', role: 'user', content: [{ type: 'text', text: '只读分析一下这个目录' }], source: { kind: 'user' } }]

  const first = await harness.step(probe, task)
  const injected = first.messages.find((m) => m.source?.kind !== 'user' && m.source?.kind !== 'agent-instructions')
  assert.ok(injected !== undefined, '条件命中应注入')
  assert.match(injected.source.kind, /^plugin:/, '注入消息必须携带生产者身份前缀')
  assert.notEqual(injected.source.kind, 'plugin', '不得写成已退役的裸 plugin')
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

test('解析器自带 source 的候选按身份盖章：dedupe=session 下多步只注入一次', async () => {
  // instruction-hint 的 text / file 两个分支都返回 source（{"kind":"instruction-hint"} /
  // {"kind":"instruction-file"}）且不带 plugin；resolved.source 直接当消息 source 用时，
  // 身份只落在 kind 通道，alreadyDelivered 永远查不到，于是每步重复注入。
  for (const params of [{ text: '参考文件提示' }, { file: fileURLToPath(import.meta.url) }]) {
    const { step, admit } = makeHarness(createPromptConfigs([
      { id: 'hint', strategy: 'placeholder', fill: 'instruction-hint', dedupe: 'session', params, position: 'after-user' },
    ]))
    const probe = agent({ session: { id: 's-hint-source', header: { delegationDepth: 0 }, snapshotEvents: () => [] } })
    const hintOf = (decision) => decision.messages.filter((message) => message.source?.kind?.startsWith('instruction-'))
    let injected = 0
    for (let round = 0; round < 4; round += 1) {
      const decision = await step(probe)
      injected += hintOf(decision).length
      admit(probe, decision)
    }
    assert.equal(injected, 1, `声明解析器 source 的候选每会话只投递一次（${JSON.stringify(params)}）`)
  }
})

test('显式 identity：先到者被接纳后，晚一步的卡不再经自己的 id 重复注入', async () => {
  const identity = { field: 'plugin', value: 'shared-identity' }
  const { step, admit } = makeHarness(createPromptConfigs([
    { id: 'card-a', strategy: 'static', dedupe: 'session', text: 'A', position: 'after-all', identity },
    { id: 'card-b', strategy: 'static', dedupe: 'session', text: 'B', position: 'after-all', identity },
  ]))
  const events = []
  const probe = agent({ session: { id: 's-shared-identity', header: { delegationDepth: 0 }, snapshotEvents: () => events } })
  const injectedTexts = (decision) => decision.messages.filter((message) => message.source?.plugin !== undefined)
    .map((message) => message.content[0].text)
  // 宿主接纳 = 逐条写进持久事件流；只接纳**先到者**：晚一步的卡必须靠共享身份去重，
  // 而不是靠自己那份 kind 通道（后者不区分两张卡，也就测不出盖章是否与查找同源）。
  const adopt = (decision) => {
    const first = decision.messages.filter((message) => message.source?.plugin !== undefined).slice(0, 1)
    admit(probe, { messages: first })
    for (const message of first) events.push({ type: 'user/message', seq: events.length + 1, data: { message } })
  }

  const first = await step(probe)
  assert.deepEqual(injectedTexts(first), ['A', 'B'], '同一批里两张卡都算「先到」')
  adopt(first)
  assert.deepEqual(injectedTexts(await step(probe)), [], '先到者被接纳后，同身份的晚到者不再注入')
})

/**
 * 会话桩：`log` 是真值源，`surface.nodes` 按宿主 `foldSurface` 的语义维护
 * （`packages/core/session/src/surface.ts:563-585`）——append 只追加节点，**只有 replace**
 * 会移除/替换节点并推进 `replaceGeneration`，而成功压缩就是一次 replace。
 */
function surfaceSession(id = 's-surface') {
  const log = []
  const nodes = []
  let replaceGeneration = 0
  const session = {
    id,
    header: { delegationDepth: 0 },
    snapshotEvents: () => log,
    surface: { get nodes() { return nodes }, get replaceGeneration() { return replaceGeneration } },
  }
  return {
    session,
    /** 宿主接纳：消息写进 durable 日志并 append 到可见视图。 */
    admit(message) {
      log.push({ type: 'user/message', seq: log.length, data: { message } })
      nodes.push(log.length - 1)
    },
    /** 成功压缩：可见节点塌缩成一条摘要，代次 +1（`nodes` 里被遮蔽的 seq 不再可见）。 */
    compact(summary) {
      nodes.splice(0, nodes.length)
      log.push({ type: 'compaction/end', seq: log.length, data: {} })
      log.push({ type: 'user/message', seq: log.length, data: { message: summary } })
      nodes.push(log.length - 1)
      replaceGeneration += 1
    },
  }
}

/** 本引擎注入的那几条（`source.moduleId` 是本轮新盖章的模块维）。 */
const injectedOf = (decision) => decision.messages.filter((message) => message.source?.moduleId !== undefined)

test('T5：去重身份带模块维——整模块复制的两个副本各自注入，身份字符串一字不改', async () => {
  // 整模块复制保留 rule id 与卡 id，两个模块编译出的身份逐字相同；这里把两份配置放进
  // 同一个挂载 = 协调器路径的合并批（共用一份 memo），跨模块串味只可能发生在这里。
  const configs = ['copy-a', 'copy-b'].flatMap((moduleId) => createPromptConfigs(
    [{ id: 'shared-hint', layer: 'pre-step', strategy: 'static', dedupe: 'session', text: `${moduleId}-HINT`, position: 'after-all' }],
    { sourceModuleId: moduleId },
  ))
  const harness = makeHarness(configs)
  const store = surfaceSession()
  const probe = agent({ session: store.session })
  const deliver = (decision) => {
    for (const message of injectedOf(decision)) {
      store.admit(message)
      harness.admit(probe, { messages: [message] })
    }
  }

  const first = await harness.step(probe)
  assert.deepEqual(injectedOf(first).map((message) => message.content[0].text).sort(),
    ['copy-a-HINT', 'copy-b-HINT'], '新会话里两个副本各自注入')
  assert.deepEqual(injectedOf(first).map((message) => message.source.moduleId), ['copy-a', 'copy-b'],
    '模块维是新盖的 source 字段')
  for (const message of injectedOf(first)) {
    assert.equal(message.source.plugin, 'shared-hint', '身份字符串（blockPlugins 的匹配键）一字不改')
    assert.equal(message.source.kind, 'plugin:shared-hint', 'kind 通道格式同样不变')
  }

  // 只接纳 copy-a 的那条：复制出来的 copy-b 候选可能被外层门控剥离，或后加进启用表。
  const [copyA] = injectedOf(first)
  store.admit(copyA)
  harness.admit(probe, { messages: [copyA] })
  const second = await harness.step(probe)
  assert.deepEqual(injectedOf(second).map((message) => message.source.moduleId), ['copy-b'],
    'copy-a 已有本模块命中；copy-b 不因身份相同被它挡住')

  deliver(second)
  assert.deepEqual(injectedOf(await harness.step(probe)), [], '两个副本各与自己模块的那条配对后都不再注入')
})

test('T5：当前上下文里的旧格式消息（无模块维）仍被识别、不重复注入', async () => {
  const harness = makeHarness(createPromptConfigs(
    [{ id: 'notice', layer: 'pre-step', strategy: 'static', dedupe: 'session', text: 'NOTICE', position: 'after-all' }],
    { sourceModuleId: 'mod-a' },
  ))
  const store = surfaceSession()
  const probe = agent({ session: store.session })
  // 升级前注入的样子：只有 plugin 字段、没有 moduleId（v4 之前写下的旧日志）。
  store.admit({ id: 'legacy', role: 'user', content: [{ type: 'text', text: 'NOTICE' }], source: { plugin: 'notice' } })
  assert.deepEqual(injectedOf(await harness.step(probe)), [], '无模块维的旧消息按保守命中算已投递')
})

test('T5：跨压缩语义 = 每当前上下文一次——被遮蔽的注入重新注入', async () => {
  const harness = makeHarness(createPromptConfigs(
    [{ id: 'notice', layer: 'pre-step', strategy: 'static', dedupe: 'session', text: 'NOTICE', position: 'after-all' }],
    { sourceModuleId: 'mod-a' },
  ))
  const store = surfaceSession()
  const probe = agent({ session: store.session })

  const first = await harness.step(probe)
  assert.equal(injectedOf(first).length, 1, '新会话注入一次')
  for (const message of injectedOf(first)) {
    store.admit(message)
    harness.admit(probe, { messages: [message] })
  }
  assert.deepEqual(injectedOf(await harness.step(probe)), [], '还在当前上下文里 → 不重复注入')

  store.compact({ id: 'summary', role: 'user', content: [{ type: 'text', text: '摘要' }], source: { kind: 'agent-summary' } })
  assert.equal(injectedOf(await harness.step(probe)).length, 1,
    '被压缩遮蔽后按当前上下文重新注入（旧判据扫全量日志 → 仍判已投递）')
})

test('T5：无 surface 的桩退化为完整历史扫描（等价迁移前行为）', async () => {
  const harness = makeHarness(createPromptConfigs(
    [{ id: 'notice', layer: 'pre-step', strategy: 'static', dedupe: 'session', text: 'NOTICE', position: 'after-all' }],
    { sourceModuleId: 'mod-a' },
  ))
  const events = []
  const probe = agent({ session: { id: 's-degraded', header: { delegationDepth: 0 }, snapshotEvents: () => events } })
  const first = await harness.step(probe)
  assert.equal(injectedOf(first).length, 1)
  // 只写日志、不通知 session/event：命中的只能是扫描（不是 memo 记账）。
  for (const message of injectedOf(first)) events.push({ type: 'user/message', seq: events.length, data: { message } })
  assert.deepEqual(injectedOf(await harness.step(probe)), [], '无 surface 时可见上下文 = 完整历史')
})

test('T5：memo 是纯性能缓存——清空后再判一次，两个方向的结论都不变', async () => {
  const configs = createPromptConfigs(
    [{ id: 'notice', layer: 'pre-step', strategy: 'static', dedupe: 'session', text: 'NOTICE', position: 'after-all' }],
    { sourceModuleId: 'mod-a' },
  )
  const store = surfaceSession()
  const probe = agent({ session: store.session })
  const memo = new Map()
  const run = () => runPreStepBatch({
    ctx: {},
    agent: probe,
    decision: { kind: 'enter', messages: [userTask] },
    configs,
    memo,
    promotion: { main: { status: () => ({ promoted: true }) }, withSubagents: { status: () => ({ promoted: true }) } },
    warnOnce: () => {},
  })

  const first = await run()
  assert.equal(injectedOf(first).length, 1)
  for (const message of injectedOf(first)) {
    store.admit(message)
    confirmDelivered(memo, store.session, { type: 'user/message', data: { message } })
  }
  assert.ok(memo.size > 0, '快路径确实记了账')

  memo.clear()
  assert.deepEqual(injectedOf(await run()), [], 'memo 清空后仍按当前上下文判定：不重复注入')

  store.compact({ id: 'summary', role: 'user', content: [{ type: 'text', text: '摘要' }], source: { kind: 'agent-summary' } })
  memo.clear()
  assert.equal(injectedOf(await run()).length, 1, 'memo 清空 + 上下文遮蔽后照常重新注入')
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

test('wireLayers 只装配实际声明的插入点：未声明 seam 无监听器', () => {
  // 只声明 pre-step：applyPromptConfigs 应只注册 pre-step 相关监听，
  // 其余非 pre-step 层级（agent/request / llm/stream / tools/* / system-prompt）无监听器。
  // tools/* 的监听只可能来自 decision / append-context 动作，不由注入配置产生。
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

test('wireLayers 对没有注入通道的层告警一次：直供 tool-pipeline 配置不再静默丢弃', () => {
  // 规则路径与公开动作路径都在上游拒绝 tool-pipeline（见 test/engine/rules.test.mjs），
  // 这里覆盖的是 config 级公开入口直供该层配置的兜底：必须可见，不得静默。
  const warnings = []
  const config = createPromptConfigs([{ id: 'tp-direct', layer: 'tool-pipeline', strategy: 'static', text: 'X' }])[0]
  const ctx = { on: () => () => {}, get() { return undefined }, logger: { warn: (message) => warnings.push(message) } }
  wireLayers(ctx, [config], (message) => warnings.push(message))
  assert.equal(warnings.length, 1, '每个无通道配置告警一次')
  assert.match(warnings[0], /tool-pipeline 没有注入通道/)
})

test('wireLayers 公开入口：注册层的动作级分支走条件化注册，不被无条件注册吞掉', async () => {
  // 声明路径编译期已拒绝注册层的动作级分支（rule-spec.mjs 的 REGISTRATION_LAYERS 校验），
  // 故 config.actionWhen 只剩公开 wireLayers 入口可达；直供配置带它时必须仍按分支注册，
  // 否则动作级 if 会被无条件注册整段忽略，与其余七层经 actionMatches 的判定不一致。
  const sections = []
  const listeners = new Map()
  const ctx = {
    on(name, handler) { listeners.set(name, handler); return () => listeners.delete(name) },
    get: (name) => (name === 'systemPrompt'
      ? { variable: () => () => {}, section(def) { sections.push(def); return () => {} } }
      : undefined),
    logger: { warn() {} },
  }
  const config = { ...createPromptConfigs([{ id: 'gated', layer: 'system-section', strategy: 'static', text: 'GATED' }])[0], actionWhen: () => false }
  wireLayers(ctx, [config], () => {})
  assert.equal(sections.length, 1)
  assert.match(sections[0].text, /^\{\{pt_rule_/, '带动作级分支必须注册占位，不得直接注册正文')
  const assembly = { contexts: [], sections: [{ name: sections[0].name, text: sections[0].text }] }
  const result = await listeners.get('system-prompt/assemble')(assembly, { agent: agent() }, async () => assembly)
  assert.equal(result.sections[0].text, '', 'actionWhen=false 时该段正文为空')
})

test('原生关键词世界书只扫描本批真实对话消息：插件注入与指令文件正文都不触发', async () => {
  // 与 userText / ST 世界书同一判据（condition.mjs#isConversationMessage）：扫描范围
  // = 本批真实对话消息，不含任何插件来源（append-context / 子代理 inject / skill_load）
  // 与 agent-instructions 正文。
  const { step } = makeHarness(createPromptConfigs([{
    id: 'lore', strategy: 'world-book', text: 'LORE', position: 'after-all', params: { keys: ['龙'] },
  }]))
  const say = (id, text, source = { kind: 'user' }, role = 'user') => ({ id, role, content: [{ type: 'text', text }], source })
  const injected = decision => decision.messages.filter((message) => message.source?.plugin === 'lore').map((message) => message.content[0].text)
  const probe = agent({ session: { id: 's-lore', header: { delegationDepth: 0 }, snapshotEvents: () => [] } })
  assert.deepEqual(injected(await step(probe, [
    say('u1', '普通提问'),
    say('p1', '龙', { kind: 'plugin:skill-load', plugin: 'skill-load' }),
    say('p2', '龙', { kind: 'agent-instructions' }),
    say('p3', '龙', { kind: 'plugin:append-context', plugin: 'append-context' }),
  ])), [], '插件注入与指令文件正文不得计入关键词扫描')
  assert.deepEqual(injected(await step(probe, [say('u2', '这里有条龙')])), ['LORE'], '真实对话含关键词才命中')
  assert.deepEqual(injected(await step(probe, [say('u3', '普通提问'), say('a3', '龙出现了', { kind: 'user' }, 'assistant')])), ['LORE'], '真实 assistant 消息同样在扫描范围内')
})

test('guide-auto：缺省不启用长度业务阈值，显式 complexMinChars 按严格大于判定', async () => {
  const run = async (params, text) => {
    const { step } = makeHarness(createPromptConfigs([{ id: 'guide', strategy: 'guide-auto', params }]))
    return (await step(agent(), [{ ...userTask, content: [{ type: 'text', text }] }])).messages.slice(1).flatMap(message => message.content.map(block => block.text))
  }
  assert.deepEqual(await run({}, 'long task '.repeat(30)), [])
  const texts = { guideWeak: 'WEAK', guideDeep: 'DEEP' }
  assert.deepEqual(await run(texts, 'long task '.repeat(30)), ['WEAK'])
  assert.deepEqual(await run({ ...texts, complexMinChars: '' }, 'long task '.repeat(30)), ['WEAK'])
  assert.deepEqual(await run({ ...texts, complexMinChars: 3 }, 'abc'), ['WEAK'])
  assert.deepEqual(await run({ ...texts, complexMinChars: 3 }, 'abcd'), ['DEEP'])
  assert.deepEqual(await run({ ...texts, complexPattern: 'complex' }, 'complex'), ['DEEP'])
  assert.throws(() => createPromptConfigs([{ id: 'bad-guide', strategy: 'guide-auto', params: { complexMinChars: -1 } }]), /complexMinChars/)
})
