import test from 'node:test'
import assert from 'node:assert/strict'
import { measurePanelContentHeight, resolveAnchoredPopoverFit } from '../../src/client/ui/anchored-popover-fit.ts'

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
  }), { side: 'top', maxHeight: 780 })
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

test('锚定浮层：maxHeight 只取可用空间，内容异步变多后仍可展开', () => {
  const input = { anchorTop: 100, anchorBottom: 136, viewportHeight: 900, gap: 8, margin: 12 }
  const empty = resolveAnchoredPopoverFit({ ...input, desiredHeight: 80 })
  const loaded = resolveAnchoredPopoverFit({ ...input, desiredHeight: 640 })
  assert.deepEqual(empty, { side: 'bottom', maxHeight: 744 })
  assert.deepEqual(loaded, { side: 'bottom', maxHeight: 744 })
})

test('锚定浮层：测量真实内容高度时临时解除 max-height 并恢复', () => {
  const panel = {
    style: { maxHeight: '110px' },
    offsetHeight: 110,
    get scrollHeight() { return this.style.maxHeight === 'none' ? 350 : 110 },
  }
  assert.equal(measurePanelContentHeight(panel), 350)
  assert.equal(panel.style.maxHeight, '110px')
})
