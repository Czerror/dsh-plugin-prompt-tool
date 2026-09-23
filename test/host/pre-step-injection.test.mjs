// 独立指令文件注入（Wave 2 合并，2026-09-17 测试归一精简）：
// 合并自 pre-step-coordinator.test.mjs（15 条）、instruction-owner.test.mjs（4 条）、
// instructions-e2e.test.mjs（3 条），共 22 条；用例标题与断言逐条保留。
// 端到端用例使用独立的隔离 DSH_HOME（e2eHome），与基底协调层用例的 home 分离。
//
// 独立指令文件来源协调层（W3）：策略开关、按会话工作区探测、文件版本可见状态、
// 一次性失效通知与负责人冲突。覆盖 PLAN.md T15–T21 的判定面：
//   - 策略缺失/损坏 → 不注入（不把损坏策略当空配置，也不冒充空正文）；
//   - 按会话 cwd 探测全局 + 项目文件，字段来自独立策略（defaults + 每文件覆盖）；
//   - 同版本已可见不重复、内容变化注入新版本一次、成功压缩后同版本恢复、失败压缩不重放；
//   - reject / 无 after-user 锚点不确认注入；不可用文件只在曾注入过时发一次失效通知；
//   - 官方指令行仍在（负责人冲突）时不注入；旧生成卡 agents-file-* 不再参战。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse } from 'yaml'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { PRE_STEP_COORDINATOR_SERVICE, installPreStepCoordinator } from '../../src/runtime/pre-step-coordinator.ts'
import { agentsFileId } from '../../src/host/agents-cards.ts'

const home = mkdtempSync(join(tmpdir(), 'pt-coord-home-'))
const ws = mkdtempSync(join(tmpdir(), 'pt-coord-ws-'))
mkdirSync(join(ws, '.git'), { recursive: true })
const nested = join(ws, 'packages', 'app')
mkdirSync(nested, { recursive: true })
writeFileSync(join(home, 'AGENTS.md'), 'GLOBAL RULES\n', 'utf8')
writeFileSync(join(ws, 'AGENTS.md'), 'PROJECT RULES\n', 'utf8')

