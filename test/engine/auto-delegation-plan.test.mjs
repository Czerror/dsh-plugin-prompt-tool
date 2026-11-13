/**
 * 票 08：自动派工、等待与汇总。
 *
 * 接缝 A：真实官方 Team（agentTeams）+ 真实 SubagentRuntime + spawn provider + 插件真实装配
 *          createAgentAssembly + 可控 adapter。断言落在**真实 spawn 出来的子代理首请求**、
 *          官方任务状态/版本/依赖、以及运行终态上；官方 ready、规则命中或提示词命中都不算启动。
 *
 * 夹具模块只装配本票需要的规则（角色正文与协议仍用包内真实资产逐字比对，默认关闭的
 * auto-delegation 规则从包内定义逐字取来）；04 的完整十三条规则由
 * prompt-content-redteam.test.mjs 守门，不在这里重复搭建。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { createAgentAssembly } from '../../src/runtime/agent-assembly.ts'
import { createRoleDelegation, ROLE_MODULE_ID } from '../../src/runtime/role-delegation.ts'
import { createAutoDelegation, AUTO_DELEGATION_RULE_ID } from '../../src/runtime/auto-delegation.ts'
import { setModuleEnabled } from '../../src/host/config-store.ts'
import { readModuleRules, editModuleRules } from '../../src/host/module-rules.ts'
import { parse as parseYaml } from 'yaml'

/**
 * 夹具自带最小资产与自动派工规则：红队内容模块已移出仓库（存档在本地知识库），
 * 测试不再依赖产品内容，只保留「角色正文 / 公共段 / 协议 / 派工纪律」的可观察断言。
 */
