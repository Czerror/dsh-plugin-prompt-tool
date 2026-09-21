// W3 接线证据（真实 Cordis 4.0.2 + dsh-scope + dsh-agent dispatch）：
//   1. 插件侧协调服务对预设 mount 的 scoped ctx 可见（跨 fiber 服务解析）；
//   2. 管理路径只有一个执行器：引擎行把来源注册给协调器，注入恰好一次（不双份）；
//   3. 来源作用域按 dsh-scope 生效：各自 mount 互不串、父 scope 对子代理可见、兄弟不可见；
//   4. scope.dispose() 后来源归零；协调服务迟到时引擎先撤旧再启用新路径；
//   5. 与 context-gate 共挂时门控仍在外层（未晋升步的注入被剥离）、reject 不被吞掉。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { NamedEntries, ScopedLayers, bindScopeParent, createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { apply as applyContextGate } from '../../engine/context-gate.mjs'
import { applyPromptConfigs, createPromptConfigs } from '../../engine/prompt-config-engine.mjs'
import { installPreStepCoordinator, PRE_STEP_COORDINATOR_SERVICE } from '../../src/runtime/pre-step-coordinator.ts'

const ENGINE_DIR = new URL('../../engine/', import.meta.url).href
const signalOf = () => new AbortController().signal

const userMessage = (text = 'claimed', id = 'u-claimed') => ({
  id,
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})

/** 最小本地 Agent：session 形状对齐 executor / compaction-epoch 的读取面。 */
const makeAgent = (id, events = [], header = {}) => ({
  session: {
    id,
    header: { delegationDepth: 0, ...header },
    snapshotEvents: () => events,
    deriveMessages: () => [],
  },
  options: { model: 'pro' },
})

/** 真实 scoped dispatch：agentEvents → ctx.waterfall(thisArg=carrier)。 */
const dispatch = (app, agent, next = async () => ({ kind: 'enter', messages: [userMessage()] })) =>
  agentEvents(app, agent).waterfall('agent/pre-step', { messages: [userMessage()], turn: 1, step: 1, signal: signalOf() }, next)

/** 挂 scope 的最小 Agent：agent.ctx 经 createScope 获得真实 scope tag（key=agent）。 */
const scopedAgent = (app, id, events = []) => {
  const agent = makeAgent(id, events)
  const scope = createScope(app, agent)
  agent.ctx = scope.ctx
  return { agent, scope }
}

const staticSpec = (id, text, extra = {}) => ({
  id,
  layer: 'pre-step',
  strategy: 'static',
  text,
  position: 'after-user',
  ...extra,
})

const textsOf = (decision) =>
  (Array.isArray(decision?.messages) ? decision.messages : [])
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .map((block) => block?.text ?? '')
    .filter((text) => text.length > 0)

const installEngine = (app, mount, specs, options = {}) =>
  applyPromptConfigs(
    mount.scope.ctx,
    createPromptConfigs(specs, { strategyDir: ENGINE_DIR }),
    { prepend: true, ...options },
  )

/**
 * 物化布局下的引擎行（`<presetRoot>/<template>/agent.cordis.yml` + `.engine/`）：
 * 用来验证引擎把「本 mount 是否仍挂着官方指令行」作为装配事实上报给协调器。
 */
const runEngineRow = async (compositionRow) => {
  const root = mkdtempSync(join(tmpdir(), 'pt-facts-'))
  const templateDir = join(root, 'standard')
  mkdirSync(join(templateDir, 'prompt-configs'), { recursive: true })
  writeFileSync(
    join(templateDir, 'prompt-configs', 'card.yml'),
    'id: card-1\nlayer: pre-step\nstrategy: static\ntext: BODY\n',
    'utf8',
  )
  writeFileSync(join(templateDir, 'agent.cordis.yml'), compositionRow, 'utf8')
  const engineFile = fileURLToPath(new URL('../../engine/prompt-config-engine.mjs', import.meta.url))
  // 真实物化布局：引擎只物化一份于 `<presetRoot>/.engine/`，组合引用 `../.engine/`，
  // configsDir 相对引擎文件解析 → `../<template>/prompt-configs`。
  cpSync(dirname(engineFile), join(root, '.engine'), { recursive: true })
  const registered = []
  const app = new Context()
  app.provide(PRE_STEP_COORDINATOR_SERVICE, {
    registerPreset: (ctx, sourceId, source) => {
      registered.push({ sourceId, source })
      return () => {}
    },
  })
  const engine = await import(pathToFileURL(join(root, '.engine', 'prompt-config-engine.mjs')).href)
  engine.apply(app, { configsDir: '../standard/prompt-configs' })
  rmSync(root, { recursive: true, force: true })
  return registered
}

