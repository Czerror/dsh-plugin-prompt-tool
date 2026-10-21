/**
 * 工具可见面计划：三面（目录 / SDK 正文 / 执行闸）共用的 fail-open 判据。
 * 真值源是 mask 的声明语义与「required = 静态 allow ∪ 动态解锁项」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMask, toolSurfacePlan } from '../../engine/actions/shared.mjs'

const mask = (allow, extra, requireMatch = true) => createMask({ allow, requireMatch }, 'v', 'p', extra)

test('toolSurfacePlan：名单齐全时不 fail-open，missing 为空', () => {
  const plan = toolSurfacePlan(mask(['alpha', 'beta']), new Set(['alpha', 'beta', 'run_code']))
  assert.deepEqual(plan, { failOpen: false, missing: [] })
})

test('toolSurfacePlan：静态 allow 缺项时 fail-open 并给出名字', () => {
  const plan = toolSurfacePlan(mask(['alpha', 'ghost']), new Set(['alpha']))
  assert.deepEqual(plan, { failOpen: true, missing: ['ghost'] })
})

test('toolSurfacePlan：解锁项缺项也算缺（required = allow ∪ allowExtra）', () => {
  const extra = new Set(['unlocked'])
  const plan = toolSurfacePlan(mask(['alpha'], extra), new Set(['alpha']))
  assert.deepEqual(plan, { failOpen: true, missing: ['unlocked'] })
})

test('toolSurfacePlan：deny-only 或未声明 requireMatch 时不 fail-open', () => {
  assert.equal(toolSurfacePlan(createMask({ deny: ['beta'] }, 'v', 'p'), new Set()).failOpen, false)
  assert.equal(toolSurfacePlan(mask(['ghost'], undefined, false), new Set()).failOpen, false)
})
