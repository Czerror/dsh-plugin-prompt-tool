// 技能导入（注册层屏蔽模型）：复制进用户技能根 `$DSH_HOME/skills`，不建受管实体库、不建链接。
// 随注册层屏蔽模型移除：`.system` 物化目标与受管记录不再存在；覆盖前只允许替换技能目录。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importSkillsPackage } from '../../lib/index.mjs'
import { importSkillsDirectory, readSkillDirectory } from '../../src/host/skills-import.ts'

const makeRoot = (prefix = 'prompt-tool-skills-import') => {
  const root = join(tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(root, { recursive: true })
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const file = (path, text) => ({ path, content: Buffer.from(text).toString('base64') })

test('importSkillsPackage：目录导入保留顶层文件夹并落在用户技能根', () => {
  const { root, cleanup } = makeRoot()
  try {
    const result = importSkillsPackage(root, [
      file('demo/SKILL.md', '---\nname: demo\ndescription: demo\n---\nbody\n'),
      { path: 'demo/assets/icon.png', content: Buffer.from([1, 2, 3]).toString('base64') },
    ])
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.path, root)
    assert.equal(result.count, 2)
    assert.equal(readFileSync(join(root, 'demo', 'SKILL.md'), 'utf8'), '---\nname: demo\ndescription: demo\n---\nbody\n')
    assert.deepEqual([...readFileSync(join(root, 'demo', 'assets/icon.png'))], [1, 2, 3])
    assert.equal(existsSync(join(root, '.system')), false, '导入不落受管实体库')
    assert.deepEqual(readdirSync(root).sort(), ['demo'])
  } finally {
    cleanup()
  }
})

test('importSkillsPackage：覆盖前要求目标是技能目录，非技能目录原样保留', () => {
  const { root, cleanup } = makeRoot()
  try {
    const first = importSkillsPackage(root, [file('demo/SKILL.md', '---\nname: demo\ndescription: demo\n---\nold\n')])
    assert.equal(first.ok, true)
    const overwritten = importSkillsPackage(root, [file('demo/SKILL.md', '---\nname: demo\ndescription: demo\n---\nnew\n')])
    assert.equal(overwritten.ok, true)
    assert.match(readFileSync(join(root, 'demo', 'SKILL.md'), 'utf8'), /new/)
    assert.equal(importSkillsPackage(root, [file('demo/SKILL.md', 'x')], false).ok, false, 'overwrite=false 时拒绝已存在的技能')

    // 用户根里的普通目录不是技能目录：覆盖导入必须拒绝且不改动它。
    mkdirSync(join(root, 'plain'))
    writeFileSync(join(root, 'plain', 'note.txt'), 'keep', 'utf8')
    const rejected = importSkillsPackage(root, [file('plain/SKILL.md', '---\nname: plain\ndescription: plain\n---\nbody\n')])
    assert.equal(rejected.ok, false)
    assert.equal(readFileSync(join(root, 'plain', 'note.txt'), 'utf8'), 'keep')
    assert.equal(existsSync(join(root, 'plain', 'SKILL.md')), false)
  } finally {
    cleanup()
  }
})

test('importSkillsDirectory：复制宿主机目录内容到用户技能根并保留资源', () => {
  const { root, cleanup } = makeRoot()
  const source = makeRoot('pt-skills-source')
  try {
    mkdirSync(join(source.root, 'references'))
    writeFileSync(join(source.root, 'SKILL.md'), '---\nname: imported-skill\ndescription: imported\n---\nbody\n', 'utf8')
    writeFileSync(join(source.root, 'references', 'doc.md'), 'doc', 'utf8')

    const files = readSkillDirectory(source.root)
    assert.deepEqual(files.map((entry) => entry.path).sort(), ['SKILL.md', 'references/doc.md'])
    const result = importSkillsDirectory(root, source.root)
    assert.equal(result.ok, true, result.ok ? '' : result.message)
    if (!result.ok) return
    const name = source.root.split(/[\\/]/).at(-1)
    assert.equal(result.path, root)
    assert.equal(result.count, 2)
    assert.equal(readFileSync(join(root, name, 'references', 'doc.md'), 'utf8'), 'doc')
    assert.equal(existsSync(join(source.root, 'SKILL.md')), true, '复制导入不改动来源目录')
    assert.equal(existsSync(join(root, '.system')), false)
    // 来源目录名必须是合法技能目录名：非法名先于任何写盘被拒绝。
    const bad = makeRoot('pt-skills-source')
    const badName = join(bad.root, 'Bad Name')
    mkdirSync(badName)
    writeFileSync(join(badName, 'SKILL.md'), '---\nname: bad\ndescription: bad\n---\nbody\n', 'utf8')
    const rejected = importSkillsDirectory(root, badName)
    assert.equal(rejected.ok, false)
    assert.equal(existsSync(join(root, 'Bad Name')), false)
    rmSync(bad.root, { recursive: true, force: true })
  } finally {
    cleanup()
    source.cleanup()
  }
})

test('importSkillsPackage：拒绝路径穿越且不落盘', () => {
  const { root, cleanup } = makeRoot()
  try {
    const result = importSkillsPackage(root, [
      file('demo/../../escape.txt', 'bad'),
    ])
    assert.equal(result.ok, false)
    assert.equal(existsSync(join(root, 'escape.txt')), false)
    assert.equal(existsSync(join(root, 'demo')), false)
    assert.deepEqual(readdirSync(root), [])
  } finally {
    cleanup()
  }
})

test('importSkillsPackage：空文件列表直接失败', () => {
  const { root, cleanup } = makeRoot()
  try {
    const result = importSkillsPackage(root, [])
    assert.equal(result.ok, false)
  } finally {
    cleanup()
  }
})
