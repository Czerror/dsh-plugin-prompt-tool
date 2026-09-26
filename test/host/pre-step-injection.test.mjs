// 真实 Cordis waterfall：官方负责生成消息，协调器只过滤本批待注入内容。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { PRE_STEP_COORDINATOR_SERVICE, installPreStepCoordinator } from '../../src/runtime/pre-step-coordinator.ts'
import { agentsFileId } from '../../src/host/agents-cards.ts'
import { apply as applyInstructionHint } from '../../engine/instruction-hint.mjs'

const root = mkdtempSync(join(tmpdir(), 'pt-official-instructions-'))
const home = join(root, 'home')
const ws = join(root, 'project')
const otherWs = join(root, 'other-project')
const nested = join(ws, 'packages', 'app')
for (const dir of [home, nested, join(ws, '.git'), join(otherWs, '.git')]) mkdirSync(dir, { recursive: true })
writeFileSync(join(home, 'AGENTS.md'), 'GLOBAL RULES\n', 'utf8')
writeFileSync(join(ws, 'AGENTS.md'), 'PROJECT RULES\n', 'utf8')
writeFileSync(join(ws, 'CLAUDE.md'), 'OTHER RULES\n', 'utf8')
writeFileSync(join(otherWs, 'AGENTS.md'), 'OTHER PROJECT RULES\n', 'utf8')
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = home
const { BRIDGE_ENDPOINTS, SETTINGS_BRIDGE_PREFIX, registerSettingsBridge } = await import('../../lib/index.mjs')
after(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(root, { recursive: true, force: true })
})

const GLOBAL_ID = agentsFileId(join(home, 'AGENTS.md'))
const PROJECT_ID = agentsFileId(join(ws, 'AGENTS.md'))
const OTHER_ID = agentsFileId(join(ws, 'CLAUDE.md'))
let caseSeq = 0
const policyFile = (content) => {
  const file = join(root, `policy-${++caseSeq}.yml`)
  if (content !== undefined) writeFileSync(file, content, 'utf8')
  return file
}
const policy = (ids) => JSON.stringify({ schemaVersion: 1, files: Object.fromEntries(ids.map(id => [id, { enabled: false }])) })
const userTask = { id: 'task-1', role: 'user', content: [{ type: 'text', text: '写一个工具' }], source: { kind: 'user' } }
const bodyOf = (message) => message.content.map(block => block.text ?? '').join('\n')
const officialMessages = (decision) => decision.messages.filter(message => message.source?.kind === 'agent-instructions')

/** 固定官方包的基线/增量消息契约；生成在真实普通 pre-step 监听器中。 */
const official = (paths = ['AGENTS.md', 'CLAUDE.md'], { action = 'set', baseline = true, id = 'official-1' } = {}) => {
  const heading = action === 'replace' ? 'Updated instructions from:'
    : action === 'remove' ? 'Instructions removed:'
      : baseline ? 'Instructions from:' : 'Additional instructions from:'
  return {
    id, role: 'user',
    content: [{ type: 'text', text: '<system-reminder>\n'
      + paths.map(path => `${heading} ${path}\n\nRULES ${path} {{KeepRaw}}`).join('\n\n')
      + '\n</system-reminder>' }],
    source: {
      kind: 'agent-instructions', form: 'instructions',
      ...(baseline ? { baseline: true, baselineIdentity: JSON.stringify({ projectRoot: '../..' }) } : {}),
      changes: paths.map(path => ({ path, action, scope: `${path}\0AGENTS.md`, digest: id })),
    },
  }
}

let sessionSeq = 0
const agentAt = (app, t, cwd = nested, depth = 0) => {
  const events = []
  const visible = []
  const agent = {
    events, visible,
    session: {
      id: `session-${++sessionSeq}`, header: { delegationDepth: depth, ...(cwd === null ? {} : { cwd }) },
      snapshotEvents: () => events,
      deriveMessages: () => visible,
    },
    options: { model: 'pro' },
  }
  const scope = createScope(app, agent)
  agent.ctx = scope.ctx
  t.after(() => scope.dispose())
  return agent
}

const dispatch = (harness, agent, incoming = [], decision = { kind: 'enter', messages: [userTask] }) => {
  harness.pending = incoming
  return agentEvents(harness.app, agent).waterfall(
    'agent/pre-step',
    { messages: [userTask], turn: 1, step: 1, signal: new AbortController().signal },
    async () => decision,
  )
}