const FIXTURE_ASSETS = {
  'roles/plan.md': 'FIXTURE-ROLE-PLAN',
  'roles/recon.md': 'FIXTURE-ROLE-RECON',
  'roles/assess.md': 'FIXTURE-ROLE-ASSESS',
  'roles/vuln-scan.md': 'FIXTURE-ROLE-VULN-SCAN',
  'roles/exploit.md': 'FIXTURE-ROLE-EXPLOIT',
  'roles/internal.md': 'FIXTURE-ROLE-INTERNAL',
  'common/env.md': 'FIXTURE-COMMON-ENV',
  'common/bind.md': 'FIXTURE-COMMON-BIND',
  'common/handoff.md': 'FIXTURE-COMMON-HANDOFF',
  'protocols/redteam-lead.md': 'FIXTURE-PROTOCOL-LEAD',
  'protocols/redteam-child.md': 'FIXTURE-PROTOCOL-CHILD',
}
const asset = (...parts) => FIXTURE_ASSETS[parts.filter(part => part !== 'assets').join('/')]
const FIXTURE_AUTO_RULE = {
  id: 'auto-delegation', name: '自动派工纪律', enabled: false, layer: 'pre-step',
  then: [{ id: 'discipline', kind: 'inject-text',
    config: { layer: 'pre-step', position: 'before-all', dedupe: 'session', text: '## 自动派工运行纪律\nFIXTURE-AUTO-DELEGATION-DISCIPLINE' } }],
}
const writeAssets = moduleDir => {
  for (const [relative, text] of Object.entries(FIXTURE_ASSETS)) {
    const file = join(moduleDir, 'assets', relative)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
}
const roleBody = role => asset('assets', 'roles', role + '.md')
const commonBody = key => asset('assets', 'common', key + '.md')
const protocolBody = file => asset('assets', 'protocols', file + '.md')

const require = createRequire(import.meta.url)
const peer = createRequire(require.resolve('@deepseek-ai/dsh-agent-loop'))
const load = name => import(pathToFileURL(peer.resolve(name)).href)
const [{ default: Llm, LlmAdapter, createUserMessage }, { default: Agents }, { default: Sessions }, { default: Projections },
  { default: Prompt }, { default: Tools }, Native, { default: Loop }, Persistence, { default: Subagents }, Spawn] = await Promise.all([
  load('@deepseek-ai/dsh-llm'), load('@deepseek-ai/dsh-agent'), load('@deepseek-ai/dsh-session'),
  load('@deepseek-ai/dsh-session-projection'), load('@deepseek-ai/dsh-system-prompt'), load('@deepseek-ai/dsh-tools'),
  load('@deepseek-ai/dsh-tool-executor-native'), load('@deepseek-ai/dsh-agent-loop'),
  load('@deepseek-ai/dsh-session-persistence-jsonl'), load('@deepseek-ai/dsh-subagent'),
  import('@deepseek-ai/dsh-subagent-spawn-in-process'),
])

/** 官方 Team 包不在本插件依赖树里：先按普通说明符解析，再回退固定的 rc.2 源码构建；都不行就明确报缺失。 */
async function loadTeam() {
  try {
    return (await import('@deepseek-ai/dsh-agent-team')).default
  } catch (primary) {
    const marker = new URL('../../.scratch/harness/local.json', import.meta.url)
    const sourceRoot = existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')).sourceRoot : undefined
    const entry = typeof sourceRoot === 'string' ? join(sourceRoot, 'packages', 'team', 'agent-team', 'lib', 'index.js') : undefined
    if (entry === undefined || !existsSync(entry)) {
      throw new Error('官方 Team 包不可用：package.json 的 devDependencies 应声明 @deepseek-ai/dsh-agent-team@0.2.2-rc.2（install 后由 lock 的 overrides 解析到固定构建）；也可用 .scratch/harness/local.json 指向固定 rc.2 源码构建；原因：' + String(primary?.message ?? primary))
    }
    return (await import(pathToFileURL(entry).href)).default
  }
}
const TeamService = await loadTeam()

const ROLE_FORM = {
  plan: { audience: 'main', commons: ['env', 'bind'] },
  recon: { audience: 'subagent', commons: ['bind', 'handoff'] },
  assess: { audience: 'subagent', commons: ['bind', 'handoff'] },
  'vuln-scan': { audience: 'subagent', commons: ['bind', 'handoff'] },
  exploit: { audience: 'subagent', commons: ['bind', 'handoff'] },
  internal: { audience: 'subagent', commons: ['bind', 'handoff'] },
}
const inject = (id, file, layer = 'pre-step') => ({
  id, kind: 'inject-text',
  config: layer === 'pre-step'
    ? { layer, position: 'before-all', dedupe: 'session', templateFile: './assets/' + file }
    : { layer, order: 150, templateFile: './assets/' + file },
})
const fixtureRoles = roles => roles.map(role => {
  const form = ROLE_FORM[role]
  return {
    id: 'role-' + role, enabled: true, layer: 'pre-step',
    if: { all: [{ scope: { audience: form.audience } }, { variable: { key: 'role', op: 'eq', value: role } }] },
    then: [inject('body', 'roles/' + role + '.md'), ...form.commons.map(key => inject(key, 'common/' + key + '.md'))],
  }
})
const protocolRule = () => ({
  id: 'protocol-redteam', enabled: false, group: 'capability-protocol', groupScope: 'cross-module', exclusive: true,
  then: [
    { if: { scope: { audience: 'main' } }, then: [inject('lead', 'protocols/redteam-lead.md', 'system-section')] },
    { if: { scope: { audience: 'subagent' } }, then: [inject('child', 'protocols/redteam-child.md', 'system-section')] },
  ],
})
/** 包内真实定义的自动派工规则（默认 enabled=false），夹具只改开关值。直接读 YAML，避免在包目录物化规则切片。 */
const packageRules = () => [JSON.parse(JSON.stringify(FIXTURE_AUTO_RULE))]
const packageAutoRule = () => JSON.parse(JSON.stringify(FIXTURE_AUTO_RULE))

/** 可控 adapter：记录真实请求；按会话挂住流，用于观察「依赖未完成时后序未启动」。 */
class Capture extends LlmAdapter {
  requests = []
  children = []
  parentId = undefined
  holdAll = false
  gates = new Map()
  async resolveModel(provider, id) { return { provider, id, name: id } }
  async *stream(request) {
    const id = String(request.sessionId)
    this.requests.push({ sessionId: id, messages: request.messages })
    if (id !== this.parentId) {
      this.children.push(id)
      if (this.holdAll) {
        if (!this.gates.has(id)) this.gates.set(id, Promise.withResolvers())
        await this.gates.get(id).promise
      }
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'AUTO-FIXTURE-ANSWER' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  release(sessionId) { this.gates.get(sessionId)?.resolve() }
  releaseAll() { for (const gate of this.gates.values()) gate.resolve(); this.gates.clear(); this.holdAll = false }
}

const messageText = message => (message.content ?? []).map(block => (typeof block === 'string' ? block : block?.text ?? '')).join('\n')
const requestText = request => request.messages.map(messageText).join('\n---\n')
const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms) })
async function waitFor(check, label, timeout = 20000) {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error('等待超时：' + label)
    await sleep(10)
  }
}

