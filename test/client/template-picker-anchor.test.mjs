import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

test('模板入口把按钮 ref 传给顶层浮层', () => {
  const main = read('src/client/app/workspace/pages/MainSessionPage.tsx')
  const menu = read('src/client/features/modules/EngineModuleList.tsx')
  const scoped = read('src/client/app/workspace/pages/ConfigListWithTemplates.tsx')
  assert.match(main, /anchorRef=\{picker\.anchorRef\}/)
  assert.match(menu, /ref=\{anchorRef\}/)
  assert.match(scoped, /ref=\{templatePicker\.anchorRef\}/)
  assert.match(scoped, /anchorRef=\{templatePicker\.anchorRef\}/)
})

test('锚定浮层层级高于工作台抽屉', () => {
  const css = read('src/client/ui/controls.module.css')
  const block = css.match(/\.templatePopover\s*\{([^}]*)\}/s)?.[1] ?? ''
  assert.match(block, /position:\s*fixed/)
  assert.match(block, /z-index:\s*1200/)
})