// 端到端用例的隔离 DSH_HOME 与上面的 home 分开：基底在 home/AGENTS.md 放了全局指令文件，
// 若共用会被端到端用例当成用户级文件而多注入一条。动态 import 必须在设置之后生效。
const e2eHome = mkdtempSync(join(tmpdir(), 'pt-e2e-home-'))
/** 工作区必须在 DSH_HOME 之外：否则会被当成用户级 `$DSH_HOME/AGENTS.md`。 */
const workspaceRoot = mkdtempSync(join(tmpdir(), 'pt-e2e-ws-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = e2eHome
const { BRIDGE_ENDPOINTS, SETTINGS_BRIDGE_PREFIX, registerSettingsBridge, writePreset } =
  await import('../../lib/index.mjs')
const { FIXTURE_PRESET_ID, installFixturePreset } = await import('../fixtures/preset-template.mjs')
// 夹具不含官方 agent-instructions 行（等价于原 anchored 的「无官方指令行」装配事实），
// 独立指令来源才会接管正文注入；standard 基型相反，用于下面的负责人冲突用例。
installFixturePreset(join(e2eHome, 'preset'))

/** 端到端用例的策略文件（与基底的 policyWith 生成的 case-N 策略互不干扰）。 */
const e2ePolicyFile = join(e2eHome, '.prompt-tool', 'instructions.yml')
mkdirSync(join(e2eHome, '.prompt-tool'), { recursive: true })
writeFileSync(e2ePolicyFile, 'schemaVersion: 1\nenabled: true\n', 'utf8')

after(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
  rmSync(ws, { recursive: true, force: true })
  rmSync(e2eHome, { recursive: true, force: true })
  rmSync(workspaceRoot, { recursive: true, force: true })
})

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const GLOBAL_ID = agentsFileId(join(home, 'AGENTS.md'))
const PROJECT_ID = agentsFileId(join(ws, 'AGENTS.md'))
const rev16 = (text) => sha256(Buffer.from(text)).slice(0, 16)

let caseSeq = 0
const newPolicyFile = () => {
  caseSeq += 1
  const dir = join(home, '.prompt-tool', `case-${caseSeq}`)
  mkdirSync(dir, { recursive: true })
  return join(dir, 'instructions.yml')
}
const policyWith = (content) => {
  const file = newPolicyFile()
  writeFileSync(file, content, 'utf8')
  return file
}

const userTask = {
  id: 'task-1',
  role: 'user',
  content: [{ type: 'text', text: '写一个工具' }],
  source: { kind: 'user' },
}

let sessionSeq = 0
/** 只带持久日志（无 deriveMessages）：走「事件流 + compaction 边界」可见面回退路径。 */
const agentAt = (cwd, events = [], header = {}) => {
  sessionSeq += 1
  return {
    session: {
      id: `s-${sessionSeq}`,
      header: { delegationDepth: 0, ...(cwd === undefined ? {} : { cwd }), ...header },
      snapshotEvents: () => events,
    },
    options: { model: 'pro' },
  }
}

/** 注入过的历史消息（持久事件形状：event.data 本身是消息）。 */
const injectedEvent = (fileId, revision, seq = 1) => ({
  seq,
  type: 'user/message',
  data: {
    id: `injected-${fileId}-${revision}`,
    role: 'user',
    content: [{ type: 'text', text: 'OLD BODY' }],
    source: { kind: 'instruction-file', form: 'instructions', plugin: `instruction-file:${fileId}:${revision}:e0` },
  },
})

/** 生成器感知的最小 ctx：cordis effect（含 generator effect）、on、provide、logger。 */
const makeCtx = () => {
  const listeners = new Map()
  const provided = new Map()
  const warnings = []
  const cleanups = []
  const disposeEffect = (fn) => {
    const result = fn()
    if (result !== null && typeof result === 'object' && typeof result.next === 'function') {
      const undo = []
      for (let step = result.next(); step.done !== true; step = result.next()) {
        if (typeof step.value === 'function') undo.push(step.value)
      }
      return () => {
        for (const item of undo.reverse()) item()
      }
    }
    return typeof result === 'function' ? result : () => {}
  }
  const ctx = {
    on(name, handler) {
      listeners.set(name, handler)
      return () => listeners.delete(name)
    },
    effect(fn) {
      const dispose = disposeEffect(fn)
      cleanups.push(dispose)
      return dispose
    },
    provide(name, value) {
      provided.set(name, value)
    },
    get(name) {
      return provided.get(name)
    },
    logger: { warn: (message) => warnings.push(message) },
  }
  return { ctx, listeners, provided, warnings, cleanups }
}

const coordinatorFor = (options = {}) => {
  const harness = makeCtx()
  const service = installPreStepCoordinator(harness.ctx, { home, ...options })
  // 生产装配里每个 mount 都有 prompt-config-engine 行（即使没有预设卡也会上报装配事实）；
  // 测试默认注册一份「只有事实、没有配置」的来源，未确认装配的用例显式关掉它。
  if (options.preset !== false) {
    service.registerPreset(harness.ctx, 'preset:test-owner', { configs: [], officialInstructions: false })
  }
  return { ...harness, service }
}

const step = async (harness, agent, decide) =>
  harness.listeners.get('agent/pre-step')(
    { agent },
    decide ?? (async () => ({ kind: 'enter', messages: [userTask] })),
  )

const fileMessages = (decision) =>
  (Array.isArray(decision?.messages) ? decision.messages : []).filter((message) => message?.source?.kind === 'instruction-file')

const bodyOf = (message) =>
  (Array.isArray(message?.content) ? message.content : [])
    .map((block) => (typeof block?.text === 'string' ? block.text : ''))
    .join('\n')

/** 极简预设来源：只会注入一条静态消息，用于负责人冲突/遗留卡用例。 */
const presetCard = (overrides = {}) => ({
  id: 'preset-card-1',
  layer: 'pre-step',
  enabled: true,
  order: 10,
  position: 'after-user',
  promotion: 'none',
  audience: null,
  modelScope: 'all',
  role: 'user',
  dedupe: 'none',
  mergeMode: 'separate',
  sourceKind: 'preset-card',
  form: 'text',
  texts: [],
  params: {},
  variables: {},
  identity: { field: 'plugin', value: 'preset-card-1' },
  resolve: async () => ({ text: 'PRESET BODY' }),
  ...overrides,
})

const registerPreset = (harness, configs, officialInstructions = false) =>
  harness.service.registerPreset(harness.ctx, 'preset:test', {
    configs,
    officialInstructions,
  })

test('T15 策略缺失（默认关闭）不注入文件正文', async () => {
  const harness = coordinatorFor({ policyFile: newPolicyFile() })
  const decision = await step(harness, agentAt(nested))
  assert.equal(fileMessages(decision).length, 0, '缺省关闭时没有文件卡参战')
  assert.deepEqual(decision.messages.map((message) => message.id), ['task-1'])
  assert.deepEqual(harness.warnings, [])
})

test('T15 显式 enabled=false 时不注入文件正文', async () => {
  const harness = coordinatorFor({ policyFile: policyWith('schemaVersion: 1\nenabled: false\n') })
  const decision = await step(harness, agentAt(nested))
  assert.deepEqual(decision.messages.map((message) => message.id), ['task-1'])
  assert.deepEqual(harness.warnings, [])
})

test('T15 enabled 后按会话工作区探测：全局 + 项目文件各一张，字段来自策略 defaults', async () => {
  const file = policyWith('schemaVersion: 1\nenabled: true\ndefaults:\n  order: 12\n  position: before-all\n')
  const harness = coordinatorFor({ policyFile: file })
  const decision = await step(harness, agentAt(nested))
  const cards = fileMessages(decision)
  assert.equal(cards.length, 2, '全局与项目文件各一条')
  // before-all 按 order 升序插在用户消息之前。
  assert.deepEqual(decision.messages.map((message) => message.source.kind), ['instruction-file', 'instruction-file', 'user'])
  const project = cards.find((message) => message.source.plugin.includes(PROJECT_ID))
  assert.ok(project, '项目文件按真实路径身份生成')
  assert.equal(bodyOf(project), 'Instructions from: AGENTS.md\n\nPROJECT RULES')
  assert.equal(project.role, 'user')
  assert.equal(project.source.form, 'instructions')
  assert.equal(project.source.plugin, `instruction-file:${PROJECT_ID}:${rev16('PROJECT RULES\n')}:e0`)
  const global = cards.find((message) => message.source.plugin.includes(GLOBAL_ID))
  assert.equal(bodyOf(global), 'Instructions from: ~/.dsh/AGENTS.md\n\nGLOBAL RULES')
})

test('T12 无本地会话 cwd：只保留可确认的全局文件，不拿进程 cwd 兜底', async () => {
  const file = policyWith('enabled: true\n')
  const harness = coordinatorFor({ policyFile: file })
  const decision = await step(harness, agentAt(undefined))
  assert.equal(fileMessages(decision).length, 1)
  assert.equal(fileMessages(decision)[0].source.plugin.includes(GLOBAL_ID), true)
})

test('T15 每文件覆盖：行为字段与显示名生效；enabled=false 单独关闭该文件', async () => {
  const file = policyWith([
    'enabled: true',
    'files:',
    `  ${PROJECT_ID}:`,
    '    order: 7',
    '    position: after-all',
    '    promotion: main',
    '    audience: subagent',
    '    modelScope: flash',
    '',
  ].join('\n'))
  const harness = coordinatorFor({ policyFile: file })
  // audience=subagent 且 modelScope=flash：主会话不注入，Flash 子代理注入。
  const main = await step(harness, agentAt(nested))
  assert.deepEqual(fileMessages(main).map((message) => message.source.plugin.includes(PROJECT_ID)), [false])
  const sub = await step(
    harness,
    { ...agentAt(nested, [{ seq: 1, type: 'tool/call', data: {} }], { delegationDepth: 1 }), options: { model: 'deepseek-flash' } },
  )
  assert.deepEqual(
    fileMessages(sub).map((message) => message.source.plugin.includes(PROJECT_ID)).sort(),
    [false, true],
    'Flash 子代理同时注入两份文件',
  )
  assert.deepEqual(
    sub.messages.map((message) => message.source.kind),
    ['user', 'instruction-file', 'instruction-file'],
    'after-all / after-user 都落在真实用户消息之后',
  )

  const scoped = policyWith(`enabled: true\nfiles:\n  ${PROJECT_ID}:\n    enabled: false\n`)
  const off = await step(coordinatorFor({ policyFile: scoped }), agentAt(nested))
  assert.deepEqual(fileMessages(off).map((message) => message.source.plugin.includes(PROJECT_ID)), [false])
  assert.equal(fileMessages(off).length, 1, '只剩全局文件一张')
})

test('T16/T20 同版本已可见不重复；内容变化注入新版本一次；多文件身份独立', async () => {
  const file = policyWith('enabled: true\n')
  const harness = coordinatorFor({ policyFile: file })
  const projectIdentity = `instruction-file:${PROJECT_ID}:${rev16('PROJECT RULES\n')}:e0`
  const already = await step(harness, agentAt(nested, [injectedEvent(PROJECT_ID, rev16('PROJECT RULES\n'))]))
  assert.deepEqual(
    fileMessages(already).map((message) => message.source.plugin),
    [`instruction-file:${GLOBAL_ID}:${rev16('GLOBAL RULES\n')}:e0`],
    '项目文件同版本已可见 → 不重复；全局文件独立身份照常注入',
  )

  writeFileSync(join(ws, 'AGENTS.md'), 'PROJECT RULES V2\n', 'utf8')
  const changed = await step(harness, agentAt(nested, [injectedEvent(PROJECT_ID, rev16('PROJECT RULES\n'))]))
  const updated = fileMessages(changed).find((message) => message.source.plugin.includes(PROJECT_ID))
  assert.ok(updated, '内容变化 → 注入新版本一次')
  assert.equal(updated.source.plugin, `instruction-file:${PROJECT_ID}:${rev16('PROJECT RULES V2\n')}:e0`)
  assert.notEqual(updated.source.plugin, projectIdentity, '新版本身份与旧版本不同')
  assert.equal(bodyOf(updated), 'Instructions from: AGENTS.md\n\nPROJECT RULES V2')
  writeFileSync(join(ws, 'AGENTS.md'), 'PROJECT RULES\n', 'utf8')
})

test('T17 成功压缩后同版本恢复注入；失败压缩不推进 epoch', async () => {
  const file = policyWith([
    'enabled: true',
    'files:',
    `  ${GLOBAL_ID}:`,
    '    enabled: false',
    '',
  ].join('\n'))
  const harness = coordinatorFor({ policyFile: file })
  const identity = `instruction-file:${PROJECT_ID}:${rev16('PROJECT RULES\n')}:e0`
  const success = await step(
    harness,
    agentAt(nested, [injectedEvent(PROJECT_ID, rev16('PROJECT RULES\n'), 1), { seq: 2, type: 'compaction/end', data: {} }]),
  )
  const afterSuccess = fileMessages(success)
  assert.equal(afterSuccess.length, 1, '成功压缩把旧全文移出可见面 → 同版本重新注入一次')
  assert.notEqual(afterSuccess[0].source.plugin, identity, '新 epoch 身份，不复用旧消息身份')
  assert.equal(afterSuccess[0].source.plugin, `instruction-file:${PROJECT_ID}:${rev16('PROJECT RULES\n')}:e2`)

  const failed = await step(
    harness,
    agentAt(nested, [
      injectedEvent(PROJECT_ID, rev16('PROJECT RULES\n'), 1),
      { seq: 2, type: 'compaction/end', data: { error: 'boom' } },
    ]),
  )
  assert.deepEqual(fileMessages(failed), [], '失败压缩不推进边界 → 不重放同版本')
})

test('T19 可见面以 deriveMessages() 为准（压缩投影后的真相优先于持久日志）', async () => {
  const file = policyWith('enabled: true\n')
  const harness = coordinatorFor({ policyFile: file })
  const agent = agentAt(nested, [injectedEvent(PROJECT_ID, rev16('PROJECT RULES\n')), injectedEvent(GLOBAL_ID, rev16('GLOBAL RULES\n'))])
  agent.session.deriveMessages = () => []
  const decision = await step(harness, agent)
  assert.equal(fileMessages(decision).length, 2, '投影后可见面为空 → 两份文件都重新注入')
})

test('T21 不可用文件：曾注入过发一次失效通知，从未注入过静默；通知只发一次', async () => {
  const file = policyWith([
    'enabled: true',
    'files:',
    `  ${GLOBAL_ID}:`,
    '    enabled: false',
    `  ${PROJECT_ID}:`,
    '    enabled: false',
    '',
  ].join('\n'))
  const harness = coordinatorFor({ policyFile: file })
  const emptyDir = join(ws, 'empty-case')
  mkdirSync(emptyDir, { recursive: true })
  writeFileSync(join(emptyDir, 'AGENTS.md'), '', 'utf8')
  const emptyId = agentsFileId(join(emptyDir, 'AGENTS.md'))

  const noticed = await step(harness, agentAt(emptyDir, [injectedEvent(emptyId, rev16('OLD\n'))]))
  const notice = fileMessages(noticed)
  assert.equal(notice.length, 1, '曾注入过正文 → 发一次失效通知')
  assert.equal(notice[0].source.plugin, `instruction-file:${emptyId}:unavailable:e0`)
  assert.match(bodyOf(notice[0]), /no longer available \(file is empty\)/)
  assert.match(bodyOf(notice[0]), /stale/)

  const repeated = await step(harness, agentAt(emptyDir, [
    injectedEvent(emptyId, rev16('OLD\n'), 1),
    {
      seq: 2,
      type: 'user/message',
      data: {
        id: 'notice-1',
        role: 'user',
        content: [{ type: 'text', text: 'no longer available' }],
        source: { kind: 'instruction-file', form: 'instructions', plugin: `instruction-file:${emptyId}:unavailable:e0` },
      },
    },
  ]))
  assert.deepEqual(fileMessages(repeated), [], '失效通知只发一次')

  const never = await step(harness, agentAt(emptyDir))
  assert.deepEqual(fileMessages(never), [], '从未注入过的文件不可用时不注入任何东西')

  const bigDir = join(ws, 'big-case')
  mkdirSync(bigDir, { recursive: true })
  writeFileSync(join(bigDir, 'AGENTS.md'), 'x'.repeat(64 * 1024 + 1), 'utf8')
  const bigId = agentsFileId(join(bigDir, 'AGENTS.md'))
  const big = await step(harness, agentAt(bigDir, [injectedEvent(bigId, rev16('OLD\n'))]))
  assert.match(bodyOf(fileMessages(big)[0]), /no longer available/)
  assert.equal(fileMessages(big)[0].source.plugin, `instruction-file:${bigId}:unavailable:e0`)
})

test('策略损坏或 schemaVersion 未知：拒绝注入，不当作空配置', async () => {
  const broken = policyWith('enabled: true\n  bad indent::\n')
  assert.deepEqual(fileMessages(await step(coordinatorFor({ policyFile: broken }), agentAt(nested))), [])
  const future = policyWith('schemaVersion: 99\nenabled: true\n')
  assert.deepEqual(fileMessages(await step(coordinatorFor({ policyFile: future }), agentAt(nested))), [])
})

test('T18 reject 与缺少 after-user 锚点都不确认注入', async () => {
  const file = policyWith('enabled: true\n')
  const harness = coordinatorFor({ policyFile: file })
  const rejected = await step(harness, agentAt(nested), async () => ({ kind: 'reject' }))
  assert.deepEqual(rejected, { kind: 'reject' })
  const noAnchor = await step(harness, agentAt(nested), async () => ({ kind: 'enter', messages: [] }))
  assert.deepEqual(noAnchor.messages, [], '没有真实用户消息锚点 → 文件卡延后，不写入')
})

test('T27 负责人冲突：官方指令行仍在时不注入文件正文（预设卡照常）', async () => {
  const file = policyWith('enabled: true\n')
  const harness = coordinatorFor({ policyFile: file })
  registerPreset(harness, [presetCard()], true)
  const decision = await step(harness, agentAt(nested))
  assert.deepEqual(fileMessages(decision), [], '同一正文只由一方注入')
  assert.deepEqual(decision.messages.map((message) => message.source.kind), ['user', 'preset-card'], '预设卡照常注入')
})

test('T27 未确认装配（没有已注册的 preset 来源）不注入文件正文，也不谎称插件负责', async () => {
  const file = policyWith('enabled: true\n')
  const harness = coordinatorFor({ policyFile: file, preset: false })
  const agent = agentAt(nested)
  const decision = await step(harness, agent)
  assert.deepEqual(fileMessages(decision), [], '装配未知 → 不同时执行，也不要「偷跑」')
  assert.equal(harness.service.officialOwnerOf(agent.session.id), undefined, '未确认 → 负责人事实保持未知')
})

test('T25 旧生成卡 agents-file-* 由独立来源接管后不再参战', async () => {
  const file = policyWith('enabled: true\nfiles:\n  ' + GLOBAL_ID + ':\n    enabled: false\n')
  const harness = coordinatorFor({ policyFile: file })
  registerPreset(harness, [
    presetCard({
      id: `agents-file-${PROJECT_ID}`,
      sourceKind: 'instruction-file',
      identity: { field: 'plugin', value: `agents-file-${PROJECT_ID}` },
      resolve: async () => ({ text: 'LEGACY CARD BODY' }),
    }),
  ])
  const decision = await step(harness, agentAt(nested))
  const texts = decision.messages.map(bodyOf)
  assert.ok(!texts.some((text) => text.includes('LEGACY CARD BODY')), '遗留卡不参与注入')
  assert.equal(fileMessages(decision).length, 1, '运行时文件来源照常注入')
  assert.ok(harness.warnings.some((message) => /skipping legacy generated file card/.test(message)))
})

test('T15/T16 文件卡按策略晋升门控，正文 literal（不经过预设变量插值）', async () => {
  const dir = join(ws, 'literal-case')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'AGENTS.md'), 'RULES {{KeepRaw}}\n', 'utf8')
  const file = policyWith([
    'enabled: true',
    'files:',
    `  ${GLOBAL_ID}:`,
    '    enabled: false',
    `  ${PROJECT_ID}:`,
    '    enabled: false',
    `  ${agentsFileId(join(dir, 'AGENTS.md'))}:`,
    '    promotion: main',
    '',
  ].join('\n'))
  const harness = coordinatorFor({ policyFile: file })

  const unpromoted = await step(harness, agentAt(dir))
  assert.deepEqual(fileMessages(unpromoted), [], 'promotion=main 未晋升不注入（缺锚点之外的第二道门）')

  const promoted = await step(harness, agentAt(dir, [{ seq: 1, type: 'tool/call', data: {} }]))
  assert.equal(fileMessages(promoted).length, 1)
  assert.match(bodyOf(fileMessages(promoted)[0]), /\{\{KeepRaw\}\}/, '文件正文 literal，不插值')
})

