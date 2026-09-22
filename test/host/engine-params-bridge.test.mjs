// 合并自 module-configs.test.mjs(15) + param-contract.test.mjs(4) + scope-separation-audit.test.mjs(5)
//（2026-09-17 测试归一精简 Wave 2）：三者都是「预设参数 → 组合行 config」这一条链路的核验，
//  顶层 DSH_HOME 样板按 harness 统一为一份（见 isolatedHome），两份逐字相同的 findAllNested 合并为一份。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { isolatedHome } from '../fixtures/host-harness.mjs'

// 隔离 DSH_HOME：真实用户同名预设会遮蔽包内模板；harness 负责设置与 after() 还原。
const { home } = isolatedHome('pt-params-bridge-')
const { FIXTURE_PRESET_ID, installFixturePresetInHome } = await import('../fixtures/preset-template.mjs')
// 夹具装进隔离 DSH_HOME 的官方预设根：本文件用「夹具模板 + renderComposition」替代已下线的 buildCordis 兼容层。
installFixturePresetInHome(home)
const { ENGINE_PARAM_DEFINITIONS, ENGINE_PARAM_KEYS, buildEngineModuleParams } = await import('../../src/shared/engine-params.ts')
const { PARAM_KEYS } = await import('../../src/shared/param-keys.ts')
const {
  MODEL_SEGMENT_MAP,
  applyModuleConfigs,
  buildModuleConfigsFromParams,
  loadPresetSpec,
  renderComposition,
  resolvePresetDir,
  resolvePresetParams,
} = await import('../../src/host/manifest.ts')

/** 用测试夹具模板渲染组合（等价于旧的 buildCordis：模板 spec + 运行时参数）。 */
function fixtureComposition(runtime = {}) {
  const dir = resolvePresetDir(FIXTURE_PRESET_ID)
  return renderComposition(loadPresetSpec(dir), runtime, dir)
}

/** 递归收集指定 id 的嵌套行（delegation 组内工具行）。 */
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

const RAW = `# module: tool-git-bash
- id: tool-git-bash
  name: ./engine/tool-git-bash.mjs
  config:
    timeoutMs: 120000
    maxOutputBytes: 64000
- id: router-first-turn
  name: ./engine/router-first-turn.mjs
  config:
    mainPersona: "__MAIN_PERSONA__"
    hideSectionPrefixes: ["mnemon:"]
`

// —— moduleConfigs 合并与参数桥（原 module-configs.test.mjs） ——

test('moduleConfigs 覆盖声明模块的行级 config（未覆盖键保留）', () => {
  const out = applyModuleConfigs(RAW, { 'tool-git-bash': { timeoutMs: 180000 } })
  assert.ok(out.includes('timeoutMs: 180000'))
  assert.ok(!out.includes('timeoutMs: 120000'))
  assert.ok(out.includes('maxOutputBytes: 64000'))
})

test('moduleConfigs 不影响未声明模块与 __TOKEN__', () => {
  const out = applyModuleConfigs(RAW, { 'tool-git-bash': { timeoutMs: 180000 } })
  const rows = parseYaml(out)
  const router = rows.find((row) => row?.id === 'router-first-turn')
  assert.ok(router)
  assert.deepEqual(router.config.hideSectionPrefixes, ['mnemon:'])
  assert.equal(router.config.mainPersona, '__MAIN_PERSONA__')
})

test('moduleConfigs 未声明时返回原文（零开销）', () => {
  assert.equal(applyModuleConfigs(RAW, undefined), RAW)
  assert.equal(applyModuleConfigs(RAW, {}), RAW)
})

test('resolvePresetParams 模型路由/委派参数全扁平（preset.yml params 与运行时扁平键等价）', () => {
  const flat = resolvePresetParams({ id: 't', params: { modelProvider: 'deepseek', modelName: 'deepseek-v4-flash-7013', customToolRequireApproval: ['shell', 'fs'], maxDepth: 2 } }, {})
  assert.equal(flat.modelProvider, 'deepseek')
  assert.equal(flat.modelName, 'deepseek-v4-flash-7013')
  assert.deepEqual(flat.customToolRequireApproval, ['shell', 'fs'])
  assert.equal(flat.maxDepth, 2)
  // 运行时扁平键优先于 preset.yml 默认值。
  const overridden = resolvePresetParams({ id: 't', params: { modelProvider: 'preset-default', modelName: 'm1' } }, { modelProvider: 'runtime-wins' })
  assert.equal(overridden.modelProvider, 'runtime-wins')
  assert.equal(overridden.modelName, 'm1')
  // 空默认值不渲染（renderEngineTokens 对空串/空数组跳过）。
  const empty = resolvePresetParams({ id: 't', params: { modelProvider: '', modelName: '', customToolRequireApproval: [], maxDepth: '' } }, {})
  assert.equal(empty.modelProvider, '')
  assert.deepEqual(empty.customToolRequireApproval, [])
  assert.equal(empty.maxDepth, '')
})

