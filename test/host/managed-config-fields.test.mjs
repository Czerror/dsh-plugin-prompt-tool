// writer 投影与 shared 契约的一致性：`MANAGED_CONFIG_FIELDS` 登记的每个「受管字段 →
// 来源参数」都必须在真实产物里成立（改来源参数，字段随动），且 writer 实际覆写的
// params 键都已被登记（不留「能改但重建覆盖」的未登记字段）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

const home = mkdtempSync(join(tmpdir(), 'pt-managed-home-'))
process.env.DSH_HOME = home
const { FIXTURE_PRESET_ID, installFixturePreset } = await import('../fixtures/preset-template.mjs')
const { writePreset } = await import('../../lib/index.mjs')
const { MANAGED_CONFIG_FIELDS, managedFieldValue } = await import('../../src/shared/managed-config-fields.ts')
test.after(() => rmSync(home, { recursive: true, force: true }))

/** writePreset 的运行时参数：A/B 两组只在受管字段的来源参数上不同。 */
function runtimeOf(presetDir, suffix, flags) {
  return {
    firstTurnAnchor: flags,
    firstTurnCustom: flags,
    firstTurnText: `ANCHOR-${suffix}`,
    buildPattern: `BUILD-${suffix}`,
    complexPattern: `COMPLEX-${suffix}`,
    firstTurnBuild: `FIRST-BUILD-${suffix}`,
    firstTurnInspect: `FIRST-INSPECT-${suffix}`,
    firstTurnDeep: `FIRST-DEEP-${suffix}`,
    guideEnabled: flags,
    guideCustom: flags,
    guideText: `GUIDE-${suffix}`,
    guideWeak: `WEAK-${suffix}`,
    guideDeep: `DEEP-${suffix}`,
    injectPrompt: true,
    modelProvider: '', subagentModelProvider: '', subagentModelName: '', modelName: '',
    bootstrapMaxTokens: 0,
    usePtcMode: true,
    presetDir,
    presetTemplate: FIXTURE_PRESET_ID,
    presetOrder: 5,
    promptConfigs: [],
  }
}

/** 生成一份预设并读回指定 id 的生成产物（configFileName = 数字前缀 + id）。 */
function materialize(suffix, flags) {
  const presetDir = mkdtempSync(join(home, `preset-${suffix}-`))
  installFixturePreset(presetDir)
  writePreset('', runtimeOf(presetDir, suffix, flags))
  const configDir = join(presetDir, FIXTURE_PRESET_ID, 'prompt-configs')
  const read = (id) => {
    const file = readdirSync(configDir).find((name) => name.endsWith(`-${id}.yml`))
    assert.ok(file, `生成产物里应有 ${id}`)
    return parseYaml(readFileSync(join(configDir, file), 'utf8'))
  }
  return { nearAnchor: read('near-anchor'), routerGuide: read('router-guide') }
}

const on = materialize('ON', true)
const off = materialize('OFF', false)

test('受管字段逐条随来源参数变化（shared 契约与 writer 投影一致）', () => {
  for (const spec of MANAGED_CONFIG_FIELDS) {
    const current = spec.configId === 'near-anchor' ? on.nearAnchor : on.routerGuide
    const flipped = spec.configId === 'near-anchor' ? off.nearAnchor : off.routerGuide
    for (const field of spec.fields) {
      assert.notDeepEqual(
        managedFieldValue(field, current),
        managedFieldValue(field, flipped),
        `${spec.configId}.${field.path} 未随来源参数 ${field.sourceParam} 变化：契约与 writer 投影不一致`,
      )
    }
  }
})

test('来源参数的具体值逐字落到产物（含派生项的语义）', () => {
  assert.equal(on.nearAnchor.enabled, true)
  assert.equal(on.nearAnchor.params.useCustom, true)
  assert.equal(on.nearAnchor.params.text, 'ANCHOR-ON')
  assert.equal(on.nearAnchor.params.buildPattern, 'BUILD-ON')
  assert.equal(on.nearAnchor.params.complexPattern, 'COMPLEX-ON')
  assert.equal(on.nearAnchor.params.firstTurnBuild, 'FIRST-BUILD-ON')
  assert.equal(on.nearAnchor.params.firstTurnInspect, 'FIRST-INSPECT-ON')
  assert.equal(on.nearAnchor.params.firstTurnDeep, 'FIRST-DEEP-ON')
  assert.equal(off.nearAnchor.enabled, false)
  assert.equal(off.nearAnchor.params.text, 'ANCHOR-OFF')
  assert.equal(on.routerGuide.enabled, true)
  assert.equal(on.routerGuide.params.useCustom, true)
  assert.equal(on.routerGuide.params.text, 'GUIDE-ON')
  assert.equal(on.routerGuide.params.guideWeak, 'WEAK-ON')
  assert.equal(on.routerGuide.params.guideDeep, 'DEEP-ON')
  assert.equal(off.routerGuide.params.text, 'GUIDE-OFF')
  // 模型范围是计算结果：自定义引导全模型生效，自动引导只服务 Flash 家族。
  assert.equal(on.routerGuide.modelScope, 'all')
  assert.equal(off.routerGuide.modelScope, 'flash')
})

test('guideEnabled 缺省时跟随首轮锚定开关（契约的 fallbackNote 与 writer 一致）', () => {
  const inherit = (flags, suffix) => {
    const presetDir = mkdtempSync(join(home, `preset-inherit-${suffix}-`))
    installFixturePreset(presetDir)
    const runtime = runtimeOf(presetDir, suffix, flags)
    delete runtime.guideEnabled
    writePreset('', runtime)
    const configDir = join(presetDir, FIXTURE_PRESET_ID, 'prompt-configs')
    const file = readdirSync(configDir).find((name) => name.endsWith('-router-guide.yml'))
    assert.ok(file, '生成产物里应有 router-guide')
    return parseYaml(readFileSync(join(configDir, file), 'utf8'))
  }
  assert.equal(inherit(true, 'ON').enabled, true, '锚定开启且未显式声明引导开关时引导启用')
  assert.equal(inherit(false, 'OFF').enabled, false, '锚定关闭时引导跟随关闭')
})

test('writer 实际覆写的字段都已登记，未登记字段不会被静默覆盖', () => {
  for (const spec of MANAGED_CONFIG_FIELDS) {
    const current = spec.configId === 'near-anchor' ? on.nearAnchor : on.routerGuide
    const flipped = spec.configId === 'near-anchor' ? off.nearAnchor : off.routerGuide
    const registered = new Set(spec.fields.map((field) => field.path))
    // 顶层受管字段：A/B 之间值不同的顶层键必须已登记。
    for (const key of ['enabled', 'modelScope']) {
      if (current[key] === flipped[key]) continue
      assert.ok(registered.has(key), `${spec.configId}.${key} 被投影但未登记`)
    }
    // params 受管字段：A/B 之间值不同的 params 键必须已登记。
    for (const key of Object.keys(current.params ?? {})) {
      if (JSON.stringify(current.params[key]) === JSON.stringify(flipped.params?.[key])) continue
      assert.ok(registered.has(`params.${key}`), `${spec.configId}.params.${key} 被投影但未登记`)
    }
  }
})
