import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderElement, withSsr } from './support/ssr-render.mjs'

const entryUrl = new URL('../../src/client/app/workbench/register-workbench.tsx', import.meta.url).href
const iconUrl = new URL('../../src/client/app/workbench/WorkbenchSidebarEntry.tsx', import.meta.url).href
const { registerWorkbenchSlots, WORKBENCH_ENTRY_ID } = await withSsr([entryUrl])
const { WorkbenchSidebarEntry } = await withSsr([iconUrl])

/** 只记宿主槽位接口：注册选项与释放，不加载真实宿主。 */
function fakeSlots() {
  const registrations = []
  const unregisters = []
  const ctx = {
    inject: (_services, callback) => {
      const dispose = callback({ ...ctx, sidebarRightTabs: { register: () => () => { unregisters.push('tab-type') } } })
      return { dispose }
    },
    slots: {
      inject: (_name, callback) => callback(),
      register: (options, component) => {
        registrations.push({ options, component })
        return () => { unregisters.push(options.name) }
      },
    },
  }
  return { ctx, registrations, unregisters }
}

test('原生入口：三面注册、会话绑定、右侧真实可见性与释放', () => {
  const fake = fakeSlots()
  const renders = []
  const face = { t: key => `t:${key}`, renderWorkspace: props => { renders.push(props); return null } }
  const dispose = registerWorkbenchSlots(fake.ctx, face)

  const names = fake.registrations.map(entry => entry.options.name).sort()
  assert.deepEqual(names, ['conversation.view', 'main', 'sidebar.panellist', 'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title'])
  const icon = fake.registrations.find(entry => entry.options.name === 'sidebar.panellist')
  assert.equal(icon.options.id, WORKBENCH_ENTRY_ID)
  assert.equal(icon.options.locale, 'prompt-tool')
  assert.equal(icon.options.label(), 't:app.title')
  const main = fake.registrations.find(entry => entry.options.name === 'main')
  assert.equal(main.options.key, icon.options.id)
  main.component({})
  fake.registrations.find(entry => entry.options.name === 'conversation.view').component({ sessionId: 'session-a' })
  const right = fake.registrations.find(entry => entry.options.name === 'sidebar.right.pane.tab')
  right.component({ sessionId: 'session-b', useTabInfo: () => ({ tab: { visible: false } }) })
  right.component({ sessionId: 'session-b', useTabInfo: () => ({ tab: { visible: true } }) })
  assert.deepEqual(renders, [
    { placement: 'main', visible: true },
    { sessionId: 'session-a', placement: 'conversation', visible: true },
    { sessionId: 'session-b', placement: 'sidebar', visible: false },
    { sessionId: 'session-b', placement: 'sidebar', visible: true },
  ])

  dispose()
  assert.deepEqual([...fake.unregisters].sort(), [...names, 'tab-type'].sort())
})

test('侧栏入口图标：只画尺寸内的装饰图形，标签与可访问名归侧栏', () => {
  const html = renderElement(WorkbenchSidebarEntry, { size: 16, active: false, open: () => {} })
  assert.match(html, /width="16"/)
  assert.match(html, /height="16"/)
  assert.match(html, /aria-hidden="true"/)
  assert.match(html, /data-dsh-part="sidebar-icon"/)
})