test('夹具模板组合集成：组合源行默认与生成 token 渲染共存', () => {
  const rows = parseYaml(fixtureComposition())
  const bash = rows.find((row) => row?.id === 'tool-git-bash')
  const web = rows.find((row) => row?.id === 'tool-web')
  assert.ok(bash && web, 'agent 组合应含核心行')
  assert.equal(bash.config.timeoutMs, 120000, '本地行默认来自组合源 config')
  assert.equal(web.config.fetch, true)
  assert.equal(web.config.searchTimeoutMs, 60000, '夹具 moduleConfigs 与行默认一致，合并后不丢键')
  // 人设已迁到顶层 persona 段：组合不再含 router-first-turn 行，persona 行由
  // renderComposition 自动前插（见 write-preset 测试的顶层 persona 断言）。
  assert.equal(rows.some((row) => row?.id === 'router-first-turn'), false, '组合不应含 router-first-turn 行')
  assert.ok(!/__[A-Za-z0-9_]+__/.test(fixtureComposition()), '生成文本不应残留未解析 token')
})

test('子代理模型路由与委派完整自定义：模型转交官方 tool-subagent Config + maxDepth 渲染', () => {
  const rows = parseYaml(fixtureComposition({
    subagentModelProvider: 'my-provider',
    subagentModelName: 'deepseek-v4-flash-7013',
    maxDepth: 1,
  }))
  const subs = findAllNested(rows, new Set(['tool-subagent', 'tool-subagent-fork']))
  assert.equal(subs.length, 2, 'subagent 与 subagent_fork 两行都应渲染')
  for (const row of subs) {
    assert.equal(row.config.agentOptions.provider, 'my-provider')
    assert.equal(row.config.agentOptions.model, 'deepseek-v4-flash-7013')
    assert.equal(row.config.maxDepth, 1)
    // B7 T3：委派 `toolFilter` 通道随 toolFilterAllow/Deny 一并删除，两行都不再承接它。
    assert.equal(row.config.toolFilter, undefined, '委派行不再有 toolFilter 通道')
  }
})

test('实例策略启用后主过滤不下沉 delegation，模型路由与 maxDepth 转交策略模块', () => {
  const base = loadPresetSpec(resolvePresetDir('pt-minimal'))
  const policy = {
    defaultProfile: 'base', ceiling: { allow: ['read'], deny: [] },
    profiles: [{ id: 'base', name: '基础', allow: ['read'], deny: [], modelSelectable: false }],
  }
  const rows = parseYaml(renderComposition({ ...base, subagentToolPolicy: policy }, {
    subagentModelProvider: 'deepseek', subagentModelName: 'child',
    subagentReasoningEffort: 'high', subagentMaxTokens: '4096',
    maxDepth: 2,
  }))
  const policyRow = rows.find((row) => row?.id === 'subagent-tool-policy')
  assert.ok(policyRow, '策略段非空时自动装配模块')
  assert.deepEqual(policyRow.config.agentOptions, { provider: 'deepseek', model: 'child', reasoningEffort: 'high', maxTokens: 4096 })
  assert.equal(policyRow.config.maxDepth, 2)
  const subs = findAllNested(rows, new Set(['tool-subagent', 'tool-subagent-fork']))
  assert.ok(subs.every((row) => row.config.toolFilter === undefined), '旧主过滤不再写入官方 delegation')
})

test('参数桥透传模块行参数覆盖组合源行默认', () => {
  const rows = parseYaml(fixtureComposition({ toolGitBashEnabled: false }))
  const row = rows.find((item) => item?.id === 'tool-git-bash')
  assert.ok(row)
  assert.equal(row.config.enabled, false, '参数桥覆盖组合源行默认 enabled: true')
  // 未传时用组合源行默认。
  const defaults = parseYaml(fixtureComposition())
  assert.equal(defaults.find((item) => item?.id === 'tool-git-bash').config.enabled, true)
})

test('参数桥：模块绑定参数直达该行 config（不 token 化）', () => {
  const rows = parseYaml(fixtureComposition({
    toolGitBashEnabled: false,
    strReplaceEditorMaxOutputChars: 12000,
    instructionHint: true,
  }))
  const bash = rows.find((row) => row?.id === 'tool-git-bash')
  assert.equal(bash.config.enabled, false, 'toolGitBashEnabled 直达 tool-git-bash 行')
  assert.equal(bash.config.timeoutMs, 120000, '未被参数桥覆盖的键保留行默认')
  const [editor] = findAllNested(rows, new Set(['str-replace-editor']))
  assert.equal(editor.config.maxOutputChars, 12000, 'strReplaceEditorMaxOutputChars 直达嵌套的 str-replace-editor 行')
  // `instructionHint` 的落点是 `instruction-hint` 行。夹具预设的 modules 不含它，且该参数卡的
  // moduleKeys 为空（不再隐含装配），所以本轮组合里没有该行 —— 「参数有没有落点」由组合源断言
  // （instruction-hint.yml 存在即绿，见 test/shared/engine-config-closure.test.mjs）。
  assert.equal(rows.some((row) => row?.id === 'instruction-hint'), false, '未装配的模块不产生幽灵行')
  // 未声明的模块参数不合并（行默认 / 引擎默认生效）。
  const defaults = parseYaml(fixtureComposition())
  assert.equal(defaults.find((row) => row?.id === 'tool-git-bash').config.enabled, true, '未声明时用行默认')
})

