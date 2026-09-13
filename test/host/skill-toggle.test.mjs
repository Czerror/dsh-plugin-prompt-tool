import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 隔离 DSH_HOME：被导入模块的路径常量在加载时解析。
const home = mkdtempSync(join(tmpdir(), 'pt-skill-toggle-home-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = home
after(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})

// 直接验证源码（隐藏策略是文件层约定，不需要构建产物）。
const { DISABLED_SUFFIX, SKILL_MARKER, setSkillEnabled } = await import('../../src/host/skill-toggle.ts')
const { readSkills } = await import('../../src/runtime/skills-provider.ts')

const root = join(home, 'skills')

function writeSkill(folder, name) {
  const dir = join(root, folder)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, SKILL_MARKER), `---\nname: ${name}\ndescription: demo\n---\nbody\n`, 'utf8')
}

test('停用 = 标记改名 SKILL.md.disabled，启用 = 改回（两次幂等）', () => {
  writeSkill('demo-skill', 'demo-skill')
  const disabled = setSkillEnabled(root, 'demo-skill', false)
  assert.equal(disabled.ok, true)
  assert.equal(disabled.changed, true)
  assert.equal(existsSync(join(root, 'demo-skill', SKILL_MARKER)), false, '停用后 SKILL.md 必须不存在（官方扫描同步失效）')
  assert.equal(existsSync(join(root, 'demo-skill', SKILL_MARKER + DISABLED_SUFFIX)), true)

  // 扫描层仍可见停用条目（管理界面要能重新启用），但带 disabled 标记。
  const entries = readSkills(root)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].disabled, true)
  assert.equal(entries[0].valid, true)

  const again = setSkillEnabled(root, 'demo-skill', false)
  assert.equal(again.ok, true)
  assert.equal(again.changed, false, '重复停用不产生动作')

  const enabled = setSkillEnabled(root, 'demo-skill', true)
  assert.equal(enabled.changed, true)
  assert.equal(existsSync(join(root, 'demo-skill', SKILL_MARKER)), true)
  assert.equal(existsSync(join(root, 'demo-skill', SKILL_MARKER + DISABLED_SUFFIX)), false)
  assert.equal(readSkills(root)[0].disabled, undefined)
})

test('嵌套技能与非 kebab 目录名按相对路径启停', () => {
  writeSkill('group/child-skill', 'child-skill')
  const result = setSkillEnabled(root, 'group/child-skill', false)
  assert.equal(result.ok, true)
  assert.equal(existsSync(join(root, 'group', 'child-skill', SKILL_MARKER + DISABLED_SUFFIX)), true)
  setSkillEnabled(root, 'group/child-skill', true)
  assert.equal(existsSync(join(root, 'group', 'child-skill', SKILL_MARKER)), true)
})

test('两边标记同时存在判冲突，不擅自删除任何一份', () => {
  writeSkill('conflict-skill', 'conflict-skill')
  writeFileSync(join(root, 'conflict-skill', SKILL_MARKER + DISABLED_SUFFIX), 'stale', 'utf8')
  const result = setSkillEnabled(root, 'conflict-skill', false)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'conflict')
  assert.equal(existsSync(join(root, 'conflict-skill', SKILL_MARKER)), true)
  assert.equal(existsSync(join(root, 'conflict-skill', SKILL_MARKER + DISABLED_SUFFIX)), true)
})

test('越界与不存在的目标拒绝操作', () => {
  assert.equal(setSkillEnabled(root, '../escape', false).code, 'invalid-target')
  assert.equal(setSkillEnabled(root, 'C:/windows', false).code, 'invalid-target')
  assert.equal(setSkillEnabled(root, 'group/../escape', false).code, 'invalid-target')
  assert.equal(setSkillEnabled(root, 'missing-skill', false).code, 'not-found')
})
