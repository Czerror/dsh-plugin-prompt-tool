import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../../engine/tool-git-bash.mjs'

test('tool-git-bash：schema 要求 description，供宿主标准 shell 卡片消费', () => {
  const registered = []
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
    subprocess: {},
  }
  apply(ctx, { enabled: true, timeoutMs: 1_000, maxOutputBytes: 1_024 })
  assert.equal(registered.length, 1)
  const schema = registered[0].parameters
  assert.deepEqual(schema.required, ['command', 'description'])
  assert.equal(schema.properties.description.type, 'string')
})
