// 技能资产操作（注册层屏蔽模型）：创建与回收站删除都落在用户技能根 `<root>/<目录名>/SKILL.md`。
// 随注册层屏蔽模型移除：受管实体库（`.system/<技能>` 物化 + 根链接 + 状态记录）不再是产品行为，
//  删除改为整体移动技能目录进 `<root>/.system/prompt-tool/.trash`，只处理用户根里的实体。
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { createSkill, deleteSkill, deleteSkillTarget, readSkillMarker } = await import('../../src/host/skills-actions.ts')

const makeRoot = () => mkdtempSync(join(tmpdir(), 'pt-actions-'))

test('createSkill 落在用户技能根，不做实体库也不建链接', () => {
  const root = makeRoot()
  try {
    const created = createSkill(root, { name: 'demo-skill', description: 'demo', content: 'body' })
    assert.equal(created.ok, true, created.ok ? '' : created.message)
    if (!created.ok) return
    assert.equal(created.id, 'demo-skill')
    assert.equal(created.path, join(root, 'demo-skill'))
    const marker = join(root, 'demo-skill', 'SKILL.md')
    assert.equal(existsSync(marker), true)
    assert.equal(readSkillMarker(created.path), readFileSync(marker, 'utf8'))
    assert.match(readFileSync(marker, 'utf8'), /^---\nname: demo-skill\ndescription: demo\n---\nbody$/)
    // 技能实体就是用户根里的普通目录：不建 .system 实体库、不建符号链接。
    assert.equal(existsSync(join(root, '.system')), false, '创建不落受管实体库')
    assert.equal(lstatSync(join(root, 'demo-skill')).isSymbolicLink(), false)
    assert.deepEqual(readdirSync(root), ['demo-skill'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('createSkill 拒绝重复、非法输入与非普通目录且不留半成品', () => {
  const root = makeRoot()
  try {
    assert.equal(createSkill(root, { name: 'demo-skill', description: 'demo', content: 'body' }).ok, true)
    const marker = join(root, 'demo-skill', 'SKILL.md')
    const original = readFileSync(marker, 'utf8')
    assert.equal(createSkill(root, { name: 'demo-skill', description: 'other', content: 'other' }).ok, false, '同名技能不覆盖')
    assert.equal(readFileSync(marker, 'utf8'), original)
    for (const input of [
      { name: 'Bad Name', description: 'x', content: '' },
      { name: '', description: 'x', content: '' },
      { name: 'demo--skill', description: 'x', content: '' },
      { name: 42, description: 'x', content: '' },
      { name: 'other-skill', description: '   ', content: '' },
      { name: 'other-skill', description: 'x', content: 42 },
      { name: 'other-skill', description: 'x'.repeat(8193), content: '' },
      { name: 'other-skill', description: 'x', content: 'y'.repeat(1024 * 1024 + 1) },
    ]) {
      const result = createSkill(root, input)
      assert.equal(result.ok, false, JSON.stringify(input).slice(0, 60))
      if (input.name === 'other-skill') assert.equal(existsSync(join(root, 'other-skill')), false, '失败不留半成品目录')
    }
    assert.deepEqual(readdirSync(root), ['demo-skill'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('createSkill 对非普通目录的用户根直接拒绝，不在链接目标里留下任何目录', () => {
  const root = makeRoot()
  try {
    const real = join(root, 'real-root')
    mkdirSync(real)
    const linked = join(root, 'linked-root')
    symlinkSync(real, linked, process.platform === 'win32' ? 'junction' : 'dir')
    const result = createSkill(linked, { name: 'demo-skill', description: 'demo', content: 'body' })
    assert.equal(result.ok, false, '符号链接用户根不是普通目录')
    assert.deepEqual(readdirSync(real), [], '拒绝创建时不改动链接目标')
    assert.equal(existsSync(join(linked, 'demo-skill')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('createSkill 拒绝链接根时不删除链接目标里已存在的同名技能和资源', () => {
  const root = makeRoot()
  try {
    const real = join(root, 'real-root')
    mkdirSync(join(real, 'demo-skill', 'references'), { recursive: true })
    const marker = join(real, 'demo-skill', 'SKILL.md')
    const resource = join(real, 'demo-skill', 'references', 'note.md')
    writeFileSync(marker, 'original skill')
    writeFileSync(resource, 'original resource')
    const linked = join(root, 'linked-root')
    symlinkSync(real, linked, process.platform === 'win32' ? 'junction' : 'dir')
    const result = createSkill(linked, { name: 'demo-skill', description: 'demo', content: 'replacement' })
    assert.equal(result.ok, false)
    assert.equal(readFileSync(marker, 'utf8'), 'original skill')
    assert.equal(readFileSync(resource, 'utf8'), 'original resource')
    assert.deepEqual(readdirSync(real), ['demo-skill'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('deleteSkill 把整个技能目录移入回收站并可人工恢复', () => {
  const root = makeRoot()
  try {
    createSkill(root, { name: 'demo-skill', description: 'demo', content: 'body' })
    mkdirSync(join(root, 'demo-skill', 'assets'), { recursive: true })
    writeFileSync(join(root, 'demo-skill', 'assets', 'note.md'), 'keep', 'utf8')

    const deleted = deleteSkill(root, 'demo-skill')
    assert.equal(deleted.ok, true, deleted.ok ? '' : deleted.message)
    if (!deleted.ok) return
    assert.equal(existsSync(join(root, 'demo-skill')), false, '技能目录整体移走')
    const trashRoot = join(root, '.system', 'prompt-tool', '.trash')
    const entries = readdirSync(trashRoot)
    assert.equal(entries.length, 1)
    assert.match(entries[0], /^demo-skill-/)
    const trashed = join(trashRoot, entries[0])
    assert.equal(deleted.path, join(trashed, 'demo-skill'))
    assert.equal(readFileSync(join(trashed, 'demo-skill', 'assets', 'note.md'), 'utf8'), 'keep', '资源随技能目录一起进回收站')
    const record = JSON.parse(readFileSync(join(trashed, 'record.json'), 'utf8'))
    assert.equal(record.folder, 'demo-skill')
    assert.equal(record.source, join(root, 'demo-skill'))
    assert.deepEqual(record.files.sort(), ['SKILL.md', 'assets'])
    assert.equal(typeof record.deletedAt, 'string')
    assert.equal(record.origin, 'delete', '删除与覆盖导入共用同一套记录字段')
    // 用户根里的其他内容不受影响，删除不是「清空目录」。
    writeFileSync(join(root, 'unrelated.txt'), 'keep', 'utf8')
    assert.equal(deleteSkill(root, 'unrelated').ok, false, '不是技能目录（缺少 SKILL.md）')
    assert.equal(existsSync(join(root, 'unrelated.txt')), true)
    assert.equal(deleteSkill(root, 'missing-skill').ok, false)
    assert.equal(deleteSkill(root, '../escape').ok, false)
    assert.equal(deleteSkill(root, 'Bad Name').ok, false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('importSkillsPackage 支持无顶层容器的单技能包并写入用户技能根', async () => {
  const root = makeRoot()
  try {
    const { importSkillsPackage } = await import('../../src/host/skills-import.ts')
    const result = importSkillsPackage(root, [{ path: 'SKILL.md', content: Buffer.from('---\nname: one-skill\ndescription: one\n---\nbody').toString('base64') }])
    assert.equal(result.ok, true, result.ok ? '' : result.message)
    assert.equal(existsSync(join(root, 'one-skill', 'SKILL.md')), true)
    assert.equal(existsSync(join(root, '.system')), false, '导入不落受管实体库')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('trashSkill 拒绝不合法的目录名，不把容器外的目录搬走', async () => {
  const root = makeRoot()
  try {
    const { trashSkill } = await import('../../src/host/skills-actions.ts')
    assert.throws(() => trashSkill(root, '../escape', 'delete'), /技能目录名不合法/u)
    assert.equal(existsSync(join(root, '.system')), false, '拒绝时连回收站目录都不创建')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('trashSkill 失败时清理自己创建的容器，不在回收站留空条目', async () => {
  const root = makeRoot()
  try {
    const { trashSkill } = await import('../../src/host/skills-actions.ts')
    assert.throws(() => trashSkill(root, 'missing-skill', 'delete'), /ENOENT/u, '源目录不存在时抛错')
    const trashRoot = join(root, '.system', 'prompt-tool', '.trash')
    assert.deepEqual(readdirSync(trashRoot), [], '失败不留「只有 record.json」的空条目')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('引用根删除目录包和 flat 文件：回收记录完整，其他资源不动', () => {
  const root = makeRoot()
  try {
    createSkill(root, { name: 'demo', description: 'D', content: 'body' })
    writeFileSync(join(root, 'flat.md'), '---\nname: flat\ndescription: D\n---\nbody\n')
    writeFileSync(join(root, 'keep.txt'), 'keep')
    for (const target of [join(root, 'demo', 'SKILL.md'), join(root, 'flat.md')]) {
      const result = deleteSkillTarget([root], target)
      assert.equal(result.ok, true, result.message)
      assert.equal(existsSync(target), false)
      assert.equal(existsSync(result.path), true)
      const record = JSON.parse(readFileSync(join(result.path, '..', 'record.json'), 'utf8'))
      assert.equal(record.origin, 'delete')
      assert.equal(record.source, target.endsWith('SKILL.md') ? join(root, 'demo') : target)
    }
    assert.equal(readFileSync(join(root, 'keep.txt'), 'utf8'), 'keep')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('引用根删除拒绝越界、移除的根、非技能、只读和所有链接边界', () => {
  const root = makeRoot()
  try {
    const allowed = join(root, 'allowed')
    const outside = join(root, 'outside')
    mkdirSync(allowed)
    mkdirSync(outside)
    createSkill(allowed, { name: 'demo', description: 'D', content: 'body' })
    createSkill(outside, { name: 'other', description: 'D', content: 'body' })
    const marker = join(allowed, 'demo', 'SKILL.md')
    assert.equal(deleteSkillTarget([], marker).ok, false)
    assert.equal(deleteSkillTarget([allowed], join(outside, 'other', 'SKILL.md')).ok, false)
    writeFileSync(join(allowed, 'plain.md'), 'not a skill')
    assert.equal(deleteSkillTarget([allowed], join(allowed, 'plain.md')).ok, false)
    chmodSync(marker, 0o444)
    try { assert.equal(deleteSkillTarget([allowed], marker).ok, false) } finally { chmodSync(marker, 0o666) }
    const link = join(root, 'linked')
    symlinkSync(allowed, link, process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal(deleteSkillTarget([link], join(link, 'demo', 'SKILL.md')).ok, false)
    assert.equal(deleteSkillTarget([join(link, 'demo')], join(link, 'demo', 'SKILL.md')).ok, false)
    symlinkSync(join(outside, 'other'), join(allowed, 'linked-skill'), process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal(deleteSkillTarget([allowed], join(allowed, 'linked-skill', 'SKILL.md')).ok, false)
    symlinkSync(join(outside, 'other', 'SKILL.md'), join(allowed, 'linked.md'), 'file')
    assert.equal(deleteSkillTarget([allowed], join(allowed, 'linked.md')).ok, false)
    symlinkSync(outside, join(allowed, '.system'), process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal(deleteSkillTarget([allowed], marker).ok, false)
    assert.equal(existsSync(marker), true)
    assert.deepEqual(readdirSync(outside), ['other'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})
