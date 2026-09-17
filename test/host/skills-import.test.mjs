// 技能导入（注册层屏蔽模型）：复制进用户技能根 `$DSH_HOME/skills`，不建受管实体库、不建链接。
// 随注册层屏蔽模型移除：`.system` 物化目标与受管记录不再存在；覆盖前只允许替换技能目录。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importSkillsPackage, importSkillsDirectory, readSkillDirectory } from '../../src/host/skills-import.ts'

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
    const replacement = importSkillsPackage(root, [file('demo/SKILL.md', '---\nname: demo\ndescription: demo\n---\nnew\n')])
    assert.equal(replacement.ok, true)
    assert.equal(replacement.overwritten, 1, '覆盖导入如实报告替换数量')
    assert.match(readFileSync(join(root, 'demo', 'SKILL.md'), 'utf8'), /new/)
    // 上传入口与宿主机目录导入共用同一套回收站逻辑：旧版本同样必须可恢复。
    const trash = join(root, '.system', 'prompt-tool', '.trash')
    const containers = readdirSync(trash)
    assert.equal(containers.length, 1, '被替换的旧版本进回收站')
    assert.match(readFileSync(join(trash, containers[0], 'demo', 'SKILL.md'), 'utf8'), /old/, '回收站里留的是旧版本')
    assert.equal(JSON.parse(readFileSync(join(trash, containers[0], 'record.json'), 'utf8')).origin, 'import-overwrite')
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
    // 来源必须是绝对路径：空串会经 resolve('') 退化成进程工作目录，等于把整个 cwd 当技能导入。
    for (const [label, invalid] of [['空串', ''], ['纯空白', '   '], ['相对路径', 'pt-skills-source']]) {
      const guarded = importSkillsDirectory(root, invalid)
      assert.equal(guarded.ok, false, `${label}必须被拒绝`)
      assert.match(guarded.ok ? '' : guarded.message, /绝对路径|路径为空/u, label)
    }
    assert.deepEqual(readdirSync(root), [name], '被拒绝的导入不向用户技能根写入任何内容')
  } finally {
    cleanup()
    source.cleanup()
  }
})

test('importSkillsDirectory：覆盖同名技能时旧版本进回收站而不是被删除', () => {
  const target = makeRoot()
  const source = makeRoot('pt-skills-source')
  const root = target.root
  try {
    writeFileSync(join(source.root, 'SKILL.md'), '---\nname: imported\ndescription: first\n---\nfirst body\n', 'utf8')
    const first = importSkillsDirectory(root, source.root)
    assert.equal(first.ok, true, first.ok ? '' : first.message)
    if (!first.ok) return
    assert.equal(first.overwritten, 0, '首次导入没有覆盖任何技能')
    const name = source.root.split(/[\\/]/).at(-1)

    // 改来源内容后再次导入：同名技能被替换，旧版本必须仍可人工恢复。
    writeFileSync(join(source.root, 'SKILL.md'), '---\nname: imported\ndescription: second\n---\nsecond body\n', 'utf8')
    const second = importSkillsDirectory(root, source.root)
    assert.equal(second.ok, true, second.ok ? '' : second.message)
    if (!second.ok) return
    assert.equal(second.overwritten, 1, '覆盖计数如实返回')
    assert.match(readFileSync(join(root, name, 'SKILL.md'), 'utf8'), /second body/)

    const trash = join(root, '.system', 'prompt-tool', '.trash')
    const containers = readdirSync(trash)
    assert.equal(containers.length, 1, '被替换的旧版本进回收站')
    assert.match(readFileSync(join(trash, containers[0], name, 'SKILL.md'), 'utf8'), /first body/, '回收站里留的是旧版本')
    const record = JSON.parse(readFileSync(join(trash, containers[0], 'record.json'), 'utf8'))
    assert.equal(record.folder, name)
    assert.equal(record.origin, 'import-overwrite', '记录覆盖来源，便于区分回收站条目的成因')
  } finally {
    target.cleanup()
    source.cleanup()
  }
})

test('覆盖导入中途失败：已进回收站的旧技能被放回，目标不留半成品', () => {
  const target = makeRoot()
  const root = target.root
  try {
    mkdirSync(join(root, 'demo-skill'), { recursive: true })
    writeFileSync(join(root, 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: old\n---\nold body\n', 'utf8')

    // 两个顶层：第一个会被覆盖（先移入回收站），第二个目录名非法 → 在切换中途抛错。
    const result = importSkillsPackage(root, [
      file('demo-skill/SKILL.md', '---\nname: demo-skill\ndescription: new\n---\nnew body\n'),
      file('Bad Name/SKILL.md', '---\nname: bad\ndescription: bad\n---\nbody\n'),
    ])
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.message, /kebab-case/u, '失败原因仍是原始错误')
    assert.match(readFileSync(join(root, 'demo-skill', 'SKILL.md'), 'utf8'), /old body/, '旧技能必须被放回原处')
    assert.deepEqual(readdirSync(root).filter((name) => name !== '.system'), ['demo-skill'], '目标里不留半成品')
    assert.deepEqual(readdirSync(join(root, '.system', 'prompt-tool', '.trash')), [], '回滚成功后回收站不留残留')
  } finally {
    target.cleanup()
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