const harnessFor = (t, file = policyFile(), { officialFirst = false, hintFirst, withOfficial = true } = {}) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  const harness = { app, pending: [] }
  const installOfficial = () => app.on('agent/pre-step', async (_payload, next) => {
    const decision = await next()
    return decision.kind === 'reject' || harness.pending.length === 0 ? decision
      : { ...decision, messages: [...decision.messages, ...harness.pending] }
  })
  if (withOfficial && officialFirst) installOfficial()
  if (hintFirst === true) applyInstructionHint(app, { enabled: true })
  harness.service = installPreStepCoordinator(app, { home, policyFile: file })
  if (hintFirst === false) applyInstructionHint(app, { enabled: true })
  if (withOfficial && !officialFirst) installOfficial()
  return harness
}

for (const officialFirst of [false, true]) {
  test(`关闭文件过滤首次基线、附加、更新、移除及压缩后重注入（官方先挂=${officialFirst}）`, async (t) => {
    const harness = harnessFor(t, policyFile(policy([PROJECT_ID])), { officialFirst })
    const agent = agentAt(harness.app, t)
    for (const options of [{}, { baseline: false }, { action: 'replace', baseline: false }, { action: 'remove', baseline: false }]) {
      const original = official(undefined, options)
      const before = structuredClone(original)
      const decision = await dispatch(harness, agent, [original])
      assert.equal(decision.messages[0], userTask)
      const [kept] = officialMessages(decision)
      assert.equal(kept.id, original.id)
      assert.deepEqual(kept.source.changes, [original.source.changes[1]])
      assert.match(bodyOf(kept), /RULES CLAUDE\.md \{\{KeepRaw\}\}/)
      assert.doesNotMatch(bodyOf(kept), /AGENTS\.md/)
      assert.deepEqual(original, before, '过滤不修改官方原对象')
      if (original.source.baseline) agent.visible.push(kept)
    }
    for (const data of [{}, { error: 'failed' }]) {
      const event = { seq: agent.events.length + 1, type: 'compaction/end', data }
      agent.events.push(event)
      harness.app.emit('session/event', agent.session, event)
      const decision = await dispatch(harness, agent, [official()])
      assert.deepEqual(officialMessages(decision)[0].source.changes.map(change => change.path), ['CLAUDE.md'])
    }
  })
}

test('全部关闭不留下空官方消息，reject 与空批次保持原决定', async (t) => {
  const harness = harnessFor(t, policyFile(policy([PROJECT_ID, OTHER_ID])))
  const agent = agentAt(harness.app, t)
  assert.deepEqual((await dispatch(harness, agent, [official()])).messages, [userTask])
  const rejected = { kind: 'reject', reason: 'retry' }
  assert.equal(await dispatch(harness, agent, [official()], rejected), rejected)
  const empty = { kind: 'enter', messages: [] }
  assert.equal(await dispatch(harness, agent, [], empty), empty)
})

test('主会话、子代理和新会话按各自 cwd 匹配路径，不串文件身份', async (t) => {
  const harness = harnessFor(t, policyFile(policy([PROJECT_ID])))
  for (const [cwd, depth, disabled] of [[nested, 0, true], [otherWs, 1, false], [nested, 1, true], [otherWs, 0, false]]) {
    const agent = agentAt(harness.app, t, cwd, depth)
    const incoming = official(['AGENTS.md'])
    if (cwd === otherWs) incoming.source.baselineIdentity = JSON.stringify({ projectRoot: '' })
    const decision = await dispatch(harness, agent, [incoming])
    assert.equal(officialMessages(decision).length, disabled ? 0 : 1)
    if (!disabled) assert.equal(officialMessages(decision)[0], incoming)
  }
})

