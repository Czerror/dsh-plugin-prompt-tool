// 前端审查修复回归（2026-09-14）：
// - 预设切换的事务性：草稿保存失败不切换；切换中拒绝把旧预设字段写进新预设；
// - 模板变量开关在保存同帧传出新值；
// - 子代理策略读取失败进入错误态（不降级成“无策略”）、抽屉 aria-modal 的 Tab 循环；
// - 角色卡选择器与 PNG 解析范围一致。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { setImmediate } from 'node:timers/promises'
import { usePromptToolStore } from '../../src/client/data/use-prompt-tool-store.ts'

const require = createRequire(new URL('../../package.json', import.meta.url))
const React = require('react')
const { renderToString } = require('react-dom/server')
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

const waitFor = async (predicate) => {
  for (let index = 0; index < 200; index += 1) {
    if (predicate()) return
    await setImmediate()
  }
  throw new Error('waitFor timeout')
}

const okResponse = (payload) => new Response(JSON.stringify(payload))
const bootstrapPayload = (presetTemplate, promptConfigs = []) => ({
  ok: true,
  value: { value: { presetTemplate }, base: {}, revision: 1 },
  promptConfigs: { promptConfigs },
})

/** settings 传输面最小替身：镜像 ready、mutate 直接成功。 */
const makeSettings = () => ({
  scope: { getSnapshot: () => ({ status: 'ready', revision: 1 }) },
  ensure: async () => {},
  mutate: async () => {},
})

/** 用 SSR 渲染一次拿到真实 hook 闭包（不执行 effects，不发初始请求）。 */
const mountStore = (api, settings) => {
  let store
  function Probe() {
    store = usePromptToolStore(api, settings)
    return null
  }
  renderToString(React.createElement(Probe))
  return store
}

const makeApi = (onSwitch) => ({
  sessionModel: { snapshot: () => ({}) },
  currentSessionId: () => undefined,
  switchPreset: async (id) => {
    onSwitch?.(id)
    return { applied: true }
  },
})

