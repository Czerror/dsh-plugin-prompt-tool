/**
 * B6 T1 —— `runtimeOf` 的**归一化形态**特性固化（characterization）。
 *
 * ## 为什么是特性测试，而不是「按 kind 统一驱动」
 *
 * PLAN 原计划把 `runtimeOf`（`src/host/write-preset.ts`）与 `reloadPresetParams`
 * （`src/index.ts`）的逐键清单收敛为「按 `ENGINE_PARAM_KEYS` 遍历 + 少量显式特例」。
 * 查证后**不采用按 kind 统一驱动**，三条同向证据：
 *
 *   1. **两处规则本来就不同**：`firstTurnAnchor` 在写盘侧是 `providedBoolean`（保留调用方
 *      显式的 `false`），在读回侧是 `params.x === true`（把 `undefined` 也布尔化成 `false`）；
 *      同一批键、两套有意的策略，按 kind 驱动必然改变其中一侧的行为。
 *   2. **kind 不等于入参形态**：`modelTemperature` / `modelMaxTokens` / `subagentTemperature` /
 *      `subagentMaxTokens` 的 kind 是 `number`（值语义是数字），但写盘侧的规则是
 *      `typeof === 'string'`——因为 UI/YAML 以**字符串**回读这些值
 *      （`engine-param-schema.test.mjs:28` 断言 `modelTemperature: 0.5` → `'0.5'`）。
 *      按 kind 归一化会把合法输入判成非法。
 *   3. **逐键清单的存在理由不是「类型声明」**，而是「**哪些键需要在写盘前收窄形态**」：
 *      24 个键需要、48 个键直透。这个划分是行为事实，不是类型信息的拷贝。
 *
 * 所以本文件把**实测得到的划分**钉住：任何改动（包括按 kind 重写）只要挪动了某个键的
 * 归属或改变了收窄结果，都会红在这里，而不是等到写盘出问题时才发现。
 *
 * 划分由探针对全部 72 个 `ENGINE_PARAM_KEYS` 逐个喂「该 kind 的合法值 / 异物值」实测得出。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { runtimeOf } from '../../src/host/write-preset.ts'
import { ENGINE_PARAM_DEFINITIONS, ENGINE_PARAM_KEYS } from '../../src/shared/engine-params.ts'

/** 写盘前**收窄形态**的键：异物值丢弃为 undefined，合法值原样保留。 */
const NORMALIZED = [
  'firstTurnAnchor', 'firstTurnText', 'firstTurnCustom', 'guideText', 'guideCustom', 'guideEnabled',
  'injectPrompt', 'modelProvider', 'modelName', 'subagentModelProvider', 'subagentModelName',
  'modelReasoningEffort', 'subagentReasoningEffort', 'firstTurnWord',
]

/**
 * **直透**的键（16 个，= 30 − 14）：`runtimeOf` 不碰它们，取值原样进 runtime。
 *
 * 其中四个（`modelTemperature` / `modelMaxTokens` / `subagentTemperature` / `subagentMaxTokens`）
 * 看着像漏网，其实**是**在上面第 2 条里被有意排除的：它们已有独立的字符串收窄分支，
 * 而喂给它们的「异物值」恰好是字符串（其 kind 为 `number`），所以行为上表现为直透。
 *
 * B7 T3：参数目录从 72 键收缩到 30 键（七个专用能力的参数键随模块删除），两个清单同时变短；
 * 「哪些键需要收窄」的判据不变 —— 仍是 `runtimeOf` 里有没有显式的类型守卫。
 */
const PASSTHROUGH = [
  'modelTemperature', 'modelMaxTokens', 'subagentTemperature', 'subagentMaxTokens', 'maxDepth',
  'buildPattern', 'complexPattern', 'firstTurnBuild', 'firstTurnInspect', 'firstTurnDeep',
  'guideWeak', 'guideDeep', 'instructionHint', 'strReplaceEditorMaxOutputChars',
  'toolGitBashEnabled', 'customToolRequireApproval',
]

/** 异物值：与该 kind 的合法形态**不同类**，用来判断这个键有没有被收窄。 */
const ALIEN = { boolean: 'not-a-boolean', number: 'not-a-number', string: 12345, 'string-list': 12345, stages: 12345, 'max-depth': 12345, pattern: 12345 }
/** 该 kind 的合法值，用来判断收窄是否「保留原值」。 */
const VALID = { boolean: true, number: 7, string: 'valid', 'string-list': ['a'], stages: [{ name: 's', tools: ['t'] }], 'max-depth': 2, pattern: '^x' }

test('收窄划分与实测一致：14 个键收窄形态，16 个键直透（按 kind 统一驱动会破坏它）', () => {
  const normalized = []
  const passthrough = []
  for (const key of ENGINE_PARAM_KEYS) {
    const kind = ENGINE_PARAM_DEFINITIONS[key].kind
    const alien = runtimeOf({ [key]: ALIEN[kind] }, 'p')[key]
    if (alien === undefined) normalized.push(key)
    else if (JSON.stringify(alien) === JSON.stringify(ALIEN[kind])) passthrough.push(key)
    else assert.fail(`${key}: 既未收窄也未直透（输出 ${JSON.stringify(alien)}）—— 出现新的第三种形态，需人工确认`)
  }
  assert.deepEqual(normalized, NORMALIZED, '收窄清单变了：写盘形态随之改变')
  assert.deepEqual(passthrough, PASSTHROUGH, '直透清单变了：写盘形态随之改变')
  assert.equal(normalized.length + passthrough.length, ENGINE_PARAM_KEYS.length, '两个清单必须恰好覆盖全部引擎参数键')
})

test('收窄语义：合法值原样保留，异物值丢弃为 undefined（= 不覆盖模板值）', () => {
  for (const key of NORMALIZED) {
    const kind = ENGINE_PARAM_DEFINITIONS[key].kind
    assert.deepEqual(runtimeOf({ [key]: VALID[kind] }, 'p')[key], VALID[kind], `${key}: 合法值必须原样保留`)
    assert.equal(runtimeOf({ [key]: ALIEN[kind] }, 'p')[key], undefined, `${key}: 异物值必须丢弃为 undefined`)
  }
})

test('「未提供 = 不覆盖」：空输入时只有 promptText 有值', () => {
  const empty = runtimeOf({}, 'PROMPT')
  const provided = Object.entries(empty).filter(([, value]) => value !== undefined)
  assert.deepEqual(provided, [['promptText', 'PROMPT']],
    '未提供的参数必须保持 undefined（resolvePresetParams 跳过 undefined 键，模板/预设才是缺省值来源）')
})

test('输出键集 = 全部引擎参数 + promptText（不多不少）', () => {
  const keys = Object.keys(runtimeOf({}, 'p'))
  assert.deepEqual(keys.filter((key) => !ENGINE_PARAM_KEYS.includes(key)), ['promptText'],
    '引擎参数之外的输出键只允许 promptText（它不是引擎参数，由 writePreset 直接给）')
  assert.deepEqual(ENGINE_PARAM_KEYS.filter((key) => !keys.includes(key)), [],
    '每个引擎参数键都必须出现在写盘 runtime 里，否则该参数永远写不进预设')
})
