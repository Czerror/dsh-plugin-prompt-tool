import test from 'node:test'
import assert from 'node:assert/strict'
import { bridgeViewFromBoot, fieldsFromView, mergePresetParams } from '../../src/client/data/prompt-tool-view.ts'

test('fields view：当前值覆盖 base，缺省字段保留稳定默认', () => {
  const fields = fieldsFromView({
    ok: true,
    value: {
      ns: 'prompt-tool',
      revision: 3,
      base: { writePreset: true, presetTemplate: 'base', skillBlocked: ['base-skill'] },
      value: { writePreset: false, presetTemplate: 'active' },
    },
  })
  assert.equal(fields.writePreset, false)
  assert.equal(fields.presetTemplate, 'active')
  // 注册层技能事实不在 settings：缺省时保留稳定空默认，不会被 base 里的同名键带出。
  assert.deepEqual(fields.skillFolders, [])
  assert.deepEqual(fields.skillCatalog, [])
  assert.equal(fields.skillsRoot, '')
  // 技能事实不来自 settings：字段集合由投影决定，base 里塞同名键既不会带出值也不会带出键。
  assert.deepEqual(
    Object.keys(fields).sort(),
    Object.keys(fieldsFromView({ ok: true, value: { ns: 'prompt-tool', revision: 1, base: {}, value: {} } })).sort(),
    '字段集合不受 settings 内容影响',
  )
})

test('fields view：技能清单、引用目录与用户根都取 describe 事实', () => {
  const path = 'D:\\AI\\CC-switch\\skills'
  const entry = {
    id: `user-dsh:${path}:demo-skill`,
    name: 'demo-skill',
    description: 'demo',
    folder: 'demo-skill',
    dir: path,
    source: 'user-dsh',
    rank: 400,
    valid: true,
    blocked: true,
    blockedModel: true,
    blockedUser: true,
    modelInvocable: true,
    userInvocable: true,
    path: `${path}\\demo-skill\\SKILL.md`,
  }
  const fields = fieldsFromView(bridgeViewFromBoot({
    ok: true,
    value: {
      ns: 'prompt-tool',
      revision: 1,
      // describe 载荷：清单、引用目录与用户根都来自注册层扫描事实（屏蔽状态逐条在清单条目上）。
      value: {
        activeSkillsDirs: [path],
        skillCatalog: [entry, { id: 'broken-entry' }],
        skillFolders: ['D:\\referenced-skills'],
      },
    },
  }))
  assert.deepEqual(fields.skillCatalog, [entry], '缺身份字段的条目被丢弃，其余原样投影')
  assert.deepEqual(fields.skillFolders, ['D:\\referenced-skills'])
  assert.equal(fields.skillsRoot, path)
  // 用户技能根只由 activeSkillsDirs 决定：没有它时根为空，界面据此提示重新读取。
  const missing = fieldsFromView(bridgeViewFromBoot({
    ok: true,
    value: {
      ns: 'prompt-tool',
      revision: 1,
      value: {},
    },
  }))
  assert.equal(missing.skillsRoot, '')
  assert.deepEqual(missing.skillCatalog, [])
})

test('预设参数投影完整读回列表、阶段与 false；settings 不覆盖预设行为', () => {
  const fields = fieldsFromView({ ok: true, value: { ns: 'prompt-tool', revision: 1, value: { usePtcMode: true }, base: {} } })
  assert.equal(fields.usePtcMode, false)
  const next = mergePresetParams(fields, {
    guideEnabled: true, toolFilterEnabled: false, messageSources: ['user'],
    stages: [{ name: '读取', tools: ['read'] }], subagentTemperature: 0.2,
  })
  assert.equal(next.guideEnabled, true)
  assert.equal(next.toolFilterEnabled, false)
  assert.equal(next.messageSources, 'user')
  assert.deepEqual(next.stages, [{ name: '读取', tools: 'read' }])
  assert.equal(next.subagentTemperature, '0.2')
})
