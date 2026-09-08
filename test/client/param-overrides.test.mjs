import test from 'node:test'
import assert from 'node:assert/strict'
import { EMPTY_FIELDS } from '../../src/client/data/prompt-tool-fields.ts'
import { buildParamOverrides, isCurrentPresetDraft, readParamOverridesPatch, updateLoadedParamKeys } from '../../src/client/data/param-overrides.ts'
import { createSerialTaskQueue } from '../../src/client/data/save-queue.ts'

test('param overrides：列表与 stages 读回为 UI 草稿', () => {
  assert.deepEqual(readParamOverridesPatch({
    toolFilterAllow: ['read', 'glob'],
    maxDepth: 3,
    stages: [{ name: '了解', tools: ['read'] }],
  }), {
    toolFilterAllow: 'read, glob',
    maxDepth: '3',
    stages: [{ name: '了解', tools: 'read' }],
  })
})

test('param overrides：只发送已有键或偏离默认值的字段', () => {
  const overrides = buildParamOverrides({ ...EMPTY_FIELDS, firstTurnText: 'hello' }, {
    loadedKeys: new Set(['guideText']),
  })
  assert.equal(overrides.firstTurnText, 'hello')
  assert.equal(overrides.guideText, '', '已有空键必须发送以执行删键语义')
  assert.equal('promoteGate' in overrides, false)
})

test('param overrides：自动预选 provider 在模型为空时不落盘', () => {
  const overrides = buildParamOverrides({ ...EMPTY_FIELDS, modelProvider: 'deepseek' }, {
    loadedKeys: new Set(),
    autoModelProvider: 'deepseek',
  })
  assert.equal('modelProvider' in overrides, false)
  const explicit = buildParamOverrides({ ...EMPTY_FIELDS, modelProvider: 'deepseek', modelName: 'chat' }, {
    loadedKeys: new Set(),
    autoModelProvider: 'deepseek',
  })
  assert.equal(explicit.modelProvider, 'deepseek')
})

test('param overrides：成功保存后推进已存键，后续默认值能删除刚写入键', () => {
  const loadedKeys = new Set()
  updateLoadedParamKeys(loadedKeys, { firstTurnText: 'hello', guideText: '' })
  assert.deepEqual([...loadedKeys], ['firstTurnText'])
  const clear = buildParamOverrides({ ...EMPTY_FIELDS }, { loadedKeys })
  assert.equal(clear.firstTurnText, '')
  updateLoadedParamKeys(loadedKeys, clear)
  assert.equal(loadedKeys.has('firstTurnText'), false)
})

test('有效组合默认值仅作回显，未编辑的值不因保存其他卡片而固化', () => {
  const baseline = { ...EMPTY_FIELDS, bootstrapTools: 'read, write', maxPromoteSteps: 4, anchorTurn: true }
  const result = buildParamOverrides({ ...baseline, usePtcMode: true }, { loadedKeys: new Set(), baseline })
  assert.deepEqual(result, { usePtcMode: true })
  assert.deepEqual(buildParamOverrides({ ...baseline, anchorTurn: false }, { loadedKeys: new Set(), baseline }), { anchorTurn: false })
})

test('排队参数保存绑定原预设，切换后不发送旧草稿', async () => {
  const queue = createSerialTaskQueue()
  let current = { ...EMPTY_FIELDS, presetTemplate: 'a' }
  const draft = { ...current, bootstrapSubagents: true }
  let release
  const sent = []
  const first = queue.enqueue(() => new Promise((resolve) => { release = resolve }))
  await Promise.resolve()
  const second = queue.enqueue(async () => {
    if (isCurrentPresetDraft(draft, current)) sent.push(buildParamOverrides(draft, { loadedKeys: new Set() }))
  })
  current = { ...current, presetTemplate: 'b' }
  release()
  await Promise.all([first, second])
  assert.deepEqual(sent, [])
})

test('从自动显示的服务商选择模型时，provider 与 name 一起保存', () => {
  const baseline = { ...EMPTY_FIELDS, modelProvider: 'detected', subagentModelProvider: 'detected' }
  const fields = { ...baseline, modelName: 'main', subagentModelName: 'child' }
  assert.deepEqual(buildParamOverrides(fields, { baseline, loadedKeys: new Set(), autoModelProvider: 'detected', autoSubagentModelProvider: 'detected' }), {
    modelName: 'main', modelProvider: 'detected', subagentModelName: 'child', subagentModelProvider: 'detected',
  })
})