test('关闭只影响后续批次，历史不变；重新开启仅恢复放行，不主动补发', async (t) => {
  const file = policyFile(policy([]))
  const harness = harnessFor(t, file)
  const agent = agentAt(harness.app, t)
  const original = official(['AGENTS.md'])
  assert.equal(officialMessages(await dispatch(harness, agent, [original]))[0], original)
  agent.visible.push(original)
  const event = { seq: 1, type: 'user/message', data: original }
  agent.events.push(event)
  const before = structuredClone(agent.events)
  writeFileSync(file, policy([PROJECT_ID]), 'utf8')
  assert.deepEqual(officialMessages(await dispatch(harness, agent, [official(['AGENTS.md'], { action: 'replace', baseline: false })])), [])
  assert.equal(agent.visible[0], original)
  assert.equal(agent.events[0], event)
  assert.deepEqual(agent.events, before, '持久历史与模型可见历史均不撤回或改写')
  writeFileSync(file, policy([]), 'utf8')
  assert.deepEqual((await dispatch(harness, agent)).messages, [userTask], '没有官方新消息就不补发')
  const next = official(['AGENTS.md'], { id: 'official-restored' })
  assert.equal(officialMessages(await dispatch(harness, agent, [next]))[0], next)
})

test('缺少会话 cwd 时只匹配明确的全局路径，不拿进程 cwd 猜项目身份', async (t) => {
  const harness = harnessFor(t, policyFile(policy([PROJECT_ID, GLOBAL_ID])))
  const agent = agentAt(harness.app, t, null)
  const decision = await dispatch(harness, agent, [official(['~/.dsh/AGENTS.md', 'AGENTS.md'])])
  assert.deepEqual(officialMessages(decision)[0].source.changes.map(change => change.path), ['AGENTS.md'])
})

test('官方自定义项目根按基线身份解析，不能把子目录文件误当已关闭的祖先文件', async (t) => {
  const harness = harnessFor(t, policyFile(policy([PROJECT_ID])))
  const agent = agentAt(harness.app, t)
  const baseline = official(['AGENTS.md'])
  baseline.source.baselineIdentity = JSON.stringify({ projectRoot: '', projectRootMarkers: [] })
  assert.equal(officialMessages(await dispatch(harness, agent, [baseline]))[0], baseline)
  agent.visible.push(baseline)
  const update = official(['AGENTS.md'], { baseline: false, action: 'replace' })
  assert.equal(officialMessages(await dispatch(harness, agent, [update]))[0], update, '增量沿用可见官方基线根')
})

test('官方项目根身份不明时放行，不使用插件 .git 规则猜文件', async (t) => {
  const harness = harnessFor(t, policyFile(policy([PROJECT_ID])))
  const agent = agentAt(harness.app, t)
  for (const identity of ['unknown-version', JSON.stringify({ changedFormat: true })]) {
    const incoming = official(['AGENTS.md'])
    incoming.source.baselineIdentity = identity
    assert.equal(officialMessages(await dispatch(harness, agent, [incoming]))[0], incoming)
  }
})

test('策略缺失默认放行，已退役总开关不改变官方行为', async (t) => {
  for (const content of [undefined, 'schemaVersion: 1\nenabled: false\nfiles: {}\n']) {
    const harness = harnessFor(t, policyFile(content))
    const agent = agentAt(harness.app, t)
    const incoming = official()
    assert.equal(officialMessages(await dispatch(harness, agent, [incoming]))[0], incoming)
  }
})

test('策略损坏、未知版本或读取失败时放行官方原消息', async (t) => {
  const directory = join(root, 'unreadable-policy-directory')
  mkdirSync(directory)
  for (const file of [policyFile('files: [\n'), policyFile('schemaVersion: 99\n'), directory]) {
    const harness = harnessFor(t, file)
    const incoming = official()
    assert.equal(officialMessages(await dispatch(harness, agentAt(harness.app, t), [incoming]))[0], incoming)
  }
})

test('分段有歧义或官方改变包装时放行原对象，其他文件不误删', async (t) => {
  const harness = harnessFor(t, policyFile(policy([PROJECT_ID])))
  const agent = agentAt(harness.app, t)
  const ambiguous = official()
  ambiguous.content[0].text = ambiguous.content[0].text.replace('RULES AGENTS.md', 'Instructions from: CLAUDE.md\n\nRULES AGENTS.md')
  const unknown = { ...official(), content: [{ type: 'text', text: 'UNKNOWN OFFICIAL FORMAT' }] }
  for (const incoming of [ambiguous, unknown]) {
    assert.equal(officialMessages(await dispatch(harness, agent, [incoming]))[0], incoming)
  }
})