// —— 指令负责人事实（原 instruction-owner.test.mjs，4 条） ——
// 负责人事实契约：/bootstrap 的 instructions.owner 来自 pre-step 协调器对该会话的观察，
// 没有协调服务或尚未观察过时为 null（不猜）。这是 UI「官方指令行仍在 → 独立来源不参战」
// 提示的唯一数据来源，不能靠客户端本地推断。

const promptConfigsPath = SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.promptConfigs
const ownerConfigsDir = mkdtempSync(join(tmpdir(), 'pt-owner-configs-'))
after(() => rmSync(ownerConfigsDir, { recursive: true, force: true }))

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
    { inject: (_deps, cb) => cb(sctx) },
    'prompt-tool',
    () => ({ available: true }),
    () => ({}),
    () => '',
    undefined,
    () => ownerConfigsDir,
  )
  return registered
}

function ownerFakeReq(body) {
  const req = {
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: 'localhost' },
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
    writeHead(code) { status = code },
    end(payload) { body = payload },
    get status() { return status },
    get body() { return body },
  }
}

/** 指令快照与负责人事实在 /prompt-configs 与 /bootstrap 走同一入口；这里取前者。 */
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

test('指令负责人事实：协调器观察到插件独立来源负责 → false', async () => {
  const service = { officialOwnerOf: (id) => (id === 's-owner' ? false : undefined) }
  const instructions = await callInstructions((name) => (name === PRE_STEP_COORDINATOR_SERVICE ? service : undefined))
  assert.equal(instructions.owner.officialInstructions, false)
})

