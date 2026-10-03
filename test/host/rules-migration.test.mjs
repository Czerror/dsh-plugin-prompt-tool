import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { isolatedHome } from '../fixtures/host-harness.mjs'
import { Context } from '@deepseek-ai/cordis'
import { createPromptConfigs } from '../../engine/schema.mjs'
import { wireLayers } from '../../engine/layers.mjs'
import { compileRules } from '../../engine/rule-spec.mjs'
import { mountRuleSources } from '../../engine/rule-runtime.mjs'
import { buildInstructionHintText, instructionHintMessages } from '../../engine/instruction-hint.mjs'

const { moduleRoot } = isolatedHome('pt-rules-migration-')
const { promptConfigToRule, convertLegacyModuleRules, planRulesMigration, planCharacterRulesMigration, applyRulesMigration, rollbackRulesMigration } = await import('../../src/host/rules-migration.ts')
function fixture(name, definitions) {
  const root = join(moduleRoot, name)
  mkdirSync(root, { recursive: true })
  for (const [id, source] of Object.entries(definitions)) {
    const dir = join(root, id)
    mkdirSync(dir)
    writeFileSync(join(dir, 'module.yml'), '# user-owned comment\n' + JSON.stringify({ id, modules: ['prompt-config-engine'], unknown: { keep: 'yes' }, ...source }))
    writeFileSync(join(dir, 'custom.txt'), 'owned asset')
  }
  return root
}

