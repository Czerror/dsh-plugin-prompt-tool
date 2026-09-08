import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { hostResolutionBases, resolveHostPackage } from '../../engine/host-package.mjs'

/**
 * 复现「npm-global junction 安装」：入口是全局 node_modules 下的 junction，
 * 依赖只存在于真实仓库根（pnpm workspace 提升），沿 junction 路径向上找不到。
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pt-host-package-'))
  const real = join(root, 'repo', 'apps', 'cli')
  mkdirSync(join(real, 'lib'), { recursive: true })
  mkdirSync(join(root, 'repo', 'node_modules', '@scope', 'tools'), { recursive: true })
  writeFileSync(join(real, 'lib', 'bin.js'), '// host entry\n')
  writeFileSync(join(root, 'repo', 'node_modules', '@scope', 'tools', 'index.js'), 'export const ok = true\n')
  const linkParent = join(root, 'global', 'node_modules', '@scope')
  mkdirSync(linkParent, { recursive: true })
  const link = join(linkParent, 'dsh')
  symlinkSync(real, link, 'junction')
  return { root, entry: join(link, 'lib', 'bin.js') }
}

test('hostResolutionBases：junction 入口把真实路径排在原路径之前', () => {
  const { root, entry } = fixture()
  try {
    const bases = hostResolutionBases(entry)
    assert.equal(bases[0], realpathSync(entry))
    assert.equal(bases[1], entry)
    assert.notEqual(bases[0], bases[1], '前提：junction 入口的 realpath 与原路径不同')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveHostPackage：沿 junction 路径解析失败时回退真实路径', () => {
  const { root, entry } = fixture()
  try {
    // 前提：这正是用户报的 Cannot find module 场景（依赖只在真实仓库根下）。
    assert.throws(() => createRequire(entry).resolve('@scope/tools'), { code: 'MODULE_NOT_FOUND' })
    const resolved = resolveHostPackage('@scope/tools', entry)
    assert.equal(resolved, realpathSync(join(root, 'repo', 'node_modules', '@scope', 'tools', 'index.js')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveHostPackage：全部基准失败时抛出可诊断错误', () => {
  assert.throws(
    () => resolveHostPackage('@scope/definitely-missing', join(tmpdir(), 'pt-missing-entry.js')),
    /cannot resolve @scope\/definitely-missing from host entry/,
  )
})
