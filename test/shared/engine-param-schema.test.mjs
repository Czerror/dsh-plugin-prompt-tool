import test from 'node:test'
import assert from 'node:assert/strict'
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
  const values = { toolGitBashEnabled: false, guideEnabled: true, maxDepth: 0, modelTemperature: 0.5, subagentMaxTokens: 8192 }
  assert.deepEqual(readParamOverridesPatch(values), {
    toolGitBashEnabled: false, guideEnabled: true, maxDepth: '0', modelTemperature: '0.5', subagentMaxTokens: '8192',
  })
  const fields = { ...EMPTY_FIELDS, ...readParamOverridesPatch(values) }
  assert.deepEqual(buildParamOverrides(fields, { loadedKeys: new Set(Object.keys(values)) }), {
    toolGitBashEnabled: false, guideEnabled: true, maxDepth: 0, modelTemperature: '0.5', subagentMaxTokens: '8192',
  })
})

test('模块参数的装配与回显同源，按声明落位到对应模块行', () => {
  // B7 T3：七个专用能力的参数键已删除，改用四个存活能力提供者的模块行绑定覆盖同一契约。
  const params = {
    toolGitBashEnabled: false,
    strReplaceEditorMaxOutputChars: 32000,
    customToolRequireApproval: ['shell', 'fs'],
    instructionHint: true,
  }
  const configs = buildEngineModuleParams(params)
  assert.deepEqual(configs['tool-git-bash'], { enabled: false })
  assert.deepEqual(configs['str-replace-editor'], { maxOutputChars: 32000 })
  assert.deepEqual(configs['tool-config-engine'], { requireApproval: ['shell', 'fs'] })
  assert.deepEqual(configs['instruction-hint'], { enabled: true })
  const fallbacks = moduleParamFallbacks(configs)
  for (const [key, value] of Object.entries(params)) assert.deepEqual(fallbacks[key], value, key)
})

test('合法零值保留：maxDepth 0 与显式 false 不被当成空值吞掉', () => {
  assert.deepEqual(validateEngineParamValues({ maxDepth: 0, toolGitBashEnabled: false }), [])
  assert.deepEqual(readParamOverridesPatch({ maxDepth: 0 }), { maxDepth: '0' })
  const fields = { ...EMPTY_FIELDS, maxDepth: '0', toolGitBashEnabled: false }
  assert.deepEqual(buildParamOverrides(fields, { loadedKeys: new Set(['maxDepth', 'toolGitBashEnabled']) }),
    { maxDepth: 0, toolGitBashEnabled: false })
})

test('深度限制只接受非负安全整数、数字字符串、provider-managed 或清空值', () => {
  for (const maxDepth of ['', 0, 2, '0', ' 2 ', 'provider-managed']) {
    assert.deepEqual(validateEngineParamValues({ maxDepth }), [], String(maxDepth))
  }
  for (const maxDepth of [' ', 'invalid', '-1', '1.5', 'Infinity', '9007199254740992', -1, 1.5, true]) {
    assert.equal(validateEngineParamValues({ maxDepth }).length, 1, String(maxDepth))
  }
})

test('清除可选开关恢复继承，工具开关与编辑器上限按类型落位', () => {
  const overrides = buildParamOverrides(EMPTY_FIELDS, { loadedKeys: new Set(['guideEnabled']) })
  assert.deepEqual(overrides, { guideEnabled: '' })
  assert.deepEqual(validateEngineParamValues(overrides), [])
  assert.equal(buildEngineModuleParams({ toolGitBashEnabled: false })['tool-git-bash'].enabled, false)
  assert.equal(buildEngineModuleParams({ strReplaceEditorMaxOutputChars: '32000' })['str-replace-editor'].maxOutputChars, 32000)
})

test('R5 编辑器上限只投影已提供的合法值，缺参不补默认覆盖行级配置', () => {
  // 缺参：参数桥不产生该行配置（moduleConfigs/行默认生效），回显同样为空。
  assert.deepEqual(buildEngineModuleParams({}), {})
  assert.deepEqual(moduleParamFallbacks(buildEngineModuleParams({})), {})
  // 显式合法值：参数桥优先（数字与数字字符串同义）。
  assert.deepEqual(buildEngineModuleParams({ strReplaceEditorMaxOutputChars: 48000 })['str-replace-editor'], { maxOutputChars: 48000 })
  assert.deepEqual(buildEngineModuleParams({ strReplaceEditorMaxOutputChars: '32000' })['str-replace-editor'], { maxOutputChars: 32000 })
  // 非法值不写（渲染层宽容，回落行默认），保存层仍响亮拒绝。
  for (const bad of [0, -1, 1.5, Number.NaN, 'abc', '', ' ']) {
    assert.equal(buildEngineModuleParams({ strReplaceEditorMaxOutputChars: bad })['str-replace-editor'], undefined, String(bad))
  }
  assert.ok(validateEngineParamValues({ strReplaceEditorMaxOutputChars: 0 }).length > 0)
  assert.deepEqual(validateEngineParamValues({ strReplaceEditorMaxOutputChars: '' }), [])
})

