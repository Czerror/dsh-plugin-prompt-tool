import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

// 直接验证源码，受管技能启停不依赖构建产物。
const { SKILL_MARKER, setSkillEnabled } = await import('../../src/host/skill-toggle.ts')
const { updateSkillsLibrary } = await import('../../src/host/skills-library.ts')

const root = join(home, 'skills')

function writeSkill(folder, name, link = folder.replaceAll('/', '-')) {
  const dir = join(root, '.system', folder)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, SKILL_MARKER), `---\nname: ${name}\ndescription: demo\n---\nbody\n`, 'utf8')
  const result = updateSkillsLibrary(root, (config) => {
    config.skills[folder] = { path: folder, link, enabled: true, modelInvocable: true, userInvocable: true }
    return config
  })
  assert.equal(result.ok, true, result.message)
}

test('停用仅取消链接，启用恢复链接；实体正文与文件名不变且重复操作幂等', () => {
  writeSkill('demo-skill', 'demo-skill')
  const marker = join(root, '.system', 'demo-skill', SKILL_MARKER)
  const original = readFileSync(marker, 'utf8')
  const disabled = setSkillEnabled(root, 'demo-skill', false)
  assert.equal(disabled.ok, true)
  assert.equal(disabled.changed, true)
  assert.equal(existsSync(join(root, 'demo-skill')), false)
  assert.equal(existsSync(marker), true)
  assert.equal(existsSync(`${marker}.disabled`), false)
  assert.equal(disabled.file, marker)

  const again = setSkillEnabled(root, 'demo-skill', false)
  assert.equal(again.ok, true)
  assert.equal(again.changed, false, '重复停用不产生动作')

  const enabled = setSkillEnabled(root, 'demo-skill', true)
  assert.equal(enabled.changed, true)
  assert.equal(lstatSync(join(root, 'demo-skill')).isSymbolicLink(), true)
  assert.equal(readFileSync(marker, 'utf8'), original)
  assert.equal(setSkillEnabled(root, 'demo-skill', true).changed, false)
})

test('嵌套技能使用稳定身份定位独立链接', () => {
  writeSkill('group/child-skill', 'child-skill')
  const result = setSkillEnabled(root, 'group/child-skill', false)
  assert.equal(result.ok, true)
  assert.equal(existsSync(join(root, 'group-child-skill')), false)
  assert.equal(existsSync(join(root, '.system', 'group', 'child-skill', SKILL_MARKER)), true)
  setSkillEnabled(root, 'group/child-skill', true)
  assert.equal(existsSync(join(root, 'group-child-skill', SKILL_MARKER)), true)
})

test('链接被替换为其他来源后拒绝操作，保留双方文件', () => {
  writeSkill('conflict-skill', 'conflict-skill')
  const outside = join(home, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, SKILL_MARKER), 'unmanaged')
  rmSync(join(root, 'conflict-skill'))
  symlinkSync(outside, join(root, 'conflict-skill'), 'junction')
  const result = setSkillEnabled(root, 'conflict-skill', false)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'conflict')
  assert.equal(existsSync(join(root, '.system', 'conflict-skill', SKILL_MARKER)), true)
  assert.equal(readFileSync(join(outside, SKILL_MARKER), 'utf8'), 'unmanaged')
})

test('越界与不存在的目标拒绝操作', () => {
  assert.equal(setSkillEnabled(root, '../escape', false).code, 'invalid-target')
  assert.equal(setSkillEnabled(root, 'C:/windows', false).code, 'invalid-target')
  assert.equal(setSkillEnabled(root, 'group/../escape', false).code, 'invalid-target')
  assert.equal(setSkillEnabled(root, 'missing-skill', false).code, 'not-found')
  const unmanaged = join(root, 'unmanaged')
  mkdirSync(unmanaged)
  writeFileSync(join(unmanaged, SKILL_MARKER), 'user skill')
  assert.equal(setSkillEnabled(root, 'unmanaged', false).code, 'not-found')
  assert.equal(readFileSync(join(unmanaged, SKILL_MARKER), 'utf8'), 'user skill')
})
