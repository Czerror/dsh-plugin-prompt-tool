import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { fakeReq, fakeRes, handlerTable } from '../fixtures/host-harness.mjs'
const home = mkdtempSync(join(process.cwd(), 'pt-contract-'))
process.env.DSH_HOME = home
const { BRIDGE_ENDPOINTS, SETTINGS_BRIDGE_PREFIX } = await import('../../src/shared/bridge-contract.ts')
const { registerSettingsBridge } = await import('../../src/runtime/settings-bridge.ts')
const { ENGINE_CAPABILITIES, ENGINE_EDITOR_GROUP_MAP, ENGINE_LAYER_ORDER } = await import('../../src/shared/engine-capabilities.ts')
const { getEngineMeta, LAYER_ORDER } = await import('../../engine/schema.mjs')
const bridgeDisposers = []
test.after(() => {
  for (const dispose of bridgeDisposers) dispose()
  rmSync(home, { recursive: true, force: true })
})

// 跨端契约测试：shared 常量（client 消费）必须与 server 注册路由逐点一致。

function makeHarness(otherServices = {}, logger = undefined) {
  const table = handlerTable()
  const agentPresets = {
    list: async () => [{ id: 'official', trust: 'system' }],
    acquireScope: async (id) => ({ key: { id }, [Symbol.asyncDispose]: async () => {} }),
    ...otherServices.agentPresets,
  }
  const sctx = {
    settings: {
      describe: () => [{ ns: 'prompt-tool', value: { promptText: 'P' }, base: {} }],
      mutate: async () => {},
    },
    webServer: { register: table.register },
    agents: {
      get: (id) => id === 'live-session' ? { id } : undefined,
    },
    tools: {
      schemas: () => [{ name: 'bash', description: '运行命令' }],
      ...otherServices.tools,
    },
    get: (name) => name === 'agentPresets' ? agentPresets : otherServices[name],
    effect: (fn) => { const dispose = fn(); if (dispose) bridgeDisposers.push(dispose) },
  }
  // Cordis 语义：未 inject 的服务属性访问直接抛错，可选服务只能经 ctx.get 解析。
  Object.defineProperty(sctx, 'agentPresets', {
    get() { throw new Error('cannot get property "agentPresets" without inject') },
  })
  const ctx = { inject: (_deps, cb) => cb(sctx), ...(logger === undefined ? {} : { logger }) }
  return { ctx, handlers: table.handlers }
}

/** 文件层调用策略的技能状态替身：技能实体留在官方技能根，插件只提供引用目录、清单与策略写入。 */
function makeSkillsState(overrides = {}) {
  const state = { version: 4, folders: [] }
  return {
    skillsRoot: 'D:/isolated/skills',
    folders: [],
    listSkills: () => [],
    setSkillPolicy: () => ({ ok: true, changed: true, invocation: { modelInvocable: true, userInvocable: true } }),
    patchSkillFolders: () => ({ ok: true, state, exists: true }),
    ...overrides,
  }
}

function register(skillsState = makeSkillsState()) {
  const { ctx, handlers } = makeHarness()
  registerSettingsBridge(
    ctx,
    'prompt-tool',
    () => ({ available: true, providers: ['deepseek-official'] }),
    () => skillsState,
    () => '',
  )
  return handlers
}

/** /bootstrap 与 /meta 必须同源（同一份 loadEngineMeta）：逐字段表驱动比对，不各自组装。 */
function assertMetaSameSource(boot, meta, keys) {
  for (const key of keys) assert.deepEqual(boot[key], meta[key], `/bootstrap 与 /meta 必须同源：${key}`)
}

test('契约：client 前缀与 server 注册前缀同源', () => {
  assert.equal(SETTINGS_BRIDGE_PREFIX, '/api/prompt-tool/settings')
})

test('契约：所有端点路径全部注册且无多余', () => {
  const handlers = register()
  const expected = Object.values(BRIDGE_ENDPOINTS)
  const registered = [...handlers.keys()].sort()
  const wanted = expected.map((p) => SETTINGS_BRIDGE_PREFIX + p).sort()
  assert.deepEqual(registered, wanted)
})

