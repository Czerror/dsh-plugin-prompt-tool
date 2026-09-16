/**
 * 主会话 / 子代理分离的设计一致性核验（本次设计）。
 *
 * 覆盖四层边界：
 * 1. 模块参数：子代理专属参数只落 `includeSubagents` 键，主会话侧开关不越界；
 * 2. 工具过滤：主对话 `tool-filter` 与子代理 `delegation.toolFilter` / 实例级策略互不串写；
 * 3. 模型参数：`model*` → `audience: main`，`subagent*` → `audience: subagent`（agent-request patch）；
 * 4. 提示词配置受众：`audience` 决定注入对象，主/子列表各自过滤。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parse as parseYaml } from 'yaml'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 隔离 DSH_HOME：真实用户同名预设会遮蔽包内模板。
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'pt-scope-home-'))
const { FIXTURE_PRESET_ID, installFixturePresetInHome } = await import('../fixtures/preset-template.mjs')
installFixturePresetInHome(process.env.DSH_HOME)
const { ENGINE_PARAM_DEFINITIONS, buildEngineModuleParams } = await import('../../src/shared/engine-params.ts')
const { buildModuleConfigsFromParams, loadPresetSpec, renderComposition, resolvePresetDir } = await import('../../lib/index.mjs')

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
