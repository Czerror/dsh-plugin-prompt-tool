import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { isolatedHome } from '../fixtures/host-harness.mjs'

const { moduleRoot } = isolatedHome('pt-module-rules-')
const { readModuleRules, editModuleRules } = await import('../../src/host/module-rules.ts')
const { loadModuleSpec, resolveModuleFacts } = await import('../../src/host/manifest.ts')
const { readRulesDir } = await import('../../src/host/module-storage.ts')
const rule = (id, extra = {}) => ({ id, layer: 'agent-request', then: [{ id: 'request', kind: 'request-params', patch: { maxTokens: 512 } }], ...extra })
const completeRule = (id, audience, enabled = true) => ({ id, enabled, then: [{ id: 'section', kind: 'inject-text', config: {
  layer: 'system-section', text: id, ...(audience === undefined ? {} : { audience }), params: { complete: true },
} }] })
function fixture(id, rules) {
  const dir = join(moduleRoot, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'module.yml'), '# user comment\n' + JSON.stringify({ id, modules: [], unknown: { keep: true }, rules, configOrder: Object.fromEntries(rules.map((item, i) => [item.id, i * 10])) }))
  return dir
}

test('规则局部事务：改名和删除同步序号，显式启用原子关闭同组，保留其他定义', () => {
  const dir = fixture('edit', [rule('a', { group: 'g', exclusive: true }), rule('b', { group: 'g', enabled: false }), rule('c')])
  writeFileSync(join(dir, 'module.yml'), [
    '# user comment', 'id: edit', 'modules: []', 'unknown: { keep: true }',
    'persona:', '  main: { prefix: "", complete: false } # persona comment',
    '  subagent: { suffix: "", complete: true, includeRuntimeContext: false }',
    'rules:',
    '  - id: a', '    group: g', '    exclusive: true', '    then:',
    '      - { id: request, kind: request-params, patch: { maxTokens: 512 } }',
    '  - id: b # identity comment', '    name: Before # name comment', '    group: g', '    enabled: false',
    '    then:', '      - id: request # action comment', '        kind: request-params', '        patch:', '          maxTokens: 512 # value comment',
    '  - id: c', '    then:', '      - { id: request, kind: request-params, patch: { maxTokens: 512 } }',
    'configOrder:', '  a: 0', '  b: 10 # order comment', '  c: 20', '',
  ].join('\n'))
  const initial = readModuleRules(dir)
  const updated = editModuleRules(dir, { expectedRevisions: initial.revisions, edits: [{ previousId: 'b', rule: { ...initial.rules[1], id: 'renamed', name: 'After' } }, { previousId: 'c', rule: null }], activateRuleId: 'renamed' })
  assert.deepEqual(updated.rules.map(item => [item.id, item.enabled]), [['a', false], ['renamed', true]])
  const text = readFileSync(join(dir, 'module.yml'), 'utf8')
  const data = parse(text)
  assert.deepEqual(data.configOrder, { a: 0, renamed: 10 })
  assert.deepEqual(data.unknown, { keep: true })
  const persona = { main: { prefix: '', complete: false }, subagent: { suffix: '', complete: true, includeRuntimeContext: false } }
  assert.deepEqual(data.persona, persona)
  assert.deepEqual(parse(readFileSync(join(dir, 'rules', '_settings.yml'), 'utf8')).persona, persona, '规则事务同时发布人设只读投影，省略字段与空串/false 区分')
  assert.match(text, /# persona comment/)
  assert.match(text, /# user comment/)
  for (const comment of ['identity comment', 'name comment', 'action comment', 'value comment', 'order comment']) assert.ok(text.includes('# ' + comment), `改名保留 ${comment}`)
  assert.ok(resolveModuleFacts(loadModuleSpec(dir), dir).effectiveModules.includes('rule-engine'), '模块事实如实报告规则的隐式执行入口')
  assert.notEqual(updated.revisions.settings, initial.revisions.settings)
  const split = fixture('complete-audiences', [])
  const expected = [completeRule('main-only', 'main'), completeRule('child-only', 'subagent'), completeRule('disabled-main', 'main', false)]
  editModuleRules(split, { expectedRevisions: readModuleRules(split).revisions, edits: expected.map(rule => ({ previousId: null, rule })) })
  assert.deepEqual(readModuleRules(split).rules, expected, '主子各一条独占可同时保存，禁用条目不参与计数')
  assert.deepEqual(parse(readFileSync(join(split, 'module.yml'), 'utf8')).rules, expected)
  assert.deepEqual(readRulesDir(split).contents.map(rule => rule.then[0].config.audience), ['main', 'subagent', 'main'], '受众保留到可恢复投影')
})

test('规则拒绝：版本过期、重复身份、坏动作与未显式解决的互斥均不写盘', () => {
  const dir = fixture('reject', [rule('a', { group: 'g', exclusive: true }), rule('b', { group: 'g', enabled: false })])
  const initial = readModuleRules(dir)
  const before = readFileSync(join(dir, 'module.yml'), 'utf8')
  for (const request of [
    { expectedRevisions: { settings: '0'.repeat(64) }, activateRuleId: 'b' },
    { expectedRevision: '0'.repeat(64), edits: [] },
    { edits: [{ previousId: null, rule: rule('a') }] },
    { edits: [{ previousId: 'a', rule: { ...rule('a'), then: [{ id: 'broken', kind: 'missing' }] } }] },
    { edits: [{ previousId: 'b', rule: rule('b', { group: 'g', enabled: true }), settingsChanged: true }] },
    { edits: [{ previousId: 'missing', rule: null }] },
  ]) assert.throws(() => editModuleRules(dir, { expectedRevisions: initial.revisions, ...request }))
  assert.equal(readFileSync(join(dir, 'module.yml'), 'utf8'), before)
  const file = join(dir, 'module.yml')
  writeFileSync(file, JSON.stringify({ id: 'reject', modules: [], rules: [null] }))
  assert.throws(() => readModuleRules(dir), error => error.status === 400 && error.code === 'rules-invalid', '坏结构在读取面明确拒绝')
  const future = { id: 'future', if: { futurePredicate: { custom: true } }, then: [{ id: 'future-action', kind: 'future-kind', opaque: { custom: true } }] }
  writeFileSync(file, JSON.stringify({ id: 'reject', modules: [], rules: [future] }))
  assert.throws(() => readModuleRules(dir), /future-kind|futurePredicate/, '无效源语义拒绝加载，不能发布切片')
  const aliased = 'id: reject\nmodules: []\nrules:\n  - id: a\n    name: &shared Before\n    then:\n      - { id: request, kind: request-params, patch: { maxTokens: 512 } }\nunknown: *shared\n'
  writeFileSync(file, aliased)
  const aliasSnapshot = readModuleRules(dir)
  for (const validateOnly of [true, false]) assert.throws(() => editModuleRules(dir, { expectedRevisions: aliasSnapshot.revisions, validateOnly, edits: [{ previousId: 'a', rule: { ...aliasSnapshot.rules[0], name: 'After' } }] }), /YAML.*引用/, '共享别名不允许局部编辑改变其他定义')
  assert.equal(readFileSync(file, 'utf8'), aliased, '别名拒绝保持原文件字节')
  const overlap = fixture('complete-overlap', [completeRule('one', 'main')])
  const snapshot = readModuleRules(overlap), original = readFileSync(join(overlap, 'module.yml')), projection = readRulesDir(overlap)
  for (const audience of ['main', undefined, null]) {
    assert.throws(() => editModuleRules(overlap, { expectedRevisions: snapshot.revisions,
      edits: [{ previousId: null, rule: completeRule('overlap', audience) }],
    }), /multiple complete system sections/, '同主受众或通用独占与已有主独占重叠')
    assert.deepEqual(readFileSync(join(overlap, 'module.yml')), original, '拒绝保持完整定义原字节')
    assert.deepEqual(readRulesDir(overlap), projection, '拒绝不发布候选切片')
  }
})

test('规则边界：仅校验与无改动幂等；旧内容按白名单加载', () => {
  const dir = fixture('check', [rule('a')])
  const initial = readModuleRules(dir)
  const before = readFileSync(join(dir, 'module.yml'), 'utf8')
  const checked = editModuleRules(dir, { expectedRevisions: initial.revisions, edits: [{ previousId: null, rule: rule('b') }], validateOnly: true })
  assert.equal(checked.rules.length, 2)
  assert.deepEqual(checked.revisions, initial.revisions)
  assert.deepEqual(editModuleRules(dir, { expectedRevisions: initial.revisions, edits: [] }), initial)
  assert.equal(readFileSync(join(dir, 'module.yml'), 'utf8'), before)
  const settingsFile = join(dir, 'rules', '_settings.yml')
  assert.equal(Object.hasOwn(parse(readFileSync(settingsFile, 'utf8')), 'persona'), false, '未声明人设不生成覆盖')
  const persona = { main: { prefix: '', complete: false }, subagent: { suffix: '', complete: true, includeRuntimeContext: false } }
  const definition = { ...parse(before), persona }
  const personaSource = '# original persona owner\n' + JSON.stringify(definition)
  writeFileSync(join(dir, 'module.yml'), personaSource)
  const withPersona = readModuleRules(dir)
  assert.deepEqual(withPersona.rules, initial.rules, '人设不成为规则')
  assert.deepEqual(withPersona.revisions, initial.revisions, '人设内容不扩大规则状态和变量的版本所有权')
  assert.deepEqual(loadModuleSpec(dir).configOrder, definition.configOrder, '人设不进入配置序号')
  const settings = parse(readFileSync(settingsFile, 'utf8'))
  assert.deepEqual(settings.persona, persona)
  writeFileSync(settingsFile, JSON.stringify({ ...settings, persona: { main: { prefix: 'FORGED', complete: true } } }))
  assert.throws(() => readRulesDir(dir), /失配/, '即使完整性元数据未改，伪造的人设投影也不能被接纳')
  assert.deepEqual(readModuleRules(dir), withPersona, '协调读取从完整定义恢复坏投影')
  assert.deepEqual(parse(readFileSync(settingsFile, 'utf8')).persona, persona)
  assert.equal(readFileSync(join(dir, 'module.yml'), 'utf8'), personaSource, '恢复不反写人设唯一真值')
  writeFileSync(join(dir, 'module.yml'), before)
  assert.deepEqual(readModuleRules(dir), initial)
  assert.equal(Object.hasOwn(parse(readFileSync(settingsFile, 'utf8')), 'persona'), false, '完整定义删除人设后投影也撤销，恢复继承')
  // 旧内容不再阻断加载：它不变成规则、不参与执行，定义原样保留。
  writeFileSync(join(dir, 'module.yml'), 'id: check\nmodules: []\npromptConfigs:\n  - id: legacy-card\n    text: LEGACY\n')
  assert.deepEqual(readModuleRules(dir).rules, [])
  // 模型路由/采样参数是公共参数（写在 layerSettings），与规则表并存必须能加载并读回。
  writeFileSync(join(dir, 'module.yml'), 'id: check\nmodules: []\nrules: []\nlayerSettings:\n  agent-request:\n    modelTemperature: 0.5\n')
  assert.equal(readModuleRules(dir).rules.length, 0)
  assert.equal(loadModuleSpec(dir).params.modelTemperature, 0.5, '模型参数原样读回')
})
