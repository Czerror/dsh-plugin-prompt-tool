/**
 * 发布入口的精确导出面：插件协议四符号 + 三个构建期符号。
 *
 * 破例说明（用户 2026-10-22 拍板）：入口契约不是四条 seam 之一，但 b643597d 已证明
 * 普通 test 对发布面零覆盖会让「缺 Config」一路漏到打包门。本文件只读 lib/ 产物；
 * run-tests 会先构建，单独运行需先 pnpm build。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const plugin = await import('../../lib/index.mjs')

test('发布入口只暴露协议四符号与三个构建期符号', () => {
  assert.deepEqual(Object.keys(plugin).sort(), [
    'Config', 'apply', 'inject', 'loadPromptTemplates', 'name', 'userModulesDir', 'writeModule',
  ])
  assert.equal(plugin.name, 'prompt-tool')
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(typeof plugin.Config, 'function')
  assert.ok(Array.isArray(plugin.inject))
  for (const symbol of ['loadPromptTemplates', 'writeModule', 'userModulesDir']) {
    assert.equal(typeof plugin[symbol], 'function', '发布入口缺少 ' + symbol)
  }
})