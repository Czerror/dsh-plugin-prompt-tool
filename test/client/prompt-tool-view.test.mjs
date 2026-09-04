import test from 'node:test'
import assert from 'node:assert/strict'
import { EMPTY_FIELDS } from '../../src/client/data/prompt-tool-fields.ts'
import { bridgeViewFromBoot, fieldsFromView } from '../../src/client/data/prompt-tool-view.ts'

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
