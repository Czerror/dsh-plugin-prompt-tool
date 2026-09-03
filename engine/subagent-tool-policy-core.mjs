/**
 * subagent-tool-policy-core — 子代理实例级工具策略纯模块（单一 seam）。
 *
 * Host bridge、运行时 shadow 工具与测试都只经过本模块的四个接口：
 *   validateSubagentToolPolicy  — 策略 schema/唯一性/引用/子集校验（返回错误列表）；
 *   compileSubagentToolPolicy   — 校验后编译（正则编译、稳定排序、Set 归一）；
 *   resolveSubagentToolPolicy   — 实例选择与有效工具集解析（selector 优先级、
 *                                 expansion/deny 合并、ceiling 硬上限）；
 *   buildSubagentToolParameters — 模型可见的扩展参数 Schema 片段。
 *
 * 不变量：
 *   - ceiling.deny 永远优先，任何 selector / additional_tools 都不能恢复；
 *   - 有效工具集 = (profile.allow ∪ 已验证扩权) ∩ ceiling.allow ∩ presetAvailable
 *                 − profile.deny − restrict_tools − ceiling.deny；
 *   - selector 优先级 tool_profile > character_id > task_type > 自动分类 > default；
 *   - 纯模块：不 import dsh-tools、不写文件，可在 .engine 与 host 两侧加载。
 */
import { createOrderedTaskClassifier } from './classify-task.mjs'

/** 解析字符串列表（数组或逗号/空格分隔字符串），非字符串项报错。 */
function stringList(value, path, errors, { allowEmpty = true } = {}) {
  if (value === undefined || value === null) return []
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,\s]+/) : undefined
  if (raw === undefined) {
    errors.push(`${path} must be an array of strings`)
    return []
  }
  const out = []
  for (const item of raw) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      errors.push(`${path} must contain only non-empty strings`)
      continue
    }
    if (!out.includes(item.trim())) out.push(item.trim())
  }
  return out
}