test('参数桥完整性：手写白名单模块的产出键 ⊆ 该模块的 ALLOWED_KEYS', () => {
  // 手抄 engine/instruction-hint.mjs 的 ALLOWED_KEYS 一份；mirror-guards 做双向比对，
  // 防止「镜像漂移」让这条检查静默失效。B7 T3 后它是**唯一**还用手写白名单的本地模块
  // （其余已迁 `defineConfig`，其闭合由 test/shared/engine-config-closure.test.mjs 守卫）。
  const ALLOWED = {
    'instruction-hint': new Set(['enabled', 'promoteOn', 'includeSubagents']),
  }
  const sampleOf = (key) => {
    const definition = ENGINE_PARAM_DEFINITIONS[key]
    if (definition.kind === 'boolean') return true
    if (definition.kind === 'number') return 1
    if (definition.kind === 'string-list') return ['shell']
    return 'x'
  }
  let checked = 0
  for (const [module, allow] of Object.entries(ALLOWED)) {
    const params = {}
    for (const key of ENGINE_PARAM_KEYS) {
      if (ENGINE_PARAM_DEFINITIONS[key].module?.row !== module) continue
      params[key] = sampleOf(key)
    }
    assert.ok(Object.keys(params).length > 0, `${module}: 应至少有一个模块绑定参数`)
    const produced = buildModuleConfigsFromParams(params)[module]
    assert.ok(produced !== undefined, `${module}: 参数桥应产出该行 config`)
    for (const key of Object.keys(produced)) {
      assert.ok(allow.has(key), `${module} 行 config 键 ${key} 必须在 ALLOWED_KEYS 中（参数桥漏注册或行默认漂移）`)
    }
    checked += 1
  }
  // 解析型守卫的自证：数量过少说明 row→param 映射失效，不得静默空转。
  assert.ok(checked >= 1, `至少应校验 1 个手写白名单模块（实际 ${checked}）`)
})

test('参数桥优先于 moduleConfigs 直写：UI 开关不被行级直写覆盖（旧作者锁定语义移除）', () => {
  const spec = loadPresetSpec(resolvePresetDir(FIXTURE_PRESET_ID))
  // 模拟模板/ST 直写 tool-git-bash.enabled（旧锁定语义会覆盖 UI，导致开关失效）。
  const withDirect = { ...spec, moduleConfigs: { 'tool-git-bash': { enabled: true } } }
  // 1) 参数桥关闭 → 桥优先，直写不覆盖。
  const rows = parseYaml(renderComposition(withDirect, { toolGitBashEnabled: false }))
  const bash = rows.find((r) => r?.id === 'tool-git-bash')
  assert.equal(bash.config.enabled, false, '参数桥（UI）优先于 moduleConfigs 直写，开关必须生效')
  // 2) 参数桥未设置 → moduleConfigs 直写仍生效（桥未覆盖的键照常合并）。
  const rows2 = parseYaml(renderComposition(withDirect, {}))
  const bash2 = rows2.find((r) => r?.id === 'tool-git-bash')
  assert.equal(bash2.config.enabled, true, '桥未覆盖时 moduleConfigs 直写生效')
})

test('显式 moduleConfigs 行 ⇒ 自动装配对应能力（参数在 ⇒ 装配在）', () => {
  const base = loadPresetSpec(resolvePresetDir('pt-custom'))
  const spec = {
    ...base,
    moduleConfigs: {
      'tool-git-bash': { timeoutMs: 60000 },
      'tool-config-engine': { requireApproval: ['shell'] },
    },
  }
  const ids = parseYaml(renderComposition(spec, {})).map((row) => row.id)
  assert.ok(ids.includes('tool-git-bash'), '显式行配置隐含 tool-git-bash 装配')
  assert.ok(ids.includes('tool-config-engine'), '显式行配置隐含 tool-config-engine 装配')
})

// —— 参数目录与桥接契约（原 param-contract.test.mjs） ——

/** 非 writer 键的合法样本值（类型与引擎消费一致；键缺失时测试报「无装配消费」）。 */
const BRIDGE_SAMPLES = {
  // B7 T3：样本集收缩到存活参数（七个专用能力的参数键已随模块删除）。
  toolGitBashEnabled: false,
  strReplaceEditorMaxOutputChars: 20000,
  customToolRequireApproval: ['shell', 'fs'],
  instructionHint: true,
  maxDepth: 2,
}

