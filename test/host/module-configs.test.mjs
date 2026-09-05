import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parse as parseYaml } from 'yaml'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 隔离 DSH_HOME：真实用户同名预设会遮蔽包内模板。
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'pt-mc-home-'))
const { buildCordis } = await import('../../lib/preset-core.mjs')
const { applyModuleConfigs, loadPresetSpec, renderComposition, resolvePresetDir, resolvePresetParams } = await import('../../lib/index.mjs')

/** 递归收集指定 id 的嵌套行（delegation 组内工具行）。 */
function findAllNested(rows, idSet) {
  const found = []
  const walk = (items) => {
    for (const item of Array.isArray(items) ? items : []) {
      if (item === null || typeof item !== 'object') continue
      if (idSet.has(item.id)) found.push(item)
      walk(item.config)
    }
  }
  walk(rows)
  return found
}

const RAW = `# module: custom-bash
- id: custom-bash
  name: ./engine/custom-bash.mjs
  config:
    timeoutMs: 120000
    maxOutputBytes: 64000
- id: router-first-turn
  name: ./engine/router-first-turn.mjs
  config:
    mainPersona: "__MAIN_PERSONA__"
    hideSectionPrefixes: ["mnemon:"]
`

test('moduleConfigs 覆盖声明模块的行级 config（未覆盖键保留）', () => {
  const out = applyModuleConfigs(RAW, { 'custom-bash': { timeoutMs: 180000 } })
  assert.ok(out.includes('timeoutMs: 180000'))
  assert.ok(!out.includes('timeoutMs: 120000'))
  assert.ok(out.includes('maxOutputBytes: 64000'))
})

test('moduleConfigs 不影响未声明模块与 __TOKEN__', () => {
  const out = applyModuleConfigs(RAW, { 'custom-bash': { timeoutMs: 180000 } })
  const rows = parseYaml(out)
  const router = rows.find((row) => row?.id === 'router-first-turn')
  assert.ok(router)
  assert.deepEqual(router.config.hideSectionPrefixes, ['mnemon:'])
  assert.equal(router.config.mainPersona, '__MAIN_PERSONA__')
})

test('moduleConfigs 未声明时返回原文（零开销）', () => {
  assert.equal(applyModuleConfigs(RAW, undefined), RAW)
  assert.equal(applyModuleConfigs(RAW, {}), RAW)
})

test('resolvePresetParams 模型路由/委派参数全扁平（preset.yml params 与运行时扁平键等价）', () => {
  const flat = resolvePresetParams({ id: 't', params: { modelProvider: 'deepseek', modelName: 'deepseek-v4-flash-7013', toolFilterAllow: ['read', 'glob'], toolFilterDeny: ['bash'], maxDepth: 2 } }, {})
  assert.equal(flat.modelProvider, 'deepseek')
  assert.equal(flat.modelName, 'deepseek-v4-flash-7013')
  assert.deepEqual(flat.toolFilterAllow, ['read', 'glob'])
  assert.deepEqual(flat.toolFilterDeny, ['bash'])
  assert.equal(flat.maxDepth, 2)
  // 运行时扁平键优先于 preset.yml 默认值。
  const overridden = resolvePresetParams({ id: 't', params: { modelProvider: 'preset-default', modelName: 'm1' } }, { modelProvider: 'runtime-wins' })
  assert.equal(overridden.modelProvider, 'runtime-wins')
  assert.equal(overridden.modelName, 'm1')
  // 空默认值不渲染（renderEngineTokens 对空串/空数组跳过）。
  const empty = resolvePresetParams({ id: 't', params: { modelProvider: '', modelName: '', toolFilterAllow: [], toolFilterDeny: [], maxDepth: '' } }, {})
  assert.equal(empty.modelProvider, '')
  assert.deepEqual(empty.toolFilterAllow, [])
  assert.equal(empty.maxDepth, '')
})

