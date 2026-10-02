/**
 * 模块启用表回归。
 *
 * 真值源：`<存储根>/config.yml` 的既定格式（`schemaVersion: 3` + `enabled: [id…]`），
 * 以及「启用即配装、顺序即装配顺序、停用是幂等移除」三条契约。
 * 断言落在**磁盘产物**与读回结果上，不看实现内部结构。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolatedHome } from '../fixtures/host-harness.mjs'

const { presetRoot } = isolatedHome('pt-enable-')
const { enabledModuleIds, setModuleEnabled, enableTablePath, ENABLE_TABLE_SCHEMA } =
  await import('../../src/host/config-store.ts')

/** 每个用例独立的存储根（上溯一级就是 home，故模块根随意命名但互不共用）。 */
function freshRoot(name) {
  const root = join(presetRoot, '..', `enable-${name}`, 'modules')
  mkdirSync(root, { recursive: true })
  return root
}

test('启用表：缺失/坏文件/schema<3 一律读成空表（不误当启用）', () => {
  const root = freshRoot('empty')
  assert.deepEqual(enabledModuleIds(root), [], '文件缺失 = 空表')

  writeFileSync(enableTablePath(root), 'not: [valid\n', 'utf8')
  assert.deepEqual(enabledModuleIds(root), [], 'YAML 解析失败 = 空表')

  writeFileSync(enableTablePath(root), 'schemaVersion: 2\nenabled:\n  - legacy\n', 'utf8')
  assert.deepEqual(enabledModuleIds(root), [], '旧 schema 的 enabled 没有启用语义')

  writeFileSync(enableTablePath(root), 'schemaVersion: 3\nenabled: nope\n', 'utf8')
  assert.deepEqual(enabledModuleIds(root), [], 'enabled 不是数组 = 空表')
})

test('启用即配装：顺序即装配顺序，启用幂等，停用只摘除自己', () => {
  const root = freshRoot('order')
  setModuleEnabled(root, 'a', true)
  setModuleEnabled(root, 'b', true)
  setModuleEnabled(root, 'c', true)
  assert.deepEqual(enabledModuleIds(root), ['a', 'b', 'c'], '按启用先后排列（= 装配顺序）')

  setModuleEnabled(root, 'a', true)
  assert.deepEqual(enabledModuleIds(root), ['a', 'b', 'c'], '重复启用不产生第二条')

  setModuleEnabled(root, 'b', false)
  assert.deepEqual(enabledModuleIds(root), ['a', 'c'], '停用只摘除目标')
  setModuleEnabled(root, 'b', false)
  assert.deepEqual(enabledModuleIds(root), ['a', 'c'], '重复停用幂等')

  const text = readFileSync(enableTablePath(root), 'utf8')
  assert.match(text, new RegExp(`schemaVersion: ${ENABLE_TABLE_SCHEMA}`), '写盘带当前 schema')
  assert.match(text, /enabled:/, '写盘保留 enabled 段')
})

test('启用表写盘保留用户注释与未知字段（Document API 契约）', () => {
  const root = freshRoot('comments')
  writeFileSync(enableTablePath(root),
    '# 我自己的注释\nschemaVersion: 3\nenabled:\n  - x\nmyOwnKey: keep\n', 'utf8')
  setModuleEnabled(root, 'y', true)
  const text = readFileSync(enableTablePath(root), 'utf8')
  assert.match(text, /# 我自己的注释/, '注释保留')
  assert.match(text, /myOwnKey: keep/, '未知字段保留')
  assert.deepEqual(enabledModuleIds(root), ['x', 'y'], '启用追加在末尾')
})
