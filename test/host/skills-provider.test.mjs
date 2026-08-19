import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseFrontmatter } from '../../lib/preset-core.mjs'
import { readSkills, validSkills, SKILL_NAME_RE } from '../../lib/index.mjs'

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

test('readSkills：无 frontmatter 时回退目录名；SKILL.md 缺失时保留坏条目', () => {
  const { dir, cleanup } = makeDir()
  try {
    writeSkill(dir, 'fallback-skill', 'BODY without frontmatter')
    const missing = join(dir, 'broken-skill')
    mkdirSync(missing, { recursive: true })
    const entries = readSkills(dir)
    const fallback = entries.find((entry) => entry.folder === 'fallback-skill')
    assert.equal(fallback.name, 'fallback-skill')
    assert.equal(fallback.valid, true)
    const broken = entries.find((entry) => entry.folder === 'broken-skill')
    assert.equal(broken.valid, false)
    assert.match(broken.issue, /不可读|不存在/)
    assert.equal(validSkills(entries).length, 1)
  } finally {
    cleanup()
  }
})