const presetCard = (overrides = {}) => ({
  id: 'preset-card-1', layer: 'pre-step', enabled: true, order: 10, position: 'after-user', promotion: 'none',
  audience: null, modelScope: 'all', role: 'user', dedupe: 'none', mergeMode: 'separate', sourceKind: 'preset-card',
  form: 'text', texts: [], params: {}, variables: {}, identity: { field: 'plugin', value: 'preset-card-1' },
  resolve: async () => ({ text: 'PRESET BODY' }), ...overrides,
})

test('官方未装配时不自行读取注入，普通预设卡保留，遗留生成指令卡退出', async (t) => {
  const harness = harnessFor(t, policyFile(policy([])), { withOfficial: false })
  const agent = agentAt(harness.app, t)
  assert.equal(harness.service.officialOwnerOf(agent.session.id), undefined)
  assert.deepEqual((await dispatch(harness, agent)).messages, [userTask])
  harness.service.registerPreset(agent.ctx, 'preset:without-official', {
    officialInstructions: false,
    configs: [presetCard(), presetCard({ id: `agents-file-${PROJECT_ID}`, sourceKind: 'instruction-file' })],
  })
  const decision = await dispatch(harness, agent)
  assert.deepEqual(decision.messages.map(message => message.source.kind), ['user', 'preset-card'])
  assert.equal(harness.service.officialOwnerOf(agent.session.id), false, 'false 表示官方未装配，不代表插件接管正文')
})

test('官方来源负责人事实按会话隔离，来源 disposer 后恢复未知', async (t) => {
  const harness = harnessFor(t)
  const mounted = agentAt(harness.app, t)
  const unknown = agentAt(harness.app, t)
  const dispose = harness.service.registerPreset(mounted.ctx, 'preset:official', { configs: [], officialInstructions: true })
  await dispatch(harness, mounted)
  await dispatch(harness, unknown)
  assert.equal(harness.service.officialOwnerOf(mounted.session.id), true)
  assert.equal(harness.service.officialOwnerOf(unknown.session.id), undefined)
  dispose()
  await dispatch(harness, mounted)
  assert.equal(harness.service.officialOwnerOf(mounted.session.id), undefined)
})

test('协调器 dispose 后停止过滤，HMR 新实例只执行一份过滤', async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  const file = policyFile(policy([PROJECT_ID]))
  let service
  const start = () => app.plugin(ctx => { service = installPreStepCoordinator(ctx, { home, policyFile: file }) })
  const old = start()
  await old
  const agent = agentAt(app, t)
  const incoming = official()
  const run = () => agentEvents(app, agent).waterfall('agent/pre-step',
    { messages: [userTask], turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [userTask, incoming] }))
  assert.deepEqual(officialMessages(await run())[0].source.changes.map(change => change.path), ['CLAUDE.md'])
  const stale = service
  await old.dispose()
  assert.equal(officialMessages(await run())[0], incoming)
  const untouched = [incoming]
  assert.equal(stale.filterInstructions(agent, untouched), untouched, '旧服务引用也停止过滤')
  const fresh = start()
  await fresh
  t.after(() => fresh.dispose())
  const decision = await run()
  assert.equal(officialMessages(decision).length, 1)
  assert.deepEqual(officialMessages(decision)[0].source.changes.map(change => change.path), ['CLAUDE.md'])
})

test('主会话 hint 晋升、压缩和重晋升期间始终先遵守文件开关', async (t) => {
  const harness = harnessFor(t, policyFile(policy([PROJECT_ID])), { hintFirst: true })
  const agent = agentAt(harness.app, t)
  const run = () => dispatch(harness, agent, [official()])
  const emit = (type, data = {}) => {
    const event = { seq: agent.events.length + 1, type, data }
    agent.events.push(event)
    harness.app.emit('session/event', agent.session, event)
  }
  const first = await run()
  assert.deepEqual(officialMessages(first)[0].source.changes.map(change => change.path), ['CLAUDE.md'])
  emit('tool/call')
  const promoted = await run()
  assert.equal(promoted.messages[1].source.kind, 'instruction-hint')
  assert.doesNotMatch(bodyOf(promoted.messages[1]), /AGENTS\.md/)
  agent.visible.push(promoted.messages[1])
  assert.deepEqual((await run()).messages, [userTask], '可见历史已有 hint 时不重复')
  emit('compaction/end')
  agent.visible.length = 0
  const compacted = await run()
  assert.deepEqual(officialMessages(compacted)[0].source.changes.map(change => change.path), ['CLAUDE.md'])
  emit('tool/call')
  const again = await run()
  assert.equal(again.messages[1].source.kind, 'instruction-hint')
  assert.doesNotMatch(bodyOf(again.messages[1]), /AGENTS\.md/)
})

