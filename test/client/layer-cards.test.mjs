/**
 * 层卡片的唯一判据：某模块在某一层下有哪些卡、各是什么 kind。
 * 真值源是共享能力/编辑组契约与 module.yml 声明面的语义，不是实现细节。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ENGINE_EDITOR_GROUP_MAP, MODULE_CAPABILITIES, moduleCapability } from '../../src/shared/engine-capabilities.ts'
import { layerCards } from '../../src/client/data/layer-cards.ts'

const facts = (declaredModules) => ({
  declaredModules,
  effectiveModules: declaredModules,
  rowIds: [],
  sourceMode: 'explicit',
  editable: true,
})

const single = ({ declares, declaredModules } = {}) => [{
  id: 'mod',
  name: 'mod',
  enabled: true,
  ...(declares === undefined ? {} : { declares }),
  ...(declaredModules === undefined ? {} : { facts: facts(declaredModules) }),
}]

const kindsOf = (cards, id) => cards.filter((card) => card.id === id).map((card) => card.kind)

test('layerCards：能力组的参数卡与能力行都要求显式声明，声明后各出一张', () => {
  const undeclared = layerCards(single(), 'pre-step', 'mod')
  assert.deepEqual(kindsOf(undeclared, 'instruction-hint'), ['missingCapability'], '未声明时只有可创建项，参数卡与能力行都不出现')
  const declared = layerCards(single({ declaredModules: ['instruction-hint'] }), 'pre-step', 'mod')
  assert.deepEqual(kindsOf(declared, 'instruction-hint').sort(), ['capability', 'param'], '同 id 两种 kind 各一张')
})

test('layerCards：未声明的能力给出 missingCapability 创建项，声明后变 capability', () => {
  const undeclared = layerCards(single(), 'tool-pipeline', 'mod')
  assert.ok(kindsOf(undeclared, 'tool-config-engine').includes('missingCapability'), '未声明 → 可创建')
  const declared = layerCards(single({ declaredModules: ['tool-config-engine'] }), 'tool-pipeline', 'mod')
  assert.ok(kindsOf(declared, 'tool-config-engine').includes('capability'), '声明后 → 已声明')
  assert.ok(!kindsOf(declared, 'tool-config-engine').includes('missingCapability'))
})

test('layerCards：未声明且有登记节的资产给出 add 入口，声明后变 asset', () => {
  const undeclared = layerCards(single({ declares: [] }), 'runtime-context', 'mod')
  assert.deepEqual(kindsOf(undeclared, 'variables'), ['add'])
  const declared = layerCards(single({ declares: ['variables', 'variablesEnabled'] }), 'runtime-context', 'mod')
  assert.deepEqual(kindsOf(declared, 'variables'), ['asset'])
})

test('layerCards：参数卡全是能力组——能力补卡用 [param, capability] 的前提', () => {
  // 守门：补卡渲染传 ['param','capability'] 依赖「有扁平参数的编辑组都是能力组」。
  // 新增非能力参数组时这条会红，届时补卡要改成按能力标记过滤。
  const declaredModules = MODULE_CAPABILITIES.flatMap((capability) => capability.moduleKeys)
  const modules = single({ declaredModules })
  const layers = [...new Set(ENGINE_EDITOR_GROUP_MAP.map((group) => group.displayLayer))]
  for (const layer of layers) {
    for (const card of layerCards(modules, layer, 'mod')) {
      if (card.kind !== 'param') continue
      assert.ok(moduleCapability(card.id) !== undefined, card.id + ' 是参数卡但不是能力组')
    }
  }
})

test('layerCards：exclude 命中的 id 不出卡', () => {
  const cards = layerCards(single({ declares: ['variables'] }), 'runtime-context', 'mod', ['variables'])
  assert.deepEqual(kindsOf(cards, 'variables'), [])
})

test('layerCards：未登记声明面的资产不门控，声明面未下发时不当作未声明', () => {
  const cards = layerCards(single(), 'agent-request', 'mod')
  assert.deepEqual(kindsOf(cards, 'main-model'), ['asset'], '未登记节的资产直接出卡')
  const unknown = layerCards(single(), 'runtime-context', 'mod')
  assert.deepEqual(kindsOf(unknown, 'variables'), ['asset'], '声明面未下发不等于未声明')
})
