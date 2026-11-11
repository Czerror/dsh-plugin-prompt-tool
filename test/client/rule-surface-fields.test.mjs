import test from 'node:test'
import assert from 'node:assert/strict'
import { withSsr, renderElement, makeTranslate } from './support/ssr-render.mjs'
import { getRuleEditorMeta } from '../../engine/rule-spec.mjs'
import { createWorkspaceDrafts } from '../../src/client/data/workspace-drafts.ts'
import { getRulesDraft } from '../../src/client/data/rule-drafts.ts'

const t = makeTranslate()
const meta = getRuleEditorMeta()
const { RuleStepsPanel, RuleCard } = await withSsr([
  new URL('../../src/client/features/prompts/RuleSteps.tsx', import.meta.url).href,
  new URL('../../src/client/features/prompts/RuleCard.tsx', import.meta.url).href,
])
const render = action => renderElement(RuleStepsPanel, {
  t, meta, rule: { id: 'surface', then: [action] }, engineMeta: { layerFieldPolicies: {}, layers: [] },
  fields: new Map(), expanded: new Map([['surface:rule:then:0', true]]), prefix: 'surface', fieldKey: 'rule',
  onDraft() {}, onChange() {},
})
const labels = html => [...html.matchAll(/aria-label="([^"]*)"/g)].map(match => match[1])

test('人设动作：普通规则卡接入受控人设字段，保留空串与 false', () => {
  const action = { id: 'persona', kind: 'persona', prefix: '', complete: false }
  const before = structuredClone(action), html = render(action)
  assert.ok(html.includes('data-persona-action="persona"'))
  for (const key of ['audience', 'prefix.aria', 'suffix.aria', 'complete.label', 'runtimeContext.label']) {
    assert.ok(labels(html).includes(t(`persona.${key}`)))
  }
  assert.deepEqual(action, before, '渲染不补入省略字段')
})

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

test('装配替句沿普通规则编辑面展示原文、替文与局部开关', () => {
  for (const target of ['sections', 'contexts']) {
    const action = { id: 'policy', kind: 'assembly', target: { [target]: { replace: [
      { name: 'sandbox:policy', match: 'KNOWN ORIGINAL', text: 'EDITED TEXT' },
    ] } } }
    const before = structuredClone(action), html = render(action)
    for (const key of ['matchEnabled', 'entryMatch']) assert.ok(labels(html).includes(t(`rules.surface.${key}`)))
    assert.ok(html.includes('KNOWN ORIGINAL'))
    assert.ok(html.includes('EDITED TEXT'))
    assert.deepEqual(action, before, '展示沿原规则草稿，不改变匹配内容')
  }
})

test('工具说明配置沿普通装配卡显示工具、可选参数与必填匹配原文', () => {
  const action = { id: 'description', kind: 'assembly', target: { toolDescriptions: [
    { name: 'pwsh', parameter: 'sandbox_permissions', match: 'KNOWN TOOL NOTICE', text: '' },
  ] } }
  const before = structuredClone(action), html = render(action), controls = labels(html)
  assert.ok(controls.includes(t('rules.surface.editTarget', { target: t('rules.surface.toolDescriptions') })))
  for (const key of ['entryName', 'parameter', 'entryMatch', 'entryText']) assert.ok(controls.includes(t(`rules.surface.${key}`)), key)
  for (const text of ['pwsh', 'sandbox_permissions', 'KNOWN TOOL NOTICE']) assert.ok(html.includes(text), text)
  assert.deepEqual(action, before, '原规则草稿保留空替文，不补造工具或参数')
})

test('技能说明配置沿真实规则卡显示精确匹配与空替文，不能编辑正文或参数路径', () => {
  const action = { id: 'skill-description', kind: 'assembly', target: { skillDescriptions: [
    { name: 'dsh-badge', match: 'KNOWN SKILL DESCRIPTION', text: '' },
  ] } }
  const before = structuredClone(action), html = render(action), controls = labels(html)
  const skillLabel = t('rules.surface.editTarget', { target: t('rules.surface.skillDescriptions') })
  assert.ok(controls.includes(skillLabel))
  for (const key of ['entryName', 'entryMatch', 'entryText']) assert.ok(controls.includes(t(`rules.surface.${key}`)), key)
  assert.equal(controls.includes(t('rules.surface.parameter')), false)
  assert.equal(controls.includes(t('rules.surface.matchEnabled')), false, '匹配原文必填，没有关闭匹配的伪入口')
  assert.ok(html.includes('dsh-badge'))
  assert.ok(html.includes('KNOWN SKILL DESCRIPTION'))
  assert.deepEqual(action, before, '展示不改技能身份、空替文或保存草稿')
  const seed = { id: 'empty', kind: 'assembly', target: {} }
  assert.ok(labels(render(seed)).includes(skillLabel), '新建装配也提供技能说明入口')
  assert.deepEqual(seed.target, {})
})

