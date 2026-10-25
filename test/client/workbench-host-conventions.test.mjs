import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorkbenchHostConventions, workbenchHostConventions } from '../../src/client/app/workbench/workbench-host-conventions.ts'

test('workbench-host-conventions：侧栏行点击打开抽屉，dispose 后失效', () => {
  const host = createWorkbenchHostConventions()
  let click
  const row = {
    addEventListener: (_type, listener) => { click = listener },
    removeEventListener: () => { click = undefined },
  }
  const icon = { closest: () => row }
  let opened = 0
  const dispose = host.interceptSidebarRow(icon, () => { opened += 1 })
  click({ stopPropagation: () => {} })
  assert.equal(opened, 1)
  dispose()
  assert.equal(click, undefined)
})

test('workbench-host-conventions：找不到宿主行时返回空 disposer', () => {
  const host = createWorkbenchHostConventions()
  assert.equal(typeof host.interceptSidebarRow({ closest: () => null }, () => {}), 'function')
})

test('workbench-host-conventions：其他面板激活时关闭自己，打开时派发自己的事件', () => {
  const target = new EventTarget()
  const host = createWorkbenchHostConventions(target)
  const seen = []
  target.addEventListener('dsh-panel-activate', (event) => { seen.push(event.detail) })
  let closed = 0
  const dispose = host.installPanelExclusion({ close: () => { closed += 1 } })
  assert.deepEqual(seen, ['prompt-tool'])
  target.dispatchEvent(new CustomEvent('dsh-panel-activate', { detail: 'taskboard' }))
  target.dispatchEvent(new CustomEvent('dsh-panel-activate', { detail: 'ssh' }))
  target.dispatchEvent(new CustomEvent('dsh-panel-activate', { detail: 'prompt-tool' }))
  assert.equal(closed, 2)
  dispose()
  target.dispatchEvent(new CustomEvent('dsh-panel-activate', { detail: 'taskboard' }))
  assert.equal(closed, 2)
})

test('workbench-host-conventions：生产单例提供两个方法', () => {
  assert.equal(typeof workbenchHostConventions.interceptSidebarRow, 'function')
  assert.equal(typeof workbenchHostConventions.installPanelExclusion, 'function')
})
