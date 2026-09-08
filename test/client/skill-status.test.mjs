import test from 'node:test'
import assert from 'node:assert/strict'
import { matchesSkillStatus, skillStatusLabel, skillStatusTone } from '../../src/client/features/skills/skill-status.ts'

const skill = (overrides = {}) => ({
  folder: 'demo-skill',
  name: 'demo-skill',
  description: 'Demo',
  valid: true,
  modelInvocable: true,
  userInvocable: true,
  ...overrides,
})

test('技能状态胶囊显示模型/用户调用范围与开关状态', () => {
  assert.equal(skillStatusLabel(skill(), true), '可调用:模型/用户')
  assert.equal(skillStatusLabel(skill({ userInvocable: false }), true), '可调用:模型')
  assert.equal(skillStatusLabel(skill({ modelInvocable: false }), true), '可调用:用户')
  assert.equal(skillStatusLabel(skill({ modelInvocable: false, userInvocable: false }), true), '不可调用')
  assert.equal(skillStatusLabel(skill(), false), '已禁用')
  assert.equal(skillStatusLabel(skill({ valid: false }), true), '未注册')
})

test('技能状态筛选区分模型、用户、已禁用与全部', () => {
  const both = skill()
  const modelOnly = skill({ userInvocable: false })
  const userOnly = skill({ modelInvocable: false })
  const disabled = skill()
  const invalid = skill({ valid: false })

  assert.equal(matchesSkillStatus(invalid, true, 'all'), true)
  assert.equal(matchesSkillStatus(both, true, 'model'), true)
  assert.equal(matchesSkillStatus(userOnly, true, 'model'), false)
  assert.equal(matchesSkillStatus(both, true, 'user'), true)
  assert.equal(matchesSkillStatus(modelOnly, true, 'user'), false)
  assert.equal(matchesSkillStatus(disabled, false, 'disabled'), true)
  assert.equal(matchesSkillStatus(disabled, true, 'disabled'), false)
  assert.equal(matchesSkillStatus(invalid, true, 'disabled'), false)
})

test('技能状态徽章色调随注册、开关与调用范围变化', () => {
  assert.equal(skillStatusTone(skill({ valid: false }), true), 'danger')
  assert.equal(skillStatusTone(skill(), false), 'neutral')
  assert.equal(skillStatusTone(skill({ modelInvocable: false, userInvocable: false }), true), 'neutral')
  assert.equal(skillStatusTone(skill({ modelInvocable: false }), true), 'success')
  assert.equal(skillStatusTone(skill({ userInvocable: false }), true), 'success')
  assert.equal(skillStatusTone(skill(), true), 'success')
})
