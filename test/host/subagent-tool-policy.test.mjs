/**
 * `subagent-tool-policy` 的端到端核验：模块类型能力链路 + UI 保存链路。
 *
 * 合并自 `subagent-policy-capability.test.mjs`（7 条）与 `subagent-policy-save.test.mjs`（4 条）
 * —— 2026-09-17 测试归一精简 Wave 2。两条链路原本各建一个隔离 DSH_HOME，现共用一个 HOME、
 * 各自持有独立预设目录（cap-e2e / policy-e2e），互不干扰；顶层样板与 `findAllNested`/`writeOptions`
 * 去重，断言与用例标题一律原样保留。
 *
 * 用户决策：①启用写「可用骨架」；②单独一张能力卡内嵌策略编辑器；③删除能力时一并删除策略段。
 *
 * 能力链路：启用 → 模块声明 + 顶层段骨架；物化 → subagent-tools/policy.yml；组合 → shadow 行；
 * 删除 → 模块与段同时消失；幂等与"已有策略不被覆盖"。
 *
 * UI 保存链路：PUT `/subagent-tool-policy` → ①写激活预设 preset.yml 顶层 `subagentToolPolicy` 段；
 * ②自动把 `subagent-tool-policy` 追加进 `modules`（无需手工加模块）；③`runOverridesChange` 触发重建
 * （测试里显式调用 `writePreset` 做确定性断言）→ 生成目录出现 `subagent-tools/policy.yml`；
 * ④组合装配 shadow 行，且 `delegation` 行不再接收主对话 toolFilter（= 真正独立）；
 * ⑤幂等 / 改档 / 清空 / 校验拒绝 四种边界。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { isolatedHome } from '../fixtures/host-harness.mjs'

const { presetRoot } = isolatedHome('pt-subagent-policy-')
const {
  BRIDGE_ENDPOINTS,
  SETTINGS_BRIDGE_PREFIX,
  createEngineCapabilityInPreset,
  loadPresetSpec,
  registerSettingsBridge,
  removeEngineCapabilityFromPreset,
  renderComposition,
  writePreset,
} = await import('../../lib/index.mjs')
const { ENGINE_CAPABILITIES, SUBAGENT_TOOL_POLICY_SKELETON, engineCapability } = await import('../../src/shared/engine-capabilities.ts')
const { validateSubagentToolPolicy } = await import('../../engine/subagent-tool-policy-core.mjs')

const CAPABILITY_ID = 'subagent-tool-policy'
/** 能力链路（原 subagent-policy-capability）的预设。 */
const CAP_PRESET_ID = 'cap-e2e'
const capPresetDir = join(presetRoot, CAP_PRESET_ID)
/** UI 保存链路（原 subagent-policy-save）的预设。 */
const PREFIX = SETTINGS_BRIDGE_PREFIX
const POLICY_PRESET_ID = 'policy-e2e'
/** 模板解析根 = 预设根；激活预设目录（端点写入与物化输出）= 根/<id>。 */
const policyPresetDir = join(presetRoot, POLICY_PRESET_ID)

