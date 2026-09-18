import test from 'node:test'
import assert from 'node:assert/strict'
import { bridgeViewFromBoot, fieldsFromView, mergePresetParams, skillFieldsFromSnapshot } from '../../src/client/data/prompt-tool-view.ts'

test('fields view：当前值覆盖 base，缺省字段保留稳定默认', () => {
  const fields = fieldsFromView({
    ok: true,
    value: {
      ns: 'prompt-tool',
      revision: 3,
      // base 里残留的旧注册层屏蔽键（skillBlocked）已被弃用：读取时忽略，不会造出清单或调用策略事实。
      base: { writePreset: true, presetTemplate: 'base', skillBlocked: ['base-skill'] },
      value: { writePreset: false, presetTemplate: 'active' },
    },
  })
  assert.equal(fields.writePreset, false)
  assert.equal(fields.presetTemplate, 'active')
  // 调用策略是技能文件 frontmatter 的事实，不在 settings：缺省时保留稳定空默认，不会被 base 里的旧键带出。
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

test('fields view：技能清单、调用能力与完整性只取 bridge 顶层事实', () => {
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
    // 清单条目只带 frontmatter 的调用策略事实：两端各自独立，缺省即两端可调用。
    modelInvocable: true,
    userInvocable: false,
    path: `${path}\\demo-skill\\SKILL.md`,
    availability: 'unknown', provider: 'filesystem', canSetPolicy: true, canDelete: true,
  }
  const fields = fieldsFromView(bridgeViewFromBoot({
    ok: true,
    value: {
      ns: 'prompt-tool',
      revision: 1,
      value: {},
    },
    activeSkillsDirs: [path],
    skillCatalog: [entry, { id: 'broken-entry' }],
    skillFolders: ['D:\\referenced-skills'],
    skillsComplete: false,
  }))
  assert.deepEqual(fields.skillCatalog, [entry], '缺身份字段的条目被丢弃，其余按调用策略字段原样投影')
  assert.deepEqual(fields.skillFolders, ['D:\\referenced-skills'])
  assert.equal(fields.skillsRoot, path)
  assert.equal(fields.skillsComplete, false)
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

test('fields view：权威空快照与字段缺失都不回退旧 settings 技能事实', () => {
  const old = { id: 'old', name: 'old', folder: 'old', dir: 'D:/old', source: 'user-dsh' }
  const stale = { skillCatalog: [old], skillFolders: ['D:/old'], activeSkillsDirs: ['D:/old'] }
  for (const extras of [{}, { skillCatalog: [], skillFolders: [], activeSkillsDirs: [], skillsComplete: true }]) {
    const fields = fieldsFromView(bridgeViewFromBoot({
      ok: true, value: { ns: 'prompt-tool', revision: 1, value: stale, base: stale }, ...extras,
    }))
    assert.deepEqual(fields.skillCatalog, [])
    assert.deepEqual(fields.skillFolders, [])
    assert.equal(fields.skillsRoot, '')
    assert.equal(fields.skillsComplete, extras.skillsComplete === true)
  }
})

test('技能局部快照不包含预设字段；观测完整性只由 skillsComplete 表达，不降级条目', () => {
  const entry = { id: 'custom:demo', name: 'demo', folder: 'demo', dir: 'D:/refs', source: 'custom', valid: true,
    modelInvocable: true, userInvocable: true, availability: 'active', canSetPolicy: true, canDelete: true }
  const patch = skillFieldsFromSnapshot({ skills: [entry], complete: false, folders: ['D:/refs'], roots: ['D:/skills'] })
  assert.deepEqual(Object.keys(patch).sort(), ['skillCatalog', 'skillFolders', 'skillsComplete', 'skillsRoot'])
  // 观测完整性只由 skillsComplete 表达，不再把条目降级成 unknown（重构前语义，与参照实现
  // dsh-web 的 collectSkills 一致）。降级会让状态徽章停在「未确认」，并让「模型可用／
  // 用户可用」两个页签计数归零。
  assert.equal(patch.skillCatalog[0].availability, 'active')
  assert.equal(patch.skillsComplete, false)
  assert.equal(patch.skillCatalog[0].canSetPolicy, true)
  assert.equal(patch.skillCatalog[0].canDelete, true)
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
