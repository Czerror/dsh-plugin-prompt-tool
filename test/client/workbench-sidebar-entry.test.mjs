import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderElement, withSsr } from './support/ssr-render.mjs'

const entryUrl = new URL('../../src/client/app/workbench/register-workbench.tsx', import.meta.url).href
const iconUrl = new URL('../../src/client/app/workbench/WorkbenchSidebarIcon.tsx', import.meta.url).href
const { registerWorkbenchSlots, WORKBENCH_PANEL_ID } = await withSsr([entryUrl])
const { WorkbenchSidebarIcon } = await withSsr([iconUrl])

/** 只记注入面：槽名、注册选项与释放顺序，不加载真实宿主。 */
function fakeSlots() {
  const registrations = []
  const injections = []
  const releases = []
  const unregisters = []
  const ctx = {
    layout: { selectPanel: panelId => releases.push(['selectPanel', panelId]) },
    slots: {
      inject: (name, callback) => {
        injections.push(name)
        const dispose = callback()
        return () => {
          releases.push(['inject', name])
          dispose?.()
        }
      },
      register: (options, component) => {
        registrations.push({ options, component })
        return () => { unregisters.push(options.name) }
      },
    },
  }
  return { ctx, registrations, injections, releases, unregisters }
}

test('侧栏入口：main 与 sidebar.panellist 成对注册，key/id 相同，释放一并撤销', () => {
  const fake = fakeSlots()
  const face = { controller: {}, api: { marker: 'api' }, settings: { marker: 'settings' }, t: key => `t:${key}` }
  const dispose = registerWorkbenchSlots(fake.ctx, face)

  assert.deepEqual(fake.injections, ['shell.overlay', 'main', 'sidebar.panellist'])
  assert.deepEqual(fake.registrations.map(entry => entry.options.name), ['shell.overlay', 'main', 'sidebar.panellist'])

  const main = fake.registrations.find(entry => entry.options.name === 'main')
  const icon = fake.registrations.find(entry => entry.options.name === 'sidebar.panellist')
  assert.equal(main.options.key, WORKBENCH_PANEL_ID)
  assert.equal(icon.options.id, WORKBENCH_PANEL_ID)
  assert.equal(icon.options.order, 60)
  assert.equal(icon.options.locale, 'prompt-tool')
  assert.equal(icon.options.label(), 't:app.title')

  // 主面板注入的是抽屉同一份 api/settings；关闭走官方 selectPanel(null) 回对话。
  const injected = main.options.inject()
  assert.equal(injected.api, face.api)
  assert.equal(injected.settings, face.settings)
  injected.closePanel()
  assert.deepEqual(fake.releases.at(-1), ['selectPanel', null])

  dispose()
  assert.deepEqual(fake.unregisters, ['shell.overlay', 'sidebar.panellist', 'main'])
})

test('侧栏图标：只画尺寸内的装饰图形，标签与可访问名归侧栏', () => {
  const html = renderElement(WorkbenchSidebarIcon, { size: 16, active: false })
  assert.match(html, /width="16"/)
  assert.match(html, /height="16"/)
  assert.match(html, /aria-hidden="true"/)
  assert.match(html, /data-dsh-part="sidebar-icon"/)
})