test('指令负责人事实：协调器尚未观察过该会话 → null（不猜）', async () => {
  const service = { officialOwnerOf: () => undefined }
  const instructions = await callInstructions((name) => (name === PRE_STEP_COORDINATOR_SERVICE ? service : undefined))
  assert.equal(instructions.owner.officialInstructions, null)
})

test('指令负责人事实：没有协调服务（独立引擎/测试宿主）时为 null，不猜成冲突', async () => {
  const instructions = await callInstructions(() => undefined)
  assert.equal(instructions.owner.officialInstructions, null)
})

// —— 端到端注入（原 instructions-e2e.test.mjs，3 条） ——
// 端到端（真实物化 + 包内真实引擎 + 协调器 + 真实文件系统）：
//   writePreset 生成预设（组合行以包名说明符引用包内共享引擎，不再物化 `<预设根>/.engine/`）
//   → 受管字段按历史基准换算为绝对 file:// → 引擎行注册来源给协调器 → 指令文件按会话工作区
//   现场探测并注入正文 → 文件变更后注入新版本 → 内容为空只发失效通知。
// 与单测的区别：这里不注入任何替身，探测、策略、读取、版本、消息身份全部走真实模块。

/** 物化一份真实预设（组合行引用包内共享引擎，不再物化 `.engine/`），返回预设目录与挂载目录。 */
const materialize = (name, template) => {
  const presetDir = join(e2eHome, 'preset')
  writePreset('PROMPT', {
    firstTurnAnchor: false,
    firstTurnText: '',
    firstTurnCustom: false,
    guideText: '',
    guideCustom: false,
    injectPrompt: true,
    modelProvider: '', subagentModelProvider: '', subagentModelName: '',
    modelName: '',
    bootstrapMaxTokens: 0,
    usePtcMode: true,
    presetDir,
    presetOrder: 5,
    presetTemplate: template,
    outputId: name,
    promptConfigs: [],
  })
  return { presetDir, mountDir: join(presetDir, name) }
}

