import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'

const { apply: applyPolicyModule } = await import('../../engine/subagent-tool-policy.mjs')

const POLICY = {
  defaultProfile: 'base',
  ceiling: { allow: ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'web_search'], deny: [] },
  profiles: [
    { id: 'base', name: '基础', allow: ['read', 'glob', 'grep'], deny: [], modelSelectable: false },
    { id: 'researcher', name: '研究', allow: ['read', 'glob', 'grep', 'web_search'], deny: [], modelSelectable: true },
    { id: 'coder', name: '编码', allow: ['read', 'write', 'edit', 'glob', 'grep', 'bash'], deny: [], modelSelectable: true },
  ],
  characterBindings: [{ characterId: 'analyst', profile: 'researcher', modelSelectable: true }],
  taskRules: [{ id: 'research', name: '研究', pattern: '调研', profile: 'researcher', order: 100, modelSelectable: true }],
  modelExpansion: { enabled: true, allow: ['web_search', 'bash'], maxAdditionalTools: 2, requireApproval: true },
}

function writePolicy() {
  const file = join(mkdtempSync(join(tmpdir(), 'pt-sp-')), 'policy.yml')
  writeFileSync(file, JSON.stringify(POLICY), 'utf8')
  return pathToFileURL(file).href
}

async function harness({ approval = true } = {}) {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRuntime)
  const presetKey = {}
  const preset = createScope(root, presetKey)
  const handlers = new Map()
  const starts = []
  const continuables = []
  const providers = {
    spawn: { name: 'spawn', capabilities: { toolFilter: true, agentOptions: true, depthLimit: true }, inheritsParentContext: false, prepareContinuable: async () => ({}) },
    fork: { name: 'fork', capabilities: { toolFilter: true, agentOptions: true, depthLimit: true }, inheritsParentContext: true, prepareContinuable: async () => ({}) },
  }
  const ctx = preset.ctx
  const agents = { list: () => [] }
  const subagents = {
    getProvider: (name) => providers[name],
    startContinuable: async (spec) => { continuables.push(spec); return { childId: `child-${spec.provider}`, messageId: 'message-1' } },
    start: async (provider, request) => {
      starts.push({ provider, request })
      return { id: `child-${provider}`, localAgent: undefined, result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }] }), dispose: async () => {} }
    },
  }
  Object.defineProperties(ctx, {
    agents: { configurable: true, value: agents },
    subagents: { configurable: true, value: subagents },
    get: { configurable: true, value: (name) => name === 'approval' && approval ? { request: async () => 'allowed-once' } : name === 'llm' ? { resolveCallConfig: async () => ({}) } : undefined },
    on: { configurable: true, value: (event, cb) => { handlers.set(event, cb); return () => {} } },
  })
  applyPolicyModule(ctx, { policyFile: writePolicy(), maxDepth: 3 })
  const agentScope = createScope(root, {}, { parent: presetKey })
  const agentCtx = await new Promise((resolve) => {
    agentScope.ctx.inject(['tools'], (runtimeCtx) => { resolve(runtimeCtx) })
  })
  const agent = { id: 'parent', options: { provider: 'deepseek', model: 'model' }, ctx: agentCtx, session: { header: { cwd: process.cwd() } } }
  for (const name of ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'web_search']) {
    root.tools.register({ name, description: name, parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object', additionalProperties: true }, render: () => [] }, execute: async () => ({}) })
  }
  handlers.get('agent/created')({ agent })
  return { root, ctx, tools: root.tools, agent, starts, continuables, handlers }
}

function runOf(agent) {
  return { name: 'subagent', callId: 'call-1', rootCallId: 'call-1', token: {}, agent, signal: new AbortController().signal, arguments: {}, deferContext() {}, concludeTurn() {} }
}

test('Wave4：仅为当前 preset generation 的 Agent 注册两个 shadow，dispose 时撤销', async () => {
  const h = await harness()
  assert.deepEqual(h.tools.schemas(scopeOf(h.agent.ctx)).map((item) => item.name).filter((name) => name.startsWith('subagent')).sort(), ['subagent', 'subagent_fork'])
  const foreign = createScope(h.root, {}).ctx
  const foreignAgent = { id: 'foreign', ctx: foreign }
  h.handlers.get('agent/created')({ agent: foreignAgent })
  assert.equal(h.tools.schemas(scopeOf(foreignAgent.ctx)).some((item) => item.name === 'subagent'), false)
  await h.root.fiber.dispose()
})

test('Wave4：spawn/fork 使用官方 foreground/continuable 契约并冻结不同 toolFilter', async () => {
  const h = await harness()
  const spawn = h.tools.get('subagent', scopeOf(h.agent.ctx))
  const fork = h.tools.get('subagent_fork', scopeOf(h.agent.ctx))
  const run = runOf(h.agent)
  const bg = await fork.execute({ description: '研究', prompt: '调研资料', character_id: 'analyst' }, run)
  assert.equal(h.continuables[0].provider, 'fork')
  assert.equal(h.continuables[0].signal, run.signal)
  assert.equal(bg.subagentId, 'child-fork')
  assert.deepEqual(h.continuables[0].request.toolFilter.allow, ['glob', 'grep', 'read', 'web_search'])
  const fg = await spawn.execute({ description: '编码', prompt: '实现', tool_profile: 'coder', run_in_background: false }, run)
  assert.equal(h.starts[0].provider, 'spawn')
  assert.equal(fg.runId, 'child-spawn')
  assert.ok(h.starts[0].request.toolFilter.allow.includes('bash'))
})

test('Wave4：真实 ToolRuntime 在 body 前拒绝隐藏 selector 和超量扩权', async () => {
  const h = await harness()
  const hidden = await h.tools.execute({ callId: 'bad-1', name: 'subagent', agent: h.agent, arguments: { description: 'x', prompt: 'y', tool_profile: 'base' }, signal: new AbortController().signal })
  assert.equal(hidden.isError, true)
  const tooMany = await h.tools.execute({ callId: 'bad-2', name: 'subagent', agent: h.agent, arguments: { description: 'x', prompt: 'y', additional_tools: ['web_search', 'bash', 'read'] }, signal: new AbortController().signal })
  assert.equal(tooMany.isError, true)
  assert.equal(h.continuables.length, 0)
})

test('Wave4：扩权批准在创建前执行且无 approval 服务 fail closed', async () => {
  const h = await harness({ approval: false })
  const result = await h.tools.execute({ callId: 'approval', name: 'subagent', agent: h.agent, arguments: { description: 'x', prompt: 'y', additional_tools: ['web_search'] }, signal: new AbortController().signal })
  assert.equal(result.isError, true)
  assert.equal(h.continuables.length, 0)
})
