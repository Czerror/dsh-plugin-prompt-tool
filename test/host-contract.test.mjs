/**
 * DSH 宿主契约回归（当前基线见 package.json 的官方发布包声明）。
 *
 * 0.1.5 相对 0.1.3 的破坏性变化：conversation.details.tool slot 与
 * session.events 数组移除；PTC 事件由 tool/code-dispatch 改名为 tool/ptc-dispatch。
 * 本文件锁定插件只消费现存契约（shell.overlay 由 ui-layout 声明；官方右侧栏
 * 与 sidebar.footer.action 几何探针都已移除——悬浮入口改为可拖动、读自己的位置偏好），
 * 并锁定非 pre-step 五层的注入时序。
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

test('客户端只注册 0.1.5 官方 slot 面：settings.plugins.tab + shell.overlay 可拖动悬浮入口', () => {
  assert.ok(register.includes("ctx.slots.inject('settings.plugins.tab'"), 'settings tab 注册缺失')
  assert.match(register, /name: 'settings\.plugins\.tab', id: 'prompt-tool'/)
  // 悬浮入口：shell.overlay 触发器/抽屉；右侧栏与几何探针都已移除。
  assert.match(register, /ctx\.slots\.inject\('shell\.overlay'/)
  assert.doesNotMatch(register, /footer\.action/, '不再占用 sidebar footer 做几何探针')
  assert.doesNotMatch(register, /sidebarRightTabs|sidebar\.right\.pane\.tab|conversation\.details/)
  assert.doesNotMatch(entry, /'sidebarRightTabs'/, '客户端 inject 不应等待已移除的 tab registry')
  assert.match(entry, /'slots'/)
})

test('版本声明对齐 package.json 的官方开发基线，且 bundle 依赖边包含悬浮入口所需包', () => {
  // 基线只从 manifest 派生：官方版本升级时改 package.json 一处，不在这里重复写死。
  const baseline = manifest.devDependencies['@deepseek-ai/dsh-agent']
  assert.match(baseline, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, '主基线必须是精确 semver')
  for (const [name, range] of Object.entries(manifest.peerDependencies)) {
    if (!name.startsWith('@deepseek-ai/dsh-')) continue
    assert.equal(range, `^${baseline}`, `peerDependencies.${name} 应声明 ^${baseline}`)
  }
  for (const [name, range] of Object.entries(manifest.devDependencies)) {
    if (!name.startsWith('@deepseek-ai/dsh-')) continue
    assert.equal(range, baseline, `devDependencies.${name} 应精确锁定 ${baseline}`)
  }
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-layout'))
  assert.ok(!manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-sidebar-right'), '官方右侧栏已移除')
  assert.ok(!manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-sidebar'), '几何探针下线后不再消费宿主侧栏 slot')
  assert.ok(manifest.peerDependencies['@deepseek-ai/dsh-client-ui-layout'] !== undefined)
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-client-ui-sidebar'], undefined, 'ui-sidebar 已无消费方')
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