test('部署总闸保留旧false，显式保存规范新键并拒绝同批新旧冲突', async () => {
  const handlers = new Map()
  let value = { writePreset: false }
  const writes = []
  const scope = {
    settings: {
      describe: () => [{ ns: 'prompt-tool', value, base: {}, revision: 1 }],
      mutate: async (_ns, ops) => {
        writes.push(ops)
        for (const op of ops) {
          if (op.op === 'unset') delete value[op.path[0]]
          else value[op.path[0]] = op.value
        }
      },
    },
    get: () => undefined,
    webServer: { register: ({ path, handler }) => { handlers.set(path, handler); return () => {} } },
    effect: fn => { const dispose = fn(); if (dispose) bridgeDisposers.push(dispose) },
  }
  registerSettingsBridge({ inject: (_deps, callback) => callback(scope) }, 'prompt-tool', () => ({}), () => makeSkillsState(), () => '')
  const read = fakeRes()
  await handlers.get(SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.describe)(fakeReq(), read)
  assert.equal(JSON.parse(read.body).value.value.modulesEnabled, false)
  const save = async ops => {
    const res = fakeRes()
    await handlers.get(SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.mutate)(fakeReq({ body: { ops } }), res)
    return res
  }
  const conflict = await save([{ op: 'set', path: ['modulesEnabled'], value: true }, { op: 'set', path: ['writePreset'], value: false }])
  assert.equal(conflict.status, 409)
  assert.deepEqual(value, { writePreset: false })
  assert.equal(writes.length, 0)
  const changed = await save([{ op: 'set', path: ['modulesEnabled'], value: true }])
  assert.equal(changed.status, 200, changed.body)
  assert.deepEqual(value, { modulesEnabled: true })
  assert.deepEqual(writes[0].at(-1), { op: 'unset', path: ['writePreset'] })
  value = { writePreset: true }
  const legacy = await save([{ op: 'set', path: ['writePreset'], value: false }])
  assert.equal(legacy.status, 200, legacy.body)
  assert.deepEqual(value, { modulesEnabled: false })
})