const brief = tag => ({
  objective: 'OBJECTIVE-' + tag,
  inputs: 'INPUTS-' + tag,
  known: 'KNOWN-' + tag,
  expected: 'EXPECTED-' + tag,
  acceptance: 'ACCEPTANCE-' + tag,
  tools: 'TOOLS-' + tag,
})
const subtask = (key, role, extra = {}) => ({ key, role, subject: 'literal subject ' + key, brief: brief(key), ...extra })
const plan = (planId, subtasks) => ({ planId, subtasks, signal: new AbortController().signal })

async function mount(t, { auto = true, roles = ['recon'], teamEnabled = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'pt-auto-delegation-'))
  const moduleRoot = join(home, 'modules'), moduleDir = join(moduleRoot, ROLE_MODULE_ID)
  mkdirSync(moduleDir, { recursive: true })
  writeAssets(moduleDir)
  const ids = [...roles, 'auto-delegation', 'protocol-redteam']
  writeFileSync(join(moduleDir, 'module.yml'), JSON.stringify({
    id: ROLE_MODULE_ID, name: 'auto delegation fixture', version: '1.0.0', engineCompat: '>=0.4.2',
    modules: ['rule-engine'], variables: { role: '' },
    configOrder: Object.fromEntries(ids.map((id, index) => [id, 70 + index * 10])),
    rules: [...fixtureRoles(roles), { ...packageAutoRule(), enabled: auto }, protocolRule()],
  }))
  setModuleEnabled(moduleRoot, ROLE_MODULE_ID, true)

  const root = new Context()
  const capture = new Capture()
  // 告警进数组而不是丢弃：失败时能看见「认领未完成」「绑定未完成」这类真实原因。
  const warnings = []
  const warn = message => warnings.push(String(message))
  const runtime = createRoleDelegation(root, { moduleRoot, warn })
  const auto_delegation = createAutoDelegation({ delegation: runtime, moduleRoot, warn })
  const assembly = createAgentAssembly(root, {
    moduleRoot,
    enabledModules: () => [ROLE_MODULE_ID],
    runtimeVariables: (id, sessionId) => runtime.roleFactsOf(id, sessionId),
    warn,
  })
  const off = root.on('agent/created', async ({ agent }) => {
    auto_delegation.assignRoot(agent)
    await runtime.bindCreated(agent)
  })
  const handles = []
  t.after(async () => {
    off()
    await assembly.dispose().catch(() => {})
    auto_delegation.dispose()
    runtime.dispose()
    for (const item of handles) await item.dispose().catch(() => {})
    await root.fiber.dispose().catch(() => {})
    rmSync(home, { recursive: true, force: true })
  })

  for (const plugin of [Llm, Sessions, Projections, Prompt, Tools, Native, Agents]) await root.plugin(plugin)
  await root.plugin(Persistence, { root: join(home, 'sessions'), compression: 'none' })
  await root.plugin(Loop, { agents: [] })
  root.provide('workingDirectory', { get: () => home, ensure: async () => home, set: async () => home })
  await root.plugin(Subagents)
  await root.plugin(Spawn, { providerName: 'spawn' })
  await root.plugin(TeamService, {})
  root.llm.registerAdapter(['local'], capture)

  const handle = await root.agents.create({ sessionId: 'auto-parent', agentOptions: { provider: 'local', model: 'auto-fixture' }, meta: { cwd: home } })
  handles.push(handle)
  capture.parentId = String(handle.agent.id)
  if (teamEnabled) await root.agentTeams.setEnabled(handle.agent, true)
  await assembly.settled()

  const childText = sessionId => capture.requests.filter(request => request.sessionId === sessionId).map(requestText).join('\n===\n')
  const parentText = () => childText(String(handle.agent.id))
  const turn = async text => {
    const before = capture.requests.filter(request => request.sessionId === capture.parentId).length
    handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
    await handle.agent.whenIdle()
    await waitFor(() => capture.requests.filter(request => request.sessionId === capture.parentId).length > before, '根会话下一个请求')
  }
  const tasks = () => root.agentTeams.listTasks(handle.agent)
  return { home, moduleRoot, moduleDir, root, capture, runtime, auto: auto_delegation, assembly, warnings, parent: handle.agent, handle, childText, parentText, turn, tasks }
}

