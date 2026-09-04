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

test('通用/能力视图使用 ARIA tabs 且状态正交', () => {
  const editor = read('features/prompts/PromptConfigsEditor.tsx')
  const page = read('app/workspace/pages/MainSessionPage.tsx')
  assert.match(editor, /viewMode\?: 'general' \| 'capability'/)
  assert.match(editor, /role="tablist"/)
  assert.match(editor, /role="tabpanel"/)
  assert.match(page, /useState<'general' \| 'capability'>\('general'\)/)
  assert.match(page, /viewFilter=\{layerFilter\}/)
})
