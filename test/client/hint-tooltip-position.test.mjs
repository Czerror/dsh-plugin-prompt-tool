import test from 'node:test'
import assert from 'node:assert/strict'
import { fitHintTooltipPosition } from '../../src/client/ui/hint-tooltip-position.ts'

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
