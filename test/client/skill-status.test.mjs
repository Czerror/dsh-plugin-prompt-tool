// 技能状态展示与来源分组（注册层屏蔽模型）。
// 随注册层屏蔽模型移除：技能树 / 嵌套祖先筛选（buildSkillTree、filterSkillCatalog）与
//  skillIdOf / skillParentOf 身份解析——新模型按官方一层发现只认 `<根>/<目录名>/SKILL.md`，
//  folder 不再是可嵌套的路径身份，同名遮蔽由来源优先级裁决，页面上不再有树与拖拽排序。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PROMPT_TOOL_DICTS } from '../../src/client/locales.ts'
import {
  groupBySource,
  matchesSkillStatus,
  scopeAfterToggle,
  skillEnabled,
  skillShadowed,
  skillStatusLabel,
  skillStatusTone,
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
  blocked: false,
  modelInvocable: true,
  userInvocable: true,
  ...overrides,
})

test('技能状态胶囊显示注册层屏蔽、同名遮蔽与模型/用户调用范围', () => {
  const both = zh('skills.status.callable', { audiences: `${zh('skills.status.audience.model')}/${zh('skills.status.audience.user')}` })
  assert.equal(skillStatusLabel(skill(), zh), both)
  assert.equal(skillStatusLabel(skill({ userInvocable: false }), zh), zh('skills.status.callable', { audiences: zh('skills.status.audience.model') }))
  assert.equal(skillStatusLabel(skill({ modelInvocable: false }), zh), zh('skills.status.callable', { audiences: zh('skills.status.audience.user') }))
  assert.equal(skillStatusLabel(skill({ modelInvocable: false, userInvocable: false }), zh), zh('skills.status.notCallable'))
  // 注册层屏蔽优先于 frontmatter 的调用范围：影子候选压掉官方候选。
  // 文案按端区分：只关一端时技能仍从另一端可用，不能笼统显示「已停用」。
  assert.equal(skillStatusLabel(skill({ blocked: true, blockedModel: true, blockedUser: true }), zh), zh('skills.status.blocked'))
  assert.equal(skillStatusLabel(skill({ blocked: true, blockedModel: true }), zh), zh('skills.status.blockedModel'))
  assert.equal(skillStatusLabel(skill({ blocked: true, blockedUser: true }), zh), zh('skills.status.blockedUser'))
  assert.equal(skillStatusLabel(skill({ blocked: true, blockedModel: true, blockedUser: true, modelInvocable: false }), zh), zh('skills.status.blocked'))
  assert.equal(skillStatusLabel(skill({ winnerId: 'project-dsh:C:\\repo:.dsh:demo-skill' }), zh), zh('skills.status.shadowed'))
  assert.equal(skillStatusLabel(skill({ valid: false, issue: 'frontmatter 缺少 name' }), zh), zh('skills.status.invalid'))
  assert.equal(skillStatusLabel(skill({ valid: false, winnerId: 'x' }), zh), zh('skills.status.invalid'), '无效技能先报无效')
  assert.equal(skillStatusLabel(skill({ valid: false, blocked: true }), zh), zh('skills.status.invalid'))
})

