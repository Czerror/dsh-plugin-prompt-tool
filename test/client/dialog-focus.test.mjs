import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { nextDialogFocusIndex } from '../../src/client/ui/dialog-focus.ts'

test('dialog focus：只在越过边界或焦点位于弹窗外时循环', () => {
  assert.equal(nextDialogFocusIndex(0, -1, false), undefined)
  assert.equal(nextDialogFocusIndex(3, -1, false), 0)
  assert.equal(nextDialogFocusIndex(3, -1, true), 2)
  assert.equal(nextDialogFocusIndex(3, 0, true), 2)
  assert.equal(nextDialogFocusIndex(3, 2, false), 0)
  assert.equal(nextDialogFocusIndex(3, 1, false), undefined)
})

test('两个 picker 共用焦点模块，不再各自扫描 focusables', () => {
  for (const path of ['../../src/client/features/prompts/TemplatePicker.tsx', '../../src/client/PresetSwitcher.tsx']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8')
    assert.match(source, /useDialogFocus/)
    assert.doesNotMatch(source, /querySelectorAll<HTMLElement>/)
  }
})