test('T27 引擎上报 mount 装配事实：组合仍挂着官方指令行时标记负责人冲突', async () => {
  const withOfficial = await runEngineRow(
    "- id: agent-instructions\n  name: '@deepseek-ai/dsh-agent-instructions'\n  config:\n    maxBytes: 65536\n",
  )
  assert.equal(withOfficial.length, 1, '引擎把来源注册给协调器（管理路径）')
  assert.equal(withOfficial[0].sourceId, 'preset:standard')
  assert.equal(withOfficial[0].source.officialInstructions, true)

  const withoutOfficial = await runEngineRow('- id: something-else\n  name: ./x.mjs\n')
  assert.equal(withoutOfficial[0].source.officialInstructions, false, '没有官方指令行时不声明冲突')
})

test('T22 协调服务对 scoped mount ctx 可见，管理路径只注入一次（无第二个执行器）', async () => {
  const app = new Context()
  const service = installPreStepCoordinator(app, { collectFiles: () => [] })
  const agent = scopedAgent(app, 'agent-a')
  assert.equal(agent.scope.ctx.get(PRE_STEP_COORDINATOR_SERVICE), service, '跨 fiber 解析同一协调服务实例')
  installEngine(app, agent, [staticSpec('preset-card', 'PRESET BODY')], { sourceId: 'preset:a' })

  const decision = await dispatch(app, agent.agent)
  assert.deepEqual(textsOf(decision), ['claimed', 'PRESET BODY'], '预设来源只注入一次')
  assert.equal(decision.messages[1].source.plugin, 'preset-card')
})

test('T12 来源按 scope 隔离：各自 mount 互不串，父 scope 对子代理可见、兄弟不可见', async () => {
  const app = new Context()
  installPreStepCoordinator(app, { collectFiles: () => [] })
  const a = scopedAgent(app, 'agent-a')
  const b = scopedAgent(app, 'agent-b')
  const parent = scopedAgent(app, 'agent-parent')
  const child = scopedAgent(app, 'agent-child')
  bindScopeParent(child.agent, parent.agent)
  installEngine(app, a, [staticSpec('preset-a', 'A BODY')], { sourceId: 'preset:a' })
  installEngine(app, b, [staticSpec('preset-b', 'B BODY')], { sourceId: 'preset:b' })
  installEngine(app, parent, [staticSpec('preset-parent', 'PARENT BODY')], { sourceId: 'preset:parent' })

  assert.deepEqual(textsOf(await dispatch(app, a.agent)), ['claimed', 'A BODY'])
  assert.deepEqual(textsOf(await dispatch(app, b.agent)), ['claimed', 'B BODY'])
  assert.deepEqual(
    textsOf(await dispatch(app, child.agent)),
    ['claimed', 'PARENT BODY'],
    '子代理继承父 scope 的来源，不经过兄弟 scope 的配置',
  )
})

test('T22 scope.dispose() 后来源不再参战（先撤旧再启新）', async () => {
  const app = new Context()
  installPreStepCoordinator(app, { collectFiles: () => [] })
  const agent = scopedAgent(app, 'agent-dispose')
  installEngine(app, agent, [staticSpec('preset-card', 'PRESET BODY')], { sourceId: 'preset:dispose' })
  assert.deepEqual(textsOf(await dispatch(app, agent.agent)), ['claimed', 'PRESET BODY'])
  await agent.scope.dispose()
  assert.deepEqual(textsOf(await dispatch(app, agent.agent)), ['claimed'], 'dispose 释放该 scope 的来源')
})

test('T24 无协调服务时引擎独立执行（不依赖 src/host 或协调服务存在）', async () => {
  const app = new Context()
  const agent = scopedAgent(app, 'agent-standalone')
  installEngine(app, agent, [staticSpec('preset-card', 'STANDALONE BODY')])
  assert.deepEqual(textsOf(await dispatch(app, agent.agent)), ['claimed', 'STANDALONE BODY'])
})

