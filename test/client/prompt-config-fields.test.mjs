/**
 * 层专属参数字段的渲染守卫：每层的字段集逐项固定，tool-pipeline 不再是结构化参数字段层。
 *
 * 真值源：`engine/layers.mjs` 实际消费的 params（runtime-context.contextName、
 * agent-request.patch/replace、llm-stream.mode、subagent-end.action）。期望值按层手写，
 * 不由被测实现派生。tool-pipeline 已无注入通道（`engine/schema.mjs` 的 injectionLayers
 * 是八层），它的 params 只剩离线迁移输入，UI 不再为它开工具链裁决字段。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeTranslate, renderElement, withSsr } from './support/ssr-render.mjs'

const t = makeTranslate()
const { StrategyParamsFields } = await withSsr([
  new URL('../../src/client/features/prompts/PromptConfigFields.tsx', import.meta.url).href,
])

// FormField 的名称与 ParamToggle 的标签在 SSR 里同形（configFieldLabel 类），
// 因此一个正则同时覆盖两类字段。
const fieldLabels = (html) => [...html.matchAll(/class="configFieldLabel">([^<]*)</g)].map((match) => match[1])
const render = (layer, params) => fieldLabels(renderElement(StrategyParamsFields, { t, strategy: 'static', layer, params, onPatch: () => {} }))

test('层专属参数字段集逐项固定：tool-pipeline 不再渲染工具链裁决字段', () => {
  assert.deepEqual(render('runtime-context', { contextName: 'ctx' }), [t('strategyParam.contextName.label')])
  assert.deepEqual(render('agent-request', { patch: { model: 'deepseek-chat' }, replace: false }), [
    t('strategyParam.request.provider'), t('strategyParam.request.model'), t('strategyParam.request.reasoningEffort'),
    t('strategyParam.request.temperature'), t('strategyParam.request.maxTokens'), t('strategyParam.request.stop'),
    t('strategyParam.replace.label'),
  ])
  assert.deepEqual(render('llm-stream', { mode: 'replace' }), [t('strategyParam.mode.label')])
  assert.deepEqual(render('subagent-end', { action: 'inject-main' }), [t('strategyParam.endAction.label')])

  // 旧 tool-pipeline 形态的参数不再有结构化入口，但仍按原值出现在高级 JSON 里（不吞旧资产）。
  const legacy = { toolNames: 'bash', preDecision: 'deny', denyReason: 'blocked', postAction: 'replace' }
  const html = renderElement(StrategyParamsFields, { t, strategy: 'static', layer: 'tool-pipeline', params: legacy, onPatch: () => {} })
  assert.deepEqual(fieldLabels(html), [t('field.json.advanced')])
  for (const key of Object.keys(legacy)) assert.match(html, new RegExp(`&quot;${key}&quot;`))
})
