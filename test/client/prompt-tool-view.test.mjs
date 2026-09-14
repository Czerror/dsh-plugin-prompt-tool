import test from 'node:test'
import assert from 'node:assert/strict'
import { EMPTY_FIELDS } from '../../src/client/data/prompt-tool-fields.ts'
import { bridgeViewFromBoot, fieldsFromView, mergePresetParams } from '../../src/client/data/prompt-tool-view.ts'

test('fields view：当前值覆盖 base，缺省字段保留稳定默认', () => {
  const fields = fieldsFromView({
    ok: true,
    value: {
      ns: 'prompt-tool',
      revision: 3,
      base: { writePreset: true, presetTemplate: 'base', skillOrder: ['base-skill'] },
      value: { writePreset: false, presetTemplate: 'active' },
    },
  })
  assert.equal(fields.writePreset, false)
  assert.equal(fields.presetTemplate, 'active')
  assert.deepEqual(fields.skillOrder, [], '技能顺序不在 settings：只认 describe 事实')
})

test('fields view：技能顺序/目录/rank 与目录存在性都取 describe 事实', () => {
  const path = 'D:\\AI\\CC-switch\\skills'
  const fields = fieldsFromView(bridgeViewFromBoot({
    ok: true,
    value: {
      ns: 'prompt-tool',
      revision: 1,
      value: {},
    },
    skillOrder: ['demo-skill'],
    skillsDirs: [path],
    skillRankBase: 300,
    activeSkillsDirs: [path],
    skillsDirExists: { [path]: true },
    skillCatalog: [],
  }))
  assert.deepEqual(fields.skillOrder, ['demo-skill'])
  assert.deepEqual(fields.skillsDirs, [path])
  assert.equal(fields.skillRankBase, 300)
  assert.equal(fields.skillsDirExists[path], true)
})

test('预设参数投影完整读回列表、阶段与 false；settings 不覆盖预设行为', () => {
  const fields = fieldsFromView({ ok: true, value: { ns: 'prompt-tool', revision: 1, value: { usePtcMode: true }, base: {} } })
  assert.equal(fields.usePtcMode, false)
  const next = mergePresetParams(fields, {
    guideEnabled: true, toolFilterSubagents: false, messageSources: ['user'],
    stages: [{ name: '读取', tools: ['read'] }], subagentTemperature: 0.2,
  })
  assert.equal(next.guideEnabled, true)
  assert.equal(next.toolFilterSubagents, false)
  assert.equal(next.messageSources, 'user')
  assert.deepEqual(next.stages, [{ name: '读取', tools: 'read' }])
  assert.equal(next.subagentTemperature, '0.2')
})
