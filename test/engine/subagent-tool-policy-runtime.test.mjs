import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const { apply: applyPolicyModule } = await import('../../engine/subagent-tool-policy.mjs')

const POLICY = {
  defaultProfile: 'base',
  ceiling: { allow: ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'web_search'], deny: ['dangerous_tool'] },
  profiles: [
    { id: 'base', name: '基础', allow: ['read', 'glob', 'grep'], deny: [], modelSelectable: false },
    { id: 'researcher', name: '研究', allow: ['read', 'glob', 'grep', 'web_search'], deny: ['write', 'bash'], modelSelectable: true },
    { id: 'coder', name: '编码', allow: ['read', 'write', 'edit', 'glob', 'grep', 'bash'], deny: [], modelSelectable: true },
  ],
  characterBindings: [
    { characterId: 'analyst', profile: 'researcher', modelSelectable: true },
  ],
  taskRules: [
    { id: 'research', name: '资料研究', pattern: '(research|调研|搜索|资料|文档)', profile: 'researcher', order: 100, modelSelectable: true },
  ],
  modelExpansion: { enabled: true, allow: ['web_search', 'bash'], maxAdditionalTools: 2, requireApproval: true },
}

/** 组装模块运行所需的 ctx + agent mock。 */
function makeHarness() {
  const starts = []
  const continuables = []
  const warns = []
  const registrations = []
  const ctx = {
    handler: undefined,
    on: (event, cb) => { ctx.handler = cb },
    get: (name) => (name === 'approval' ? { request: async () => 'allowed-once' } : undefined),
    subagents: {
      getProvider: () => ({ capabilities: { toolFilter: true, agentOptions: true } }),
      start: async (provider, request) => {
        starts.push({ provider, request })
        return { sessionId: 'child-1', settled: async () => ({ stopReason: 'completed', output: [] }), dispose: async () => {} }
      },
      startContinuable: async ({ provider, request }) => {
        continuables.push({ provider, request })
        return { sessionId: 'child-2' }
      },
    },
    tools: { schemas: () => ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'web_search'].map((name) => ({ name, description: name })) },
    logger: { warn: (m) => warns.push(String(m)) },
  }
  const agentCtx = {
    effect: (fn) => fn(),
    tools: { register: (tool) => { registrations.push(tool); return () => {} } },
  }
  const agent = { ctx: agentCtx, sessionId: 'main-1' }
  return { ctx, agent, starts, continuables, warns, registrations }
}

function writePolicy(policy) {
  const dir = mkdtempSync(join(tmpdir(), 'pt-sp-'))
  const file = join(dir, 'policy.yml')
  writeFileSync(file, JSON.stringify(policy), 'utf8')
  return pathToFileURL(file).href
}

function runOf() {
  return {
    name: 'subagent',
    callId: 'call-1',
    rootCallId: 'call-1',
    token: { symbol: 'tok' },
    agent: { session: { header: { cwd: process.cwd() } }, sessionId: 'main-1' },
    parent: undefined,
    signal: new AbortController().signal,
    arguments: {},
    deferContext: () => {},
    concludeTurn: () => {},
  }
}

test('Wave4：策略启用时在 agent/created 注册 subagent/subagent_fork shadow（遮蔽官方工具）', () => {
  const policyFile = writePolicy(POLICY)
  const { ctx, agent, registrations, warns } = makeHarness()
  applyPolicyModule(ctx, { policyFile })
  assert.equal(warns.length, 0, '策略加载无告警')
  ctx.handler({ agent })
  assert.equal(registrations.length, 2, '每个 agent 注册两个 shadow')
  const names = registrations.map((tool) => tool.name).sort()
  assert.deepEqual(names, ['subagent', 'subagent_fork'])
  const spawn = registrations.find((tool) => tool.name === 'subagent')
  assert.deepEqual(spawn.parameters.required, ['description', 'prompt'])
  assert.deepEqual(spawn.parameters.properties.tool_profile.enum, ['researcher', 'coder'])
  assert.deepEqual(spawn.parameters.properties.character_id.enum, ['analyst'])
  assert.equal(spawn.parameters.properties.additional_tools.maxItems, 2)
  assert.ok(spawn.parameters.properties.provider !== undefined, 'spawn 保留 provider')
  assert.ok(registrations.find((tool) => tool.name === 'subagent_fork').parameters.properties.provider === undefined, 'fork 不开放 provider')
})

test('Wave4：shadow execute 解析实例策略并冻结 toolFilter（扩权/deny/ceiling）', async () => {
  const policyFile = writePolicy(POLICY)
  const { ctx, agent, continuables, starts, registrations } = makeHarness()
  applyPolicyModule(ctx, { policyFile })
  ctx.handler({ agent })
  const tool = registrations.find((entry) => entry.name === 'subagent')
  assert.ok(tool, 'shadow 已注册')
  // coder 档 + 扩权 web_search（在 expansion.allow ∩ ceiling ∩ visible）→ 有效集含 web_search。
  const result = await tool.execute(
    { description: '实现功能', prompt: '请实现', tool_profile: 'coder', additional_tools: ['web_search'] },
    runOf(),
  )
  assert.equal(result.ok, true)
  assert.equal(continuables.length, 1, '默认 continuable 后台路径')
  const filter = continuables[0].request.toolFilter.allow
  assert.ok(filter.includes('web_search'), '扩权进入 effectiveAllow')
  assert.ok(filter.includes('bash'), 'coder 档含 bash')
  assert.ok(!filter.includes('dangerous_tool'), 'ceiling.deny 永不进入')
  const policySummary = result.value.policy
  assert.equal(policySummary.profile, 'coder')
  assert.deepEqual(policySummary.additionalTools, ['web_search'])
  // 显式拒绝扩权：additional_tools 不在 expansion.allow → 不进入。
  const denied = await tool.execute(
    { description: 'x', prompt: 'y', tool_profile: 'coder', additional_tools: ['edit'] },
    runOf(),
  )
  assert.equal(denied.ok, true)
  assert.deepEqual(denied.value.policy.additionalTools, [], 'edit 不在 expansion.allow，不进入扩权列表')
  // edit 仍可能经 coder 基础档进入有效集——断言的是"扩权"本身被拒绝，而非工具名。
  assert.ok(continuables[1].request.toolFilter.allow.includes('edit'), 'edit 来自 coder 基础 allow（非扩权）')
  // restrict_tools 收紧 + 主代理不可见但 ceiling 内工具仍可为子代理可见。
  const restricted = await tool.execute(
    { description: 'x', prompt: 'y', tool_profile: 'coder', restrict_tools: ['grep'] },
    runOf(),
  )
  assert.ok(!restricted.value.policy.effectiveTools.includes('grep'), 'restrict_tools 从有效集移除')
  // 显式 tool_profile + 自动分类优先；无匹配回落 default。
  const auto = await tool.execute({ description: '帮我调研一下资料', prompt: 'y' }, runOf())
  assert.equal(auto.value.policy.profile, 'researcher', '自动分类命中 research 规则')
  // 前台路径：run_in_background=false 走 ctx.subagents.start。
  const foreground = await tool.execute({ description: 'x', prompt: 'y', run_in_background: false }, runOf())
  assert.equal(foreground.ok, true)
  assert.equal(starts.length, 1, '前台走 start')
  assert.deepEqual(starts[0].request.toolFilter.allow, ['glob', 'grep', 'read'], 'default 档 base 工具集')
  assert.equal(foreground.value.policy.profile, 'base')
})
