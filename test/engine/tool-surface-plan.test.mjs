/**
 * 工具可见面计划：三面（目录 / SDK 正文 / 执行闸）共用的 fail-open 判据。
 * 真值源是声明语义：放宽只在**静态 allow 全部缺失**时发生；解锁名不参与判定。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMask, toolSurfacePlan } from '../../engine/actions/shared.mjs'

const mask = (allow, extra, requireMatch = true) => createMask({ allow, requireMatch }, 'v', 'p', extra)

test('toolSurfacePlan：名单齐全时不 fail-open，missing 为空', () => {
  const plan = toolSurfacePlan(mask(['alpha', 'beta']), new Set(['alpha', 'beta', 'run_code']))
  assert.deepEqual(plan, { failOpen: false, missing: [] })
})

test('toolSurfacePlan：只缺一个名字时照常收窄，missing 只作诊断', () => {
  const plan = toolSurfacePlan(mask(['alpha', 'ghost']), new Set(['alpha']))
  assert.deepEqual(plan, { failOpen: false, missing: ['ghost'] })
})

test('toolSurfacePlan：静态 allow 全部缺失时 fail-open 并给出全部名字', () => {
  const plan = toolSurfacePlan(mask(['ghost', 'phantom']), new Set(['alpha']))
  assert.deepEqual(plan, { failOpen: true, missing: ['ghost', 'phantom'] })
})

test('toolSurfacePlan：解锁名不参与 fail-open（只做加法）', () => {
  const extra = new Set(['unlocked'])
  assert.deepEqual(toolSurfacePlan(mask(['alpha'], extra), new Set(['alpha'])), { failOpen: false, missing: [] })
  // 静态名单全缺时仍然放宽，解锁名不改变结论。
  assert.deepEqual(toolSurfacePlan(mask(['ghost'], extra), new Set(['alpha'])), { failOpen: true, missing: ['ghost'] })
})

test('toolSurfacePlan：deny-only 或未声明 requireMatch 时不 fail-open', () => {
  assert.equal(toolSurfacePlan(createMask({ deny: ['beta'] }, 'v', 'p'), new Set()).failOpen, false)
  assert.equal(toolSurfacePlan(mask(['ghost'], undefined, false), new Set()).failOpen, false)
})

test('toolSurfacePlan：deny 覆盖的名字不算必需，不因它缺席 fail-open', () => {
  const denied = createMask({ allow: ['read', 'bash'], deny: ['bash'], requireMatch: true }, 'v', 'p')
  assert.deepEqual(toolSurfacePlan(denied, new Set(['read'])), { failOpen: false, missing: [] })
  // deny 剔完后名单全缺 → 仍然放宽（required 只剩 read）。
  assert.deepEqual(toolSurfacePlan(denied, new Set(['write'])), { failOpen: true, missing: ['read'] })
})

test('toolSurfacePlan：run_code 虽可点名但不计入 required', () => {
  assert.deepEqual(toolSurfacePlan(mask(['alpha', 'run_code']), new Set(['alpha'])), { failOpen: false, missing: [] })
  assert.deepEqual(toolSurfacePlan(mask(['run_code']), new Set(['alpha'])), { failOpen: false, missing: [] })
})
