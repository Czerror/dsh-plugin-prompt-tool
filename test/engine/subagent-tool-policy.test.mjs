import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOrderedTaskClassifier } from '../../engine/classify-task.mjs'
import {
  buildSubagentToolParameters,
  compileSubagentToolPolicy,
  resolveSubagentToolPolicy,
  validateSubagentToolPolicy,
} from '../../engine/subagent-tool-policy-core.mjs'

const SAMPLE = {
  defaultProfile: 'base',
  ceiling: { allow: ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'web_search'], deny: ['dangerous_tool'] },
  profiles: [
    { id: 'base', name: '基础', allow: ['read', 'glob', 'grep'], deny: [], modelSelectable: false },
    { id: 'researcher', name: '研究', allow: ['read', 'glob', 'grep', 'web_search'], deny: ['write', 'bash'], modelSelectable: true },
    { id: 'coder', name: '编码', allow: ['read', 'write', 'edit', 'glob', 'grep', 'bash'], deny: [], modelSelectable: true },
  ],
  characterBindings: [
    { characterId: 'analyst', profile: 'researcher', modelSelectable: true },
    { characterId: 'developer', profile: 'coder', modelSelectable: true },
  ],
  taskRules: [
    { id: 'research', name: '资料研究', pattern: '(research|调研|搜索|资料|文档)', profile: 'researcher', order: 100, modelSelectable: true },
    { id: 'implementation', name: '编码实现', pattern: '(implement|build|实现|开发|修复)', profile: 'coder', order: 200, modelSelectable: true },
  ],
  modelExpansion: { enabled: true, allow: ['web_search', 'bash'], maxAdditionalTools: 2, requireApproval: true },
}

const AVAILABLE = ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'web_search']

test('policy-core：validate —— 合法策略零错误', () => {
  assert.deepEqual(validateSubagentToolPolicy(SAMPLE), [])
})

test('policy-core：validate —— defaultProfile 缺失/悬空、id 重复、ceiling 子集、非法正则、非法 maxAdditionalTools', () => {
  const missingDefault = validateSubagentToolPolicy({ ...SAMPLE, defaultProfile: undefined })
  assert.ok(missingDefault.some((message) => message.includes('defaultProfile is required')))
  const danglingDefault = validateSubagentToolPolicy({ ...SAMPLE, defaultProfile: 'nope' })
  assert.ok(danglingDefault.some((message) => message.includes('must reference an existing profile')))
  const dup = validateSubagentToolPolicy({
    ...SAMPLE,
    profiles: [SAMPLE.profiles[0], SAMPLE.profiles[0]],
  })
  assert.ok(dup.some((message) => message.includes('duplicated')))
  const ceilingSubset = validateSubagentToolPolicy({
    ...SAMPLE,
    profiles: [{ ...SAMPLE.profiles[0], allow: ['read', 'hacker_tool'] }],
    defaultProfile: 'base',
  })
  assert.ok(ceilingSubset.some((message) => message.includes('exceeds ceiling.allow')))
  const badRegex = validateSubagentToolPolicy({
    ...SAMPLE,
    taskRules: [{ ...SAMPLE.taskRules[0], pattern: '([unclosed' }],
  })
  assert.ok(badRegex.some((message) => message.includes('not a valid regular expression')))
  const badMax = validateSubagentToolPolicy({
    ...SAMPLE,
    modelExpansion: { ...SAMPLE.modelExpansion, maxAdditionalTools: -1 },
  })
  assert.ok(badMax.some((message) => message.includes('non-negative safe integer')))
  const emptyCeiling = validateSubagentToolPolicy({ ...SAMPLE, ceiling: { allow: [], deny: [] } })
  assert.ok(emptyCeiling.some((message) => message.includes('must be a non-empty list')))
  const ref = validateSubagentToolPolicy({
    ...SAMPLE,
    characterBindings: [{ characterId: 'x', profile: 'ghost' }],
  })
  assert.ok(ref.some((message) => message.includes('must reference an existing profile')))
})

test('policy-core：compile —— 非法策略抛错，合法策略归一为运行态结构', () => {
  assert.throws(() => compileSubagentToolPolicy({}), /invalid subagentToolPolicy/)
  const compiled = compileSubagentToolPolicy(SAMPLE)
  assert.equal(compiled.defaultProfileId, 'base')
  assert.ok(compiled.profileMap.has('coder'))
  assert.equal(compiled.taskRules[0].id, 'research')
  assert.equal(compiled.taskRules[1].id, 'implementation')
  assert.deepEqual(compiled.modelSelectableProfiles, ['researcher', 'coder'])
  assert.deepEqual(compiled.modelSelectableCharacterIds, ['analyst', 'developer'])
  assert.deepEqual(compiled.modelSelectableTaskTypes, ['research', 'implementation'])
  assert.equal(compiled.expansion.maxAdditionalTools, 2)
  assert.equal(typeof compiled.classify, 'function')
})

