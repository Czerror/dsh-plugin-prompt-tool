// 合并自 module-configs.test.mjs(15) + param-contract.test.mjs(4) + scope-separation-audit.test.mjs(5)
//（2026-09-17 测试归一精简 Wave 2）：三者都是「预设参数 → 组合行 config」这一条链路的核验，
//  顶层 DSH_HOME 样板按 harness 统一为一份（见 isolatedHome），两份逐字相同的 findAllNested 合并为一份。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parse as parseYaml } from 'yaml'
import { isolatedHome } from '../fixtures/host-harness.mjs'

// 隔离 DSH_HOME：真实用户同名预设会遮蔽包内模板；harness 负责设置与 after() 还原。
const { home } = isolatedHome('pt-params-bridge-')
const { FIXTURE_PRESET_ID, installFixturePresetInHome } = await import('../fixtures/preset-template.mjs')
// 夹具装进隔离 DSH_HOME 的官方预设根：本文件用「夹具模板 + renderComposition」替代已下线的 buildCordis 兼容层。
installFixturePresetInHome(home)
const { ENGINE_PARAM_DEFINITIONS, buildEngineModuleParams } = await import('../../src/shared/engine-params.ts')
const {
  ENGINE_PARAM_KEYS,
  WRITER_PARAM_KEYS,
  PARAM_KEYS,
  MODEL_SEGMENT_MAP,
  applyModuleConfigs,
  buildModuleConfigsFromParams,
  loadPresetSpec,
  renderComposition,
  resolvePresetDir,
  resolvePresetParams,
} = await import('../../lib/index.mjs')

/** 用测试夹具模板渲染组合（等价于旧的 buildCordis：模板 spec + 运行时参数）。 */
function fixtureComposition(runtime = {}) {
  const dir = resolvePresetDir(FIXTURE_PRESET_ID)
  return renderComposition(loadPresetSpec(dir), runtime, dir)
}

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

const RAW = `# module: tool-git-bash
- id: tool-git-bash
  name: ./engine/tool-git-bash.mjs
  config:
    timeoutMs: 120000
    maxOutputBytes: 64000
- id: router-first-turn
  name: ./engine/router-first-turn.mjs
  config:
    mainPersona: "__MAIN_PERSONA__"
    hideSectionPrefixes: ["mnemon:"]
`

// —— moduleConfigs 合并与参数桥（原 module-configs.test.mjs） ——

test('moduleConfigs 覆盖声明模块的行级 config（未覆盖键保留）', () => {
  const out = applyModuleConfigs(RAW, { 'tool-git-bash': { timeoutMs: 180000 } })
  assert.ok(out.includes('timeoutMs: 180000'))
  assert.ok(!out.includes('timeoutMs: 120000'))
  assert.ok(out.includes('maxOutputBytes: 64000'))
})

