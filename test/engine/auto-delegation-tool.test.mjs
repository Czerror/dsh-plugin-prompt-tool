/**
 * 票 08 / P0-1：自动派工的产品入口（auto_delegate_plan）。
 *
 * 接缝 A：真实官方 Team（agentTeams）+ 真实 SubagentRuntime（spawn）+ 插件真实装配
 *          createAgentAssembly + 可控 adapter，工具经宿主 root.tools.execute 真实调用；
 *          断言落在真实子会话首请求、官方任务归属/状态与工具返回值上，
 *          「注册成功」「已提交」和规则命中都不算验收。
 *
 * 夹具只装配本入口需要的规则（角色正文与协议仍用包内真实资产逐字取用）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { createAgentAssembly } from '../../src/runtime/agent-assembly.ts'
import { createRoleDelegation, ROLE_MODULE_ID } from '../../src/runtime/role-delegation.ts'
import { createAutoDelegation, AUTO_DELEGATION_RULE_ID } from '../../src/runtime/auto-delegation.ts'
import { AUTO_DELEGATION_TOOL_NAME, registerAutoDelegationTools } from '../../src/runtime/auto-delegation-tools.ts'
import { setModuleEnabled } from '../../src/host/config-store.ts'
import { parse as parseYaml } from 'yaml'

const PACKAGE_MODULE = new URL('../../modules/redteam/', import.meta.url)
const PACKAGE_DIR = fileURLToPath(PACKAGE_MODULE)
const asset = (...parts) => readFileSync(new URL(parts.join('/'), PACKAGE_MODULE), 'utf8').trimEnd()
const roleBody = role => asset('assets', 'roles', role + '.md')
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

/** 官方 Team 包不在本插件依赖树里：先按普通说明符解析，再回退固定的 rc.2 源码构建；都不行就明确报缺失。 */
async function loadTeam() {
  try {
    return (await import('@deepseek-ai/dsh-agent-team')).default
  } catch (primary) {
    const marker = new URL('../../.scratch/harness/local.json', import.meta.url)
    const sourceRoot = existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')).sourceRoot : undefined
    const entry = typeof sourceRoot === 'string' ? join(sourceRoot, 'packages', 'team', 'agent-team', 'lib', 'index.js') : undefined
    if (entry === undefined || !existsSync(entry)) {
      throw new Error('官方 Team 包不可用：package.json 的 devDependencies 应声明 @deepseek-ai/dsh-agent-team@0.2.2-rc.2；也可用 .scratch/harness/local.json 指向固定 rc.2 源码构建；原因：' + String(primary?.message ?? primary))
    }
    return (await import(pathToFileURL(entry).href)).default
  }
}
const TeamService = await loadTeam()

