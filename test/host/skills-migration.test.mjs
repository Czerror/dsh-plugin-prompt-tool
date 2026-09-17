import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

const migration = await import('../../scripts/migrate-skills.mjs')

test('技能迁移默认预览，apply 保留备份并可按哈希回滚', () => {
  const root = mkdtempSync(join(tmpdir(), 'pt-migration-'))
  try {
    // 旧布局：状态配置在 .system/prompt-tool/config.yml，技能是 skills 根的普通目录。
    mkdirSync(join(root, '.system', 'prompt-tool'), { recursive: true })
    writeFileSync(join(root, '.system', 'prompt-tool', 'config.yml'), 'order: [demo-skill, missing]\nrankBase: 10\n')
    mkdirSync(join(root, 'demo-skill', 'references', 'child'), { recursive: true })
    writeFileSync(join(root, 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: demo\n---\nbody')
    writeFileSync(join(root, 'demo-skill', 'references', 'child', 'SKILL.md'), '---\nname: child\ndescription: child\n---\nbody')
    writeFileSync(join(root, 'demo-skill', 'references', 'doc.md'), 'resource')
    mkdirSync(join(root, 'artifacts'))
    writeFileSync(join(root, 'artifacts', 'note.txt'), 'keep')
    writeFileSync(join(root, '.prompt-tool-manifest.json'), '{"version":1,"deployed":{}}')

    const preview = migration.planMigration(root)
    assert.deepEqual(preview.skills.map((skill) => skill.id), ['demo-skill', 'demo-skill/references/child'], '嵌套技能各自成为一条受管记录')
    assert.deepEqual(preview.order, ['demo-skill'], '旧顺序中已不存在的技能被过滤')
    assert.equal(preview.rankBase, 10)
    assert.equal(existsSync(join(root, '.system', 'skills.yml')), false, '预览零写入')

    const applied = migration.applyMigration(root)
    assert.equal(readFileSync(join(root, '.system', 'demo-skill', 'SKILL.md'), 'utf8').includes('demo-skill'), true)
    assert.equal(readFileSync(join(root, '.system', 'demo-skill', 'references', 'doc.md'), 'utf8'), 'resource', '资源随技能包迁移')
    assert.equal(lstatSync(join(root, 'demo-skill')).isSymbolicLink(), true, '顶层技能通过根链接暴露')
    assert.equal(lstatSync(join(root, 'demo-skill--references--child')).isSymbolicLink(), true, '嵌套技能同样需要自己的根链接')
    assert.equal(existsSync(join(root, 'artifacts', 'note.txt')), true, '非技能目录不动')
    assert.equal(existsSync(join(root, '.prompt-tool-manifest.json')), true, '旧账本保留原样，不迁移也不删除')
    assert.equal(existsSync(join(root, '.system', 'prompt-tool', 'config.yml')), true, '旧配置保留供人工核对')
    assert.equal(existsSync(join(applied.backup, 'demo-skill', 'references', 'child', 'SKILL.md')), true, '迁移前完整备份')

    const config = parseYaml(readFileSync(join(root, '.system', 'skills.yml'), 'utf8'))
    assert.deepEqual(Object.keys(config.skills).sort(), ['demo-skill', 'demo-skill/references/child'])
    assert.equal(config.skills['demo-skill'].link, 'demo-skill')
    assert.equal(config.skills['demo-skill'].enabled, true)
    assert.equal(config.skills['demo-skill/references/child'].link, 'demo-skill--references--child')
    assert.equal(config.skills['demo-skill/references/child'].path, 'demo-skill/references/child')
    assert.deepEqual(config.order, ['demo-skill'])
    assert.equal(config.rankBase, 10)

    assert.throws(() => migration.applyMigration(root), /已存在|未找到/, '重复迁移拒绝覆盖既有状态')

    migration.rollbackMigration(applied.record)
    assert.equal(existsSync(join(root, 'demo-skill', 'SKILL.md')), true, '实体回到原路径')
    assert.equal(existsSync(join(root, 'demo-skill--references--child')), false, '嵌套链接一并清除')
    assert.equal(existsSync(join(root, '.system', 'demo-skill')), false)
    assert.equal(existsSync(join(root, '.system', 'skills.yml')), false, '回滚删除本次创建的状态文件')
    assert.equal(existsSync(join(root, '.system', 'prompt-tool', 'config.yml')), true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
