// 合并自 dirty-state.test.mjs(4) + save-queue.test.mjs(4) + prompt-tool-stages.test.mjs(4)
//（2026-09-17 测试归一精简 Wave 3 C2a 组）：三者同属「编辑器草稿状态与保存队列」主题，
//  共用 EMPTY_FIELDS / snapshotSwitches / shouldReload* 依赖，合并后保留全部 12 条运行用例与逐条断言。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EMPTY_FIELDS, hasIncompleteStageDrafts } from '../../src/client/data/prompt-tool-fields.ts'
import {
  deepEqual,
  EMPTY_SWITCHES,
  hasPendingVariableRows,
  promptConfigsDirty,
  shouldReloadAfterParamSave,
  shouldReloadAfterPresetSave,
  snapshotSwitches,
  switchesEqual,
} from '../../src/client/data/dirty-state.ts'
import { createSerialTaskQueue } from '../../src/client/data/save-queue.ts'
import { ENGINE_PARAM_KEYS } from '../../src/shared/engine-params.ts'

// —— 脏状态比较（原 dirty-state.test.mjs） ——

test('dirty state：record 键序不影响比较，数组顺序仍有意义', () => {
  assert.equal(deepEqual({ a: 1, b: [2, 3] }, { b: [2, 3], a: 1 }), true)
  assert.equal(deepEqual([1, 2], [2, 1]), false)
})

test('dirty state：两个独立空配置数组不误判脏', () => {
  assert.equal(promptConfigsDirty([], []), false)
  const config = { id: 'x' }
  assert.equal(promptConfigsDirty([config], [config]), true)
})

test('dirty state：snapshot 深拷贝可变集合并比较全字段', () => {
  const fields = { ...EMPTY_FIELDS, stages: [{ name: 'a', tools: 'read' }] }
  const snapshot = snapshotSwitches(fields)
  fields.stages[0].name = 'changed'
  fields.stages.push({ name: 'b', tools: 'write' })
  assert.deepEqual(snapshot.stages, [{ name: 'a', tools: 'read' }], 'snapshot 深拷贝，隔离保存期间的继续编辑')
  assert.equal(switchesEqual(snapshot, snapshotSwitches({ ...EMPTY_FIELDS, stages: [{ name: 'a', tools: 'read' }] })), true)
  assert.equal(switchesEqual(snapshot, snapshotSwitches({ ...EMPTY_FIELDS, stages: [{ name: 'a', tools: 'write' }] })), false)
  // 注册层技能事实（清单 / 引用目录 / 用户根）不属于 settings 参数。这里断言快照的键集合
  // 恰好是参数键：写 Object.hasOwn(snapshot, key) 只会恒真（快照本就只挑参数键），
  // 有人把技能字段塞进 snapshotSwitches 时不会失败。
  assert.deepEqual(
    Object.keys(snapshot).sort(),
    [...ENGINE_PARAM_KEYS, 'presetOrder', 'fallbackText', 'writePreset'].sort(),
    '参数快照只包含引擎参数与设置快照键',
  )
  const withSkills = { ...EMPTY_FIELDS, skillCatalog: [{ id: 'x' }], skillFolders: ['D:/referenced'], skillsRoot: 'D:/skills' }
  assert.equal(switchesEqual(snapshotSwitches(withSkills), EMPTY_SWITCHES), true, '技能事实变化不产生参数脏状态')
})

test('dirty state：空 key 变量待编辑行单独识别（保存后不静默重载）', () => {
  assert.equal(hasPendingVariableRows([{ id: 'a' }]), false)
  assert.equal(hasPendingVariableRows([{ id: 'a', variables: {} }]), false)
  assert.equal(hasPendingVariableRows([{ id: 'a', variables: { key: 'v' } }]), false)
  assert.equal(hasPendingVariableRows([{ id: 'a', variables: { '': '' } }]), true)
  assert.equal(hasPendingVariableRows([{ id: 'a', variables: { '  ': 'v', key: 'v' } }]), true)
})

// —— 保存队列串行（原 save-queue.test.mjs） ——

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
  assert.match(configSave, /await load\(\{ silent: true, presetConfigs: configs\.filter\(isPresetCard\) \}\)/)
  // 待编辑变量行（空 key）不落盘：保存后不得静默重载，否则服务端状态覆盖草稿使编辑行消失。
  assert.match(paramSave, /!hasPendingVariableRows\(f\.promptConfigs\)/)
  assert.match(configSave, /!pendingVariableRows && shouldReloadAfterPresetSave/)
})

// —— 阶段草稿与重载判定（原 prompt-tool-stages.test.mjs） ——

const cards = readFileSync(new URL('../../src/client/features/modules/EngineParamFields.tsx', import.meta.url), 'utf8')
const snapshotWithStages = (stages) => snapshotSwitches({ ...EMPTY_FIELDS, stages })

test('stages 添加按钮追加可编辑的空草稿行', () => {
  const start = cards.indexOf("if (definition.kind === 'stages')")
  const end = cards.indexOf("if (definition.kind === 'string-list')")
  assert.ok(start >= 0 && end > start, '应找到 stages UI 区块')
  const stagesUi = cards.slice(start, end)
  assert.ok(stagesUi.includes("update([...stages, { name: '', tools: '' }])"), '添加按钮应追加空阶段草稿行，不立即保存')
  // 按钮文案走 prompt-tool 字典（归档 §8.3.1 分词典）：断言键名而不是中文字面量。
  assert.ok(stagesUi.includes("t('param.stages.add')"), '应显示添加阶段按钮')
})

test('stages 未完成草稿保存后不重载，避免新增行立即消失', () => {
  for (const stages of [
    [{ name: '', tools: '' }],
    [{ name: '了解', tools: '' }],
    [{ name: '', tools: 'read, glob' }],
  ]) {
    const snapshot = snapshotWithStages(stages)
    assert.equal(hasIncompleteStageDrafts(stages), true)
    assert.equal(shouldReloadAfterParamSave(snapshot, snapshot), false)
  }
})

test('stages 完整且保存期间未继续编辑时允许重载', () => {
  const saved = snapshotWithStages([{ name: '了解', tools: 'read, glob' }])
  assert.equal(hasIncompleteStageDrafts(saved.stages), false)
  assert.equal(shouldReloadAfterParamSave(saved, saved), true)
})

test('stages 保存期间继续编辑时仍跳过旧快照重载', () => {
  const saved = snapshotWithStages([{ name: '了解', tools: 'read' }])
  const current = snapshotWithStages([{ name: '了解', tools: 'read, glob' }])
  assert.equal(shouldReloadAfterParamSave(current, saved), false)
})