test('串行依赖：官方任务与 blockedBy 先登记，依赖完成前不启动后序，任务书自包含，汇总只认真实运行结果', { timeout: 120000 }, async t => {
  const h = await mount(t, { roles: ['recon', 'vuln-scan'] })
  // 用户显式开启：走既有事务选红队协议并给真实根授 plan，再刷新装配让新协议进入后续请求。
  h.auto.enable(h.parent)
  await h.assembly.refresh()
  h.capture.holdAll = true
  // 并行额度给到 2：有依赖的任务仍按 blockedBy 串行，额度不能越过依赖。
  const running = h.auto.run({ parent: h.parent, parallel: 2, ...plan('plan-serial', [subtask('recon', 'recon'), subtask('scan', 'vuln-scan', { blockedBy: ['recon'] })]) })

  await waitFor(() => h.capture.children.length === 1, '第一个执行者真实启动')
  const first = h.capture.children[0]
  const registered = h.tasks()
  assert.equal(registered.length, 2, '两项子任务都登记进官方任务板')
  const [blocker, blocked] = [registered.find(task => task.blockedBy.length === 0), registered.find(task => task.blockedBy.length === 1)]
  assert.deepEqual([...blocked.blockedBy], [blocker.id], '官方 blockedBy 指向真实上游任务 id')
  assert.deepEqual([blocker.status, blocked.status], ['in_progress', 'pending'], '状态由真实运行推进，不由 ready 推进')
  assert.equal(blocked.ready, false, '依赖未完成时官方 ready=false')
  assert.equal(blocked.ownerId, undefined, '未启动的任务没有 owner')
  await sleep(120)
  assert.equal(h.capture.children.length, 1, '依赖未完成，后序真实子代理没有启动')

  const firstText = h.childText(first)
  for (const label of ['目标范围', '输入', '已知事实', '预期产出', '验收依据', '实际可用工具']) {
    assert.ok(firstText.includes('## ' + label), '任务书含段落：' + label)
  }
  assert.ok(firstText.includes('OBJECTIVE-recon') && firstText.includes('TOOLS-recon'), '任务书正文来自本次子任务的字段')
  assert.equal(firstText.includes('OBJECTIVE-scan'), false, '不把后序任务的内容塞进当前任务书')
  assert.ok(firstText.includes(roleBody('recon')), '执行角色正文仍由 redteam 规则在首请求投递')
  assert.ok(firstText.includes(protocolBody('redteam-child')), '子代理拿红队子协议')

  h.capture.releaseAll()
  const summary = await running
  assert.equal(h.capture.children.length, 2, '上游完成后再启动后序')
  assert.deepEqual(summary.outcomes.map(item => [item.key, item.state]), [['recon', 'completed'], ['scan', 'completed']])
  const settled = h.tasks()
  for (const item of summary.outcomes) {
    const task = settled.find(candidate => candidate.id === item.taskId)
    assert.equal(task.status, 'completed', '官方任务与汇总一致：' + item.key)
    assert.equal(typeof item.childSession, 'string')
    assert.equal(typeof item.runId, 'string', '汇总带真实运行身份：' + item.key)
    assert.equal(task.ownerId, item.childSession, '任务归属就是该次运行的子会话')
    assert.equal(item.revision, task.revision)
  }
  assert.equal(summary.completed, true)
  assert.equal(summary.cancelled, false)
  assert.equal(settled.find(task => task.id === summary.outcomes[1].taskId).blockedBy[0], summary.outcomes[0].taskId, '官方依赖关系保持')
})

test('计划校验：任务书不自包含、key 重复、未知依赖、成环与不可派角色都被拒，零登记零启动', { timeout: 60000 }, async t => {
  const h = await mount(t, { roles: ['recon'] })
  const reject = async (request, code) => await assert.rejects(
    h.auto.run({ parent: h.parent, ...request }), error => {
      assert.equal(error.code, code, error.message)
      return true
    })
  await reject(plan('plan-blank-tools', [{ ...subtask('recon', 'recon'), brief: { ...brief('recon'), tools: '   ' } }]), 'AUTO_BRIEF_INCOMPLETE')
  await reject(plan('plan-missing', [{ ...subtask('recon', 'recon'), brief: { ...brief('recon'), acceptance: '' } }]), 'AUTO_BRIEF_INCOMPLETE')
  await reject(plan('plan-dup', [subtask('recon', 'recon'), subtask('recon', 'recon')]), 'AUTO_PLAN_INVALID')
  await reject(plan('plan-unknown-dep', [subtask('recon', 'recon', { blockedBy: ['missing'] })]), 'AUTO_PLAN_INVALID')
  await reject(plan('plan-cycle', [subtask('recon', 'recon', { blockedBy: ['scan'] }), subtask('scan', 'recon', { blockedBy: ['recon'] })]), 'AUTO_PLAN_INVALID')
  await reject(plan('plan-plan-role', [subtask('root', 'plan')]), 'AUTO_ROLE_INVALID')
  await reject({ planId: '', subtasks: [subtask('recon', 'recon')], signal: new AbortController().signal }, 'AUTO_PLAN_INVALID')
  assert.equal(h.tasks().length, 0, '被拒的计划不登记任何官方任务')
  assert.equal(h.capture.children.length, 0, '被拒的计划不启动任何子代理')
})

