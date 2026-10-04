import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tempDir } from '../fixtures/host-harness.mjs'
import { apply, configContract } from '../../engine/tool-config-engine.mjs'

const directory = tempDir('pt-inline-tools-')
const definitions = [
  { id: 'ask', name: 'ask', description: '确认 {{args.value}}', timeoutMs: 2000,
    parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    output: { schema: { type: 'object', additionalProperties: true } },
    execute: { kind: 'ask-user', question: '继续？' } },
  { id: 'disabled', name: 'disabled', description: '停用', enabled: false,
    output: { schema: { type: 'object' } }, execute: { kind: 'ask-user' } },
]
definitions.forEach((definition, index) => writeFileSync(join(directory, `${index}.json`), JSON.stringify(definition)))

function harness() {
  const registered = []
  const disposed = []
  const effects = []
  const warnings = []
  return { registered, disposed, effects, warnings, ctx: {
    tools: { register: tool => { registered.push(tool); return () => disposed.push(tool.name) } },
    effect: fn => effects.push(fn()),
    logger: { info() {}, warn: message => warnings.push(message) },
    get: name => name === 'approval' ? { request: async () => 'allowed-once' } : undefined,
  } }
}

test('工具内联与文件入口提供相同 schema、执行结果和释放行为', async () => {
  const observed = []
  for (const config of [{ configsDir: directory }, { tools: definitions, configsDir: join(directory, 'missing') }]) {
    const h = harness()
    apply(h.ctx, config)
    assert.deepEqual(h.warnings, [])
    assert.deepEqual(h.registered.map(tool => tool.name), ['ask'])
    const tool = h.registered[0]
    assert.equal(tool.description, '确认 {args.value}')
    assert.equal(tool.timeoutMs, 2000)
    const output = await tool.execute({ value: 'ok' }, { agent: { id: 'agent' }, signal: new AbortController().signal })
    assert.deepEqual(output, { ok: true, answer: 'allowed-once' })
    observed.push({ parameters: tool.parameters, output: tool.output.schema, result: output })
    h.effects.forEach(dispose => dispose())
    assert.deepEqual(h.disposed, ['ask'])
  }
  assert.deepEqual(observed[0], observed[1])
})

test('工具内联空数组不回落旧目录，非法内联在注册前拒绝', () => {
  const empty = harness()
  apply(empty.ctx, { tools: [], configsDir: directory })
  assert.deepEqual(empty.registered, [])
  assert.deepEqual(empty.warnings, [])
  for (const tools of [undefined, null, {}, [null], [definitions[0], {}]]) {
    const h = harness()
    assert.throws(() => apply(h.ctx, { tools, configsDir: directory }), /tools|tool definition/)
    assert.deepEqual(h.registered, [], '非法内联不得留下部分注册或加载旧目录')
  }
})

test('资源允许根兼容旧名，同值可共存，冲突在装配前拒绝', () => {
  const root = pathToFileURL(directory).href
  assert.equal(configContract.parse({ resourceRoot: root }, 'probe').resourceRoot, root)
  assert.equal(configContract.parse({ presetRoot: root }, 'probe').resourceRoot, root)
  assert.equal(configContract.parse({ resourceRoot: root, presetRoot: root }, 'probe').resourceRoot, root)
  assert.throws(() => configContract.parse({ resourceRoot: root, presetRoot: `${root}/other` }, 'probe'), /resourceRoot.*presetRoot.*conflict/)
  for (const field of ['resourceRoot', 'presetRoot']) {
    const allowed = harness()
    apply(allowed.ctx, { configsDir: root, [field]: root })
    assert.deepEqual(allowed.registered.map(tool => tool.name), ['ask'])
    allowed.effects.forEach(dispose => dispose())
    const rejected = harness()
    apply(rejected.ctx, { configsDir: root, [field]: `${root}/other` })
    assert.deepEqual(rejected.registered, [])
    assert.match(rejected.warnings[0], /escapes resource root/)
  }
})
