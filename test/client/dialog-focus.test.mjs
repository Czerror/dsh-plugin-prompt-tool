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

test('模块与工具模板选择器使用 body 顶层锚定浮层', () => {
  const picker = readFileSync(new URL('../../src/client/ui/TemplatePicker.tsx', import.meta.url), 'utf8')
  assert.match(picker, /useAnchoredPopoverStyle/)
  assert.match(picker, /useDismissOnOutsidePointer/)
  assert.match(picker, /className=\{styles\.templatePopover\}/)
  assert.match(picker, /createPortal\(surface, document\.body\)/)
  assert.doesNotMatch(picker, /modalBackdrop|DialogSurface/)
})

test('新建预设使用可锚定的 body-portaled DialogSurface', () => {
  const preset = readFileSync(new URL('../../src/client/features/presets/PresetSwitcher.tsx', import.meta.url), 'utf8')
  const surface = readFileSync(new URL('../../src/client/ui/DialogSurface.tsx', import.meta.url), 'utf8')
  const geometry = readFileSync(new URL('../../src/client/ui/anchored-popover.ts', import.meta.url), 'utf8')
  assert.match(preset, /ref=\{pickerAnchorRef\}/)
  assert.match(preset, /anchorRef=\{pickerAnchorRef\}/)
  assert.match(surface, /useAnchoredPopoverStyle/)
  assert.match(surface, /useDismissOnOutsidePointer/)
  assert.match(surface, /createPortal\(surface, document\.body\)/)
  assert.match(geometry, /useAnchoredPosition/)
  assert.ok(geometry.includes("{ visibility: 'hidden', maxHeight: fit.maxHeight }"))
})
