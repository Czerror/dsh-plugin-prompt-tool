import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveAnchoredPopoverFit } from '../../src/client/ui/anchored-popover-fit.ts'

test('锚定浮层：下方空间较大时限制高度并保持贴在按钮下方', () => {
  assert.deepEqual(resolveAnchoredPopoverFit({
    anchorTop: 378,
    anchorBottom: 414,
    desiredHeight: 512,
    viewportHeight: 900,
    gap: 8,
    margin: 12,
  }), { side: 'bottom', maxHeight: 466 })
})

test('锚定浮层：按钮靠近底部时改为向上展开', () => {
  assert.deepEqual(resolveAnchoredPopoverFit({
    anchorTop: 800,
    anchorBottom: 836,
    desiredHeight: 512,
    viewportHeight: 900,
    gap: 8,
    margin: 12,
  }), { side: 'top', maxHeight: 512 })
})

test('锚定浮层：上下空间都不足时选择空间更大的一侧', () => {
  assert.deepEqual(resolveAnchoredPopoverFit({
    anchorTop: 440,
    anchorBottom: 476,
    desiredHeight: 512,
    viewportHeight: 900,
    gap: 8,
    margin: 12,
  }), { side: 'top', maxHeight: 420 })
})