/** 物化选项：输出目录 = 预设根/<presetTemplate>，调用方传入自己那条链路的预设 id。 */
function writeOptions(presetId) {
  return {
    firstTurnAnchor: false, firstTurnText: '', firstTurnCustom: false,
    guideText: '', guideCustom: false, injectPrompt: true,
    modelProvider: '', modelName: '', subagentModelProvider: '', subagentModelName: '',
    bootstrapMaxTokens: 0, usePtcMode: false,
    presetDir: presetRoot, presetTemplate: presetId, presetOrder: 5,
  }
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

/** 能力链路的预设：带 name/version/engineCompat 的完整定义。 */
function seedCapPreset() {
  mkdirSync(capPresetDir, { recursive: true })
  writeFileSync(join(capPresetDir, 'preset.yml'),
    `id: ${CAP_PRESET_ID}\nname: ${CAP_PRESET_ID}\nversion: "1"\nengineCompat: ">=0"\nmodules:\n  - tool-fs\n  - delegation\nparams: {}\npromptConfigs: []\n`, 'utf8')
}

/** UI 保存链路的预设：modules 必须存在（保存端点据此自动追加策略模块），delegation 让组合里出现委派工具行。 */
function seedPolicyPreset() {
  mkdirSync(policyPresetDir, { recursive: true })
  writeFileSync(join(policyPresetDir, 'preset.yml'),
    `id: ${POLICY_PRESET_ID}\nmodules:\n  - tool-fs\n  - delegation\nparams: {}\npromptConfigs: []\n`, 'utf8')
}

// —— 以下 bridge 样板仅 UI 保存链路使用（逐字来自原 subagent-policy-save.test.mjs） ——

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
    () => policyPresetDir,
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

/** 调用真实端点保存策略，返回解析后的响应载荷。 */
async function savePolicy(handler, policy) {
  const res = fakeRes()
  await handler(fakeReq({ policy, expectedPresetId: POLICY_PRESET_ID }), res)
  return { status: res.status, payload: JSON.parse(res.body) }
}

// —— 能力链路（原 subagent-policy-capability.test.mjs） ——

test('能力目录登记：subagent-tool-policy 带 ownSection 且骨架通过校验', () => {
  const capability = engineCapability(CAPABILITY_ID)
  assert.ok(capability, '能力目录必须登记 subagent-tool-policy')
  assert.deepEqual(capability.moduleKeys, [CAPABILITY_ID])
  assert.deepEqual(capability.rowIds, [CAPABILITY_ID])
  assert.equal(capability.displayLayer, 'tool-pipeline')
  assert.equal(capability.ownSection?.key, 'subagentToolPolicy')
  // 骨架必须能被策略校验接受（否则"启用即不可保存"）。
  assert.deepEqual(validateSubagentToolPolicy(SUBAGENT_TOOL_POLICY_SKELETON), [])
  // 目录里的每个能力都要有唯一 id。
  assert.equal(new Set(ENGINE_CAPABILITIES.map((item) => item.id)).size, ENGINE_CAPABILITIES.length)
})

test('启用能力：模块声明 + 顶层骨架同时写入，物化与组合链路成立', () => {
  seedCapPreset()
  const created = createEngineCapabilityInPreset(capPresetDir, { action: 'create', capabilityId: CAPABILITY_ID })
  assert.equal(created.changed, true)
  assert.deepEqual(created.addedModules, [CAPABILITY_ID])
  const spec = loadPresetSpec(capPresetDir)
  assert.ok(spec.modules.includes(CAPABILITY_ID), '模块声明写入')
  assert.deepEqual(spec.subagentToolPolicy, SUBAGENT_TOOL_POLICY_SKELETON, '启用即写入可用骨架（模块在 ⇒ 数据在）')

  // 物化：生成目录产出策略文件 + 生成目录 preset.yml 同步模块与段。
  writePreset('PROMPT', writeOptions(CAP_PRESET_ID))
  assert.deepEqual(parseYaml(readFileSync(join(capPresetDir, 'subagent-tools', 'policy.yml'), 'utf8')), SUBAGENT_TOOL_POLICY_SKELETON)
  const generated = loadPresetSpec(capPresetDir)
  assert.ok(generated.modules.includes(CAPABILITY_ID))
  assert.deepEqual(generated.subagentToolPolicy, SUBAGENT_TOOL_POLICY_SKELETON)

  // 组合：shadow 行装配。
  const [row] = findAllNested(parseYaml(renderComposition(generated, {}, capPresetDir)), new Set([CAPABILITY_ID]))
  assert.ok(row, '组合装配 shadow 行')
  assert.equal(row.config.policyFile, '../subagent-tools/policy.yml')
})

test('幂等与保护：重复启用不重复追加；段已有用户内容时只补模块、不覆盖策略', () => {
  seedCapPreset()
  createEngineCapabilityInPreset(capPresetDir, { action: 'create', capabilityId: CAPABILITY_ID })
  const second = createEngineCapabilityInPreset(capPresetDir, { action: 'create', capabilityId: CAPABILITY_ID })
  assert.equal(second.changed, false, '已装配且段已存在时不重复写盘')
  assert.equal(loadPresetSpec(capPresetDir).modules.filter((item) => item === CAPABILITY_ID).length, 1)
})

test('半状态自愈：段已有用户策略但没有模块声明时，启用补上模块声明且不覆盖策略', () => {
  seedCapPreset()
  // 手工构造"段在、模块不在"的历史状态（旧版本或手工编辑过 preset.yml）。
  const file = join(capPresetDir, 'preset.yml')
  writeFileSync(file, readFileSync(file, 'utf8').replace('params: {}',
    'subagentToolPolicy:\n  defaultProfile: reader\n  ceiling:\n    allow: [read]\n    deny: []\n  profiles:\n    - id: reader\n      name: 只读\n      allow: [read]\n      deny: []\n      modelSelectable: false\nparams: {}'), 'utf8')
  const custom = loadPresetSpec(capPresetDir).subagentToolPolicy
  assert.equal(custom.defaultProfile, 'reader')
  // 关键：段的存在让 resolvePresetModuleFacts 会把模块算进 effectiveModules，
  // 实际运行能力与磁盘声明分开：创建必须按声明检查，才能补齐而不覆盖已有策略。
  const created = createEngineCapabilityInPreset(capPresetDir, { action: 'create', capabilityId: CAPABILITY_ID })
  assert.equal(created.changed, true, '半状态必须能补上模块声明')
  assert.deepEqual(created.addedModules, [CAPABILITY_ID])
  const after = loadPresetSpec(capPresetDir)
  assert.ok(after.modules.includes(CAPABILITY_ID), '模块声明补齐')
  assert.deepEqual(after.subagentToolPolicy, custom, '既有策略内容不被骨架覆盖')
})

test('模块已在声明里时不重复写盘（幂等）', () => {
  seedCapPreset()
  createEngineCapabilityInPreset(capPresetDir, { action: 'create', capabilityId: CAPABILITY_ID })
  const again = createEngineCapabilityInPreset(capPresetDir, { action: 'create', capabilityId: CAPABILITY_ID })
  assert.equal(again.changed, false)
  assert.deepEqual(again.addedModules, [])
  assert.equal(loadPresetSpec(capPresetDir).modules.filter((item) => item === CAPABILITY_ID).length, 1)
})

test('删除能力：模块声明与顶层策略段一并移除（用户决策 3）', () => {
  seedCapPreset()
  createEngineCapabilityInPreset(capPresetDir, { action: 'create', capabilityId: CAPABILITY_ID })
  const removed = removeEngineCapabilityFromPreset(capPresetDir, CAPABILITY_ID)
  assert.equal(removed.changed, true)
  assert.deepEqual(removed.removedModules, [CAPABILITY_ID])
  const spec = loadPresetSpec(capPresetDir)
  assert.equal(spec.modules.includes(CAPABILITY_ID), false, '模块声明移除')
  assert.equal(spec.subagentToolPolicy, undefined, '顶层策略段一并删除')
  // 组合不再有 shadow 行。
  assert.deepEqual(findAllNested(parseYaml(renderComposition(spec, {}, capPresetDir)), new Set([CAPABILITY_ID])), [])
  // 再次删除幂等。
  assert.equal(removeEngineCapabilityFromPreset(capPresetDir, CAPABILITY_ID).changed, false)
})

test('只有段没有模块的残留也能被删除能力清理（半状态自愈）', () => {
  seedCapPreset()
  writeFileSync(join(capPresetDir, 'preset.yml'),
    readFileSync(join(capPresetDir, 'preset.yml'), 'utf8').replace('params: {}', `subagentToolPolicy:\n  defaultProfile: default\n  ceiling:\n    allow: [read]\n    deny: []\n  profiles:\n    - id: default\n      name: 默认\n      allow: [read]\n      deny: []\nparams: {}`), 'utf8')
  const removed = removeEngineCapabilityFromPreset(capPresetDir, CAPABILITY_ID)
  assert.equal(removed.changed, true, '模块不在但段存在时也必须清理')
  assert.equal(loadPresetSpec(capPresetDir).subagentToolPolicy, undefined)
})

// —— UI 保存链路（原 subagent-policy-save.test.mjs） ——

test('UI 保存：写入预设段 + 自动装配模块 + 物化策略文件 + 独立于主对话过滤', async () => {
  seedPolicyPreset()
  const handler = registerBridge()

  // 1) 保存策略（用户点「保存」）。
  const saved = await savePolicy(handler, READER_POLICY)
  assert.equal(saved.status, 200)
  assert.equal(saved.payload.ok, true)
  const spec = loadPresetSpec(policyPresetDir)
  assert.deepEqual(spec.subagentToolPolicy, READER_POLICY, '顶层段按原样落盘')
  assert.ok(spec.modules.includes('subagent-tool-policy'), '模块声明自动追加，无需手工加模块')
  assert.equal(spec.modules.filter((item) => item === 'subagent-tool-policy').length, 1)

  // 2) 重建（端点里由 runOverridesChange 触发；测试显式调用做确定性断言）。
  writePreset('PROMPT', writeOptions(POLICY_PRESET_ID))
  const generated = join(policyPresetDir)
  const policyFile = join(generated, 'subagent-tools', 'policy.yml')
  assert.ok(existsSync(policyFile), '生成目录必须产出 subagent-tools/policy.yml')
  assert.deepEqual(parseYaml(readFileSync(policyFile, 'utf8')), READER_POLICY)

  // 3) 组合端到端：shadow 行装配 + delegation 不再携带主对话过滤。
  const rows = parseYaml(renderComposition(loadPresetSpec(policyPresetDir), { toolFilterAllow: ['read'], toolFilterDeny: [] }, policyPresetDir))
  const [policyRow] = findAllNested(rows, new Set(['subagent-tool-policy']))
  assert.ok(policyRow, '组合装配 shadow 行')
  assert.equal(policyRow.config.policyFile, '../subagent-tools/policy.yml')
  assert.equal(policyRow.config.spawnProvider, 'spawn')
  assert.equal(policyRow.config.forkProvider, 'fork')
  assert.equal(findAllNested(rows, new Set(['tool-subagent']))[0].config.toolFilter, undefined, '子代理工具面不再由 delegation 过滤决定')

  // 4) 幂等：重复保存同一策略不重复追加模块。
  await savePolicy(handler, READER_POLICY)
  assert.deepEqual(loadPresetSpec(policyPresetDir).modules.filter((item) => item === 'subagent-tool-policy'), ['subagent-tool-policy'])

  // 5) 改档重建：生成物随策略变化。
  await savePolicy(handler, WRITER_POLICY)
  writePreset('PROMPT', writeOptions(POLICY_PRESET_ID))
  assert.deepEqual(parseYaml(readFileSync(policyFile, 'utf8')), WRITER_POLICY)

  // 6) 关闭开关：只删除顶层段，**保留模块声明**（能力卡仍在，可再次打开）；
  //    引擎在策略文件缺失时降级为官方委派行为（见 engine/subagent-tool-policy.mjs）。
  const cleared = await savePolicy(handler, null)
  assert.equal(cleared.status, 200)
  const disabled = loadPresetSpec(policyPresetDir)
  assert.equal(disabled.subagentToolPolicy, undefined)
  assert.ok(disabled.modules.includes('subagent-tool-policy'), '关闭开关后模块声明保留，能力卡不会消失')
  assert.ok(findAllNested(parseYaml(renderComposition(disabled, {}, policyPresetDir)), new Set(['subagent-tool-policy'])).length > 0, '组合仍装配该行')
})

test('保存被拒绝的两类输入：损坏策略 409 且不落盘；预设切换 409', async () => {
  seedPolicyPreset()
  const handler = registerBridge()
  const presetFile = join(policyPresetDir, 'preset.yml')
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
  await handler(fakeReq({ expectedPresetId: POLICY_PRESET_ID }), read)
  assert.equal(read.status, 200)
  assert.equal(JSON.parse(read.body).value.policy, null, '未配置时返回 null')
  await savePolicy(handler, READER_POLICY)
  const read2 = fakeRes()
  await handler(fakeReq({ expectedPresetId: POLICY_PRESET_ID }), read2)
  assert.deepEqual(JSON.parse(read2.body).value.policy, READER_POLICY)
})

test('关闭开关后重建：生成目录不再产出策略文件（引擎侧降级见 engine 测试）', async () => {
  seedPolicyPreset()
  const handler = registerBridge()
  await savePolicy(handler, READER_POLICY)
  writePreset('PROMPT', writeOptions(POLICY_PRESET_ID))
  const policyFile = join(policyPresetDir, 'subagent-tools', 'policy.yml')
  assert.ok(existsSync(policyFile), '启用时产出策略文件')

  await savePolicy(handler, null)
  writePreset('PROMPT', writeOptions(POLICY_PRESET_ID))
  assert.equal(loadPresetSpec(policyPresetDir).subagentToolPolicy, undefined, '策略段已删除')
  assert.equal(existsSync(policyFile), false, '关闭后不再产出策略文件（引擎据此降级）')
  assert.ok(existsSync(join(policyPresetDir, 'agent.cordis.yml')), '预设本体仍然物化成功，不因缺策略文件而失败')
})

test('编辑对象是激活预设：路径只由 getPresetConfigsDir 决定，客户端 ID 不参与构造', async () => {
  seedPolicyPreset()
  const handler = registerBridge()
  // 传另一个预设名不会写到别处，只会被 identity 守卫拒绝。
  const res = fakeRes()
  await handler(fakeReq({ policy: READER_POLICY, expectedPresetId: basename(policyPresetDir) }), res)
  assert.equal(res.status, 200)
  assert.deepEqual(loadPresetSpec(policyPresetDir).subagentToolPolicy, READER_POLICY, '写的是激活预设目录')
})