test('契约：/bootstrap 聚合 meta + overrides + variables + promptConfigs 供客户端单请求消费', async () => {
  // 技能事实用非空数据断言透传：stub 的默认空表无法区分「如实下发」与「兜底成空」。
  const entry = { id: 'user-dsh:D:/isolated/skills:demo-skill', name: 'demo-skill', source: 'user-dsh', rank: 400, valid: true, modelInvocable: false, userInvocable: true, path: 'D:/isolated/skills/demo-skill/SKILL.md' }
  const handlers = register(makeSkillsState({
    folders: ['D:/referenced'],
    listSkills: () => [entry],
  }))
  const handler = handlers.get(SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.bootstrap)
  assert.ok(handler, '/bootstrap 端点未注册')
  const res = fakeRes()
  await handler(fakeReq(), res)
  assert.equal(res.status, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  // 客户端 load() 消费路径：meta.meta / overrides.overrides / variables.variables /
  // promptConfigs.promptConfigs 全部存在（空值兜底形状，非 undefined）。
  assert.ok(payload.meta !== undefined && payload.meta.meta !== undefined)
  assert.deepEqual(payload.overrides.overrides, {}, '无激活模块时参数覆盖是空表（对象），不是数组或 undefined')
  assert.ok(typeof payload.variables.variables === 'object' && typeof payload.variables.enabled === 'boolean')
  assert.ok(Array.isArray(payload.promptConfigs.promptConfigs))
  // 技能事实在同一聚合响应里下发：清单 + 引用目录 + 用户技能根。
  // 调用策略不单独下发——它已经逐条表达在 skillCatalog 条目的 modelInvocable / userInvocable 里。
  assert.deepEqual(payload.activeSkillsDirs, ['D:/isolated/skills'])
  assert.deepEqual(payload.skillFolders, ['D:/referenced'])
  assert.deepEqual(payload.skillCatalog, [entry])
  assert.equal(payload.skillsComplete, false, '无注册表观测时不得宣称会话技能清单完整')
  // 包内默认模块可解析，moduleFacts 确有值：这里查的是投影本身不夹带行级配置。
  assert.equal(payload.moduleFacts.effectiveConfigs, undefined, 'bootstrap 不应暴露完整行级配置')
})

test('契约：/meta 与 /bootstrap 同源下发 layerOrder 与 editorGroups，且只含白名单字段', async () => {
  const engineMeta = getEngineMeta()
  assert.deepEqual(engineMeta.layerOrder, [
    'pre-step', 'system-section', 'runtime-context', 'agent-request', 'llm-stream',
    'tool-pipeline', 'turn-stop', 'subagent-start', 'subagent-end',
  ])
  assert.deepEqual([...LAYER_ORDER], engineMeta.layerOrder, 'LAYER_ORDER 必须是九层固定顺序')
  assert.deepEqual([...ENGINE_LAYER_ORDER], engineMeta.layerOrder, '前端退化默认必须与引擎层序同源')
  assert.deepEqual([...engineMeta.layers], [...LAYER_ORDER].sort(), 'layers 仍是排序后的合法集合（旧消费方不变）')
  // 两份层清单：九层给视图筛选与规则级 layer，八层（去 tool-pipeline）才可注入。
  assert.deepEqual([...engineMeta.injectionLayers], [...LAYER_ORDER].filter((layer) => layer !== 'tool-pipeline'))
  assert.equal(engineMeta.injectionLayers.includes('tool-pipeline'), false, '工具链层没有 inject-text 通道')
  assert.deepEqual([...engineMeta.layers].filter((layer) => !engineMeta.injectionLayers.includes(layer)), ['tool-pipeline'], '两份清单的差集只有工具链层')

  const handlers = register()
  const metaRes = fakeRes()
  await handlers.get(SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.meta)(fakeReq(), metaRes)
  assert.equal(metaRes.status, 200)
  const meta = JSON.parse(metaRes.body).value.meta
  assert.deepEqual(meta.layerOrder, engineMeta.layerOrder)
  assert.deepEqual(meta.injectionLayers, engineMeta.injectionLayers, '/meta 下发的可注入层与 schema 同源')
  assert.ok(Array.isArray(meta.editorGroups) && meta.editorGroups.length > 0)
  // 同源：host 下发的编辑组与共享契约逐条一致（含能力组）。
  assert.deepEqual(meta.editorGroups.map(({ id }) => id), ENGINE_EDITOR_GROUP_MAP.map(({ id }) => id))
  const capabilityIds = ENGINE_CAPABILITIES.map(({ id }) => id)
  const groupIds = meta.editorGroups.map(({ id }) => id)
  assert.equal(new Set(groupIds).size, groupIds.length, '编辑组 id 必须唯一（能力组与专用组不重复登记）')
  for (const id of capabilityIds) assert.ok(groupIds.includes(id), `能力 ${id} 必须有主归属`)
  for (const group of meta.editorGroups) {
    // 白名单：只有四个可序列化字段，不夹带路径、行级配置、校验函数或服务实例。
    assert.deepEqual(Object.keys(group).sort(), group.relatedLayers === undefined
      ? ['displayLayer', 'hook', 'id']
      : ['displayLayer', 'hook', 'id', 'relatedLayers'])
    assert.equal(typeof group.id, 'string')
    assert.equal(typeof group.hook, 'string')
    assert.ok(meta.layerOrder.includes(group.displayLayer), `${group.id} 主归属层非法：${group.displayLayer}`)
    for (const related of group.relatedLayers ?? []) {
      assert.ok(meta.layerOrder.includes(related), `${group.id} 相关层非法：${related}`)
      assert.notEqual(related, group.displayLayer, `${group.id} 相关层不能与主归属层相同`)
    }
  }
  const serialized = JSON.stringify(meta.editorGroups)
  assert.equal(serialized.includes('function'), false, '不得下发函数')
  assert.equal(serialized.includes(':\\'), false, '不得下发本地路径')

  // /bootstrap 与 /meta 同源：同一份 layerOrder / editorGroups，不各自组装。
  const bootRes = fakeRes()
  await handlers.get(SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.bootstrap)(fakeReq(), bootRes)
  assert.equal(bootRes.status, 200)
  const boot = JSON.parse(bootRes.body).meta.meta
  assertMetaSameSource(boot, meta, ['layerOrder', 'injectionLayers', 'editorGroups', 'layerContracts'])
  assert.deepEqual(meta.layerContracts, getEngineMeta().layerContracts)
  assert.equal(Object.keys(meta.layerContracts).length, 9)
})

test('契约：官方装配刻度随 /meta 与 /bootstrap 同源下发，服务缺失时整张表缺席且只告警一次', async (t) => {
  // 刻度数值只认官方实现：这里挂真实 SystemPrompt，不喂手抄数值。
  const root = new Context()
  await root.plugin(SystemPrompt, { includeHarnessIdentity: false })
  t.after(async () => { await root.fiber.dispose() })

  const warnings = []
  const present = makeHarness({ systemPrompt: root.systemPrompt }, { warn: (message) => warnings.push(message) })
  registerSettingsBridge(
    present.ctx, 'prompt-tool',
    () => ({ available: true, providers: ['deepseek-official'] }), () => makeSkillsState(), () => '',
  )
  const metaRes = fakeRes()
  await present.handlers.get(SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.meta)(fakeReq(), metaRes)
  assert.equal(metaRes.status, 200)
  const meta = JSON.parse(metaRes.body).value.meta
  assert.ok(meta.officialOrders, '真实服务在位时必须下发刻度')
  assert.equal(meta.officialOrders.sections.length, 6)
  assert.equal(meta.officialOrders.contexts.length, 1)
  for (const segment of [...meta.officialOrders.sections, ...meta.officialOrders.contexts]) {
    assert.equal(typeof segment.id, 'string')
    assert.equal(Number.isFinite(segment.from), true)
    assert.equal(Number.isFinite(segment.to), true)
    assert.ok(segment.from <= segment.to, `${segment.id}: from 不得大于 to`)
  }
  assert.equal(JSON.stringify(meta.officialOrders).includes('function'), false, '不得下发函数')
  assert.equal(warnings.length, 0, '服务在位时不得告警')

  const bootRes = fakeRes()
  await present.handlers.get(SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.bootstrap)(fakeReq(), bootRes)
  assert.equal(bootRes.status, 200)
  assertMetaSameSource(JSON.parse(bootRes.body).meta.meta, meta, ['officialOrders'])

  // 服务缺失：字段整体缺席、端点不失败，且只告警一次（两个端点共用同一函数）。
  const missingWarnings = []
  const missing = makeHarness({}, { warn: (message) => missingWarnings.push(message) })
  registerSettingsBridge(
    missing.ctx, 'prompt-tool',
    () => ({ available: true, providers: ['deepseek-official'] }), () => makeSkillsState(), () => '',
  )
  for (const endpoint of [BRIDGE_ENDPOINTS.meta, BRIDGE_ENDPOINTS.meta]) {
    const res = fakeRes()
    await missing.handlers.get(SETTINGS_BRIDGE_PREFIX + endpoint)(fakeReq(), res)
    assert.equal(res.status, 200, '服务缺失不得让端点失败')
    assert.equal(JSON.parse(res.body).value.meta.officialOrders, undefined, '服务缺失 ⇒ 字段整体缺席，绝不部分下发')
  }
  assert.equal(missingWarnings.length, 1, '取值失败只告警一次，不随请求刷屏')
  assert.match(missingWarnings[0], /官方装配档位/)
})

test('契约：复制引擎目录即可提供层契约，不依赖 src', async () => {
  const copied = mkdtempSync(join(process.cwd(), 'pt-engine-copy-'))
  try {
    cpSync(new URL('../../engine', import.meta.url), join(copied, 'engine'), { recursive: true })
    const copy = await import(pathToFileURL(join(copied, 'engine', 'schema.mjs')).href)
    assert.deepEqual([...copy.LAYER_ORDER], [...LAYER_ORDER])
  } finally {
    rmSync(copied, { recursive: true, force: true })
  }
})

test('契约：成功载荷统一为 { ok: true, value }', async () => {
  const handlers = register()
  // 抽样无需 settings/descriptor 依赖的端点，断言客户端 typed bridge 消费形状（res.value.*）。
  for (const path of [SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.meta, SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.skillsList]) {
    const handler = handlers.get(path)
    assert.ok(handler, `端点未注册: ${path}`)
    const res = fakeRes()
    await handler(fakeReq(), res)
    assert.equal(res.status, 200)
    const payload = JSON.parse(res.body)
    assert.equal(payload.ok, true)
    assert.ok(payload.value !== undefined && payload.value !== null, `${path} 成功载荷必须带 value`)
  }
})

test('契约：/tool-surface 返回存活 Agent 的只读工具面摘要，未知 session 稳定错误', async () => {
  const handlers = register()
  const handler = handlers.get(SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.toolSurface)
  assert.ok(handler, '/tool-surface 端点未注册')
  const ok = fakeRes()
  await handler(fakeReq({ body: { sessionId: 'live-session' } }), ok)
  assert.equal(ok.status, 200)
  const payload = JSON.parse(ok.body)
  assert.equal(payload.ok, true)
  assert.deepEqual(payload.value.tools, [{ name: 'bash', description: '运行命令' }], '只返回 name/description')
  assert.equal(payload.value.source, 'session')
  const unknown = fakeRes()
  await handler(fakeReq({ body: { sessionId: 'nope' } }), unknown)
  assert.equal(unknown.status, 404)
  const unknownPayload = JSON.parse(unknown.body)
  assert.equal(unknownPayload.ok, false)
  assert.equal(unknownPayload.code, 'tool-surface-unknown-session')
})

test('契约：/rule-diagnostics 只回判定计数，未启用不入账且读取不触发求值', async () => {
  const { recordRuleOutcome, resetRuleDiagnostics } = await import('../../src/runtime/rule-diagnostics.ts')
  const handlers = register()
  const handler = handlers.get(SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.ruleDiagnostics)
  assert.ok(handler, '/rule-diagnostics 端点未注册')
  resetRuleDiagnostics()
  const empty = fakeRes()
  await handler(fakeReq({ body: {} }), empty)
  assert.equal(empty.status, 200)
  assert.deepEqual(JSON.parse(empty.body), { ok: true, value: { records: [] } }, '未产生判定时回空数组，不伪报')
  recordRuleOutcome({ moduleId: 'm', ruleId: 'r', channel: 'agent/pre-step', outcome: 'unavailable' })
  recordRuleOutcome({ moduleId: 'm', ruleId: 'r', channel: 'agent/pre-step', outcome: 'unavailable' })
  recordRuleOutcome({ moduleId: 'm', ruleId: 'r', channel: 'agent/pre-step', outcome: 'disabled' })
  const filled = fakeRes()
  await handler(fakeReq({ body: {} }), filled)
  assert.deepEqual(JSON.parse(filled.body), {
    ok: true,
    value: { records: [{ moduleId: 'm', ruleId: 'r', channel: 'agent/pre-step', hit: 0, miss: 0, unavailable: 2, error: 0 }] },
  })
  resetRuleDiagnostics()
})

test('契约：/rule-diagnostics 身份上限溢出可见——512 条封顶并报 dropped', async (t) => {
  const { recordRuleOutcome, resetRuleDiagnostics, ruleDiagnosticsSnapshot, RULE_DIAGNOSTIC_LIMIT } = await import('../../src/runtime/rule-diagnostics.ts')
  const handlers = register()
  const handler = handlers.get(SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.ruleDiagnostics)
  resetRuleDiagnostics()
  t.after(() => resetRuleDiagnostics())
  for (let index = 0; index <= RULE_DIAGNOSTIC_LIMIT; index += 1) {
    recordRuleOutcome({ moduleId: 'm', ruleId: `r${index}`, channel: 'agent/pre-step', outcome: 'hit' })
  }
  assert.equal(ruleDiagnosticsSnapshot().length, RULE_DIAGNOSTIC_LIMIT, '身份表封顶 512 条')
  const overflow = fakeRes()
  await handler(fakeReq({ body: {} }), overflow)
  const payload = JSON.parse(overflow.body)
  assert.equal(payload.value.records.length, RULE_DIAGNOSTIC_LIMIT)
  assert.equal(payload.value.dropped, 1, '超限丢弃的判定次数随响应下发')
  resetRuleDiagnostics()
  const clean = fakeRes()
  await handler(fakeReq({ body: {} }), clean)
  assert.deepEqual(JSON.parse(clean.body), { ok: true, value: { records: [] } }, '未超限的响应不带 dropped')
})

test('契约：协调器未观察到官方装配时负责人事实是 null，不捏造 false', async () => {
  const { PRE_STEP_COORDINATOR_SERVICE } = await import('../../src/runtime/pre-step-coordinator.ts')
  const { ctx, handlers } = makeHarness({ [PRE_STEP_COORDINATOR_SERVICE]: { officialOwnerOf: () => undefined } })
  registerSettingsBridge(ctx, 'prompt-tool', () => ({ available: true, providers: ['deepseek-official'] }), () => makeSkillsState(), () => '')
  const res = fakeRes()
  await handlers.get(SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.bootstrap)(fakeReq({ body: { sessionId: 'live-session' } }), res)
  assert.equal(res.status, 200, res.body)
  assert.equal(JSON.parse(res.body).instructions.owner.officialInstructions, null, 'undefined → null：三态收敛后不再报 false')
})

test('契约：/tool-surface 支持官方 preset scope 且只读有效 schema', async () => {
  const handlers = register()
  const handler = handlers.get(SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.toolSurface)
  const ok = fakeRes()
  await handler(fakeReq({ body: { presetId: 'official' } }), ok)
  assert.equal(ok.status, 200)
  const payload = JSON.parse(ok.body)
  assert.equal(payload.value.source, 'preset')
  assert.equal(payload.value.presetId, 'official')
  assert.deepEqual(payload.value.tools, [{ name: 'bash', description: '运行命令' }])

  const invalid = fakeRes()
  await handler(fakeReq({ body: { sessionId: 'live-session', presetId: 'official' } }), invalid)
  assert.equal(invalid.status, 400)
  assert.equal(JSON.parse(invalid.body).code, 'tool-surface-invalid')
})

test('契约：/persona 未配置 moduleDir 时稳定拒绝', async () => {
  const handlers = register()
  const handler = handlers.get(SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.persona)
  assert.ok(handler, '/persona 端点未注册')
  const res = fakeRes()
  await handler(fakeReq({ body: {} }), res)
  assert.equal(res.status, 400)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, false)
  assert.equal(payload.code, 'module-dir-unavailable')
})

