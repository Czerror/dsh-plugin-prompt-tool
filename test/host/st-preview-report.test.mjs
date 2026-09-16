import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { convertStToPreset, convertStToPresetWithReport, mergeStConversionReports } from '../../src/host/sillytavern.ts'

// DSH_HOME 必须先于 lib 加载设置，避免污染真实用户目录（与 preset-package-import 同款）。
const home = mkdtempSync(join(tmpdir(), 'pt-st-preview-'))
process.env.DSH_HOME = home
const { registerSettingsBridge } = await import('../../lib/index.mjs')

const PREFIX = '/api/prompt-tool/settings'
const PRESETS = join(home, '.agent-presets')

function handlers(sessions = new Map(), hooks = {}) {
  const registered = new Map()
  const sctx = {
    settings: { describe: () => [{ ns: 'prompt-tool', value: {}, base: {} }], mutate: async () => {} },
    webServer: { register: ({ path, handler }) => { registered.set(path, handler) } },
    agents: { get: (id) => sessions.get(id) },
    tools: { schemas: () => [] },
    get: () => undefined,
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
    undefined,
    undefined,
    (id) => { hooks.materialized = [...(hooks.materialized ?? []), id] },
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

async function call(endpoint, body, options = {}) {
  const handler = handlers(options.sessions, options.hooks).get(`${PREFIX}${endpoint}`)
  assert.ok(handler, `${endpoint} 端点应注册`)
  const res = fakeRes()
  const req = fakeReq(body)
  if (options.remoteAddress !== undefined) req.socket.remoteAddress = options.remoteAddress
  if (options.method !== undefined) req.method = options.method
  await handler(req, res)
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
  assert.equal(report.converter, 'st-to-preset/3')
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

  const stale = await call('/import-preset-package', { files, expectedSourceDigest: '0'.repeat(64) })
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

test('T03 预览先给顺序组候选，选组后重新预览才 ready；带选组的无凭据提交被拒', async () => {
  const ambiguous = JSON.stringify({
    prompts: [{ identifier: 'a', role: 'system', content: 'A' }],
    prompt_order: [
      { character_id: 111, order: [{ identifier: 'a', enabled: true }] },
      { character_id: 222, order: [{ identifier: 'a', enabled: false }] },
    ],
  })
  const files = [{ path: 'amb/amb.json', content: ambiguous }]
  // 首轮预览：多组且无法明确对应 → 只回候选，不宣称已转换、不给写入凭据。
  const candidates = await call('/import-preset-package', { files, preview: true })
  assert.equal(candidates.status, 200)
  assert.equal(candidates.payload.value.state, 'needs-order-selection')
  assert.equal(candidates.payload.value.sourceName, 'amb.json')
  assert.deepEqual(candidates.payload.value.candidates, [
    { characterId: '111', entries: 1 },
    { characterId: '222', entries: 1 },
  ])
  assert.equal(candidates.payload.value.sourceDigest, undefined, '候选状态没有可用凭据')
  assert.equal(candidates.payload.value.previewRevision, undefined)
  assert.equal(candidates.payload.value.report, undefined, '候选状态不宣称已转换')
  assert.equal(existsSync(join(PRESETS, 'amb')), false)

  // 选组后重新预览：ready + 报告 + 版本凭据。
  const picked = await call('/import-preset-package', { files, preview: true, promptOrderCharacterId: '222' })
  assert.equal(picked.status, 200)
  assert.equal(picked.payload.value.state, 'ready')
  assert.deepEqual(picked.payload.value.report.orderGroups.map((group) => group.selected), [false, true])
  assert.match(picked.payload.value.previewRevision, /^[0-9a-f]{64}$/)
  assert.equal(existsSync(join(PRESETS, 'amb')), false)

  // 旧调用只带文件摘要、却要求新的选组覆盖：不授予选组保证，要求重新预览。
  const noRevision = await call('/import-preset-package', { files, promptOrderCharacterId: '222' })
  assert.equal(noRevision.status, 409)
  assert.equal(noRevision.payload.code, 'preset-preview-stale')

  // 无选组歧义、无版本凭据的旧直连提交仍按文件摘要工作（兼容既有调用）。
  const legacy = await call('/import-preset-package', {
    files: [{ path: 'single/single.json', content: JSON.stringify({ prompts: [{ identifier: 'a', role: 'system', content: 'A', enabled: true }] }) }],
  })
  assert.equal(legacy.status, 200)
  assert.equal(existsSync(join(PRESETS, 'single', 'preset.yml')), true)

  // 提交仍拒绝歧义。
  const commit = await call('/import-preset-package', { files })
  assert.equal(commit.status, 400)
  assert.match(commit.payload.message, /顺序组|prompt_order/)
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

  const stale = await call('/characters-import', { files, expectedSourceDigest: 'f'.repeat(64) })
  assert.equal(stale.status, 409)
  const commit = await call('/characters-import', { files, expectedSourceDigest: preview.payload.value.sourceDigest })
  assert.equal(commit.status, 200)
  assert.equal(typeof commit.payload.value.id, 'string')
  assert.equal(existsSync(join(charactersDir, commit.payload.value.id, 'card.json')), true, '确认提交才入库')
})

test('T02 两个导入端点对缺省与非法类型分开处理：非法 400、过期 409，且零写盘零重建', async () => {
  const files = [{ path: 'typed/typed.json', content: stJson() }]
  const hooks = {}
  const options = { hooks }
  assert.equal(existsSync(join(PRESETS, 'typed')), false)

  // preview：字符串 "true"、数值、null、数组、对象都不是"预览"，也不是"提交"。
  for (const value of ['true', 1, 0, null, [], {}]) {
    const res = await call('/import-preset-package', { files, preview: value }, options)
    assert.equal(res.status, 400, `preset preview=${JSON.stringify(value)} 必须 400`)
    assert.equal(res.payload.code, 'preset-package-invalid')
  }
  // expectedSourceDigest：空值/错误长度/错误字符/类型错误都不能被当作"未提供"。
  for (const value of ['', 'deadbeef', '0'.repeat(63), 'z'.repeat(64), 64, null, {}]) {
    const res = await call('/import-preset-package', { files, expectedSourceDigest: value }, options)
    assert.equal(res.status, 400, `preset digest=${JSON.stringify(value)} 必须 400`)
  }
  // promptOrderCharacterId：不使用 truthy 转换，也不吞非法选项后回落默认组。
  for (const value of ['', 222, 0, null, {}, 'x'.repeat(129)]) {
    const res = await call('/import-preset-package', { files, promptOrderCharacterId: value }, options)
    assert.equal(res.status, 400, `promptOrderCharacterId=${JSON.stringify(value)} 必须 400`)
  }
  // files 容器与条目类型 fail closed（不再静默丢弃后按"缺少定义文件"处理）。
  assert.equal((await call('/import-preset-package', { files: 'x' }, options)).status, 400)
  assert.equal((await call('/import-preset-package', { files: ['x'] }, options)).status, 400)
  assert.equal((await call('/import-preset-package', { files: [{ path: 'a.json', content: 5 }] }, options)).status, 400)
  assert.equal((await call('/import-preset-package', { files: [{ path: 'a.json' }] }, options)).status, 400, '条目缺 content 也必须 400')
  assert.equal((await call('/import-preset-package', { files: [{ path: '../a.json', content: '{}' }] }, options)).status, 400)

  // 角色卡端点同约束。
  const cardFiles = [{ path: 'Ada.json', content: '{"data":{"name":"Ada"}}' }]
  for (const value of ['true', 1, null, [], {}]) {
    const res = await call('/characters-import', { files: cardFiles, preview: value }, options)
    assert.equal(res.status, 400, `characters preview=${JSON.stringify(value)} 必须 400`)
    assert.equal(res.payload.code, 'characters-rejected')
  }
  for (const value of ['', 'nope', 64, null]) {
    const res = await call('/characters-import', { files: cardFiles, expectedSourceDigest: value }, options)
    assert.equal(res.status, 400, `characters digest=${JSON.stringify(value)} 必须 400`)
  }
  assert.equal((await call('/characters-import', { files: cardFiles.concat([{ path: 'b.json', content: 1 }]) }, options)).status, 400)
  assert.equal((await call('/characters-import', { files: [{ path: '../escape.json', content: '{}' }] }, options)).status, 400)

  // 错误请求对目录树、备份与重建回调都没有副作用。
  assert.equal(existsSync(join(PRESETS, 'typed')), false, '非法请求零写盘')
  assert.equal(hooks.materialized, undefined, '非法请求不触发重建')

  // 合法语义保持：显式 false = 提交，true = 只读预览，缺省 = 旧直连提交。
  const preview = await call('/import-preset-package', { files, preview: true }, options)
  assert.equal(preview.status, 200)
  assert.equal(existsSync(join(PRESETS, 'typed')), false, '预览不落盘')
  const commit = await call('/import-preset-package', { files, preview: false, expectedSourceDigest: preview.payload.value.sourceDigest }, options)
  assert.equal(commit.status, 200)
  assert.deepEqual(hooks.materialized, ['typed'], '提交触发一次重建')
  assert.equal(existsSync(join(PRESETS, 'typed', 'preset.yml')), true)
  const legacy = await call('/import-preset-package', { files: [{ path: 'legacy/legacy.json', content: stJson() }] }, options)
  assert.equal(legacy.status, 200)
  assert.equal(existsSync(join(PRESETS, 'legacy', 'preset.yml')), true, '缺省 preview 的旧调用仍可提交')
})

test('T04 预览版本绑定文件、选组与目标身份：任一变化即 409 且零写盘', async () => {
  const files = [{ path: 'rev/rev.json', content: stJson() }]
  const preview = await call('/import-preset-package', { files, preview: true })
  assert.equal(preview.payload.value.state, 'ready')
  const { sourceDigest, previewRevision } = preview.payload.value
  assert.match(previewRevision, /^[0-9a-f]{64}$/)

  const target = join(PRESETS, 'rev')
  assert.equal(existsSync(target), false, '首次预览时目标不存在')
  const commit = await call('/import-preset-package', { files, expectedSourceDigest: sourceDigest, expectedPreviewRevision: previewRevision })
  assert.equal(commit.status, 200)
  assert.equal(existsSync(join(target, 'preset.yml')), true)

  // 目标内容参与身份：从"不存在"到"存在"必须改变版本，反之无法发现覆盖风险。
  const afterCommit = await call('/import-preset-package', { files, preview: true })
  assert.notEqual(afterCommit.payload.value.previewRevision, previewRevision, '目标已存在 → 版本必须不同')
  const replayed = await call('/import-preset-package', { files, expectedSourceDigest: sourceDigest, expectedPreviewRevision: previewRevision })
  assert.equal(replayed.status, 409, '旧版本（目标尚不存在时取得）不得再覆盖已存在的目标')
  assert.equal(replayed.payload.code, 'preset-preview-stale')

  // 预览期间用户编辑了目标 → 旧版本失配，零写盘。
  const freshRevision = afterCommit.payload.value.previewRevision
  const marker = join(target, 'prompt-configs', 'user-edit.yml')
  mkdirSync(dirname(marker), { recursive: true })
  writeFileSync(marker, 'id: user-edit\n', 'utf8')
  const edited = await call('/import-preset-package', { files, expectedSourceDigest: sourceDigest, expectedPreviewRevision: freshRevision })
  assert.equal(edited.status, 409, '目标被改动后旧预览不得写入')
  assert.equal(readFileSync(marker, 'utf8'), 'id: user-edit\n', '失败提交不动用户改动')

  // 换文件内容 → 文件摘要与版本同时失配。
  const changed = await call('/import-preset-package', {
    files: [{ path: 'rev/rev.json', content: stJson({ prompts: [{ identifier: 'main', role: 'system', content: 'CHANGED' }] }) }],
    expectedSourceDigest: sourceDigest,
    expectedPreviewRevision: freshRevision,
  })
  assert.equal(changed.status, 409)

  // 换选组 → 版本失配（多组输入分别预览两个组）。
  const multi = JSON.stringify({
    prompts: [{ identifier: 'a', role: 'system', content: 'A', enabled: true }],
    prompt_order: [
      { character_id: 111, order: [{ identifier: 'a', enabled: true }] },
      { character_id: 222, order: [{ identifier: 'a', enabled: false }] },
    ],
  })
  const multiFiles = [{ path: 'multi/multi.json', content: multi }]
  const groupA = await call('/import-preset-package', { files: multiFiles, preview: true, promptOrderCharacterId: '111' })
  const groupB = await call('/import-preset-package', { files: multiFiles, preview: true, promptOrderCharacterId: '222' })
  assert.notEqual(groupA.payload.value.previewRevision, groupB.payload.value.previewRevision, '选组参与版本')
  const crossGroup = await call('/import-preset-package', {
    files: multiFiles,
    promptOrderCharacterId: '222',
    expectedSourceDigest: groupB.payload.value.sourceDigest,
    expectedPreviewRevision: groupA.payload.value.previewRevision,
  })
  assert.equal(crossGroup.status, 409, '用 A 组的凭据提交 B 组必须被拒')
  assert.equal(existsSync(join(PRESETS, 'multi')), false, '失配提交零写盘')

  // 同组凭据可正常提交，且提交结果与预览一致。
  const matched = await call('/import-preset-package', {
    files: multiFiles,
    promptOrderCharacterId: '222',
    expectedSourceDigest: groupB.payload.value.sourceDigest,
    expectedPreviewRevision: groupB.payload.value.previewRevision,
  })
  assert.equal(matched.status, 200)
  const written = parseYaml(readFileSync(join(PRESETS, 'multi', 'preset.yml'), 'utf8'))
  assert.equal(written.promptConfigs.find((config) => config.id === 'a').enabled, false, '写入结果与所选组一致')
})

test('T05 多文件合并的最终 id 与报告同源：跨文件重名、既有后缀与 excluded 条目', async () => {
  const one = JSON.stringify({
    prompts: [
      { identifier: 'same', role: 'system', content: 'A', enabled: true },
      { identifier: 'mark', role: 'system', content: 'MARK', marker: true },
    ],
  })
  const two = JSON.stringify({
    prompts: [
      { identifier: 'same', role: 'system', content: 'B', enabled: true },
      { identifier: 'same-2', role: 'system', content: 'C', enabled: true },
    ],
  })
  const files = [{ path: 'multi/one.json', content: one }, { path: 'multi/two.json', content: two }]
  const preview = await call('/import-preset-package', { files, preview: true })
  assert.equal(preview.status, 200)
  const report = preview.payload.value.report
  assert.match(preview.payload.value.previewRevision, /^[0-9a-f]{64}$/)

  // 报告里的目标身份必须与真实写盘结果一致（后缀只由合并分配一次）。
  const commit = await call('/import-preset-package', {
    files,
    preview: false,
    expectedSourceDigest: preview.payload.value.sourceDigest,
    expectedPreviewRevision: preview.payload.value.previewRevision,
  })
  assert.equal(commit.status, 200)
  const presetId = commit.payload.value.id
  const written = parseYaml(readFileSync(join(PRESETS, presetId, 'preset.yml'), 'utf8'))
  const writtenIds = written.promptConfigs.map((config) => config.id)
  assert.deepEqual(writtenIds, ['same', 'same-2', 'same-2-2'], '跨文件重名与既有后缀都由合并分配唯一 id')

  const targets = report.entries.filter((entry) => entry.classification !== 'excluded').map((entry) => entry.targetId)
  assert.deepEqual(targets, ['same', 'same-2', 'same-2-2'], '每个非排除条目都指向真实存在的最终配置')
  for (const targetId of targets) assert.ok(writtenIds.includes(targetId), `${targetId} 必须命中写盘产物`)

  // 源身份与目标身份分字段：来源文件名 + 来源序号可定位，excluded 条目没有伪目标。
  assert.deepEqual(report.entries.map((entry) => entry.sourceFileIndex), [0, 0, 1, 1])
  assert.deepEqual(report.entries.map((entry) => entry.sourceName), ['one.json', 'one.json', 'two.json', 'two.json'])
  const excluded = report.entries.find((entry) => entry.classification === 'excluded')
  assert.equal(excluded.sourceId, 'mark')
  assert.equal(excluded.targetId, undefined, '被排除条目不得伪造目标身份')
  assert.deepEqual(excluded.codes, ['marker-dropped'])
  assert.equal(report.summary.converted, writtenIds.length, '全量计数不被展示截断改变')
})

test('T08 外部引擎交权给 bundle 协调器后，bridge 读到非空 committed 诊断', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { createScope } = await import('@deepseek-ai/dsh-scope')
  const { agentEvents } = await import('@deepseek-ai/dsh-agent')
  const { installPreStepCoordinator } = await import('../../lib/index.mjs')
  const { applyPromptConfigs, createPromptConfigs } = await import('../../engine/prompt-config-engine.mjs')

  const app = new Context()
  installPreStepCoordinator(app, { collectFiles: () => [] })
  const session = { id: 'live-wb', header: { delegationDepth: 0 }, snapshotEvents: () => [] }
  const agent = { session, options: { model: 'pro' } }
  const scope = createScope(app, agent)
  agent.ctx = scope.ctx

  // 「外部引擎」= 物化 .engine 行：把世界书来源注册给 bundle 协调器，实际执行由协调器完成。
  const spec = convertStToPreset({ data: {
    name: 'Probe',
    character_book: { entries: [{ uid: 1, key: [], content: 'LORE', constant: true, disable: false }] },
  } }, 'probe')
  applyPromptConfigs(scope.ctx, createPromptConfigs(spec.promptConfigs), { prepend: true, sourceId: 'preset:live' })
  const claimed = [{ id: 'u1', role: 'user', content: [{ type: 'text', text: 'N' }], source: { kind: 'user' } }]
  const decision = await agentEvents(app, agent).waterfall(
    'agent/pre-step',
    { messages: claimed, turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: claimed }),
  )
  assert.ok(decision.messages.some((message) => message.source?.plugin?.startsWith('lore-')), '真实注入发生一次')

  // bridge（同一 bundle 的端点）读取该会话：记录来自同一次真实求值路径。
  const sessions = new Map([['live-wb', { session }]])
  const live = await call('/world-book-diagnostics', { sessionId: 'live-wb' }, { sessions })
  assert.equal(live.status, 200)
  assert.equal(live.payload.value.evaluated, true, '已求值与会话未求值必须可区分')
  assert.ok(live.payload.value.records.length > 0, '非空诊断（不是只在测试里断言两端各自为空）')
  assert.ok(live.payload.value.records.some((record) => record.stage === 'committed'), '含执行器 commit 后的已注入记录')
  assert.ok(live.payload.value.records.some((record) => record.stage === 'selected'))
  assert.equal(live.payload.value.step, 1)

  // 重复读取不变、不触发重新求值；其他会话不会读到这份记录。
  const again = await call('/world-book-diagnostics', { sessionId: 'live-wb' }, { sessions })
  assert.deepEqual(again.payload.value.records, live.payload.value.records)
  const other = await call('/world-book-diagnostics', { sessionId: 'cold' }, { sessions })
  assert.deepEqual(other.payload.value.records, [])
  assert.equal(other.payload.value.evaluated, false)
  await scope.dispose()
})

test.after(() => { rmSync(home, { recursive: true, force: true }) })

test('worldBookDiagnostics 端点只读、按会话隔离并拒绝非 loopback/错误方法', async () => {
  const session = { id: 'live', header: {}, snapshotEvents: () => [] }
  const sessions = new Map([['live', { session }]])
  // lib 是打包产物，其引擎模块实例与本测试导入的源码实例不同；这里只断言端点契约与隔离性，
  // 「引擎真实记录」由 test/engine/st-world-book.test.mjs 的 lastWorldBookDiagnostics 断言覆盖。
  const res = await call('/world-book-diagnostics', { sessionId: 'live' }, { sessions })
  assert.equal(res.status, 200)
  assert.deepEqual(res.payload.value.records, [], '无记录时返回空集合而不是报错')
  assert.equal(res.payload.value.truncated, false)
  assert.equal(res.payload.value.evaluated, false, '未知会话不伪报已求值')

  const unknown = await call('/world-book-diagnostics', { sessionId: 'missing' }, { sessions })
  assert.deepEqual(unknown.payload.value.records, [], '未知会话不返回其他会话记录')
  const anonymous = await call('/world-book-diagnostics', {}, { sessions })
  assert.deepEqual(anonymous.payload.value.records, [], '缺 sessionId 时返回空集合')
  const remote = await call('/world-book-diagnostics', { sessionId: 'live' }, { sessions, remoteAddress: '10.0.0.5' })
  assert.equal(remote.status, 403, '非 loopback 拒绝')
  const wrongMethod = await call('/world-book-diagnostics', { sessionId: 'live' }, { sessions, method: 'GET' })
  assert.equal(wrongMethod.status, 405)
})
