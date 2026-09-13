import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

const file = skillsConfigPath()

test('配置文件缺失时回退默认值（默认技能根 + 默认 rank 基数）', () => {
  assert.equal(existsSync(file), false)
  const read = readSkillsConfig(file)
  assert.equal(read.ok, true)
  assert.equal(read.exists, false)
  assert.deepEqual(read.config, { dirs: [], order: [], rankBase: 250 })
  assert.equal(defaultSkillsConfig().rankBase, 250)
})

test('写入/读回往返：目录、顺序、rank 基数，并保留手写注释', () => {
  const written = writeSkillsConfig({ dirs: ['D:\\skills-a'], order: ['demo-skill'] }, file)
  assert.equal(written.ok, true)
  assert.deepEqual(written.config.dirs, ['D:\\skills-a'])
  assert.deepEqual(written.config.order, ['demo-skill'])
  assert.equal(existsSync(file), true)
  assert.ok(file.includes(join('skills', '.system', 'prompt-tool')), '配置落在技能根的 .system 区（官方 skipSystem 忽略）')

  // 手工注释必须保留（yaml Document API 写回）。
  const text = readFileSync(file, 'utf8')
  writeFileSync(file, `${text}# 手工注释：保留我\n`, 'utf8')
  writeSkillsConfig({ rankBase: 300 }, file)
  const after = readFileSync(file, 'utf8')
  assert.ok(after.includes('# 手工注释：保留我'), '注释保留')
  assert.equal(readSkillsConfig(file).config.rankBase, 300)
})

test('空数组与默认 rank 基数删除对应键，文件保持精简', () => {
  writeSkillsConfig({ dirs: [], order: [], rankBase: 250 }, file)
  const text = readFileSync(file, 'utf8')
  assert.equal(/^dirs:/m.test(text), false)
  assert.equal(/^order:/m.test(text), false)
  assert.equal(/^rankBase:/m.test(text), false)
  assert.deepEqual(readSkillsConfig(file).config, { dirs: [], order: [], rankBase: 250 })
})

test('YAML 损坏时拒绝覆盖并报错（不丢用户手写内容）', () => {
  writeFileSync(file, 'dirs: [unclosed\n', 'utf8')
  const broken = readSkillsConfig(file)
  assert.equal(broken.ok, false)
  const written = writeSkillsConfig({ order: ['x'] }, file)
  assert.equal(written.ok, false)
  assert.equal(readFileSync(file, 'utf8'), 'dirs: [unclosed\n', '损坏文件不得被覆盖')
})
