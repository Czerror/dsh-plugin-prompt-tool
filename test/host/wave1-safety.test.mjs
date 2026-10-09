import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'

// 隔离 DSH_HOME：writeModule 模板解析用户模块优先，测试必须隔离。
const home = mkdtempSync(join(tmpdir(), 'pt-w1-home-'))
process.env.DSH_HOME = home
const {
  validateEngineParamValues,
  assertSafeConfigId,
  configFileName,
  loadModuleSpec,
  renderComposition,
  DEFAULT_MODULE_ID,
} = await import('../../lib/index.mjs')
const { writeModule } = await import('../../src/host/write-module.ts')
const { mergePromptConfigs } = await import('../../src/host/prompt-configs.ts')

test('validateEngineParamValues：全量类型校验（布尔/数值/字符串/列表/枚举）', () => {
  // 合法值（含 '' = 删键、number 直写）无错误。
  // B7 T3：原用例里的 bootstrapTools / allowKinds / stages / bootstrapMaxTokens 已随七个专用能力删除，
  // 换成本批存活的同 kind 键。
  assert.deepEqual(validateEngineParamValues({
    firstTurnAnchor: true,
    modelTemperature: '0.7',
    modelMaxTokens: 8192,
    subagentTemperature: '',
    customToolRequireApproval: ['shell', 'fs'],
    buildPattern: '^(写|实现)',
    maxDepth: 'provider-managed',
  }), [])
  // 布尔键收窄。
  assert.deepEqual(validateEngineParamValues({ instructionHint: 'yes' }).map((e) => e.key), ['instructionHint'])
  // 数值键非法。
  assert.deepEqual(validateEngineParamValues({ modelTemperature: 'abc' }).map((e) => e.key), ['modelTemperature'])
  assert.deepEqual(validateEngineParamValues({ modelMaxTokens: '-5' }).map((e) => e.key), ['modelMaxTokens'])
  assert.deepEqual(validateEngineParamValues({ subagentMaxTokens: 1.5 }).map((e) => e.key), ['subagentMaxTokens'])
  // 列表键收窄。
  assert.deepEqual(validateEngineParamValues({ customToolRequireApproval: [1, 2] }).map((e) => e.key), ['customToolRequireApproval'])
  // maxDepth 枚举收窄。
  assert.deepEqual(validateEngineParamValues({ maxDepth: -1 }).map((e) => e.key), ['maxDepth'])
  // 正则键结构校验（pattern kind）。
  assert.deepEqual(validateEngineParamValues({ buildPattern: '(' }).map((e) => e.key), ['buildPattern'])
  assert.deepEqual(validateEngineParamValues({ complexPattern: 'a{2,1}' }).map((e) => e.key), ['complexPattern'])
  // 未知键（旧内容别名等不兼容键）响亮失败。
  const unknown = validateEngineParamValues({ guideComplexPattern: 'x' })
  assert.equal(unknown.length, 1)
  assert.match(unknown[0].message, /guideComplexPattern/)
})

test('assertSafeConfigId / configFileName：路径穿越与 Windows 保留字符拒绝，4 位零填充前缀', () => {
  assert.equal(configFileName(0, 'near-anchor'), '0000-near-anchor.yml')
  assert.equal(configFileName(12, 'x'), '0012-x.yml')
  assert.equal(configFileName(120, 'x'), '0120-x.yml')
  for (const bad of ['', '.', '..', '../../evil', 'a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a|b', 'a\0b']) {
    assert.throws(() => assertSafeConfigId(bad), TypeError, `应拒绝非法 id: ${JSON.stringify(bad)}`)
    assert.throws(() => configFileName(1, bad), TypeError)
  }
  // 多字节（ST 导入 id 含中文）与点号小写组合允许。
  assert.equal(configFileName(1, 'beta-2.42'), '0001-beta-2.42.yml')
  assert.equal(configFileName(1, '夏瑾'), '0001-夏瑾.yml')
})

test('mergePromptConfigs：单源数组内重复 ID 合并前拒绝；跨源覆盖语义保留', () => {
  assert.throws(
    () => mergePromptConfigs([
      { id: 'a', strategy: 'static', text: 'A' },
      { id: 'a', strategy: 'static', text: 'A2' },
    ]),
    /duplicate prompt config id/,
  )
  // 跨源（默认 < 模板 < settings）同名覆盖是设计语义，不拒绝。
  const merged = mergePromptConfigs(
    [{ id: 'a', strategy: 'static', text: 'default' }],
    [{ id: 'a', strategy: 'static', text: 'override' }],
  )
  assert.deepEqual(merged.map((spec) => spec.id), ['a'])
  assert.equal(merged[0].text, 'override')
})