test('moduleConfigs 不影响未声明模块与 __TOKEN__', () => {
  const out = applyModuleConfigs(RAW, { 'tool-git-bash': { timeoutMs: 180000 } })
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

test('夹具模板组合集成：moduleConfigs 合并与 token 渲染共存', () => {
  const rows = parseYaml(fixtureComposition())
  const bash = rows.find((row) => row?.id === 'tool-git-bash')
  const gate = rows.find((row) => row?.id === 'context-gate')
  const bootstrap = rows.find((row) => row?.id === 'tool-bootstrap')
  assert.ok(bash && gate && bootstrap, 'agent 组合应含核心行')
  assert.equal(bash.config.timeoutMs, 120000)
  // 人设已迁到顶层 persona 段：组合不再含 router-first-turn 行，persona 行由
  // renderComposition 自动前插（见 write-preset 测试的顶层 persona 断言）。
  assert.equal(rows.some((row) => row?.id === 'router-first-turn'), false, '组合不应含 router-first-turn 行')
  assert.equal(gate.config.promoteOn, 'either')
  assert.deepEqual(gate.config.allowKinds, ['skill-invocation', 'near-anchor', 'router-guide'])
  // 子代理相位两行显式一致（tool-bootstrap 与 context-gate 保持同步）。
  assert.equal(bootstrap.config.includeSubagents, false)
  assert.equal(gate.config.includeSubagents, false)
  assert.ok(!/__[A-Za-z0-9_]+__/.test(fixtureComposition()), '生成文本不应残留未解析 token')
})

test('子代理模型路由与委派完整自定义：toolFilter + maxDepth 渲染（官方 tool-subagent Config）', () => {
  const rows = parseYaml(fixtureComposition({
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

test('参数桥透传 allowKinds 覆盖模板默认', () => {
  const rows = parseYaml(fixtureComposition({ allowKinds: ['skill-invocation'] }))
  const gate = rows.find((row) => row?.id === 'context-gate')
  assert.ok(gate)
  assert.deepEqual(gate.config.allowKinds, ['skill-invocation'])
  // 未传时用 preset.yml 模板默认（夹具模板 allowKinds 白名单）。
  const defaults = parseYaml(fixtureComposition())
  const defaultGate = defaults.find((row) => row?.id === 'context-gate')
  assert.deepEqual(defaultGate.config.allowKinds, ['skill-invocation', 'near-anchor', 'router-guide'])
})

test('参数桥：anchor-turn / deliberation-gate / progress-reminder 行级配置映射', () => {
  const rows = parseYaml(fixtureComposition({
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

  const drip = rows.find((row) => row?.id === 'progress-reminder')
  assert.ok(drip, '应含 progress-reminder 行')
  assert.equal(drip.config.enabled, true)
  assert.equal(drip.config.every, 3)
  assert.equal(drip.config.maxPerTurn, 2)

  // 关闭开关与显式零值独立保留，重新启用后仍使用零值而非行默认。
  const off = parseYaml(fixtureComposition({ anchorTurn: false, deliberationGate: false, cotDrip: false, deliberationMinChars: 0, cotDripEvery: 0 }))
  assert.equal(off.find((row) => row?.id === 'anchor-turn').config.enabled, false)
  assert.equal(off.find((row) => row?.id === 'deliberation-gate').config.enabled, false)
  assert.equal(off.find((row) => row?.id === 'progress-reminder').config.enabled, false)
  assert.equal(off.find((row) => row?.id === 'deliberation-gate').config.minChars, 0, '0 取消深思下限')
  assert.equal(off.find((row) => row?.id === 'progress-reminder').config.every, 0, '0 禁用滴入')
})

test('参数桥：门控/状态机扁平键直达模块行 config（不 token 化）', () => {
  const rows = parseYaml(fixtureComposition({
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
  const presentation = rows.find((row) => row?.id === 'promoted-code-mode')
  assert.equal(presentation.config.usePtcMode, false, 'usePtcMode=false 直达 promoted-code-mode 行')
  // 未声明的门控键不合并（行默认 / 引擎默认生效）。
  const defaults = parseYaml(fixtureComposition())
  const defaultBootstrap = defaults.find((row) => row?.id === 'tool-bootstrap')
  assert.equal(defaultBootstrap.config.promoteGate, undefined, '未声明不合并')
  assert.equal(defaultBootstrap.config.bootstrapMaxTokens, undefined, 'bootstrapMaxTokens 0/未声明不合并')
})

test('关闭首轮输出封顶清除行默认/moduleConfigs 限额，不破坏其他配置', () => {
  const spec = { id: 'cap-off', modules: ['tool-bootstrap'], params: { bootstrapMaxTokens: 0 },
    moduleConfigs: { 'tool-bootstrap': { bootstrapMaxTokens: 1024, workspaceLine: true } } }
  const rows = parseYaml(renderComposition(spec, {}))
  const config = rows.find((row) => row.id === 'tool-bootstrap').config
  assert.equal(Object.hasOwn(config, 'bootstrapMaxTokens'), false)
  assert.equal(config.workspaceLine, true)
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
    'promoted-code-mode': new Set(['usePtcMode', 'includeSubagents', 'promoteOn']),
    'tool-filter': new Set(['allow', 'deny', 'enabled']),
  }
  const rows = parseYaml(fixtureComposition({
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
  }))
  for (const [module, allow] of Object.entries(ALLOWED)) {
    const row = rows.find((r) => r?.id === module)
    if (row === undefined) continue // 未挂载模块（夹具 modules 无此行）
    for (const key of Object.keys(row.config ?? {})) {
      assert.ok(allow.has(key), `${module} 行 config 键 ${key} 必须在 ALLOWED_KEYS 中（参数桥漏注册或行默认漂移）`)
    }
  }
  const bootstrap = rows.find((r) => r?.id === 'tool-bootstrap')
  assert.equal(bootstrap.config.stageAdvanceDescription, '推进到下一阶段（解锁更多工具）', 'stageAdvanceDescription 经参数桥直达 tool-bootstrap 行')
})

test('参数桥优先于 moduleConfigs 直写：UI 开关不被行级直写覆盖（旧作者锁定语义移除）', () => {
  const spec = loadPresetSpec(resolvePresetDir(FIXTURE_PRESET_ID))
  // 模拟模板/ST 直写 tool-filter.enabled（旧锁定语义会覆盖 UI，导致开关失效）。
  const withDirect = { ...spec, moduleConfigs: { 'tool-filter': { enabled: true } } }
  // 1) 参数桥关闭工具过滤 → 桥优先，直写不覆盖。
  const rows = parseYaml(renderComposition(withDirect, { toolFilterEnabled: false }))
  const tf = rows.find((r) => r?.id === 'tool-filter')
  assert.equal(tf.config.enabled, false, '参数桥（UI）优先于 moduleConfigs 直写，开关必须生效')
  // 2) 参数桥未设置 → moduleConfigs 直写仍生效（桥未覆盖的键照常合并）。
  const rows2 = parseYaml(renderComposition(withDirect, {}))
  const tf2 = rows2.find((r) => r?.id === 'tool-filter')
  assert.equal(tf2.config.enabled, true, '桥未覆盖时 moduleConfigs 直写生效')
})

test('空白预设的 dormant moduleConfigs 不会隐式装配引擎能力', () => {
  const base = loadPresetSpec(resolvePresetDir('custom'))
  const spec = {
    ...base,
    moduleConfigs: {
      'tool-bootstrap': { promoteGate: true, maxPromoteSteps: 4 },
      'promoted-code-mode': { usePtcMode: true },
    },
  }
  const rows = parseYaml(renderComposition(spec, {}))
  assert.deepEqual(rows, [], '只有 modules 显式声明才允许装配能力')
})

test('显式零值穿过组合默认与直写配置后仍禁用节拍、取消深思下限', async () => {
  const { apply: applyDrip } = await import('../../engine/progress-reminder.mjs')
  const { apply: applyGate } = await import('../../engine/deliberation-gate.mjs')
  const rows = parseYaml(renderComposition({
    id: 'zero', modules: ['progress-reminder', 'deliberation-gate'],
    moduleConfigs: { 'progress-reminder': { every: 2 }, 'deliberation-gate': { minChars: 200 } },
    params: { cotDrip: true, cotDripEvery: 0, cotDripSubagents: true,
      deliberationGate: true, deliberationMinChars: 0, deliberationSubagents: true },
  }, {}))
  const listeners = new Map()
  const ctx = { on: (event, callback) => { listeners.set(event, callback) } }
  applyDrip(ctx, rows.find(row => row.id === 'progress-reminder').config)
  applyGate(ctx, rows.find(row => row.id === 'deliberation-gate').config)
  for (const delegationDepth of [0, 1]) {
    const exec = { agent: { session: { id: `zero-${delegationDepth}`, header: { delegationDepth }, events: [] } } }
    for (let i = 0; i < 4; i += 1) {
      const post = await listeners.get('tools/post-execute')(exec, {}, async () => ({ kind: 'accept' }))
      assert.equal(post.additionalContexts, undefined)
      const pre = listeners.get('tools/pre-execute')(exec, () => ({ kind: 'accept' }))
      assert.equal(pre.kind, 'accept')
    }
  }
})

// —— 参数目录与桥接契约（原 param-contract.test.mjs） ——

/** 非 writer 键的合法样本值（类型与引擎消费一致；键缺失时测试报「无装配消费」）。 */
const BRIDGE_SAMPLES = {
  promoteGate: true,
  promoteAfterFirstResponse: true,
  maxPromoteSteps: 5,
  bootstrapTools: ['bash'],
  compactionTools: ['read'],
  personaSectionsOnly: true,
  workspaceLine: true,
  phase1FirstCallInstruction: 'x',
  messageSources: ['user'],
  deferredSources: ['skill-catalog'],
  deferredGraceSteps: 1,
  instructionHint: true,
  stages: [{ name: 's', tools: ['t'] }],
  stagePreUnlock: 2,
  stageAdvanceTool: 'x',
  stageAdvanceDescription: 'x',
  stageSectionTemplate: 'x',
  strReplaceEditorMaxOutputChars: 20000,
  anchorTurn: true,
  anchorTurnText: 'x',
  deliberationGate: true,
  deliberationMinChars: 500,
  deliberationMaxGatesPerTurn: 2,
  cotDrip: true,
  cotDripEvery: 3,
  cotDripMaxPerTurn: 2,
  bootstrapSubagents: true,
  bootstrapPromoteOn: 'tool-call',
  contextGateEnabled: false,
  contextGateSubagents: true,
  contextGatePromoteOn: 'assistant-message',
  ptcSubagents: true,
  ptcPromoteOn: 'either',
  toolFilterEnabled: false,
  anchorTurnSubagents: true,
  deliberationSubagents: true,
  deliberationGateText: '深思提示',
  cotDripSubagents: true,
  cotDripText: '保持思考',
  customToolRequireApproval: ['shell', 'fs'],
}

test('PARAM_KEYS 派生一致性：= ENGINE_PARAM_KEYS + 锚定内容键 + promptConfigs', () => {
  const EXTRA = new Set(['buildPattern', 'complexPattern', 'firstTurnBuild', 'firstTurnInspect', 'firstTurnDeep',
    'guideWeak', 'guideDeep', 'promptConfigs'])
  const engineKeys = new Set(ENGINE_PARAM_KEYS)
  for (const key of PARAM_KEYS) {
    assert.ok(engineKeys.has(key) || EXTRA.has(key), `${key} 应属于 ENGINE_PARAM_KEYS 或附加键`)
  }
  for (const key of ENGINE_PARAM_KEYS) {
    assert.ok(PARAM_KEYS.has(key), `${key} 应从 ENGINE_PARAM_KEYS 派生进 PARAM_KEYS`)
  }
  for (const key of EXTRA) {
    assert.ok(PARAM_KEYS.has(key), `${key} 附加键应存在`)
  }
  // 无重复。
  assert.equal(PARAM_KEYS.size, ENGINE_PARAM_KEYS.length + EXTRA.size, 'PARAM_KEYS 无重复键')
})

test('ENGINE_PARAM_KEYS 每个非 writer 键都有参数桥装配消费（防「加键没装配」）', () => {
  const writerKeys = new Set(WRITER_PARAM_KEYS)
  const bridgeConsumed = new Set(Object.keys(buildModuleConfigsFromParams({})))
  for (const key of ENGINE_PARAM_KEYS) {
    if (writerKeys.has(key)) continue // writePreset.runtimeOf 透传（模型 patch / prompt-injector 等）。
    assert.ok(BRIDGE_SAMPLES[key] !== undefined, `${key} 缺测试样本值`)
    const configs = buildModuleConfigsFromParams({ [key]: BRIDGE_SAMPLES[key] })
    assert.ok(Object.keys(configs).length > 0, `${key} 应被参数桥消费（产出组合行 config）`)
    for (const id of Object.keys(configs)) bridgeConsumed.add(id)
  }
  const allConfigs = buildModuleConfigsFromParams(BRIDGE_SAMPLES)
  assert.ok(Object.hasOwn(allConfigs, 'tool-bootstrap') && Object.hasOwn(allConfigs, 'context-gate'),
    '参数桥应覆盖核心引擎行；writer 参数仍需由 runtimeOf 透传')
})

test('MODEL_SEGMENT_MAP 双向一致：展平读回 = 保存写回（段目标唯一）', () => {
  const targets = new Set()
  for (const [flatKey, [segment, segmentKey]] of Object.entries(MODEL_SEGMENT_MAP)) {
    assert.ok(flatKey.length > 0 && segment.length > 0 && segmentKey.length > 0, `映射项非空: ${flatKey}`)
    const target = `${segment}.${segmentKey}`
    assert.ok(!targets.has(target), `段目标重复: ${target}（两个扁平键映射到同一段键）`)
    targets.add(target)
  }
  assert.equal(Object.keys(MODEL_SEGMENT_MAP).length, 10, '模型段映射应覆盖 10 个扁平键')
})

test('字符串深度与数字同义，普通委派及实例策略均接收归一后的限制', () => {
  for (const value of [0, 2, 'provider-managed']) {
    for (const subagentPolicyEnabled of [false, true]) {
      const options = { subagentPolicyEnabled }
      const configs = buildModuleConfigsFromParams({ maxDepth: String(value) }, options)
      assert.deepEqual(configs, buildModuleConfigsFromParams({ maxDepth: value }, options))
      for (const id of ['tool-subagent', 'tool-subagent-fork', ...(subagentPolicyEnabled ? ['subagent-tool-policy'] : [])]) {
        assert.equal(configs[id].maxDepth, value)
      }
    }
  }
  for (const maxDepth of ['', ' ', 'invalid', '-1', '1.5']) {
    assert.equal(buildModuleConfigsFromParams({ maxDepth })['tool-subagent'], undefined)
  }
})

// —— 主/子代理分离的设计一致性（原 scope-separation-audit.test.mjs） ——
// 覆盖四层边界：
// 1. 模块参数：子代理专属参数只落 `includeSubagents` 键，主会话侧开关不越界；
// 2. 工具过滤：主对话 `tool-filter` 与子代理 `delegation.toolFilter` / 实例级策略互不串写；
// 3. 模型参数：`model*` → `audience: main`，`subagent*` → `audience: subagent`（agent-request patch）；
// 4. 提示词配置受众：`audience` 决定注入对象，主/子列表各自过滤。

test('模块参数按行落位：子代理参与类参数只写 includeSubagents，且不污染无关键', () => {
  const configs = buildEngineModuleParams({
    bootstrapSubagents: true,
    contextGateSubagents: true,
    ptcSubagents: true,
    anchorTurnSubagents: true,
    deliberationSubagents: true,
    cotDripSubagents: true,
    toolFilterEnabled: false,
    toolFilterAllow: ['read'],
    toolFilterDeny: ['bash'],
  })
  // 每个「参与」开关只落在自己那一行的 includeSubagents 键上。
  assert.deepEqual(configs['tool-bootstrap'].includeSubagents, true)
  assert.deepEqual(configs['context-gate'].includeSubagents, true)
  assert.deepEqual(configs['promoted-code-mode'].includeSubagents, true)
  assert.deepEqual(configs['anchor-turn'].includeSubagents, true)
  assert.deepEqual(configs['deliberation-gate'].includeSubagents, true)
  assert.deepEqual(configs['progress-reminder'].includeSubagents, true)
  // 工具过滤行：只剩总开关与白/黑名单，不再有 includeSubagents 绑定。
  assert.deepEqual(Object.keys(configs['tool-filter']).sort(), ['allow', 'deny', 'enabled'])
  assert.equal(configs['tool-filter'].enabled, false)
  // 交叉污染检查：只有声明了子代理参与开关的行才有 includeSubagents，其余行不得出现。
  const subagentAware = new Set(['tool-bootstrap', 'context-gate', 'promoted-code-mode', 'anchor-turn', 'deliberation-gate', 'progress-reminder'])
  for (const [module, config] of Object.entries(configs)) {
    if (subagentAware.has(module)) {
      assert.equal(config.includeSubagents, true, `${module} 的 includeSubagents 来自自身开关`)
      continue
    }
    assert.equal(Object.hasOwn(config, 'includeSubagents'), false, `${module} 不应出现 includeSubagents`)
  }
})

test('参数目录层面：主/子代理专属参数绑定到不同行，工具过滤不再有子代理绑定', () => {
  const bindingsOf = (card) => Object.entries(ENGINE_PARAM_DEFINITIONS)
    .filter(([, definition]) => definition.card === card)
    .map(([key]) => key)
    .sort()
  assert.deepEqual(bindingsOf('main-model'), ['modelMaxTokens', 'modelName', 'modelProvider', 'modelReasoningEffort', 'modelTemperature'])
  assert.deepEqual(bindingsOf('subagent-model'), ['subagentMaxTokens', 'subagentModelName', 'subagentModelProvider', 'subagentReasoningEffort', 'subagentTemperature'])
  assert.deepEqual(bindingsOf('tool-filter'), ['toolFilterAllow', 'toolFilterDeny', 'toolFilterEnabled'])
  assert.deepEqual(bindingsOf('subagent-tools'), ['maxDepth'])
  // 主/子模型参数一一对称且零交集（预设顶层 model / subagentModel 两段是唯一来源）。
  const mainModel = new Set(bindingsOf('main-model'))
  for (const key of bindingsOf('subagent-model')) assert.equal(mainModel.has(key), false, `${key} 不得同时属于主与子`)
})

test('工具过滤落位：策略启用后主对话过滤不下发给子代理，子代理由实例级策略授权', () => {
  const params = { toolFilterAllow: ['read', 'write'], toolFilterDeny: ['bash'], maxDepth: 2 }
  const mainFilter = { allow: ['read', 'write'], deny: ['bash'] }
  // 未启用实例级策略：主对话过滤同时写入 delegation.toolFilter（兼容旧行为）。
  const legacy = buildModuleConfigsFromParams(params, { subagentPolicyEnabled: false })
  assert.deepEqual(legacy['tool-filter'], mainFilter)
  assert.deepEqual(legacy['tool-subagent'].toolFilter, mainFilter)
  assert.deepEqual(legacy['tool-subagent-fork'].toolFilter, mainFilter)
  // 启用实例级策略：主对话过滤仍然落位，delegation 行不再接收它（授权改由 subagent-tool-policy 解析）。
  const withPolicy = buildModuleConfigsFromParams(params, { subagentPolicyEnabled: true })
  assert.deepEqual(withPolicy['tool-filter'], mainFilter, '主对话过滤仍然落位')
  assert.equal(withPolicy['tool-subagent'].toolFilter, undefined, '策略启用后不得再写 delegation.toolFilter')
  assert.equal(withPolicy['tool-subagent-fork'].toolFilter, undefined)
  assert.equal(withPolicy['tool-subagent'].maxDepth, 2, '与过滤无关的委派参数不受影响')
})

test('组合端到端：子代理专属参数只出现在子代理行为，主对话行保持独立', () => {
  const dir = resolvePresetDir(FIXTURE_PRESET_ID)
  const spec = loadPresetSpec(dir)
  const runtime = {
    toolFilterAllow: ['read'],
    toolFilterDeny: ['bash'],
    toolFilterEnabled: true,
    bootstrapSubagents: true,
    contextGateSubagents: true,
  }
  const rendered = renderComposition(spec, runtime, dir)
  const rows = parseYaml(rendered)
  const toolFilter = rows.find((row) => row?.id === 'tool-filter')
  const bootstrap = rows.find((row) => row?.id === 'tool-bootstrap')
  const gate = rows.find((row) => row?.id === 'context-gate')
  // 主对话过滤行只有主会话语义的键（过滤总开关 + 白/黑名单）。
  assert.deepEqual(Object.keys(toolFilter.config).sort(), ['allow', 'deny', 'enabled'])
  // 子代理参与开关落在各自行，不回流到主对话过滤行。
  assert.equal(bootstrap.config.includeSubagents, true)
  assert.equal(gate.config.includeSubagents, true)
  assert.equal(Object.hasOwn(toolFilter.config, 'includeSubagents'), false)
})

test('实例级工具策略：声明后装配 shadow 行并指向生成目录策略文件，未声明则不装配', () => {
  const dir = resolvePresetDir(FIXTURE_PRESET_ID)
  const base = loadPresetSpec(dir)
  const withPolicy = {
    ...base,
    subagentToolPolicy: {
      defaultProfile: 'reader',
      ceiling: { allow: ['read'], deny: [] },
      profiles: [{ id: 'reader', name: '只读', allow: ['read'], deny: [], modelSelectable: true }],
    },
  }
  const rows = parseYaml(renderComposition(withPolicy, {}, dir))
  const [policyRow] = findAllNested(rows, new Set(['subagent-tool-policy']))
  assert.ok(policyRow, '声明策略后必须装配 subagent-tool-policy 行')
  assert.equal(policyRow.config.policyFile, '../subagent-tools/policy.yml', '策略文件指向生成目录')
  assert.equal(policyRow.config.spawnProvider, 'spawn', 'shadow 覆盖 spawn 工具名')
  assert.equal(policyRow.config.forkProvider, 'fork', 'shadow 覆盖 fork 工具名')
  // 未声明策略时不装配该模块（opt-in），子代理工具面回落到 delegation 行。
  const without = parseYaml(renderComposition(base, {}, dir))
  assert.deepEqual(findAllNested(without, new Set(['subagent-tool-policy'])), [])
  assert.ok(findAllNested(without, new Set(['tool-subagent'])).length > 0, '未启用策略时仍由官方委派行供工具')
})
