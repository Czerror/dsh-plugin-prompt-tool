import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDocument } from 'yaml'
import { isolatedHome, fakeReq, fakeRes, readBridge } from '../fixtures/host-harness.mjs'

const { home, moduleRoot } = isolatedHome('pt-rules-bridge-')
const { registerSettingsBridge } = await import('../../src/runtime/settings-bridge.ts')
let sequence = 0
const textRule = (id, enabled = false) => ({ id, layer: 'pre-step', enabled, group: 'mode', exclusive: true, do: [{ id: 'text', kind: 'inject-text', config: { id, layer: 'pre-step', text: id } }] })

function harness({ readonly = false, afterRebuild } = {}) {
  const id = `rules-${++sequence}`
  const directory = join(readonly ? join(home, 'system') : moduleRoot, id)
  mkdirSync(directory, { recursive: true })
  const file = join(directory, 'module.yml')
  const original = `# 用户注释\nid: ${id}\nmodules: []\nrules: []\nunknown: keep # 未知字段\n`
  writeFileSync(file, original)
  const handlers = new Map(), releases = []
  let rebuilds = 0
  const scope = {
    settings: { describe: () => [] },
    webServer: { register: ({ path, handler }) => { handlers.set(path, handler); return () => {} } },
    get: () => undefined,
    effect: fn => { const dispose = fn(); if (dispose) releases.push(dispose) },
  }
  registerSettingsBridge({ inject: (_deps, callback) => callback(scope) }, 'prompt-tool', () => ({}), () => ({}), () => '', undefined,
    () => directory, undefined, async () => { rebuilds++; await afterRebuild?.(file) })
  test.after(() => releases.forEach(dispose => dispose()))
  return { file, original, id, get rebuilds() { return rebuilds }, async call(body = {}, request = {}) {
    const response = fakeRes()
    await handlers.get('/api/prompt-tool/settings/rules')(fakeReq({ body: { expectedPresetId: id, ...body }, ...request }), response)
    return readBridge(response)
  } }
}

test('统一规则桥：候选校验不写盘，激活整组停用，改名保持序号和注释', async () => {
  const h = harness()
  const initial = await h.call()
  assert.equal(initial.status, 200, initial.message)
  assert.deepEqual(initial.value.rules, [])
  assert.ok(initial.value.meta.actions.some(action => action.kind === 'inject-text'))
  const edits = ['a', 'b'].map(id => ({ previousId: null, rule: textRule(id) }))
  const checked = await h.call({ edits, expectedRevision: initial.value.revision, validateOnly: true })
  assert.equal(checked.ok, true, checked.message)
  assert.equal(readFileSync(h.file, 'utf8'), h.original)
  assert.equal(h.rebuilds, 0)
  const created = await h.call({ edits, activateRuleId: 'a', expectedRevision: initial.value.revision })
  assert.equal(created.ok, true, created.message)
  assert.deepEqual(created.value.rules.map(rule => [rule.id, rule.enabled]), [['a', true], ['b', false]])
  const ordered = parseDocument(readFileSync(h.file, 'utf8'))
  ordered.set('configOrder', { a: 40, b: 10 })
  writeFileSync(h.file, ordered.toString())
  const fresh = await h.call()
  const renamed = await h.call({ expectedRevision: fresh.value.revision, edits: [{ previousId: 'a', rule: { ...created.value.rules[0], id: 'renamed' } }] })
  assert.equal(renamed.ok, true, renamed.message)
  const after = parseDocument(readFileSync(h.file, 'utf8')).toJS()
  assert.equal(after.configOrder.renamed, 40)
  assert.equal(after.configOrder.a, undefined)
  const activated = await h.call({ expectedRevision: renamed.value.revision, activateRuleId: 'b' })
  assert.equal(activated.ok, true, activated.message)
  assert.deepEqual(activated.value.rules.map(rule => [rule.id, rule.enabled]), [['renamed', false], ['b', true]])
  assert.equal((await h.call()).value.revision, activated.value.revision)
  assert.match(readFileSync(h.file, 'utf8'), /用户注释/)
  assert.match(readFileSync(h.file, 'utf8'), /未知字段/)
})

test('统一规则桥：陈旧版本、错误身份和跨站写入不改盘', async () => {
  const h = harness()
  const { revision } = (await h.call()).value
  const edit = { expectedRevision: revision, edits: [{ previousId: null, rule: textRule('a') }] }
  for (const [payload, request, status] of [
    [{ ...edit, expectedRevision: undefined }, {}, 400],
    [{ ...edit, expectedPresetId: 'other' }, {}, 409],
    [{ ...edit, unknown: true }, {}, 400],
    [edit, { headers: { origin: 'https://example.com' } }, 403],
    [edit, { remoteAddress: '192.0.2.1' }, 403],
  ]) {
    const result = await h.call(payload, request)
    assert.equal(result.status, status, result.message)
    assert.equal(readFileSync(h.file, 'utf8'), h.original)
  }
  writeFileSync(h.file, h.original + '# 外部修改\n')
  assert.equal((await h.call(edit)).status, 409)
  assert.equal(readFileSync(h.file, 'utf8'), h.original + '# 外部修改\n')
  const locked = harness({ readonly: true })
  assert.equal((await locked.call({ edits: edit.edits, expectedRevision: (await locked.call()).value.revision })).status, 403)
})

test('统一规则桥：重建失败或期间再次编辑不签发旧草稿的新版本', async () => {
  const h = harness({ afterRebuild: () => { throw new Error('rebuild stopped') } })
  const initial = await h.call()
  const result = await h.call({ expectedRevision: initial.value.revision, edits: [{ previousId: null, rule: textRule('a') }] })
  assert.equal(result.code, 'rules-rebuild-failed')
  assert.match(result.message, /已保存/)
  assert.equal(parseDocument(readFileSync(h.file, 'utf8')).toJS().rules[0].id, 'a')
  const concurrent = harness({ afterRebuild: file => {
    const doc = parseDocument(readFileSync(file, 'utf8'))
    doc.setIn(['rules', 0, 'name'], '外部编辑')
    writeFileSync(file, doc.toString())
  } })
  const snapshot = await concurrent.call()
  const conflict = await concurrent.call({ expectedRevision: snapshot.value.revision, edits: [{ previousId: null, rule: textRule('a') }] })
  assert.equal(conflict.code, 'rules-conflict')
  assert.equal((await concurrent.call()).value.rules[0].name, '外部编辑')
})