const userMessage = (text = 'claimed') => ({
  id: 'u-claimed',
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})

const textsOf = (decision) =>
  (Array.isArray(decision?.messages) ? decision.messages : [])
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .map((block) => block?.text ?? '')
    .filter((text) => text.length > 0)

const instructionMessages = (decision) =>
  (Array.isArray(decision?.messages) ? decision.messages : [])
    .filter((message) => message?.source?.kind === 'instruction-file')

/** 包内共享引擎源码：阶段 2 起引擎由插件包提供（组合行写包名说明符），不再物化到预设根。 */
const packageEngineFile = fileURLToPath(new URL('../../engine/prompt-config-engine.mjs', import.meta.url))

/**
 * 组合行声明的受管配置位置 → 装配期绝对 `file://`。
 * 正本仍按历史语义相对 `<预设根>/.engine/` 书写（`../<id>/prompt-configs`），与
 * `preset-registry.absolutizeLocalModules` 同一规则；该基准目录本身已不再物化。
 */
const engineConfigsDir = (presetDir, mountDir) => {
  const rows = parse(readFileSync(join(mountDir, 'agent.cordis.yml'), 'utf8'))
  const row = rows.find((item) => item?.name === 'dsh-plugin-prompt-tool/engine/prompt-config-engine.mjs')
  assert.ok(row, '组合行按包名说明符引用包内共享引擎')
  assert.equal(row.config.configsDir, `../${basename(mountDir)}/prompt-configs`, '受管字段保持历史相对形态')
  return pathToFileURL(resolve(join(presetDir, '.engine'), row.config.configsDir)).href
}

