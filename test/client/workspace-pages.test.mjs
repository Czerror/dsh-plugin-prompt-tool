/**
 * 工作台页面表：UI slot / 入口注册 seam。
 *
 * 真值源是产品规格里写死的四页与顺序（主会话、子代理、工具预览、模块）；
 * 页面 id 是不参与翻译的稳定契约，tab/panel 的 DOM id 依赖它。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WORKSPACE_PAGES, WORKSPACE_PAGE_IDS, workspacePageMeta } from '../../src/client/app/workspace/workspace-pages.ts'

test('工作台恰好四页，顺序与文案键固定', () => {
  assert.deepEqual(WORKSPACE_PAGE_IDS, ['features', 'subagent', 'tools', 'modules'])
  assert.deepEqual(WORKSPACE_PAGES.map((page) => page.labelKey), [
    'page.features.label', 'page.subagent.label', 'page.tools.label', 'page.modules.label',
  ])
  assert.equal(workspacePageMeta('tools').labelKey, 'page.tools.label')
})