test('PARAM_KEYS 派生一致性：= ENGINE_PARAM_KEYS + promptConfigs', () => {
  // 锚定/引导内容键已并入 ENGINE_PARAM_KEYS，旁路清单只剩 settings 载荷键 promptConfigs。
  const EXTRA = new Set(['promptConfigs'])
  const engineKeys = new Set(ENGINE_PARAM_KEYS)
  for (const key of PARAM_KEYS) {
    assert.ok(engineKeys.has(key) || EXTRA.has(key), `${key} 应属于 ENGINE_PARAM_KEYS 或附加键`)
  }
  for (const key of ENGINE_PARAM_KEYS) {
    assert.ok(PARAM_KEYS.has(key), `${key} 应从 ENGINE_PARAM_KEYS 派生进 PARAM_KEYS`)
  }
  for (const key of EXTRA) {
    assert.ok(PARAM_KEYS.has(key), `${key} 附加键应存在`)
  }
  // 七个内容键不得再以旁路键存在：它们必须同时进白名单与值校验（否则又是「白名单接受、值校验拒绝」）。
  for (const key of ['buildPattern', 'complexPattern', 'firstTurnBuild', 'firstTurnInspect', 'firstTurnDeep', 'guideWeak', 'guideDeep']) {
    assert.ok(engineKeys.has(key), `${key} 应已并入 ENGINE_PARAM_KEYS`)
  }
  // 无重复。
  assert.equal(PARAM_KEYS.size, ENGINE_PARAM_KEYS.length + EXTRA.size, 'PARAM_KEYS 无重复键')
})

test('BRIDGE_SAMPLES 覆盖的每个键都必须被参数桥装配消费（防「加键没装配」）', () => {
  // 原判定是「非 writer 键必须有参数桥消费」，但 WRITER_PARAM_KEYS === ENGINE_PARAM_KEYS
  // 使该判定恒为真 → 循环体从不执行（守卫空转）。改为按实际样本集校验：
  // 凡有样本值的引擎键，都必须能被参数桥消费成组合行 config。
  const bridgeConsumed = new Set(Object.keys(buildModuleConfigsFromParams({})))
  const sampleKeys = Object.keys(BRIDGE_SAMPLES)
  assert.ok(sampleKeys.length > 0, 'BRIDGE_SAMPLES 不得为空')
  for (const key of sampleKeys) {
    assert.ok(ENGINE_PARAM_KEYS.includes(key), `${key} 的样本值应属于引擎参数键`)
    const configs = buildModuleConfigsFromParams({ [key]: BRIDGE_SAMPLES[key] })
    assert.ok(Object.keys(configs).length > 0, `${key} 应被参数桥消费（产出组合行 config）`)
    for (const id of Object.keys(configs)) bridgeConsumed.add(id)
  }
  const allConfigs = buildModuleConfigsFromParams(BRIDGE_SAMPLES)
  for (const row of ['tool-git-bash', 'str-replace-editor', 'tool-config-engine', 'instruction-hint', 'tool-subagent']) {
    assert.ok(Object.hasOwn(allConfigs, row), `参数桥应覆盖核心行 ${row}`)
  }
})

test('runtimeOf 保留 ENGINE_PARAM_KEYS 全键透传（输出是 Record<string, unknown>，无类型保护）', () => {
  // runtimeOf 的返回类型是 Record<string, unknown>：输出键没有类型保护，
  // 全键透传只靠实现里的 `ENGINE_PARAM_KEYS.map(...)`，删掉它会静默丢参数且 TS 不报错。
  const runtimeOfBody = readFileSync(new URL('../../src/host/write-preset.ts', import.meta.url), 'utf8')
    .match(/function runtimeOf\([\s\S]*?\n\}/)?.[0]
  assert.ok(runtimeOfBody !== undefined, 'write-preset.ts 应可定位 runtimeOf 实现')
  assert.match(runtimeOfBody, /ENGINE_PARAM_KEYS\.map\(/,
    'runtimeOf 必须保留 ENGINE_PARAM_KEYS 全键透传')
  const handled = new Set([...runtimeOfBody.matchAll(/options\.([A-Za-z0-9_]+)/g)].map((match) => match[1]))
  // 解析型守卫的自证：正则一旦失效，断言不得静默空转。
  assert.ok(handled.size > 0, 'runtimeOf 显式处理键的解析结果不得为空')
})

test('装配态回读同样保留 ENGINE_PARAM_KEYS 全键覆盖（index.ts reloadPresetParams）', () => {
  const reloadBody = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8')
    .match(/const reloadPresetParams = \(\)[\s\S]*?\n  \}/)?.[0]
  assert.ok(reloadBody !== undefined, 'index.ts 应可定位 reloadPresetParams')
  assert.match(reloadBody, /for \(const key of ENGINE_PARAM_KEYS\)/,
    'reloadPresetParams 必须保留 ENGINE_PARAM_KEYS 全键回读（否则预设参数保存后运行时部分键不更新）')
})

