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
    // 显示文案不在 shared：shared 只给键与卡片归属，标签由 UI 按 `param.<键>` 查 prompt-tool 字典
    // （键覆盖由 test/client/locale-contract.test.mjs 守卫）。
    assert.ok(definition.card, `${key} 必须归属配置卡`)
    assert.equal(definition.label, undefined, `${key} 不得在 shared 持有显示文案`)
    assert.deepEqual(EMPTY_FIELDS[key], definition.defaultValue, `${key} 默认值同源`)
  }
  assert.deepEqual(buildParamOverrides(EMPTY_FIELDS, { loadedKeys: new Set() }), {})
})

test('参数读回保留 false、0、未设置开关以及 YAML 数值模型参数', () => {
  const values = { toolFilterEnabled: false, guideEnabled: true, stagePreUnlock: 0, modelTemperature: 0.5, subagentMaxTokens: 8192 }
  assert.deepEqual(readParamOverridesPatch(values), {
    toolFilterEnabled: false, guideEnabled: true, stagePreUnlock: 0, modelTemperature: '0.5', subagentMaxTokens: '8192',
  })
  const fields = { ...EMPTY_FIELDS, ...readParamOverridesPatch(values) }
  assert.deepEqual(buildParamOverrides(fields, { loadedKeys: new Set(Object.keys(values)) }), {
    guideEnabled: true, modelTemperature: '0.5', subagentMaxTokens: '8192', stagePreUnlock: 0, toolFilterEnabled: false,
  })
})

test('模块参数的装配与回显同源，完整覆盖门控列表与阶段', () => {
  const params = {
    allowKinds: ['prompt'], messageSources: ['user'], deferredSources: ['skills'], deferredGraceSteps: 2,
    stages: [{ name: 'read', tools: ['read'] }], stagePreUnlock: 0, workspaceLine: true,
  }
  const configs = buildEngineModuleParams(params)
  assert.deepEqual(configs['context-gate'], {
    allowKinds: ['prompt'], messageSources: ['user'], deferredSources: ['skills'], deferredGraceSteps: 2,
  })
  const fallbacks = moduleParamFallbacks(configs)
  for (const [key, value] of Object.entries(params)) assert.deepEqual(fallbacks[key], value, key)
  assert.deepEqual(readParamOverridesPatch(fallbacks).stages, [{ name: 'read', tools: 'read' }])
})

test('合法零值保留阶段、节拍与深思下限语义，输出封顶仍可清除', () => {
  const values = { stagePreUnlock: 0, cotDripEvery: 0, deliberationMinChars: 0, bootstrapMaxTokens: 0, maxPromoteSteps: 0 }
  assert.deepEqual(validateEngineParamValues(values), [])
  const configs = buildEngineModuleParams(values)
  assert.equal(configs['tool-bootstrap'].stagePreUnlock, 0)
  assert.equal(configs['progress-reminder'].every, 0)
  assert.equal(configs['deliberation-gate'].minChars, 0)
  assert.equal(configs['tool-bootstrap'].bootstrapMaxTokens, undefined)
})

test('深度限制只接受非负安全整数、数字字符串、provider-managed 或清空值', () => {
  for (const maxDepth of ['', 0, 2, '0', ' 2 ', 'provider-managed']) {
    assert.deepEqual(validateEngineParamValues({ maxDepth }), [], String(maxDepth))
  }
  for (const maxDepth of [' ', 'invalid', '-1', '1.5', 'Infinity', '9007199254740992', -1, 1.5, true]) {
    assert.equal(validateEngineParamValues({ maxDepth }).length, 1, String(maxDepth))
  }
})

test('清除可选开关恢复继承，工具过滤开关与编辑器上限按类型落位', () => {
  const overrides = buildParamOverrides(EMPTY_FIELDS, { loadedKeys: new Set(['guideEnabled']) })
  assert.deepEqual(overrides, { guideEnabled: '' })
  assert.deepEqual(validateEngineParamValues(overrides), [])
  // 工具过滤只保留总开关（主/子代理已分离，不再有「子代理同过滤」）。
  assert.equal(buildEngineModuleParams({ toolFilterEnabled: false })['tool-filter'].enabled, false)
  assert.equal(buildEngineModuleParams({ strReplaceEditorMaxOutputChars: '32000' })['str-replace-editor'].maxOutputChars, 32000)
})

