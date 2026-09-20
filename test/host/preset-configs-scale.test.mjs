// 同层多实例的保存往返（PLAN 验收）：实例编辑 → preset.yml 落盘 → 重读保持数量、
// 身份、顺序与未修改字段；同名局部参数不串值，注释与未知顶层键不被删除。
// 使用隔离 DSH_HOME 与临时预设目录，结束后清理，不触碰真实用户资产。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

const home = mkdtempSync(join(tmpdir(), 'pt-scale-home-'))
process.env.DSH_HOME = home
const { savePresetParams, loadPresetSpec } = await import('../../lib/index.mjs')
test.after(() => rmSync(home, { recursive: true, force: true }))

const PRESET_ID = 'scale-sample'
/** 预设定义：带注释与未知顶层键，用于验证保存不整段覆盖用户内容。 */
const PRESET_YML = [
  '# 顶部注释：保存 promptConfigs 不得删除它',
  `id: ${PRESET_ID}`,
  'name: 规模样本',
  'modules:',
  '  - prompt-config-engine',
  'params:',
  '  injectPrompt: true',
  'unknownFutureKey:',
  '  keep: me',
  '',
].join('\n')

function makePreset() {
  const root = mkdtempSync(join(home, 'presets-'))
  mkdirSync(join(root, PRESET_ID), { recursive: true })
  writeFileSync(join(root, PRESET_ID, 'preset.yml'), PRESET_YML, 'utf8')
  return root
}

/** 合成样本：消息批层 120 张（启用 18，含一条复制产物）+ 系统段层 64 张（启用 4）。 */
function syntheticSample() {
  const preStep = Array.from({ length: 119 }, (_, index) => ({
    id: `pre-${String(index).padStart(3, '0')}`,
    name: `消息批 ${index}`,
    layer: 'pre-step',
    strategy: 'static',
    order: index * 10,
    enabled: index < 18,
    text: `消息批正文 ${index}`,
    variables: { slot: `pre-${index}`, shared: `pre-value-${index}` },
    params: { maxOutputChars: 1000 + index, marker: `pre-${index}` },
  }))
  preStep.push({
    id: 'pre-005-copy',
    name: '消息批 5（复制）',
    layer: 'pre-step',
    strategy: 'static',
    order: 1190,
    enabled: false,
    text: '复制正文',
    variables: { slot: 'copy', shared: 'copy-value' },
    params: { maxOutputChars: 1005 },
  })
  const systemSections = Array.from({ length: 64 }, (_, index) => ({
    id: `sys-${String(index).padStart(3, '0')}`,
    name: `系统段 ${index}`,
    layer: 'system-section',
    strategy: 'static',
    order: index * 10,
    enabled: index < 4,
    text: `系统段正文 ${index}`,
    variables: { shared: `sys-value-${index}` },
    params: { section: index, shared: `sys-value-${index}` },
  }))
  return [...preStep, ...systemSections]
}

test('184 卡落盘往返：数量、身份、顺序与未修改字段保持，注释与未知键不动', () => {
  const root = makePreset()
  const configs = syntheticSample()
  assert.equal(configs.length, 184)
  savePresetParams(root, PRESET_ID, undefined, configs)

  const file = join(root, PRESET_ID, 'preset.yml')
  const raw = readFileSync(file, 'utf8')
  assert.ok(raw.includes('# 顶部注释：保存 promptConfigs 不得删除它'), '保留文档注释')
  assert.deepEqual(parseYaml(raw).unknownFutureKey, { keep: 'me' }, '未知顶层键不被删除')
  assert.equal(parseYaml(raw).params.injectPrompt, true, '未改动的 params 保持')

  const written = parseYaml(raw).promptConfigs
  assert.equal(written.length, 184, '实例数量不折叠')
  assert.deepEqual(written.map((config) => config.id), configs.map((config) => config.id), '身份与声明顺序逐条保持')
  for (const config of written) {
    const original = configs.find((item) => item.id === config.id)
    assert.deepEqual(config, original, `${config.id} 往返后字段逐字一致`)
  }
  // 同名局部参数与同名变量在不同实例里各自保留，不互相覆盖。
  const preShared = written.find((config) => config.id === 'pre-007')
  const sysShared = written.find((config) => config.id === 'sys-007')
  assert.equal(preShared.variables.shared, 'pre-value-7')
  assert.equal(sysShared.variables.shared, 'sys-value-7')
  assert.equal(preShared.params.marker, 'pre-7')
  assert.equal(sysShared.params.shared, 'sys-value-7')
})

test('184 卡落盘往返：loadPresetSpec 走 host 解析链读到同一批实例', () => {
  const root = makePreset()
  const configs = syntheticSample()
  savePresetParams(root, PRESET_ID, undefined, configs)
  const spec = loadPresetSpec(join(root, PRESET_ID))
  assert.equal(spec.promptConfigs.length, 184)
  assert.equal(spec.promptConfigs.filter((config) => config.layer === 'pre-step').length, 120)
  assert.equal(spec.promptConfigs.filter((config) => config.layer === 'system-section').length, 64)
  assert.equal(spec.promptConfigs.filter((config) => config.enabled === true).length, 22, '启用态按各实例自身保存')
  // 层内 order 全体唯一：保存不重排、不归一化成层默认序。
  for (const layer of ['pre-step', 'system-section']) {
    const orders = spec.promptConfigs.filter((config) => config.layer === layer).map((config) => config.order)
    assert.equal(new Set(orders).size, orders.length, `${layer} 的 order 在层内唯一`)
  }
})

test('第二次编辑只替换 promptConfigs，其他实例与顶层数据不受影响', () => {
  const root = makePreset()
  const configs = syntheticSample()
  savePresetParams(root, PRESET_ID, undefined, configs)
  // 复制一张 + 删除一张后再次保存：其余实例逐条保持。
  const edited = [
    ...configs.filter((config) => config.id !== 'sys-000'),
    { ...configs.find((config) => config.id === 'sys-001'), id: 'sys-001-copy', order: 10_000 },
  ]
  savePresetParams(root, PRESET_ID, undefined, edited)
  const written = parseYaml(readFileSync(join(root, PRESET_ID, 'preset.yml'), 'utf8')).promptConfigs
  assert.equal(written.length, 184)
  assert.equal(written.some((config) => config.id === 'sys-000'), false)
  assert.equal(written.at(-1).id, 'sys-001-copy')
  for (const config of written) {
    if (config.id === 'sys-001-copy') continue
    assert.deepEqual(config, edited.find((item) => item.id === config.id), `${config.id} 未被本次编辑改写`)
  }
  assert.deepEqual(parseYaml(readFileSync(join(root, PRESET_ID, 'preset.yml'), 'utf8')).unknownFutureKey, { keep: 'me' })
})
