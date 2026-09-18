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
import {
  groupBySource,
  matchesSkillStatus,
  policyAfterToggle,
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
  availability: 'active',
  modelInvocable: true,
  userInvocable: true,
  path: 'D:\\skills\\demo-skill\\SKILL.md',
  ...overrides,
})

test('技能状态胶囊按 frontmatter 两端事实显示可用范围与同名遮蔽', () => {
  const both = zh('skills.status.callable', { audiences: `${zh('skills.status.audience.model')}/${zh('skills.status.audience.user')}` })
  assert.equal(skillStatusLabel(skill(), zh), both, '两端都可调用时列出两个受众')
  // 只关一端时报【仍可用的那一端】：状态行要回答「现在还能怎么用」，而不是复述被关掉的
  // 那一端——后者会让一端仍可用的技能读起来像坏了。
  const userOnly = zh('skills.status.callable', { audiences: zh('skills.status.audience.user') })
  const modelOnly = zh('skills.status.callable', { audiences: zh('skills.status.audience.model') })
  assert.equal(skillStatusLabel(skill({ modelInvocable: false }), zh), userOnly, '只关模型端：列出仍可用的用户端')
  assert.equal(skillStatusLabel(skill({ userInvocable: false }), zh), modelOnly, '只关用户端：列出仍可用的模型端')
  assert.equal(skillStatusLabel(skill({ modelInvocable: false, userInvocable: false }), zh), zh('skills.status.blocked'), '两端都关才报整体停用')
  // 按端如实区分：只关一端时技能仍从另一端可用，不能笼统显示「已停用」。
  assert.notEqual(skillStatusLabel(skill({ userInvocable: false }), zh), zh('skills.status.blocked'))
  assert.notEqual(skillStatusLabel(skill({ modelInvocable: false }), zh), zh('skills.status.blocked'))
  assert.notEqual(skillStatusLabel(skill({ modelInvocable: false, userInvocable: false }), zh), zh('skills.status.notCallable'))
  assert.equal(skillStatusLabel(skill({ availability: 'shadowed', winnerId: 'project-dsh:C:\\repo:.dsh:demo-skill' }), zh), zh('skills.status.shadowed'))
  assert.equal(skillStatusLabel(skill({ availability: 'shadowed', winnerId: 'x', userInvocable: false }), zh), zh('skills.status.shadowed'), '注册状态与文件声明分开表达')
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

test('调用策略开关只提交点击端，不携带另一端快照', () => {
  const states = [
    { modelInvocable: true, userInvocable: true },
    { modelInvocable: true, userInvocable: false },
    { modelInvocable: false, userInvocable: true },
    { modelInvocable: false, userInvocable: false },
  ]
  for (const state of states) {
    for (const side of ['model', 'user']) {
      const key = side === 'model' ? 'modelInvocable' : 'userInvocable'
      assert.deepEqual(policyAfterToggle(state, side), { side, enabled: !state[key] })
    }
  }

})

test('技能状态徽章色调：无效=红，遮蔽或两端不可用=灰，其余=绿', () => {
  assert.equal(skillStatusTone(skill({ valid: false })), 'danger')
  assert.equal(skillStatusTone(skill({ availability: 'shadowed', winnerId: 'project-dsh:C:\\repo:.dsh:demo-skill' })), 'neutral')
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
  assert.equal(skillShadowed(skill({ availability: 'shadowed', winnerId: 'project-dsh:C:\\repo:.dsh:demo-skill' })), true)
  assert.equal(skillShadowed(skill()), false)
  assert.equal(skillShadowed(skill({ availability: 'shadowed', winnerId: 'x', modelInvocable: false, userInvocable: false })), true, '关闭文件调用策略不改变会话遮蔽事实')
  assert.equal(skillShadowed(skill({ winnerId: 'x', valid: false })), false)
})

test('注册表缺乏观测不否认可扫描到的技能：availability 缺省即视为生效', () => {
  // 文件系统扫描是技能的唯一事实源，注册表只补充同名遮蔽结论。注册表读不到（缺省）时
  // 技能照旧可调用，页面不得因此打出「未注册」「未确认」这类把观测缺失说成不可用的状态。
  const entry = skill({ availability: undefined, canSetPolicy: true, canDelete: true })
  assert.equal(skillEnabled(entry), true)
  assert.equal(matchesSkillStatus(entry, 'model'), true)
  assert.equal(matchesSkillStatus(entry, 'user'), true)
  assert.equal(skillStatusTone(entry), 'success')
  assert.equal(skillShadowed(entry), false)
  assert.equal(skillStatusLabel(entry, zh), zh('skills.status.callable', {
    audiences: `${zh('skills.status.audience.model')}/${zh('skills.status.audience.user')}`,
  }))
  assert.deepEqual(policyAfterToggle(entry, 'model'), { side: 'model', enabled: false }, '观测缺失不妨碍文件调用策略操作')
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