test('T22 协调服务迟到：引擎先独立执行，服务出现后交出唯一执行权且不双份注入', async () => {
  const app = new Context()
  const agent = scopedAgent(app, 'agent-late')
  installEngine(app, agent, [staticSpec('preset-card', 'BODY')], { sourceId: 'preset:late' })
  assert.deepEqual(textsOf(await dispatch(app, agent.agent)), ['claimed', 'BODY'], '无协调器:独立路径')
  installPreStepCoordinator(app, { collectFiles: () => [] })
  assert.deepEqual(textsOf(await dispatch(app, agent.agent)), ['claimed', 'BODY'], '接管后仍只注入一次')
})

test('T23 与 context-gate 共挂：未晋升步注入被门控剥离，reject 不被吞掉', async () => {
  const app = new Context()
  installPreStepCoordinator(app, { collectFiles: () => [] })
  applyContextGate(app, { allowKinds: ['user'] })
  const agent = scopedAgent(app, 'agent-gated')
  installEngine(app, agent, [staticSpec('preset-card', 'PRESET BODY')], { sourceId: 'preset:gated' })

  const decision = await dispatch(app, agent.agent)
  assert.deepEqual(textsOf(decision), ['claimed'], '门控在外层:未晋升步骤只留 claimed 批（allowKinds=user）')
  const reject = await dispatch(app, agent.agent, async () => ({ kind: 'reject' }))
  assert.deepEqual(reject, { kind: 'reject' }, 'reject 不被协调器或引擎吞掉')
})

/** 宿主写入路径：本步承认的消息逐条成为持久事件（快照 + session/event 双通道）。 */
const persist = (app, session, events, messages) => {
  for (const message of messages) {
    const event = { type: 'user/message', seq: events.length + 1, data: { message } }
    events.push(event)
    app.emit('session/event', session, event)
  }
}

const onceSpec = (id, text) => staticSpec(id, text, { dedupe: 'session' })

// R1：候选生成与投递确认分离。门控在瀑布外层剥离候选时不得记账，
// 否则晋升后（门控放行）正文永久缺失。
for (const managed of [false, true]) {
  test(`R1 首阶段剥离的候选不算已投递，晋升后补发（${managed ? '管理' : '独立'}路径）`, async () => {
    const app = new Context()
    if (managed) installPreStepCoordinator(app, { collectFiles: () => [] })
    const events = []
    const mount = scopedAgent(app, `r1-gated-${managed}`, events)
    installEngine(app, mount, [onceSpec('once-card', 'ONCE')], { sourceId: `r1:${managed}` })
    // gate 后注册 = prepend 更外层：剥离本步注入的候选消息。
    applyContextGate(app, { allowKinds: ['user'] })
    assert.deepEqual(textsOf(await dispatch(app, mount.agent)), ['claimed'], '未晋升步：候选被外层门控剥离')
    app.emit('session/event', mount.agent.session, { type: 'tool/call', seq: 1, data: {} })
    assert.deepEqual(textsOf(await dispatch(app, mount.agent)), ['claimed', 'ONCE'], '晋升后必须补发，候选未被误记为已投递')
  })
}

for (const managed of [false, true]) {
  test(`V1 字段同值不串用，冷热路径的延迟命中都只投一次（${managed ? '管理' : '独立'}路径）`, async (t) => {
    const specs = [
      { ...onceSpec('first', 'FIRST'), sourceKind: 'second' },
      { ...onceSpec('second', 'SECOND'), sourceKind: 'other', match: { keys: ['LATER'] } },
    ]
    const mountApp = (events) => {
      const app = new Context()
      t.after(() => app.fiber.dispose())
      if (managed) installPreStepCoordinator(app, { collectFiles: () => [] })
      const mount = scopedAgent(app, `v1-${managed}`, events)
      installEngine(app, mount, specs)
      return { app, agent: mount.agent, events }
    }
    const hot = mountApp([])
    const first = await dispatch(hot.app, hot.agent)
    assert.deepEqual(textsOf(first), ['claimed', 'FIRST'])
    persist(hot.app, hot.agent.session, hot.events, first.messages)
    // 重挂从同一日志恢复，不发送 session/event，确保走持久扫描而非确认快路径。
    const cold = mountApp([...hot.events])
    const later = async () => ({ kind: 'enter', messages: [userMessage('LATER', 'later')] })
    for (const current of [hot, cold]) {
      const hit = await dispatch(current.app, current.agent, later)
      assert.deepEqual(textsOf(hit), ['LATER', 'SECOND'])
      assert.equal(hit.messages[1].source.plugin, 'second')
      persist(current.app, current.agent.session, current.events, hit.messages)
      assert.deepEqual(textsOf(await dispatch(current.app, current.agent, later)), ['LATER'])
    }
  })
}