test('模块重命名只改变行映射，保留参数键、工具名与消息来源身份', () => {
  const params = {
    usePtcMode: true, ptcSubagents: true, ptcPromoteOn: 'tool-call',
    cotDrip: true, cotDripEvery: 0, cotDripMaxPerTurn: 2, cotDripSubagents: true, cotDripText: '保持节拍',
    strReplaceEditorMaxOutputChars: 32000, bootstrapTools: ['bash', 'run_code', 'str_replace_editor'],
    messageSources: ['cot-drip'], deferredSources: ['cot-drip'],
  }
  const configs = buildEngineModuleParams(params)
  assert.deepEqual(configs['promoted-code-mode'], { usePtcMode: true, includeSubagents: true, promoteOn: 'tool-call' })
  assert.deepEqual(configs['progress-reminder'], { enabled: true, every: 0, maxPerTurn: 2, includeSubagents: true, text: '保持节拍' })
  assert.deepEqual(configs['str-replace-editor'], { maxOutputChars: 32000 })
  assert.deepEqual(moduleParamFallbacks(configs), params)
  assert.equal(configs['code-presentation'], undefined)
  assert.equal(configs['cot-drip'], undefined)
  assert.deepEqual(moduleParamFallbacks({
    'code-presentation': { usePtcMode: true, includeSubagents: true, promoteOn: 'tool-call' },
    'cot-drip': { enabled: true, every: 4, maxPerTurn: 1, includeSubagents: true, text: '旧行' },
  }), {})
})

test('能力卡覆盖引擎全部公开配置键，且新参数自动参与保存中脏检测', () => {
  // 引擎保留但不再面向 UI 暴露的键：主/子代理已分离，工具过滤只保留总开关，
  // 子代理工具面由实例级 subagentToolPolicy 授权，故 includeSubagents 不再有 UI 绑定。
  const UI_UNBOUND_BY_DESIGN = { 'tool-filter': new Set(['includeSubagents']) }
  for (const module of ['tool-bootstrap', 'context-gate', 'promoted-code-mode', 'tool-filter', 'anchor-turn', 'deliberation-gate', 'progress-reminder']) {
    const source = readFileSync(new URL(`../../engine/${module}.mjs`, import.meta.url), 'utf8')
    const allowed = source.match(/const ALLOWED_KEYS = new Set\(\[([\s\S]*?)\]\)/)?.[1]
    assert.ok(allowed, `${module} 公共配置键`)
    const keys = [...allowed.matchAll(/'([^']+)'/g)].map((match) => match[1])
    const bindings = Object.entries(ENGINE_PARAM_DEFINITIONS).filter(([, definition]) => definition.module?.row === module)
      .map(([key, definition]) => definition.module.key ?? key)
    const unbound = keys.filter((key) => !bindings.includes(key))
    const byDesign = UI_UNBOUND_BY_DESIGN[module] ?? new Set()
    assert.deepEqual(new Set(unbound.filter((key) => !byDesign.has(key))), new Set(), `${module} 不得遗漏引擎参数`)
    assert.deepEqual(
      new Set(bindings.filter((key) => !keys.includes(key))),
      new Set(),
      `${module} 不得绑定引擎不接受的配置键`,
    )
  }
  const before = snapshotSwitches(EMPTY_FIELDS)
  const after = snapshotSwitches({ ...EMPTY_FIELDS, bootstrapSubagents: true })
  assert.equal(shouldReloadAfterParamSave(after, before), false)
  assert.equal(shouldReloadAfterParamSave(snapshotSwitches({ ...EMPTY_FIELDS, toolFilterAllow: 'read' }), before), false)
  assert.ok(validateEngineParamValues({ bootstrapPromoteOn: 'invalid' }).length > 0)
})
