// 同层多实例的规模回归（PLAN 验收：合成 128 卡样本 + 至少 64 张系统段卡）：
// 数量、身份、顺序在渲染与逐卡操作后都不折叠、不串值，也不就地改写传入数组。
// 样本分布对齐只读解析过的本地预设（pre-step 大量独立卡、system-section 多段），
// 但用合成 id/order/参数值，不复制任何真实预设正文。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { createElement, isValidElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { getEngineMeta } from '../../engine/schema.mjs'
import { PROMPT_TOOL_DICTS } from '../../src/client/locales.ts'
import { viewOrderedIds } from '../../src/client/features/prompts/prompt-config-order.ts'

const reactModules = Object.fromEntries(['react', 'react/jsx-runtime', 'react-dom'].map((name) => [name, import.meta.resolve(name)]))
const loader = registerHooks({
  resolve(specifier, context, nextResolve) {
    return reactModules[specifier] === undefined ? nextResolve(specifier, context) : { url: reactModules[specifier], shortCircuit: true }
  },
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) {
      const source = readFileSync(new URL(url), 'utf8')
      const names = [...new Set([...source.matchAll(/\.([A-Za-z_][\w-]*)/g)].map(([, name]) => name))]
      return { format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(Object.fromEntries(names.map((name) => [name, name])))}` }
    }
    if (url.endsWith('.tsx')) return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2024 },
    }).outputText }
    return nextLoad(url, context)
  },
})
const { PromptConfigList } = await import('../../src/client/features/prompts/PromptConfigList.tsx')
const { PromptConfigCard } = await import('../../src/client/features/prompts/PromptConfigCard.tsx')
loader.deregister()

// 删除后的焦点回归只在浏览器里跑；Node 下让 rAF 静默吞掉回调（不触碰 DOM）。
globalThis.requestAnimationFrame ??= () => 0
const render = (component, props) => renderToStaticMarkup(createElement(component, props))
const tree = (component, props) => {
  let result
  function Probe() { result = component(props); return null }
  render(Probe)
  return result
}
const find = (node, predicate) => {
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean)
  if (!isValidElement(node)) return undefined
  return predicate(node) ? node : find(node.props.children, predicate)
}
const zh = PROMPT_TOOL_DICTS.zh
const t = (key, params) => {
  let text = zh[key] ?? key
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}
const meta = getEngineMeta()
const listProps = (configs, onPatchConfigs) => ({
  t, meta, configs, viewFilter: 'all', onPatchConfigs, onSaveConfigs: async () => true, onNotice: () => {},
})

/** 合成样本：消息批层 120 张（启用 18）+ 系统段层 64 张（启用 4），每层 order 各不相同。 */
function syntheticSample() {
  const preStep = Array.from({ length: 120 }, (_, index) => ({
    id: `pre-${String(index).padStart(3, '0')}`,
    name: `消息批 ${index}`,
    layer: 'pre-step',
    strategy: 'static',
    order: index * 10,
    enabled: index < 18,
    text: `消息批正文 ${index}`,
    params: { maxOutputChars: 1000 + index },
  }))
  const systemSections = Array.from({ length: 64 }, (_, index) => ({
    id: `sys-${String(index).padStart(3, '0')}`,
    name: `系统段 ${index}`,
    layer: 'system-section',
    strategy: 'static',
    order: index * 10,
    enabled: index < 4,
    text: `系统段正文 ${index}`,
    params: { section: index },
  }))
  return [...preStep, ...systemSections]
}

test('合成 184 卡：渲染与层内顺序保持数量与身份，不折叠也不分区', () => {
  const configs = syntheticSample()
  assert.equal(configs.length, 184)
  const html = render(PromptConfigList, listProps(configs, () => {}))
  const ids = [...html.matchAll(/data-config-id="([^"]+)"/g)].map(([, id]) => id)
  assert.equal(ids.length, 184, '每张实例卡都独立渲染')
  assert.equal(new Set(ids).size, 184, '卡 id 不重复')
  assert.equal(ids.filter((id) => id.startsWith('pre-')).length, 120)
  assert.equal(ids.filter((id) => id.startsWith('sys-')).length, 64)
  assert.equal((html.match(/aria-expanded="false"/g) ?? []).length >= 184, true, '每张实例保留最外层折叠入口')
  assert.doesNotMatch(html, /data-config-tab=|data-config-view=|data-layer-settings-content=/, '折叠的巨量列表不挂载内部编辑器')
  // 层内顺序按 order 稳定排序，跨层不互相移动。
  const preIds = viewOrderedIds(configs, 'pre-step', meta.layers)
  assert.deepEqual(preIds.slice(0, 3), ['pre-000', 'pre-001', 'pre-002'])
  assert.deepEqual(preIds.slice(-2), ['pre-118', 'pre-119'])
  const sysIds = viewOrderedIds(configs, 'system-section', meta.layers)
  assert.equal(sysIds.length, 64)
  assert.deepEqual(sysIds.slice(0, 3), ['sys-000', 'sys-001', 'sys-002'])
})

test('合成 184 卡：复制、排序、启停、删除都只作用于目标实例', () => {
  const configs = syntheticSample()
  const before = structuredClone(configs)
  const patches = []
  const nodes = tree(PromptConfigList, listProps(configs, (next) => patches.push(next)))
  const cardOf = (id) => find(nodes, (node) => node.type === PromptConfigCard && node.props.config.id === id)
  const targetCard = cardOf('pre-005')
  assert.ok(targetCard, '目标实例卡存在')

  // 复制：新 id 追加在末尾，其余实例保持同一引用（不重建、不串值）。
  targetCard.props.onDuplicate('pre-005')
  const duplicated = patches.at(-1)
  assert.equal(duplicated.length, 185)
  assert.equal(duplicated.at(-1).id, 'pre-005-copy')
  assert.deepEqual(duplicated.at(-1).params, { maxOutputChars: 1005 })
  for (let index = 0; index < configs.length; index++) {
    assert.equal(duplicated[index], configs[index], `复制不得重建第 ${index} 张实例`)
  }

  // 层内上移：只与同层相邻实例交换位置，系统段层实例引用不变。
  const moveCard = cardOf('pre-006')
  assert.equal(moveCard.props.canMoveUp, true)
  moveCard.props.onMoveUp('pre-006')
  const moved = patches.at(-1)
  assert.deepEqual(viewOrderedIds(moved, 'pre-step', meta.layers).slice(0, 8),
    ['pre-000', 'pre-001', 'pre-002', 'pre-003', 'pre-004', 'pre-006', 'pre-005', 'pre-007'])
  assert.deepEqual(viewOrderedIds(moved, 'system-section', meta.layers), viewOrderedIds(configs, 'system-section', meta.layers))
  for (const id of ['sys-000', 'sys-063', 'pre-119']) {
    assert.equal(moved.find((item) => item.id === id), configs.find((item) => item.id === id), `${id} 不得被排序改写`)
  }

  // 启停：只重建目标实例且只改 enabled，其他实例保持同一引用。
  cardOf('sys-010').props.onToggleEnabled('sys-010', false)
  const toggled = patches.at(-1)
  const toggledTarget = toggled.find((item) => item.id === 'sys-010')
  assert.equal(toggledTarget.enabled, false)
  const originalTarget = configs.find((item) => item.id === 'sys-010')
  assert.deepEqual(Object.keys(toggledTarget).sort(), Object.keys(originalTarget).sort(), '启停不增删字段')
  for (const [key, fieldValue] of Object.entries(originalTarget)) {
    if (key === 'enabled') continue
    assert.deepEqual(toggledTarget[key], fieldValue, `启停不得改动 ${key}`)
  }
  for (const id of ['pre-000', 'sys-011', 'pre-119']) {
    assert.equal(toggled.find((item) => item.id === id), configs.find((item) => item.id === id), `${id} 不得被启停重建`)
  }

  // 删除：只移除目标实例，同层其他实例的 order 与内容不变。
  cardOf('pre-007').props.onDelete('pre-007')
  const deleted = patches.at(-1)
  assert.equal(deleted.length, 183)
  assert.equal(deleted.some((item) => item.id === 'pre-007'), false)
  assert.equal(deleted.find((item) => item.id === 'pre-008').order, configs.find((item) => item.id === 'pre-008').order)
  for (const id of ['pre-000', 'sys-000', 'sys-063']) {
    assert.equal(deleted.find((item) => item.id === id), configs.find((item) => item.id === id))
  }
  // 全部操作都不就地改写传入数组，也不携带 promptConfigs 之外的字段。
  assert.deepEqual(configs, before, '实例数组保持只读')
  assert.ok(patches.every((patch) => Array.isArray(patch)), '每次操作只提交 promptConfigs 数组')
})

test('合成 184 卡：同名局部参数互不串值，配置实例与全局变量分离', () => {
  const configs = syntheticSample()
  // 同名局部参数（两条不同实例的 variables.section 同名键）：值各自独立。
  const withSameKey = configs.map((config, index) => index === 0 || index === 120
    ? { ...config, variables: { shared: `value-${index}` } }
    : config)
  const html = render(PromptConfigList, listProps(withSameKey, () => {}))
  assert.equal((html.match(/data-config-id="/g) ?? []).length, 184)
  const first = withSameKey.find((config) => config.id === 'pre-000')
  const second = withSameKey.find((config) => config.id === 'sys-000')
  assert.equal(first.variables.shared, 'value-0')
  assert.equal(second.variables.shared, 'value-120')
  // 删除一条实例不影响另一条的同名局部参数（数组过滤语义，不是键级合并）。
  const patches = []
  const nodes = tree(PromptConfigList, listProps(withSameKey, (next) => patches.push(next)))
  find(nodes, (node) => node.type === PromptConfigCard && node.props.config.id === 'pre-000').props.onDelete('pre-000')
  assert.equal(patches.at(-1).find((config) => config.id === 'sys-000').variables.shared, 'value-120')
})
