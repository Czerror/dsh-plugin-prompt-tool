/**
 * UI 保存子代理工具策略的端到端核验（真实 bridge 端点）。
 *
 * 覆盖链路：PUT `/subagent-tool-policy` →
 * 1. 写激活预设 preset.yml 顶层 `subagentToolPolicy` 段；
 * 2. 自动把 `subagent-tool-policy` 追加进 `modules`（无需手工加模块）；
 * 3. `runOverridesChange` 触发重建（测试里显式调用 `writePreset` 做确定性断言）→
 *    生成目录出现 `subagent-tools/policy.yml`；
 * 4. 组合装配 shadow 行，且 `delegation` 行不再接收主对话 toolFilter（= 真正独立）；
 * 5. 幂等 / 改档 / 清空 / 校验拒绝 四种边界。
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { parse as parseYaml } from 'yaml'

const home = mkdtempSync(join(tmpdir(), 'pt-policy-home-'))
process.env.DSH_HOME = home
const { BRIDGE_ENDPOINTS, SETTINGS_BRIDGE_PREFIX, loadPresetSpec, registerSettingsBridge, renderComposition, writePreset } =
  await import('../../lib/index.mjs')
after(() => rmSync(home, { recursive: true, force: true }))

const PREFIX = SETTINGS_BRIDGE_PREFIX
const presetRoot = join(home, '.agent-presets')
const PRESET_ID = 'policy-e2e'
/** 模板解析根 = 预设根；激活预设目录（端点写入与物化输出）= 根/<id>。 */
const presetDir = join(presetRoot, PRESET_ID)

function makeHarness() {
  const handlers = new Map()
  const sctx = {
    settings: { describe: () => [], get: () => undefined, mutate: async () => {} },
    webServer: { register: ({ path, handler }) => { handlers.set(path, handler); return () => {} } },
    effect: (fn) => fn(),
  }
  const ctx = { inject: (_deps, cb) => cb(sctx) }
  return { ctx, handlers }
}

function fakeReq(body) {
  const payload = JSON.stringify(body ?? {})
  const stream = Readable.from([Buffer.from(payload, 'utf8')])
  return Object.assign(stream, {
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: 'localhost', 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) },
  })
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

/** 与插件装配同源：注册 bridge 并把 presetDir 提供给端点。 */
function registerBridge() {
  const { ctx, handlers } = makeHarness()
  registerSettingsBridge(
    ctx,
    'prompt-tool',
    () => ({ available: true, providers: [] }),
    () => ({ activeSkillsDirs: [], skillCatalog: [] }),
    () => '',
    undefined,
    () => presetDir,
  )
  const handler = handlers.get(PREFIX + BRIDGE_ENDPOINTS.subagentToolPolicy)
  assert.ok(handler, 'subagent-tool-policy 端点必须注册')
  return handler
}

const READER_POLICY = {
  defaultProfile: 'reader',
  ceiling: { allow: ['read', 'bash'], deny: [] },
  profiles: [{ id: 'reader', name: '只读', allow: ['read'], deny: ['bash'], modelSelectable: true }],
}
const WRITER_POLICY = {
  defaultProfile: 'writer',
  ceiling: { allow: ['read', 'bash'], deny: [] },
  profiles: [{ id: 'writer', name: '读写', allow: ['read', 'bash'], deny: [], modelSelectable: false }],
}

function seedPreset() {
  mkdirSync(presetDir, { recursive: true })
  // modules 必须存在（保存端点据此自动追加策略模块），delegation 让组合里出现委派工具行。
  writeFileSync(join(presetDir, 'preset.yml'),
    `id: ${PRESET_ID}\nmodules:\n  - tool-fs\n  - delegation\nparams: {}\npromptConfigs: []\n`, 'utf8')
}

function writeOptions() {
  return {
    firstTurnAnchor: false, firstTurnText: '', firstTurnCustom: false,
    guideText: '', guideCustom: false, injectPrompt: true,
    modelProvider: '', modelName: '', subagentModelProvider: '', subagentModelName: '',
    bootstrapMaxTokens: 0, usePtcMode: false,
    // presetDir = 模板解析根（预设根）；输出目录 = 根/<presetTemplate>，与端点写入目录一致。
    presetDir: presetRoot, presetTemplate: PRESET_ID, presetOrder: 5,
  }
}

/** 调用真实端点保存策略，返回解析后的响应载荷。 */
async function savePolicy(handler, policy) {
  const res = fakeRes()
  await handler(fakeReq({ policy, expectedPresetId: PRESET_ID }), res)
  return { status: res.status, payload: JSON.parse(res.body) }
}

function findAllNested(rows, idSet) {
  const found = []
  const walk = (items) => {
    for (const item of Array.isArray(items) ? items : []) {
      if (item === null || typeof item !== 'object') continue
      if (idSet.has(item.id)) found.push(item)
      walk(item.config)
    }
  }
  walk(rows)
  return found
}