test('组合源 yml 出现的键都有归属：参数目录登记，或该模块自有配置键', () => {
  // 断言的是「有登记」而非值相等：yml 行默认是运行时真源，
  // ENGINE_PARAM_DEFINITIONS.defaultValue 只是编辑草稿（见 docs/architecture-params.md）。
  const localDir = new URL('../../engine/compositions/source/local/', import.meta.url)
  const ymlFiles = readdirSync(localDir).filter((name) => name.endsWith('.yml'))
  assert.ok(ymlFiles.length > 0, '本地组合源目录不得为空')

  /**
   * 模块自有配置键；无同名模块文件时返回 undefined。
   * 两种形态都要认：B2 起白名单由 `defineConfig({...})` 的字段声明派生（单一来源），
   * 待删的 7 个模块仍是手写 `ALLOWED_KEYS` 字面量（B7 连模块一起删）。
   * 只认旧的 `ALLOWED_KEYS` 会让迁移后的模块落回空集、被 pendingWhitelist 静默跳过——
   * 守卫看着绿、实际不再检查（这条是 B2 实测暴露出来的空转）。
   */
  const ownKeysOf = (rowId) => {
    let source
    try {
      source = readFileSync(new URL(`../../engine/${rowId}.mjs`, import.meta.url), 'utf8')
    } catch {
      return undefined
    }
    const declared = source.match(/defineConfig\(\{([\s\S]*?)\n\}\)/)?.[1]
    if (declared !== undefined) {
      const keys = [...declared.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*):/gm)].map((match) => match[1])
      if (keys.length > 0) return new Set(keys)
    }
    const block = source.match(/const ALLOWED_KEYS = new Set\(\[([\s\S]*?)\]\)/)?.[1]
    return new Set(block === undefined ? [] : [...block.matchAll(/'([^']+)'/g)].map((match) => match[1]))
  }

  // 组合源 yml 的顶层是行数组，且行内 config 可再嵌套行数组（delegation 组），故需递归收集。
  const rows = []
  const collect = (items) => {
    for (const item of Array.isArray(items) ? items : []) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
      if (typeof item.id === 'string'
        && item.config !== null && typeof item.config === 'object' && !Array.isArray(item.config)) {
        rows.push({ id: item.id, keys: Object.keys(item.config) })
      }
      collect(item.config)
    }
  }
  for (const file of ymlFiles) collect(parseYaml(readFileSync(new URL(file, localDir), 'utf8')))
  assert.ok(rows.length > 0, '组合源 yml 应含至少一个模块行')

  const ownCache = new Map()
  const unowned = []
  const skipped = new Set()
  const pendingWhitelist = new Set()
  let checked = 0
  for (const row of rows) {
    if (!ownCache.has(row.id)) ownCache.set(row.id, ownKeysOf(row.id))
    const own = ownCache.get(row.id)
    // 无同名模块文件 = 官方行或改名行（实测：fs-local / str-replace-editor / terminal-bash /
    // persistent-bash / terminal-pwsh / persistent-pwsh）：其配置键由官方包契约负责，不断言。
    if (own === undefined) {
      skipped.add(row.id)
      continue
    }
    // 有同名模块文件但没有 ALLOWED_KEYS（实测：prompt-config-engine / tool-config-engine /
    // subagent-tool-policy）：这正是 B2 T4「四个无白名单模块补字段声明与校验」的待办对象。
    // B0 不改引擎行为，故此处只登记；B2 补完白名单后这些行会自然进入下面的严格检查。
    if (own.size === 0) {
      pendingWhitelist.add(row.id)
      continue
    }
    for (const key of row.keys) {
      checked += 1
      const registered = ENGINE_PARAM_KEYS.some((paramKey) => {
        const binding = ENGINE_PARAM_DEFINITIONS[paramKey].module
        return binding?.row === row.id && (binding.key ?? paramKey) === key
      })
      if (!registered && !own.has(key)) unowned.push(`${row.id}.${key}`)
    }
  }
  assert.ok(checked > 0, `应检查到组合源 yml 的配置键（否则守卫空转）；跳过：无同名模块文件 ${[...skipped].join(',') || '无'}；待 B2 补白名单 ${[...pendingWhitelist].join(',') || '无'}`)
  assert.deepEqual(unowned, [], `这些键既未在参数目录登记，也不属于该模块的 ALLOWED_KEYS → 无人拥有（跳过：${[...skipped].join(',') || '无'}；待 B2 T4 补白名单：${[...pendingWhitelist].join(',') || '无'}）`)
})

test('MODEL_SEGMENT_MAP 显式迁移源唯一，覆盖全部旧模型字段', () => {
  const targets = new Set()
  for (const [flatKey, [segment, segmentKey]] of Object.entries(MODEL_SEGMENT_MAP)) {
    assert.ok(flatKey.length > 0 && segment.length > 0 && segmentKey.length > 0, `映射项非空: ${flatKey}`)
    const target = `${segment}.${segmentKey}`
    assert.ok(!targets.has(target), `段目标重复: ${target}（两个扁平键映射到同一段键）`)
    targets.add(target)
  }
  assert.equal(Object.keys(MODEL_SEGMENT_MAP).length, 10, '模型段映射应覆盖 10 个扁平键')
})

