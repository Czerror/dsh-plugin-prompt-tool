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
test('工具可见面：名单、发现工具与 requireMatch 按声明渲染', () => {
  const action = { id: 'existing', kind: 'tool-visibility', allow: ['pwsh', 'read'], discovery: { kind: 'tools', tool: 'tool_search', key: 'toolNames' }, requireMatch: true }
  const before = structuredClone(action)
  const controls = labels(render(action))
  for (const key of ['fixedTools', 'dynamic', 'discoveryTool', 'argumentKey']) assert.ok(controls.includes(t(`rules.surface.${key}`)), key)
  assert.ok(controls.includes(t('triggers.label.requireMatch')))
  for (const tag of ['pwsh', 'read']) assert.ok(controls.includes(t('rules.tokens.remove', { tag })))
  assert.deepEqual(action, before)
})

test('模型流动作：模式与正文沿普通动作编辑面渲染，不修改作者声明', () => {
  const action = { id: 'output', kind: 'stream-output', mode: 'replace', text: '替代输出' }
  const before = structuredClone(action)
  const html = render(action), controls = labels(html)
  assert.ok(controls.includes(t('triggers.label.mode')))
  assert.ok(controls.includes(t('triggers.label.text')))
  assert.ok(html.includes('替代输出'))
  assert.deepEqual(action, before)
})

test('工具目录提示：普通注入表单展示同规则动作引用与作者模板', () => {
  const action = { id: 'notice', kind: 'inject-text', config: {
    layer: 'pre-step', strategy: 'placeholder', fill: 'tool-catalog',
    text: '常驻：{{RESIDENT_TOOLS}}；发现：{{DISCOVERY_TOOL}}', params: { action: 'narrow-tools' },
  } }
  const before = structuredClone(action), html = render(action)
  assert.ok(html.includes('narrow-tools'), '动作引用沿现有 params 编辑面展示')
  assert.ok(html.includes('{{RESIDENT_TOOLS}}'))
  assert.ok(html.includes('{{DISCOVERY_TOOL}}'))
  assert.deepEqual(action, before, '展示不把工具名单复制到提示配置')
})

test('文本条件：可选长度入口保持缺省，已声明的零边界按数字渲染', async () => {
  const { RuleConditionFields } = await withSsr([new URL('../../src/client/features/prompts/RuleFields.tsx', import.meta.url).href])
  const renderCondition = value => renderElement(RuleConditionFields, {
    t, meta, value, fields: new Map(), expanded: new Map(), prefix: 'text', fieldKey: 'rule:if',
    creation: { active: '', select() {} }, onDraft() {}, onChange() {},
  })
  const condition = { text: { subject: 'userMessage', minChars: 0, maxChars: 120 } }
  const before = structuredClone(condition), html = renderCondition(condition)
  assert.ok(html.includes('value="0"'))
  assert.ok(html.includes('value="120"'))
  for (const key of ['minChars', 'maxChars']) assert.ok(labels(html).includes(t(`triggers.label.${key}`)))
  assert.deepEqual(condition, before)
  const withoutLength = { text: { subject: 'userMessage', keys: ['重构'] } }
  renderCondition(withoutLength)
  assert.deepEqual(withoutLength, { text: { subject: 'userMessage', keys: ['重构'] } }, '显示可选入口不补入示例长度')
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

