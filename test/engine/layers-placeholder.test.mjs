import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wireLayers } from '../../engine/layers.mjs'

// placeholder 正文由 resolver 运行期产出，不走 config.texts；它的变量必须是
// 「声明默认值 + store 覆盖」的合并结果，否则声明值会被出口清洗静默删掉。
test('placeholder 正文引用声明变量时展开而不是被清洗删除', async () => {
  const handlers = []
  const contexts = []
  const warnings = []
  const systemPrompt = {
    section: () => () => {},
    context: (definition) => { contexts.push(definition); return () => {} },
    variable: () => () => {},
  }
  const ctx = {
    on(name, handler) { handlers.push({ name, handler }); return () => {} },
    get(name) { return name === 'systemPrompt' ? systemPrompt : undefined },
    logger: { info() {}, warn: (message) => warnings.push(message) },
  }
  const config = {
    id: 'probe',
    sourceModuleId: 'probe-mod',
    layer: 'runtime-context',
    strategy: 'placeholder',
    fill: 'probe-fill',
    position: 'prepend',
    order: 1,
    mergeMode: 'separate',
    params: { contextName: 'probe-ctx' },
    texts: [],
    variables: { value: 'V' },
    variableStore: { read: () => ({ effective: {}, session: {} }) },
    resolve: async () => ({ text: 'X={{value}}' }),
  }
  wireLayers(ctx, [config], (message) => warnings.push(message))
  const assemble = handlers.find((entry) => entry.name === 'system-prompt/assemble')
  assert.ok(assemble, 'assemble waterfall registered')
  const context = { agent: { session: { id: 's1' } } }
  const assembly = { sections: [], contexts: [{ name: 'probe-ctx', text: '' }] }
  await assemble.handler(assembly, context, () => {})
  const entry = contexts.find((definition) => definition.name === 'probe-ctx')
  assert.ok(entry, 'context registered')
  assert.equal(entry.text(context), 'X=V')
})
