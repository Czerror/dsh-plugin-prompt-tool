import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { isolatedHome, fakeReq, fakeRes, readBridge } from '../fixtures/host-harness.mjs'

const { presetRoot } = isolatedHome('pt-activation-bridge-')
const { registerSettingsBridge } = await import('../../src/runtime/settings-bridge.ts')
const dir = join(presetRoot, 'editable')
mkdirSync(dir, { recursive: true })
const file = join(dir, 'module.yml')
writeFileSync(file, 'id: editable\nmodules: []\n')

test('预设保存等待宿主采用；异步拒绝保留定义并可重试；只保存不触发注册', async () => {
  const handlers = new Map()
  const disposers = []
  let rebuild = async () => {}
  let calls = 0
  const sctx = {
    settings: { describe: () => [] },
    webServer: { register: ({ path, handler }) => { handlers.set(path, handler); return () => {} } },
    get: name => name === 'agentPresets' ? { list: async () => [{ id: 'editable', broken: 'MISSING_SERVICE' }] } : undefined,
    effect: fn => { const dispose = fn(); if (dispose) disposers.push(dispose) },
  }
  registerSettingsBridge({ inject: (_deps, cb) => cb(sctx) }, 'prompt-tool', () => ({}), () => ({}), () => '', undefined,
    () => dir, undefined, async () => { calls++; await rebuild() })
  const handler = handlers.get('/api/prompt-tool/settings/param-overrides')
  const save = async (overrides, extra = {}) => {
    const res = fakeRes()
    await handler(fakeReq({ body: { expectedPresetId: 'editable', overrides, ...extra } }), res)
    return readBridge(res)
  }
  try {
    const metaRes = fakeRes()
    await handlers.get('/api/prompt-tool/settings/meta')(fakeReq(), metaRes)
    assert.equal(readBridge(metaRes).value.meta.presets.find(preset => preset.id === 'editable').broken, 'MISSING_SERVICE')
    let entered
    const started = new Promise(resolve => { entered = resolve })
    let release
    const pending = new Promise(resolve => { release = resolve })
    rebuild = async () => { entered(); await pending }
    let settled = false
    const saving = save({ injectPrompt: false }).then(value => { settled = true; return value })
    await started
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(settled, false, '注册尚未完成不能发送成功响应')
    release()
    assert.equal((await saving).ok, true)

    rebuild = async () => { await Promise.resolve(); throw new Error('REGISTRATION_FAILED') }
    const failed = await save({ injectPrompt: true })
    assert.equal(failed.status, 500)
    assert.equal(failed.ok, false)
    assert.equal(failed.code, 'preset-activation-failed')
    assert.match(failed.message, /已保存.*REGISTRATION_FAILED/)
    assert.equal(parse(readFileSync(file, 'utf8')).layerSettings['pre-step'].injectPrompt, true)

    rebuild = async () => {}
    assert.equal((await save({ injectPrompt: true })).ok, true)
    const before = calls
    assert.equal((await save({ injectPrompt: false }, { rebuild: false })).ok, true)
    assert.equal(calls, before)
  } finally { for (const dispose of disposers) dispose() }
})
