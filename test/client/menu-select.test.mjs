import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { withSsr, renderElement, makeTranslate } from './support/ssr-render.mjs'

const clientDir = new URL('../../src/client/', import.meta.url)
const read = (file) => readFileSync(new URL(file, clientDir), 'utf8')

function tsxFiles(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix + entry.name
    if (entry.isDirectory()) return tsxFiles(new URL(`${entry.name}/`, dir), `${relative}/`)
    return entry.name.endsWith('.tsx') ? [relative] : []
  })
}

/**
 * 真实渲染（内存转译 TSX + CSS Modules 类名映射，无 Edge）：
 * 能证明"组件实际渲染出什么"，替代原先"读源码正则匹配"的等价部分。
 * 仍保留源码断言的部分都在原处写明原因（portal 内容、CSS 计算值、类型声明、目录级禁令）。
 */
const t = makeTranslate()
const { MenuSelect, PromptConfigList } = await withSsr([
  new URL('../../src/client/ui/MenuSelect.tsx', import.meta.url).href,
  new URL('../../src/client/features/prompts/PromptConfigList.tsx', import.meta.url).href,
])
const { getEngineMeta } = await import('../../engine/schema.mjs')

const html = (component, props) => renderElement(component, props)

const selectOptions = [
  { value: 'a', label: '选项甲', group: '分组一' },
  { value: 'b', label: '选项乙', group: '分组一' },
  { value: 'c', label: '选项丙', group: '分组二', disabled: true },
]
const renderSelect = (extra = {}) => html(MenuSelect, {
  value: 'b', options: selectOptions, onChange: () => {}, ariaLabel: '层级选择', ...extra,
})

test('客户端单选统一复用官方 Menu 选择器', () => {
  // 目录级禁令保留源码扫描：它证明的是"不存在"，渲染断言无法表达否定命题。
  for (const file of tsxFiles(clientDir)) {
    assert.doesNotMatch(read(file), /<\/?select\b/, `${file} 不应保留原生 select`)
  }

  // 真实渲染：触发器就是官方 Menu 的 anchor，ARIA 与图标都由官方 primitive 产出。
  const standard = renderSelect()
  assert.match(standard, /<button[^>]*aria-haspopup="menu"/, '触发器必须声明 aria-haspopup="menu"')
  assert.match(standard, /aria-expanded="false"/, '未展开时 aria-expanded 必须是 false')
  assert.match(standard, /aria-label="层级选择"/, 'aria-label 必须落到真实触发器上')
  assert.match(standard, /class="menuSelectChevron"/, 'chevron 由官方 icon primitive 渲染')
  assert.match(standard, /class="menuSelectTrigger menuSelectTriggerStandard"/, '标准形态使用标准类名')
  assert.match(renderSelect({ compact: true }), /class="menuSelectTrigger menuSelectTriggerCompact"/, 'compact 形态切换真实类名')

  // 真实渲染：选中项标签取自 options；未知 value 回退为 value 本身；空值回退占位文案。
  assert.match(standard, /<span class="menuSelectLabel">选项乙<\/span>/, '选中项显示对应 label')
  assert.match(renderSelect({ value: 'unknown' }), /<span class="menuSelectLabel">unknown<\/span>/, '未知 value 回退显示 value')
  assert.match(renderSelect({ value: '' }), /<span class="menuSelectLabel">（未选择）<\/span>/, '空值回退占位文案')

  // 真实渲染：禁用与校验态透传到触发器。
  const disabled = renderSelect({ disabled: true, 'aria-invalid': true })
  assert.match(disabled, /<button[^>]*disabled=""/, 'disabled 必须落到真实触发器上')
  assert.match(disabled, /aria-invalid="true"/, 'aria-invalid 必须透传')

  // 保留源码断言（渲染拿不到的部分）：
  // - 分组标题（`type: 'label'`）与整个选项列表由官方 Menu 在**展开后经 portal** 渲染，
  //   SSR 的 open=false 静态输出里没有它们，渲染断言只能覆盖触发器一侧；
  // - `portal` 是传给 Menu 的开关 prop，不开浏览器就看不出效果；
  // - `group?: string` 是选项接口的类型声明，不是运行时可观察行为。
  const source = read('ui/MenuSelect.tsx')
  assert.match(source, /portal/)
  assert.match(source, /type: 'label'/)
  assert.match(source, /group\?: string/)
})

test('模块控件紧凑且长文本继续自适应', () => {
  // 数值契约保留源码断言：CSS Modules 的发丝边框、min-height 与 field-sizing 是样式契约，
  // SSR 拿不到计算样式（真实计算值只有 Edge smoke 能断言）。
  const css = read('ui/controls.module.css')
  assert.match(css, /\.configInput\s*\{[^}]*min-height:\s*32px/s)
  assert.match(css, /\.moduleCard \.configInput,\s*\.toolCard \.configInput,\s*\.configForm \.configInput\s*\{[^}]*min-height:\s*28px/s)
  assert.doesNotMatch(css, /\.switch\b/, '开关几何由官方 Switch 拥有')
  assert.match(read('ui/EngineModuleCard.tsx'), /<Switch\s/)
  assert.match(css, /\.menuSelectTriggerCompact\s*\{[^}]*min-height:\s*28px/s)
  assert.match(css, /\.menuSelectTriggerStandard\s*\{[^}]*min-height:\s*36px/s)
  assert.match(css, /\.configTextarea\s*\{[^}]*field-sizing:\s*content;[^}]*max-height:\s*max\(72px,\s*60dvh\)/s)
  assert.match(read('features/prompts/PromptConfigFields.tsx'), /autoResizeTextarea/)
})