test('policy-core：resolve —— selector 优先级 tool_profile > character_id > task_type > 自动分类 > default', () => {
  const compiled = compileSubagentToolPolicy(SAMPLE)
  const base = { description: '', prompt: '' }
  // 显式 tool_profile
  const byProfile = resolveSubagentToolPolicy(compiled, { ...base, tool_profile: 'coder' }, AVAILABLE)
  assert.equal(byProfile.profileId, 'coder')
  assert.deepEqual(byProfile.adopted, ['tool_profile'])
  assert.equal(byProfile.characterId, undefined)
  // character_id（无显式 profile）
  const byChar = resolveSubagentToolPolicy(compiled, { ...base, character_id: 'analyst' }, AVAILABLE)
  assert.equal(byChar.profileId, 'researcher')
  assert.equal(byChar.characterId, 'analyst')
  assert.deepEqual(byChar.adopted, ['character_id'])
  // task_type（无显式 profile/character）
  const byTask = resolveSubagentToolPolicy(compiled, { ...base, task_type: 'implementation' }, AVAILABLE)
  assert.equal(byTask.profileId, 'coder')
  assert.equal(byTask.taskType, 'implementation')
  assert.deepEqual(byTask.adopted, ['task_type'])
  // 自动分类
  const byAuto = resolveSubagentToolPolicy(compiled, { ...base, description: '帮我调研一下资料' }, AVAILABLE)
  assert.equal(byAuto.profileId, 'researcher')
  assert.deepEqual(byAuto.adopted, ['auto-classify'])
  // 无匹配 → default
  const byDefault = resolveSubagentToolPolicy(compiled, { ...base, description: '随便聊聊' }, AVAILABLE)
  assert.equal(byDefault.profileId, 'base')
  assert.deepEqual(byDefault.adopted, [])
})

test('policy-core：resolve —— 无效 selector 被忽略并回显，不静默歧义', () => {
  const compiled = compileSubagentToolPolicy(SAMPLE)
  const result = resolveSubagentToolPolicy(compiled, { tool_profile: 'ghost', character_id: 'ghost', task_type: 'ghost', description: '' }, AVAILABLE)
  assert.equal(result.profileId, 'base')
  assert.deepEqual(result.ignored, ['tool_profile', 'character_id', 'task_type'])
})

test('policy-core：resolve —— 扩权受 modelExpansion.allow ∩ ceiling.allow ∩ presetAvailable 约束，deny 永远优先', () => {
  const compiled = compileSubagentToolPolicy(SAMPLE)
  // 非法扩权工具：不在 expansion.allow（edit）→ 拒绝
  const r1 = resolveSubagentToolPolicy(compiled, { tool_profile: 'base', additional_tools: ['edit'] }, AVAILABLE)
  assert.deepEqual(r1.additionalTools, [])
  // 合法扩权：web_search 在 expansion.allow + ceiling + available
  const r2 = resolveSubagentToolPolicy(compiled, { tool_profile: 'base', additional_tools: ['web_search'] }, AVAILABLE)
  assert.deepEqual(r2.additionalTools, ['web_search'])
  assert.ok(r2.effectiveTools.includes('web_search'))
  assert.equal(r2.requiresApproval, true)
  // maxAdditionalTools=2 截断
  const r3 = resolveSubagentToolPolicy(compiled, { tool_profile: 'base', additional_tools: ['web_search', 'bash', 'web_search'] }, AVAILABLE)
  assert.deepEqual(r3.additionalTools, ['web_search', 'bash'])
  // ceiling.deny 永远优先：base + 扩权也不能得到 dangerous_tool
  const r4 = resolveSubagentToolPolicy(compiled, { tool_profile: 'coder', additional_tools: ['dangerous_tool'] }, AVAILABLE)
  assert.ok(!r4.effectiveTools.includes('dangerous_tool'))
  // presetAvailable 之外的工具不可用
  const r5 = resolveSubagentToolPolicy(compiled, { tool_profile: 'coder' }, ['read', 'write'])
  assert.deepEqual(r5.effectiveTools, ['read', 'write'])
})

test('policy-core：resolve —— profile.deny / restrict_tools 从有效集移除', () => {
  const compiled = compileSubagentToolPolicy(SAMPLE)
  const r = resolveSubagentToolPolicy(compiled, { tool_profile: 'researcher', restrict_tools: ['grep'] }, AVAILABLE)
  assert.deepEqual(r.effectiveTools, ['glob', 'read', 'web_search'])
  // researcher deny 含 write/bash
  assert.ok(!r.effectiveTools.includes('write'))
  assert.ok(!r.effectiveTools.includes('bash'))
})

test('policy-core：buildSubagentToolParameters —— 只暴露可选项，扩权关闭时无 additional_tools，restrict_tools 恒在', () => {
  const compiled = compileSubagentToolPolicy(SAMPLE)
  const params = buildSubagentToolParameters(compiled)
  assert.deepEqual(params.tool_profile.enum, ['researcher', 'coder'])
  assert.deepEqual(params.character_id.enum, ['analyst', 'developer'])
  assert.deepEqual(params.task_type.enum, ['research', 'implementation'])
  assert.equal(params.additional_tools.maxItems, 2)
  assert.deepEqual(params.additional_tools.items.enum, ['web_search', 'bash'])
  assert.ok(params.restrict_tools !== undefined)
  // 关闭扩权：additional_tools 不出现
  const closed = compileSubagentToolPolicy({ ...SAMPLE, modelExpansion: { ...SAMPLE.modelExpansion, enabled: false } })
  const closedParams = buildSubagentToolParameters(closed)
  assert.equal(closedParams.additional_tools, undefined)
})

test('classify-task：createOrderedTaskClassifier —— order 升序、首个匹配获胜、无匹配 undefined', () => {
  const classifier = createOrderedTaskClassifier([
    { id: 'implementation', re: /(implement|实现)/, order: 200 },
    { id: 'research', re: /(research|调研)/, order: 100 },
    { id: 'generic', re: /./, order: 300 },
  ])
  assert.equal(classifier('需要调研一下'), 'research')
  assert.equal(classifier('帮我实现一个功能'), 'implementation')
  // 首个匹配获胜：即使后来规则也匹配
  assert.equal(classifier('实现之前先调研'), 'research')
  assert.equal(classifier('nothing matches'), 'generic')
  const empty = createOrderedTaskClassifier([])
  assert.equal(empty('anything'), undefined)
})