test('技能状态筛选区分模型、用户、已停用与全部', () => {
  const both = skill()
  const modelOnly = skill({ userInvocable: false })
  const userOnly = skill({ modelInvocable: false })
  const blocked = skill({ blocked: true, blockedModel: true, blockedUser: true })
  const modelBlocked = skill({ blocked: true, blockedModel: true })
  const userBlocked = skill({ blocked: true, blockedUser: true })
  const invalid = skill({ valid: false })

  assert.equal(matchesSkillStatus(invalid, 'all'), true)
  assert.equal(matchesSkillStatus(both, 'model'), true)
  assert.equal(matchesSkillStatus(userOnly, 'model'), false)
  assert.equal(matchesSkillStatus(both, 'user'), true)
  assert.equal(matchesSkillStatus(modelOnly, 'user'), false)
  assert.equal(matchesSkillStatus(blocked, 'blocked'), true)
  assert.equal(matchesSkillStatus(both, 'blocked'), false)
  assert.equal(matchesSkillStatus(blocked, 'model'), false, '两端都屏蔽：模型不可调用')
  assert.equal(matchesSkillStatus(blocked, 'user'), false, '两端都屏蔽：用户也不可调用')
  assert.equal(matchesSkillStatus(modelBlocked, 'model'), false, '只屏蔽模型端：模型不可调用')
  assert.equal(matchesSkillStatus(modelBlocked, 'user'), true, '只屏蔽模型端：用户仍可调用')
  assert.equal(matchesSkillStatus(userBlocked, 'user'), false, '只屏蔽用户端：用户不可调用')
  assert.equal(matchesSkillStatus(userBlocked, 'model'), true, '只屏蔽用户端：模型仍可调用')
  // 「不可用」只收两端都不可用的技能：只关一端的技能留在「模型」或「用户」页签里。
  assert.equal(matchesSkillStatus(modelBlocked, 'blocked'), false)
  assert.equal(matchesSkillStatus(userBlocked, 'blocked'), false)
  // 技能自身声明两端都不可调用时也要收进「不可用」，否则它只出现在「全部」，用户会以为技能丢了。
  const declaredOff = skill({ modelInvocable: false, userInvocable: false })
  assert.equal(matchesSkillStatus(declaredOff, 'blocked'), true)
  assert.equal(matchesSkillStatus(declaredOff, 'model'), false)
  assert.equal(matchesSkillStatus(declaredOff, 'user'), false)
  for (const candidate of [both, modelOnly, userOnly, blocked, modelBlocked, userBlocked, declaredOff]) {
    assert.equal(['model', 'user', 'blocked'].some((tab) => matchesSkillStatus(candidate, tab)), true, '每个有效技能至少落在一个页签')
  }
  assert.equal(matchesSkillStatus(invalid, 'model'), false)
  assert.equal(matchesSkillStatus(invalid, 'blocked'), false, '无效技能有自己的原因展示，不混进不可用')
})

test('开关往返：两端屏蔽后仍能逐端恢复（这段曾被误判为死端）', () => {
  const both = { blockedModel: true, blockedUser: true }
  assert.equal(scopeAfterToggle(both, 'model'), 'user', '点模型端 → 只屏蔽用户端，模型端恢复')
  assert.equal(scopeAfterToggle(both, 'user'), 'model', '点用户端 → 只屏蔽模型端，用户端恢复')
  assert.equal(scopeAfterToggle({ blockedModel: false, blockedUser: false }, 'model'), 'model')
  assert.equal(scopeAfterToggle({ blockedModel: false, blockedUser: false }, 'user'), 'user')
  assert.equal(scopeAfterToggle({ blockedModel: true, blockedUser: false }, 'user'), 'all', '再关用户端 → 两端都屏蔽')
  assert.equal(scopeAfterToggle({ blockedModel: false, blockedUser: true }, 'model'), 'all', '再关模型端 → 两端都屏蔽')
  assert.equal(scopeAfterToggle({ blockedModel: true, blockedUser: false }, 'model'), 'none', '再点模型端 → 完全恢复')
})

test('技能状态徽章色调随注册、屏蔽、遮蔽与调用范围变化', () => {
  assert.equal(skillStatusTone(skill({ valid: false })), 'danger')
  assert.equal(skillStatusTone(skill({ blocked: true })), 'neutral')
  assert.equal(skillStatusTone(skill({ winnerId: 'project-dsh:C:\\repo:.dsh:demo-skill' })), 'neutral')
  assert.equal(skillStatusTone(skill({ modelInvocable: false, userInvocable: false })), 'neutral')
  assert.equal(skillStatusTone(skill({ modelInvocable: false })), 'success')
  assert.equal(skillStatusTone(skill({ userInvocable: false })), 'success')
  assert.equal(skillStatusTone(skill()), 'success')
})

test('生效与遮蔽判定：屏蔽或无效的技能不参与同名遮蔽提示', () => {
  assert.equal(skillEnabled(skill()), true)
  assert.equal(skillEnabled(skill({ blocked: true })), false)
  assert.equal(skillEnabled(skill({ valid: false })), false)
  assert.equal(skillShadowed(skill({ winnerId: 'project-dsh:C:\\repo:.dsh:demo-skill' })), true)
  assert.equal(skillShadowed(skill()), false)
  assert.equal(skillShadowed(skill({ winnerId: 'x', blocked: true })), false, '屏蔽已优先表达，不重复报遮蔽')
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