async function policyMigrationChecks() {
  const oldFallback = { kind: 'inject-text', config: { id: 'fallback', layer: 'pre-step', strategy: 'custom-fallback', params: { text: 'BODY', firstTurnWord: 'ok' } } }
  const fallback = convertLegacyModuleRules({ id: 'fallback', modules: [], triggers: [{ id: 'fallback', channel: 'agent/pre-step', do: oldFallback }] }).rules[0]
  assert.deepEqual(fallback.when, { anchor: { keys: ['ok'], fallbackAfter: 1 } })
  assert.equal(fallback.do[0].config.strategy, 'anchor-notice')
  assert.equal(fallback.do[0].config.params.text, 'BODY')
  assert.throws(() => convertLegacyModuleRules({ modules: [], triggers: [{ id: 'mixed', channel: 'agent/pre-step', do: [oldFallback, { kind: 'pre-step-filter', blockPlugins: [] }] }] }), /不能无损提升/, '动作局部条件不能错误提升而影响同卡其他动作')
  const cwd = join(moduleRoot, 'workspace')
  const render = async (rule, skills = [], model = 'deepseek-pro', input = 'TASK') => {
    const ctx = new Context()
    ctx.provide('skills', { list: async () => skills })
    const release = mountRuleSources(ctx, [{ moduleId: 'policy', rules: compileRules([rule]) }])
    const agent = { options: { model }, session: { id: rule.id, header: { cwd }, snapshotEvents: () => [] } }
    const messages = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: input }] }]
    try {
      const result = await ctx.waterfall('agent/pre-step', { agent, messages }, async () => ({ kind: 'continue', messages }))
      return result.messages.slice(1).flatMap(message => message.content.map(block => block.text))
    } finally { release(); await ctx.fiber.dispose() }
  }
  const disabledAction = { kind: 'inject-text', config: { id: 'hidden', layer: 'pre-step', enabled: false, text: 'MUST_NOT_RUN' } }
  const migratedDisabled = convertLegacyModuleRules({ modules: [], triggers: [{ id: 'hidden', channel: 'agent/pre-step', do: disabledAction }] }).rules[0]
  assert.equal(migratedDisabled.enabled, false, '旧动作停用状态提升到唯一规则总开关')
  assert.equal(Object.hasOwn(migratedDisabled.do[0].config, 'enabled'), false)
  assert.deepEqual(await render(migratedDisabled), [], '迁移不得激活原本禁用的正文')
  assert.throws(() => convertLegacyModuleRules({ modules: [], triggers: [{ id: 'mixed-enabled', channel: 'agent/pre-step', do: [disabledAction, { kind: 'inject-text', config: { id: 'visible', layer: 'pre-step', text: 'VISIBLE' } }] }] }), /不能无损提升/, '动作局部停用不能变成兄弟动作停用或重新启用')
  const legacyInjection = { kind: 'inject-text', config: { id: 'conditional', layer: 'pre-step', audience: 'main', modelScope: 'pro', match: { keys: ['TASK'] }, text: 'MATCHED' } }
  const migratedInjection = convertLegacyModuleRules({ modules: [], triggers: [{ id: 'conditional', channel: 'agent/pre-step', do: legacyInjection }] }).rules[0]
  assert.deepEqual(migratedInjection.when, { all: [{ scope: { audience: 'main', modelScope: 'pro' } }, { text: { keys: ['TASK'], subject: 'userMessage' } }] })
  for (const key of ['audience', 'modelScope', 'promotion', 'subject', 'match']) assert.equal(Object.hasOwn(migratedInjection.do[0].config, key), false)
  assert.deepEqual(await render(migratedInjection), ['MATCHED'])
  assert.deepEqual(await render(migratedInjection, [], 'deepseek-flash'), [])
  assert.deepEqual(await render(migratedInjection, [], 'deepseek-pro', 'different'), [])
  assert.throws(() => convertLegacyModuleRules({ modules: [], triggers: [{ id: 'mixed-gates', channel: 'agent/pre-step', do: [legacyInjection, { kind: 'inject-text', config: { id: 'unconditional', layer: 'pre-step', text: 'ALWAYS' } }] }] }), /不能无损提升/, '动作局部判断不可提升后限制未受条件约束的兄弟动作')
  const env = { id: 'facts', strategy: 'placeholder', fill: 'env-facts' }
  assert.deepEqual(await render(promptConfigToRule(env)), [`Environment facts:\n- WORKSPACE=${process.env.DSH_WORKSPACE ?? cwd}\n- CWD=${cwd}`], '旧非空机器事实正文由迁移模板恢复')
  assert.deepEqual(await render(promptConfigToRule({ ...env, text: '' })), [], '显式空正文不被旧默认模板覆盖')
  assert.deepEqual(await render({ id: 'new-empty', do: [{ id: 'facts', kind: 'inject-text', config: env }] }), [], '新运行时缺正文时跳过，不读取旧策略模板')
  const catalog = { id: 'skills', strategy: 'placeholder', fill: 'skill-catalog' }
  const skills = Array.from({ length: 21 }, (_, index) => ({ name: `skill${index + 1}`, description: `description${index + 1}\nsecond line` }))
  const oldCatalog = promptConfigToRule(catalog)
  assert.equal(oldCatalog.do[0].config.params.limit, 20)
  assert.equal(oldCatalog.do[0].config.params.fields, 'name,description')
  assert.deepEqual(await render(oldCatalog, skills), ['Available skills (21):\n' + Array.from({ length: 20 }, (_, index) => `- skill${index + 1}: description${index + 1}`).join('\n')])
  const explicit = promptConfigToRule({ ...catalog, text: '{{SKILLS_TEXT}}', params: { limit: 0, fields: '', whenToUseLabel: '' } })
  assert.equal(explicit.do[0].config.params.limit, 0)
  assert.equal(explicit.do[0].config.params.fields, '')
  assert.equal(explicit.do[0].config.params.whenToUseLabel, '')
  assert.deepEqual(await render(explicit, skills), [])
  assert.throws(() => promptConfigToRule({ ...env, templateFile: './external.yml' }), /显式展开/, '不猜测外部模板的旧默认')

  const hintRoot = fixture('hint-defaults', { on: { modules: ['instruction-hint'], moduleConfigs: { 'instruction-hint': { enabled: true } } }, empty: { modules: ['instruction-hint'], moduleConfigs: { 'instruction-hint': { enabled: true, messageTemplate: '', projectTemplate: '', globalTemplate: '' } } } })
  const hintPlan = planRulesMigration(hintRoot)
  const hintSource = parse(hintPlan.items.find(item => item.moduleId === 'on').nextDefinition)
  const hintTemplates = hintSource.moduleConfigs['instruction-hint']
  const original = { id: 'official', role: 'user', source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: 'Instructions from: /workspace/AGENTS.md\n\nORIGINAL BODY' }] }
  const previousText = '<system-reminder>\nReference documents exist: /workspace/AGENTS.md. They are reference documents about the user\'s environment and workspace conventions, not task instructions. Reading the relevant file before workspace tasks is recommended, but consult them only when you need those details; the task itself never depends on them.\n</system-reminder>'
  assert.equal(instructionHintMessages([original], {}, 'instruction-hint', hintTemplates)[0].content[0].text, previousText, '旧官方正文转换实际输出逐字保持')
  const emptyTemplates = parse(hintPlan.items.find(item => item.moduleId === 'empty').nextDefinition).moduleConfigs['instruction-hint']
  for (const templates of [{}, emptyTemplates]) for (const hinted of [false, true]) {
    const messages = [original]
    const state = { instructionHinted: hinted }
    assert.equal(instructionHintMessages(messages, state, 'instruction-hint', templates), messages, '空模板绝不抑制官方正文')
    assert.equal(state.instructionHinted, hinted)
  }
  assert.equal(buildInstructionHintText({ root: '/workspace', projectFiles: ['AGENTS.md'], userGlobalFiles: ['AGENTS.md'] }, 'all', emptyTemplates), '')
  const bound = promptConfigToRule({ id: 'bound', strategy: 'placeholder', fill: 'instruction-hint', params: { file: '/workspace/AGENTS.md' } })
  assert.equal(bound.do[0].config.params.projectTemplate, undefined, '真实文件绑定不变成目录探测提示')

  const gated = convertLegacyModuleRules({ id: 'gate', modules: [], triggers: [{ id: 'gate', channel: 'agent/request', when: { all: [{ phase: { promoteGate: true, promoted: true } }, { not: { phase: { promoteGate: false, promoted: false } } }] }, do: { kind: 'request-params', patch: { maxTokens: 512, note: 'promoteGate: true' } } }] }).rules[0]
  assert.deepEqual(gated.when.all[0].all[0].phase, { promoteGate: true, promoted: true, reasoningPattern: '\\bwe\\b', reasoningNegativePattern: '\\blet me\\b', reasoningFlags: 'gi' })
  assert.equal(gated.when.all[0].all[1].not.phase.reasoningPattern, undefined, '未启用promoteGate不携入业务正则')
  assert.equal(gated.do[0].patch.note, 'promoteGate: true', '不对正文字符串做全文替换')
  const events = []
  const session = { id: 'gated', header: {}, snapshotEvents: () => events }
  const agent = { session, options: { model: 'deepseek-pro' } }
  const gateCtx = new Context()
  const releaseGate = mountRuleSources(gateCtx, [{ moduleId: 'gate', rules: compileRules([gated]) }])
  const request = () => gateCtx.waterfall('agent/request', { agent }, async () => ({ maxTokens: 1024 }))
  const observe = event => { events.push(event); gateCtx.emit('session/event', session, event) }
  try {
    assert.equal((await request()).maxTokens, 1024)
    observe({ seq: 1, type: 'tool/call', data: {} })
    observe({ seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'Let me inspect.' }] } } })
    assert.equal((await request()).maxTokens, 1024)
    observe({ seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'WE inspect.' }] } } })
    assert.equal((await request()).maxTokens, 512, '旧gated phase事件/大小写实际动作输出保持')
  } finally { releaseGate(); await gateCtx.fiber.dispose() }
  const emptyCtx = new Context()
  const releaseEmpty = mountRuleSources(emptyCtx, [{ moduleId: 'empty-gate', rules: compileRules([{ id: 'empty-gate', when: { phase: { promoteGate: true } }, do: gated.do }]) }])
  try {
    assert.equal((await emptyCtx.waterfall('agent/request', { agent }, async () => ({ maxTokens: 1024 }))).maxTokens, 1024, '新缺省pattern不内建we/let me偏好')
  } finally { releaseEmpty(); await emptyCtx.fiber.dispose() }
}