test('主会话使用平铺模块列表与合并创建菜单', () => {
  // 页面接线与被移除形态保留源码断言：渲染 MainSessionPage 需要完整 store/session 依赖，
  // 而 `viewMode` 这类断言证明的是"不存在"，只能靠源码扫描。
  const editor = read('features/prompts/PromptConfigsEditor.tsx')
  const page = read('app/workspace/pages/MainSessionPage.tsx')
  const list = read('features/prompts/PromptConfigList.tsx')
  assert.doesNotMatch(editor, /viewMode|通用设置|引擎能力设置/)
  assert.doesNotMatch(page, /viewMode|onViewModeChange/)
  assert.match(editor, /moduleCards\?: ReactNode/)
  // 旧的按插入点分区渲染已移除；`renderLayerSettings` 是本层设置注入点，不是分区渲染。
  assert.doesNotMatch(list, /data-insertion-point|renderLayer\(/)
  assert.match(list, /renderLayerSettings\?:/)
  // 自动保存（store debounce）取代浮动未保存提示/放弃/保存条；工具栏保留校验与保存入口。
  assert.doesNotMatch(list, /放弃修改|保存提示词配置|有未保存提示词配置修改/)

  // 真实渲染 PromptConfigList：工具栏、筛选下拉与空态分支都由实际 DOM 证明。
  const meta = getEngineMeta()
  const renderList = (extra = {}) => html(PromptConfigList, {
    t, meta, configs: [], onPatchConfigs: () => {}, onSaveConfigs: async () => true, ...extra,
  })
  const plain = renderList({ viewFilter: 'all' })
  assert.match(plain, new RegExp(`<button[^>]*class="pillButton"[^>]*>${t('configs.validate')}</button>`), '工具栏渲染校验入口')
  assert.match(plain, new RegExp(`<button[^>]*class="primaryPill"[^>]*>${t('configs.save')}</button>`), '工具栏渲染保存入口')
  assert.match(plain, new RegExp(`aria-label="${t('configs.view.aria')}"`), '筛选下拉的 aria-label 来自字典')
  assert.match(plain, new RegExp(`<span class="menuSelectLabel">${t('configs.view.all')}</span>`), '未筛选时下拉显示「全部」')
  assert.match(plain, /<div class="emptyState">/, '无配置且无筛选时渲染空态容器')
  assert.match(plain, /还没有自定义配置/, '空态给出模板引导文案')

  // moduleCards 的隐藏语义由真实 hidden 属性证明（世界书视图只隐藏模块卡容器，不卸载它）。
  const worldBook = renderList({ viewFilter: 'world-book', moduleCards: 'MODULE-MARKER' })
  assert.match(worldBook, /<div class="configList" hidden="">MODULE-MARKER<\/div>/, '世界书视图隐藏模块卡容器')
  assert.match(renderList({ viewFilter: 'all', moduleCards: 'MODULE-MARKER' }), /<div class="configList">MODULE-MARKER<\/div>/, '非世界书视图显示模块卡容器')

  // 空态区分与清除筛选入口：被筛掉的配置给可操作提示，且与「没有任何配置」不是同一文案。
  assert.match(worldBook, new RegExp(t('configs.noMatch', { keyword: 'world-book' })), '筛选无匹配给出定位提示')
  assert.match(worldBook, new RegExp(`<button[^>]*>${t('configs.clearFilters')}</button>`), '空态提供清除筛选入口')

  // 筛选下拉的层级分类选项保留源码断言：选项列表同样只在 Menu 展开后经 portal 渲染。
  assert.match(list, /LAYER_LABEL_KEYS/)
  assert.match(list, /\.\.\.allLayers\.map\(/)
  assert.match(list, /t\('configs\.view\.layer', \{ layer: translateLabel\(t, LAYER_LABEL_KEYS, item\) \}\)/)
  // 层内卡片由统一装配入口下发；筛选值仍由页面持有并下发（创建路径不写过滤）。
  assert.match(page, /commonCards=\{layers\.commonCards\}/)
  assert.match(page, /viewFilter=\{viewFilter\}/)
  assert.match(read('app/workspace/pages/EngineLayersPanel.tsx'), /layerFilter=\{viewFilter\}/)
  assert.match(page, /extraItems=\{createItems\}/)
  // 模板入口按插入点层级平铺，浮层只列该层模板（不再有一个「从模板新建」聚合项）。
  assert.match(page, /INSERTION_LAYERS\.map/)
  assert.match(page, /t\('main\.addTemplate', \{ layer: translateLabel\(t, LAYER_LABEL_KEYS, layer\) \}\)/)
  assert.match(page, /tpl:\$\{layer\}/)
  assert.match(page, /picker\.openPicker\(id\.slice\(4\)\)/)
  assert.match(page, /layer=\{picker\.layer\}/)
  assert.match(page, /create:blank-tool/)
  assert.match(page, /create:tool-template/)
  assert.match(page, /create:variables/)
  assert.doesNotMatch(page, /从模板新建/)
})
