import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { applyPromptConfigs } from '../../engine/executor.mjs'
import { createPromptConfigs as createPromptConfigsCore } from '../../engine/schema.mjs'

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

test('显式 identity：确认过身份后同身份的两张卡都不再注入', async () => {
  const identity = { field: 'plugin', value: 'shared-identity' }
  const { step, admit } = makeHarness(createPromptConfigs([
    { id: 'card-a', strategy: 'static', dedupe: 'session', text: 'A', position: 'after-all', identity },
    { id: 'card-b', strategy: 'static', dedupe: 'session', text: 'B', position: 'after-all', identity },
  ]))
  const events = []
  const probe = agent({ session: { id: 's-shared-identity', header: { delegationDepth: 0 }, snapshotEvents: () => events } })
  const injectedTexts = (decision) => decision.messages.filter((message) => message.source?.plugin !== undefined)
    .map((message) => message.content[0].text)
  // 宿主接纳 = 逐条写进持久事件流：快路径查显式身份，持久扫描查消息自带身份，两条都得命中。
  const adopt = (decision) => {
    admit(probe, decision)
    for (const message of decision.messages) events.push({ type: 'user/message', seq: events.length + 1, data: { message } })
  }

  const first = await step(probe)
  assert.deepEqual(injectedTexts(first), ['A', 'B'], '同一批里两张卡都算「先到」')
  adopt(first)
  assert.deepEqual(injectedTexts(await step(probe)), [], '接纳后共享身份的两张卡都不再注入')
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
