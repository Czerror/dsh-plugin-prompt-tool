import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCordis } from '../../lib/preset-core.mjs'
import { applyModuleConfigs } from '../../lib/index.mjs'
import { parse as parseYaml } from 'yaml'

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
  assert.ok(bash && router && gate, 'agent 组合应含 custom-bash / router-first-turn / context-gate 行')
  assert.equal(bash.config.timeoutMs, 120000)
  assert.deepEqual(router.config.hideSectionPrefixes, ['mnemon:'])
  assert.equal(gate.config.promoteOn, 'either')
  assert.deepEqual(gate.config.allowKinds, ['skill-invocation', 'near-anchor', 'router-guide'])
  assert.ok(!/__[A-Z0-9_]+__/.test(buildCordis('P')), '生成文本不应残留未解析 token')
})
