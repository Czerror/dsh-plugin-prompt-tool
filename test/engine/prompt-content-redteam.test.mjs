import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeOf, scopeTarget } from '@deepseek-ai/dsh-scope'
import { parse as parseYaml } from 'yaml'
import { isolatedHome } from '../fixtures/host-harness.mjs'
import { compileRules } from '../../engine/rule-spec.mjs'
import { compareConfigSequence } from '../../engine/order.mjs'
import { mountRuleSources } from '../../engine/rule-runtime.mjs'

const { moduleRoot } = isolatedHome('pt-prompt-content-redteam-')
const { rulePromptConfigOptions, validateModuleDefinitionText } = await import('../../src/host/module-slices.ts')

const PACKAGE_MODULE = fileURLToPath(new URL('../../modules/redteam/', import.meta.url))

/** 一段注入动作的声明：正文来自模块 assets，组合顺序即动作声明序。 */
const inject = (id, file) => ({
  id,
  kind: 'inject-text',
  config: { layer: 'pre-step', position: 'before-all', dedupe: 'session', templateFile: `./assets/${file}` },
})

/**
 * 角色组合的公开出口：模块定义编译后，按引擎序号取启用规则的注入正文。
 * 期望值不来自实现——调用方传的是自己写的字面角色与公共段文件。
 */
function compose(dir, source) {
  const compiled = compileRules(source.rules, {
    moduleId: basename(dir),
    configOrder: source.configOrder ?? {},
    promptConfigOptions: rulePromptConfigOptions(dir),
  })
  const configs = compiled
    .filter(rule => rule.enabled !== false)
    .flatMap(rule => rule.actions.filter(action => action.compiledConfig !== undefined).map(action => action.compiledConfig))
    .sort(compareConfigSequence)
  return configs.map(config => config.texts.join('\n\n'))
}

function fixtureModule(name, source, assets) {
  const dir = join(moduleRoot, name)
  mkdirSync(join(dir, 'assets', 'roles'), { recursive: true })
  mkdirSync(join(dir, 'assets', 'common'), { recursive: true })
  writeFileSync(join(dir, 'module.yml'), JSON.stringify({ id: name, modules: [], ...source }))
  for (const [path, text] of Object.entries(assets)) writeFileSync(join(dir, 'assets', path), text)
  return dir
}

const FIXTURE_ASSETS = {
  'roles/a.md': 'A-BODY',
  'roles/b.md': 'B-BODY',
  'roles/c.md': 'C-BODY',
  'common/one.md': 'COMMON-ONE',
  'common/two.md': 'COMMON-TWO',
}
const FIXTURE_RULES = [
  { id: 'role-a', enabled: true, layer: 'pre-step', then: [inject('body', 'roles/a.md'), inject('one', 'common/one.md'), inject('two', 'common/two.md')] },
  { id: 'role-b', enabled: true, layer: 'pre-step', then: [inject('body', 'roles/b.md'), inject('two', 'common/two.md')] },
  { id: 'role-c', enabled: true, layer: 'pre-step', then: [inject('body', 'roles/c.md')] },
]

test('角色组合按声明序拼接自身正文与共享公共段，每段只出现一次', () => {
  const dir = fixtureModule('fixture-order', { rules: FIXTURE_RULES }, FIXTURE_ASSETS)
  assert.deepEqual(compose(dir, { rules: FIXTURE_RULES }), [
    'A-BODY', 'COMMON-ONE', 'COMMON-TWO',
    'B-BODY', 'COMMON-TWO',
    'C-BODY',
  ], '同一规则内多段按声明序投递，共享段引用不展开成多份')
})

test('修改共享段后所有引用它的角色同步变化，未引用的角色保持', () => {
  const dir = fixtureModule('fixture-shared', { rules: FIXTURE_RULES }, FIXTURE_ASSETS)
  assert.deepEqual(compose(dir, { rules: FIXTURE_RULES }), ['A-BODY', 'COMMON-ONE', 'COMMON-TWO', 'B-BODY', 'COMMON-TWO', 'C-BODY'])
  writeFileSync(join(dir, 'assets', 'common', 'two.md'), 'COMMON-TWO-EDIT')
  assert.deepEqual(compose(dir, { rules: FIXTURE_RULES }), [
    'A-BODY', 'COMMON-ONE', 'COMMON-TWO-EDIT',
    'B-BODY', 'COMMON-TWO-EDIT',
    'C-BODY',
  ], '两处引用同步变化，只引用自身正文的 role-c 保持')
})

