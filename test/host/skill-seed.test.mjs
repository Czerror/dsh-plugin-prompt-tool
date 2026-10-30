/**
 * 内置技能种子化（`ensureSkillSeed`）——插件安装/启动时把包内 `skills/` 补进用户技能根。
 *
 * 真值源是文件系统里的真实内容：包内 `skills/dsh-module/SKILL.md` 与补建产物逐字比较，
 * 不经被测代码生成期望值。纪律与内置模块的种子化一致：只补缺失项，用户改过或删过的
 * 技能不被重新铺写。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureSkillSeed, packageSkillsDir } from '../../src/host/skills-actions.ts'

const tempRoot = () => mkdtempSync(join(tmpdir(), 'pt-skill-seed-'))

test('首次种子化：按包内目录补建内置技能，内容逐字一致', (t) => {
  const root = tempRoot()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const { created } = ensureSkillSeed(root)

  assert.ok(created.includes('dsh-module'), `created 应含包内技能，实际：${created.join(', ') || '(空)'}`)
  assert.equal(
    readFileSync(join(root, 'dsh-module', 'SKILL.md'), 'utf8'),
    readFileSync(join(packageSkillsDir(), 'dsh-module', 'SKILL.md'), 'utf8'),
  )
  // 随技能的附属文件一并复制：`reference.md` 是 SKILL.md 正文的指针目标，缺了技能就是残的。
  assert.equal(existsSync(join(root, 'dsh-module', 'reference.md')), true)
})

test('二次种子化幂等：用户改过的同名技能保持原样', (t) => {
  const root = tempRoot()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  ensureSkillSeed(root)

  const mine = join(root, 'dsh-module', 'SKILL.md')
  writeFileSync(mine, '---\nname: dsh-module\ndescription: 我改过的\n---\n\n本地版本\n')
  const second = ensureSkillSeed(root)

  assert.deepEqual(second.created, [], '已有同名目录不再补建')
  assert.match(readFileSync(mine, 'utf8'), /本地版本/, '用户改动不被覆盖')
})

test('目标根不可用时静默返回空：技能是可选资产，种子化失败不阻断启动', (t) => {
  const base = tempRoot()
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const blocked = join(base, 'not-a-directory')
  writeFileSync(blocked, 'x')

  assert.doesNotThrow(() => ensureSkillSeed(blocked))
  assert.deepEqual(ensureSkillSeed(blocked).created, [])
})
