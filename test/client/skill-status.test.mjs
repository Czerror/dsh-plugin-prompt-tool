// 技能状态展示与来源分组（文件层调用策略）。
// 调用策略不再是插件的屏蔽表，而是技能文件 frontmatter 的两个官方键
// （disable-model-invocation / user-invocable）：条目上的 modelInvocable / userInvocable
// 既是唯一事实，也是开关、页签、徽章与色调的共同输入。
// 随注册层屏蔽模型移除的还有技能树 / 嵌套祖先筛选（buildSkillTree、filterSkillCatalog）与
// skillIdOf / skillParentOf 身份解析——新模型按官方一层发现只认 `<根>/<目录名>/SKILL.md`，
// folder 不再是可嵌套的路径身份，同名遮蔽由来源优先级裁决，页面上不再有树与拖拽排序。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PROMPT_TOOL_DICTS } from '../../src/client/locales.ts'
import { invocationForScope, scopeOfInvocation } from '../../src/shared/skills.ts'
import {
  groupBySource,
  matchesSkillStatus,
  scopeAfterToggle,
  skillEnabled,
  skillShadowed,
  skillStatusLabel,
  skillStatusTone,
  skillUnavailable,
} from '../../src/client/features/skills/skill-status.ts'

/** 中文命名空间翻译（mock 官方 Translate 的 {name} 插值，键缺失即失败）。 */
const zh = (key, params) => {
  const template = PROMPT_TOOL_DICTS.zh[key]
  if (template === undefined) throw new Error(`missing locale key: ${key}`)
  return template.replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? ''))
}

const skill = (overrides = {}) => ({
  id: 'user-dsh:D:\\skills:demo-skill',
  folder: 'demo-skill',
  dir: 'D:\\skills',
  name: 'demo-skill',
  description: 'Demo',
  source: 'user-dsh',
  rank: 400,
  valid: true,
  modelInvocable: true,
  userInvocable: true,
  path: 'D:\\skills\\demo-skill\\SKILL.md',
  ...overrides,
})

test('技能状态胶囊按 frontmatter 两端事实显示可用范围、逐端停用与同名遮蔽', () => {
  const both = zh('skills.status.callable', { audiences: `${zh('skills.status.audience.model')}/${zh('skills.status.audience.user')}` })
  assert.equal(skillStatusLabel(skill(), zh), both, '两端都可调用时列出两个受众')
  assert.equal(skillStatusLabel(skill({ modelInvocable: false }), zh), zh('skills.status.blockedModel'), '只关模型端：文案指向模型端')
  assert.equal(skillStatusLabel(skill({ userInvocable: false }), zh), zh('skills.status.blockedUser'), '只关用户端：文案指向用户端')
  assert.equal(skillStatusLabel(skill({ modelInvocable: false, userInvocable: false }), zh), zh('skills.status.blocked'), '两端都关才报整体停用')
  // 按端如实区分：只关一端时技能仍从另一端可用，不能笼统显示「已停用」，也不能退化成泛化的「不可调用」。
  assert.notEqual(skillStatusLabel(skill({ userInvocable: false }), zh), zh('skills.status.blocked'))
  assert.notEqual(skillStatusLabel(skill({ modelInvocable: false }), zh), zh('skills.status.blocked'))
  assert.notEqual(skillStatusLabel(skill({ userInvocable: false }), zh), zh('skills.status.blockedModel'))
  assert.notEqual(skillStatusLabel(skill({ modelInvocable: false, userInvocable: false }), zh), zh('skills.status.notCallable'))
  // 遮蔽提示只在两端都可调用时出现：逐端停用的文案更具体，优先表达（与色调、页签同一套谓词）。
  assert.equal(skillStatusLabel(skill({ winnerId: 'project-dsh:C:\\repo:.dsh:demo-skill' }), zh), zh('skills.status.shadowed'))
  assert.equal(skillStatusLabel(skill({ winnerId: 'x', userInvocable: false }), zh), zh('skills.status.blockedUser'), '逐端停用优先于遮蔽提示')
  // 无效技能先报无效：无效不参与调用策略叙事，没有可写的 frontmatter。
  assert.equal(skillStatusLabel(skill({ valid: false, issue: 'frontmatter 缺少 name' }), zh), zh('skills.status.invalid'))
  assert.equal(skillStatusLabel(skill({ valid: false, winnerId: 'x' }), zh), zh('skills.status.invalid'))
  assert.equal(skillStatusLabel(skill({ valid: false, modelInvocable: false, userInvocable: false }), zh), zh('skills.status.invalid'))
  assert.equal(skillStatusLabel(skill({ valid: false, modelInvocable: false }), zh), zh('skills.status.invalid'))
})