test('字符串深度与数字同义，普通委派及实例策略均接收归一后的限制', () => {
  for (const value of [0, 2, 'provider-managed']) {
    for (const subagentPolicyEnabled of [false, true]) {
      const options = { subagentPolicyEnabled }
      const configs = buildModuleConfigsFromParams({ maxDepth: String(value) }, options)
      assert.deepEqual(configs, buildModuleConfigsFromParams({ maxDepth: value }, options))
      for (const id of ['tool-subagent', 'tool-subagent-fork', ...(subagentPolicyEnabled ? ['subagent-tool-policy'] : [])]) {
        assert.equal(configs[id].maxDepth, value)
      }
    }
  }
  for (const maxDepth of ['', ' ', 'invalid', '-1', '1.5']) {
    assert.equal(buildModuleConfigsFromParams({ maxDepth })['tool-subagent'], undefined)
  }
})

// —— 主/子代理分离的设计一致性（原 scope-separation-audit.test.mjs） ——
// 覆盖四层边界：
// 1. 模块参数：子代理专属参数只落 `includeSubagents` 键，主会话侧开关不越界；
// 2. 工具过滤：主对话 `tool-filter` 与子代理 `delegation.toolFilter` / 实例级策略互不串写；
// 3. 模型参数：`model*` → `audience: main`，`subagent*` → `audience: subagent`（agent-request patch）；
// 4. 提示词配置受众：`audience` 决定注入对象，主/子列表各自过滤。

test('模块参数按行落位：每个绑定键只写自己那一行，已删能力不产生幽灵行', () => {
  const configs = buildEngineModuleParams({
    toolGitBashEnabled: false,
    strReplaceEditorMaxOutputChars: 12000,
    customToolRequireApproval: ['shell'],
    instructionHint: true,
  })
  assert.deepEqual(configs['tool-git-bash'], { enabled: false })
  assert.deepEqual(configs['str-replace-editor'], { maxOutputChars: 12000 })
  assert.deepEqual(configs['tool-config-engine'], { requireApproval: ['shell'] })
  assert.deepEqual(configs['instruction-hint'], { enabled: true })
  // 交叉污染检查：七个专用能力的行名不得再被参数桥产出。
  for (const ghost of ['tool-filter', 'context-gate', 'tool-bootstrap', 'progress-reminder',
    'deliberation-gate', 'anchor-turn', 'promoted-code-mode']) {
    assert.equal(configs[ghost], undefined, `${ghost} 不得有幽灵行配置`)
  }
})

test('参数目录层面：主/子代理专属参数绑定到不同行，模块绑定面收敛到存活能力', () => {
  const bindingsOf = (card) => Object.entries(ENGINE_PARAM_DEFINITIONS)
    .filter(([, definition]) => definition.card === card)
    .map(([key]) => key)
    .sort()
  assert.deepEqual(bindingsOf('main-model'), ['modelMaxTokens', 'modelName', 'modelProvider', 'modelReasoningEffort', 'modelTemperature'])
  assert.deepEqual(bindingsOf('subagent-model'), ['subagentMaxTokens', 'subagentModelName', 'subagentModelProvider', 'subagentReasoningEffort', 'subagentTemperature'])
  assert.deepEqual(bindingsOf('subagent-tools'), ['maxDepth'])
  // B7 T3：七张专用能力卡（含 `tool-filter`）已删除，不得再有参数键登记在它们名下。
  for (const card of ['tool-filter', 'context-gate', 'tool-bootstrap', 'anchor-turn',
    'deliberation-gate', 'progress-reminder', 'promoted-code-mode']) {
    assert.deepEqual(bindingsOf(card), [], `${card} 卡已删除，不得再有参数键`)
  }
  // 主/子模型参数一一对称且零交集（预设顶层 model / subagentModel 两段是唯一来源）。
  const mainModel = new Set(bindingsOf('main-model'))
  for (const key of bindingsOf('subagent-model')) assert.equal(mainModel.has(key), false, `${key} 不得同时属于主与子`)
  // 模块绑定面 = 四个存活能力提供者的行（每个键各自唯一落点）。
  const rows = new Set()
  for (const key of ENGINE_PARAM_KEYS) {
    const binding = ENGINE_PARAM_DEFINITIONS[key].module
    if (binding !== undefined) rows.add(binding.row)
  }
  assert.deepEqual([...rows].sort(), ['instruction-hint', 'str-replace-editor', 'tool-config-engine', 'tool-git-bash'])
})

test('委派落位：toolFilter 通道已删除，子代理工具面只由实例级策略授权', () => {
  const params = { maxDepth: 2 }
  const legacy = buildModuleConfigsFromParams(params, { subagentPolicyEnabled: false })
  for (const id of ['tool-subagent', 'tool-subagent-fork']) {
    assert.equal(legacy[id].toolFilter, undefined, `${id} 不得再有 toolFilter 通道（B7 T3 拍板一并删除）`)
    assert.equal(legacy[id].maxDepth, 2, '与过滤无关的委派参数不受影响')
  }
  const withPolicy = buildModuleConfigsFromParams(params, { subagentPolicyEnabled: true })
  assert.equal(withPolicy['tool-subagent'].toolFilter, undefined)
  assert.equal(withPolicy['subagent-tool-policy'].maxDepth, 2, '策略启用后 maxDepth 转交策略模块')
  // 三个工具过滤参数键已从参数目录整体删除。
  for (const key of ['toolFilterAllow', 'toolFilterDeny', 'toolFilterEnabled']) {
    assert.equal(ENGINE_PARAM_KEYS.includes(key), false, `${key} 应已从参数目录删除`)
  }
})

