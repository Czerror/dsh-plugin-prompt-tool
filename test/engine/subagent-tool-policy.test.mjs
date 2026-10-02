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

test('子代理策略工具在真实 registry 中注册一次，模块卸载与重挂均释放旧贡献', async (t) => {
  const policyFile = join(home, 'policy.yml')
  writeFileSync(policyFile, JSON.stringify({
    defaultProfile: 'read',
    ceiling: { allow: ['read'] },
    profiles: [{ id: 'read', name: '只读', allow: ['read'] }],
  }), 'utf8')
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
  const config = { policyFile: pathToFileURL(policyFile).href }
  const names = (target = agent) => root.get('tools').schemas(target).map(tool => tool.name)

  const mounted = await agent.ctx.plugin(policy, config)
  assert.deepEqual(names(), ['subagent', 'subagent_fork'])
  assert.deepEqual(names(sibling), [], '兄弟 Agent 不获得本模块贡献')
  root.emit('tools/change')
  assert.deepEqual(names(), ['subagent', 'subagent_fork'], '同步变更通知不会重复安装')

  await mounted.dispose()
  root.emit('tools/change')
  assert.deepEqual(names(), [], '模块卸载时撤回工具，清理通知不得重新安装')

  const remounted = await agent.ctx.plugin(policy, config)
  assert.deepEqual(names(), ['subagent', 'subagent_fork'], '原 Agent 可立即重挂，不残留同名工具')
  agents.splice(0, 1)
  await scope.dispose()
  root.emit(scopeTarget(agent, agent), 'agent/disposed', { agent })
  assert.deepEqual(names(), [], 'Agent 定向释放同样撤回工具')
  await remounted.dispose()
})
