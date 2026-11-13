/**
 * 票 07：官方 Team 单任务角色委派。
 *
 * 接缝 A：真实官方 Team（agentTeams）+ 真实 SubagentRuntime + spawn provider + 插件真实装配
 *          createAgentAssembly + 可控 adapter。断言落在**子代理真正收到的首请求**、真实 spawn 结果
 *          与官方任务事件/版本上，不用规则 hit、注册成功或 role 标签代替。
 *
 * 夹具模块只装配本票需要的那几条规则（角色正文与协议仍用包内真实资产逐字比对）；
 * 04 的完整十三条规则与组合顺序由 prompt-content-redteam.test.mjs 守门，这里不重复搭建，
 * 也不让全量装配耗时变成测试时长。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { createAgentAssembly } from '../../src/runtime/agent-assembly.ts'
import { createRoleDelegation, ROLE_BINDING_EVENT, selectCapabilityProtocol } from '../../src/runtime/role-delegation.ts'
import { setModuleEnabled } from '../../src/host/config-store.ts'
import { readModuleRules, editModuleRules } from '../../src/host/module-rules.ts'

const PACKAGE_MODULE = new URL('../../modules/redteam/', import.meta.url)
const asset = (...parts) => readFileSync(new URL(parts.join('/'), PACKAGE_MODULE), 'utf8').trimEnd()
const roleBody = role => asset('assets', 'roles', role + '.md')
const commonBody = key => asset('assets', 'common', key + '.md')
const protocolBody = file => asset('assets', 'protocols', file + '.md')

const require = createRequire(import.meta.url)
const peer = createRequire(require.resolve('@deepseek-ai/dsh-agent-loop'))
const load = name => import(pathToFileURL(peer.resolve(name)).href)
const [{ default: Llm, LlmAdapter }, { default: Agents }, { default: Sessions }, { default: Projections },
  { default: Prompt }, { default: Tools }, Native, { default: Loop }, Persistence, { default: Subagents }, Spawn] = await Promise.all([
  load('@deepseek-ai/dsh-llm'), load('@deepseek-ai/dsh-agent'), load('@deepseek-ai/dsh-session'),
  load('@deepseek-ai/dsh-session-projection'), load('@deepseek-ai/dsh-system-prompt'), load('@deepseek-ai/dsh-tools'),
  load('@deepseek-ai/dsh-tool-executor-native'), load('@deepseek-ai/dsh-agent-loop'),
  load('@deepseek-ai/dsh-session-persistence-jsonl'), load('@deepseek-ai/dsh-subagent'),
  import('@deepseek-ai/dsh-subagent-spawn-in-process'),
])

/**
 * 官方 Team 包不在本插件依赖树里：先按普通说明符解析（本地 junction 或将来成为正式依赖），
 * 再回退到 `verify:harness` 固定的官方源码构建目录。两者都不可用时明确报准备缺失，
 * 不用 skip 冒充「已验过真实 Team」。
 */
