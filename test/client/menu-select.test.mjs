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

test('主会话使用单一模块列表，插入点筛选与能力卡共用入口', () => {
  const editor = read('features/prompts/PromptConfigsEditor.tsx')
  const page = read('app/workspace/pages/MainSessionPage.tsx')
  const list = read('features/prompts/PromptConfigList.tsx')
  assert.doesNotMatch(editor, /viewMode|通用设置|引擎能力设置/)
  assert.doesNotMatch(page, /viewMode|onViewModeChange/)
  assert.match(editor, /layerCards\?: \(layer: string\) => ReactNode/)
  assert.match(list, /layers\.map\(renderLayer\)/)
  assert.match(list, /layers\.map\(\(item\) =>/)
  assert.match(list, /保存提示词配置/)
  assert.match(list, /能力模块不受此搜索影响/)
  assert.match(page, /commonCards=/)
  assert.match(page, /layerFilter=\{layer\}/)
  assert.match(page, /viewFilter=\{layerFilter\}/)
})
