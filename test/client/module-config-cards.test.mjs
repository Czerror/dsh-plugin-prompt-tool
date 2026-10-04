/**
 * 跨模块统一配置卡列表的纯逻辑验收。
 *
 * 覆盖：一次性合并所有已启用模块的卡、当前模块可编辑而其余只读、显示顺序
 * （层序 → order → 模块内 sequence → 模块声明序 → 输入序）、身份去重、
 * 模块名反查与回落，以及总览投影的身份格式。
 * 组件渲染本身不在 Node 测试环境内（无 DOM），因此把可判定逻辑抽成纯函数在此守住。
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

const SOURCES = [
  { moduleId: 'ponytail', name: 'Ponytail', index: 0 },
  { moduleId: 'skill-surface', name: '技能面收窄', index: 1 },
  { moduleId: 'tool-surface', name: '工具面收窄', index: 2 },
]

test('mergeModuleCardList：一次平铺所有已启用模块的卡，不遗漏也不重复', () => {
  const current = [entry('ponytail', 'ponytail-rules')]
  const all = [
    ...current,
    entry('skill-surface', 'skill-surface-narrowing'),
    entry('tool-surface', 'tool-surface-resident'),
  ]
  const cards = mergeModuleCardList(current, all, SOURCES, 'ponytail', LAYERS)
  assert.equal(cards.length, 3, '三个模块的卡都在同一个列表里')
  assert.deepEqual(cards.map((card) => card.entry.configId).sort(), ['ponytail-rules', 'skill-surface-narrowing', 'tool-surface-resident'])
  // 当前模块的卡与「其它」输入重叠时按身份去重，不会出现两张。
  const keys = cards.map((card) => configIdentityKey(card.entry))
  assert.equal(new Set(keys).size, keys.length)
})

test('mergeModuleCardList：只有当前编辑模块标 current，其余只读', () => {
  const cards = mergeModuleCardList(
    [entry('ponytail', 'a')],
    [entry('ponytail', 'a'), entry('skill-surface', 'b'), entry('tool-surface', 'c')],
    SOURCES,
    'ponytail',
    LAYERS,
  )
  assert.deepEqual(cards.map((card) => [card.entry.configId, card.current]), [['a', true], ['b', false], ['c', false]])
  // 模块名反查，未登记时回落模块 id。
  assert.equal(cards.find((card) => card.entry.configId === 'b').moduleName, '技能面收窄')
  assert.equal(mergeModuleCardList([], [entry('ghost', 'x')], SOURCES, 'cur', LAYERS)[0].moduleName, 'ghost')
})

test('mergeModuleCardList：按层序与官方 order 排序，跨模块混排', () => {
  const cards = mergeModuleCardList([], [
    entry('ponytail', 'late-pre', { layer: 'pre-step', order: 10 }),
    entry('skill-surface', 'early-section', { layer: 'system-section', order: 0 }),
    entry('tool-surface', 'early-pre', { layer: 'pre-step', order: 0 }),
  ], SOURCES, 'cur', LAYERS)
  assert.deepEqual(cards.map((card) => card.entry.configId), ['early-pre', 'late-pre', 'early-section'],
    '先按 LAYERS 的层序，再按官方 order')
})

test('mergeModuleCardList：同层同 order 用模块内 sequence，再平局用模块声明序', () => {
  const cards = mergeModuleCardList([], [
    entry('tool-surface', 't2', { sequence: 20 }),
    entry('skill-surface', 's1', { sequence: 10 }),
    entry('tool-surface', 't1', { sequence: 10 }),
    entry('skill-surface', 's2', { sequence: 20 }),
  ], SOURCES, 'cur', LAYERS)
  // sequence 10 的两个模块：skill-surface(1) 在 tool-surface(2) 之前；sequence 20 同理。
  assert.deepEqual(cards.map((card) => card.entry.configId), ['s1', 't1', 's2', 't2'])
})

test('mergeModuleCardList：空与未定义输入都返回空列表，不抛错', () => {
  assert.deepEqual(mergeModuleCardList(undefined, undefined, SOURCES, 'cur', LAYERS), [])
  assert.deepEqual(mergeModuleCardList([], [], SOURCES, 'cur', LAYERS), [])
  // 未声明的层排到最后，而不是丢弃整张卡。
  const cards = mergeModuleCardList([], [entry('m', 'unknown-layer', { layer: 'nope' })], SOURCES, 'cur', LAYERS)
  assert.equal(cards.length, 1)
})

test('moduleOrderConfigs：总览投影的 id 含模块身份，可与当前模块的卡区分', () => {
  const sameName = [entry('m1', 'x'), entry('m2', 'x')]
  const ids = moduleOrderConfigs(sameName).map((config) => config.id)
  assert.notEqual(ids[0], ids[1], '同 configId 不同模块必须产生不同 id，否则统一视图会把两张卡当成一张')
  assert.deepEqual(ids, sameName.map(configIdentityKey))
})