/** 布尔可选字段。 */
function booleanOption(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/** 校验策略；返回错误列表（空 = 合法）。 */
export function validateSubagentToolPolicy(raw) {
  const errors = []
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return ['subagentToolPolicy must be an object']
  }
  const defaultProfile = raw.defaultProfile
  if (typeof defaultProfile !== 'string' || defaultProfile.length === 0) {
    errors.push('subagentToolPolicy.defaultProfile is required')
  }
  const ceiling = raw.ceiling
  if (ceiling === null || typeof ceiling !== 'object' || Array.isArray(ceiling)) {
    errors.push('subagentToolPolicy.ceiling is required')
  }
  const ceilingAllow = ceiling !== null && typeof ceiling === 'object' && !Array.isArray(ceiling)
    ? stringList(ceiling.allow, 'ceiling.allow', errors)
    : []
  if (ceilingAllow.length === 0) errors.push('subagentToolPolicy.ceiling.allow must be a non-empty list')
  const ceilingDeny = ceiling !== null && typeof ceiling === 'object' && !Array.isArray(ceiling)
    ? stringList(ceiling.deny, 'ceiling.deny', errors)
    : []

  const profileIds = new Set()
  const profiles = Array.isArray(raw.profiles) ? raw.profiles : []
  if (profiles.length === 0) errors.push('subagentToolPolicy.profiles must declare at least one profile')
  for (const [index, profile] of profiles.entries()) {
    const path = `profiles[${index}]`
    if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) {
      errors.push(`${path} must be an object`)
      continue
    }
    if (typeof profile.id !== 'string' || profile.id.length === 0) {
      errors.push(`${path}.id is required`)
    } else {
      if (profileIds.has(profile.id)) errors.push(`${path}.id ${JSON.stringify(profile.id)} is duplicated`)
      profileIds.add(profile.id)
    }
    if (typeof profile.name !== 'string' || profile.name.length === 0) {
      errors.push(`${path}.name is required`)
    }
    const allow = stringList(profile.allow, `${path}.allow`, errors)
    const deny = stringList(profile.deny, `${path}.deny`, errors)
    for (const tool of allow) {
      if (!ceilingAllow.includes(tool)) errors.push(`${path}.allow tool ${JSON.stringify(tool)} exceeds ceiling.allow`)
    }
    for (const tool of deny) {
      if (!ceilingAllow.includes(tool)) errors.push(`${path}.deny tool ${JSON.stringify(tool)} is not in ceiling.allow`)
    }
    if (typeof profile.modelSelectable !== 'undefined' && typeof profile.modelSelectable !== 'boolean') {
      errors.push(`${path}.modelSelectable must be a boolean`)
    }
  }

  const characterIds = new Set()
  const characterBindings = Array.isArray(raw.characterBindings) ? raw.characterBindings : []
  for (const [index, binding] of characterBindings.entries()) {
    const path = `characterBindings[${index}]`
    if (binding === null || typeof binding !== 'object' || Array.isArray(binding)) {
      errors.push(`${path} must be an object`)
      continue
    }
    if (typeof binding.characterId !== 'string' || binding.characterId.length === 0) {
      errors.push(`${path}.characterId is required`)
    } else {
      if (characterIds.has(binding.characterId)) errors.push(`${path}.characterId ${JSON.stringify(binding.characterId)} is duplicated`)
      characterIds.add(binding.characterId)
    }
    if (typeof binding.profile !== 'string' || !profileIds.has(binding.profile)) {
      errors.push(`${path}.profile ${JSON.stringify(binding.profile)} must reference an existing profile`)
    }
  }

  const taskIds = new Set()
  const taskRules = Array.isArray(raw.taskRules) ? raw.taskRules : []
  for (const [index, rule] of taskRules.entries()) {
    const path = `taskRules[${index}]`
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
      errors.push(`${path} must be an object`)
      continue
    }
    if (typeof rule.id !== 'string' || rule.id.length === 0) {
      errors.push(`${path}.id is required`)
    } else {
      if (taskIds.has(rule.id)) errors.push(`${path}.id ${JSON.stringify(rule.id)} is duplicated`)
      taskIds.add(rule.id)
    }
    if (typeof rule.pattern !== 'string' || rule.pattern.length === 0) {
      errors.push(`${path}.pattern is required`)
    } else {
      try {
        // 不用全局 g 标志；编译期校验非法正则，非法拒绝整次保存。
        new RegExp(rule.pattern)
      } catch (error) {
        errors.push(`${path}.pattern is not a valid regular expression: ${String(error.message ?? error)}`)
      }
    }
    if (typeof rule.order !== 'number' || !Number.isSafeInteger(rule.order)) {
      errors.push(`${path}.order must be an integer`)
    }
    if (typeof rule.profile !== 'string' || !profileIds.has(rule.profile)) {
      errors.push(`${path}.profile ${JSON.stringify(rule.profile)} must reference an existing profile`)
    }
  }

  const expansion = raw.modelExpansion
  if (expansion !== undefined && expansion !== null) {
    const expansionPath = 'modelExpansion'
    if (typeof expansion !== 'object' || Array.isArray(expansion)) {
      errors.push(`${expansionPath} must be an object`)
    } else {
      const expansionAllow = stringList(expansion.allow, `${expansionPath}.allow`, errors)
      for (const tool of expansionAllow) {
        if (!ceilingAllow.includes(tool)) errors.push(`${expansionPath}.allow tool ${JSON.stringify(tool)} exceeds ceiling.allow`)
      }
      if (expansion.maxAdditionalTools !== undefined
        && (!Number.isSafeInteger(expansion.maxAdditionalTools) || expansion.maxAdditionalTools < 0)) {
        errors.push(`${expansionPath}.maxAdditionalTools must be a non-negative safe integer`)
      }
    }
  }
  if (defaultProfile !== undefined && typeof defaultProfile === 'string' && defaultProfile.length > 0 && !profileIds.has(defaultProfile)) {
    errors.push(`subagentToolPolicy.defaultProfile ${JSON.stringify(defaultProfile)} must reference an existing profile`)
  }
  return errors
}

/** 编译策略：校验通过后归一为运行态结构（Set / 编译正则 / 稳定排序 / 分类器）。 */
export function compileSubagentToolPolicy(raw) {
  const errors = validateSubagentToolPolicy(raw)
  if (errors.length > 0) {
    throw new Error(`invalid subagentToolPolicy: ${errors.join('; ')}`)
  }
  const ceiling = raw.ceiling
  const ceilingAllow = stringList(ceiling.allow, 'ceiling.allow', [])
  const ceilingDeny = stringList(ceiling.deny, 'ceiling.deny', [])
  const profiles = (Array.isArray(raw.profiles) ? raw.profiles : []).map((profile) => ({
    id: profile.id,
    name: profile.name,
    allow: stringList(profile.allow, 'profile.allow', []),
    deny: stringList(profile.deny, 'profile.deny', []),
    modelSelectable: booleanOption(profile.modelSelectable, false),
  }))
  const profileMap = new Map(profiles.map((profile) => [profile.id, profile]))
  const characterBindings = (Array.isArray(raw.characterBindings) ? raw.characterBindings : []).map((binding) => ({
    characterId: binding.characterId,
    profile: binding.profile,
    modelSelectable: booleanOption(binding.modelSelectable, false),
  }))
  const taskRules = (Array.isArray(raw.taskRules) ? raw.taskRules : [])
    .map((rule) => ({
      id: rule.id,
      name: rule.name ?? rule.id,
      pattern: rule.pattern,
      re: new RegExp(rule.pattern),
      profile: rule.profile,
      order: rule.order,
      modelSelectable: booleanOption(rule.modelSelectable, false),
    }))
    .sort((a, b) => (a.order - b.order) || 0)
  const expansionRaw = raw.modelExpansion
  const expansion = {
    enabled: booleanOption(expansionRaw?.enabled, false),
    allow: stringList(expansionRaw?.allow, 'modelExpansion.allow', []),
    maxAdditionalTools: Number.isSafeInteger(expansionRaw?.maxAdditionalTools) ? expansionRaw.maxAdditionalTools : 0,
    requireApproval: booleanOption(expansionRaw?.requireApproval, true),
  }
  return {
    defaultProfileId: raw.defaultProfile,
    ceiling: { allow: ceilingAllow, deny: ceilingDeny },
    profiles,
    profileMap,
    characterBindings,
    taskRules,
    expansion,
    modelSelectableProfiles: profiles.filter((profile) => profile.modelSelectable).map((profile) => profile.id),
    modelSelectableCharacterIds: characterBindings.filter((binding) => binding.modelSelectable).map((binding) => binding.characterId),
    modelSelectableTaskTypes: taskRules.filter((rule) => rule.modelSelectable).map((rule) => rule.id),
    classify: createOrderedTaskClassifier(taskRules),
  }
}