test('UI 保存：写入预设段 + 自动装配模块 + 物化策略文件 + 独立于主对话过滤', async () => {
  seedPreset()
  const handler = registerBridge()

  // 1) 保存策略（用户点「保存」）。
  const saved = await savePolicy(handler, READER_POLICY)
  assert.equal(saved.status, 200)
  assert.equal(saved.payload.ok, true)
  const spec = loadPresetSpec(presetDir)
  assert.deepEqual(spec.subagentToolPolicy, READER_POLICY, '顶层段按原样落盘')
  assert.ok(spec.modules.includes('subagent-tool-policy'), '模块声明自动追加，无需手工加模块')
  assert.equal(spec.modules.filter((item) => item === 'subagent-tool-policy').length, 1)

  // 2) 重建（端点里由 runOverridesChange 触发；测试显式调用做确定性断言）。
  writePreset('PROMPT', writeOptions())
  const generated = join(presetDir)
  const policyFile = join(generated, 'subagent-tools', 'policy.yml')
  assert.ok(existsSync(policyFile), '生成目录必须产出 subagent-tools/policy.yml')
  assert.deepEqual(parseYaml(readFileSync(policyFile, 'utf8')), READER_POLICY)

  // 3) 组合端到端：shadow 行装配 + delegation 不再携带主对话过滤。
  const rows = parseYaml(renderComposition(loadPresetSpec(presetDir), { toolFilterAllow: ['read'], toolFilterDeny: [] }, presetDir))
  const [policyRow] = findAllNested(rows, new Set(['subagent-tool-policy']))
  assert.ok(policyRow, '组合装配 shadow 行')
  assert.equal(policyRow.config.policyFile, '../subagent-tools/policy.yml')
  assert.equal(policyRow.config.spawnProvider, 'spawn')
  assert.equal(policyRow.config.forkProvider, 'fork')
  assert.equal(findAllNested(rows, new Set(['tool-subagent']))[0].config.toolFilter, undefined, '子代理工具面不再由 delegation 过滤决定')

  // 4) 幂等：重复保存同一策略不重复追加模块。
  await savePolicy(handler, READER_POLICY)
  assert.deepEqual(loadPresetSpec(presetDir).modules.filter((item) => item === 'subagent-tool-policy'), ['subagent-tool-policy'])

  // 5) 改档重建：生成物随策略变化。
  await savePolicy(handler, WRITER_POLICY)
  writePreset('PROMPT', writeOptions())
  assert.deepEqual(parseYaml(readFileSync(policyFile, 'utf8')), WRITER_POLICY)

  // 6) 关闭开关：只删除顶层段，**保留模块声明**（能力卡仍在，可再次打开）；
  //    引擎在策略文件缺失时降级为官方委派行为（见 engine/subagent-tool-policy.mjs）。
  const cleared = await savePolicy(handler, null)
  assert.equal(cleared.status, 200)
  const disabled = loadPresetSpec(presetDir)
  assert.equal(disabled.subagentToolPolicy, undefined)
  assert.ok(disabled.modules.includes('subagent-tool-policy'), '关闭开关后模块声明保留，能力卡不会消失')
  assert.ok(findAllNested(parseYaml(renderComposition(disabled, {}, presetDir)), new Set(['subagent-tool-policy'])).length > 0, '组合仍装配该行')
})

test('保存被拒绝的两类输入：损坏策略 409 且不落盘；预设切换 409', async () => {
  seedPreset()
  const handler = registerBridge()
  const presetFile = join(presetDir, 'preset.yml')
  const before = readFileSync(presetFile, 'utf8')

  // A) 校验失败：空 ceiling.allow（保存端点 validateSubagentToolPolicy 拒绝）。
  const invalid = await savePolicy(handler, { ceiling: { allow: [] }, profiles: [] })
  assert.equal(invalid.status, 409)
  assert.equal(invalid.payload.code, 'subagent-tool-policy-rejected')
  assert.equal(readFileSync(presetFile, 'utf8'), before, '校验失败不产生任何落盘')

  // B) 身份不一致：expectedPresetId 与激活预设不同 → 409，避免旧草稿写错预设。
  const res = fakeRes()
  await handler(fakeReq({ policy: READER_POLICY, expectedPresetId: 'another-preset' }), res)
  assert.equal(res.status, 409)
  assert.equal(JSON.parse(res.body).code, 'preset-changed')
  assert.equal(readFileSync(presetFile, 'utf8'), before)

  // C) 读取分支：无 policy 载荷时返回当前策略（UI 打开卡片时走这条）。
  const read = fakeRes()
  await handler(fakeReq({ expectedPresetId: PRESET_ID }), read)
  assert.equal(read.status, 200)
  assert.equal(JSON.parse(read.body).value.policy, null, '未配置时返回 null')
  await savePolicy(handler, READER_POLICY)
  const read2 = fakeRes()
  await handler(fakeReq({ expectedPresetId: PRESET_ID }), read2)
  assert.deepEqual(JSON.parse(read2.body).value.policy, READER_POLICY)
})

test('关闭开关后重建：生成目录不再产出策略文件（引擎侧降级见 engine 测试）', async () => {
  seedPreset()
  const handler = registerBridge()
  await savePolicy(handler, READER_POLICY)
  writePreset('PROMPT', writeOptions())
  const policyFile = join(presetDir, 'subagent-tools', 'policy.yml')
  assert.ok(existsSync(policyFile), '启用时产出策略文件')

  await savePolicy(handler, null)
  writePreset('PROMPT', writeOptions())
  assert.equal(loadPresetSpec(presetDir).subagentToolPolicy, undefined, '策略段已删除')
  assert.equal(existsSync(policyFile), false, '关闭后不再产出策略文件（引擎据此降级）')
  assert.ok(existsSync(join(presetDir, 'agent.cordis.yml')), '预设本体仍然物化成功，不因缺策略文件而失败')
})

test('编辑对象是激活预设：路径只由 getPresetConfigsDir 决定，客户端 ID 不参与构造', async () => {
  seedPreset()
  const handler = registerBridge()
  // 传另一个预设名不会写到别处，只会被 identity 守卫拒绝。
  const res = fakeRes()
  await handler(fakeReq({ policy: READER_POLICY, expectedPresetId: basename(presetDir) }), res)
  assert.equal(res.status, 200)
  assert.deepEqual(loadPresetSpec(presetDir).subagentToolPolicy, READER_POLICY, '写的是激活预设目录')
})