test('技能状态筛选区分模型、用户、两端不可用与全部', () => {
  const both = skill()
  const userOff = skill({ userInvocable: false })
  const modelOff = skill({ modelInvocable: false })
  const off = skill({ modelInvocable: false, userInvocable: false })
  const invalid = skill({ valid: false })

  assert.equal(matchesSkillStatus(invalid, 'all'), true)
  assert.equal(matchesSkillStatus(both, 'model'), true)
  assert.equal(matchesSkillStatus(modelOff, 'model'), false)
  assert.equal(matchesSkillStatus(both, 'user'), true)
  assert.equal(matchesSkillStatus(userOff, 'user'), false)
  assert.equal(matchesSkillStatus(off, 'blocked'), true)
  assert.equal(matchesSkillStatus(both, 'blocked'), false)
  assert.equal(matchesSkillStatus(off, 'model'), false, '两端都停用：模型端不可调用')
  assert.equal(matchesSkillStatus(off, 'user'), false, '两端都停用：用户也不可调用')
  assert.equal(matchesSkillStatus(modelOff, 'model'), false, '只关模型端：模型不可调用')
  assert.equal(matchesSkillStatus(modelOff, 'user'), true, '只关模型端：用户仍可调用')
  assert.equal(matchesSkillStatus(userOff, 'user'), false, '只关用户端：用户不可调用')
  assert.equal(matchesSkillStatus(userOff, 'model'), true, '只关用户端：模型仍可调用')
  // 「两端不可用」只收两端都不可用的技能：只关一端的技能留在「模型」或「用户」页签里。
  assert.equal(matchesSkillStatus(modelOff, 'blocked'), false)
  assert.equal(matchesSkillStatus(userOff, 'blocked'), false)
  // 插件写入的停用与技能自身声明的停用是同一个事实：两端都不可调用必然收进「两端不可用」，
  // 否则它只出现在「全部」里，用户会以为技能丢了。
  for (const candidate of [both, userOff, modelOff, off]) {
    assert.equal(['model', 'user', 'blocked'].some((tab) => matchesSkillStatus(candidate, tab)), true, '每个有效技能至少落在一个页签')
  }
  assert.equal(matchesSkillStatus(invalid, 'model'), false)
  assert.equal(matchesSkillStatus(invalid, 'user'), false)
  assert.equal(matchesSkillStatus(invalid, 'blocked'), false, '无效技能有自己的原因展示，不混进两端不可用')
})

test('开关往返：两端停用后仍能逐端恢复（这段曾被误判为死端）', () => {
  const bothOff = { modelInvocable: false, userInvocable: false }
  assert.equal(scopeAfterToggle(bothOff, 'model'), 'user', '点模型端 → 只停用用户端，模型端恢复')
  assert.equal(scopeAfterToggle(bothOff, 'user'), 'model', '点用户端 → 只停用模型端，用户端恢复')
  assert.equal(scopeAfterToggle({ modelInvocable: true, userInvocable: true }, 'model'), 'model')
  assert.equal(scopeAfterToggle({ modelInvocable: true, userInvocable: true }, 'user'), 'user')
  assert.equal(scopeAfterToggle({ modelInvocable: false, userInvocable: true }, 'user'), 'all', '再关用户端 → 两端都停用')
  assert.equal(scopeAfterToggle({ modelInvocable: true, userInvocable: false }, 'model'), 'all', '再关模型端 → 两端都停用')
  assert.equal(scopeAfterToggle({ modelInvocable: false, userInvocable: true }, 'model'), 'none', '再点模型端 → 完全恢复')

  // 参数不是「当前是否被屏蔽」而是「该端当前是否可调用」：四种组合 × 两端的全量往返，
  // 钉住「本端取反、另一端原样保持」，读错语义就会误以为某一端是死端。
  const states = [
    { modelInvocable: true, userInvocable: true },
    { modelInvocable: true, userInvocable: false },
    { modelInvocable: false, userInvocable: true },
    { modelInvocable: false, userInvocable: false },
  ]
  for (const state of states) {
    for (const side of ['model', 'user']) {
      const key = side === 'model' ? 'modelInvocable' : 'userInvocable'
      const other = side === 'model' ? 'userInvocable' : 'modelInvocable'
      const scope = scopeAfterToggle(state, side)
      const written = invocationForScope(scope)
      assert.equal(written[key], !state[key], `${side} 端被点击后取反`)
      assert.equal(written[other], state[other], `${side} 端被点击后另一端保持不变`)
      assert.equal(scopeOfInvocation(written), scope, '写回 frontmatter 后范围与目标一致')
    }
  }

  // 完整往返 none → model → all → user → none（scope 命名的是「不可调用」的那一端）：
  // 两端都停用不是死端，从 all 起两步即可逐端恢复。
  const clicks = [
    ['model', 'model', { modelInvocable: false, userInvocable: true }],
    ['user', 'all', { modelInvocable: false, userInvocable: false }],
    ['model', 'user', { modelInvocable: true, userInvocable: false }],
    ['user', 'none', { modelInvocable: true, userInvocable: true }],
  ]
  let state = { modelInvocable: true, userInvocable: true }
  for (const [side, expectedScope, expectedState] of clicks) {
    const scope = scopeAfterToggle(state, side)
    assert.equal(scope, expectedScope, `点 ${side} 端 → scope=${expectedScope}`)
    state = invocationForScope(scope)
    assert.deepEqual(state, expectedState, `scope=${expectedScope} 写回后的两端事实`)
  }
})