test('anchored buildCordis 集成：moduleConfigs 合并与 token 渲染共存', () => {
  const rows = parseYaml(buildCordis('P'))
  const bash = rows.find((row) => row?.id === 'custom-bash')
  const gate = rows.find((row) => row?.id === 'context-gate')
  const bootstrap = rows.find((row) => row?.id === 'tool-bootstrap')
  assert.ok(bash && gate && bootstrap, 'agent 组合应含核心行')
  assert.equal(bash.config.timeoutMs, 120000)
  // 人设已模块化：组合不再含 router-first-turn 行（persona 由 promptConfigs 的
  // system-section 模块承担，见 write-preset 测试的 persona-main 断言）。
  assert.equal(rows.some((row) => row?.id === 'router-first-turn'), false, '组合不应含 router-first-turn 行')
  assert.equal(gate.config.promoteOn, 'either')
  assert.deepEqual(gate.config.allowKinds, ['skill-invocation', 'near-anchor', 'router-guide'])
  // 子代理相位两行显式一致（tool-bootstrap 与 context-gate 保持同步）。
  assert.equal(bootstrap.config.includeSubagents, false)
  assert.equal(gate.config.includeSubagents, false)
  assert.ok(!/__[A-Za-z0-9_]+__/.test(buildCordis('P')), '生成文本不应残留未解析 token')
})

test('子代理模型路由与委派完整自定义：toolFilter + maxDepth 渲染（官方 tool-subagent Config）', () => {
  const rows = parseYaml(buildCordis('P', {
    subagentModelProvider: 'my-provider',
    subagentModelName: 'deepseek-v4-flash-7013',
    toolFilterAllow: ['read', 'write', 'glob'],
    toolFilterDeny: 'bash, run_code',
    maxDepth: 1,
  }))
  const subs = findAllNested(rows, new Set(['tool-subagent', 'tool-subagent-fork']))
  assert.equal(subs.length, 2, 'subagent 与 subagent_fork 两行都应渲染')
  for (const row of subs) {
    assert.equal(row.config.agentOptions.provider, 'my-provider')
    assert.equal(row.config.agentOptions.model, 'deepseek-v4-flash-7013')
    assert.deepEqual(row.config.toolFilter, { allow: ['read', 'write', 'glob'], deny: ['bash', 'run_code'] })
    assert.equal(row.config.maxDepth, 1)
  }
})

test('实例策略启用后主过滤不下沉 delegation，模型路由与 maxDepth 转交策略模块', () => {
  const base = loadPresetSpec(resolvePresetDir('minimal'))
  const policy = {
    defaultProfile: 'base', ceiling: { allow: ['read'], deny: [] },
    profiles: [{ id: 'base', name: '基础', allow: ['read'], deny: [], modelSelectable: false }],
  }
  const rows = parseYaml(renderComposition({ ...base, subagentToolPolicy: policy }, {
    subagentModelProvider: 'deepseek', subagentModelName: 'child',
    subagentReasoningEffort: 'high', subagentMaxTokens: '4096',
    toolFilterAllow: ['read'], toolFilterDeny: ['bash'], maxDepth: 2,
  }))
  const policyRow = rows.find((row) => row?.id === 'subagent-tool-policy')
  assert.ok(policyRow, '策略段非空时自动装配模块')
  assert.deepEqual(policyRow.config.agentOptions, { provider: 'deepseek', model: 'child', reasoningEffort: 'high', maxTokens: 4096 })
  assert.equal(policyRow.config.maxDepth, 2)
  const subs = findAllNested(rows, new Set(['tool-subagent', 'tool-subagent-fork']))
  assert.ok(subs.every((row) => row.config.toolFilter === undefined), '旧主过滤不再写入官方 delegation')
})

test('buildCordis 透传 allowKinds 覆盖模板默认', () => {
  const rows = parseYaml(buildCordis('P', { allowKinds: ['skill-invocation'] }))
  const gate = rows.find((row) => row?.id === 'context-gate')
  assert.ok(gate)
  assert.deepEqual(gate.config.allowKinds, ['skill-invocation'])
  // 未传时用 preset.yml 模板默认（anchored allowKinds 白名单）。
  const defaults = parseYaml(buildCordis('P'))
  const defaultGate = defaults.find((row) => row?.id === 'context-gate')
  assert.deepEqual(defaultGate.config.allowKinds, ['skill-invocation', 'near-anchor', 'router-guide'])
})