test('开关与授根：包内默认关闭，开关决定注入与派工资格，enable 走既有协议事务并只给真实根授 plan', { timeout: 180000 }, async t => {
  const pkgRule = packageRules().find(item => item.id === AUTO_DELEGATION_RULE_ID)
  assert.equal(pkgRule.enabled, false, '自动派工规则默认关闭（规格 34）')

  const off = await mount(t, { auto: false, roles: ['plan'] })
  assert.equal(off.auto.status(off.parent).ruleEnabled, false)
  await assert.rejects(off.auto.run({ parent: off.parent, ...plan('plan-off', [subtask('recon', 'recon')]) }),
    error => error.code === 'AUTO_DELEGATION_DISABLED', '关闭时不接受计划')
  assert.equal(off.tasks().length, 0, '关闭时不登记官方任务')
  await off.turn('literal turn off')
  assert.equal(off.parentText().includes('自动派工运行纪律'), false, '规则关闭时主会话没有运行纪律')
  assert.equal(off.parentText().includes(roleBody('plan')), false, '规则关闭时 root 没有 plan 正文')
  assert.equal(off.capture.children.length, 0)
  assert.equal(off.auto.assignRoot(off.parent), false, '规则关闭时不授 plan')

  // 保存开关：开启后沿既有事务选红队协议；关闭时不擅自重开普通协议（规格 9/33）。
  const opening = readModuleRules(off.moduleDir)
  const autoRule = opening.rules.find(item => item.id === AUTO_DELEGATION_RULE_ID)
  editModuleRules(off.moduleDir, { expectedRevisions: opening.revisions, edits: [{ previousId: AUTO_DELEGATION_RULE_ID, rule: { ...autoRule, enabled: true }, settingsChanged: true }] })
  assert.equal(off.auto.status(off.parent).ruleEnabled, true, '编辑并保存后运行时按新值判定')
  assert.equal(readModuleRules(off.moduleDir).rules.find(item => item.id === 'protocol-redteam').enabled, false, '规则开启本身不切协议')
  off.auto.syncRule()
  assert.equal(readModuleRules(off.moduleDir).rules.find(item => item.id === 'protocol-redteam').enabled, true, '开启沿既有跨模块互斥事务选红队协议')
  assert.equal(off.auto.assignRoot(off.parent), true, '规则开启后给真实根授 plan')
  await off.assembly.refresh()
  await off.turn('literal turn discipline')
  assert.ok(off.parentText().includes('自动派工运行纪律'), '规则开启后 main 受众实际收到运行纪律')
  assert.ok(off.parentText().includes(roleBody('plan')), '授 plan 后 root 得到角色正文')
  assert.ok(off.parentText().includes(protocolBody('redteam-lead')), '主会话协议为红队主')

  const on = await mount(t, { auto: true, roles: ['plan', 'recon'] })
  await on.turn('literal turn on')
  assert.ok(on.parentText().includes('自动派工运行纪律'), '规则开启后 main 受众实际收到运行纪律')
  assert.ok(on.parentText().includes(roleBody('plan')), '规则开启时 plan 在根会话创建时即授出')
  assert.equal(on.parentText().includes(protocolBody('redteam-lead')), false, '未开启事务前不切红队主协议')

  assert.deepEqual(on.auto.enable(on.parent), { ruleEnabled: true, protocol: 'redteam' })
  assert.equal(readModuleRules(on.moduleDir).rules.find(item => item.id === 'protocol-redteam').enabled, true,
    '开启沿既有跨模块互斥事务选红队协议')
  assert.deepEqual(on.runtime.roleFactsOf(ROLE_MODULE_ID, String(on.parent.id)), { role: 'plan' }, 'plan 授予真实根会话')
  await on.assembly.refresh()
  await on.turn('literal turn plan')
  const withPlan = on.parentText()
  assert.ok(withPlan.includes(roleBody('plan')), '根会话首请求之后的下一次请求已含 plan 正文')
  assert.ok(withPlan.includes(commonBody('env')) && withPlan.includes(commonBody('bind')), 'plan 组合的公共段按序到位')
  assert.ok(withPlan.includes(protocolBody('redteam-lead')), '主会话协议为红队主')

  // plan 只给真实根：子会话拿指挥角色被拒，assignRoot 对子会话不生效。
  on.capture.holdAll = true
  const run = await on.runtime.delegate({ parent: on.parent, role: 'recon', taskId: (await on.runtime.submitTask(on.parent, { subject: 'literal', description: 'literal task' })).id, label: 'x', prompt: 'literal task only', signal: new AbortController().signal })
  on.capture.releaseAll()
  const child = on.root.agents.get(run.childId)
  assert.throws(() => on.runtime.assignRootRole(child, 'plan'), error => error.code === 'ROLE_PARENT_REQUIRED', '子会话不能拿指挥角色')
  assert.equal(on.auto.assignRoot(child), false, '编排入口对子会话不授 plan')
  await run.activation.dispose().catch(() => {})

  on.auto.disable(on.parent)
  assert.equal(on.runtime.roleFactsOf(ROLE_MODULE_ID, String(on.parent.id)), undefined, '关闭撤回 plan 角色事实')
  assert.equal(readModuleRules(on.moduleDir).rules.find(item => item.id === 'protocol-redteam').enabled, true, '关闭不擅自重开普通协议')

  const before = readModuleRules(on.moduleDir)
  const current = before.rules.find(item => item.id === AUTO_DELEGATION_RULE_ID)
  editModuleRules(on.moduleDir, { expectedRevisions: before.revisions, edits: [{ previousId: AUTO_DELEGATION_RULE_ID, rule: { ...current, enabled: false }, settingsChanged: true }] })
  assert.equal(on.auto.status(on.parent).ruleEnabled, false, '编辑并保存后运行时按新值判定')
  on.auto.syncRule()
  assert.equal(readModuleRules(on.moduleDir).rules.find(item => item.id === 'protocol-redteam').enabled, true, '规则关闭后 syncRule 不重开普通协议')
  await assert.rejects(on.auto.run({ parent: on.parent, ...plan('plan-after-off', [subtask('recon', 'recon')]) }),
    error => error.code === 'AUTO_DELEGATION_DISABLED', '关闭后不再接受计划')
})

