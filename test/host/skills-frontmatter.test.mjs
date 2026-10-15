/**
 * SKILL.md 合法性的唯一解析：解析层直测 ＋ 「清单与策略写入对同一文件结论一致」。
 *
 * 两面缺一不可：只测解析层，四侧接线错了不会红；只测一侧，边界还原错了也看不出来。
 * 本轮的判别力在这里——改动之前，同一份带 BOM 的文件「清单判无效、编辑器却能读写」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseFrontmatter } from '../../src/host/skills-parse.ts'
import { scanRoots } from '../../src/host/skills-scan.ts'
import { setSkillInvocation } from '../../src/host/skills-policy.ts'

const base = mkdtempSync(join(tmpdir(), 'pt-skill-parse-'))
test.after(() => rmSync(base, { recursive: true, force: true }))

/** 在独立的技能根下造一个技能目录，返回 SKILL.md 路径（每个用例一个根，互不扫描）。 */
function skill(caseName, folder, text, bom = '') {
  const root = join(base, caseName)
  const dir = join(root, folder)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'SKILL.md')
  writeFileSync(file, bom + text)
  return { root, file }
}

const scanOne = (root) => scanRoots([{ kind: 'custom', path: root }])[0]

test('parseFrontmatter：BOM 读时剥、边界片段能逐字还原原文', () => {
  const raw = '\ufeff---\r\nname: demo\r\ndescription: 演示\r\n---\r\n正文第一行\n正文第二行\n'
  const parsed = parseFrontmatter(raw)
  assert.equal(parsed.ok, true, parsed.ok ? '应当解析成功' : parsed.issue)
  const { bom, boundaries, frontmatter, declared, body } = parsed.source
  assert.equal(bom, '\ufeff')
  assert.equal(declared.name, 'demo')
  assert.equal(boundaries.open, '---\r\n')
  assert.equal(boundaries.close, '\r\n---')
  // 四个片段 ＋ BOM 必须逐字还原原文——写回方靠这条不变式保留用户原文。
  assert.equal(bom + boundaries.open + frontmatter + boundaries.close + boundaries.tail, raw)
  assert.equal(body, '正文第一行\n正文第二行\n')
})

test('同一份带 BOM 的 SKILL.md：清单与策略写入给同一个答案', () => {
  const { root, file } = skill('bom', 'bom-skill', '---\nname: bom-skill\ndescription: 带 BOM 的技能\n---\n正文\n', '\ufeff')
  const scanned = scanOne(root)
  assert.equal(scanned.valid, true, `带 BOM 的技能应当有效；本轮之前这里是无效（${scanned.issue ?? '无 issue'}）`)
  assert.equal(scanned.name, 'bom-skill')
  const written = setSkillInvocation(file, 'model')
  assert.equal(written.ok, true, written.ok ? '策略写入应当可用' : written.message)
})

test('含 YAML 别名的 SKILL.md：清单与策略写入一致拒绝', () => {
  const { root, file } = skill('alias', 'alias-skill', '---\nname: alias-skill\ndescription: &d 描述\ncopy: *d\n---\n正文\n')
  const scanned = scanOne(root)
  assert.equal(scanned.valid, false, '别名会让「保留注释改写」出错，四侧一律拒绝')
  assert.match(scanned.issue ?? '', /别名/)
  const written = setSkillInvocation(file, 'model')
  assert.equal(written.ok, false)
  assert.match(written.message, /别名/, '两侧拒绝原因同源')
})

test('legacy 键的拒绝文案带修正提示，且两侧同源', () => {
  const { root, file } = skill('legacy', 'legacy-skill', '---\nname: legacy-skill\ndescription: 描述\nmodelInvocable: true\n---\n正文\n')
  const scanned = scanOne(root)
  assert.equal(scanned.valid, false)
  assert.match(scanned.issue ?? '', /unsupported; use "disable-model-invocation"/)
  const written = setSkillInvocation(file, 'model')
  assert.equal(written.ok, false)
  assert.match(written.message, /unsupported; use "disable-model-invocation"/, '清单与策略写入的文案来自同一处')
})