const ROLE_FORM = {
  plan: { audience: 'main', commons: ['env', 'bind'] },
  recon: { audience: 'subagent', commons: ['bind', 'handoff'] },
  'vuln-scan': { audience: 'subagent', commons: ['bind', 'handoff'] },
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
/** 包内真实定义的自动派工规则（默认 enabled=false），夹具只改开关值。 */
const packageAutoRule = () => {
  const rule = parseYaml(readFileSync(join(PACKAGE_DIR, 'module.yml'), 'utf8')).rules.find(item => item.id === AUTO_DELEGATION_RULE_ID)
  assert.ok(rule, '包内必须有自动派工规则')
  return JSON.parse(JSON.stringify(rule))
}

/** 可控 adapter：记录真实请求；可挂住子会话首请求，用于观察存活的真实子代理。 */
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
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'TOOL-FIXTURE-ANSWER' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
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

const SIX = ['目标范围', '输入', '已知事实', '预期产出', '验收依据', '实际可用工具']
const brief = tag => ({
  objective: 'OBJECTIVE-' + tag, inputs: 'INPUTS-' + tag, known: 'KNOWN-' + tag,
  expected: 'EXPECTED-' + tag, acceptance: 'ACCEPTANCE-' + tag, tools: 'TOOLS-' + tag,
})
const subtask = (key, role, extra = {}) => ({ key, role, subject: 'literal subject ' + key, brief: brief(key), ...extra })

async function mount(t, { auto = true, roles = ['recon'], teamEnabled = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'pt-auto-tool-'))
  const moduleRoot = join(home, 'modules'), moduleDir = join(moduleRoot, ROLE_MODULE_ID)
  cpSync(PACKAGE_MODULE, moduleDir, { recursive: true })
  const ids = [...roles, AUTO_DELEGATION_RULE_ID, 'protocol-redteam']
  writeFileSync(join(moduleDir, 'module.yml'), JSON.stringify({
    id: ROLE_MODULE_ID, name: 'auto delegation tool fixture', version: '1.0.0', engineCompat: '>=0.4.2',
    modules: ['rule-engine'], variables: { role: '' },
    configOrder: Object.fromEntries(ids.map((id, index) => [id, 70 + index * 10])),
    rules: [...fixtureRoles(roles), { ...packageAutoRule(), enabled: auto }, protocolRule()],
  }))
  setModuleEnabled(moduleRoot, ROLE_MODULE_ID, true)

  const root = new Context()
  const capture = new Capture()
  const warnings = []
  const warn = message => warnings.push(String(message))
  const runtime = createRoleDelegation(root, { moduleRoot, warn })
  const autoDelegation = createAutoDelegation({ delegation: runtime, moduleRoot, warn })
  const assembly = createAgentAssembly(root, {
    moduleRoot, enabledModules: () => [ROLE_MODULE_ID],
    runtimeVariables: (id, sessionId) => runtime.roleFactsOf(id, sessionId), warn,
  })
  const off = root.on('agent/created', async ({ agent }) => {
    autoDelegation.assignRoot(agent)
    await runtime.bindCreated(agent)
  })
  let unregister = () => {}
  const handles = []
  t.after(async () => {
    off()
    unregister()
    await assembly.dispose().catch(() => {})
    autoDelegation.dispose()
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
  // 产品入口：与 src/index.ts 同一注册函数，工具经宿主 tools 服务真实执行。
  unregister = registerAutoDelegationTools(root, { runtime: autoDelegation })
  await sleep(0)

  const handle = await root.agents.create({ sessionId: 'tool-parent', agentOptions: { provider: 'local', model: 'tool-fixture' }, meta: { cwd: home } })
  handles.push(handle)
  capture.parentId = String(handle.agent.id)
  if (teamEnabled) await root.agentTeams.setEnabled(handle.agent, true)
  await assembly.settled()

  let calls = 0
  const call = async (args, agent = handle.agent) => (await root.tools.execute({
    calls: [{ type: 'tool-call', id: 'call-' + ++calls, name: AUTO_DELEGATION_TOOL_NAME, arguments: JSON.stringify(args) }],
    agent, signal: new AbortController().signal,
  })).results[0].result
  const tasks = () => root.agentTeams.listTasks(handle.agent)
  const childText = sessionId => capture.requests.filter(request => request.sessionId === sessionId).map(requestText).join('\n===\n')
  return { home, moduleRoot, moduleDir, root, capture, runtime, auto: autoDelegation, assembly, warnings, parent: handle.agent, handle, call, tasks, childText }
}

test('规则关闭：真实根调入口被明确拒绝，零官方登记零真实启动', { timeout: 60000 }, async t => {
  const h = await mount(t, { auto: false, roles: ['recon'] })
  const result = await h.call({ planId: 'tool-plan-off', subtasks: [subtask('recon', 'recon')] })
  assert.equal(result.isError, true, '规则关闭时工具必须拒绝，而不是静默登记')
  const text = JSON.stringify(result)
  assert.ok(text.includes('AUTO_DELEGATION_DISABLED'), '拒绝里带稳定错误码：' + text)
  assert.equal(h.tasks().length, 0, '关闭时不登记官方任务')
  assert.equal(h.capture.children.length, 0, '关闭时不启动任何真实子代理')
})

test('规则开启：真实根调入口一次提交计划，真实子会话启动、官方任务 completed 且 owner 为子会话，返回带 runId', { timeout: 120000 }, async t => {
  const h = await mount(t, { roles: ['recon', 'vuln-scan'] })
  const result = await h.call({
    planId: 'tool-plan',
    subtasks: [subtask('recon', 'recon'), subtask('scan', 'vuln-scan', { blockedBy: ['recon'] })],
  })
  assert.equal(result.isError, false, JSON.stringify(result))
  const value = result.value
  assert.equal(value.planId, 'tool-plan', '计划标识随真实结果返回')
  assert.equal(value.completed, true, '两项都按真实运行收口')
  assert.equal(value.cancelled, false)
  assert.deepEqual(value.outcomes.map(item => [item.key, item.state]), [['recon', 'completed'], ['scan', 'completed']])

  const official = h.tasks()
  assert.equal(official.length, 2, '官方任务板有两项任务')
  for (const outcome of value.outcomes) {
    assert.equal(typeof outcome.taskId, 'string', '每项带官方任务 id')
    assert.equal(typeof outcome.childSession, 'string', '每项带真实子会话 id')
    assert.equal(typeof outcome.runId, 'string', '每项带真实运行身份')
    assert.equal(outcome.taskStatus, 'completed', '任务终态来自官方视图')
    const task = official.find(item => item.id === outcome.taskId)
    assert.equal(task.status, 'completed', '官方任务 completed：' + outcome.key)
    assert.equal(task.ownerId, outcome.childSession, '任务归属就是该次真实子会话：' + outcome.key)
    assert.equal(outcome.revision, task.revision, '汇总版本与官方一致：' + outcome.key)
  }
  assert.equal(official.find(item => item.id === value.outcomes[1].taskId).blockedBy[0], value.outcomes[0].taskId,
    '官方依赖关系由 blockedBy 指向真实上游任务')

  // 入口真的驱到了真实子代理：首请求含六段任务书与执行角色正文。
  const firstText = h.childText(value.outcomes[0].childSession)
  for (const label of SIX) assert.ok(firstText.includes('## ' + label), '任务书含段落：' + label)
  assert.ok(firstText.includes('OBJECTIVE-recon') && firstText.includes('TOOLS-recon'), '任务书字段来自这次调用')
  assert.ok(firstText.includes(roleBody('recon')), '执行角色正文仍由 redteam 规则投递')
  assert.ok(firstText.includes(protocolBody('redteam-child')), '子代理拿红队子协议')
  assert.equal(h.capture.children.length, 2, '两次真实启动，逐个对应两项任务')
})

test('只给真实根：子代理调用入口被明确拒绝，不登记任务也不启动成员', { timeout: 90000 }, async t => {
  const h = await mount(t, { roles: ['recon'] })
  h.capture.holdAll = true
  const plain = await h.root.subagents.startActivation({
    provider: 'spawn', label: 'plain child', prompt: [{ type: 'text', text: 'literal only' }],
    parent: h.parent, signal: new AbortController().signal, delivery: 'caller',
  })
  await waitFor(() => h.capture.children.includes(String(plain.childId)), '真实子会话已启动')
  const child = h.root.agents.get(plain.childId)
  assert.ok(child, '子代理身份可观察')

  const result = await h.call({ planId: 'tool-plan-child', subtasks: [subtask('recon', 'recon')] }, child)
  assert.equal(result.isError, true, '子代理不能发起自动派工')
  assert.ok(JSON.stringify(result).includes('AUTO_DELEGATION_ROOT_ONLY'), '拒绝理由落在根会话独占上')
  assert.equal(h.tasks().length, 0, '被拒的调用不登记任何官方任务')
  assert.equal(h.capture.children.length, 1, '被拒的调用不启动新的成员')
  h.capture.releaseAll()
  await plain.result.catch(() => {})
  await plain.dispose().catch(() => {})
})
