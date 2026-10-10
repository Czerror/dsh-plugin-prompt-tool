/**
 * `tool-narrow` 动作的**真实 registry** 行为验收（`engine/actions/tool-narrow.mjs`）。
 *
 * 真值源是官方 `ToolRestriction` 契约（宿主 `packages/core/tools`）：restriction 只作用于
 * 该 scope **继承的全局工具**，scope 自己的注册仍然可见；被过滤掉的全局工具在
 * `tools.get(name, scope)` 里读作不存在。
 *
 * 这些断言必须跑在真实 `ToolRuntime` 上——mock 只能证明我们"调了 restrict"，证明不了
 * 上面那三条官方语义，而本动作的全部价值就在那三条上。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

import { prepareToolNarrow } from '../../engine/actions/tool-narrow.mjs'

const tool = (name) => ({
  name,
  description: `${name} tool`,
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  },
  async execute() { return { text: name } },
})

/** 真实 ToolRuntime + 一个 agent scope；返回按 scope 读工具名的观察口与一次装配的驱动。 */
async function liveNarrow(t, define) {
  const root = new Context()
  t.after(() => root.fiber.dispose())
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRuntime)
  const agent = { id: 'narrow-agent' }
  root.get('tools').register(tool('alpha'))
  root.get('tools').register(tool('beta'))
  await root.plugin({
    inject: ['tools'],
    apply(ctx) {
      const scope = createScope(ctx, agent)
      agent.ctx = scope.ctx
      scope.ctx.tools.register(tool('own_tool'))   // scope 自己注册：不受 restriction 影响
    },
  })
  const warnings = []
  const prepare = prepareToolNarrow(define, 'test')
  prepare(root, {
    warnOnce: (message) => warnings.push(message),
    collect: (disposer) => t.after(() => disposer()),
    on: (event, handler) => root.on(event, handler),
    take: () => true,
  })
  // cordis 的 `waterfall(...args)`：可选 this、事件名、监听器参数……、**最后一个参数是兜底**。
  const assembly = { sections: [], contexts: [], tools: [], variables: {} }
  const assemble = () => root.waterfall(root, 'system-prompt/assemble', assembly, { agent }, () => assembly)
  return {
    warnings,
    assemble,
    names: () => root.get('tools').schemas(agent).map(schema => schema.name).sort(),
    get: (name) => root.get('tools').get(name, agent),
  }
}

test('tool-narrow：restrict 收窄继承的全局工具，scope 自己的注册与已知外工具一并保留', async (t) => {
  const h = await liveNarrow(t, { allow: ['alpha'] })
  assert.deepEqual(h.names(), ['alpha', 'beta', 'own_tool'], '收窄前：两个全局 + 一个本层注册')
  await h.assemble()
  assert.deepEqual(h.names(), ['alpha', 'own_tool'],
    '被收窄的全局工具从目录消失；scope 本层注册的 own_tool 不受 restriction 影响')
  assert.equal(h.get('beta'), undefined, '被裁的全局工具在查找路径里读作不存在')
  assert.equal(h.get('alpha')?.name, 'alpha')
  assert.equal(h.get('own_tool')?.name, 'own_tool')
})

test('tool-narrow：未知名字被跳过并留痕，其余照常收窄', async (t) => {
  // 真值源：`restrict` 对未知全局名直接抛错（宿主 `index.ts` 的 unknown global tool），
  // 所以动作必须先按当前全局目录过滤——否则名字写错会让整次装配失败。
  const h = await liveNarrow(t, { allow: ['alpha', 'typo_tool'] })
  await h.assemble()
  assert.deepEqual(h.names(), ['alpha', 'own_tool'])
  assert.equal(h.warnings.length, 1, '未知名字告警一次')
  assert.match(h.warnings[0], /typo_tool/)
})

test('tool-narrow：名字全不存在时不收窄，且不改动目录', async (t) => {
  const h = await liveNarrow(t, { allow: ['nope_a', 'nope_b'] })
  await h.assemble()
  assert.deepEqual(h.names(), ['alpha', 'beta', 'own_tool'], '一个都不认识 → 目录保持原样')
  assert.ok(h.warnings.some(message => /nothing was narrowed/.test(message)), '整条声明一个都不认识时必须留痕')
})
