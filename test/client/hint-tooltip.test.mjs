// 合并自 hint-tooltip-focus.test.mjs(3) + hint-tooltip-position.test.mjs(2)
//（2026-09-17 测试归一精简 Wave 3 C2a 组）：两者同属「说明浮窗」主题（锁定判定 + 定位），
//  合并后保留全部 5 条运行用例，断言逐条未改。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isKeyboardFocus, shouldLockFocus } from '../../src/client/ui/hint-tooltip-focus.ts'
import { fitHintTooltipPosition } from '../../src/client/ui/hint-tooltip-position.ts'

// —— 锁定判定（原 hint-tooltip-focus.test.mjs） ——

test('说明浮窗只在键盘聚焦时锁定，鼠标点击聚焦不触发', () => {
  assert.equal(isKeyboardFocus({ matches: () => false }), false)
  assert.equal(isKeyboardFocus({ matches: () => true }), true)
})

test('不支持 :focus-visible 查询时保守按键盘聚焦处理', () => {
  assert.equal(isKeyboardFocus({}), true)
  assert.equal(isKeyboardFocus({ matches: () => { throw new Error('unsupported selector') } }), true)
})

test('刚按下指针的 focus 不锁定，键盘聚焦才锁定', () => {
  const keyboardFocus = { matches: () => true }
  const pointerFocus = { matches: () => false }
  // 鼠标点击普通按钮：focus-visible 不匹配。
  assert.equal(shouldLockFocus({ element: pointerFocus, pointerDownAt: 1000, now: 1010 }), false)
  // 鼠标点击 checkbox 等控件：focus-visible 匹配，但仍在指针窗口内。
  assert.equal(shouldLockFocus({ element: keyboardFocus, pointerDownAt: 1000, now: 1010 }), false)
  // 键盘 Tab 聚焦：没有近期指针按下。
  assert.equal(shouldLockFocus({ element: keyboardFocus, pointerDownAt: 0, now: 10_000 }), true)
  // 指针窗口过期后仍按 :focus-visible 判断。
  assert.equal(shouldLockFocus({ element: pointerFocus, pointerDownAt: 1000, now: 2000 }), false)
})

// —— 定位（原 hint-tooltip-position.test.mjs） ——

test('说明浮窗跟随指针，并在右下边缘翻转', () => {
  assert.deepEqual(
    fitHintTooltipPosition(
      { kind: 'pointer', x: 790, y: 590 },
      { width: 180, height: 80 },
      { width: 800, height: 600 },
    ),
    { left: 598, top: 498 },
  )
})

test('键盘聚焦说明紧邻控件，右侧不足时翻到左侧', () => {
  assert.deepEqual(
    fitHintTooltipPosition(
      { kind: 'focus', left: 700, right: 780, centerY: 240 },
      { width: 200, height: 60 },
      { width: 800, height: 600 },
    ),
    { left: 490, top: 210 },
  )
})
