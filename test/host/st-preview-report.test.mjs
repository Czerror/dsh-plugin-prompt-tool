import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { convertStToPreset, convertStToPresetWithReport, mergeStConversionReports } from '../../src/host/sillytavern.ts'

// DSH_HOME 必须先于 lib 加载设置，避免污染真实用户目录（与 preset-package-import 同款）。
const home = mkdtempSync(join(tmpdir(), 'pt-st-preview-'))
process.env.DSH_HOME = home
const { registerSettingsBridge } = await import('../../lib/index.mjs')

const PREFIX = '/api/prompt-tool/settings'
const PRESETS = join(home, '.agent-presets')

function handlers() {
  const registered = new Map()
  const sctx = {
    settings: { describe: () => [{ ns: 'prompt-tool', value: {}, base: {} }], mutate: async () => {} },
    webServer: { register: ({ path, handler }) => { registered.set(path, handler) } },
    effect: (fn) => fn(),
  }
  registerSettingsBridge(
    { inject: (_deps, cb) => cb(sctx) },
    () => ({ available: true, providers: [] }),
    () => ({ activeSkillsDirs: [], skillCatalog: [] }),
    () => '',
    undefined,
    undefined,
    () => join(PRESETS, 'demo-preset', 'prompt-configs'),
  )
  return registered
}

function fakeReq(body) {
  const payload = Buffer.from(JSON.stringify(body))
  return {
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: 'localhost' },
    [Symbol.asyncIterator]: async function* () { yield payload },
  }
}

function fakeRes() {
  let status = 0
  let body = ''
  return {
    writeHead(code) { status = code },
    end(payload) { body = payload },
    get status() { return status },
    get body() { return body },
  }
}

async function call(endpoint, body) {
  const handler = handlers().get(`${PREFIX}${endpoint}`)
  assert.ok(handler, `${endpoint} 端点应注册`)
  const res = fakeRes()
  await handler(fakeReq(body), res)
  return { status: res.status, payload: JSON.parse(res.body) }
}

/** 最小 ST 响应预设：一个 system 提示 + 一个深度注入降级条目。 */
const stJson = (overrides = {}) => JSON.stringify({
  character_id: 100001,
  prompts: [
    { identifier: 'main', name: '主提示', role: 'system', content: 'MAIN-{{char}}' },
    { identifier: 'deep', name: '深度', role: 'user', content: 'DEEP', injection_position: 1, injection_depth: 3 },
  ],
  ...overrides,
})

test('转换报告给出来源/目标身份、分类与摘要，且 stWarnings 由同一诊断派生', () => {
  const input = {
    name: 'Card',
    prompts: [
      { identifier: 'main', role: 'system', content: 'MAIN', enabled: true },
      { identifier: 'deep', role: 'user', content: 'DEEP', injection_position: 1 },
      { identifier: 'mark', role: 'system', content: 'MARK', marker: true },
      { identifier: 'empty', role: 'user', content: '   ' },
    ],
    extensions: { regex_scripts: [{ content: 'CODE' }] },
  }
  const snapshot = structuredClone(input)
  const { spec, report } = convertStToPresetWithReport(input, 'demo')
  assert.deepEqual(input, snapshot, '转换不修改源对象')
  assert.equal(report.converter, 'st-to-preset/1')
  assert.equal(report.sourceName, 'demo')
  const bySource = new Map(report.entries.map((entry) => [entry.sourceId, entry]))
  assert.equal(bySource.get('main').classification, 'equivalent')
  assert.equal(bySource.get('main').targetId, 'main')
  assert.equal(bySource.get('deep').classification, 'degraded')
  assert.deepEqual(bySource.get('deep').codes, ['depth-collapsed'])
  assert.equal(bySource.get('mark').classification, 'excluded')
  assert.deepEqual(bySource.get('mark').codes, ['marker-dropped'])
  assert.deepEqual(bySource.get('empty').codes, ['empty-content'])
  assert.equal(report.summary.inputs, 4)
  assert.equal(report.summary.converted, spec.promptConfigs.length)
  assert.equal(report.summary.excluded, 2)
  assert.equal(report.summary.degraded, 1)
  assert.equal(report.summary.needsReview, 2, '脚本扩展 + 深度注入两条 warning')
  // 旧字符串表现必须与结构化诊断同源。
  assert.deepEqual(
    spec.meta.stWarnings,
    report.diagnostics.filter((item) => item.severity === 'warning').map((item) => item.message),
  )
  assert.ok(report.diagnostics.every((item) => typeof item.code === 'string' && item.code.length > 0))
})

test('多 prompt_order 组：歧义仍拒绝，显式 characterId 才选择并可追溯', () => {
  const card = {
    prompts: [{ identifier: 'a', role: 'system', content: 'A' }],
    prompt_order: [
      { character_id: 111, order: [{ identifier: 'a', enabled: true }] },
      { character_id: 222, order: [{ identifier: 'a', enabled: false }] },
    ],
  }
  assert.throws(() => convertStToPreset(card, 'ambiguous'), /prompt_order 包含多个角色/)
  const { spec, report } = convertStToPresetWithReport(card, 'picked', { characterId: '222' })
  assert.equal(spec.promptConfigs[0].enabled, false, '选中组的启用状态生效')
  assert.deepEqual(report.orderGroups, [
    { characterId: '111', selected: false, entries: 1 },
    { characterId: '222', selected: true, entries: 1 },
  ])
})

