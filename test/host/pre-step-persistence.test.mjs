// T00：pre-step 注入消息必须能通过官方会话回放。
//
// 证据链使用已发布的 `@deepseek-ai/dsh-session`：宿主把 decision.messages 逐条写成
// `user/message` 事件（agent-loop:375–376），事件重载时校验 `role === 'user'`
// （session index.ts:320–345 `MESSAGE_ROLE_BY_TYPE`）。因此：
//   - 非法 assistant 消息写出的日志在重新加载时抛真实角色错误；
//   - 配置拒绝 assistant，策略 patch 在出口统一降级后可以持久化往返。
// 这里不用 stub 加载器：失败断言直接来自官方 Session.create(seed) 的校验路径。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { Session, snapshotSessionEvent } from '@deepseek-ai/dsh-session'
import { bindScopeParent, createScope } from '@deepseek-ai/dsh-scope'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { applyPromptConfigs, createPromptConfigs } from '../../engine/prompt-config-engine.mjs'
import { installPreStepCoordinator } from '../../src/runtime/pre-step-coordinator.ts'
import { convertStToPreset } from '../../src/host/sillytavern.ts'

const ENGINE_DIR = new URL('../../engine/', import.meta.url).href
const signalOf = () => new AbortController().signal
let sessionCounter = 0

const userMessage = (text = 'claimed', id = 'u-claimed') => ({
  id,
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})

const makeAgent = (id, events = [], header = {}) => ({
  session: {
    id,
    header: { delegationDepth: 0, ...header },
    snapshotEvents: () => events,
    deriveMessages: () => [],
  },
  options: { model: 'pro' },
})

const scopedAgent = (app, id, events = [], header = {}) => {
  const agent = makeAgent(id, events, header)
  const scope = createScope(app, agent)
  agent.ctx = scope.ctx
  return { agent, scope }
}

const dispatch = (app, agent, next) => agentEvents(app, agent).waterfall(
  'agent/pre-step',
  { messages: [userMessage()], turn: 1, step: 1, signal: signalOf() },
  next ?? (async () => ({ kind: 'enter', messages: [userMessage()] })),
)

/** 宿主写入路径：本步承认的消息逐条成为持久事件。 */
const persist = (session, messages, { turn = 1, step = 1 } = {}) => {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step })
  for (const message of messages) session.append('user/message', message, { surfaceOp: 'append' })
}

/** 官方持久化（事件快照 + JSON 序列化）→ 重新加载 → 再派生请求。 */
const replay = (messages) => {
  const id = `replay-${++sessionCounter}`
  const live = Session.create(`${id}-live`)
  persist(live, messages)
  const seed = JSON.parse(JSON.stringify(live.snapshotEvents().map((event) => snapshotSessionEvent(event))))
  const restored = Session.create(`${id}-restored`, seed)
  return restored.deriveMessages().map((message) => [
    message.role,
    (Array.isArray(message.content) ? message.content : [])
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('\n'),
  ])
}

const messagesOf = (decision) => (Array.isArray(decision?.messages) ? decision.messages : [])

const install = (app, mount, specs, options = {}) => {
  const configs = createPromptConfigs(specs, { strategyDir: ENGINE_DIR })
  applyPromptConfigs(mount.scope.ctx, configs, { prepend: true, ...options })
  return configs
}

test('T00 策略 patch 的 assistant 在出口降级为 user，并能通过官方回放', async () => {
  const app = new Context()
  installPreStepCoordinator(app, { collectFiles: () => [] })
  const mount = scopedAgent(app, 'persist-patch')
  const configs = install(app, mount, [
    { id: 'patched-assistant', layer: 'pre-step', strategy: 'static', text: 'PATCHED', role: 'user', position: 'after-user' },
    { id: 'merged-user', layer: 'pre-step', strategy: 'static', text: 'MERGED-A', role: 'user', position: 'after-all', mergeMode: 'merged' },
    { id: 'merged-assistant', layer: 'pre-step', strategy: 'static', text: 'MERGED-B', role: 'user', position: 'after-all', mergeMode: 'merged' },
  ], { sourceId: 'persist:patch' })
  for (const config of configs.filter((config) => config.id.endsWith('assistant'))) {
    const resolve = config.resolve
    config.resolve = async (args) => ({ ...await resolve(args), role: 'assistant' })
  }

  const decision = await dispatch(app, mount.agent)
  const injected = messagesOf(decision)
  assert.deepEqual(injected.map((message) => message.role), ['user', 'user', 'user'], '出口不再发出非法角色')
  assert.equal(injected[1].source.requestedRole, 'assistant', '保留原角色作为只读降级事实')
  assert.equal(injected[1].source.plugin, 'patched-assistant')
  assert.equal(injected[2].source.requestedRole, 'assistant', '合并组非首条的非法角色同样留痕')

  assert.deepEqual(replay(injected), [
    ['user', 'claimed'],
    ['user', 'PATCHED'],
    ['user', 'MERGED-A\nMERGED-B'],
  ], '正文、位置与次数经持久化往返不变')

  await mount.scope.dispose()
})

test('T00 回放路径是真实角色校验：assistant 夹具必须在校验处失败', () => {
  const illegal = [{
    id: 'legacy-illegal',
    role: 'assistant',
    content: [{ type: 'text', text: 'OLD' }],
    source: { kind: 'plugin', plugin: 'legacy-assistant' },
  }]
  assert.throws(() => replay(illegal), /must have role "user"/, '不使用总成功的加载器替身')
})