test('组合端到端：模块绑定参数只落在自己那一行，其他行保持独立', () => {
  const dir = resolvePresetDir(FIXTURE_PRESET_ID)
  const spec = loadPresetSpec(dir)
  const rendered = renderComposition(spec, { toolGitBashEnabled: false }, dir)
  const rows = parseYaml(rendered)
  const bash = rows.find((row) => row?.id === 'tool-git-bash')
  const web = rows.find((row) => row?.id === 'tool-web')
  assert.equal(bash.config.enabled, false, 'toolGitBashEnabled 落在 tool-git-bash 行')
  assert.equal(bash.config.timeoutMs, 120000, '同行的其他键保留行默认')
  assert.equal(Object.hasOwn(web.config, 'enabled'), false, '未绑定参数的行不得被污染')
  assert.ok(!/__[A-Za-z0-9_]+__/.test(rendered), '不残留未解析 token')
})

test('实例级工具策略：声明后装配 shadow 行并指向生成目录策略文件，未声明则不装配', () => {
  const dir = resolvePresetDir(FIXTURE_PRESET_ID)
  const base = loadPresetSpec(dir)
  const withPolicy = {
    ...base,
    subagentToolPolicy: {
      defaultProfile: 'reader',
      ceiling: { allow: ['read'], deny: [] },
      profiles: [{ id: 'reader', name: '只读', allow: ['read'], deny: [], modelSelectable: true }],
    },
  }
  const rows = parseYaml(renderComposition(withPolicy, {}, dir))
  const [policyRow] = findAllNested(rows, new Set(['subagent-tool-policy']))
  assert.ok(policyRow, '声明策略后必须装配 subagent-tool-policy 行')
  assert.equal(policyRow.config.policyFile, '../subagent-tools/policy.yml', '策略文件指向生成目录')
  assert.equal(policyRow.config.spawnProvider, 'spawn', 'shadow 覆盖 spawn 工具名')
  assert.equal(policyRow.config.forkProvider, 'fork', 'shadow 覆盖 fork 工具名')
  // 未声明策略时不装配该模块（opt-in），子代理工具面回落到 delegation 行。
  const without = parseYaml(renderComposition(base, {}, dir))
  assert.deepEqual(findAllNested(without, new Set(['subagent-tool-policy'])), [])
  assert.ok(findAllNested(without, new Set(['tool-subagent'])).length > 0, '未启用策略时仍由官方委派行供工具')
})