test('离线规则迁移：同卡前后动作与原投递身份保留，完整物化、幂等及原字节回滚', async () => {
  await policyMigrationChecks()
  const guide = promptConfigToRule({ id: 'guide', strategy: 'guide-auto', params: { guideWeak: 'WEAK', guideDeep: 'DEEP' } })
  assert.equal(guide.do[0].config.params.complexMinChars, 120, '只在旧格式迁移中显式记录原业务阈值')
  assert.equal(promptConfigToRule({ id: 'empty-guide', strategy: 'guide-auto', params: { complexMinChars: '' } }).do[0].config.params.complexMinChars, '', '显式空阈值不被迁移默认覆盖')
  const guideConfig = compileRules([guide])[0].actions[0].compiledConfig
  for (const [length, expected] of [[120, 'WEAK'], [121, 'DEEP']]) {
    const result = await guideConfig.resolve({ messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: 'x'.repeat(length) }] }] })
    assert.equal(result.text, expected, '保留原严格大于120的实际正文选择')
  }
  const legacyTrigger = convertLegacyModuleRules({ id: 'native', modules: ['declared-triggers'], triggers: [{ id: 'native', channel: 'agent/request', do: { kind: 'request-params', patch: { maxTokens: 512 } } }] })
  assert.deepEqual(legacyTrigger.rules[0].when, { scope: { modelScope: 'pro' } }, '单动作的旧模型范围统一提升为条件')
  assert.equal(legacyTrigger.rules[0].do[0].modelScope, undefined)
  const nativeCtx = new Context()
  const releaseNative = mountRuleSources(nativeCtx, [{ moduleId: 'native', rules: compileRules(legacyTrigger.rules) }])
  try {
    for (const [model, expected] of [['deepseek-pro', 512], ['deepseek-flash', 1024]]) {
      const result = await nativeCtx.waterfall('agent/request', { agent: { options: { model } } }, async () => ({ maxTokens: 1024 }))
      assert.equal(result.maxTokens, expected, '旧原生request-params缺省pro实际输出保持')
    }
  } finally { releaseNative(); await nativeCtx.fiber.dispose() }
  for (const modelScope of [undefined, 'pro', 'flash']) {
    const legacy = { id: 'model', layer: 'agent-request', ...(modelScope === undefined ? {} : { modelScope }), params: { patch: { maxTokens: 512 } } }
    const oldCtx = new Context()
    const newCtx = new Context()
    const releaseOld = wireLayers(oldCtx, createPromptConfigs([legacy]), () => {})
    const releaseNew = mountRuleSources(newCtx, [{ moduleId: 'model', rules: compileRules([promptConfigToRule(legacy)]) }])
    try {
      for (const model of ['deepseek-pro', 'deepseek-flash']) {
        const agent = { options: { model }, session: { id: model, header: {}, snapshotEvents: () => [] } }
        const before = await oldCtx.waterfall('agent/request', { agent }, async () => ({ maxTokens: 1024 }))
        const after = await newCtx.waterfall('agent/request', { agent }, async () => ({ maxTokens: 1024 }))
        const expected = modelScope === undefined || (modelScope === 'flash') === model.includes('flash') ? 512 : 1024
        assert.equal(before.maxTokens, expected, '旧实际请求结果符合字面真值')
        assert.deepEqual(after, before, `${modelScope ?? 'all'} 的 ${model} 迁移前后请求一致`)
      }
    } finally { releaseOld(); releaseNew(); await oldCtx.fiber.dispose(); await newCtx.fiber.dispose() }
  }
  const old = { id: 'tools', layer: 'tool-pipeline', audience: 'main', params: { toolNames: 'bash', preDecision: 'ask', postAction: 'replace' }, text: 'replacement' }
  const converted = promptConfigToRule(old)
  assert.deepEqual(converted.when, { scope: { audience: 'main' } })
  assert.deepEqual(converted.do, [
    { id: 'before', kind: 'decision', phase: 'pre', decision: 'ask', toolNames: 'bash' },
    { id: 'after', kind: 'decision', phase: 'post', action: 'replace', toolNames: 'bash', text: 'replacement' },
  ])
  const hash = text => createHash('sha256').update(text).digest('hex')
  const root = fixture('roundtrip', { a: { promptConfigs: [{ id: 'hello', text: 'Hello' }, old, { id: 'template', templateFile: '../a/assets/notice.yml' }], configOrder: { hello: 40, tools: 70, template: 90 },
    meta: { characterMemories: { generated: { characterId: 'generated', configId: 'hello', contentHash: hash('{"id":"hello","text":"Hello"}') }, edited: { characterId: 'edited', configId: 'tools', contentHash: 'unmatched-user-content' } } } } })
  mkdirSync(join(root, 'a', 'assets'))
  writeFileSync(join(root, 'a', 'assets', 'notice.yml'), 'text: TEMPLATE\n')
  const file = join(root, 'a', 'module.yml')
  const before = readFileSync(file)
  const plan = planRulesMigration(root)
  assert.equal(plan.items.length, 1)
  assert.deepEqual(readFileSync(file), before, 'check remains read-only')
  const result = await applyRulesMigration(plan)
  assert.deepEqual(result.changed, ['a'])
  const spec = parse(readFileSync(file, 'utf8'))
  assert.deepEqual(spec.configOrder, { hello: 40, tools: 70, template: 90 })
  assert.deepEqual(spec.modules, ['rule-engine'])
  assert.equal(spec.rules[0].do[0].config.id, 'hello')
  assert.equal(spec.rules[2].do[0].config.templateFile, './assets/notice.yml')
  assert.equal(spec.meta.characterMemories.generated.contentHash, hash('{"do":[{"config":{"id":"hello","layer":"pre-step","text":"Hello"},"id":"inject","kind":"inject-text"}],"id":"hello","layer":"pre-step"}'))
  assert.equal(spec.meta.characterMemories.edited.contentHash, 'unmatched-user-content')
  assert.equal(Object.hasOwn(spec, 'promptConfigs'), false)
  assert.equal(Object.hasOwn(spec, 'triggers'), false)
  assert.deepEqual(spec.unknown, { keep: 'yes' })
  assert.match(readFileSync(file, 'utf8'), /user-owned comment/)
  assert.equal(readFileSync(join(root, 'a', 'custom.txt'), 'utf8'), 'owned asset')
  assert.ok(existsSync(join(root, 'a', 'rules.yml')))
  assert.deepEqual((await applyRulesMigration(planRulesMigration(root))).changed, [])
  assert.deepEqual(rollbackRulesMigration(root).restored, ['a'])
  assert.deepEqual(readFileSync(file), before)
  assert.deepEqual(rollbackRulesMigration(root).restored, [])
  const materialized = fixture('materialized-only', { a: {} })
  mkdirSync(join(materialized, 'a', 'configs'))
  writeFileSync(join(materialized, 'a', 'configs', '0040-only.yml'), 'id: only\ntext: ONLY\n')
  const restored = parse(planRulesMigration(materialized).items[0].nextDefinition)
  assert.equal(restored.configOrder.only, 40)
  assert.equal(restored.rules[0].do[0].config.text, 'ONLY')
  const storage = join(moduleRoot, 'native-character-store')
  const characterRoot = join(storage, '.characters')
  const character = join(characterRoot, 'card')
  mkdirSync(character, { recursive: true })
  mkdirSync(join(storage, 'modules'))
  const definition = '# native library\nid: card\nmodules: [prompt-config-engine]\npromptConfigs:\n  - id: memory\n    # keep field note\n    text: Library\n'
  writeFileSync(join(character, 'converted.yml'), definition)
  const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  writeFileSync(join(character, 'original.png'), image)
  writeFileSync(join(character, 'card.json'), '{"name":"Native"}\n')
  writeFileSync(join(character, 'memory.md'), 'PRIVATE MEMORY\n')
  const characterPlan = planCharacterRulesMigration(characterRoot)
  assert.deepEqual((await applyRulesMigration(characterPlan)).changed, ['card'])
  const convertedText = readFileSync(join(character, 'converted.yml'), 'utf8')
  assert.equal(parse(convertedText).rules[0].do[0].config.text, 'Library')
  assert.match(convertedText, /keep field note/)
  assert.equal(existsSync(join(character, 'module.yml')), false, '库素材不被变成模块')
  assert.deepEqual(readFileSync(join(character, 'original.png')), image)
  assert.equal(readFileSync(join(character, 'card.json'), 'utf8'), '{"name":"Native"}\n')
  assert.equal(readFileSync(join(character, 'memory.md'), 'utf8'), 'PRIVATE MEMORY\n')
  const { listCharacterCards } = await import('../../src/host/characters.ts')
  assert.equal(listCharacterCards(join(storage, 'modules')).some(card => card.id === 'card'), true, '原角色库可直接读取，无需重新导入')
  assert.equal(planCharacterRulesMigration(characterRoot).items.length, 0)
  assert.deepEqual(rollbackRulesMigration(characterRoot).restored, ['card'])
  assert.equal(readFileSync(join(character, 'converted.yml'), 'utf8'), definition)
})