for (const managed of [false, true]) {
  for (const hit of [false, true]) {
    test(`V2 官方组装先行后 ST 资格在配置绑定副本上仍生效（${managed ? '管理' : '独立'}路径，命中=${hit}）`, async (t) => {
      const app = new Context()
      t.after(() => app.fiber.dispose())
      await app.plugin(SystemPrompt, { includeHarnessIdentity: false })
      if (managed) installPreStepCoordinator(app, { collectFiles: () => [] })
      const mount = scopedAgent(app, `v2-${managed}-${hit}`, [{ type: 'turn/start', seq: 1, data: { turn: 1 } }])
      installEngine(app, mount, [
        staticSpec('setter', '{{setvar::x::SET}}', { order: 0, params: { stMacros: true }, match: { keys: ['LATER'] } }),
        { id: 'system', layer: 'system-section', order: 1, text: 'SYS[{{getvar::x::EMPTY}}]', params: { stMacros: true } },
        staticSpec('reader', 'PRE[{{getvar::x::EMPTY}}]', { order: 2, params: { stMacros: true } }),
      ])
      const assembly = () => app.systemPrompt.assemble({ scope: mount.agent, agent: mount.agent })
      assert.equal(renderPrompt(await assembly()), 'SYS[EMPTY]')
      const input = hit ? 'LATER' : 'ordinary'
      const decision = await dispatch(app, mount.agent, async () => ({ kind: 'enter', messages: [userMessage(input)] }))
      assert.deepEqual(textsOf(decision), [input, hit ? 'PRE[SET]' : 'PRE[EMPTY]'])
      assert.equal(renderPrompt(await assembly()), 'SYS[EMPTY]')
    })
  }
}

test('R1 宿主接纳后只注入一次，重挂按持久事实恢复', async () => {
  const app = new Context()
  installPreStepCoordinator(app, { collectFiles: () => [] })
  const events = []
  const mount = scopedAgent(app, 'r1-admitted', events)
  const spec = onceSpec('once-card', 'ONCE')
  installEngine(app, mount, [spec], { sourceId: 'r1:admitted' })
  const first = await dispatch(app, mount.agent)
  assert.deepEqual(textsOf(first), ['claimed', 'ONCE'])
  persist(app, mount.agent.session, events, first.messages)
  assert.deepEqual(textsOf(await dispatch(app, mount.agent)), ['claimed'], '已接纳的消息不再重复注入')

  // 清空持久快照（快照滞后）：投递确认快路径独立生效，仍不重复注入。
  events.length = 0
  assert.deepEqual(textsOf(await dispatch(app, mount.agent)), ['claimed'], '确认快路径独立生效')

  // 重挂：同一会话的持久事件里已有该身份 → 新 mount 不重复注入。
  const remounted = new Context()
  installPreStepCoordinator(remounted, { collectFiles: () => [] })
  const restored = []
  const again = scopedAgent(remounted, 'r1-admitted', restored)
  installEngine(remounted, again, [spec], { sourceId: 'r1:admitted' })
  persist(remounted, again.agent.session, restored, first.messages)
  assert.deepEqual(textsOf(await dispatch(remounted, again.agent)), ['claimed'], '重挂按持久事实恢复，不重复注入')
})

test('R1 reject 与空候选不产生投递记账', async () => {
  const app = new Context()
  installPreStepCoordinator(app, { collectFiles: () => [] })
  const mount = scopedAgent(app, 'r1-reject')
  installEngine(app, mount, [onceSpec('once-card', 'ONCE')], { sourceId: 'r1:reject' })
  assert.deepEqual(await dispatch(app, mount.agent, async () => ({ kind: 'reject' })), { kind: 'reject' })
  const decision = await dispatch(app, mount.agent)
  assert.deepEqual(textsOf(decision), ['claimed', 'ONCE'], 'reject 的步不记账，下一步仍可正常注入')
})

