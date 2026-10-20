import test from 'node:test'
import assert from 'node:assert/strict'
import { withSsr, renderElement, makeTranslate } from './support/ssr-render.mjs'
import { getRuleEditorMeta } from '../../engine/rule-spec.mjs'

const t = makeTranslate()
const meta = getRuleEditorMeta()
const { RuleStepsPanel } = await withSsr([new URL('../../src/client/features/prompts/RuleSteps.tsx', import.meta.url).href])
const render = action => renderElement(RuleStepsPanel, {
  t, meta, rule: { id: 'surface', then: [action] }, engineMeta: { layerFieldPolicies: {}, layers: [] },
  fields: new Map(), expanded: new Map([['surface:rule:then:0', true]]), prefix: 'surface', fieldKey: 'rule',
  onDraft() {}, onChange() {},
})
const labels = html => [...html.matchAll(/aria-label="([^"]*)"/g)].map(match => match[1])

test('装配动作：真实新建种子的空 target 仍提供 sections / contexts 入口', () => {
  const seed = { ...structuredClone(meta.actions.find(action => action.kind === 'assembly').example), id: 'new' }
  assert.deepEqual(seed.target, {}, '引擎用无副作用的空目标作为新建种子')
  const controls = labels(render(seed))
  for (const target of ['sections', 'contexts']) {
    assert.ok(controls.includes(t('rules.surface.editTarget', { target: t(`rules.surface.${target}`) })))
  }
  assert.deepEqual(seed.target, {}, '展示入口不隐式开启过滤')
})
test('工具可见面：名单、发现工具、requireMatch 与首轮提示按声明渲染', () => {
  const action = { id: 'existing', kind: 'tool-visibility', allow: ['pwsh', 'read'], discovery: { tool: 'tool_search', key: 'toolNames' }, requireMatch: true, notice: true }
  const before = structuredClone(action)
  const controls = labels(render(action))
  for (const key of ['fixedTools', 'dynamic', 'discoveryTool', 'argumentKey']) assert.ok(controls.includes(t(`rules.surface.${key}`)), key)
  assert.ok(controls.includes(t('triggers.label.requireMatch')))
  assert.ok(controls.includes(t('triggers.label.notice')))
  for (const tag of ['pwsh', 'read']) assert.ok(controls.includes(t('rules.tokens.remove', { tag })))
  assert.deepEqual(action, before)
})

test('来源过滤：严格白名单和增量白名单按声明渲染，插件屏蔽独立在场', () => {
  for (const mode of ['sources', 'keepKinds']) {
    const action = { id: 'skills', kind: 'pre-step-filter', [mode]: ['user', 'skill-invocation'], blockPlugins: ['example'] }
    const html = render(action), controls = labels(html)
    assert.ok(controls.includes(t('rules.surface.sourceMode')))
    assert.ok(controls.includes(t('rules.surface.keptSources')))
    assert.ok(controls.includes(t('rules.surface.blockPlugins')))
    assert.ok(html.includes(t(mode === 'sources' ? 'rules.surface.strictSources' : 'rules.surface.incrementalSources')))
    for (const tag of ['user', 'skill-invocation', 'example']) assert.ok(controls.includes(t('rules.tokens.remove', { tag })))
  }
  const controls = labels(render({ id: 'unfiltered', kind: 'pre-step-filter', blockPlugins: [] }))
  assert.ok(!controls.includes(t('rules.surface.keptSources')), '未声明过滤时不制造白名单')
})