test('并行额度与失败收口：独立任务按额度并行且 writeScopes 不是锁，失败不自动完成并阻断后序', { timeout: 120000 }, async t => {
  const h = await mount(t, { roles: ['recon', 'assess', 'vuln-scan'] })
  h.capture.holdAll = true
  const parallel = h.auto.run({
    parent: h.parent,
    ...plan('plan-parallel', [
      subtask('a', 'recon', { writeScopes: ['src/shared'] }),
      subtask('b', 'assess', { writeScopes: ['src/shared'] }),
    ]),
    parallel: 2,
  })
  await waitFor(() => h.capture.children.length === 2, '两个独立任务在额度内并行启动')
  // 官方归属登记晚于 created 派发：认领成功才代表这次真实子会话拥有该任务，不能把「已启动」当成「已认领」。
  await waitFor(() => h.tasks().every(task => task.status === 'in_progress' && task.ownerId !== undefined), '两个任务都由真实子会话认领')
  const views = h.tasks()
  assert.deepEqual(views.map(task => task.status), ['in_progress', 'in_progress'])
  assert.ok(views.every(task => task.writeScopeWarnings.length > 0), '重叠 writeScopes 只作为官方冲突提示出现')
  assert.deepEqual(views.map(task => task.ownerId), [...h.capture.children], 'writeScopes 警告没有阻止任何一次派发')
  h.capture.releaseAll()
  const both = await parallel
  // 断言下沉到逐项状态与原因：失败时自带 owner-mismatch / no-evidence / stopReason:*，不用猜。
  assert.deepEqual(both.outcomes.map(item => [item.key, item.state, item.reason ?? '']),
    [['a', 'completed', ''], ['b', 'completed', '']],
    '并行两项都按真实运行结果完成；装配与认警告警：' + h.warnings.join(' / ')
      + '；任务归属：' + views.map(task => task.id + '@' + String(task.ownerId)).join(', ')
      + '；本次运行：' + both.outcomes.map(item => item.key + '#' + item.taskId + '>' + String(item.childSession)).join(', '))

  // 默认额度 1：同形状的独立任务一次只启动一个。
  // 重新按住子会话：否则第一个独立任务会在 150ms 观察窗内自行完成，测的就不是额度而是速度。
  h.capture.holdAll = true
  const serial = h.auto.run({ parent: h.parent, ...plan('plan-default-serial', [subtask('c', 'recon'), subtask('d', 'vuln-scan')]) })
  await waitFor(() => h.capture.children.length === 3, '默认额度下先启动第一个')
  await sleep(150)
  assert.equal(h.capture.children.length, 3, '默认额度下第二个独立任务没有被并行启动')
  await h.capture.release(h.capture.children[2])
  await waitFor(() => h.capture.children.length === 4, '前一个完成后才启动后一个')
  h.capture.release(h.capture.children[3])
  const serialSummary = await serial
  assert.equal(serialSummary.completed, true)
  assert.equal(h.capture.children.length, 4, '前一个完成后才启动后一个')

  // 角色内容被关闭：真实派发失败，不自动 completed，后序被阻断且官方任务保留。
  const moduleDir = h.moduleDir
  const ruleSnapshot = readModuleRules(moduleDir)
  const assessRule = ruleSnapshot.rules.find(item => item.id === 'role-assess')
  editModuleRules(moduleDir, { expectedRevisions: ruleSnapshot.revisions, edits: [{ previousId: 'role-assess', rule: { ...assessRule, enabled: false }, settingsChanged: true }] })
  const failing = await h.auto.run({ parent: h.parent, ...plan('plan-fail', [subtask('e', 'assess'), subtask('f', 'recon', { blockedBy: ['e'] })]) })
  assert.deepEqual(failing.outcomes.map(item => [item.key, item.state]), [['e', 'failed'], ['f', 'blocked']], '失败不自动完成，后序不启动')
  assert.equal(failing.completed, false)
  assert.equal(failing.outcomes[0].reason, 'ROLE_CONTENT_UNAVAILABLE', '失败原因是准确的不可用码')
  const failingTasks = h.tasks().filter(task => task.description.includes('plan-fail'))
  assert.deepEqual(failingTasks.map(task => task.status).sort(), ['pending', 'pending'], '官方任务保留，没有被伪造成完成或被删除')

  // 运行结束但无产出证据的极端终态由 07 的 settle 契约定（no-evidence 不标完成）；
  // 本夹具无法可靠构造「子代理结束却无 assistant 输出」而不让模型侧重试，故不在此伪造。
})