/**
 * 解析一次实例的工具集。request 字段：
 *   tool_profile / character_id / task_type / additional_tools / restrict_tools /
 *   description / prompt（自动分类输入 = description + "\n" + prompt）。
 * availableTools：当前 preset scope 可解析的继承工具名集合。
 */
export function resolveSubagentToolPolicy(compiled, request, availableTools) {
  const requestRecord = request ?? {}
  const presetAvailable = new Set(Array.isArray(availableTools) ? availableTools : [])
  const adopted = []
  const ignored = []

  const explicitProfile = typeof requestRecord.tool_profile === 'string' && requestRecord.tool_profile.length > 0
    ? requestRecord.tool_profile
    : undefined
  const explicitCharacter = typeof requestRecord.character_id === 'string' && requestRecord.character_id.length > 0
    ? requestRecord.character_id
    : undefined
  const explicitTask = typeof requestRecord.task_type === 'string' && requestRecord.task_type.length > 0
    ? requestRecord.task_type
    : undefined

  // 选择基础 profile：tool_profile > character_id 绑定 > task_type > 自动分类 > default。
  let selectedProfileId = compiled.defaultProfileId
  let selectedCharacterId
  let selectedTaskType
  let selected = false
  if (explicitProfile !== undefined) {
    if (compiled.modelSelectableProfiles.includes(explicitProfile)) {
      selectedProfileId = explicitProfile
      adopted.push('tool_profile')
      selected = true
    } else {
      throw new Error(`tool_profile ${JSON.stringify(explicitProfile)} is not model-selectable`)
    }
  }
  if (selected && explicitCharacter !== undefined) ignored.push('character_id')
  if (selected && explicitTask !== undefined) ignored.push('task_type')
  if (!selected && explicitCharacter !== undefined) {
    const binding = compiled.characterBindings.find((item) => item.characterId === explicitCharacter && item.modelSelectable)
    if (binding !== undefined) {
      selectedProfileId = binding.profile
      selectedCharacterId = explicitCharacter
      adopted.push('character_id')
      selected = true
      if (explicitTask !== undefined) ignored.push('task_type')
    } else {
      throw new Error(`character_id ${JSON.stringify(explicitCharacter)} is not model-selectable`)
    }
  }
  if (!selected && explicitTask !== undefined) {
    const rule = compiled.taskRules.find((item) => item.id === explicitTask && item.modelSelectable)
    if (rule !== undefined) {
      selectedProfileId = rule.profile
      selectedTaskType = explicitTask
      adopted.push('task_type')
      selected = true
    } else {
      throw new Error(`task_type ${JSON.stringify(explicitTask)} is not model-selectable`)
    }
  }
  if (!selected) {
    // 未显式选择时按 description + prompt 自动分类。
    const autoText = [requestRecord.description, requestRecord.prompt].filter((item) => typeof item === 'string').join('\n')
    const autoRuleId = compiled.classify(autoText)
    const autoRule = autoRuleId !== undefined ? compiled.taskRules.find((rule) => rule.id === autoRuleId) : undefined
    if (autoRule !== undefined) {
      selectedProfileId = autoRule.profile
      selectedTaskType = autoRuleId
      adopted.push('auto-classify')
    }
  }
  const profile = compiled.profileMap.get(selectedProfileId) ?? compiled.profileMap.get(compiled.defaultProfileId)
  const baseAllow = profile?.allow ?? []

  // 扩权校验：requestedAdd ∩ modelExpansion.allow ∩ ceiling.allow ∩ presetAvailable。
  if (requestRecord.additional_tools !== undefined && !Array.isArray(requestRecord.additional_tools)) {
    throw new Error('additional_tools must be an array of tool names')
  }
  const requestedAdd = Array.isArray(requestRecord.additional_tools) ? requestRecord.additional_tools : []
  if (requestedAdd.some((tool) => typeof tool !== 'string' || tool.length === 0)) {
    throw new Error('additional_tools must contain only non-empty tool names')
  }
  const uniqueRequestedAdd = [...new Set(requestedAdd)]
  if (requestedAdd.length !== uniqueRequestedAdd.length) {
    throw new Error('additional_tools must not contain duplicates')
  }
  if (uniqueRequestedAdd.length > 0 && (!compiled.expansion.enabled || compiled.expansion.maxAdditionalTools === 0)) {
    throw new Error('additional_tools is disabled by subagentToolPolicy')
  }
  if (uniqueRequestedAdd.length > compiled.expansion.maxAdditionalTools) {
    throw new Error(`additional_tools exceeds maxAdditionalTools (${compiled.expansion.maxAdditionalTools})`)
  }
  const validatedAdd = []
  if (uniqueRequestedAdd.length > 0) {
    for (const tool of uniqueRequestedAdd) {
      if (!compiled.expansion.allow.includes(tool)) throw new Error(`additional tool ${JSON.stringify(tool)} is not expansion-authorized`)
      if (!compiled.ceiling.allow.includes(tool)) throw new Error(`additional tool ${JSON.stringify(tool)} exceeds ceiling.allow`)
      if (!presetAvailable.has(tool)) throw new Error(`additional tool ${JSON.stringify(tool)} is not available in this preset`)
      validatedAdd.push(tool)
    }
  }
  if (requestRecord.restrict_tools !== undefined && !Array.isArray(requestRecord.restrict_tools)) {
    throw new Error('restrict_tools must be an array of tool names')
  }
  const requestedDeny = Array.isArray(requestRecord.restrict_tools) ? requestRecord.restrict_tools : []
  if (requestedDeny.some((tool) => typeof tool !== 'string' || tool.length === 0)) {
    throw new Error('restrict_tools must contain only non-empty tool names')
  }

  // 有效工具集 = (baseAllow ∪ validatedAdd) ∩ ceiling.allow ∩ presetAvailable − deny 三件套。
  const effective = new Set([...baseAllow, ...validatedAdd])
  const ceilingAllowSet = new Set(compiled.ceiling.allow)
  const denySet = new Set([...(profile?.deny ?? []), ...requestedDeny, ...compiled.ceiling.deny])
  for (const tool of [...effective]) {
    if (!ceilingAllowSet.has(tool)) effective.delete(tool)
    if (!presetAvailable.has(tool)) effective.delete(tool)
    if (denySet.has(tool)) effective.delete(tool)
  }
  return {
    adopted,
    ignored,
    profileId: selectedProfileId,
    characterId: selectedCharacterId,
    taskType: selectedTaskType,
    additionalTools: validatedAdd,
    effectiveTools: [...effective].sort(),
    requiresApproval: validatedAdd.length > 0 && compiled.expansion.requireApproval,
  }
}