test('技能状态徽章色调：无效=红，遮蔽或两端不可用=灰，其余=绿', () => {
  assert.equal(skillStatusTone(skill({ valid: false })), 'danger')
  assert.equal(skillStatusTone(skill({ winnerId: 'project-dsh:C:\\repo:.dsh:demo-skill' })), 'neutral')
  assert.equal(skillStatusTone(skill({ modelInvocable: false, userInvocable: false })), 'neutral')
  assert.equal(skillStatusTone(skill({ modelInvocable: false })), 'success', '只关模型端仍有用户端可用')
  assert.equal(skillStatusTone(skill({ userInvocable: false })), 'success', '只关用户端仍有模型端可用')
  assert.equal(skillStatusTone(skill()), 'success')
})

test('生效、两端不可用与遮蔽判定：都以 frontmatter 两端事实为准', () => {
  assert.equal(skillEnabled(skill()), true)
  assert.equal(skillEnabled(skill({ userInvocable: false })), true, '只关用户端仍对模型端生效')
  assert.equal(skillEnabled(skill({ modelInvocable: false })), true, '只关模型端仍对用户端生效')
  assert.equal(skillEnabled(skill({ modelInvocable: false, userInvocable: false })), false)
  assert.equal(skillEnabled(skill({ valid: false })), false)
  // skillUnavailable 是页面上 data-blocked 的唯一判据：只在两端都不可用时为真。
  assert.equal(skillUnavailable(skill()), false)
  assert.equal(skillUnavailable(skill({ modelInvocable: false })), false, '只关模型端不算两端不可用')
  assert.equal(skillUnavailable(skill({ userInvocable: false })), false, '只关用户端不算两端不可用')
  assert.equal(skillUnavailable(skill({ modelInvocable: false, userInvocable: false })), true)
  assert.equal(skillUnavailable(skill({ valid: false, modelInvocable: false, userInvocable: false })), false, '无效技能走无效展示，不算两端不可用')
  assert.equal(skillShadowed(skill({ winnerId: 'project-dsh:C:\\repo:.dsh:demo-skill' })), true)
  assert.equal(skillShadowed(skill()), false)
  assert.equal(skillShadowed(skill({ winnerId: 'x', modelInvocable: false, userInvocable: false })), false, '两端不可用已优先表达，不重复报遮蔽')
  assert.equal(skillShadowed(skill({ winnerId: 'x', valid: false })), false)
})

test('来源分组：顺序与官方优先级一致，空分组不返回，组内按技能名排序', () => {
  const catalog = [
    skill({ id: 'user-dsh:z', name: 'zeta', source: 'user-dsh', rank: 400 }),
    skill({ id: 'bundled:b', name: 'bundled-one', source: 'bundled', rank: 600 }),
    skill({ id: 'project-dsh:p', name: 'project-one', source: 'project-dsh', rank: 100 }),
    skill({ id: 'user-dsh:a', name: 'alpha', source: 'user-dsh', rank: 400 }),
    skill({ id: 'custom:c', name: 'referenced-one', source: 'custom', rank: 300 }),
  ]
  const groups = groupBySource(catalog)
  assert.deepEqual(groups.map((group) => group.source), ['project-dsh', 'custom', 'user-dsh', 'bundled'])
  assert.deepEqual(groups.map((group) => group.rank), [100, 300, 400, 600])
  assert.deepEqual(groups.find((group) => group.source === 'user-dsh').skills.map((item) => item.name), ['alpha', 'zeta'])
  assert.deepEqual(groupBySource([]), [], '没有技能时不产生空分组')
})