test('参数桥：anchor-turn / deliberation-gate / cot-drip 行级配置映射', () => {
  const rows = parseYaml(buildCordis('P', {
    anchorTurn: true,
    anchorTurnText: '你是谁',
    deliberationGate: true,
    deliberationMinChars: 600,
    deliberationMaxGatesPerTurn: 2,
    cotDrip: true,
    cotDripEvery: 3,
    cotDripMaxPerTurn: 2,
  }))
  const anchor = rows.find((row) => row?.id === 'anchor-turn')
  assert.ok(anchor, '应含 anchor-turn 行')
  assert.equal(anchor.config.enabled, true)
  assert.equal(anchor.config.text, '你是谁')

  const gate = rows.find((row) => row?.id === 'deliberation-gate')
  assert.ok(gate, '应含 deliberation-gate 行')
  assert.equal(gate.config.enabled, true)
  assert.equal(gate.config.minChars, 600)
  assert.equal(gate.config.maxGatesPerTurn, 2)

  const drip = rows.find((row) => row?.id === 'cot-drip')
  assert.ok(drip, '应含 cot-drip 行')
  assert.equal(drip.config.enabled, true)
  assert.equal(drip.config.every, 3)
  assert.equal(drip.config.maxPerTurn, 2)

  // 关闭：enabled: false；数字 0 = 回落行默认（不写键）。
  const off = parseYaml(buildCordis('P', { anchorTurn: false, deliberationGate: false, cotDrip: false, deliberationMinChars: 0, cotDripEvery: 0 }))
  assert.equal(off.find((row) => row?.id === 'anchor-turn').config.enabled, false)
  assert.equal(off.find((row) => row?.id === 'deliberation-gate').config.enabled, false)
  assert.equal(off.find((row) => row?.id === 'cot-drip').config.enabled, false)
  assert.equal(off.find((row) => row?.id === 'deliberation-gate').config.minChars, 400, '0 不写键 → 回落行默认 400')
  assert.equal(off.find((row) => row?.id === 'cot-drip').config.every, 4, '0 不写键 → 回落行默认 4')
})

test('参数桥：门控/状态机扁平键直达模块行 config（不 token 化）', () => {
  const rows = parseYaml(buildCordis('P', {
    promoteGate: true,
    maxPromoteSteps: 6,
    promoteAfterFirstResponse: true,
    messageSources: ['user', 'goal'],
    deferredSources: ['agent-instructions'],
    deferredGraceSteps: 2,
    instructionHint: true,
    personaSectionsOnly: true,
    workspaceLine: true,
    compactionTools: ['read', 'write'],
    bootstrapMaxTokens: 2048,
    usePtcMode: false,
  }))
  const bootstrap = rows.find((row) => row?.id === 'tool-bootstrap')
  assert.equal(bootstrap.config.promoteGate, true)
  assert.equal(bootstrap.config.maxPromoteSteps, 6)
  assert.equal(bootstrap.config.promoteAfterFirstResponse, true)
  assert.equal(bootstrap.config.personaSectionsOnly, true)
  assert.equal(bootstrap.config.workspaceLine, true)
  assert.equal(bootstrap.config.bootstrapMaxTokens, 2048)
  assert.deepEqual(bootstrap.config.compactionTools, ['read', 'write'])
  const gate = rows.find((row) => row?.id === 'context-gate')
  assert.deepEqual(gate.config.messageSources, ['user', 'goal'])
  assert.deepEqual(gate.config.deferredSources, ['agent-instructions'])
  assert.equal(gate.config.deferredGraceSteps, 2)
  assert.equal(gate.config.instructionHint, true)
  const presentation = rows.find((row) => row?.id === 'code-presentation')
  assert.equal(presentation.config.usePtcMode, false, 'usePtcMode=false 直达 code-presentation 行')
  // 未声明的门控键不合并（行默认 / 引擎默认生效）。
  const defaults = parseYaml(buildCordis('P'))
  const defaultBootstrap = defaults.find((row) => row?.id === 'tool-bootstrap')
  assert.equal(defaultBootstrap.config.promoteGate, undefined, '未声明不合并')
  assert.equal(defaultBootstrap.config.bootstrapMaxTokens, undefined, 'bootstrapMaxTokens 0/未声明不合并')
})