/** 真实装配：协调器挂在 app 上，包内共享引擎按换算后的受管位置注册到 agent 的 mount scope。 */
const mountPreset = async (presetDir, mountDir, agent) => {
  const app = new Context()
  const service = installPreStepCoordinator(app, { home: e2eHome, policyFile: e2ePolicyFile })
  assert.equal(typeof service.registerPreset, 'function')
  assert.equal(app.get(PRE_STEP_COORDINATOR_SERVICE), service, '协调服务在 app 上可见')
  assert.equal(existsSync(join(presetDir, '.engine')), false, '共享引擎不再物化到预设根')
  const scope = createScope(app, agent)
  agent.ctx = scope.ctx
  const engine = await import(pathToFileURL(packageEngineFile).href)
  engine.apply(scope.ctx, {
    configsDir: engineConfigsDir(presetDir, mountDir),
    presetRoot: `${pathToFileURL(presetDir).href}/`,
  })
  return app
}

/** 会话持久日志可变：可见面（deriveMessages）与事件扫描都读它。 */
const makeAgent = (cwd) => {
  const events = []
  return {
    events,
    session: {
      id: 'e2e-session',
      header: { delegationDepth: 0, cwd },
      snapshotEvents: () => events,
      deriveMessages: () => events.map((event) => event?.data).filter((data) => data?.source !== undefined),
    },
    options: { model: 'pro' },
  }
}