test('取消：不启动后续任务，不删除官方任务，不打断其他来源的成员', { timeout: 120000 }, async t => {
  const h = await mount(t, { roles: ['recon', 'vuln-scan'] })
  h.capture.holdAll = true
  // 另一个来源（不是本票派工）的成员：取消本来源不能波及它。
  const other = await h.root.subagents.startActivation({
    provider: 'spawn', label: 'other source', prompt: [{ type: 'text', text: 'literal only' }],
    parent: h.parent, signal: new AbortController().signal, delivery: 'caller',
  })
  const controller = new AbortController()
  const running = h.auto.run({ parent: h.parent, ...plan('plan-cancel', [subtask('recon', 'recon'), subtask('scan', 'vuln-scan', { blockedBy: ['recon'] })]), signal: controller.signal })
  await waitFor(() => h.capture.children.includes(String(other.childId)) && h.capture.children.length === 2, '两个会话都已启动')
  const ours = h.capture.children.find(id => id !== String(other.childId))
  controller.abort()
  h.capture.release(ours)
  const summary = await running
  assert.equal(summary.cancelled, true)
  assert.deepEqual(summary.outcomes.map(item => [item.key, item.state]), [['recon', 'completed'], ['scan', 'cancelled']], '已启动的收真实结果，未启动的不补发')
  assert.equal(h.capture.children.length, 2, '取消后没有启动后续子任务')
  const views = h.tasks()
  assert.equal(views.length, 2, '取消不删除官方任务')
  assert.ok(views.some(task => task.status === 'pending'), '未启动的后序任务保持 pending 可续做')
  assert.ok(h.root.agents.get(other.childId), '其他来源的成员仍在')
  h.capture.release(String(other.childId))
  await other.result
  await other.dispose().catch(() => {})

  // Team 被关闭（官方开关，不由本插件改）：已登记任务保留，后续任务不再启动。
  h.capture.holdAll = true
  const closing = h.auto.run({ parent: h.parent, ...plan('plan-team-off', [subtask('g', 'recon'), subtask('h', 'vuln-scan', { blockedBy: ['g'] })]) })
  await waitFor(() => h.capture.children.length === 3, '关闭前先启动第一个')
  const started = h.capture.children.length
  assert.equal(h.tasks().filter(task => task.description.includes('plan-team-off')).length, 2, '关闭前两项任务已登记且可读')
  await h.root.agentTeams.setEnabled(h.parent, false)
  h.capture.release(h.capture.children[2])
  const closedSummary = await closing
  // 已经跑完的那一步也拿不到官方写入：Team 关闭后官方拒绝任务变更，所以不冒充 completed。
  assert.deepEqual(closedSummary.outcomes.map(item => [item.key, item.state]), [['g', 'failed'], ['h', 'cancelled']],
    'Team 关闭后既有的真实运行不冒充完成，后续任务不启动')
  assert.deepEqual(closedSummary.outcomes.map(item => item.reason), ['TEAM_DISABLED', 'TEAM_DISABLED'], '原因来自官方开关状态')
  assert.equal(h.capture.children.length, started, '关闭后没有新的真实子代理')
  // 官方 Team 关闭时连任务板都不可读（官方语义）：重新按用户选择开启后才核对任务仍在。
  await h.root.agentTeams.setEnabled(h.parent, true)
  const kept = h.tasks().filter(task => task.description.includes('plan-team-off'))
  // 已启动的那一步真的被认领过（owner 是那次真实子会话），但 Team 关闭后官方拒绝完成写回，所以停在 in_progress。
  assert.deepEqual(kept.map(task => [task.status, task.ownerId === undefined]), [['in_progress', false], ['pending', true]],
    '官方任务不被删除也不被伪造完成')
})