test('离线拒绝：全量预检发现坏模块、互斥多启用或预检后的修改均不覆盖任何定义', async () => {
  const root = fixture('reject', { a: { promptConfigs: [{ id: 'a', text: 'A' }] }, b: { promptConfigs: [{ id: 'b', text: 'B', group: 'g', exclusive: true }, { id: 'c', text: 'C', group: 'g' }] } })
  const first = join(root, 'a', 'module.yml')
  const before = readFileSync(first)
  assert.throws(() => planRulesMigration(root), /exclusive group/)
  assert.deepEqual(readFileSync(first), before)
  const mismatch = fixture('mismatch', { a: { promptConfigs: [{ id: 'a', text: 'SOURCE' }] } })
  mkdirSync(join(mismatch, 'a', 'configs'))
  writeFileSync(join(mismatch, 'a', 'configs', '0000-a.yml'), 'id: a\ntext: RUNNING-OTHER\n')
  assert.throws(() => planRulesMigration(mismatch), /不一致/)
  const valid = fixture('stale', { a: { promptConfigs: [{ id: 'a', text: 'A' }] } })
  const plan = planRulesMigration(valid)
  writeFileSync(join(valid, 'a', 'custom.txt'), 'external edit')
  await assert.rejects(applyRulesMigration(plan), /变化/)
  assert.equal(readFileSync(join(valid, 'a', 'custom.txt'), 'utf8'), 'external edit')
})

test('离线回滚拒绝覆盖迁移后的正文或资产变化', async () => {
  const root = fixture('rollback-conflict', { a: { promptConfigs: [{ id: 'a', text: 'A' }] } })
  await applyRulesMigration(planRulesMigration(root))
  writeFileSync(join(root, 'a', 'custom.txt'), 'new user asset')
  const before = readFileSync(join(root, 'a', 'module.yml'))
  assert.throws(() => rollbackRulesMigration(root), /拒绝回滚/)
  assert.deepEqual(readFileSync(join(root, 'a', 'module.yml')), before)
  assert.equal(readFileSync(join(root, 'a', 'custom.txt'), 'utf8'), 'new user asset')
})
