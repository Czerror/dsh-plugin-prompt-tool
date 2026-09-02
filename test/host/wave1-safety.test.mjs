import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 隔离 DSH_HOME：writePreset 模板解析用户预设优先，测试必须隔离。
const home = mkdtempSync(join(tmpdir(), 'pt-w1-home-'))
process.env.DSH_HOME = home
const {
  validateEngineParamValues,
  assertSafeConfigId,
  configFileName,
  loadPresetSpec,
  renderComposition,
  writePreset,
} = await import('../../lib/index.mjs')
const { mergePromptConfigs } = await import('../../lib/preset-core.mjs')

test('validateEngineParamValues：全量类型校验（布尔/数值/字符串/列表/枚举）', () => {
  // 合法值（含 '' = 删键、number 直写）无错误。
  assert.deepEqual(validateEngineParamValues({
    firstTurnAnchor: true,
    modelTemperature: '0.7',
    modelMaxTokens: 8192,
    subagentTemperature: '',
    bootstrapTools: ['bash', 'read'],
    allowKinds: 'near-anchor,router-guide',
    maxDepth: 'provider-managed',
    stages: [{ name: '了解', tools: ['read'] }],
  }), [])
  // 布尔键收窄。
  assert.deepEqual(validateEngineParamValues({ promoteGate: 'yes' }).map((e) => e.key), ['promoteGate'])
  // 数值键非法。
  assert.deepEqual(validateEngineParamValues({ modelTemperature: 'abc' }).map((e) => e.key), ['modelTemperature'])
  assert.deepEqual(validateEngineParamValues({ modelMaxTokens: '-5' }).map((e) => e.key), ['modelMaxTokens'])
  assert.deepEqual(validateEngineParamValues({ bootstrapMaxTokens: 1.5 }).map((e) => e.key), ['bootstrapMaxTokens'])
  // 列表键收窄。
  assert.deepEqual(validateEngineParamValues({ toolFilterAllow: [1, 2] }).map((e) => e.key), ['toolFilterAllow'])
  // maxDepth 枚举收窄。
  assert.deepEqual(validateEngineParamValues({ maxDepth: -1 }).map((e) => e.key), ['maxDepth'])
  // stages 结构校验。
  assert.deepEqual(validateEngineParamValues({ stages: [{ name: '', tools: ['x'] }] }).map((e) => e.key), ['stages'])
  assert.deepEqual(validateEngineParamValues({ stages: [{ name: 'x', tools: 'bash' }] }).map((e) => e.key), ['stages'])
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

test('loadPresetSpec：坏 YAML fail loud 且带文件上下文', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-w1-badyaml-'))
  try {
    writeFileSync(join(dir, 'preset.yml'), 'a: &x 1\nb: *y\n', 'utf8')
    assert.throws(() => loadPresetSpec(dir), /YAML 解析失败/)
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

test('writePreset：恶意 promptConfigs id 物化前 fail loud，不留半成品目录', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-w1-malid-'))
  try {
    const presetDir = join(dir, 'preset')
    assert.throws(
      () => writePreset('PROMPT', {
        presetDir,
        presetOrder: 5,
        promptConfigs: [{ id: '../../evil', strategy: 'static', text: 'x' }],
      }),
      /config id/,
    )
    // 原子物化失败：目标目录不存在（tmp 已清理）。
    assert.equal(existsSync(join(presetDir, 'anchored')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writePreset：13+ 配置生成 4 位零填充文件名，字典序稳定', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-w1-many-'))
  try {
    const presetDir = join(dir, 'preset')
    const many = Array.from({ length: 13 }, (_, index) => ({
      id: `cfg-${String(index).padStart(2, '0')}`,
      strategy: 'static',
      layer: 'system-section',
      text: `内容 ${index}`,
    }))
    writePreset('PROMPT', { presetDir, presetOrder: 5, promptConfigs: many })
    const files = readdirSync(join(presetDir, 'anchored', 'prompt-configs'))
      .filter((name) => name !== 'variables.yml' && name.endsWith('.yml'))
      .sort()
    // 全部 4 位前缀且字典序 = 数值序（00 与 100+ 不串位）。
    for (const name of files) {
      assert.match(name, /^\d{4}-/, `4 位零填充前缀: ${name}`)
    }
    const sorted = [...files].sort()
    assert.deepEqual(files, sorted, '字典序读取与写入序一致')
    const last = files[files.length - 1]
    assert.match(last, /-cfg-12\.yml$/, '第 13 条配置（cfg-12）落在最后')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

rmSync(home, { recursive: true, force: true })





