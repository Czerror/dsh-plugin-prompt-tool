import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCordis } from '../../lib/preset-core.mjs'
import { applyModuleConfigs, resolvePresetParams } from '../../lib/index.mjs'
import { parse as parseYaml } from 'yaml'

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
  const flat = resolvePresetParams({ id: 't', params: { mainPersona: 'F', modelProvider: 'deepseek', modelName: 'deepseek-v4-flash-7013', subagentPersona: '子代理路由人设', toolFilterAllow: ['read', 'glob'], toolFilterDeny: ['bash'], maxDepth: 2 } }, {})
  assert.equal(flat.modelProvider, 'deepseek')
  assert.equal(flat.modelName, 'deepseek-v4-flash-7013')
  assert.equal(flat.mainPersona, 'F')
  assert.equal(flat.subagentPersona, '子代理路由人设')
  assert.deepEqual(flat.toolFilterAllow, ['read', 'glob'])
  assert.deepEqual(flat.toolFilterDeny, ['bash'])
  assert.equal(flat.maxDepth, 2)
  // 运行时扁平键优先于 preset.yml 默认值。
  const overridden = resolvePresetParams({ id: 't', params: { modelProvider: 'preset-default', modelName: 'm1' } }, { modelProvider: 'runtime-wins' })
  assert.equal(overridden.modelProvider, 'runtime-wins')
  assert.equal(overridden.modelName, 'm1')
  // 空默认值不渲染（renderEngineTokens 对空串/空数组跳过）。
  const empty = resolvePresetParams({ id: 't', params: { modelProvider: '', modelName: '', subagentPersona: '', toolFilterAllow: [], toolFilterDeny: [], maxDepth: '' } }, {})
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

test('子代理模型路由与委派完整自定义：persona + toolFilter + maxDepth 渲染（官方 tool-subagent Config）', () => {
  const rows = parseYaml(buildCordis('P', {
    subagentModelProvider: 'my-provider',
    subagentModelName: 'deepseek-v4-flash-7013',
    subagentPersona: '你是审查子代理，只读不改。',
    toolFilterAllow: ['read', 'write', 'glob'],
    toolFilterDeny: 'bash, run_code',
    maxDepth: 1,
  }))
  const subs = findAllNested(rows, new Set(['tool-subagent', 'tool-subagent-fork']))
  assert.equal(subs.length, 2, 'subagent 与 subagent_fork 两行都应渲染')
  for (const row of subs) {
    assert.equal(row.config.agentOptions.provider, 'my-provider')
    assert.equal(row.config.agentOptions.model, 'deepseek-v4-flash-7013')
    assert.equal(row.config.persona, '你是审查子代理，只读不改。')
    assert.deepEqual(row.config.toolFilter, { allow: ['read', 'write', 'glob'], deny: ['bash', 'run_code'] })
    assert.equal(row.config.maxDepth, 1)
  }
})

test('子代理 persona：仅显式 subagentPersona 渲染；缺省不渲染（scope 链继承主会话 persona）', () => {
  const routed = parseYaml(buildCordis('P', { subagentModelProvider: 'p', subagentModelName: 'm' }))
  const routedRow = findAllNested(routed, new Set(['tool-subagent']))[0]
  assert.equal(routedRow.config.persona, undefined, '无 subagentPersona 不渲染（继承主会话 persona 模块）')
  assert.equal(routedRow.config.toolFilter, undefined, '未配置 toolFilter 不渲染')
  assert.equal(routedRow.config.maxDepth, undefined, '未配置 maxDepth 不渲染（官方默认 3）')

  const explicit = parseYaml(buildCordis('P', { subagentModelProvider: 'p', subagentModelName: 'm', subagentPersona: '子代理专属人设' }))
  const explicitRow = findAllNested(explicit, new Set(['tool-subagent']))[0]
  assert.equal(explicitRow.config.persona, '子代理专属人设', '显式 subagentPersona 渲染')
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