test('T15 文件来源与预设来源同批执行：同一算法里按 order 排序、身份互不覆盖', async () => {
  const app = new Context()
  installPreStepCoordinator(app, {
    collectFiles: () => [{
      fileId: 'file-1',
      displayPath: 'AGENTS.md',
      revision: 'r1'.padEnd(16, '0'),
      text: 'FILE BODY',
      available: true,
      order: 5,
      position: 'after-user',
      promotion: 'none',
      audience: null,
      modelScope: 'all',
    }],
  })
  const agent = scopedAgent(app, 'agent-mixed')
  installEngine(app, agent, [staticSpec('preset-card', 'PRESET BODY', { order: 30 })], { sourceId: 'preset:mixed' })
  const decision = await dispatch(app, agent.agent)
  assert.deepEqual(textsOf(decision), ['claimed', 'Instructions from: AGENTS.md\n\nFILE BODY', 'PRESET BODY'], 'order 升序:文件卡在前')
  assert.equal(decision.messages[1].source.kind, 'instruction-file')
  assert.equal(decision.messages[2].source.plugin, 'preset-card')
})

const instructionFile = {
  fileId: 'lifecycle-file', displayPath: 'AGENTS.md', revision: '1111111111111111',
  text: 'FILE BODY', available: true, order: 30, position: 'after-user',
  promotion: 'none', audience: null, modelScope: 'all',
}

for (const prepend of [false, true]) {
  test(`T23 迟到协调器不得绕过既有门控（引擎 prepend=${prepend}）`, async () => {
    const app = new Context()
    const mount = scopedAgent(app, `late-gated-${prepend}`)
    const engine = () => installEngine(app, mount, [staticSpec('guarded-card', 'PRESET BODY')], { sourceId: 'guarded', prepend })
    const gate = () => applyContextGate(mount.scope.ctx, { allowKinds: ['user'] })
    // 独立执行时先保证 gate 包住引擎，再验证迟到接管不改变这个约束。
    if (prepend) { engine(); gate() } else { gate(); engine() }
    assert.deepEqual(textsOf(await dispatch(app, mount.agent)), ['claimed'])
    installPreStepCoordinator(app, { collectFiles: () => [instructionFile] })
    const next = async () => ({ kind: 'enter', messages: [userMessage()], startsRequestSeries: true })
    const managed = await dispatch(app, mount.agent, next)
    assert.deepEqual(textsOf(managed), ['claimed'], '预设与文件正文都必须经过已安装的门控')
    assert.equal(managed.startsRequestSeries, true)
    assert.deepEqual(await dispatch(app, mount.agent, async () => ({ kind: 'reject' })), { kind: 'reject' })
    await mount.scope.dispose()
  })
}

test('T12 管理模式保留各预设 resolver 的隔离服务上下文', async () => {
  const app = new Context()
  app.provide('skills', { list: async () => [{ name: 'GLOBAL SKILL' }] })
  const mounts = ['A', 'B'].map((label) => {
    const isolated = app.isolate('skills')
    isolated.provide('skills', { list: async () => [{ name: `${label} SKILL` }] })
    const mount = scopedAgent(isolated, `skills-${label}`)
    const configs = createPromptConfigs([{
      id: 'skills', layer: 'pre-step', strategy: 'placeholder', fill: 'skill-catalog',
      position: 'after-user', dedupe: 'none',
    }])
    applyPromptConfigs(mount.scope.ctx, configs, { sourceId: 'skills', prepend: true })
    return mount
  })
  const standalone = await Promise.all(mounts.map(({ agent }) => dispatch(app, agent)))
  installPreStepCoordinator(app, { collectFiles: () => [] })
  for (const [index, mount] of mounts.entries()) {
    const managed = await dispatch(app, mount.agent)
    assert.deepEqual(textsOf(managed), textsOf(standalone[index]), '不能改用全局或兄弟预设的 skills')
  }
  const child = scopedAgent(app, 'skills-child')
  child.agent.session.header.delegationDepth = 1
  bindScopeParent(child.agent, mounts[0].agent)
  assert.deepEqual(textsOf(await dispatch(app, child.agent)), textsOf(standalone[0]), '子代理继承来源仍使用该来源的 ctx')
  await child.scope.dispose()
  for (const mount of mounts) await mount.scope.dispose()
})

