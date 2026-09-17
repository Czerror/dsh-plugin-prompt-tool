import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'pt-skills-config-home-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = home
after(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})

const { defaultSkillsConfig, readSkillsConfig, skillsConfigPath, writeSkillsConfig } =
  await import('../../src/host/skills-config.ts')

function configFile(name) {
  const dir = join(home, name)
  mkdirSync(dir)
  return join(dir, 'skills.yml')
}

test('配置文件缺失时回退默认值（默认技能根 + 默认 rank 基数）', () => {
  const file = skillsConfigPath()
  assert.equal(existsSync(file), false)
  const read = readSkillsConfig(file)
  assert.equal(read.ok, true)
  assert.equal(read.exists, false)
  assert.deepEqual(read.config, { dirs: [], order: [], rankBase: 250, skills: {} })
  assert.equal(defaultSkillsConfig().rankBase, 250)
})

test('写入/读回往返：目录、顺序、rank 基数，并保留手写注释', () => {
  const file = configFile('roundtrip')
  const written = writeSkillsConfig({ dirs: ['D:\\skills-a'], order: ['demo-skill'] }, file)
  assert.equal(written.ok, true)
  assert.deepEqual(written.config.dirs, ['D:\\skills-a'])
  assert.deepEqual(written.config.order, ['demo-skill'])
  assert.equal(existsSync(file), true)
  assert.equal(skillsConfigPath(), join(home, 'skills', '.system', 'skills.yml'))

  // 手工注释必须保留（yaml Document API 写回）。
  const text = readFileSync(file, 'utf8')
  writeFileSync(file, `${text}# 手工注释：保留我\n`, 'utf8')
  writeSkillsConfig({ rankBase: 300 }, file)
  const after = readFileSync(file, 'utf8')
  assert.ok(after.includes('# 手工注释：保留我'), '注释保留')
  assert.equal(readSkillsConfig(file).config.rankBase, 300)
})

test('空数组与默认 rank 基数删除对应键，文件保持精简', () => {
  const file = configFile('defaults')
  writeSkillsConfig({ dirs: ['a'], order: ['x'], rankBase: 300 }, file)
  writeSkillsConfig({ dirs: [], order: [], rankBase: 250 }, file)
  const text = readFileSync(file, 'utf8')
  assert.equal(/^dirs:/m.test(text), false)
  assert.equal(/^order:/m.test(text), false)
  assert.equal(/^rankBase:/m.test(text), false)
  assert.deepEqual(readSkillsConfig(file).config, { dirs: [], order: [], rankBase: 250, skills: {} })
})

test('YAML 损坏时拒绝覆盖并报错（不丢用户手写内容）', () => {
  const file = configFile('broken')
  writeFileSync(file, 'dirs: [unclosed\n', 'utf8')
  const broken = readSkillsConfig(file)
  assert.equal(broken.ok, false)
  const written = writeSkillsConfig({ order: ['x'] }, file)
  assert.equal(written.ok, false)
  assert.equal(readFileSync(file, 'utf8'), 'dirs: [unclosed\n', '损坏文件不得被覆盖')
})

test('全量替换记录保留注释与未知字段，移除已删除记录', () => {
  const file = configFile('records')
  const record = { path: 'demo', link: 'demo', enabled: true, modelInvocable: true, userInvocable: true }
  writeSkillsConfig({ skills: { demo: record, old: { ...record, path: 'old', link: 'old' } } }, file)
  const initial = readFileSync(file, 'utf8')
  writeFileSync(file, initial.replace('  demo:\n', '  demo: # 技能注释\n    custom: keep\n') + 'unknown: retained\n')
  const result = writeSkillsConfig({ skills: { demo: { ...record, enabled: false } } }, file)
  assert.equal(result.ok, true, result.message)
  assert.equal(result.config.skills.demo.enabled, false)
  assert.equal(result.config.skills.old, undefined)
  const text = readFileSync(file, 'utf8')
  assert.match(text, /# 技能注释/)
  assert.match(text, /custom: keep/)
  assert.match(text, /unknown: retained/)
})

test('非映射、别名、非法类型和路径统一拒绝且保留原文件', () => {
  const file = configFile('validation')
  for (const raw of ['null\n', '- item\n', 'skills: *missing\n', 'skills: &s {}\nunknown: *s\n', 'dirs: wrong\n', 'rankBase: -1\n', 'rankBase: null\n', 'skills: null\n', 'skills: []\n', 'skills:\n  bad:\n    path: ../escape\n']) {
    writeFileSync(file, raw)
    assert.equal(readSkillsConfig(file).ok, false, raw)
    assert.equal(writeSkillsConfig({ order: ['x'] }, file).ok, false, raw)
    assert.equal(readFileSync(file, 'utf8'), raw)
  }
})

test('调用者携带的内容版本不匹配时拒绝写入', () => {
  const file = configFile('version')
  writeSkillsConfig({ order: ['first'] }, file)
  const before = readFileSync(file, 'utf8')
  assert.equal(writeSkillsConfig({ order: ['second'] }, file, 'stale').ok, false)
  assert.equal(readFileSync(file, 'utf8'), before)
})
