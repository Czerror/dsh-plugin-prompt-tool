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
  assert.deepEqual(fields.skillOrder, ['base-skill'])
  assert.equal(fields.writeAgents, EMPTY_FIELDS.writeAgents)
})

test('fields view：保留 bootstrap 顶层的技能目录存在性', () => {
  const path = 'D:\\AI\\CC-switch\\skills'
  const fields = fieldsFromView(bridgeViewFromBoot({
    ok: true,
    value: {
      ns: 'prompt-tool',
      revision: 1,
      value: { skillsDirs: [path], activeSkillsDirs: [path] },
    },
    activeSkillsDirs: [path],
    skillsDirExists: { [path]: true },
    skillCatalog: [],
  }))
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