for (const empty of [false, true]) {
  test(`T22 协调器在两步之间 HMR 后重新登记来源（空来源=${empty}）`, async () => {
    const app = new Context()
    const start = () => app.plugin((ctx) => {
      installPreStepCoordinator(ctx, { collectFiles: () => [instructionFile] })
    })
    const old = start()
    await old
    const mount = scopedAgent(app, `hmr-${empty}`)
    installEngine(app, mount, empty ? [] : [staticSpec('hmr-card', 'PRESET BODY')], { sourceId: 'hmr' })
    const before = await dispatch(app, mount.agent)
    assert.equal(before.messages.filter((message) => message.source.kind === 'instruction-file').length, 1)
    await old.dispose()
    const fresh = start()
    await fresh
    try {
      for (let step = 0; step < 2; step++) {
        assert.deepEqual(textsOf(await dispatch(app, mount.agent)), textsOf(before), '替换服务实例后不能漏注入或双注入')
      }
      await mount.scope.dispose()
      assert.deepEqual(textsOf(await dispatch(app, mount.agent)), ['claimed'], '来源 disposer 后不再执行')
    } finally {
      await fresh.dispose()
    }
  })
}

test('T22 空预设同样响应协调器迟到，不丢失文件来源资格', async () => {
  const app = new Context()
  const mount = scopedAgent(app, 'empty-late')
  installEngine(app, mount, [], { sourceId: 'empty' })
  assert.deepEqual(textsOf(await dispatch(app, mount.agent)), ['claimed'])
  installPreStepCoordinator(app, { collectFiles: () => [instructionFile] })
  assert.deepEqual(textsOf(await dispatch(app, mount.agent)), ['claimed', 'Instructions from: AGENTS.md\n\nFILE BODY'])
  await mount.scope.dispose()
})

test('T22 已释放来源的在途回调遇到协调器 HMR 时不重新登记', async () => {
  const app = new Context()
  const startCoordinator = () => app.plugin((ctx) => {
    installPreStepCoordinator(ctx, { collectFiles: () => [instructionFile] })
  })
  const old = startCoordinator()
  await old
  const source = app.plugin((ctx) => {
    applyPromptConfigs(ctx, createPromptConfigs([staticSpec('disposed-source', 'OLD BODY')]), { sourceId: 'disposed', prepend: true })
  })
  await source
  const mount = scopedAgent(app, 'in-flight-dispose')
  let release
  let entered
  const held = new Promise((resolve) => { release = resolve })
  const started = new Promise((resolve) => { entered = resolve })
  const stop = app.on('agent/pre-step', async (_payload, next) => {
    entered()
    await held
    return next()
  }, { prepend: true })
  const pending = dispatch(app, mount.agent)
  await started
  await source.dispose()
  await old.dispose()
  const fresh = startCoordinator()
  await fresh
  release()
  try {
    assert.deepEqual(textsOf(await pending), ['claimed'], '旧回调不能在失效 ctx 上创建 effect，也不能恢复已释放来源')
    assert.deepEqual(textsOf(await dispatch(app, mount.agent)), ['claimed'])
  } finally {
    stop()
    await mount.scope.dispose()
    await fresh.dispose()
  }
})