const dispatch = (app, agent) =>
  agentEvents(app, agent).waterfall(
    'agent/pre-step',
    { messages: [userMessage()], turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [userMessage()] }),
  )

test('E2E 物化 preset + 引擎 + 协调器：按会话工作区注入文件正文，文件变更注入新版本', async () => {
  const workspace = join(workspaceRoot, 'workspace')
  mkdirSync(join(workspace, '.git'), { recursive: true })
  writeFileSync(join(workspace, 'AGENTS.md'), 'PROJECT RULES V1\n', 'utf8')
  const { presetDir, mountDir } = materialize('e2e-fixture', FIXTURE_PRESET_ID)

  const agent = makeAgent(workspace)
  const app = await mountPreset(presetDir, mountDir, agent)

  const first = await dispatch(app, agent)
  const injected = instructionMessages(first)
  assert.equal(injected.length, 1, '物化 + 引擎 + 协调器整链只注入一次')
  const projectText = textsOf(first).find((text) => text.includes('PROJECT RULES V1'))
  assert.match(projectText, /^Instructions from: AGENTS\.md\n\nPROJECT RULES V1$/)
  assert.equal(injected[0].source.plugin.includes(sha256(Buffer.from('PROJECT RULES V1\n')).slice(0, 16)), true, '身份含真实字节版本')

  // 文件外部变更：下一次 pre-step 注入新版本（旧版本仍在可见面里）。
  writeFileSync(join(workspace, 'AGENTS.md'), 'PROJECT RULES V2\n', 'utf8')
  agent.events.push({ seq: 1, type: 'user/message', data: injected[0] })
  const second = await dispatch(app, agent)
  const updated = instructionMessages(second)
  assert.equal(updated.length, 1, '内容变化 → 注入一次新版本')
  assert.match(textsOf(second).join('\n'), /PROJECT RULES V2/)
  assert.notEqual(updated[0].source.plugin, injected[0].source.plugin, '新版本身份与旧版本不同')
})

