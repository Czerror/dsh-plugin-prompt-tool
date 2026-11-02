/**
 * 发布入口的精确导出面：插件协议四符号 + 三个构建期符号。
 *
 * UI slot / 入口注册 seam：b643597d 已证明
 * 普通 test 对发布面零覆盖会让「缺 Config」一路漏到打包门。本文件只读 lib/ 产物；
 * run-tests 会先构建，单独运行需先 pnpm build。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { inject } from '../../src/index.ts'

const plugin = await import('../../lib/index.mjs')

test('发布入口只暴露协议四符号与三个构建期符号', () => {
  assert.deepEqual(Object.keys(plugin).sort(), [
    'Config', 'apply', 'inject', 'loadPromptTemplates', 'name', 'userModulesDir', 'writeModule',
  ])
  assert.equal(plugin.name, 'prompt-tool')
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(typeof plugin.Config, 'function')
  assert.deepEqual([...plugin.inject].sort(), ['commands', 'llm', 'skills'], 'inject 仅等待三个实际必需服务')
  for (const symbol of ['loadPromptTemplates', 'writeModule', 'userModulesDir']) {
    assert.equal(typeof plugin[symbol], 'function', '发布入口缺少 ' + symbol)
  }
})

test('启动依赖：真实必需服务晚到时激活，未使用的服务不阻塞，释放执行一次', async t => {
  const root = new Context()
  t.after(() => root.fiber.dispose())
  root.provide('skills', {})
  root.provide('commands', {})
  let mounted = 0, disposed = 0
  const fiber = root.plugin({ inject, apply(ctx) {
    mounted += 1
    ctx.effect(() => () => { disposed += 1 })
  } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(mounted, 0, 'llm 尚未提供时继续等待')
  root.provide('llm', {})
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(mounted, 1, '三个真实依赖已就绪，不需要 subagents')
  await fiber.dispose()
  assert.equal(disposed, 1)
})