// —— 真实 Cordis/scope 接线验证（原 pre-step-scope-verify.test.mjs，6 条） ——
// 合并说明（2026-09-17 测试归一精简 Wave 2）：本组自带的 makeAgent / userMessage /
// dispatch / scopedAgent 与上面的接线用例同名但形态不同，故整组用块作用域隔离，
// 用例体与断言逐字保留，不做改名。
/**
 * W0 前置验证（PLAN.md §6.3）：固定版本真实 Cordis/scope 接线证明。
 *
 * 这些用例不使用假 ctx，而是用已安装的 @deepseek-ai/cordis、@deepseek-ai/dsh-scope
 * 与 @deepseek-ai/dsh-agent 的真实 dispatch（agentEvents → ctx.waterfall + scopeTarget），
 * 证明 W3 拟用的宿主机制成立：
 *   1. 全局（untagged）监听器收到任一本地 Agent 的 scoped pre-step，payload 携带真实
 *      agent/session，且 scopeOf(agent.ctx) 就是 agent 本身——协调器无需依赖 UI 选择。
 *   2. 父/子 scope：事件向上流动（祖先监听器收到后代事件）、注册层向下继承、
 *      最近 scope 遮蔽更远 scope；兄弟 scope 互不串。
 *   3. createScope/dispose 释放全部注册；dispose 后注册被拒。旧接线先撤、新接线再启的
 *      单执行器切换不会双跑。
 *   4. 真实 PreStepDecision：enter/reject 与 startsRequestSeries 透传。
 *   5. prepend 是 LIFO：与 context-gate 真实 apply() 共挂时 gate 仍在外层，
 *      注入消息进入 gate 的过滤视图，reject 不被下游吞掉。
 */
{
const ENGINE_DIR = new URL('../../engine/', import.meta.url).href

const signalOf = () => new AbortController().signal

/** 最小本地 Agent：session 形状对齐 executor/context-gate 的读取面。 */
const makeAgent = (id, model = 'verify-model') => ({
  session: { id, header: { delegationDepth: 0 }, snapshotEvents: () => [], deriveMessages: () => [] },
  options: { model },
})

const userMessage = (text, id = `u-${text}`) => ({
  id,
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})

/** 真实 scoped dispatch：agentEvents → ctx.waterfall(thisArg=carrier)。 */
const dispatch = (app, agent, next, messages = [userMessage('claimed')]) =>
  agentEvents(app, agent).waterfall('agent/pre-step', { messages, turn: 1, step: 1, signal: signalOf() }, next)

/** 挂 scope 的最小 Agent：agent.ctx 经 createScope 获得真实 scope tag（key=agent）。 */
const scopedAgent = (app, id) => {
  const agent = makeAgent(id)
  const scope = createScope(app, agent)
  agent.ctx = scope.ctx
  return { agent, scope }
}

const createLayers = () =>
  new ScopedLayers(
    () => ({
      entries: new NamedEntries((key) => new Error(`duplicate: ${key}`)),
      isEmpty() {
        return this.entries.isEmpty()
      },
    }),
    () => {},
  )

test('全局监听器收到任一本地 Agent 的 pre-step，scopeOf(agent.ctx) 指向 agent 本身', async () => {
  const app = new Context()
  const a = scopedAgent(app, 'agent-a')
  const b = scopedAgent(app, 'agent-b')
  const seen = []
  app.on('agent/pre-step', async ({ agent }, next) => {
    seen.push([agent.session.id, scopeOf(agent.ctx) === agent])
    return next()
  })
  await dispatch(app, a.agent, async () => ({ kind: 'enter', messages: [userMessage('a')] }))
  await dispatch(app, b.agent, async () => ({ kind: 'enter', messages: [userMessage('b')] }))
  assert.deepEqual(seen, [
    ['agent-a', true],
    ['agent-b', true],
  ])
})

test('父子 scope 事件向上流动、层向下继承并遮蔽；兄弟互不串', async () => {
  const app = new Context()
  const parent = scopedAgent(app, 'parent')
  const child = scopedAgent(app, 'child')
  const sibling = scopedAgent(app, 'sibling')
  bindScopeParent(child.agent, parent.agent)

  const seen = []
  parent.scope.ctx.on('agent/pre-step', async ({ agent }, next) => {
    seen.push(`parent:${agent.session.id}`)
    return next()
  })
  child.scope.ctx.on('agent/pre-step', async ({ agent }, next) => {
    seen.push(`child:${agent.session.id}`)
    return next()
  })
  const reject = async () => ({ kind: 'reject' })
  await dispatch(app, child.agent, reject)
  await dispatch(app, parent.agent, reject)
  await dispatch(app, sibling.agent, reject)
  // 祖先收到后代事件；后代不收到祖先；兄弟事件不进入别的 scope。
  assert.deepEqual(seen, ['parent:child', 'child:child', 'parent:parent'])

  const layers = createLayers()
  layers.effect(app, (layer) => layer.entries.insert('preset-a', 'GLOBAL'), { label: 'verify:global' })
  layers.effect(parent.scope.ctx, (layer) => layer.entries.insert('preset-a', 'PARENT'), { label: 'verify:parent' })
  layers.effect(child.scope.ctx, (layer) => layer.entries.insert('preset-b', 'CHILD'), { label: 'verify:child' })
  assert.deepEqual(
    [...layers.merge(child.agent, (layer) => layer.entries)],
    [
      ['preset-a', 'PARENT'],
      ['preset-b', 'CHILD'],
    ],
  )
  assert.deepEqual([...layers.merge(sibling.agent, (layer) => layer.entries)], [['preset-a', 'GLOBAL']], '兄弟看不到父/子 scope 的层')
  assert.equal(layers.peek(child.agent)?.entries.has('preset-a'), false, 'peek 只读自身贡献（chain-blind）')
})

test('dispose 释放注册并拒绝重注册；旧接线撤销后只剩新路径', async () => {
  const app = new Context()
  const { agent, scope } = scopedAgent(app, 'agent-switch')
  const calls = []
  scope.ctx.on('agent/pre-step', async (payload, next) => {
    calls.push('old')
    return next()
  })
  await dispatch(app, agent, async () => ({ kind: 'reject' }))
  await scope.dispose()
  await dispatch(app, agent, async () => ({ kind: 'reject' }))
  assert.deepEqual(calls, ['old'], 'dispose 后旧监听器不再收到事件')
  assert.throws(() => scope.ctx.on('agent/pre-step', () => {}), /inactive/i, 'dispose 后注册被拒')

  const nextScope = createScope(app, agent)
  agent.ctx = nextScope.ctx
  nextScope.ctx.on('agent/pre-step', async (payload, next) => {
    calls.push('new')
    return next()
  })
  await dispatch(app, agent, async () => ({ kind: 'reject' }))
  assert.deepEqual(calls, ['old', 'new'], '先撤旧再启新：任一时刻只有一条执行路径')
})

test('真实 PreStepDecision：enter/reject 与 startsRequestSeries 透传、监听器可改写 messages', async () => {
  const app = new Context()
  const { agent, scope } = scopedAgent(app, 'agent-decision')
  const extra = userMessage('injected', 'u-injected')
  scope.ctx.on('agent/pre-step', async (_payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    return { ...decision, messages: [...decision.messages, extra] }
  })
  const enter = await dispatch(app, agent, async () => ({
    kind: 'enter',
    messages: [userMessage('claimed')],
    startsRequestSeries: true,
  }))
  assert.equal(enter.kind, 'enter')
  assert.equal(enter.startsRequestSeries, true)
  assert.deepEqual(enter.messages.map((message) => message.id), ['u-claimed', 'u-injected'])

  const reject = await dispatch(app, agent, async () => ({ kind: 'reject' }))
  assert.deepEqual(reject, { kind: 'reject' })
})

test('prepend 监听按 LIFO 排在外层（W3 接线顺序约束）', async () => {
  const app = new Context()
  const order = []
  app.on('agent/pre-step', async (payload, next) => {
    order.push('prepend-first')
    return next()
  }, { prepend: true })
  app.on('agent/pre-step', async (payload, next) => {
    order.push('prepend-second')
    return next()
  }, { prepend: true })
  app.on('agent/pre-step', async (payload, next) => {
    order.push('normal')
    return next()
  })
  await app.waterfall(
    'agent/pre-step',
    { agent: makeAgent('agent-order'), messages: [], turn: 1, step: 1, signal: signalOf() },
    async () => ({ kind: 'reject' }),
  )
  assert.deepEqual(order, ['prepend-second', 'prepend-first', 'normal'])
})

test('context-gate 与 executor 真实共挂：gate 在外层过滤注入消息，reject 不被吞掉', async () => {
  const specs = [{ id: 'verify-injected', layer: 'pre-step', strategy: 'static', text: 'INJECTED', position: 'after-all' }]

  const gatedApp = new Context()
  const gated = scopedAgent(gatedApp, 'agent-gated')
  applyContextGate(gatedApp, { allowKinds: ['user'] })
  applyPromptConfigs(gatedApp, createPromptConfigs(specs, { strategyDir: ENGINE_DIR }))
  const gatedClaimed = userMessage('claimed', 'u-gated-claimed')
  const gatedDecision = await dispatch(
    gatedApp,
    gated.agent,
    async () => ({ kind: 'enter', messages: [gatedClaimed] }),
    [gatedClaimed],
  )
  assert.deepEqual(
    gatedDecision.messages.map((message) => message.id),
    ['u-gated-claimed'],
    'gate 在 executor 外层：该步注入的 verify-injected 消息被 allowKinds 过滤',
  )

  // 对照：无 gate 时同一配置确实注入，证明上面的过滤不是"注入压根没发生"。
  const plainApp = new Context()
  const bare = scopedAgent(plainApp, 'agent-bare')
  applyPromptConfigs(plainApp, createPromptConfigs(specs, { strategyDir: ENGINE_DIR }))
  const bareClaimed = userMessage('claimed', 'u-bare-claimed')
  const bareDecision = await dispatch(plainApp, bare.agent, async () => ({ kind: 'enter', messages: [bareClaimed] }), [bareClaimed])
  assert.equal(bareDecision.messages.length, 2)
  assert.equal(bareDecision.messages[1].source.kind, 'verify-injected')

  const reject = await dispatch(gatedApp, gated.agent, async () => ({ kind: 'reject' }), [gatedClaimed])
  assert.deepEqual(reject, { kind: 'reject' }, 'reject 不被门控或执行器吞掉')
})
}
