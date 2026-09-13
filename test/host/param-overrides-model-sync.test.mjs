/**
 * `/param-overrides` 回传默认模型同步结果（M-03/M-04 宿主侧）。
 *
 * 「预设已保存」与「宿主默认模型已同步」是两件事：同步失败/不可用时响应仍是
 * ok:true（预设确实落盘），但要带上 modelSync 让客户端分别表达；rebuild:false
 * 的落盘没有同步事实，不得伪造状态。
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'

const home = mkdtempSync(join(tmpdir(), 'pt-overrides-sync-home-'))
process.env.DSH_HOME = home
const { BRIDGE_ENDPOINTS, registerSettingsBridge } = await import('../../lib/index.mjs')
after(() => rmSync(home, { recursive: true, force: true }))

const PREFIX = '/api/prompt-tool/settings'
const presetRoot = join(home, '.agent-presets')

function makeHarness() {
  const handlers = new Map()
  const sctx = {
    settings: { describe: () => [], get: () => undefined, mutate: async () => {} },
    webServer: { register: ({ path, handler }) => { handlers.set(path, handler) } },
    effect: (fn) => fn(),
  }
  const ctx = { inject: (_deps, cb) => cb(sctx) }
  return { ctx, handlers }
}

function fakeReq(payload) {
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8')
  return {
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: 'localhost' },
    [Symbol.asyncIterator]() {
      let sent = false
      return {
        next: async () => {
          if (sent) return { done: true, value: undefined }
          sent = true
          return { done: false, value: bytes }
        },
      }
    },
  }
}

function fakeRes() {
  let status = 0
  let body = ''
  return {
    writeHead(code) { status = code },
    end(payload) { body = payload },
    get status() { return status },
    get body() { return body },
  }
}

test('/param-overrides 回传 modelSync 四态；rebuild:false 不带同步事实', async () => {
  mkdirSync(presetRoot, { recursive: true })
  const dir = mkdtempSync(join(presetRoot, 'pt-overrides-sync-'))
  writeFileSync(join(dir, 'preset.yml'), 'id: beta\n', 'utf8')
  const { ctx, handlers } = makeHarness()
  let next = { status: 'synced' }
  try {
    registerSettingsBridge(
      ctx,
      'prompt-tool',
      () => ({ available: true, providers: ['deepseek-official'] }),
      () => ({ activeSkillsDirs: [], skillCatalog: [] }),
      () => '',
      undefined,
      () => dir,
      undefined,
      () => next,
    )
    const write = handlers.get(`${PREFIX}${BRIDGE_ENDPOINTS.paramOverrides}`)
    assert.ok(write, '/param-overrides 端点应注册')

    for (const result of [
      { status: 'synced', message: '宿主默认模型已同步为 deepseek-official/x' },
      { status: 'unchanged', message: '宿主默认模型已是目标值' },
      { status: 'unavailable', message: '宿主未装配 agent-default-model 服务，已跳过默认模型同步' },
      { status: 'failed', message: '宿主默认模型写入失败' },
    ]) {
      next = result
      const res = fakeRes()
      await write(fakeReq({ overrides: { maxDepth: '' } }), res)
      assert.equal(res.status, 200)
      const payload = JSON.parse(res.body)
      assert.equal(payload.ok, true, '宿主同步失败不影响「预设已保存」的成功包装')
      assert.deepEqual(payload.value.modelSync, result)
    }

    const noRebuild = fakeRes()
    await write(fakeReq({ overrides: { maxDepth: '' }, rebuild: false }), noRebuild)
    assert.equal(noRebuild.status, 200)
    assert.equal(JSON.parse(noRebuild.body).value.modelSync, undefined, '没有同步事实不得伪造状态')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
