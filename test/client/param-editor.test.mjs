import test from 'node:test'
import assert from 'node:assert/strict'
import { createParamEditor } from '../../src/client/data/param-editor.ts'

test('参数编辑器：发布重试只发 refreshOnly，不重写参数', async () => {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers })
    return new Response(JSON.stringify({ ok: true, value: { overrides: { modelTemperature: 0.5 }, persisted: true, publicationPending: false } }))
  }
  try {
    const editor = createParamEditor({
      isPresent: () => true,
      declares: () => true,
      canEdit: () => true,
      globalEnabled: () => true,
      hasRawDraft: () => false,
      enqueue: task => task(),
      changed: () => {},
      edited: () => {},
      showNotice: () => {},
      prepareRefresh: () => async () => {},
    })
    await editor.retryParamPublication('module', 'mod-a')
    await editor.retryParamPublication('global')
    assert.deepEqual(calls.map(call => call.body), [
      { refreshOnly: true, expectedModuleId: 'mod-a' },
      { refreshOnly: true },
    ])
    assert.equal(calls[0].headers['x-module-id'], 'mod-a')
  } finally { globalThis.fetch = original }
})