test('参数桥完整性：本地模块行 config 键 ⊆ ALLOWED_KEYS；stageAdvanceDescription 桥接落点', () => {
  // 镜像 engine/*.mjs 的 ALLOWED_KEYS（本地模块；官方模块行不在此列）。
  const ALLOWED = {
    'tool-bootstrap': new Set(['bootstrapTools', 'promoteOn', 'bootstrapMaxTokens', 'compactionTools',
      'includeSubagents', 'promoteGate', 'maxPromoteSteps', 'promoteAfterFirstResponse',
      'personaSectionsOnly', 'workspaceLine', 'phase1FirstCallInstruction',
      'stages', 'stagePreUnlock', 'stageAdvanceTool', 'stageAdvanceDescription', 'stageSectionTemplate']),
    'context-gate': new Set(['promoteOn', 'includeSubagents', 'enabled', 'allowKinds',
      'messageSources', 'deferredSources', 'deferredGraceSteps', 'instructionHint']),
    'code-presentation': new Set(['usePtcMode', 'includeSubagents', 'promoteOn']),
    'tool-filter': new Set(['allow', 'deny', 'includeSubagents', 'enabled']),
  }
  const rows = parseYaml(buildCordis('P', {
    stages: [{ name: '了解', tools: ['read', 'glob'] }],
    stagePreUnlock: 1,
    stageAdvanceTool: 'phase_advance',
    stageAdvanceDescription: '推进到下一阶段（解锁更多工具）',
    stageSectionTemplate: 'Stage {{stageName}}',
    promoteGate: true,
    maxPromoteSteps: 6,
    promoteAfterFirstResponse: true,
    messageSources: ['user', 'goal'],
    deferredSources: ['agent-instructions'],
    deferredGraceSteps: 2,
    instructionHint: true,
    personaSectionsOnly: true,
    workspaceLine: true,
    compactionTools: ['read', 'write'],
    bootstrapMaxTokens: 2048,
    usePtcMode: true,
    toolFilterAllow: ['read'],
    toolFilterDeny: ['bash'],
    toolFilterSubagents: true,
  }))
  for (const [module, allow] of Object.entries(ALLOWED)) {
    const row = rows.find((r) => r?.id === module)
    if (row === undefined) continue // 未挂载模块（anchored modules 无此行）
    for (const key of Object.keys(row.config ?? {})) {
      assert.ok(allow.has(key), `${module} 行 config 键 ${key} 必须在 ALLOWED_KEYS 中（参数桥漏注册或行默认漂移）`)
    }
  }
  const bootstrap = rows.find((r) => r?.id === 'tool-bootstrap')
  assert.equal(bootstrap.config.stageAdvanceDescription, '推进到下一阶段（解锁更多工具）', 'stageAdvanceDescription 经参数桥直达 tool-bootstrap 行')
})

test('参数桥优先于 moduleConfigs 直写：UI 开关不被行级直写覆盖（旧作者锁定语义移除）', () => {
  const spec = loadPresetSpec(resolvePresetDir('anchored'))
  // 模拟模板/ST 直写 tool-filter.includeSubagents（旧锁定语义会覆盖 UI，导致开关失效）。
  const withDirect = { ...spec, moduleConfigs: { 'tool-filter': { includeSubagents: false } } }
  // 1) 参数桥打开 toolFilterSubagents → 桥优先，直写不覆盖。
  const rows = parseYaml(renderComposition(withDirect, { toolFilterSubagents: true }))
  const tf = rows.find((r) => r?.id === 'tool-filter')
  assert.equal(tf.config.includeSubagents, true, '参数桥（UI）优先于 moduleConfigs 直写，开关必须生效')
  // 2) 参数桥未设置 → moduleConfigs 直写仍生效（桥未覆盖的键照常合并）。
  const rows2 = parseYaml(renderComposition(withDirect, {}))
  const tf2 = rows2.find((r) => r?.id === 'tool-filter')
  assert.equal(tf2.config.includeSubagents, false, '桥未覆盖时 moduleConfigs 直写生效')
})

test('空白预设的 dormant moduleConfigs 不会隐式装配引擎能力', () => {
  const base = loadPresetSpec(resolvePresetDir('custom'))
  const spec = {
    ...base,
    moduleConfigs: {
      'tool-bootstrap': { promoteGate: true, maxPromoteSteps: 4 },
      'code-presentation': { usePtcMode: true },
    },
  }
  const rows = parseYaml(renderComposition(spec, {}))
  assert.deepEqual(rows, [], '只有 modules 显式声明才允许装配能力')
})
