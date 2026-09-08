import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'

const clientDir = new URL('../../src/client/', import.meta.url)
const read = (file) => readFileSync(new URL(file, clientDir), 'utf8')

function tsxFiles(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix + entry.name
    if (entry.isDirectory()) return tsxFiles(new URL(`${entry.name}/`, dir), `${relative}/`)
    return entry.name.endsWith('.tsx') ? [relative] : []
  })
}

test('客户端单选统一复用官方 Menu 选择器', () => {
  for (const file of tsxFiles(clientDir)) {
    assert.doesNotMatch(read(file), /<\/?select\b/, `${file} 不应保留原生 select`)
  }
  const source = read('ui/MenuSelect.tsx')
  assert.match(source, /IconChevronDownOutline14, Menu/)
  assert.match(source, /portal/)
  assert.match(source, /compact=\{compact\}/)
  assert.match(source, /aria-haspopup="menu"/)
  assert.match(source, /type: 'label'/)
  assert.match(source, /group\?: string/)
})

test('模块控件紧凑且长文本继续自适应', () => {
  const css = read('ui/controls.module.css')
  assert.match(css, /\.configInput\s*\{[^}]*height:\s*28px/s)
  assert.match(css, /\.moduleCard \.switch[\s\S]*?width:\s*32px;[\s\S]*?height:\s*18px/s)
  assert.match(css, /\.configInput\s*\{[^}]*height:\s*34px/s)
  assert.match(css, /\.menuSelectTriggerCompact\s*\{[^}]*height:\s*28px/s)
  assert.match(css, /\.menuSelectTriggerStandard\s*\{[^}]*height:\s*36px/s)
  assert.match(css, /\.configTextarea\s*\{[^}]*field-sizing:\s*content;[^}]*max-height:\s*60vh/s)
  assert.match(read('features/prompts/PromptConfigFields.tsx'), /autoResizeTextarea/)
})

test('主会话使用平铺模块列表与合并创建菜单', () => {
  const editor = read('features/prompts/PromptConfigsEditor.tsx')
  const page = read('app/workspace/pages/MainSessionPage.tsx')
  const list = read('features/prompts/PromptConfigList.tsx')
  assert.doesNotMatch(editor, /viewMode|通用设置|引擎能力设置/)
  assert.doesNotMatch(page, /viewMode|onViewModeChange/)
  assert.match(editor, /afterCards\?: ReactNode/)
  assert.match(list, /afterCards === undefined \?/)
  assert.doesNotMatch(list, /renderLayer|data-insertion-point/)
  // 自动保存（store debounce）取代浮动未保存提示/放弃/保存条；工具栏保留校验与保存入口。
  assert.doesNotMatch(list, /放弃修改|保存提示词配置|有未保存提示词配置修改/)
  assert.match(list, /'校验中…' : '校验'/)
  assert.match(list, /'保存中…' : '保存'/)
  assert.match(list, /能力模块不受此搜索影响/)
  // 下拉仍保留插入点层级分类（只过滤、不生成分类区块）。
  assert.match(list, /LAYER_LABELS/)
  assert.match(list, /\.\.\.allLayers\.map\(/)
  assert.match(list, /层级：\$\{LAYER_LABELS/)
  assert.match(list, /ariaLabel="按层级或策略过滤"/)
  assert.match(page, /commonCards=/)
  assert.match(page, /viewFilter=\{viewFilter\}/)
  assert.match(page, /layerFilter=\{viewFilter\}/)
  assert.match(page, /extraItems=\{createItems\}/)
  // 模板入口按插入点层级平铺，浮层只列该层模板（不再有一个「从模板新建」聚合项）。
  assert.match(page, /INSERTION_LAYERS\.map/)
  assert.match(page, /添加模板 · \$\{LAYER_LABELS/)
  assert.match(page, /tpl:\$\{layer\}/)
  assert.match(page, /picker\.openPicker\(id\.slice\(4\)\)/)
  assert.match(page, /layer=\{picker\.layer\}/)
  assert.match(page, /create:blank-tool/)
  assert.match(page, /create:tool-template/)
  assert.match(page, /create:variables/)
  assert.doesNotMatch(page, /从模板新建/)
})
