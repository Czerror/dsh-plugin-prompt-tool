import test from 'node:test'
import assert from 'node:assert/strict'
import { bridgeViewFromBoot, fieldsFromView, mergePresetParams } from '../../src/client/data/prompt-tool-view.ts'

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
    // 清单条目只带 frontmatter 的调用策略事实：两端各自独立，缺省即两端可调用。
    modelInvocable: true,
    userInvocable: false,
    path: `${path}\\demo-skill\\SKILL.md`,
  }
  const fields = fieldsFromView(bridgeViewFromBoot({
    ok: true,
    value: {
      ns: 'prompt-tool',
      revision: 1,
      // describe 载荷：清单、引用目录与用户根都来自插件对六类官方技能根的扫描事实
      // （调用策略逐条在清单条目上，且只来自该技能文件自己的 frontmatter）。
      value: {
        activeSkillsDirs: [path],
        skillCatalog: [entry, { id: 'broken-entry' }],
        skillFolders: ['D:\\referenced-skills'],
      },
    },
  }))
  assert.deepEqual(fields.skillCatalog, [entry], '缺身份字段的条目被丢弃，其余按调用策略字段原样投影')
  assert.deepEqual(fields.skillFolders, ['D:\\referenced-skills'])
  assert.equal(fields.skillsRoot, path)
  // 旧注册层屏蔽字段即使仍留在载荷里也不进投影：条目上只有 frontmatter 的调用策略事实。
  const legacy = fieldsFromView(bridgeViewFromBoot({
    ok: true,
    value: {
      ns: 'prompt-tool',
      revision: 1,
      value: { skillCatalog: [{ ...entry, blocked: true, blockedModel: true, blockedUser: true }] },
    },
  }))
  assert.deepEqual(legacy.skillCatalog, [entry])
  assert.equal('blocked' in legacy.skillCatalog[0], false, '投影不携带 blocked')
  assert.equal('blockedModel' in legacy.skillCatalog[0], false, '投影不携带 blockedModel')
  assert.equal('blockedUser' in legacy.skillCatalog[0], false, '投影不携带 blockedUser')
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

test('fields view：技能事实的取值优先级（顶层 → descriptor value；技能根再兜底 base）', () => {
  const path = 'D:\\AI\\CC-switch\\skills'
  const fromValue = fieldsFromView({
    ok: true,
    value: {
      ns: 'prompt-tool',
      revision: 1,
      value: { activeSkillsDirs: [path], skillFolders: ['D:\\from-value'] },
      base: { activeSkillsDirs: ['D:\\ignored-base'] },
    },
  })
  assert.equal(fromValue.skillsRoot, path, 'descriptor value 覆盖 base')
  assert.deepEqual(fromValue.skillFolders, ['D:\\from-value'])

  const fromBase = fieldsFromView({
    ok: true,
    value: { ns: 'prompt-tool', revision: 1, value: {}, base: { activeSkillsDirs: ['D:\\from-base'] } },
  })
  assert.equal(fromBase.skillsRoot, 'D:\\from-base', 'value 缺失时退回 base')

  // 引用目录只从顶层扩展字段或 descriptor value 读，没有 base 兜底——这是实现事实，一并钉住，
  // 免得后来人以为 base 也是它的来源。
  const foldersFromBase = fieldsFromView({
    ok: true,
    value: { ns: 'prompt-tool', revision: 1, value: {}, base: { skillFolders: ['D:\\base-only'] } },
  })
  assert.deepEqual(foldersFromBase.skillFolders, [], 'skillFolders 不读 base')

  const fromTop = fieldsFromView({
    ok: true,
    value: {
      ns: 'prompt-tool',
      revision: 1,
      value: { activeSkillsDirs: ['D:\\from-value'] },
      base: { activeSkillsDirs: ['D:\\from-base'] },
    },
    activeSkillsDirs: ['D:\\from-top'],
    skillFolders: ['D:\\top-folder'],
  })
  assert.equal(fromTop.skillsRoot, 'D:\\from-top', '顶层扩展字段优先于 descriptor')
  assert.deepEqual(fromTop.skillFolders, ['D:\\top-folder'])
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