test('T00 ST 五类角色来源转换后全部可回放', async () => {
  const spec = convertStToPreset({
    prompts: [
      { identifier: 'st-assistant', role: 'assistant', content: 'ASSIST', enabled: true },
      { identifier: 'st-model', role: 'model', content: 'MODEL', enabled: true },
      { identifier: 'st-system', role: 'system', content: 'SYS', enabled: true },
    ],
    data: {
      name: 'Ada',
      first_mes: 'GREETING',
      alternate_greetings: ['ALT'],
      mes_example: '<START>\n{{user}}: Q\n{{char}}: A',
      character_book: { entries: [{ id: 1, keys: ['k'], content: 'LORE', constant: true, extensions: { role: 2 } }] },
    },
  }, 'roles')

  const preStep = spec.promptConfigs.filter((config) => config.layer === 'pre-step')
  assert.ok(preStep.length >= 6, `五类来源都应产出 pre-step 配置，实际 ${preStep.length}`)
  assert.deepEqual([...new Set(preStep.map((config) => config.role))], ['user'], '转换产物只声明 user')

  const byId = new Map(spec.promptConfigs.map((config) => [config.id, config]))
  assert.equal(byId.get('st-assistant').params.stSource.role, 'assistant', '原角色可定位')
  assert.equal(byId.get('st-model').params.stSource.role, 'model')
  assert.equal(byId.get('first-mes').params.stSource.role, 'assistant')
  assert.equal(byId.get('first-mes-2').params.stSource.role, 'assistant')
  assert.deepEqual(byId.get('dialogue-example-2').params.stSource.role, 'assistant')
  assert.equal(byId.get('lore-1').params.stWorldBook.role, 2, '世界书原角色保留在 stWorldBook')

  const app = new Context()
  installPreStepCoordinator(app, { collectFiles: () => [] })
  const mount = scopedAgent(app, 'persist-st')
  install(app, mount, spec.promptConfigs, { sourceId: 'persist:st' })
  const injected = messagesOf(await dispatch(app, mount.agent))
  assert.ok(injected.length > 2, '常驻世界书与相对注入卡进入本批')
  assert.deepEqual([...new Set(injected.map((message) => message.role))], ['user'])
  const replayed = replay(injected)
  assert.deepEqual(replayed.map(([role]) => role), injected.map(() => 'user'))
  assert.deepEqual(replayed.map(([, text]) => text), injected.map((message) => message.content
    .filter((block) => block?.type === 'text').map((block) => block.text).join('\n')))

  await mount.scope.dispose()
})

test('T00 晋升前后、主子代理与 disposer 都不产生非法角色', async () => {
  const app = new Context()
  installPreStepCoordinator(app, { collectFiles: () => [] })
  const parent = scopedAgent(app, 'persist-parent')
  const child = scopedAgent(app, 'persist-child', [], { delegationDepth: 1 })
  bindScopeParent(child.agent, parent.agent)
  const configs = install(app, parent, [
    { id: 'promoted-card', layer: 'pre-step', strategy: 'static', text: 'PROMOTED', role: 'user', position: 'after-user', promotion: 'main' },
    { id: 'subagent-card', layer: 'pre-step', strategy: 'static', text: 'SUBAGENT', role: 'user', position: 'after-user', audience: 'subagent' },
  ], { sourceId: 'persist:promotion' })
  for (const config of configs) {
    const resolve = config.resolve
    config.resolve = async (args) => ({ ...await resolve(args), role: 'assistant' })
  }

  const before = messagesOf(await dispatch(app, parent.agent))
  assert.deepEqual(before.map((message) => message.content[0].text), ['claimed'], '未晋升步不注入')

  // 真实晋升信号（PROMOTE_EVENTS.either: tool/call）：压缩后重晋升走同一观察路径。
  app.emit('session/event', parent.agent.session, { type: 'tool/call', seq: 1, data: {} })
  const promoted = messagesOf(await dispatch(app, parent.agent))
  assert.deepEqual(promoted.map((message) => message.role), ['user', 'user'])
  assert.deepEqual(replay(promoted).map(([role]) => role), ['user', 'user'])

  app.emit('session/event', parent.agent.session, { type: 'compaction/end', seq: 2, data: {} })
  const afterCompaction = messagesOf(await dispatch(app, parent.agent))
  assert.deepEqual(afterCompaction.map((message) => message.role), ['user'], '压缩后回到未晋升 epoch')
  app.emit('session/event', parent.agent.session, { type: 'tool/call', seq: 3, data: {} })
  const repromoted = messagesOf(await dispatch(app, parent.agent))
  assert.deepEqual(replay(repromoted).map(([role]) => role), ['user', 'user'], '压缩后重晋升仍合法')

  const delegated = messagesOf(await dispatch(app, child.agent))
  assert.deepEqual(delegated.map((message) => message.role), ['user', 'user', 'user'], '子代理走父 scope 来源且角色合法')
  assert.ok(delegated.some((message) => message.content[0].text === 'SUBAGENT'), '仅子代理卡生效')
  assert.deepEqual(replay(delegated).map(([role]) => role), ['user', 'user', 'user'])

  await parent.scope.dispose()
  const released = messagesOf(await dispatch(app, parent.agent))
  assert.deepEqual(released.map((message) => message.role), ['user'], 'disposer 后不再注入')
  await child.scope.dispose()
})
