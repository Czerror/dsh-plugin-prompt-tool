import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseFrontmatter, createCachedSkillsReader, readSkills, validSkills, SKILL_NAME_RE } from '../../lib/index.mjs'

const makeDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-tool-skills-'))
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const writeSkill = (root, folder, content) => {
  const dir = join(root, folder)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), content, 'utf8')
  return dir
}

test('parseFrontmatter：剥掉 UTF-8 BOM 后仍能解析，body 不含 BOM', () => {
  const { data, body } = parseFrontmatter('\uFEFF---\nname: demo-skill\ndescription: Demo\n---\nBODY')
  assert.equal(data.name, 'demo-skill')
  assert.equal(data.description, 'Demo')
  assert.equal(body, 'BODY')
})

test('readSkills：BOM + 合法 kebab name 是有效条目，调用标志默认全开', () => {
  const { dir, cleanup } = makeDir()
  try {
    writeSkill(dir, 'demo-skill', '\uFEFF---\nname: demo-skill\ndescription: Demo skill\n---\nBODY')
    const [entry] = readSkills(dir)
    assert.equal(entry.folder, 'demo-skill')
    assert.equal(entry.name, 'demo-skill')
    assert.equal(entry.valid, true)
    assert.equal(entry.modelInvocable, true)
    assert.equal(entry.userInvocable, true)
    assert.equal(entry.body, 'BODY')
    assert.equal(validSkills([entry]).length, 1)
  } finally {
    cleanup()
  }
})

test('readSkills：非法名条目保留（valid=false + issue），provider 过滤层会跳过它', () => {
  const { dir, cleanup } = makeDir()
  try {
    writeSkill(dir, 'Bad Folder', '\uFEFF---\nname: 高级开发工程师\ndescription: Demo\n---\nBODY')
    const entries = readSkills(dir)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].folder, 'Bad Folder')
    assert.equal(entries[0].valid, false)
    assert.match(entries[0].issue, /kebab-case/)
    assert.equal(entries[0].modelInvocable, false)
    assert.equal(validSkills(entries).length, 0)
    assert.equal(SKILL_NAME_RE.test('Bad Folder'), false)
  } finally {
    cleanup()
  }
})

test('readSkills：disable-model-invocation / user-invocable 映射到调用标志', () => {
  const { dir, cleanup } = makeDir()
  try {
    writeSkill(dir, 'locked-skill', '---\nname: locked-skill\ndescription: Locked\ndisable-model-invocation: true\nuser-invocable: false\n---\nBODY')
    const [entry] = readSkills(dir)
    assert.equal(entry.valid, true)
    assert.equal(entry.modelInvocable, false)
    assert.equal(entry.userInvocable, false)
  } finally {
    cleanup()
  }
})

test('readSkills：无 frontmatter 时回退目录名；SKILL.md 缺失的目录与隐藏目录被跳过', () => {
  const { dir, cleanup } = makeDir()
  try {
    writeSkill(dir, 'fallback-skill', 'BODY without frontmatter')
    const missing = join(dir, 'broken-skill')
    mkdirSync(missing, { recursive: true })
    mkdirSync(join(dir, '.hidden'), { recursive: true })
    const entries = readSkills(dir)
    const fallback = entries.find((entry) => entry.folder === 'fallback-skill')
    assert.equal(fallback.name, 'fallback-skill')
    assert.equal(fallback.valid, true)
    // 技能规范：只有含 SKILL.md 的一级子目录才是技能；缺失/隐藏目录不出现在列表。
    assert.equal(entries.find((entry) => entry.folder === 'broken-skill'), undefined)
    assert.equal(entries.find((entry) => entry.folder === '.hidden'), undefined)
    assert.equal(validSkills(entries).length, 1)
  } finally {
    cleanup()
  }
})

test('readSkills：junction/符号链接技能目录被跟随并标记 linked', () => {
  const { dir, cleanup } = makeDir()
  try {
    // 真实技能目录（含 SKILL.md）+ junction 链接挂入扫描根（模拟 Windows 链接挂载）。
    const real = writeSkill(dir, 'real-skill', '---\nname: linked-skill\ndescription: Linked\n---\nBODY')
    const linkedRoot = join(dir, 'linked-root')
    mkdirSync(linkedRoot, { recursive: true })
    try {
      symlinkSync(real, join(linkedRoot, 'linked-skill'), 'junction')
    } catch {
      // 无权限创建链接时跳过该测试（如 CI 限制）。
      return
    }
    const entries = readSkills(linkedRoot)
    const linked = entries.find((entry) => entry.folder === 'linked-skill')
    assert.ok(linked, 'junction 链接的技能应被扫描到')
    assert.equal(linked.valid, true)
    assert.equal(linked.linked, true)
  } finally {
    cleanup()
  }
})

test('createCachedSkillsReader：内容未变化时复用同一次扫描结果，变化后自动失效', () => {
  const { dir, cleanup } = makeDir()
  try {
    writeSkill(dir, 'cached-skill', '---\nname: cached-skill\ndescription: v1\n---\nBODY-ONE')
    const cached = createCachedSkillsReader()
    const first = cached.read(dir)
    const second = cached.read(dir)
    assert.equal(first, second)
    assert.equal(first[0].body, 'BODY-ONE')

    writeSkill(dir, 'cached-skill', '---\nname: cached-skill\ndescription: v2\n---\nBODY-TWO-LONGER')
    const third = cached.read(dir)
    assert.notEqual(third, first)
    assert.equal(third[0].body, 'BODY-TWO-LONGER')

    const fourth = cached.read(dir)
    assert.equal(fourth, third)
    cached.invalidate(dir)
    const fifth = cached.read(dir)
    assert.notEqual(fifth, third)
  } finally {
    cleanup()
  }
})