test('E2E 助手删掉文件：曾注入过 → 只发一次失效通知；策略关闭 → 不再注入', async () => {
  const workspace = join(workspaceRoot, 'workspace-2')
  mkdirSync(join(workspace, '.git'), { recursive: true })
  writeFileSync(join(workspace, 'AGENTS.md'), 'TEMP RULES\n', 'utf8')
  const { presetDir, mountDir } = materialize('e2e-fixture-2', FIXTURE_PRESET_ID)
  const agent = makeAgent(workspace)
  const app = await mountPreset(presetDir, mountDir, agent)

  const injected = instructionMessages(await dispatch(app, agent))
  assert.equal(injected.length, 1)
  rmSync(join(workspace, 'AGENTS.md'), { force: true })
  agent.events.push({ seq: 1, type: 'user/message', data: injected[0] })
  const gone = instructionMessages(await dispatch(app, agent))
  assert.equal(gone.length, 1, '已注入过的文件消失 → 一次失效通知')
  assert.match(textsOf({ messages: gone }).join('\n'), /no longer available/)

  writeFileSync(e2ePolicyFile, 'schemaVersion: 1\nenabled: false\n', 'utf8')
  const off = await dispatch(app, agent)
  assert.deepEqual(instructionMessages(off), [], '策略关闭 → 文件来源整体不参战')
})

test('E2E 负责人冲突：standard 模板仍挂着官方指令行 → 文件正文不注入', async () => {
  const workspace = join(workspaceRoot, 'workspace-3')
  mkdirSync(join(workspace, '.git'), { recursive: true })
  writeFileSync(join(workspace, 'AGENTS.md'), 'CONFLICT RULES\n', 'utf8')
  writeFileSync(e2ePolicyFile, 'schemaVersion: 1\nenabled: true\n', 'utf8')
  const { presetDir, mountDir } = materialize('e2e-standard', 'pt-standard')
  const agent = makeAgent(workspace)
  const app = await mountPreset(presetDir, mountDir, agent)

  const decision = await dispatch(app, agent)
  assert.deepEqual(instructionMessages(decision), [], '官方指令行仍在 → 独立来源不注入')
})
