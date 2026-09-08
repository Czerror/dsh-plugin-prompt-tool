import test from 'node:test'
import assert from 'node:assert/strict'
import { isKeyboardFocus, shouldLockFocus } from '../../src/client/ui/hint-tooltip-focus.ts'

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
