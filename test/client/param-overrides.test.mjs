//（2026-09-17 测试归一精简 Wave 3 C2a 组）：七条用例改参数化表（每行仍是一条独立 test，
//  标题原样），EMPTY_FIELDS 基线只引一次；断言逐条未改，运行用例数仍 7。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EMPTY_FIELDS } from '../../src/client/data/prompt-tool-fields.ts'
import { shouldReloadAfterParamSave, snapshotSwitches } from '../../src/client/data/dirty-state.ts'
import { buildParamOverrides, isCurrentPresetDraft, readParamOverridesPatch, updateLoadedParamKeys } from '../../src/client/data/param-overrides.ts'
import { createSerialTaskQueue } from '../../src/client/data/save-queue.ts'

for (const [name, run] of [
  ['param overrides：列表与深度读回为 UI 草稿', () => {
    assert.deepEqual(readParamOverridesPatch({
      customToolRequireApproval: ['shell', 'http'],
      maxDepth: 3,
    }), {
      customToolRequireApproval: 'shell, http',
      maxDepth: '3',
    })
  }],
  ['param overrides：只发送已有键或偏离默认值的字段', () => {
    const overrides = buildParamOverrides({ ...EMPTY_FIELDS, firstTurnText: 'hello' }, {
      loadedKeys: new Set(['guideText']),
    })
    assert.equal(overrides.firstTurnText, 'hello')
    assert.equal(overrides.guideText, '', '已有空键必须发送以执行删键语义')
    assert.equal('toolGitBashEnabled' in overrides, false)
  }],
  ['param overrides：自动预选 provider 在模型为空时不落盘', () => {
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
  }],
  ['param overrides：成功保存后推进已存键，后续默认值能删除刚写入键', () => {
    const loadedKeys = new Set()
    updateLoadedParamKeys(loadedKeys, { firstTurnText: 'hello', guideText: '' })
    assert.deepEqual([...loadedKeys], ['firstTurnText'])
    const clear = buildParamOverrides({ ...EMPTY_FIELDS }, { loadedKeys })
    assert.equal(clear.firstTurnText, '')
    updateLoadedParamKeys(loadedKeys, clear)
    assert.equal(loadedKeys.has('firstTurnText'), false)
  }],
  ['有效组合默认值仅作回显，未编辑的值不因保存其他卡片而固化', () => {
    const baseline = { ...EMPTY_FIELDS, customToolRequireApproval: 'shell, http', strReplaceEditorMaxOutputChars: 4096, firstTurnAnchor: true }
    const result = buildParamOverrides({ ...baseline, instructionHint: true }, { loadedKeys: new Set(), baseline })
    assert.deepEqual(result, { instructionHint: true })
    assert.deepEqual(buildParamOverrides({ ...baseline, firstTurnAnchor: false }, { loadedKeys: new Set(), baseline }), { firstTurnAnchor: false })
  }],
  ['排队参数保存绑定原预设，切换后不发送旧草稿', async () => {
    const queue = createSerialTaskQueue()
    let current = { ...EMPTY_FIELDS, presetTemplate: 'a' }
    const draft = { ...current, strReplaceEditorMaxOutputChars: 4096 }
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
  }],
  ['从自动显示的服务商选择模型时，provider 与 name 一起保存', () => {
    const baseline = { ...EMPTY_FIELDS, modelProvider: 'detected', subagentModelProvider: 'detected' }
    const fields = { ...baseline, modelName: 'main', subagentModelName: 'child' }
    assert.deepEqual(buildParamOverrides(fields, { baseline, loadedKeys: new Set(), autoModelProvider: 'detected', autoSubagentModelProvider: 'detected' }), {
      modelName: 'main', modelProvider: 'detected', subagentModelName: 'child', subagentModelProvider: 'detected',
    })
  }],
  ['参数保存的迟到响应不覆盖请求期间的新编辑', () => {
    // 参数保存发起时取快照；请求返回时若草稿已继续变化，则不得触发静默重载覆盖新值。
    const saved = snapshotSwitches({ ...EMPTY_FIELDS, customToolRequireApproval: 'shell' })
    assert.equal(shouldReloadAfterParamSave(snapshotSwitches({ ...EMPTY_FIELDS, customToolRequireApproval: 'shell' }), saved), true,
      '草稿未继续变化时可以静默重载')
    assert.equal(shouldReloadAfterParamSave(snapshotSwitches({ ...EMPTY_FIELDS, customToolRequireApproval: 'shell, http' }), saved), false,
      '请求期间改了共享参数：迟到响应不重载')
    // 预设身份核对：跨预设的迟到响应一律拒绝，回显不串。
    assert.equal(isCurrentPresetDraft({ presetTemplate: 'a' }, { presetTemplate: 'a' }), true)
    assert.equal(isCurrentPresetDraft({ presetTemplate: 'a', customToolRequireApproval: 'shell, http' }, { presetTemplate: 'b' }), false)
  }],
]) {
  test(name, run)
}