test('参数键只落映射行，已删能力的旧行名不得产生幽灵配置', () => {
  const params = { customToolRequireApproval: 'shell', strReplaceEditorMaxOutputChars: 32000, toolGitBashEnabled: false }
  const configs = buildEngineModuleParams(params)
  assert.deepEqual(configs['tool-config-engine'], { requireApproval: ['shell'] })
  assert.deepEqual(configs['str-replace-editor'], { maxOutputChars: 32000 })
  assert.deepEqual(configs['tool-git-bash'], { enabled: false })
  assert.deepEqual(moduleParamFallbacks(configs),
    { customToolRequireApproval: ['shell'], strReplaceEditorMaxOutputChars: 32000, toolGitBashEnabled: false })
  // B7 T3：七个专用能力的行名已退场——参数桥与回显都不得再产出它们。
  for (const ghost of ['tool-filter', 'context-gate', 'tool-bootstrap', 'progress-reminder',
    'deliberation-gate', 'anchor-turn', 'promoted-code-mode']) {
    assert.equal(configs[ghost], undefined, `${ghost} 不得有幽灵行配置`)
  }
  assert.deepEqual(moduleParamFallbacks({
    'code-presentation': { usePtcMode: true, includeSubagents: true, promoteOn: 'tool-call' },
    'cot-drip': { enabled: true, every: 4, maxPerTurn: 1, includeSubagents: true, text: '旧行' },
  }), {})
})

test('新参数自动参与保存中脏检测：默认值不触发重建，非法值写盘前拒绝', () => {
  // B7 T3：原用例的「7 个手写模块 ALLOWED_KEYS 遍历」对象已随模块删除，整块移除；
  // 「每个公开键必须归属配置卡」仍由本文件第一条用例逐键钉住。
  const before = snapshotSwitches(EMPTY_FIELDS)
  assert.equal(shouldReloadAfterParamSave(snapshotSwitches({ ...EMPTY_FIELDS, toolGitBashEnabled: false }), before), false)
  assert.equal(shouldReloadAfterParamSave(snapshotSwitches({ ...EMPTY_FIELDS, customToolRequireApproval: 'shell' }), before), false)
  assert.ok(validateEngineParamValues({ maxDepth: 'invalid' }).length > 0)
})

test('T13 锚定/引导内容键：预设级归属、正则校验、读回与清空往返', () => {
  const patternKeys = ['buildPattern', 'complexPattern']
  const textKeys = ['firstTurnBuild', 'firstTurnInspect', 'firstTurnDeep', 'guideWeak', 'guideDeep']
  for (const key of [...patternKeys, ...textKeys]) {
    assert.ok(ENGINE_PARAM_KEYS.includes(key), `${key} 必须进共享参数定义（不再走旁路键清单）`)
    assert.equal(ENGINE_PARAM_DEFINITIONS[key].card, 'prompt-defaults', `${key} 主归属提示词默认值卡`)
    assert.equal(ENGINE_PARAM_DEFINITIONS[key].defaultValue, '', `${key} 默认草稿为空串`)
    assert.equal(EMPTY_FIELDS[key], '', `${key} 字段默认同源`)
  }
  // 正则按 flags=i 编译（与 engine/classify-task.mjs 同源）：合法与空串通过，非法在写盘前拒绝。
  assert.deepEqual(validateEngineParamValues({ buildPattern: '^(写|实现)' }), [])
  assert.deepEqual(validateEngineParamValues({ complexPattern: '', guideWeak: '简短引导' }), [])
  assert.equal(validateEngineParamValues({ buildPattern: '(' }).length, 1)
  assert.equal(validateEngineParamValues({ complexPattern: 'a{2,1}' }).length, 1)
  // 读回原样保留（不因本地编译差异吞值），保存往返一致。
  const patch = readParamOverridesPatch({ buildPattern: '^(写|实现)', guideWeak: '简短引导', firstTurnDeep: '深度锚句' })
  assert.deepEqual(patch, { buildPattern: '^(写|实现)', guideWeak: '简短引导', firstTurnDeep: '深度锚句' })
  const fields = { ...EMPTY_FIELDS, ...patch }
  assert.deepEqual(
    buildParamOverrides(fields, { loadedKeys: new Set(Object.keys(patch)) }),
    { buildPattern: '^(写|实现)', guideWeak: '简短引导', firstTurnDeep: '深度锚句' },
  )
  // 清空是删键语义：已存键的空串仍要发送，否则旧正则永远删不掉。
  assert.deepEqual(buildParamOverrides({ ...EMPTY_FIELDS, buildPattern: '' }, { loadedKeys: new Set(['buildPattern']) }), { buildPattern: '' })
})
