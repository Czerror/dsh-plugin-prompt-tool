import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { isolatedHome } from '../fixtures/host-harness.mjs'

const { home } = isolatedHome('pt-subagent-policy-')
const policy = await import('../../engine/subagent-tool-policy.mjs')

test('子代理策略文件入口在真实 registry 中注册一次，卸载与重挂释放旧贡献', async (t) => {
  const policyFile = join(home, 'policy.yml')
  const definition = {
    defaultProfile: 'read',
    ceiling: { allow: ['read'] },
    profiles: [{ id: 'read', name: '只读', allow: ['read'] }],
  }
  writeFileSync(policyFile, JSON.stringify(definition), 'utf8')
  const root = new Context()
  t.after(() => root.fiber.dispose())
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRuntime)
  const agent = { id: 'policy-agent' }
  const sibling = { id: 'sibling-agent' }
  let scope
  await root.plugin({
    inject: ['tools'],
    apply(ctx) {
      scope = createScope(ctx, agent)
      agent.ctx = scope.ctx
      sibling.ctx = createScope(ctx, sibling).ctx
    },
  })
  const agents = [agent, sibling]
  root.provide('agents', { list: () => agents })
  root.provide('subagents', {})
  const names = (target = agent) => root.get('tools').schemas(target).map(tool => tool.name)

  const mounted = await agent.ctx.plugin(policy, { policyFile: pathToFileURL(policyFile).href })
  assert.deepEqual(names(), ['subagent', 'subagent_fork'])
  assert.deepEqual(names(sibling), [], '兄弟 Agent 不获得本模块贡献')
  root.emit('tools/change')
  assert.deepEqual(names(), ['subagent', 'subagent_fork'], '同步变更通知不会重复安装')

  await mounted.dispose()
  root.emit('tools/change')
  assert.deepEqual(names(), [], '模块卸载时撤回工具，清理通知不得重新安装')

  const remounted = await agent.ctx.plugin(policy, { policyFile: pathToFileURL(policyFile).href })
  assert.deepEqual(names(), ['subagent', 'subagent_fork'], '原 Agent 可立即重挂，不残留同名工具')
  agents.splice(0, 1)
  await scope.dispose()
  root.emit(scopeTarget(agent, agent), 'agent/disposed', { agent })
  assert.deepEqual(names(), [], 'Agent 定向释放同样撤回工具')
  await remounted.dispose()
})

test('策略内联缺 assembly scope 拒绝；非法文件与文件缺失降级各自明确', () => {
  const warnings = []
  const ctx = { logger: { warn: message => warnings.push(message) } }
  const config = { policyFile: pathToFileURL(join(home, 'missing-policy.yml')).href }
  assert.doesNotThrow(() => policy.apply(ctx, config))
  assert.match(warnings[0], /policy file missing/)
  assert.equal(warnings.length, 1, '文件缺失只告警一次')
  const invalidFile = join(home, 'invalid-policy.yml')
  writeFileSync(invalidFile, '[]', 'utf8')
  assert.throws(() => policy.apply(ctx, { policyFile: pathToFileURL(invalidFile).href }), /policy.yml must be a YAML map/)
  assert.throws(() => policy.apply(ctx, { policy: {
    defaultProfile: 'read', ceiling: { allow: ['read'] }, profiles: [{ id: 'read', name: '只读', allow: ['read'] }],
  } }), /requires an assembly scope/)
})

test('策略执行保留扩权审批、deny 上限和 provider 拒绝', async (t) => {
  const definition = {
    defaultProfile: 'read', ceiling: { allow: ['read', 'write', 'blocked'], deny: ['blocked'] },
    profiles: [{ id: 'read', name: '只读', allow: ['read', 'blocked'] }],
    modelExpansion: { enabled: true, allow: ['write'], maxAdditionalTools: 1, requireApproval: true },
  }
  const policyFile = join(home, 'execution-policy.yml')
  writeFileSync(policyFile, JSON.stringify(definition), 'utf8')
  const root = new Context()
  t.after(() => root.fiber.dispose())
  const registered = new Map()
  const requests = []
  const approvals = []
  const provider = { capabilities: { toolFilter: true } }
  root.provide('tools', {
    schemas: () => ['read', 'write', 'blocked', 'outside'].map(name => ({ name })),
    register: tool => { registered.set(tool.name, tool); return () => registered.delete(tool.name) },
  })
  root.provide('approval', { request: async request => { approvals.push(request); return 'allowed-once' } })
  root.provide('subagents', {
    getProvider: () => provider,
    start: async (_provider, request) => {
      requests.push(request)
      return { id: 'child', result: Promise.resolve({ stopReason: 'completed', output: 'done' }), dispose() {} }
    },
  })
  const agent = { id: 'policy-execution' }
  const scope = createScope(root, agent)
  agent.ctx = scope.ctx
  root.provide('agents', { list: () => [agent] })
  const mounted = await agent.ctx.plugin(policy, { policyFile: pathToFileURL(policyFile).href })
  const tool = registered.get('subagent')
  const args = { description: '任务', prompt: '执行', run_in_background: false, additional_tools: ['write'] }
  const run = { agent, signal: new AbortController().signal, callId: 'call' }
  const result = await tool.execute(args, run)
  assert.deepEqual(requests[0].toolFilter, { allow: ['read', 'write'] })
  assert.equal(approvals.length, 1)
  assert.deepEqual(result.policy.effectiveTools, ['read', 'write'])
  await assert.rejects(tool.execute({ ...args, additional_tools: ['outside'] }, run), /unauthorized tools/)
  await assert.rejects(tool.execute({ ...args, additional_tools: ['write', 'write'] }, run), /maxAdditionalTools/)
  provider.capabilities.toolFilter = false
  await assert.rejects(tool.execute({ ...args, additional_tools: undefined }, run), /does not support per-child toolFilter/)
  assert.equal(requests.length, 1, '拒绝路径不得启动子代理')
  await mounted.dispose()
  assert.equal(registered.size, 0)
})
