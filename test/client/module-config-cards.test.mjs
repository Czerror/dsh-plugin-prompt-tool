/**
 * 跨模块配置卡只读视图的纯逻辑验收。
 *
 * 覆盖：按模块分组、排除当前模块、模块名反查与回落、空分组丢弃、总览投影的身份格式。
 * 组件渲染本身不在 Node 测试环境内（无 DOM），因此把可判定逻辑抽成纯函数在此守住。
 *
 * 真值源：`ModuleConfigOrderEntry` 的字段语义（`shared/module-config-order.ts`）与
 * 实测的 `/module-config-order` 无参返回（见 PLAN 的验收记录）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { groupOtherModuleCards, moduleOrderConfigs } from '../../src/client/data/prompt-config-order.ts'
import { configIdentityKey } from '../../src/shared/module-config-order.ts'

const entry = (moduleId, configId, name = configId, extra = {}) => ({
  moduleId, configId, name, layer: 'pre-step', position: 'after-user', sequence: 0, enabled: true, ...extra,
})

const ENTRIES = [
  entry('ponytail', 'ponytail-rules'),
  entry('ponytail', 'ponytail-subagent'),
  entry('skill-surface', 'skill-surface-narrowing'),
  entry('tool-surface', 'tool-surface-resident'),
]

test('groupOtherModuleCards：排除当前模块，其余按模块分组', () => {
  const groups = groupOtherModuleCards(ENTRIES, 'ponytail', () => undefined)
  assert.deepEqual(groups.map((group) => group.moduleId), ['skill-surface', 'tool-surface'])
  assert.deepEqual(groups.map((group) => group.entries.map((item) => item.configId)), [
    ['skill-surface-narrowing'],
    ['tool-surface-resident'],
  ])
  // 当前模块的卡一张都不进分组（它们走 draft.entries 的可编辑路径）。
  assert.equal(groups.some((group) => group.moduleId === 'ponytail'), false)
})

test('groupOtherModuleCards：模块名反查，取不到时回落模块 id', () => {
  const names = new Map([['skill-surface', '技能面收窄']])
  const groups = groupOtherModuleCards(ENTRIES, 'ponytail', (id) => names.get(id))
  assert.equal(groups.find((group) => group.moduleId === 'skill-surface').name, '技能面收窄')
  assert.equal(groups.find((group) => group.moduleId === 'tool-surface').name, 'tool-surface', '未登记显示名时回落 id')
})

test('groupOtherModuleCards：空与非数组输入都返回空分组，不抛错', () => {
  assert.deepEqual(groupOtherModuleCards([], 'ponytail', () => undefined), [])
  assert.deepEqual(groupOtherModuleCards(undefined, 'ponytail', () => undefined), [])
  // 只有当前模块时没有任何其它模块可展示。
  assert.deepEqual(groupOtherModuleCards([entry('ponytail', 'a')], 'ponytail', () => undefined), [])
})

test('groupOtherModuleCards：同模块多卡保持输入顺序，不合并也不去重', () => {
  const groups = groupOtherModuleCards([entry('m1', 'a'), entry('m1', 'b'), entry('m2', 'c')], 'cur', () => undefined)
  assert.deepEqual(groups.map((group) => group.entries.map((item) => item.configId)), [['a', 'b'], ['c']])
})

test('moduleOrderConfigs：总览投影的 id 含模块身份，可与当前模块的卡区分', () => {
  const configs = moduleOrderConfigs(ENTRIES)
  assert.equal(configs.length, ENTRIES.length)
  // 同 configId、不同模块必须产生不同 id——否则跨模块视图会把两张卡当成一张。
  const sameName = [entry('m1', 'x'), entry('m2', 'x')]
  const ids = moduleOrderConfigs(sameName).map((config) => config.id)
  assert.notEqual(ids[0], ids[1])
  assert.deepEqual(ids, sameName.map(configIdentityKey))
})