async function loadTeam() {
  try {
    return (await import('@deepseek-ai/dsh-agent-team')).default
  } catch (primary) {
    const marker = new URL('../../.scratch/harness/local.json', import.meta.url)
    const sourceRoot = existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')).sourceRoot : undefined
    const entry = typeof sourceRoot === 'string' ? join(sourceRoot, 'packages', 'team', 'agent-team', 'lib', 'index.js') : undefined
    if (entry === undefined || !existsSync(entry)) {
      throw new Error('官方 Team 包不可用：需要 node_modules/@deepseek-ai/dsh-agent-team 或 .scratch/harness/local.json 指向固定 rc.2 源码构建；原因：' + String(primary?.message ?? primary))
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

/** 可控 adapter：记录真实请求；hold 时把子会话的首个请求挂住，用于观察存活子 Agent。 */
class Capture extends LlmAdapter {
  requests = []
  parentId = undefined
  hold = false
  entered = new Map()
  async resolveModel(provider, id) { return { provider, id, name: id } }
  async *stream(request) {
    const id = String(request.sessionId)
    this.requests.push({ sessionId: id, messages: request.messages })
    if (!this.entered.has(id)) this.entered.set(id, Promise.withResolvers())
    this.entered.get(id).resolve()
    if (this.hold && id !== this.parentId) {
      await new Promise((_, reject) => {
        if (request.signal.aborted) reject(request.signal.reason)
        else request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
      })
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ROLE-FIXTURE-ANSWER' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const messageText = message => (message.content ?? []).map(block => (typeof block === 'string' ? block : block?.text ?? '')).join('\n')
const requestText = request => request.messages.map(messageText).join('\n---\n')

async function mount(t, { teamEnabled = true, hold = false, roles = ['recon'] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'pt-role-delegation-'))
  const moduleRoot = join(home, 'modules'), moduleDir = join(moduleRoot, 'redteam')
  cpSync(PACKAGE_MODULE, moduleDir, { recursive: true })
  writeFileSync(join(moduleDir, 'module.yml'), JSON.stringify({
    id: 'redteam', name: 'role delegation fixture', version: '1.0.0', engineCompat: '>=0.4.2',
    modules: ['rule-engine'], variables: { role: '' },
    configOrder: Object.fromEntries([...roles.map((role, index) => ['role-' + role, 70 + index * 10]), ['protocol-redteam', 150]]),
    rules: [...fixtureRoles(roles), protocolRule()],
  }))
  setModuleEnabled(moduleRoot, 'redteam', true)
  selectCapabilityProtocol(moduleRoot, 'redteam')

  const root = new Context()
  const capture = new Capture()
  capture.hold = hold
  const runtime = createRoleDelegation(root, { moduleRoot, warn: () => {} })
  const assembly = createAgentAssembly(root, {
    moduleRoot,
    enabledModules: () => ['redteam'],
    runtimeVariables: (id, sessionId) => runtime.roleFactsOf(id, sessionId),
    warn: () => {},
  })
  const off = root.on('agent/created', async ({ agent }) => { await runtime.bindCreated(agent) })
  const handles = []
  t.after(async () => {
    off()
    await assembly.dispose().catch(() => {})
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

  const handle = await root.agents.create({ sessionId: 'role-parent', agentOptions: { provider: 'local', model: 'role-fixture' }, meta: { cwd: home } })
  handles.push(handle)
  capture.parentId = String(handle.agent.id)
  if (teamEnabled) await root.agentTeams.setEnabled(handle.agent, true)
  await assembly.settled()

  const childText = sessionId => capture.requests.filter(request => request.sessionId === sessionId).map(requestText).join('\n===\n')
  const waitRequest = async sessionId => { await capture.entered.get(sessionId)?.promise }
  const submit = (subject = 'literal subject') => runtime.submitTask(handle.agent, { subject, description: 'literal task, no side effects' })
  return { home, moduleRoot, moduleDir, root, capture, runtime, assembly, parent: handle.agent, handle, childText, waitRequest, submit }
}

const spec = context => ({ parent: context.parent, label: 'literal label', prompt: 'literal task only', signal: new AbortController().signal })

test('单任务闭环：真实启动后子代理首请求即有角色组合与红队子协议，结果归属真实运行与任务版本', { timeout: 60000 }, async t => {
  const h = await mount(t, { roles: ['recon', 'vuln-scan'] })
  const task = await h.submit()
  assert.equal(task.revision, 1, '官方任务从 revision 1 开始')
  const run = await h.runtime.delegate({ ...spec(h), role: 'recon', taskId: task.id })
  // created 先于 subagent/start：delegate 返回时 child Agent 已由官方注册，运行身份也已发布。
  const child = h.root.agents.get(run.childId)
  assert.equal(child.session.header.parentSession, h.parent.id, '真实 child header 指向真实父')
  assert.equal(typeof run.runId, 'string', '官方运行身份随真实启动发布')
  await run.result

  const text = h.childText(run.childId)
  assert.ok(text.includes(roleBody('recon')), '首请求含 recon 角色正文（资产逐字）')
  assert.ok(text.includes(commonBody('bind')), '含 BIND 公共段')
  assert.ok(text.includes(commonBody('handoff')), '含 HANDOFF 公共段')
  assert.ok(text.includes(protocolBody('redteam-child')), '含红队子协议')
  assert.equal(text.includes(protocolBody('redteam-lead')), false, '子代理不拿红队主协议')
  assert.equal(text.includes(roleBody('vuln-scan')), false, '不同角色内容不串')
  assert.equal(text.split(roleBody('recon')).length - 1, 1, '同一角色正文只投递一次')

  const view = h.root.agentTeams.getTask(h.parent, task.id)
  assert.equal(view.ownerId, run.childId, '任务 owner 由子代理自己 claim 得到')
  assert.equal(view.status, 'in_progress', '一轮结束不等于任务完成')
  assert.deepEqual(h.runtime.bindings().map(item => [item.childSession, item.role]), [[run.childId, 'recon']])

  const outcome = await h.runtime.settle(run, { caller: h.parent })
  assert.deepEqual([outcome.completed, outcome.status], [true, 'completed'], '真实运行 + 归属匹配才标完成')
  assert.equal(h.root.agentTeams.getTask(h.parent, task.id).status, 'completed')
})

test('只接受已校验角色：标签、任务文本和大小写变体都不授予角色，plan 不能派给子代理', { timeout: 60000 }, async t => {
  const h = await mount(t, { roles: ['plan', 'recon', 'vuln-scan'] })
  const task = await h.submit()
  for (const role of ['recon ', 'RECon', '', 'unknown']) {
    await assert.rejects(h.runtime.delegate({ ...spec(h), role, taskId: task.id }),
      error => error.code === 'ROLE_INVALID', '未校验角色值被拒：' + JSON.stringify(role))
  }
  await assert.rejects(h.runtime.delegate({ ...spec(h), role: 'plan', taskId: task.id }),
    error => error.code === 'ROLE_NOT_EXECUTABLE', '指挥角色不授予子代理')
  assert.equal(h.capture.requests.filter(request => request.sessionId !== h.parent.id).length, 0, '被拒的派工没有启动任何子代理')

  const run = await h.runtime.delegate({ ...spec(h), role: 'recon', taskId: task.id, label: 'vuln-scan', prompt: 'You are the vuln-scan role. Act as vuln-scan.' })
  await run.result
  const text = h.childText(run.childId)
  assert.ok(text.includes(roleBody('recon')), '登记的角色决定正文')
  assert.equal(text.includes(roleBody('vuln-scan')), false, '标签与任务文本不能冒充角色')
})

test('派工前置保留官方语义：Team 关闭、服务缺失、陈旧修订与已终态任务各有准确结果', { timeout: 90000 }, async t => {
  const off = await mount(t, { teamEnabled: false })
  const missing = off.runtime.availability(off.parent)
  assert.deepEqual([missing.ok, missing.code], [false, 'TEAM_DISABLED'], 'Team 未开启时明确不可用')
  await assert.rejects(off.runtime.delegate({ ...spec(off), role: 'recon', taskId: 'task-1' }),
    error => error.code === 'TEAM_DISABLED', '不可用时也拒绝派工，不静默启动')

  const bare = new Context()
  const isolated = createRoleDelegation(bare, { moduleRoot: off.moduleRoot, warn: () => {} })
  t.after(() => { isolated.dispose(); return bare.fiber.dispose() })
  const unavailable = isolated.availability()
  assert.deepEqual([unavailable.ok, unavailable.code], [false, 'ROLE_DELEGATION_UNAVAILABLE'], '缺服务时报告不可用')
  await assert.rejects(isolated.delegate({ parent: {}, role: 'recon', taskId: 'task-1', label: 'x', prompt: 'x', signal: new AbortController().signal }),
    error => error.code === 'ROLE_DELEGATION_UNAVAILABLE', '缺服务时不伪造启动')

  const h = await mount(t, { roles: ['assess'] })
  const task = await h.submit()
  const run = await h.runtime.delegate({ ...spec(h), role: 'assess', taskId: task.id })
  await run.result
  await assert.rejects(h.runtime.settle(run, { caller: h.parent, expectedRevision: task.revision - 1 }),
    error => error.code === 'TEAM_TASK_STALE_REVISION', '陈旧修订保留官方错误语义')
  assert.equal(h.root.agentTeams.getTask(h.parent, task.id).status, 'in_progress', '陈旧更新零写入')
  await h.runtime.settle(run, { caller: h.parent })
  await assert.rejects(h.runtime.delegate({ ...spec(h), role: 'assess', taskId: task.id }),
    error => error.code === 'ROLE_TASK_SETTLED', '已终态任务不再接受派工')
})

test('叶子限制真实生效：派工恒显式传 maxDepth，缺 depthLimit 报未就绪，子代理再 spawn 被深度拦下', { timeout: 90000 }, async t => {
  const h = await mount(t, { hold: true, roles: ['internal'] })
  const specSeen = []
  const fakeActivation = { childId: 'fake-child', result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] }), dispose: async () => {} }
  const fakes = on => ({
    on: () => () => {},
    events: { on: () => () => {} },
    get: name => name === 'subagents'
      ? { getProvider: () => ({ capabilities: { depthLimit: on } }), startActivation: async value => { specSeen.push(value); return fakeActivation } }
      : name === 'agentTeams' ? { isEnabled: () => true, getTask: () => ({ id: 'task-1', revision: 1, status: 'pending' }) } : undefined,
  })
  const limited = createRoleDelegation(fakes(true), { moduleRoot: h.moduleRoot })
  const capped = createRoleDelegation(fakes(false), { moduleRoot: h.moduleRoot })
  t.after(() => { limited.dispose(); capped.dispose() })
  const parent = { id: 'fake-parent', session: { id: 'fake-parent', header: {}, append() {}, snapshotEvents: () => [] } }
  await limited.delegate({ parent, role: 'internal', taskId: 'task-1', label: 'x', prompt: 'x', signal: new AbortController().signal })
  assert.equal(specSeen.length, 1)
  assert.deepEqual([specSeen[0].provider, specSeen[0].delivery, specSeen[0].maxDepth], ['spawn', 'caller', 1],
    '派工显式声明叶子深度（宿主没有默认上限）')
  assert.deepEqual(capped.availability().code, 'ROLE_LEAF_LIMIT_UNAVAILABLE', 'provider 不支持深度时报限制未就绪，不伪称已施加')

  // 真实验证：存活子代理再次 spawn 并显式 maxDepth=1 时，宿主按真实深度拒绝。
  const task = await h.submit()
  const run = await h.runtime.delegate({ ...spec(h), role: 'internal', taskId: task.id })
  await h.waitRequest(run.childId)
  const child = h.root.agents.get(run.childId)
  assert.ok(child, '子代理存活可观察')
  await assert.rejects(h.root.subagents.startActivation({
    provider: 'spawn', label: 'grandchild', prompt: [{ type: 'text', text: 'literal only' }],
    parent: child, signal: new AbortController().signal, delivery: 'caller', maxDepth: 1,
  }), error => {
    assert.equal(error.name, 'SubagentDepthError', '真实的深度拒绝来自宿主')
    assert.deepEqual([error.attemptedDepth, error.maxDepth], [2, 1])
    return true
  }, '执行角色是叶子：真实再次 spawn 被现有深度限制拦住')
  await run.activation.dispose().catch(() => {})
})

test('取消与释放：取消的启动不留可复用资格，关闭后不再接受新派工且不打断已启动子任务', { timeout: 60000 }, async t => {
  const h = await mount(t, { roles: ['recon', 'exploit'] })
  const task = await h.submit()
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(h.runtime.delegate({ ...spec(h), role: 'recon', taskId: task.id, signal: aborted.signal }))

  // 02 遗留①：取消的启动不能把角色留给下一个无关 child。
  const plain = await h.root.subagents.startActivation({
    provider: 'spawn', label: 'plain', prompt: [{ type: 'text', text: 'plain literal' }],
    parent: h.parent, signal: new AbortController().signal, delivery: 'caller',
  })
  await plain.result
  const text = h.childText(plain.childId)
  assert.equal(text.includes(roleBody('recon')), false, '取消后的无关子代理不继承角色')
  assert.equal(text.includes(commonBody('bind')), false, '也没有角色组合的公共段')

  const run = await h.runtime.delegate({ ...spec(h), role: 'exploit', taskId: task.id })
  h.runtime.close()
  await run.result
  assert.equal(h.root.agentTeams.getTask(h.parent, task.id).ownerId, run.childId, '已启动子任务的归属不被清理')
  await assert.rejects(h.runtime.delegate({ ...spec(h), role: 'exploit', taskId: task.id }),
    error => error.code === 'ROLE_DELEGATION_CLOSED', '关闭后不再接受新派工')
  const outcome = await h.runtime.settle(run, { caller: h.parent })
  assert.equal(outcome.completed, true, '关闭后仍可回收已启动工作的真实结果')
})

test('恢复只认官方持久事实：角色事件与 child header 交叉，非委派子会话不继承角色', { timeout: 60000 }, async t => {
  const h = await mount(t, { hold: true, roles: ['vuln-scan'] })
  const task = await h.submit()
  const run = await h.runtime.delegate({ ...spec(h), role: 'vuln-scan', taskId: task.id })
  await h.waitRequest(run.childId)
  const child = h.root.agents.get(run.childId)
  const binding = child.session.snapshotEvents().filter(event => event.type === ROLE_BINDING_EVENT).map(event => event.data)
  assert.deepEqual(binding, [{ role: 'vuln-scan', taskId: task.id, parentSession: String(h.parent.id) }],
    '角色事实落在子会话自己的官方事件里，可据 header 交叉核验')
  assert.equal(child.session.header.parentSession, h.parent.id, '交叉核验的另一半是 child header')

  const plain = await h.root.subagents.startActivation({
    provider: 'spawn', label: 'plain restore', prompt: [{ type: 'text', text: 'plain literal' }],
    parent: h.parent, signal: new AbortController().signal, delivery: 'caller',
  })
  await h.waitRequest(plain.childId)
  const other = h.root.agents.get(plain.childId)
  assert.equal(other.session.snapshotEvents().some(event => event.type === ROLE_BINDING_EVENT), false, '未委派子会话没有角色事实')
  await plain.dispose().catch(() => {})
  await run.activation.dispose().catch(() => {})
})

test('规则编辑与保存回归：关闭角色规则后派工明确不可用，公共段编辑后新派工首请求同步变化', { timeout: 60000 }, async t => {
  const h = await mount(t, { roles: ['recon'] })
  const before = readModuleRules(h.moduleDir)
  const rule = before.rules.find(item => item.id === 'role-recon')
  assert.ok(rule, '角色规则存在')
  editModuleRules(h.moduleDir, { expectedRevisions: before.revisions, edits: [{ previousId: 'role-recon', rule: { ...rule, enabled: false }, settingsChanged: true }] })
  const task = await h.submit()
  await assert.rejects(h.runtime.delegate({ ...spec(h), role: 'recon', taskId: task.id }),
    error => error.code === 'ROLE_CONTENT_UNAVAILABLE', '内容规则被关闭时明确不可用，不静默派一个没有角色的子代理')

  const current = readModuleRules(h.moduleDir)
  const disabled = current.rules.find(item => item.id === 'role-recon')
  editModuleRules(h.moduleDir, { expectedRevisions: current.revisions, edits: [{ previousId: 'role-recon', rule: { ...disabled, enabled: true }, settingsChanged: true }] })
  const handoff = join(h.moduleDir, 'assets', 'common', 'handoff.md')
  const original = readFileSync(handoff, 'utf8')
  writeFileSync(handoff, original.trimEnd() + '\nEDITED-HANDOFF-MARKER')
  const run = await h.runtime.delegate({ ...spec(h), role: 'recon', taskId: task.id })
  await run.result
  assert.ok(h.childText(run.childId).includes('EDITED-HANDOFF-MARKER'), '公共段编辑后新派工首请求同步变化')
  writeFileSync(handoff, original)
})

test('intent 一次性且按父会话隔离：不同父各拿自己的角色，同一 child 不被二次绑定', { timeout: 90000 }, async t => {
  // hold：子代理挂在首个请求上，才能观察存活的 child Agent 与它的会话事件。
  const h = await mount(t, { hold: true, roles: ['recon', 'vuln-scan', 'internal'] })
  // hold 下请求会晚到：等到该 child 真的有请求进来再断言。
  const waitChild = async (sessionId) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (h.capture.requests.some(request => request.sessionId === sessionId)) return
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error('child 没有发出请求：' + sessionId)
  }
  const taskA = await h.submit()
  const runA = await h.runtime.delegate({ ...spec(h), role: 'recon', taskId: taskA.id })
  await waitChild(runA.childId)
  assert.equal(h.runtime.roleFactsOf('redteam', runA.childId)?.role, 'recon')

  // intent 是一次性消费：同一 child 再走一次 created 不覆盖角色，也不重复写角色事件。
  const childA = h.root.agents.get(runA.childId)
  const before = childA.session.snapshotEvents().filter(event => event.type === ROLE_BINDING_EVENT).length
  await h.runtime.bindCreated(childA)
  assert.equal(h.runtime.roleFactsOf('redteam', runA.childId)?.role, 'recon', '同一 Agent 不得有两个执行角色')
  assert.equal(childA.session.snapshotEvents().filter(event => event.type === ROLE_BINDING_EVENT).length, before,
    '不重复写角色事件')

  // 另一个真实根会话自己的登记角色，不串到别人的父。
  const other = await h.root.agents.create({
    sessionId: 'role-parent-b',
    agentOptions: { provider: 'local', model: 'role-fixture' },
    meta: { cwd: h.home },
  })
  t.after(async () => { await other.dispose().catch(() => {}) })
  await h.root.agentTeams.setEnabled(other.agent, true)
  await h.assembly.settled()
  const taskB = await h.runtime.submitTask(other.agent, { subject: 'literal subject', description: 'literal task, no side effects' })
  const runB = await h.runtime.delegate({
    parent: other.agent, role: 'internal', taskId: taskB.id,
    label: 'literal label', prompt: 'literal task only', signal: new AbortController().signal,
  })
  await waitChild(runB.childId)
  const textA = h.childText(runA.childId), textB = h.childText(runB.childId)
  assert.ok(textA.includes(roleBody('recon')) && textA.includes(roleBody('internal')) === false, '父 A 的 child 只拿自己的角色')
  assert.ok(textB.includes(roleBody('internal')) && textB.includes(roleBody('recon')) === false, '父 B 的 child 只拿自己的角色')
  assert.deepEqual(
    h.runtime.bindings().map(item => [item.childSession, item.role]).sort(),
    [[runA.childId, 'recon'], [runB.childId, 'internal']].sort(),
    '绑定表按真实 child 会话各一条，不按父会话串用',
  )
  await runA.activation.dispose().catch(() => {})
  await runB.activation.dispose().catch(() => {})
})
