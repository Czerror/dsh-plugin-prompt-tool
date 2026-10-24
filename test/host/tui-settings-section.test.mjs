import { test } from 'node:test'
import assert from 'node:assert/strict'

const { registerTuiSettingsSection } = await import('../../src/runtime/tui.ts')

test('dsh-tui 设置区块：注册 prompt-tool 的模块总开关，effect 释放即撤销', () => {
  const registered = []
  const cleanups = []
  let disposed = false
  const ctx = {
    inject: (deps, callback) => {
      assert.deepEqual(deps, ['tuiSettingsSections'])
      return callback({
        effect: execute => { cleanups.push(execute()) },
        tuiSettingsSections: {
          register: section => {
            registered.push(section)
            return () => { disposed = true }
          },
        },
      })
    },
  }

  registerTuiSettingsSection(ctx, 'prompt-tool')

  assert.equal(registered.length, 1)
  assert.equal(registered[0].ns, 'prompt-tool')
  assert.equal(registered[0].title, 'Prompt tool')
  assert.deepEqual(registered[0].fields.map(field => [field.path.join('.'), field.kind]), [['modulesEnabled', 'boolean']])
  assert.equal(cleanups.length, 1)
  assert.equal(disposed, false)
  cleanups[0]()
  assert.equal(disposed, true)
})
