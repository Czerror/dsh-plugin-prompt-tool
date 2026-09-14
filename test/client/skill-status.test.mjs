import test from 'node:test'
import assert from 'node:assert/strict'
import { PROMPT_TOOL_DICTS } from '../../src/client/locales.ts'
import { filterSkillCatalog, matchesSkillStatus, skillStatusLabel, skillStatusTone } from '../../src/client/features/skills/skill-status.ts'

/** 中文命名空间翻译（mock 官方 Translate 的 {name} 插值，键缺失即失败）。 */
const zh = (key, params) => {
  const template = PROMPT_TOOL_DICTS.zh[key]
  if (template === undefined) throw new Error(`missing locale key: ${key}`)
  return template.replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? ''))
}

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
  assert.equal(skillStatusLabel(skill(), true, zh), '可调用:模型/用户')
  assert.equal(skillStatusLabel(skill({ userInvocable: false }), true, zh), '可调用:模型')
  assert.equal(skillStatusLabel(skill({ modelInvocable: false }), true, zh), '可调用:用户')
  assert.equal(skillStatusLabel(skill({ modelInvocable: false, userInvocable: false }), true, zh), '不可调用')
  assert.equal(skillStatusLabel(skill(), false, zh), '已禁用')
  assert.equal(skillStatusLabel(skill({ valid: false }), true, zh), '未注册')
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

test('技能筛选保留命中项的祖先，子技能单独命中不丢行', () => {
  const catalog = [
    skill({ folder: 'parent', name: 'parent' }),
    skill({ folder: 'parent/child', name: 'special-child' }),
    skill({ folder: 'other', name: 'other' }),
  ]
  // 只有子技能命中：父节点保留为树容器，否则顶层展开会丢弃该行。
  const onlyChild = filterSkillCatalog(catalog, (item) => item.name === 'special-child')
  assert.deepEqual(onlyChild.map((item) => item.folder), ['parent', 'parent/child'])
  // 父节点命中：只保留父（子不匹配不进结果）。
  const onlyParent = filterSkillCatalog(catalog, (item) => item.folder === 'parent')
  assert.deepEqual(onlyParent.map((item) => item.folder), ['parent'])
  // 无命中返回空（页面走 noMatch 分支）。
  assert.deepEqual(filterSkillCatalog(catalog, () => false), [])
  // 多级嵌套：命中孙节点时逐级保留祖先。
  const nested = [
    skill({ folder: 'a', name: 'a' }),
    skill({ folder: 'a/b', name: 'b' }),
    skill({ folder: 'a/b/c', name: 'deep-hit' }),
  ]
  assert.deepEqual(
    filterSkillCatalog(nested, (item) => item.name === 'deep-hit').map((item) => item.folder),
    ['a', 'a/b', 'a/b/c'],
  )
})
