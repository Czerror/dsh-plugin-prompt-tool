/**
 * DSH 0.1.5-alpha.1 宿主契约回归。
 *
 * 0.1.5 相对 0.1.3 的破坏性变化：shell.overlay 自建工作台让位给官方
 * ui-sidebar-right；conversation.details.tool slot 与 session.events 数组移除；
 * PTC 事件由 tool/code-dispatch 改名为 tool/ptc-dispatch。本文件锁定插件只消费
 * 现存契约，并锁定非 pre-step 五层的注入时序。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const manifest = JSON.parse(read('package.json'))
const register = read('src/client/app/workbench/register-workbench.tsx')
const entry = read('src/client/index.ts')
const layers = read('engine/layers.mjs')

function sourceFiles(relative) {
  const files = []
  const walk = (url, prefix) => {
    for (const item of readdirSync(url, { withFileTypes: true })) {
      if (item.isDirectory()) walk(new URL(`${item.name}/`, url), `${prefix}${item.name}/`)
      else if (/\.(?:ts|tsx|mjs)$/.test(item.name)) files.push([`${prefix}${item.name}`, readFileSync(new URL(item.name, url), 'utf8')])
    }
  }
  walk(new URL(`../${relative}/`, import.meta.url), `${relative}/`)
  return files
}

test('客户端只注册 0.1.5 官方 slot 面：settings.plugins.tab + 右侧栏 keyed body', () => {
  assert.ok(register.includes("ctx.slots.inject('settings.plugins.tab'"), 'settings tab 注册缺失')
  assert.ok(register.includes("ctx.slots.inject('sidebar.right.pane.tab'"), '右侧栏 body 注册缺失')
  assert.match(register, /ctx\.sidebarRightTabs\.register\(\{/, '右侧栏 tab type 注册缺失')
  assert.match(register, /name: 'sidebar\.right\.pane\.tab', key: PROMPT_TOOL_TAB_ID/)
  assert.doesNotMatch(register, /shell\.overlay|sidebar\.footer\.action|conversation\.details/)
  assert.match(entry, /'sidebarRightTabs'/, '客户端 inject 应等待官方 tab registry')
})

test('版本声明对齐 0.1.5-alpha.1，且 bundle 依赖边包含右侧栏包', () => {
  for (const section of ['peerDependencies', 'devDependencies']) {
    for (const [name, range] of Object.entries(manifest[section])) {
      if (!name.startsWith('@deepseek-ai/dsh-')) continue
      assert.equal(range, '^0.1.5-alpha.1', `${section}.${name} 应声明 ^0.1.5-alpha.1`)
    }
  }
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-sidebar-right'))
  assert.ok(manifest.peerDependencies['@deepseek-ai/dsh-client-ui-sidebar-right'] !== undefined)
  assert.ok(manifest.peerDependencies['@deepseek-ai/dsh-client-ui-slots'] !== undefined)
})

test('引擎接线保持 0.1.5 注入时序：非 pre-step 五层按声明顺序接入', () => {
  const order = ['wireSystemSections', 'wireRuntimeContexts', 'wireAgentRequests', 'wireLlmStreams', 'wireToolPipelines']
    .map((name) => layers.indexOf(`  ${name}(ctx,`))
  assert.ok(order.every((index) => index > 0), '五层接线缺失')
  assert.deepEqual([...order].sort((a, b) => a - b), order, '五层接线顺序必须保持')
  assert.match(
    layers,
    /ctx\.on\('agent\/request', async \(payload, next\) => \{\s*const base = await next\(\)/,
    'agent/request 必须先结算下游（assembly 已就绪）再合并 patch',
  )
})

test('源码不引用 0.1.5 已删除或改名的宿主 API', () => {
  for (const [file, source] of [...sourceFiles('engine'), ...sourceFiles('src')]) {
    assert.doesNotMatch(source, /tool\/code-dispatch/, `${file} 仍引用已改名的 PTC 事件`)
    assert.doesNotMatch(source, /conversation\.details\.tool/, `${file} 仍引用已删除的详情 slot`)
    assert.doesNotMatch(source, /session\.events\b/, `${file} 仍读取已移除的 session.events 数组`)
  }
})