test('loadModuleSpec：坏 YAML fail loud 且带文件上下文', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-w1-badyaml-'))
  try {
    const moduleDir = join(dir, 'broken')
    mkdirSync(moduleDir)
    const source = 'id: broken\nmodules: []\na: &x 1\nb: *y\n'
    writeFileSync(join(moduleDir, 'module.yml'), source, 'utf8')
    assert.throws(() => loadModuleSpec(moduleDir), /YAML|alias|定义无效/)
    assert.equal(readFileSync(join(moduleDir, 'module.yml'), 'utf8'), source)
    assert.equal(existsSync(join(moduleDir, 'rules')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('renderComposition：composition 相对路径越界模板目录 fail loud', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-w1-cont-'))
  try {
    assert.throws(
      () => renderComposition({ id: 'x', composition: './../../etc/passwd.yml' }, {}, dir),
      /escapes template dir/,
    )
    // 合法相对路径正常读取（fixture 内）。
    writeFileSync(join(dir, 'ok.yml'), '- id: row\n', 'utf8')
    const out = renderComposition({ id: 'x', composition: './ok.yml' }, {}, dir)
    assert.match(out, /id: row/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('renderComposition：命名组合只允许 source/local 或 library 的裸模块名', () => {
  assert.throws(
    () => renderComposition({ id: 'x', composition: '../outside' }, {}),
    /bare library name/,
  )
})

test('writeModule：恶意规则身份经统一编译器拒绝，不留半成品目录', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-w1-malid-'))
  try {
    const moduleDir = join(dir, 'preset')
    const sourceDir = join(moduleDir, DEFAULT_MODULE_ID)
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'module.yml'), JSON.stringify({ id: DEFAULT_MODULE_ID, modules: [], rules: [{ id: '../../evil', then: [{ id: 'inject', kind: 'inject-text', config: { text: 'x' } }] }] }))
    assert.throws(
      () => writeModule({ modulesRoot: moduleDir, moduleId: DEFAULT_MODULE_ID, targetModuleId: 'safe-output' }),
      /rule id/,
    )
    // 原子物化失败：目标目录不存在（tmp 已清理）。
    assert.equal(existsSync(join(moduleDir, 'safe-output')), false)
    assert.equal(existsSync(join(dir, 'evil')), false)
    assert.deepEqual(readdirSync(moduleDir), [DEFAULT_MODULE_ID], '源保留且无临时半成品')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writeModule：规则裸文件名与状态清单序号独立', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-w1-many-'))
  try {
    const moduleDir = join(dir, 'preset')
    const many = Array.from({ length: 13 }, (_, index) => ({
      id: `cfg-${String(index).padStart(2, '0')}`,
      strategy: 'static',
      layer: 'system-section',
      text: `内容 ${index}`,
    }))
    mkdirSync(join(moduleDir, DEFAULT_MODULE_ID), { recursive: true })
    writeFileSync(join(moduleDir, DEFAULT_MODULE_ID, 'module.yml'), JSON.stringify({ id: DEFAULT_MODULE_ID, modules: [], rules: many.map(config => ({ id: config.id, layer: config.layer, then: [{ id: 'inject', kind: 'inject-text', config }] })) }))
    writeModule({ modulesRoot: moduleDir, moduleId: DEFAULT_MODULE_ID })
    const rulesDir = join(moduleDir, DEFAULT_MODULE_ID, 'rules')
    const files = readdirSync(rulesDir).filter(name => name.startsWith('cfg-')).sort()
    assert.deepEqual(files, many.map(config => `${config.id}.yml`))
    const settingsFile = join(rulesDir, '_settings.yml')
    const before = readFileSync(settingsFile, 'utf8')
    const settings = parse(before)
    assert.deepEqual(Object.entries(settings.rules).map(([id, state]) => [id, state.order]), many.map((config, index) => [config.id, index * 10]))
    assert.equal(existsSync(join(moduleDir, DEFAULT_MODULE_ID, 'configs')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test.after(() => rmSync(home, { recursive: true, force: true }))



