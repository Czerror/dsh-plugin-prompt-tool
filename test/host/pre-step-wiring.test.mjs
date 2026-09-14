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
import { bindScopeParent, createScope } from '@deepseek-ai/dsh-scope'
import { agentEvents } from '@deepseek-ai/dsh-agent'
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