test('契约：工具预览在 schema 成功或抛错时均释放 revision lease', async () => {
  for (const fail of [false, true]) {
    const key = {}
    let acquired = 0
    let released = 0
    const { ctx, handlers } = makeHarness({
      agentPresets: { acquireScope: async () => {
        acquired++
        return { key, [Symbol.asyncDispose]: async () => { released++ } }
      } },
      tools: { schemas: (scope) => {
        assert.equal(scope, key)
        if (fail) throw new Error('schema failed')
        return [{ name: 'example', description: 'example' }]
      } },
    })
    registerSettingsBridge(ctx, 'prompt-tool', () => ({ available: true, providers: [] }), () => makeSkillsState(), () => '')
    const handler = handlers.get(SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.toolSurface)
    const res = fakeRes()
    await handler(fakeReq({ body: { presetId: 'official' } }), res)
    assert.equal(res.status, fail ? 409 : 200)
    assert.equal(acquired, 1)
    assert.equal(released, 1)
    const unknown = fakeRes()
    await handler(fakeReq({ body: { presetId: 'unknown' } }), unknown)
    assert.equal(unknown.status, 404)
    assert.equal(acquired, 1, '未知预设不得获取 scope')
  }
})

test('契约：失败载荷统一为 { ok: false, code?, message? }', async () => {
  const handlers = register()
  // 非法方法触发 405 失败分支。
  const handler = handlers.get(SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.meta)
  const res = fakeRes()
  await handler(fakeReq({ method: 'GET' }), res)
  assert.equal(res.status, 405)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, false)
  assert.equal(typeof payload.code, 'string')
  assert.equal(typeof payload.message, 'string')
})
