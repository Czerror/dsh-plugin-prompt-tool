//（2026-09-17 测试归一精简 Wave 3 C2a 组）：前三条几何用例改参数化表（每行仍是一条独立 test，
//  固定参数只写一次），异步内容与真实测量两条保留独立 test；断言逐条未改，运行用例数仍 5。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { measurePanelContentHeight, resolveAnchoredPopoverFit } from '../../src/client/ui/anchored-popover-fit.ts'

/** 前三条用例共用的固定输入（锚点高度由表提供）。 */
const fixed = { desiredHeight: 512, viewportHeight: 900, gap: 8, margin: 12 }

for (const [name, anchorTop, anchorBottom, expected] of [
  ['锚定浮层：下方空间较大时限制高度并保持在按钮下方', 378, 414, { side: 'bottom', maxHeight: 466 }],
  ['锚定浮层：按钮靠近底部时改为向上展开', 800, 836, { side: 'top', maxHeight: 780 }],
  ['锚定浮层：上下空间都不足时选择空间更大的一侧', 440, 476, { side: 'top', maxHeight: 420 }],
]) {
  test(name, () => {
    assert.deepEqual(resolveAnchoredPopoverFit({ anchorTop, anchorBottom, ...fixed }), expected)
  })
}

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
