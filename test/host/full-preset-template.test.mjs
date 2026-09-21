import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseDocument } from 'yaml'
import { ENGINE_PARAM_KEYS, validateEngineParamValues } from '../../src/shared/engine-params.ts'
import { readPresetLayerSettings } from '../../src/host/preset-layer-settings.ts'
import { renderComposition } from '../../src/host/manifest.ts'
import { createPromptConfigs, LAYER_ORDER } from '../../engine/schema.mjs'

test('全参数模板与71键共享目录、九层契约同源，示例默认不启用且可合法物化', () => {
  const source = readFileSync(new URL('../../preset.yml', import.meta.url), 'utf8')
  const document = parseDocument(source)
  assert.deepEqual(document.errors, [])
  const spec = document.toJS()
  assert.deepEqual(readPresetLayerSettings(spec), {})
  assert.deepEqual(spec.modules, ['prompt-config-engine'])
  assert.ok(spec.promptConfigs.every(config => config.enabled === false))
  assert.deepEqual([...new Set(spec.promptConfigs.map(config => config.layer))].sort(), [...LAYER_ORDER].sort())
  assert.doesNotThrow(() => createPromptConfigs(spec.promptConfigs))
  assert.doesNotThrow(() => renderComposition(spec, {}))
  const referenceBlock = source.split('# BEGIN SHARED PARAMETER REFERENCE\n')[1].split('# END SHARED PARAMETER REFERENCE')[0]
  const reference = referenceBlock.slice(referenceBlock.indexOf('# layerSettings:'))
    .split('\n').map(line => line.replace(/^# ?/, '')).join('\n')
  const referenceDoc = parseDocument(reference)
  assert.deepEqual(referenceDoc.errors, [])
  const params = readPresetLayerSettings(referenceDoc.toJS())
  assert.deepEqual(Object.keys(params).sort(), [...ENGINE_PARAM_KEYS].sort(), '不能漏登记参数或混入旧别名')
  assert.deepEqual(validateEngineParamValues(params), [])
  assert.ok(!source.includes('undefined'), '所有参数都有中文注释')
  const check = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/rebuild-preset-template.mjs', import.meta.url)), '--check'], { cwd: process.cwd(), encoding: 'utf8' })
  assert.equal(check.status, 0, check.stderr)
})