for (const hintFirst of [false, true]) {
  for (const officialFirst of [false, true]) {
    test(`hint 前先过滤，关闭文件不转为路径提示（hint 先挂=${hintFirst}，官方先挂=${officialFirst}）`, async (t) => {
      const file = policyFile(policy([PROJECT_ID]))
      const harness = harnessFor(t, file, { hintFirst, officialFirst })
      const agent = agentAt(harness.app, t, nested, 1)
      const decision = await dispatch(harness, agent, [official()])
      assert.deepEqual(decision.messages.map(message => message.source.kind), ['user', 'instruction-hint'])
      assert.match(bodyOf(decision.messages[1]), /Reference documents exist: CLAUDE\.md/)
      assert.doesNotMatch(bodyOf(decision.messages[1]), /AGENTS\.md|RULES/)
      writeFileSync(file, policy([PROJECT_ID, OTHER_ID]), 'utf8')
      assert.deepEqual((await dispatch(harness, agent, [official()])).messages, [userTask], '全部关闭不留下无来源 hint')
    })
  }
}

// 指令快照负责人事实继续走 bridge；无事实时保持 null，不由 UI 猜测。
const promptConfigsPath = SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.promptConfigs
const ownerConfigsDir = join(root, 'owner-configs')
mkdirSync(ownerConfigsDir)

function handlersWith(getService) {
  const registered = new Map()
  const sctx = {
    settings: { describe: () => [{ ns: 'prompt-tool', value: {}, base: {} }], mutate: async () => {} },
    webServer: { register: ({ path, handler }) => { registered.set(path, handler); return () => {} } },
    agents: { get: () => undefined },
    tools: { schemas: () => [] },
    presetConfigs: { read: () => [] },
    get: getService,
    effect: (fn) => fn(),
  }
  registerSettingsBridge(
    { inject: (_deps, cb) => cb(sctx) }, 'prompt-tool', () => ({ available: true }), () => ({}),
    () => '', undefined, () => ownerConfigsDir,
  )
  return registered
}

function ownerFakeReq(body) {
  const req = {
    method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }
  req[Symbol.asyncIterator] = function* () {
    if (req.body !== undefined) yield Buffer.from(String(req.body))
  }
  return req
}

function ownerFakeRes() {
  let status = 0
  let body = ''
  return {
    writeHead(code) { status = code }, end(payload) { body = payload },
    get status() { return status }, get body() { return body },
  }
}

const callInstructions = async (getService) => {
  const handler = handlersWith(getService).get(promptConfigsPath)
  assert.ok(handler, '/prompt-configs 已注册')
  const res = ownerFakeRes()
  await handler(ownerFakeReq({ sessionId: 's-owner' }), res)
  assert.equal(res.status, 200, res.body)
  return JSON.parse(res.body).value.instructions
}

test('指令负责人事实：协调器观察到官方指令行 → owner.officialInstructions = true', async () => {
  const instructions = await callInstructions((name) =>
    name === PRE_STEP_COORDINATOR_SERVICE ? { officialOwnerOf: (id) => (id === 's-owner' ? true : undefined) } : undefined)
  assert.equal(instructions.owner.officialInstructions, true)
})

test('指令负责人事实：协调器观察到官方未装配 → false', async () => {
  const service = { officialOwnerOf: (id) => (id === 's-owner' ? false : undefined) }
  const instructions = await callInstructions((name) => (name === PRE_STEP_COORDINATOR_SERVICE ? service : undefined))
  assert.equal(instructions.owner.officialInstructions, false)
})

test('指令负责人事实：协调器尚未观察过该会话 → null（不猜）', async () => {
  const service = { officialOwnerOf: () => undefined }
  const instructions = await callInstructions((name) => (name === PRE_STEP_COORDINATOR_SERVICE ? service : undefined))
  assert.equal(instructions.owner.officialInstructions, null)
})

test('指令负责人事实：没有协调服务时为 null', async () => {
  const instructions = await callInstructions(() => undefined)
  assert.equal(instructions.owner.officialInstructions, null)
})
