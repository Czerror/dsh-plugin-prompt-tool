/**
 * 过滤 / 新建 严格分离的回归断言（F1–F5）。
 *
 * 规则（用户指定）：
 * 1. 过滤只能由用户手动改变——任何创建路径不得写入过滤状态或搜索词；
 * 2. 新建只做两件事——展开新卡 + 滚动定位；
 * 3. 新建即可见——受众随列表作用域代入，而不是把过滤框改成"全部"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { PROMPT_TOOL_DICTS } from '../../src/client/locales.ts'
import { createConfigFromTemplate } from '../../src/client/features/prompts/useTemplatePicker.ts'

const read = (path) => readFileSync(new URL(`../../src/client/${path}`, import.meta.url), 'utf8')
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
loader.deregister()

const render = (component, props) => renderToStaticMarkup(createElement(component, props))
const zh = PROMPT_TOOL_DICTS.zh
const t = (key, params) => {
  let text = zh[key] ?? key
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}
const meta = {
  layers: ['pre-step', 'system-section', 'runtime-context', 'agent-request', 'llm-stream', 'tool-pipeline'],
  strategies: [], slotKinds: [], positions: [], dedupes: [], promotions: [], audienceModes: [], modelScopes: [], roles: [], mergeModes: [], fills: [],
  layerFieldPolicies: {}, layerLabels: {},
}
const configListProps = (overrides = {}) => ({
  t,
  meta,
  configs: [],
  viewFilter: 'all',
  onPatchConfigs() {},
  onSaveConfigs() {},
  onNotice() {},
  ...overrides,
})

test('新建派生纯函数：受众随作用域代入，不改模板与既有列表', () => {
  const entry = { file: '70-subagent-maintenance.yml', spec: { id: 'sub', layer: 'pre-step', strategy: 'static', audience: 'subagent', text: 'x' } }
  // 子代理列表新建 → 仅子代理（当前视图可见）。
  const viaSubagent = createConfigFromTemplate(entry, [], 'subagent')
  assert.equal(viaSubagent.audience, 'subagent')
  // 主会话列表新建 → 清除模板自带的「仅子代理」，回落公用（两侧都可见），避免新建即消失。
  const viaMain = createConfigFromTemplate(entry, [], 'main')
  assert.equal(viaMain.audience, null)
  // 不传作用域 → 不改动模板受众（纯派生语义）。
  assert.equal(createConfigFromTemplate(entry, []).audience, 'subagent')
  // 纯函数不修改输入对象。
  assert.equal(entry.spec.audience, 'subagent')
  // 公用模板在主会话列表保持公用。
  const shared = { file: 'x.yml', spec: { id: 'shared', layer: 'pre-step', strategy: 'static' } }
  assert.equal(createConfigFromTemplate(shared, [], 'subagent').audience, 'subagent')
  assert.equal(createConfigFromTemplate(shared, [], 'main').audience, undefined)
})

test('新建派生的 id 去重与 identity 跟随同时成立（同一模板重复插入）', () => {
  const entry = { file: 'a.yml', spec: { id: 'dup', layer: 'pre-step', strategy: 'static', identity: { field: 'plugin', value: 'dup' } } }
  const first = createConfigFromTemplate(entry, [], 'subagent')
  assert.equal(first.id, 'dup')
  const second = createConfigFromTemplate(entry, [first], 'subagent')
  assert.equal(second.id, 'dup-2')
  assert.equal(second.identity.value, 'dup-2', 'identity 跟随新 id，避免与首条碰撞')
})

test('新建派生保留策略降级（instruction-hint → placeholder）', () => {
  const entry = { file: 'b.yml', spec: { id: 'hint', layer: 'pre-step', strategy: 'instruction-hint' } }
  const draft = createConfigFromTemplate(entry, [], 'subagent')
  assert.equal(draft.strategy, 'placeholder')
  assert.equal(draft.fill, 'instruction-hint')
})

test('子代理作用域新建的配置立刻可见并处于展开态', () => {
  const created = { id: 'sub-new', layer: 'pre-step', strategy: 'static', audience: 'subagent', text: 'hello' }
  const html = render(PromptConfigList, configListProps({
    configs: [created],
    scope: 'subagent',
    createdConfigId: 'sub-new',
  }))
  assert.match(html, /data-config-id="sub-new"/, '新建的配置带稳定定位锚点')
  // 展开由 useEffect 依据 createdConfigId 设置；静态标记只验证定位信号已下发，
  // 展开/滚动行为由源码断言与 engine-module-cards 的展开用例共同覆盖。
  assert.match(html, /checked=""/, '新建的配置默认启用')
  // 对照：仅主会话可见的配置不会出现在子代理视图（作用域过滤仍然生效）。
  const hidden = render(PromptConfigList, configListProps({
    configs: [{ id: 'main-only', layer: 'pre-step', strategy: 'static', audience: 'main', text: 'secret' }],
    scope: 'subagent',
  }))
  assert.doesNotMatch(hidden, /data-config-id="main-only"/, '仅主会话配置不进子代理视图')
})

test('创建与过滤分离：创建路径不写过滤状态，过滤只由下拉写入', () => {
  const list = read('features/prompts/PromptConfigList.tsx')
  const picker = read('features/prompts/useTemplatePicker.ts')
  // 过滤状态只有受控与内部两条通道，且都由下拉触发。
  const change = list.slice(list.indexOf('const changeViewFilter'), list.indexOf('const effectiveLayer'))
  assert.match(change, /if \(onViewFilterChange !== undefined\) onViewFilterChange\(value\)/)
  assert.match(change, /setInnerViewFilter\(value\)/)
  assert.equal([...list.matchAll(/setInnerViewFilter\(/g)].length, 1, '过滤状态只有一处写入')
  assert.match(list, /value=\{viewFilter\}[\s\S]{0,400}onChange=\{changeViewFilter\}/, '过滤下拉是唯一入口')
  // 创建链路：派生纯函数与 hook 都不得出现过滤相关标识。
  assert.doesNotMatch(picker, /ViewFilter|setFilter\(/, '新建派生不触碰过滤状态')
  assert.doesNotMatch(picker, /setExpanded|scrollIntoView/, '展开与滚动由列表按 createdConfigId 统一处理')
})

test('创建后的定位信号与滚动实现：重复创建同一能力仍会再次触发展开', () => {
  const page = read('app/workspace/pages/MainSessionPage.tsx')
  // 一次性信号：token 递增，避免"同 id 第二次创建不展开"。
  assert.match(page, /setFocusCapability\(\(current\) => \(\{ id, token: \(current\?\.token \?\? 0\) \+ 1 \}\)\)/)
  assert.match(page, /focusCapability=\{focusCapability\}/)
  // 选中能力卡后滚动定位到稳定锚点；不修改任何筛选状态。
  const modules = read('features/modules/EngineModuleList.tsx')
  assert.match(modules, /scrollToCreatedCard\(`\[data-module-card-id="\$\{cssEscapeId\(focusId\)\}"\]`\)/)
  assert.match(modules, /anchorId=\{capability\.id\}/)
  assert.doesNotMatch(modules, /setViewFilter|changeViewFilter/, '定位不动过滤')
  const reveal = read('ui/reveal-card.ts')
  assert.match(reveal, /scrollIntoView\(\{ block: 'nearest', inline: 'nearest' \}\)/, '块级对齐用 nearest，避免整页跳动')
  assert.match(reveal, /SCROLL_MAX_ATTEMPTS/, '节点未就绪按上限重试后静默退出')
})

test('复制配置保留受众，且不改动过滤状态', () => {
  const list = read('features/prompts/PromptConfigList.tsx')
  const duplicate = list.slice(list.indexOf('const handleDuplicate'), list.indexOf('const handleDelete'))
  assert.match(duplicate, /const clone = JSON\.parse\(JSON\.stringify\(source\)\) as PromptConfigDraft/)
  assert.doesNotMatch(duplicate, /audience/, '复制不改受众')
  assert.doesNotMatch(duplicate, /ViewFilter|setFilter\(/, '复制不触碰过滤与搜索词')
})

test('子代理页创建入口对等，且不下发指令文件卡（单编辑入口）', () => {
  const subagent = read('app/workspace/pages/SubagentPage.tsx')
  for (const needle of ['EngineModuleActions', 'EngineModuleCards', 'CustomToolsCard', 'INSERTION_LAYERS', 'TemplateVariablesModuleCard']) {
    assert.ok(subagent.includes(needle), `子代理页具备 ${needle} 入口`)
  }
  // 指令文件卡是主会话概念：子代理作用域不下发，避免同一文件双编辑入口。
  const wrapper = read('app/workspace/pages/ConfigListWithTemplates.tsx')
  assert.match(wrapper, /const instructionScope = scope === undefined \|\| scope === 'main'/)
  assert.match(wrapper, /instructionPolicy=\{instructionScope \? store\.instructionPolicy : undefined\}/)
  assert.match(wrapper, /onSaveInstructionFile=\{instructionScope \? saveInstructionFile : undefined\}/)
  assert.match(wrapper, /onPatchInstructionPolicy=\{instructionScope \? patchInstructionPolicy : undefined\}/)
  // 列表侧：未下发策略时不渲染指令文件卡（undefined 分支）。
  const list = read('features/prompts/PromptConfigList.tsx')
  assert.match(list, /props\.instructionPolicy !== undefined && props\.onToggleInstructionSource !== undefined/)
})

test('置顶卡片渲染在过滤行之前（列表顶部语义）', () => {
  const list = read('features/prompts/PromptConfigList.tsx')
  const beforeIndex = list.indexOf('{beforeCards}')
  const filterIndex = list.indexOf('styles.listFilterRow')
  assert.ok(beforeIndex > 0 && filterIndex > 0)
  assert.ok(beforeIndex < filterIndex, 'beforeCards 在过滤行之前')
  assert.equal([...list.matchAll(/\{beforeCards\}/g)].length, 1, '置顶卡片只渲染一次')
})

test('空状态文案不再承诺 settings 覆盖层语义', () => {
  const zhDict = read('locales.ts')
  assert.doesNotMatch(zhDict, /settings 覆盖层，切换预设后仍保留/)
  assert.doesNotMatch(zhDict, /stored as a settings overlay and kept across preset switches/)
  assert.match(zhDict, /写入激活预设 preset\.yml，随预设走/)
})
