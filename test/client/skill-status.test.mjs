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
  assert.equal(skillStatusLabel(skill({ blocked: true }), zh), zh('skills.status.blocked'))
  assert.equal(skillStatusLabel(skill({ blocked: true, modelInvocable: false }), zh), zh('skills.status.blocked'))
  assert.equal(skillStatusLabel(skill({ winnerId: 'project-dsh:C:\\repo:.dsh:demo-skill' }), zh), zh('skills.status.shadowed'))
  assert.equal(skillStatusLabel(skill({ valid: false, issue: 'frontmatter 缺少 name' }), zh), zh('skills.status.invalid'))
  assert.equal(skillStatusLabel(skill({ valid: false, winnerId: 'x' }), zh), zh('skills.status.invalid'), '无效技能先报无效')
  assert.equal(skillStatusLabel(skill({ valid: false, blocked: true }), zh), zh('skills.status.invalid'))
})

test('技能状态筛选区分模型、用户、已停用与全部', () => {
  const both = skill()
  const modelOnly = skill({ userInvocable: false })
  const userOnly = skill({ modelInvocable: false })
  const blocked = skill({ blocked: true })
  const invalid = skill({ valid: false })

  assert.equal(matchesSkillStatus(invalid, 'all'), true)
  assert.equal(matchesSkillStatus(both, 'model'), true)
  assert.equal(matchesSkillStatus(userOnly, 'model'), false)
  assert.equal(matchesSkillStatus(both, 'user'), true)
  assert.equal(matchesSkillStatus(modelOnly, 'user'), false)
  assert.equal(matchesSkillStatus(blocked, 'blocked'), true)
  assert.equal(matchesSkillStatus(both, 'blocked'), false)
  assert.equal(matchesSkillStatus(blocked, 'model'), false, '屏蔽后模型不可调用')
  assert.equal(matchesSkillStatus(blocked, 'user'), false, '屏蔽后用户也不可调用')
  assert.equal(matchesSkillStatus(invalid, 'model'), false)
  assert.equal(matchesSkillStatus(invalid, 'blocked'), false, '无效不等于被屏蔽')
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
