import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { createManagedSkill, deleteManagedSkill } = await import('../../src/host/skills-actions.ts')

test('createManagedSkill 物化到 .system 并创建链接', () => {
  const root = mkdtempSync(join(tmpdir(), 'pt-actions-'))
  try {
    const created = createManagedSkill(root, { name: 'demo-skill', description: 'demo', content: 'body' })
    assert.equal(created.ok, true, created.message)
    assert.equal(existsSync(join(root, '.system', 'demo-skill', 'SKILL.md')), true)
    assert.equal(lstatSync(join(root, 'demo-skill')).isSymbolicLink(), true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('importSkillsPackage 支持无顶层容器的单技能包', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pt-actions-'))
  try {
    const { importSkillsPackage } = await import('../../src/host/skills-import.ts')
    const result = importSkillsPackage(root, [{ path: 'SKILL.md', content: Buffer.from('---\nname: one-skill\ndescription: one\n---\nbody').toString('base64') }])
    assert.equal(result.ok, true, result.message)
    assert.equal(existsSync(join(root, '.system', 'one-skill', 'SKILL.md')), true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('deleteManagedSkill 只移走标记并留下可恢复回收站记录', () => {
  const root = mkdtempSync(join(tmpdir(), 'pt-actions-'))
  try {
    mkdirSync(join(root, '.system', 'demo-skill', 'assets'), { recursive: true })
    writeFileSync(join(root, '.system', 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: demo\n---\nbody')
    const created = createManagedSkill(root, { name: 'demo-skill', description: 'demo', content: 'body' })
    assert.equal(created.ok, false, '未登记实体不能被创建覆盖')
    // 先注册后删除，验证删除只处理标记文件。
    const config = join(root, '.system', 'skills.yml')
    mkdirSync(join(root, '.system'), { recursive: true })
    writeFileSync(config, 'version: 2\nskills:\n  demo-skill:\n    path: demo-skill\n    link: demo-skill\n    enabled: true\n    modelInvocable: true\n    userInvocable: true\n')
    const deleted = deleteManagedSkill(root, 'demo-skill')
    assert.equal(deleted.ok, true, deleted.message)
    if (deleted.ok) assert.equal(existsSync(join(deleted.path, 'record.json')), true)
    assert.equal(existsSync(join(root, '.system', 'demo-skill', 'assets')), true)
    assert.equal(existsSync(join(root, '.system', 'demo-skill', 'SKILL.md')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
