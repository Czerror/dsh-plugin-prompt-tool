import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importSkillsPackage } from '../../lib/index.mjs'

const makeRoot = () => {
  const root = join(tmpdir(), `prompt-tool-skills-import-${process.pid}-${Date.now()}`)
  mkdirSync(root, { recursive: true })
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('importSkillsPackage：目录导入剥离顶层文件夹并保留子目录结构', () => {
  const { root, cleanup } = makeRoot()
  try {
    const result = importSkillsPackage(root, [
      { path: 'demo/SKILL.md', content: Buffer.from('---\nname: demo\n---\nbody\n').toString('base64') },
      { path: 'demo/assets/icon.png', content: Buffer.from([1, 2, 3]).toString('base64') },
    ])
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.path, root)
    assert.equal(result.count, 2)
    assert.equal(readFileSync(join(root, 'SKILL.md'), 'utf8'), '---\nname: demo\n---\nbody\n')
    assert.deepEqual([...readFileSync(join(root, 'assets/icon.png'))], [1, 2, 3])
    assert.equal(existsSync(join(root, 'demo')), false, '顶层目录段不应复制')
  } finally {
    cleanup()
  }
})

test('importSkillsPackage：拒绝路径穿越且不落盘', () => {
  const { root, cleanup } = makeRoot()
  try {
    const result = importSkillsPackage(root, [
      { path: 'demo/../../escape.txt', content: Buffer.from('bad').toString('base64') },
    ])
    assert.equal(result.ok, false)
    assert.equal(existsSync(join(root, 'escape.txt')), false)
    assert.equal(existsSync(join(root, 'demo')), false)
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
