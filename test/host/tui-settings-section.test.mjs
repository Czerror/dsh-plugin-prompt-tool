import { test } from 'node:test'
import assert from 'node:assert/strict'

const { registerTuiSettingsSection, settingsNamespace } = await import('../../src/runtime/tui-settings.ts')

test('settings 命名空间：取 Config owner 的 Loader 行 id，缺失时回退常量', () => {
  assert.equal(settingsNamespace({ fiber: { entry: { options: { id: 'custom-row' } } } }), 'custom-row')
  assert.equal(settingsNamespace({ fiber: { entry: { options: {} } } }), 'prompt-tool')
  assert.equal(settingsNamespace({ fiber: {} }), 'prompt-tool')
})

test('dsh-tui 设置区块：声明 prompt-tool 的模块总开关，effect 释放即撤销', () => {
  const registered = []
  const cleanups = []
  let disposed = false
  const ctx = {
    inject: (_deps, callback) => {
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
