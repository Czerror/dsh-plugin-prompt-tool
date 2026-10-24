import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderElement, withSsr } from './support/ssr-render.mjs'

const entryUrl = new URL('../../src/client/app/workbench/register-workbench.tsx', import.meta.url).href
const iconUrl = new URL('../../src/client/app/workbench/WorkbenchSidebarIcon.tsx', import.meta.url).href
const { registerWorkbenchSlots, WORKBENCH_PANEL_ID } = await withSsr([entryUrl])
const { WorkbenchSidebarIcon } = await withSsr([iconUrl])

/** 只记宿主槽位接口：注册选项与释放，不加载真实宿主。 */
function fakeSlots() {
  const registrations = []
  const unregisters = []
  const selections = []
  const ctx = {
    layout: { selectPanel: panelId => { selections.push(panelId) } },
    slots: {
      inject: (_name, callback) => callback(),
      register: (options, component) => {
        registrations.push({ options, component })
        return () => { unregisters.push(options.name) }
      },
    },
  }
  return { ctx, registrations, unregisters, selections }
}

test('侧栏入口：按官方 Global panel entries 成对注册 main 与 sidebar.panellist，关闭回对话', () => {
  const fake = fakeSlots()
  const face = { controller: {}, api: { marker: 'api' }, settings: { marker: 'settings' }, t: key => `t:${key}` }
  const dispose = registerWorkbenchSlots(fake.ctx, face)

  const names = fake.registrations.map(entry => entry.options.name).sort()
  assert.deepEqual(names, ['main', 'shell.overlay', 'sidebar.panellist'])

  const main = fake.registrations.find(entry => entry.options.name === 'main')
  const icon = fake.registrations.find(entry => entry.options.name === 'sidebar.panellist')
  // 官方契约：同 key 配对；main 缺入口或入口缺 main 都不可用。
  assert.equal(main.options.key, WORKBENCH_PANEL_ID)
  assert.equal(icon.options.id, WORKBENCH_PANEL_ID)
  assert.equal(icon.options.locale, 'prompt-tool')
  assert.equal(icon.options.label(), 't:app.title')
  assert.equal(typeof icon.options.inject().open, 'function')

  // 主面板是重定向：持有常驻抽屉 controller，关闭走官方 selectPanel(null) 回对话。
  const injected = main.options.inject()
  assert.equal(injected.controller, face.controller)
  injected.closePanel()
  assert.deepEqual(fake.selections, [null])

  dispose()
  assert.deepEqual([...fake.unregisters].sort(), ['main', 'shell.overlay', 'sidebar.panellist'])
})

test('侧栏图标：只画尺寸内的装饰图形，标签与可访问名归侧栏', () => {
  const html = renderElement(WorkbenchSidebarIcon, { size: 16, active: false, open: () => {} })
  assert.match(html, /width="16"/)
  assert.match(html, /height="16"/)
  assert.match(html, /aria-hidden="true"/)
  assert.match(html, /data-dsh-part="sidebar-icon"/)
})
