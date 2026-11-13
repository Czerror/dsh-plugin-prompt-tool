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
import { associateToolStep } from '../../engine/tool-scope.mjs'

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
async function delivered(role, delegationDepth, options = {}) {
  const root = new Context()
  const agent = {
    id: `agent-${role || 'none'}-${delegationDepth}`,
    status: 'idle',
    session: { id: `session-${role || 'none'}-${delegationDepth}`, header: { delegationDepth }, snapshotEvents: () => [] },
    options: { model: 'deepseek-chat' },
  }
  const scope = createScope(root, agent)
  agent.ctx = scope.ctx
  const reports = []
  // 平台工具就绪=执行 owner 能解析到这个定义；工具集合与步骤只在 fixture 里伪造，不注册真实工具。
  const toolSet = options.toolsReady === true ? {} : undefined
  if (toolSet !== undefined) {
    root.provide('tools', { executable: name => (name === 'redteam_preflight' ? {} : undefined) })
    associateToolStep(toolSet, toolSet, agent, { status: 'sealed', toolSet })
  }
  const dispose = mountRuleSources(scope.ctx, [{
    moduleId: 'redteam',
    rules: redteamRules().filter(rule => rule.id.startsWith('role-')),
  }], {
    agent,
    onOutcome: report => reports.push(report),
    variableStore: { read: () => ({ module: { role }, global: {}, effective: { role }, enabled: true, session: {} }) },
  })
  try {
    const payload = { agent, messages: [], signal: new AbortController().signal }
    if (toolSet !== undefined) payload.toolSet = toolSet
    const decision = await root.waterfall(scopeTarget(agent, scopeOf(agent.ctx)), 'agent/pre-step',
      payload, async () => ({ kind: 'enter', messages: [] }))
    return { messages: decision.messages, reports }
  } finally {
    dispose()
    await scope.dispose()
    await root.fiber.dispose()
  }
}

test('角色选择生效：未分配、主/子受众与缺平台工具都按真实判据决定投递', async () => {
  const segments = messages => messages.map(message => String(message.source?.plugin ?? '').split(':').at(-1))
  assert.deepEqual((await delivered('', 0)).messages, [], '未分配执行角色时不叠加任何一份')
  assert.deepEqual(segments((await delivered('plan', 0)).messages), ['body', 'env', 'bind'], 'plan 在主会话按 ENV→BIND 投递一次')
  assert.deepEqual((await delivered('plan', 1)).messages, [], 'plan 内容限定主会话，不进子代理')
  assert.deepEqual(segments((await delivered('recon', 1)).messages), ['body', 'bind', 'handoff'],
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
  assert.deepEqual(snapshot.rules.filter(rule => rule.id.startsWith('role-')).map(rule => rule.id).sort(),
    Object.keys(ROLE_COMMONS).flatMap(role => [`role-${role}`, `role-${role}-platform`]).sort(),
    '六份正文与六份平台动作各自一条规则，组合关系随定义往返')
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

const PLATFORM_TOOLS = text => text.match(/redteam_[a-z0-9_]+/g) ?? []
const segments = messages => messages.map(message => String(message.source?.plugin ?? '').split(':').at(-1))
function packageRuleSource(ruleId) {
  const source = parseYaml(readFileSync(join(PACKAGE_MODULE, 'module.yml'), 'utf8'))
  const rule = source.rules.find(item => item.id === ruleId)
  assert.ok(rule, `缺少规则 ${ruleId}`)
  return { rule, description: source.description ?? '' }
}

test('六份角色正文不出现平台工具名，平台动作只落在 .platform.md', () => {
  for (const role of Object.keys(ROLE_COMMONS)) {
    const body = readFileSync(join(PACKAGE_MODULE, 'assets', 'roles', `${role}.md`), 'utf8')
    assert.deepEqual(PLATFORM_TOOLS(body), [], `${role} 正文只留不依赖具体工具的职责与纪律`)
    assert.match(body, /不虚构/, `${role} 正文保留缺工具时如实说明、不虚构的纪律`)
    const platform = readFileSync(join(PACKAGE_MODULE, 'assets', 'roles', `${role}.platform.md`), 'utf8')
    assert.ok(PLATFORM_TOOLS(platform).length > 0, `${role}.platform.md 承载依赖具体工具的动作`)
  }
})

test('缺平台工具时角色正文照常投递，平台段不投递并上报可读原因', async () => {
  const exploit = await delivered('exploit', 1)
  assert.deepEqual(segments(exploit.messages), ['body', 'bind', 'handoff'], '缺工具只暂停平台动作段，正文与公共段照常')
  const misses = exploit.reports.filter(report => report.ruleId === 'role-exploit-platform')
  assert.equal(misses.length, 1, '平台规则命中一次判定，不静默跳过')
  assert.equal(misses[0].outcome, 'unavailable', '缺工具时判定为 unavailable，可直接定位到规则')
  const { rule, description } = packageRuleSource('role-exploit-platform')
  assert.match(rule.name, /redteam_preflight/, '规则名写明平台动作依赖 redteam_preflight')
  assert.match(description, /redteam_preflight.*缺失时该段不投递|缺失时该段不投递/, '模块描述写明缺工具时不投递')
})

test('平台工具就绪时正文与平台段各投递一次', async () => {
  for (const role of Object.keys(ROLE_COMMONS)) {
    const ready = await delivered(role, role === 'plan' ? 0 : 1, { toolsReady: true })
    const delivered_ = segments(ready.messages)
    assert.equal(delivered_.filter(id => id === 'body').length, 1, `${role} 正文只投递一次`)
    assert.equal(delivered_.filter(id => id === 'platform').length, 1, `${role} 平台段随正文各投递一次`)
    assert.equal(delivered_.at(-1), 'platform', `${role} 平台段紧跟本角色组合`)
    assert.equal(ready.reports.filter(report => report.ruleId === `role-${role}-platform` && report.outcome === 'hit').length, 1,
      `${role} 平台规则判定为 hit`)
  }
})