/**
 * 模型可见的扩展参数 Schema 片段（JSON Schema property 映射；未开启能力不出现）。
 * 运行时 shadow 工具把它与官方 subagent 参数合并成完整 parameters。
 */
export function buildSubagentToolParameters(compiled) {
  const properties = {}
  if (compiled.modelSelectableProfiles.length > 0) {
    properties.tool_profile = {
      type: 'string',
      enum: compiled.modelSelectableProfiles,
      description: '子代理工具档（模型可选择的 profile id）',
    }
  }
  if (compiled.modelSelectableCharacterIds.length > 0) {
    properties.character_id = {
      type: 'string',
      enum: compiled.modelSelectableCharacterIds,
      description: '角色卡绑定（模型可选择的 character id）',
    }
  }
  if (compiled.modelSelectableTaskTypes.length > 0) {
    properties.task_type = {
      type: 'string',
      enum: compiled.modelSelectableTaskTypes,
      description: '任务类型（模型可选择的 task rule id）',
    }
  }
  if (compiled.expansion.enabled && compiled.expansion.maxAdditionalTools > 0) {
    const expansionEnum = compiled.expansion.allow.filter((tool) => compiled.ceiling.allow.includes(tool))
    if (expansionEnum.length > 0) {
      properties.additional_tools = {
        type: 'array',
        items: { type: 'string', enum: expansionEnum },
        maxItems: compiled.expansion.maxAdditionalTools,
        description: '模型请求的附加工具（受用户配置上限约束）',
      }
    }
  }
  properties.restrict_tools = {
    type: 'array',
    items: { type: 'string' },
    description: '模型可进一步收紧本实例的工具名列表',
  }
  return properties
}
