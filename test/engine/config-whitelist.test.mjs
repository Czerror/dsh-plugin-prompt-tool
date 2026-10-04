/**
 * B2 T4 验收：四个此前「没有白名单」的插件行，现在有了字段声明与校验。
 *
 * 旧字段的缺键与错类型语义必须逐字段不变——这三个模块对旧字段非法值
 * 都是**静默取默认/忽略**的
 *（`typeof x === 'string' && x.length > 0 ? x : 默认`、非数组取 `[]`、数组过滤非字符串项），
 * 所以声明里保留 `passthrough`。新增内联字段的严格语义由 inline-capabilities
 * 与 subagent-tool-policy 行为测试覆盖。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { configContract: toolConfig } = await import('../../engine/tool-config-engine.mjs')
const { configContract: subagentPolicy } = await import('../../engine/subagent-tool-policy.mjs')

const PLUGIN = 'probe'

const MODULES = [
  ['tool-config-engine', toolConfig, ['configsDir', 'tools', 'requireApproval', 'resourceRoot', 'presetRoot']],
  ['subagent-tool-policy', subagentPolicy, ['policyFile', 'policy', 'spawnProvider', 'forkProvider', 'maxDepth', 'agentOptions']],
]

test('白名单由字段声明派生，键集与 PLAN 列出的键一致', () => {
  for (const [name, contract, keys] of MODULES) {
    assert.deepEqual([...contract.allowedKeys].sort(), [...keys].sort(), `${name}: 白名单由声明派生`)
  }
})

test('未知键在挂载期报错', () => {
  for (const [name, contract] of MODULES) {
    assert.throws(() => contract.parse({ nope: 1 }, name), /unknown config key\(s\) nope/, `${name}: 未知键必须抛`)
    assert.match(
      (() => { try { contract.parse({ nope: 1 }, name) } catch (error) { return error.message } })(),
      /allowed keys: /,
      `${name}: 消息含允许键清单`,
    )
  }
})

test('tool-config-engine：requireApproval 的宽容语义（非数组取空、过滤非字符串项）', () => {
  assert.deepEqual(toolConfig.parse({}, PLUGIN).requireApproval, [], '缺键取空数组')
  assert.deepEqual(toolConfig.parse({ requireApproval: 'shell' }, PLUGIN).requireApproval, [], '非数组取空数组')
  assert.deepEqual(
    toolConfig.parse({ requireApproval: ['shell', 1, 'fs'] }, PLUGIN).requireApproval,
    ['shell', 'fs'],
    '数组内的非字符串项被过滤（迁移前行为，不报错）',
  )
  assert.equal(toolConfig.parse({}, PLUGIN).configsDir, './custom-tools', 'configsDir 缺键取默认')
  assert.equal(toolConfig.parse({ configsDir: 0 }, PLUGIN).configsDir, './custom-tools', 'configsDir 非字符串取默认')
  assert.equal(toolConfig.parse({}, PLUGIN).presetRoot, undefined, 'presetRoot 缺键为 undefined')
  assert.equal(toolConfig.parse({ presetRoot: {} }, PLUGIN).presetRoot, undefined, 'presetRoot 非字符串为 undefined')
})

test('subagent-tool-policy：五个键的缺省与原语义一致', () => {
  const policy = subagentPolicy.parse({}, PLUGIN)
  assert.equal(policy.policyFile, '../subagent-tools/policy.yml', 'policyFile 默认路径')
  assert.equal(policy.spawnProvider, 'spawn', 'spawnProvider 默认名')
  assert.equal(policy.forkProvider, 'fork', 'forkProvider 默认名')
  assert.equal(policy.maxDepth, undefined, 'maxDepth 原样透传（下游判定 provider-managed）')
  assert.equal(policy.agentOptions, undefined, 'agentOptions 缺省 undefined')
  // 非法值仍是「取默认」而非报错：
  assert.equal(subagentPolicy.parse({ policyFile: 42 }, PLUGIN).policyFile, '../subagent-tools/policy.yml')
  assert.equal(subagentPolicy.parse({ spawnProvider: '' }, PLUGIN).spawnProvider, 'spawn')
  assert.equal(subagentPolicy.parse({ maxDepth: 'provider-managed' }, PLUGIN).maxDepth, 'provider-managed', 'maxDepth 原样保留给下游判定')
})
