import test from 'node:test'
import assert from 'node:assert/strict'
import { readModulesEnabled } from '../../src/shared/module-settings.ts'
import { renderElement, withSsr } from './support/ssr-render.mjs'

const { usePromptToolStore } = await withSsr([
  new URL('../../src/client/data/use-prompt-tool-store.ts', import.meta.url).href,
])

function officialTransport(initial) {
  const document = { ...initial }
  const calls = []
  const mutate = async ops => {
    calls.push(structuredClone(ops))
    for (const op of ops) {
      if (op.op === 'set') document[op.path[0]] = op.value
      else if (op.op === 'unset') delete document[op.path[0]]
      else assert.fail('意外操作')
    }
    return true
  }
  const scope = { subscribe: () => () => {}, getSnapshot: () => ({ value: document, revision: calls.length, writable: true, status: 'ready' }), mutate }
  return { document, calls, scope, settings: { scope, ensure: async () => {}, mutate } }
}

const expected = value => [{ op: 'set', path: ['modulesEnabled'], value }]

test('工作台直接官方transport保存总闸，两个方向都可切换', async () => {
  for (const old of [true, false]) {
    const f = officialTransport({ modulesEnabled: old })
    let store
    function Probe() { store = usePromptToolStore({}, f.settings); return null }
    renderElement(Probe, {})
    store.patch({ modulesEnabled: !old })
    assert.equal(await store.persistSwitches(), true)
    assert.deepEqual(f.calls, [expected(!old)])
    assert.deepEqual(f.document, { modulesEnabled: !old })
    assert.equal(readModulesEnabled(f.document), !old)
  }
})
