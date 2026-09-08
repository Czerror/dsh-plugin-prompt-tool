import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createSerialTaskQueue } from '../../src/client/data/save-queue.ts'
import { shouldReloadAfterPresetSave } from '../../src/client/data/dirty-state.ts'

test('save queue：任务严格串行', async () => {
  const queue = createSerialTaskQueue()
  const events = []
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const first = queue.enqueue(async () => { events.push('a:start'); await gate; events.push('a:end') })
  const second = queue.enqueue(async () => { events.push('b') })
  await Promise.resolve()
  assert.deepEqual(events, ['a:start'])
  release()
  await Promise.all([first, second])
  assert.deepEqual(events, ['a:start', 'a:end', 'b'])
})

test('save queue：失败任务不阻断后续任务', async () => {
  const queue = createSerialTaskQueue()
  const first = queue.enqueue(async () => { throw new Error('boom') })
  let ran = false
  const second = queue.enqueue(async () => { ran = true })
  await assert.rejects(first, /boom/)
  await second
  assert.equal(ran, true)
})

test('save queue：跨通道新草稿使旧任务跳过重载，只由最新任务刷新', async () => {
  const queue = createSerialTaskQueue()
  const reloads = []
  let draftVersion = 1
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const paramSave = queue.enqueue(async () => {
    await gate
    if (shouldReloadAfterPresetSave(1, draftVersion, true)) reloads.push('params')
  })
  draftVersion = 2
  const configSave = queue.enqueue(async () => {
    if (shouldReloadAfterPresetSave(2, draftVersion, true)) reloads.push('configs')
  })
  release()
  await Promise.all([paramSave, configSave])
  assert.deepEqual(reloads, ['configs'])
})

test('store：参数与提示词配置保存共用预设队列，旧响应不重载新草稿', () => {
  const source = readFileSync(new URL('../../src/client/data/use-prompt-tool-store.ts', import.meta.url), 'utf8')
  const paramSave = source.slice(source.indexOf('const persistParamOverrides'), source.indexOf('const persistConfigs'))
  const configSave = source.slice(source.indexOf('const persistConfigs'), source.indexOf('const saveTemplateVariables'))
  assert.match(source, /const presetSaveQueueRef = useRef\(createSerialTaskQueue\(\)\)/)
  assert.doesNotMatch(source, /paramSaveQueueRef/)
  assert.match(paramSave, /presetSaveQueueRef\.current\.enqueue/)
  assert.match(configSave, /presetSaveQueueRef\.current\.enqueue/)
  assert.match(paramSave, /shouldReloadAfterPresetSave/)
  assert.match(configSave, /shouldReloadAfterPresetSave/)
  assert.match(paramSave, /await load\(\{ silent: true \}\)/)
  assert.match(configSave, /await load\(\{ silent: true \}\)/)
  // 待编辑变量行（空 key）不落盘：保存后不得静默重载，否则服务端状态覆盖草稿使编辑行消失。
  assert.match(paramSave, /!hasPendingVariableRows\(f\.promptConfigs\)/)
  assert.match(configSave, /!pendingVariableRows && shouldReloadAfterPresetSave/)
})
