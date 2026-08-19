import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ensureSettingsRegistered } from '../../lib/index.mjs'

function makeSctx(describeEntries, registerImpl) {
  const calls = { register: 0, onRegistered: 0, onError: 0 }
  const sctx = {
    settings: {
      describe: () => describeEntries,
      register: registerImpl ?? ((_ns, _schema, options) => {
        calls.register += 1
        const value = { text: options.base.text }
        return {
          get: () => value,
          watch: () => {},
        }
      }),
    },
  }
  const hooks = {
    base: () => ({ text: 'base' }),
    onRegistered: (scope) => {
      calls.onRegistered += 1
      assert.equal(scope.get().text, 'base')
      scope.watch(() => {})
    },
    onError: () => { calls.onError += 1 },
  }
  return { sctx, hooks, calls }
}

test('未注册时补注册并接线，返回 true', () => {
  const { sctx, hooks, calls } = makeSctx([])
  const ok = ensureSettingsRegistered(sctx, 'prompt-tool', {}, hooks)
  assert.equal(ok, true)
  assert.equal(calls.register, 1)
  assert.equal(calls.onRegistered, 1)
  assert.equal(calls.onError, 0)
})

test('已注册时跳过（幂等），不重复注册', () => {
  const { sctx, hooks, calls } = makeSctx([{ ns: 'prompt-tool' }])
  const ok = ensureSettingsRegistered(sctx, 'prompt-tool', {}, hooks)
  assert.equal(ok, true)
  assert.equal(calls.register, 0)
  assert.equal(calls.onRegistered, 0)
})

test('register 抛错时走 onError 并返回 false（bad schema/data 不中断请求）', () => {
  const { sctx, hooks, calls } = makeSctx([], () => {
    calls.register += 1
    throw new Error('invalid stored section')
  })
  const ok = ensureSettingsRegistered(sctx, 'prompt-tool', {}, hooks)
  assert.equal(ok, false)
  assert.equal(calls.register, 1)
  assert.equal(calls.onError, 1)
  assert.equal(calls.onRegistered, 0)
})
