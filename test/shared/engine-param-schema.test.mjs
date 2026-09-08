import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  ENGINE_PARAM_DEFINITIONS, ENGINE_PARAM_KEYS, buildEngineModuleParams,
  moduleParamFallbacks, validateEngineParamValues,
} from '../../src/shared/engine-params.ts'
import { EMPTY_FIELDS } from '../../src/client/data/prompt-tool-fields.ts'
import { buildParamOverrides, readParamOverridesPatch } from '../../src/client/data/param-overrides.ts'
import { snapshotSwitches, shouldReloadAfterParamSave } from '../../src/client/data/dirty-state.ts'

test('参数定义完整覆盖卡片归属、默认草稿与读写契约', () => {
  assert.deepEqual(Object.keys(ENGINE_PARAM_DEFINITIONS), [...ENGINE_PARAM_KEYS])
  for (const key of ENGINE_PARAM_KEYS) {
    const definition = ENGINE_PARAM_DEFINITIONS[key]
    assert.ok(definition.card && definition.label, `${key} 必须归属配置卡`)
    assert.deepEqual(EMPTY_FIELDS[key], definition.defaultValue, `${key} 默认值同源`)
  }
  assert.deepEqual(buildParamOverrides(EMPTY_FIELDS, { loadedKeys: new Set() }), {})
})

test('参数读回保留 false、0、未设置开关以及 YAML 数值模型参数', () => {
  const values = { toolFilterSubagents: false, guideEnabled: true, stagePreUnlock: 0, modelTemperature: 0.5, subagentMaxTokens: 8192 }
  assert.deepEqual(readParamOverridesPatch(values), {
    toolFilterSubagents: false, guideEnabled: true, stagePreUnlock: 0, modelTemperature: '0.5', subagentMaxTokens: '8192',
  })
  const fields = { ...EMPTY_FIELDS, ...readParamOverridesPatch(values) }
  assert.deepEqual(buildParamOverrides(fields, { loadedKeys: new Set(Object.keys(values)) }), {
    guideEnabled: true, modelTemperature: '0.5', subagentMaxTokens: '8192', stagePreUnlock: 0, toolFilterSubagents: false,
  })
})

test('模块参数的装配与回显同源，完整覆盖门控列表与阶段', () => {
  const params = {
    allowKinds: ['prompt'], messageSources: ['user'], deferredSources: ['skills'], deferredGraceSteps: 2,
    stages: [{ name: 'read', tools: ['read'] }], stagePreUnlock: 0, toolFilterSubagents: true,
  }
  const configs = buildEngineModuleParams(params)
  assert.deepEqual(configs['context-gate'], {
    allowKinds: ['prompt'], messageSources: ['user'], deferredSources: ['skills'], deferredGraceSteps: 2,
  })
  const fallbacks = moduleParamFallbacks(configs)
  for (const [key, value] of Object.entries(params)) assert.deepEqual(fallbacks[key], value, key)
  assert.deepEqual(readParamOverridesPatch(fallbacks).stages, [{ name: 'read', tools: 'read' }])
})

test('合法零值可保存，渐进披露零档位保留，其他零值沿用默认语义', () => {
  const values = { stagePreUnlock: 0, cotDripEvery: 0, bootstrapMaxTokens: 0, maxPromoteSteps: 0 }
  assert.deepEqual(validateEngineParamValues(values), [])
  const configs = buildEngineModuleParams(values)
  assert.equal(configs['tool-bootstrap'].stagePreUnlock, 0)
  assert.equal(configs['cot-drip']?.every, undefined)
  assert.equal(configs['tool-bootstrap'].bootstrapMaxTokens, undefined)
})

test('清除可选开关恢复继承，关闭子代理过滤覆盖行级 true', () => {
  const overrides = buildParamOverrides(EMPTY_FIELDS, { loadedKeys: new Set(['guideEnabled']) })
  assert.deepEqual(overrides, { guideEnabled: '' })
  assert.deepEqual(validateEngineParamValues(overrides), [])
  assert.equal(buildEngineModuleParams({ toolFilterSubagents: false })['tool-filter'].includeSubagents, false)
  assert.equal(buildEngineModuleParams({ strReplaceEditorMaxOutputChars: '32000' })['str-replace-editor'].maxOutputChars, 32000)
})

test('能力卡覆盖引擎全部公开配置键，且新参数自动参与保存中脏检测', () => {
  for (const module of ['tool-bootstrap', 'context-gate', 'code-presentation', 'tool-filter', 'anchor-turn', 'deliberation-gate', 'cot-drip']) {
    const source = readFileSync(new URL(`../../engine/${module}.mjs`, import.meta.url), 'utf8')
    const allowed = source.match(/const ALLOWED_KEYS = new Set\(\[([\s\S]*?)\]\)/)?.[1]
    assert.ok(allowed, `${module} 公共配置键`)
    const keys = [...allowed.matchAll(/'([^']+)'/g)].map((match) => match[1])
    const bindings = Object.entries(ENGINE_PARAM_DEFINITIONS).filter(([, definition]) => definition.module?.row === module)
      .map(([key, definition]) => definition.module.key ?? key)
    assert.deepEqual(new Set(bindings), new Set(keys), `${module} 不得遗漏引擎参数`)
  }
  const before = snapshotSwitches(EMPTY_FIELDS)
  const after = snapshotSwitches({ ...EMPTY_FIELDS, bootstrapSubagents: true })
  assert.equal(shouldReloadAfterParamSave(after, before), false)
  assert.equal(shouldReloadAfterParamSave(snapshotSwitches({ ...EMPTY_FIELDS, toolFilterAllow: 'read' }), before), false)
  assert.ok(validateEngineParamValues({ bootstrapPromoteOn: 'invalid' }).length > 0)
})