test('说明规则卡显示当前保存版本的工具与技能缺目标原因，旧观测不显示假成功', () => {
  for (const [field, channel, name] of [['toolDescriptions', 'tool:descriptions', 'run_code'], ['skillDescriptions', 'skill:descriptions', 'dsh-badge']]) {
    const rule = { id: 'metadata', enabled: true, then: [{ id: 'description', kind: 'assembly', target: {
      [field]: [{ name, match: 'KNOWN ORIGINAL', text: 'EDITED DESCRIPTION' }],
    } }] }
    const before = structuredClone(rule)
    const draft = getRulesDraft(createWorkspaceDrafts(), 'metadata-module')
    Object.assign(draft, { loaded: true, saved: [structuredClone(rule)], revisions: { rules: { metadata: 'R1' }, settings: 'S1', variables: 'V1' } })
    const entry = { key: 'metadata', previousId: 'metadata', value: rule }
    const renderCard = diagnostics => renderElement(RuleCard, { t, entry, draft, editor: {}, meta: { layers: [] }, expanded: true,
      onToggle() {}, onDuplicate() {}, expandedRows: new Map(), moduleId: 'metadata-module', diagnostics })
    const reason = `assembly.${field} ${name} target missing; skipped`
    const observation = { moduleId: 'metadata-module', ruleId: 'metadata', actionId: 'description', agentId: 'agent-a', channel,
      hit: 0, miss: 0, unavailable: 1, error: 0, identityOutcome: 'target-mismatch', definitionRevision: 'R1:S1', reason }
    const unavailable = renderCard([observation])
    assert.ok(unavailable.includes(t('rules.identity.unavailable')), `${field}卡片显示实际不可用`)
    assert.ok(unavailable.includes(reason), `${field}卡片显示缺目标原因`)
    const staleReason = 'STALE OBSERVATION REASON'
    const stale = renderCard([{ ...observation, definitionRevision: 'OLD', identityOutcome: 'matched', reason: staleReason }])
    assert.ok(stale.includes(t('rules.identity.unverified')))
    assert.equal(stale.includes(t('rules.identity.matched')), false, '旧版本成功不冒充当前状态')
    assert.equal(stale.includes(staleReason), false, '旧版本原因也不串入当前定义')
    const matched = renderCard([{ ...observation, identityOutcome: 'matched', reason: undefined }])
    assert.ok(matched.includes(t('rules.identity.matched')))
    assert.deepEqual(entry.value, before, '只读状态投影不修改规则草稿')
  }
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

test('结果片段与装配候选保留精确JSON，不显示结果模式的示例正文', () => {
  const action = { id: 'result', kind: 'tool-result', action: 'edit-text', edits: [
    { region: 'web-notice', match: 'ORIGINAL, WITH COMMA', text: '' },
  ] }
  const before = structuredClone(action), html = render(action)
  assert.ok(labels(html).includes(t('triggers.label.edits')))
  assert.ok(!labels(html).includes(t('triggers.label.text')), 'edit-text不暴露互斥的顶层text')
  assert.ok(html.includes('ORIGINAL, WITH COMMA'))
  assert.deepEqual(action, before)
  const candidates = ['FIRST, CANDIDATE', 'SECOND\nCANDIDATE']
  const assembly = { id: 'assembly', kind: 'assembly', target: { sections: { replace: [
    { name: 'app:web-surface', match: candidates, text: '' },
  ] } } }
  const candidateHtml = render(assembly)
  assert.ok(candidateHtml.includes('FIRST, CANDIDATE'))
  assert.ok(candidateHtml.includes('SECOND\\nCANDIDATE'), '候选以JSON保留换行而非逗号拼接')
  assert.deepEqual(assembly.target.sections.replace[0].match, candidates)
})

test('结果模式切换清理互斥草稿，空片段不伪造匹配文本', async () => {
  const { RuleParameterFields } = await withSsr([new URL('../../src/client/features/prompts/RuleFields.tsx', import.meta.url).href])
  const fields = new Map([['result:text:nested', { raw: 'old' }], ['result:edits:0', { raw: 'old' }]])
  let value = { id: 'result', kind: 'tool-result', action: 'replace', text: 'OLD' }
  const changeMode = mode => {
    const rows = RuleParameterFields({ t, value, fields, fieldKey: 'result', onDraft() {}, onChange(next) { value = next } })
    const field = rows.find(row => row?.props?.label === t('rules.actionField.action'))
    field.props.children.props.onChange(mode)
  }
  changeMode('edit-text')
  assert.deepEqual(value, { id: 'result', kind: 'tool-result', action: 'edit-text', edits: [{ region: 'web-notice', match: '', text: '' }] })
  assert.equal(fields.has('result:text:nested'), false)
  changeMode('accept')
  assert.deepEqual(value, { id: 'result', kind: 'tool-result', action: 'accept' })
  assert.equal(fields.has('result:edits:0'), false)
  changeMode('block')
  assert.equal(value.text, '')
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