test('角色自身正文独立编辑，不牵连其它角色与共享段', () => {
  const dir = fixtureModule('fixture-roles', { rules: FIXTURE_RULES }, FIXTURE_ASSETS)
  writeFileSync(join(dir, 'assets', 'roles', 'b.md'), 'B-BODY-EDIT')
  assert.deepEqual(compose(dir, { rules: FIXTURE_RULES }), ['A-BODY', 'COMMON-ONE', 'COMMON-TWO', 'B-BODY-EDIT', 'COMMON-TWO', 'C-BODY'])
})

test('未分配执行角色时不叠加任何角色组合', () => {
  const disabled = FIXTURE_RULES.map(rule => ({ ...rule, enabled: false }))
  const dir = fixtureModule('fixture-unassigned', { rules: disabled }, FIXTURE_ASSETS)
  assert.deepEqual(compose(dir, { rules: disabled }), [], '角色规则未命中时不产生注入')
})

/** 真实 Agent 的 pre-step 投递：Agent 挂在 scope 上，按官方 waterfall 观察命中角色实际投递的消息。 */
async function delivered(role, delegationDepth) {
  const root = new Context()
  const agent = {
    id: `agent-${role || 'none'}-${delegationDepth}`,
    status: 'idle',
    session: { id: `session-${role || 'none'}-${delegationDepth}`, header: { delegationDepth }, snapshotEvents: () => [] },
    options: { model: 'deepseek-chat' },
  }
  const scope = createScope(root, agent)
  agent.ctx = scope.ctx
  const dispose = mountRuleSources(scope.ctx, [{
    moduleId: 'redteam',
    rules: redteamRules().filter(rule => rule.id.startsWith('role-')),
  }], {
    agent,
    variableStore: { read: () => ({ module: { role }, global: {}, effective: { role }, enabled: true, session: {} }) },
  })
  try {
    const decision = await root.waterfall(scopeTarget(agent, scopeOf(agent.ctx)), 'agent/pre-step',
      { agent, messages: [], signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
    return decision.messages
  } finally {
    dispose()
    await scope.dispose()
    await root.fiber.dispose()
  }
}

test('角色选择生效：未分配、主/子受众与缺平台工具都按真实判据决定投递', async () => {
  const segments = messages => messages.map(message => String(message.source?.plugin ?? '').split(':').at(-1))
  assert.deepEqual(await delivered('', 0), [], '未分配执行角色时不叠加任何一份')
  assert.deepEqual(segments(await delivered('plan', 0)), ['body', 'env', 'bind'], 'plan 在主会话按 ENV→BIND 投递一次')
  assert.deepEqual(await delivered('plan', 1), [], 'plan 内容限定主会话，不进子代理')
  assert.deepEqual(segments(await delivered('recon', 1)), ['body', 'bind', 'handoff'],
    '缺平台工具时只暂停 score-rules/db-lookup/evidence 三段，其余正文照常')
})

test('复制模块保留共享关系，复制体独立维护', () => {
  const dir = fixtureModule('fixture-copy-source', { rules: FIXTURE_RULES }, FIXTURE_ASSETS)
  const copy = join(moduleRoot, 'fixture-copy-target')
  cpSync(dir, copy, { recursive: true })
  const copied = JSON.parse(readFileSync(join(copy, 'module.yml'), 'utf8'))
  assert.deepEqual(compose(copy, copied), ['A-BODY', 'COMMON-ONE', 'COMMON-TWO', 'B-BODY', 'COMMON-TWO', 'C-BODY'])
  writeFileSync(join(copy, 'assets', 'common', 'two.md'), 'COPY-EDIT')
  assert.deepEqual(compose(copy, copied), ['A-BODY', 'COMMON-ONE', 'COPY-EDIT', 'B-BODY', 'COPY-EDIT', 'C-BODY'], '复制后仍引用同一共享段文件，不是展开副本')
  assert.deepEqual(compose(dir, { rules: FIXTURE_RULES }), ['A-BODY', 'COMMON-ONE', 'COMMON-TWO', 'B-BODY', 'COMMON-TWO', 'C-BODY'], '复制体改动不回写原模块')
})

/** 规格第 11 条的角色 → 公共段顺序；来源正文是独立真值，不从实现反推。 */
const ROLE_COMMONS = {
  plan: ['env', 'bind'],
  recon: ['bind', 'db-lookup', 'evidence', 'handoff'],
  assess: ['bind', 'db-lookup', 'evidence', 'handoff'],
  'vuln-scan': ['bind', 'score-rules', 'db-lookup', 'evidence', 'handoff'],
  exploit: ['bind', 'score-rules', 'db-lookup', 'evidence', 'handoff'],
  internal: ['bind', 'score-rules', 'db-lookup', 'evidence', 'handoff'],
}

function packageRule(ruleId) {
  const rule = redteamRules().find(item => item.id === ruleId)
  assert.ok(rule, `缺少角色规则 ${ruleId}`)
  return rule
}
function redteamRules() {
  const source = parseYaml(readFileSync(join(PACKAGE_MODULE, 'module.yml'), 'utf8'))
  return compileRules(source.rules, {
    moduleId: 'redteam',
    configOrder: source.configOrder ?? {},
    variables: source.variables,
    promptConfigOptions: rulePromptConfigOptions(PACKAGE_MODULE),
  })
}
const segmentsOf = rule => rule.actions
  .filter(action => action.kind === 'inject-text')
  .map(action => basename(String(action.config.templateFile ?? '')))

test('六角色组合顺序与各段次数与规格一致', () => {
  for (const [role, commons] of Object.entries(ROLE_COMMONS)) {
    const rule = packageRule(`role-${role}`)
    assert.notEqual(rule.enabled, false, `${role} 是内容规则，默认启用；是否投递由角色选择与受众决定`)
    assert.deepEqual(segmentsOf(rule), [`${role}.md`, ...commons.map(key => `${key}.md`)],
      `${role} 组合顺序：角色正文后按规格顺序引用公共段，每段一次`)
  }
})

test('六个公共段各自只有一处内容所有权，被多个角色共同引用', () => {
  const owners = {}
  for (const role of Object.keys(ROLE_COMMONS)) {
    for (const file of segmentsOf(packageRule(`role-${role}`)).slice(1)) owners[file] = (owners[file] ?? 0) + 1
  }
  assert.deepEqual(owners, {
    'env.md': 1, 'bind.md': 6, 'score-rules.md': 3, 'db-lookup.md': 5, 'evidence.md': 5, 'handoff.md': 5,
  }, '同一公共段文件被多角色引用；共享段正文不复制进角色资产')
})

test('导出的模块定义可再次导入校验，角色组合关系随定义保留', () => {
  const text = readFileSync(join(PACKAGE_MODULE, 'module.yml'), 'utf8')
  const snapshot = validateModuleDefinitionText(PACKAGE_MODULE, text)
  assert.deepEqual(snapshot.rules.filter(rule => rule.id.startsWith('role-')).map(rule => rule.id).sort(), Object.keys(ROLE_COMMONS).map(role => `role-${role}`).sort())
  assert.equal(snapshot.rules.find(rule => rule.id === 'role-plan').then[0].config.templateFile, './assets/roles/plan.md', '相对资产引用随定义往返')
})

test('角色资产不含公共段正文，展开全文只做一次性比对', () => {
  const commons = ['env', 'bind', 'score-rules', 'db-lookup', 'evidence', 'handoff']
    .map(key => readFileSync(join(PACKAGE_MODULE, 'assets', 'common', `${key}.md`), 'utf8'))
  for (const role of Object.keys(ROLE_COMMONS)) {
    const body = readFileSync(join(PACKAGE_MODULE, 'assets', 'roles', `${role}.md`), 'utf8')
    for (const common of commons) {
      assert.equal(body.includes(common), false, `${role} 角色资产不得内嵌公共段正文`)
    }
  }
})