test('报告上限有界，合并报告保留计数并截断条目', () => {
  const many = { entries: Object.fromEntries(Array.from({ length: 700 }, (_, index) => [String(index), {
    uid: index, key: [], content: `E${index}`, constant: true,
  }])) }
  const { report } = convertStToPresetWithReport(many, 'big')
  assert.equal(report.entries.length, 500)
  assert.equal(report.truncated, true)
  assert.equal(report.summary.converted, 700)
  const merged = mergeStConversionReports([report, report])
  assert.equal(merged.entries.length, 500, '合并后条目仍有上限')
  assert.equal(merged.summary.converted, 1400)
  assert.equal(merged.truncated, true)
})

test('importPresetPackage 预览不落盘、返回报告，过期摘要提交被拒且不写盘', async () => {
  const files = [{ path: 'demo/demo.json', content: stJson() }]
  const preview = await call('/import-preset-package', { files, preview: true })
  assert.equal(preview.status, 200)
  assert.equal(preview.payload.value.preview, true)
  assert.equal(typeof preview.payload.value.sourceDigest, 'string')
  assert.equal(preview.payload.value.report.summary.converted > 0, true)
  assert.equal(existsSync(join(PRESETS, 'demo')), false, '预览不得写盘')

  const stale = await call('/import-preset-package', { files, expectedSourceDigest: 'deadbeef' })
  assert.equal(stale.status, 409)
  assert.equal(stale.payload.code, 'preset-preview-stale')
  assert.equal(existsSync(join(PRESETS, 'demo')), false, '过期提交不得写盘')

  const changed = await call('/import-preset-package', {
    files: [{ path: 'demo/demo.json', content: stJson({ prompts: [{ identifier: 'main', role: 'system', content: 'CHANGED' }] }) }],
    expectedSourceDigest: preview.payload.value.sourceDigest,
  })
  assert.equal(changed.status, 409, '换文件后旧摘要失效')

  const commit = await call('/import-preset-package', { files, expectedSourceDigest: preview.payload.value.sourceDigest })
  assert.equal(commit.status, 200)
  assert.equal(commit.payload.value.id, 'demo')
  assert.equal(commit.payload.value.sourceDigest, preview.payload.value.sourceDigest)
  assert.equal(existsSync(join(PRESETS, 'demo', 'preset.yml')), true, '确认提交才写盘')
})

test('importPresetPackage 预览支持显式顺序组，歧义包返回明确错误', async () => {
  const ambiguous = JSON.stringify({
    prompts: [{ identifier: 'a', role: 'system', content: 'A' }],
    prompt_order: [
      { character_id: 111, order: [{ identifier: 'a', enabled: true }] },
      { character_id: 222, order: [{ identifier: 'a', enabled: false }] },
    ],
  })
  const rejected = await call('/import-preset-package', { files: [{ path: 'amb/amb.json', content: ambiguous }], preview: true })
  assert.equal(rejected.status, 400)
  assert.match(rejected.payload.message, /prompt_order/)
  const picked = await call('/import-preset-package', {
    files: [{ path: 'amb/amb.json', content: ambiguous }], preview: true, promptOrderCharacterId: '222',
  })
  assert.equal(picked.status, 200)
  assert.deepEqual(picked.payload.value.report.orderGroups.map((group) => group.selected), [false, true])
  assert.equal(existsSync(join(PRESETS, 'amb')), false)
})

test('charactersImport 预览只转换不写角色库，确认提交才入库', async () => {
  const card = JSON.stringify({ data: { name: 'Ada', description: 'DESC', first_mes: 'HI' } })
  const files = [{ path: 'Ada.json', content: card }]
  const preview = await call('/characters-import', { files, preview: true })
  assert.equal(preview.status, 200)
  assert.equal(preview.payload.value.preview, true)
  assert.equal(preview.payload.value.name.includes('Ada'), true)
  assert.equal(preview.payload.value.report.summary.converted > 0, true)
  const charactersDir = join(PRESETS, 'demo-preset', '.characters')
  assert.equal(existsSync(charactersDir), false, '预览不得写角色库')

  const stale = await call('/characters-import', { files, expectedSourceDigest: 'nope' })
  assert.equal(stale.status, 409)
  const commit = await call('/characters-import', { files, expectedSourceDigest: preview.payload.value.sourceDigest })
  assert.equal(commit.status, 200)
  assert.equal(typeof commit.payload.value.id, 'string')
  assert.equal(existsSync(join(charactersDir, commit.payload.value.id, 'card.json')), true, '确认提交才入库')
})

test.after(() => { rmSync(home, { recursive: true, force: true }) })