test('恢复：重挂后按官方已有事实复用任务，不重复创建也不重复派发', { timeout: 120000 }, async t => {
  const h = await mount(t, { roles: ['recon', 'vuln-scan'] })
  const firstPlan = () => plan('plan-resume', [subtask('recon', 'recon'), subtask('scan', 'vuln-scan', { blockedBy: ['recon'] })])
  const first = await h.auto.run({ parent: h.parent, ...firstPlan() })
  assert.equal(first.completed, true)
  const created = h.tasks().map(task => task.id).sort()
  const children = h.capture.children.length
  assert.equal(children, 2)

  // 同一次运行内重跑同一计划：全部从官方终态汇报，不新建任务、不再启动子代理。
  const again = await h.auto.run({ parent: h.parent, ...firstPlan() })
  assert.deepEqual(again.outcomes.map(item => item.state), ['completed', 'completed'])
  assert.deepEqual(again.outcomes.map(item => item.reason), ['official-status', 'official-status'], '完成来自官方已有终态而不是新的启动')
  assert.deepEqual(h.tasks().map(task => task.id).sort(), created, '不重复创建官方任务')
  assert.equal(h.capture.children.length, children, '不重复派发已提交任务')

  // 重挂：新的编排实例没有内存状态，只能读官方事实。
  const remounted = createAutoDelegation({ delegation: h.runtime, moduleRoot: h.moduleRoot, warn: () => {} })
  t.after(() => remounted.dispose())
  const resumed = await remounted.run({ parent: h.parent, ...firstPlan() })
  assert.equal(resumed.completed, true)
  assert.deepEqual(h.tasks().map(task => task.id).sort(), created, '重挂后仍不创建新任务')
  assert.equal(h.capture.children.length, children, '重挂后仍不重复派发')
  assert.deepEqual(resumed.outcomes.map(item => item.taskId), again.outcomes.map(item => item.taskId), '任务 id 保持稳定')
})

test('交接：需要继续时用官方消息，真实成员收到后续内容', { timeout: 120000 }, async t => {
  const h = await mount(t, { roles: ['recon'] })
  h.capture.holdAll = true
  const running = h.auto.run({ parent: h.parent, ...plan('plan-handoff', [subtask('recon', 'recon')]) })
  await waitFor(() => h.capture.children.length === 1, '执行者启动')
  const child = h.capture.children[0]
  const signal = new AbortController().signal
  const messageId = await h.auto.handoff(h.parent, child, 'HANDOFF-MARKER continue with the remaining steps', signal)
  assert.equal(typeof messageId, 'string', '官方 inbox 接受消息并返回消息 id')
  h.capture.releaseAll()
  await running
  await waitFor(() => h.capture.requests.filter(request => request.sessionId === child).length > 1, '成员收到后续工作')
  assert.ok(h.childText(child).includes('HANDOFF-MARKER'), '后续请求里能看到这次交接的内容')
  await assert.rejects(h.auto.handoff(h.parent, child, '   ', signal), error => error.code === 'AUTO_HANDOFF_INVALID')
  // 官方 sendMessage 直接读 options.signal：缺 signal 会在派工层被明确拒绝，而不是变成宿主 TypeError。
  await assert.rejects(h.auto.handoff(h.parent, child, 'literal handoff', undefined),
    error => error.code === 'ROLE_MESSAGE_SIGNAL_REQUIRED', '缺 signal 的交接被明确拒绝')
})