test('预设切换：当前草稿保存失败时不切换、不丢草稿', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  let switchCalls = 0
  globalThis.fetch = async (url, init) => {
    const endpoint = url.split('/').at(-1)
    const body = JSON.parse(init.body ?? '{}')
    requests.push({ endpoint, body })
    if (endpoint === 'bootstrap') return okResponse(bootstrapPayload('A'))
    if (endpoint === 'param-overrides') return okResponse({ ok: false, message: 'simulated disk failure' })
    return okResponse({ ok: true, value: {} })
  }
  try {
    const store = mountStore(makeApi(() => { switchCalls += 1 }), makeSettings())
    await store.load()
    store.patch({ promptConfigs: [{ id: 'draft', text: 'unsaved' }] })
    await store.setPresetTemplate('B')
    assert.equal(switchCalls, 0, '保存失败后不得调用宿主切换')
    assert.equal(store.getFields().presetTemplate, 'A', '失败后仍停在原预设')
    assert.equal(store.getFields().promptConfigs[0].text, 'unsaved', '草稿必须保留')
    assert.equal(requests.some(({ endpoint, body }) => endpoint === 'param-overrides' && body.expectedPresetId === 'B'), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('预设切换：目标数据未应用前拒绝写盘，应用后恢复', async () => {
  const originalFetch = globalThis.fetch
  const writes = []
  let releaseBoot
  const bootGate = new Promise((resolve) => { releaseBoot = resolve })
  let bootCount = 0
  let activePreset = 'A'
  globalThis.fetch = async (url, init) => {
    const endpoint = url.split('/').at(-1)
    if (endpoint === 'bootstrap') {
      bootCount += 1
      if (bootCount > 1) await bootGate
      return okResponse(bootstrapPayload(
        activePreset,
        activePreset === 'B' ? [{ id: 'live-b', text: 'from-server' }] : [{ id: 'live-a', text: 'from-server' }],
      ))
    }
    writes.push({ endpoint, body: JSON.parse(init.body ?? '{}') })
    return okResponse({ ok: true, value: {} })
  }
  try {
    const store = mountStore(makeApi((id) => { activePreset = id }), makeSettings())
    await store.load()
    store.patch({ promptConfigs: [{ id: 'draft-a', text: 'edited-a' }] })
    const switching = store.setPresetTemplate('B')
    await waitFor(() => bootCount === 2)
    assert.equal(store.getFields().presetTemplate, 'B', '已进入切换窗口')
    assert.equal(store.getFields().promptConfigs[0].id, 'draft-a', '窗口期 fields 仍是旧预设数据')

    // 窗口期编辑并保存：守卫必须拒绝（旧数据不得带新 presetTemplate 落盘）。
    store.patch({ promptConfigs: [{ id: 'stale', text: 'stale' }] })
    await store.persistConfigs([{ id: 'stale', text: 'stale' }])
    assert.equal(writes.some(({ endpoint, body }) => endpoint === 'param-overrides' && body.expectedPresetId === 'B'),
      false, '切换窗口内不得写入目标预设')

    releaseBoot()
    await switching
    // 窗口内编辑 bump 了草稿版本：B 快照被丢弃，守卫保持拒绝（避免把窗口草稿写进新预设）。
    const writesBefore = writes.filter(({ endpoint }) => endpoint === 'param-overrides').length
    await store.persistConfigs([{ id: 'stale', text: 'stale' }])
    assert.equal(writes.filter(({ endpoint }) => endpoint === 'param-overrides').length, writesBefore,
      '重新加载成功前持续拒绝写盘')

    // 显式重新加载应用 B 快照后恢复写入。
    await store.load()
    assert.equal(store.getFields().promptConfigs[0].id, 'live-b', 'B 的服务端配置已应用')
    await store.persistConfigs([{ id: 'for-b', text: 'ok' }])
    const lastWrite = writes.filter(({ endpoint }) => endpoint === 'param-overrides').at(-1)
    assert.equal(lastWrite.body.expectedPresetId, 'B')
    assert.equal(lastWrite.body.promptConfigs[0].id, 'for-b')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('模板变量开关：保存载荷使用同帧传入的新 enabled 值', async () => {
  const originalFetch = globalThis.fetch
  const writes = []
  globalThis.fetch = async (url, init) => {
    const endpoint = url.split('/').at(-1)
    if (endpoint === 'bootstrap') return okResponse(bootstrapPayload('A'))
    writes.push({ endpoint, body: JSON.parse(init.body ?? '{}') })
    return okResponse({ ok: true, value: {} })
  }
  try {
    const store = mountStore(makeApi(), makeSettings())
    await store.load()
    await store.saveTemplateVariables({ sample: 'x' }, false)
    const last = writes.filter(({ endpoint }) => endpoint === 'preset-variables').at(-1)
    assert.equal(last.body.enabled, false, '开关新值必须进入同一次保存')
    assert.deepEqual(last.body.variables, { sample: 'x' })
    assert.equal(last.body.expectedPresetId, 'A')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('契约：子代理策略读取失败进入错误态且不降级为空策略', () => {
  const source = read('src/client/features/subagents/SubagentToolPolicyCard.tsx')
  assert.match(source, /setLoadError\(result\.message/, '失败分支必须写入错误态')
  assert.match(source, /loadError\.length > 0/, '错误态必须禁用保存并隐藏启用入口')
  assert.match(source, /\{t\('policy\.retry'\)\}/, '错误态必须提供重试入口')
})

test('契约：aria-modal 抽屉提供 Tab 焦点循环并复用 dialog-focus helper', () => {
  const overlay = read('src/client/app/workbench/WorkbenchOverlay.tsx')
  assert.match(overlay, /onKeyDown=\{onDrawerKeyDown\}/)
  assert.match(overlay, /nextDialogFocusIndex/, '循环索引必须复用共享 helper')
  assert.match(overlay, /drawerRef\.current\.contains\(active\)/, '只在焦点位于抽屉内时接管')
  assert.match(read('src/client/ui/dialog-focus.ts'), /export const FOCUSABLE = /)
})

test('契约：角色卡图片选择器与 PNG 解析范围一致', () => {
  const source = read('src/client/features/characters/CharactersPage.tsx')
  assert.match(source, /accept="\.png,image\/png"/)
  assert.doesNotMatch(source, /image\/jpeg/, 'JPG/JPEG 会被 importCard 判为不支持，选择器不得声明')
})
