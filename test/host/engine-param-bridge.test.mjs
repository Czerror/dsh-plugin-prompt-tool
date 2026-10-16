/**
 * 参数桥：共享参数 → 模块行 config 的映射（`buildEngineModuleParams`）。
 *
 * seam：写盘产物语义——参数桥写出的行配置形状与空值处理。
 * 真值源：`ENGINE_PARAM_DEFINITIONS` 的 `module` 绑定与 `dropWhenEmpty` 声明，加上各行的
 * 组合源默认（`run-code-env` 的 `envKeys` 在引擎侧是 `allowEmpty: false`：写空数组会让该行
 * 挂载期抛错、连带整个装配失败，所以空值必须**不写**、回落到组合源的默认键集）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { buildEngineModuleParams } = await import('../../src/shared/engine-params.ts')

test('参数桥：runCodeEnvKeys 写进 run-code-env 的 envKeys；空值不写（该行 allowEmpty:false）', () => {
  assert.deepEqual(
    buildEngineModuleParams({ runCodeEnvKeys: 'PATH, HOME' }),
    { 'run-code-env': { envKeys: ['PATH', 'HOME'] } },
  )
  assert.deepEqual(
    buildEngineModuleParams({ runCodeEnvKeys: ['PATH'] }),
    { 'run-code-env': { envKeys: ['PATH'] } },
  )
  // 空串与空数组都不得写 `envKeys: []`：那会让 run-code-env 在挂载期抛错。
  assert.deepEqual(buildEngineModuleParams({ runCodeEnvKeys: '' }), {}, '空串回落组合源默认键集')
  assert.deepEqual(buildEngineModuleParams({ runCodeEnvKeys: [] }), {}, '空数组同样不写')
  assert.deepEqual(buildEngineModuleParams({ runCodeEnvKeys: undefined }), {}, '缺键不写')
  // 未标 dropWhenEmpty 的列表键保持既有语义：空列表照写（行为未被本次改动波及）。
  assert.deepEqual(
    buildEngineModuleParams({ customToolRequireApproval: [] }),
    { 'tool-config-engine': { requireApproval: [] } },
  )
})
