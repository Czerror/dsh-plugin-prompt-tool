import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorkbenchHost } from '../../src/client/app/workbench/workbench-host.ts'

function listenerList() {
  const listeners = []
  return {
    listeners,
    addEventListener: (type, fn) => { listeners.push({ type, fn }) },
    removeEventListener: (type, fn) => {
      const index = listeners.findIndex(entry => entry.type === type && entry.fn === fn)
      if (index >= 0) listeners.splice(index, 1)
    },
  }
}

test('workbench-host：侧栏行点击在冒泡阶段截获并打开抽屉', () => {
  const host = createWorkbenchHost()
  const row = listenerList()
  const icon = { closest: selector => selector === 'button' ? row : null }
  let opened = 0
  let stopped = false
  const dispose = host.interceptSidebarRow(icon, () => { opened += 1 })
  assert.equal(row.listeners.length, 1)
  assert.equal(row.listeners[0].type, 'click')
  row.listeners[0].fn({ stopPropagation: () => { stopped = true } })
  assert.equal(opened, 1)
  assert.equal(stopped, true)
  dispose()
  assert.equal(row.listeners.length, 0)
})

test('workbench-host：找不到宿主行时返回空 disposer', () => {
  const host = createWorkbenchHost()
  assert.equal(typeof host.interceptSidebarRow({ closest: () => null }, () => {}), 'function')
})

test('workbench-host：其他面板激活时关闭自己，打开时派发自己的事件', () => {
  const host = createWorkbenchHost()
  const doc = {
    ...listenerList(),
    dispatched: [],
    dispatchEvent(event) { this.dispatched.push(event.detail); return true },
  }
  let closed = 0
  const dispose = host.installPanelExclusion({ close: () => { closed += 1 } }, doc)
  assert.deepEqual(doc.dispatched, ['prompt-tool'])
  assert.equal(doc.listeners.length, 1)
  assert.equal(doc.listeners[0].type, 'dsh-panel-activate')
  doc.listeners[0].fn({ detail: 'taskboard' })
  doc.listeners[0].fn({ detail: 'ssh' })
  doc.listeners[0].fn({ detail: 'prompt-tool' })
  assert.equal(closed, 2)
  dispose()
  assert.equal(doc.listeners.length, 0)
})
