import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCordis } from '../../lib/preset-core.mjs'
import { applyModuleConfigs } from '../../lib/index.mjs'
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
    flashPersona: "__FLASH_PERSONA__"
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
  assert.equal(router.config.flashPersona, '__FLASH_PERSONA__')
})

test('moduleConfigs 未声明时返回原文（零开销）', () => {
  assert.equal(applyModuleConfigs(RAW, undefined), RAW)
  assert.equal(applyModuleConfigs(RAW, {}), RAW)
})

test('anchored buildCordis 集成：moduleConfigs 合并与 token 渲染共存', () => {
  const rows = parseYaml(buildCordis('P'))
  const bash = rows.find((row) => row?.id === 'custom-bash')
  const router = rows.find((row) => row?.id === 'router-first-turn')
  const gate = rows.find((row) => row?.id === 'context-gate')
  const persona = rows.find((row) => row?.id === 'persona')
  const bootstrap = rows.find((row) => row?.id === 'tool-bootstrap')
  assert.ok(bash && router && gate && persona && bootstrap, 'agent 组合应含核心行')
  assert.equal(bash.config.timeoutMs, 120000)
  assert.deepEqual(router.config.hideSectionPrefixes, ['mnemon:'])
  assert.equal(gate.config.promoteOn, 'either')
  assert.deepEqual(gate.config.allowKinds, ['skill-invocation', 'near-anchor', 'router-guide'])
  // persona.complete 是可选功能开关（官方 assemble 语义）：默认 true = minimal
  // 完整 persona（plan-mode/Flash 路由人设被抑制）；设 false 切 standard 语义。
  // includeRuntimeContext 同理：false = 永久抑制（context-gate 恢复失效）。
  assert.equal(persona.config.complete, true, 'persona 默认 minimal 语义（complete 开关可配）')
  assert.equal(persona.config.includeRuntimeContext, false, 'persona 默认抑制 runtime-context（开关可配）')
  // 子代理相位两行显式一致（tool-bootstrap 与 context-gate 保持同步）。
  assert.equal(bootstrap.config.includeSubagents, false)
  assert.equal(gate.config.includeSubagents, false)
  assert.ok(!/__[A-Z0-9_]+__/.test(buildCordis('P')), '生成文本不应残留未解析 token')
})

test('子代理完整自定义：独立 persona + toolFilter + maxDepth 渲染（官方 tool-subagent Config）', () => {
  const rows = parseYaml(buildCordis('P', {
    subagentFlashProvider: 'my-provider',
    subagentFlashModel: 'deepseek-v4-flash-7013',
    subagentPersona: '你是审查子代理，只读不改。',
    subagentToolFilterAllow: ['read', 'write', 'glob'],
    subagentToolFilterDeny: 'bash, run_code',
    subagentMaxDepth: 1,
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

test('子代理 persona 回退：无独立 persona 时固定路由用 flashPersona，无路由不渲染', () => {
  const routed = parseYaml(buildCordis('P', { subagentFlashProvider: 'p', subagentFlashModel: 'm' }))
  const routedRow = findAllNested(routed, new Set(['tool-subagent']))[0]
  assert.match(routedRow.config.persona, /decide the task type \(build or fix\)/, '固定路由时 persona 回退 flashPersona')
  assert.equal(routedRow.config.toolFilter, undefined, '未配置 toolFilter 不渲染')
  assert.equal(routedRow.config.maxDepth, undefined, '未配置 maxDepth 不渲染（官方默认 3）')

  const plain = parseYaml(buildCordis('P'))
  const plainRow = findAllNested(plain, new Set(['tool-subagent']))[0]
  assert.equal(plainRow.config.persona, undefined, '无路由且无独立 persona 时不渲染（继承主会话）')
  assert.equal(plainRow.config.agentOptions, undefined)
})