test('真实来源：表单局部编辑经 bridge/writer 重读，清空、只读与过期预设不串写', async () => {
  const { mkdirSync, readFileSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { createElement, isValidElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { withSsr, makeTranslate } = await import('../client/support/ssr-render.mjs')
  const { StrategyParamsFields } = await withSsr([new URL('../../src/client/features/prompts/PromptConfigFields.tsx', import.meta.url).href])
  const { writePreset } = await import('../../src/host/write-preset.ts')
  const { registerSettingsBridge } = await import('../../src/runtime/settings-bridge.ts')
  const { bridgeCall } = await import('../../src/client/data/bridge-client.ts')
  const { stripConfigFieldSources } = await import('../../src/shared/managed-config-fields.ts')
  const { withConfigFieldSources } = await import('../../src/client/data/prompt-tool-view.ts')
  const { handlerTable, fakeReq, fakeRes } = await import('../fixtures/host-harness.mjs')
  const root = join(home, '.agent-presets')
  const id = 'managed-source-roundtrip'
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  const initial = {
    id, modules: [], layerSettings: { 'pre-step': { firstTurnAnchor: true, firstTurnText: 'GLOBAL' } },
    promptConfigs: [
      { id: 'near-anchor', layer: 'pre-step', strategy: 'first-turn-anchor', enabled: false, params: { text: 'LOCAL', useCustom: true } },
      { id: 'ordinary-anchor', layer: 'pre-step', strategy: 'first-turn-anchor', params: { text: 'ORDINARY' } },
    ],
  }
  const { stringify } = await import('yaml')
  writeFileSync(join(dir, 'preset.yml'), stringify(initial), 'utf8')
  const options = { presetDir: root, presetTemplate: id, presetOrder: 5, promptConfigs: [] }
  writePreset('', options)
  let active = dir
  let rebuilds = 0
  const table = handlerTable()
  const disposers = []
  const sctx = {
    settings: { describe: () => [{ ns: 'prompt-tool', value: { presetTemplate: id }, revision: 1 }], get: () => undefined },
    webServer: { register: table.register },
    get: () => undefined,
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
  }
  registerSettingsBridge({ inject: (_deps, callback) => callback(sctx) }, 'prompt-tool',
    () => ({ available: false, providers: [] }),
    () => ({ skillsRoot: join(home, 'skills'), folders: [], listSkills: () => [] }), () => '', undefined, () => active, undefined,
    () => {
      const spec = loadPresetSpec(dir)
      writePreset('', { ...resolvePresetParams(spec, {}), ...options, promptConfigs: spec.promptConfigs })
      rebuilds += 1
    })
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const handler = table.handlers.get(String(url))
    assert.ok(handler, `bridge 端点已注册：${url}`)
    const res = fakeRes()
    await handler(fakeReq({ raw: init.body }), res)
    return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json' } })
  }
  const read = async () => {
    const result = await bridgeCall('promptConfigs')
    assert.equal(result.ok, true)
    return result.value.promptConfigs.filter((config) => config.sourceKind !== 'instruction-file').map(withConfigFieldSources)
  }
  const sourceOf = (config, path) => config.fieldSources?.fields.find((field) => field.path === path)?.source
  const t = makeTranslate()
  const find = (node, predicate) => Array.isArray(node) ? node.map((child) => find(child, predicate)).find(Boolean)
    : !isValidElement(node) ? undefined : predicate(node) ? node : find(node.props.children, predicate)
  try {
    let configs = await read()
    assert.equal(configs[0].params.text, 'GLOBAL')
    assert.equal(sourceOf(configs[0], 'params.text'), 'preset-param', '读当前离线产物，不能拿下一次在线来源冒充当前来源')
    const boot = await bridgeCall('bootstrap')
    assert.equal(boot.ok, true)
    assert.deepEqual(boot.promptConfigs.promptConfigs.find((config) => config.id === 'near-anchor').fieldSources, configs[0].fieldSources)
    // 在线生产路径的最高覆盖层是原始 spec.promptConfigs；必须保持 LOCAL，不能强制全局胜出。
    writePreset('', { ...options, promptConfigs: loadPresetSpec(dir).promptConfigs })
    configs = await read()
    assert.equal(configs[0].params.text, 'LOCAL')
    assert.equal(sourceOf(configs[0], 'params.text'), 'prompt-config')
    assert.equal(sourceOf(configs[0], 'enabled'), 'prompt-config')
    assert.equal(configs[1].fieldSources, undefined, '普通同策略配置不锁定')
    for (const nextText of ['EDITED-IN-FORM', '']) {
      let edited = configs[0]
      let tree
      function Probe() {
        tree = StrategyParamsFields({ t, ...edited, onPatch(params) { edited = { ...edited, params } } })
        return null
      }
      renderToStaticMarkup(createElement(Probe))
      const input = find(tree, (element) => element.props.label === t('strategyParam.anchorText.label'))
      assert.ok(input, '真实局部来源必须渲染编辑入口')
      input.props.onChange(nextText)
      const saved = await bridgeCall('paramOverrides', { expectedPresetId: id, promptConfigs: [edited, configs[1]].map(stripConfigFieldSources) })
      assert.equal(saved.ok, true)
      configs = await read()
      assert.equal(configs[0].params.text, nextText)
      assert.equal(sourceOf(configs[0], 'params.text'), 'prompt-config')
      assert.equal(loadPresetSpec(dir).promptConfigs[0].fieldSources, undefined)
    }
    // 伪造来源元数据不能写入定义，也不能改变真实覆盖优先级。
    const forged = await bridgeCall('paramOverrides', { expectedPresetId: id, promptConfigs: [{ ...configs[0], fieldSources: { configId: 'near-anchor', fields: [{ path: 'params.text', source: 'preset-param', file: 'SECRET' }] } }, configs[1]] })
    assert.equal(forged.ok, true)
    assert.equal(loadPresetSpec(dir).promptConfigs[0].fieldSources, undefined)
    assert.equal(sourceOf((await read())[0], 'params.text'), 'prompt-config')
    const before = readFileSync(join(dir, 'preset.yml'), 'utf8')
    const count = rebuilds
    const stale = await bridgeCall('paramOverrides', { expectedPresetId: 'old-preset', promptConfigs: [] })
    assert.equal(stale.ok, false)
    assert.equal(stale.code, 'preset-changed')
    active = join(home, 'system-preset')
    mkdirSync(active)
    writeFileSync(join(active, 'preset.yml'), before)
    const readonly = await bridgeCall('paramOverrides', { expectedPresetId: 'system-preset', promptConfigs: [] })
    assert.equal(readonly.ok, false)
    assert.equal(readonly.code, 'preset-readonly')
    assert.equal(readFileSync(join(active, 'preset.yml'), 'utf8'), before)
    assert.equal(readFileSync(join(dir, 'preset.yml'), 'utf8'), before)
    assert.equal(rebuilds, count)
  } finally {
    globalThis.fetch = previousFetch
    for (const dispose of disposers.reverse()) dispose()
  }
})
