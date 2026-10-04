/**
 * 跨模块统一配置卡列表的纯逻辑验收。
 *
 * 覆盖：一次性平铺所有已启用模块的卡、只有当前模块可编辑、显示顺序
 * （层序 → 官方 order → sequence → 输入序，复用 viewOrderedIds）、同 configId
 * 不同模块的身份区分、模块名反查与回落、空输入。
 * 组件渲染不在 Node 测试环境内（无 DOM），因此把可判定逻辑抽成纯函数在此守住。
 *
 * 真值源：`ModuleConfigOrderEntry` 与 `viewOrderedIds` 已定义的排序口径
 * （`shared/module-config-order.ts`、本文件相邻函数），以及实测的无参
 * `/module-config-order` 返回（见 PLAN 验收记录）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { mergeModuleCardList, moduleOrderConfigs } from '../../src/client/data/prompt-config-order.ts'
import { configIdentityKey } from '../../src/shared/module-config-order.ts'

const LAYERS = ['pre-step', 'system-section', 'runtime-context']

const entry = (moduleId, configId, extra = {}) => ({
  moduleId, configId, name: configId, layer: 'pre-step', position: 'after-user', sequence: 0, enabled: true, ...extra,
})

const names = (map) => (id) => map[id]

test('mergeModuleCardList：一次平铺所有已启用模块的卡，不遗漏', () => {
  const entries = [
    entry('ponytail', 'ponytail-rules'),
    entry('skill-surface', 'skill-surface-narrowing'),
    entry('tool-surface', 'tool-surface-resident'),
  ]
  const cards = mergeModuleCardList(entries, LAYERS, 'ponytail', names({ 'skill-surface': '技能面收窄' }))
  assert.deepEqual(cards.map((card) => card.entry.configId), ['ponytail-rules', 'skill-surface-narrowing', 'tool-surface-resident'])
  assert.deepEqual(cards.map((card) => card.current), [true, false, false], '只有当前编辑模块可编辑')
  assert.equal(cards[1].moduleName, '技能面收窄')
  assert.equal(cards[2].moduleName, 'tool-surface', '未登记显示名时回落模块 id')
})

test('mergeModuleCardList：按层序排序，跨模块混排', () => {
  const cards = mergeModuleCardList([
    entry('ponytail', 'late-pre', { layer: 'pre-step', sequence: 10 }),
    entry('skill-surface', 'early-section', { layer: 'system-section', order: 0 }),
    entry('tool-surface', 'early-pre', { layer: 'pre-step', sequence: 0 }),
  ], LAYERS, 'ponytail', names({}))
  // pre-step 的两张按 sequence（该层不看 order），system-section 的层序在后。
  assert.deepEqual(cards.map((card) => card.entry.configId), ['early-pre', 'late-pre', 'early-section'])
})

test('mergeModuleCardList：官方文本层（system-section / runtime-context）看 order 而非 sequence', () => {
  const cards = mergeModuleCardList([
    entry('ponytail', 'seq-first', { layer: 'system-section', order: 100, sequence: 0 }),
    entry('skill-surface', 'order-first', { layer: 'system-section', order: 0, sequence: 999 }),
  ], LAYERS, 'ponytail', names({}))
  assert.deepEqual(cards.map((card) => card.entry.configId), ['order-first', 'seq-first'],
    '这两层用官方 order 定位，sequence 不参与')
})

test('mergeModuleCardList：同层同 order 用 sequence，平局保持输入序', () => {
  const cards = mergeModuleCardList([
    entry('tool-surface', 't2', { sequence: 20 }),
    entry('skill-surface', 's1', { sequence: 10 }),
    entry('tool-surface', 't1', { sequence: 10 }),
    entry('skill-surface', 's2', { sequence: 20 }),
  ], LAYERS, 'tool-surface', names({}))
  // sequence 10 的两张在前（s1 先于 t1）；sequence 20 的两张按输入序（t2 先于 s2）。
  assert.deepEqual(cards.map((card) => card.entry.configId), ['s1', 't1', 't2', 's2'])
})

test('mergeModuleCardList：空与未定义输入返回空列表，未声明的层排到最后', () => {
  assert.deepEqual(mergeModuleCardList(undefined, LAYERS, 'cur', names({})), [])
  assert.deepEqual(mergeModuleCardList([], LAYERS, 'cur', names({})), [])
  const cards = mergeModuleCardList([entry('m', 'unknown-layer', { layer: 'nope' })], LAYERS, 'cur', names({}))
  assert.equal(cards.length, 1, '未声明的层不丢卡，只是排后')
})

test('moduleOrderConfigs：总览投影的 id 含模块身份，同 configId 不混淆', () => {
  const sameName = [entry('m1', 'x'), entry('m2', 'x')]
  const ids = moduleOrderConfigs(sameName).map((config) => config.id)
  assert.notEqual(ids[0], ids[1], '同 configId 不同模块必须产生不同 id，否则统一视图会把两张卡当成一张')
  assert.deepEqual(ids, sameName.map(configIdentityKey))
})
