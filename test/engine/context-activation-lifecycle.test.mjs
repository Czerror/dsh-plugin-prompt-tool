// 上下文激活的可见历史、压缩与多模块递归，以及注入身份和去重。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { compileRules } from '../../engine/rule-spec.mjs'
import { conversationMessages, selectContextActivation, lastContextActivationDiagnostics } from '../../engine/context-activation.mjs'
import { SURFACE_MESSAGE_TYPES } from '../../engine/history.mjs'
import { runPreStepBatch } from '../../engine/executor.mjs'
import { createPreStepSource } from '../../engine/pre-step-source.mjs'
import { identityStampOf } from '../../engine/delivery.mjs'
import { createPromptConfigs as createPromptConfigsCore } from '../../engine/schema.mjs'
import { isolatedHome } from '../fixtures/host-harness.mjs'

// 模块级开关要按完整链路验证（module.yml → ModuleSpec → compileRules 顶层选项）；
// 隔离 DSH_HOME 用夹具完成，动态 import 只是本文件的既有写法（paths.ts 已不再 import 期冻结）。
const { moduleRoot } = isolatedHome('pt-stwb-')
const { prepareAssembly } = await import('../../src/runtime/agent-assembly.ts')
const { validateModuleDefinitionText } = await import('../../src/host/module-slices.ts')
/** 可见消息与完整日志分离；成功压缩只保留摘要节点。 */
function visibleSession(id) {
  const log = []
  const nodes = []
  return {
    session: { id, header: {}, snapshotEvents: () => log, surface: { nodes } },
    push(event) { log.push(event); if (SURFACE_MESSAGE_TYPES.has(event.type)) nodes.push(log.length - 1) },
    compact(summary) {
      nodes.length = 0
      log.push({ type: 'compaction/end', seq: log.length, data: {} })
      log.push({ type: 'user/message', seq: log.length, data: { message: summary } })
      nodes.push(log.length - 1)
    },
  }
}


test('context-activation：扫描范围 = 模型可见的真实对话——被压缩遮蔽的关键词不再命中', () => {
  // 原生条目的正文、共享匹配键和显式 history 扫描面独立声明。
  const entry = (id) => ({
    id, name: id, strategy: 'context-activation', order: 100, text: 'LORE', layer: 'pre-step',
    position: 'before-all', enabled: true,
    params: { constant: false, keys: ['龙'], activation: { scan: 'history', scanDepth: 2 } },
  })
  const say = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
  const store = visibleSession('st-wb-surface')
  store.push({ type: 'user/message', seq: 0, data: { message: say('u0', '龙现身了') } })
  store.session.surface.nodes.length = 0

  assert.deepEqual(conversationMessages(store.session), [], '遮蔽掉的对话不在扫描 haystack 里')
  assert.equal(selectContextActivation([entry('lore')], store.session, []).size, 0,
    '关键词只出现在被遮蔽的消息里 → 条目不入选（迁移前读完整历史 → 命中）')

  // 降级对照：无 surface 时退回完整历史，命中行为与迁移前一致。
  assert.equal(selectContextActivation([entry('lore-degraded')], { snapshotEvents: store.session.snapshotEvents }, []).size, 1,
    '无 surface 的会话仍扫完整历史')
})

test('context-activation：成功压缩重基准窗口状态——sticky 不得让键已不在可见面上的条目继续入选', () => {
  // 真值源＝ST 的 sticky 窗口语义（「自上次入选起的 N 条可见消息」）：`last` 记的是**绝对可见计数**，
  // 而 `chat` 现在来自 `currentEvents`（可缩小的视图）。压缩把可见面塌成一条不含键的摘要后，
  // 压缩前的基准必须作废（判据与 count / anchor 的失效点同源：成功 `compaction/end`），
  // 否则 `chat.length < last + sticky` 恒真，条目会在键早已不可见时一直重注。
  const entry = {
    id: 'lore', name: 'lore', strategy: 'context-activation', order: 100, text: 'LORE', layer: 'pre-step',
    position: 'before-all', enabled: true,
    params: { constant: false, keys: ['龙'], activation: { scan: 'history', scanDepth: 2, sticky: 3 } },
  }
  const say = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
  const store = visibleSession('stwb-window')
  store.push({ type: 'user/message', seq: 0, data: { message: say('u0', '龙现身了') } })
  const before = selectContextActivation([entry], store.session, [])
  assert.deepEqual([...before].map(config => config.id), ['lore'], '压缩前命中')
  // 窗口状态在 commit 时写回（`last` 是「这条消息真的落位了」才记的账）。
  before.commit(entry)

  store.compact(say('summary', '摘要'))
  assert.deepEqual([...selectContextActivation([entry], store.session, [])].map(config => config.id), [],
    '压缩重置窗口：sticky 不得让键已不在可见面上的条目继续入选')
})

test('context-activation：{{pick}} 的 seed 含条目身份——同键条目不共用取值且各自稳定', () => {
  // 判别力：省略 sourceId 时 16 条同键条目共享 sha256([会话,'',0])，取值必然全同 → 入选 0 或 16 条。
  // 取值是 sha256 的，故只断言「不是全同」——五选一全撞概率 5·5⁻¹⁶（同 interpolate.test.mjs 的理由）。
  const key = '{{pick::a::b::c::d::e}}'
  const entry = (id) => ({
    id, name: id, strategy: 'context-activation', order: 100, text: 'LORE', layer: 'pre-step',
    position: 'before-all', enabled: true, variables: {},
    params: { constant: false, keys: [key], activation: { scan: 'history', scanDepth: 2 } },
  })
  // 正文只含候选取值之一：条目入选与否直接反映自己那一处 pick 的取值。
  const session = (text = 'a') => ({
    id: 'stwb-pick', header: {},
    snapshotEvents: () => [{ type: 'user/message', seq: 0, data: { message: { id: 'u0', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } } }],
  })
  const entries = Array.from({ length: 16 }, (_, index) => entry(`wb-${index}`))
  const scan = (text) => [...selectContextActivation(entries, session(text), [])].map(config => config.id).sort()
  const selected = scan()
  assert.ok(selected.length > 0 && selected.length < entries.length,
    '不同条目各自的 seed 决定取值（共用 seed 时必然是 0 或 16 条）')
  assert.deepEqual(scan(), selected, '同一会话与条目下取值稳定')
  // T28 回归保持：seed 不含扫描正文，正文变长（仍含 'a'、不含其余候选取值）不改变任何键的取值。
  assert.deepEqual(scan('a 龙现身了并说了很长的一段话'), selected, '扫描正文变长不改变键的取值')
})

test('context-activation：递归只由模块顶层 contextActivationRecursive 决定，条目仍可拒绝递归', async () => {
  const dir = join(moduleRoot, 'stwb')
  mkdirSync(dir, { recursive: true })
  // 真值源：开关只在 module.yml 顶层（规格见 docs/SillyTavern.md）。
  // 夹具走与 `variablesEnabled` 同一条链路：module.yml 顶层 → ModuleSpec → prepareAssembly 的
  // compileRules 顶层选项 → 校验后打标到 compiledConfig（装配期真实入口，不是手搓 config）。
  const compile = async (recursive, entries) => {
    writeFileSync(join(dir, 'module.yml'), stringify({ id: 'stwb', modules: ['rule-engine'], rules: entries, ...(recursive ? { contextActivationRecursive: true } : {}) }))
    return (await prepareAssembly(moduleRoot, 'stwb', () => true)).rules.map(rule => rule.actions[0].compiledConfig)
  }
  // 正文在 text，匹配键在 params.keys，扫描与选择在 params.activation。
  const entry = (id, text, extra = {}) => ({
    id, then: [{ id: 'inject', kind: 'inject-text', config: {
      id, layer: 'pre-step', strategy: 'context-activation', text,
      params: { keys: [`key-${id}`], activation: { scan: 'history', scanDepth: 2, ...extra } },
    } }],
  })
  const session = {
    id: 'stwb', header: {},
    snapshotEvents: () => [{ type: 'user/message', seq: 0, data: { message: { id: 'u0', role: 'user', content: [{ type: 'text', text: 'key-a 现身' }], source: { kind: 'user' } } } }],
  }
  const scan = async (recursive, entries) => [...selectContextActivation(await compile(recursive, entries), session, [])].map(config => config.id).sort()
  // a 的正文含 b 的键：只有递归 pass 才可能让 b 入选（b 的键在对话里不出现）。
  const plain = [entry('a', 'A 正文 key-b'), entry('b', 'B 正文')]
  assert.deepEqual(await scan(true, plain), ['a', 'b'], '全局开关打开：正文里的键触发第二条')
  assert.deepEqual(await scan(false, plain), ['a'], '全局开关缺省（未声明）= 不递归，对齐 ST world_info_recursive 默认 false')
  assert.deepEqual(await scan(true, [entry('a', 'A 正文 key-b'), entry('b', 'B 正文', { excludeRecursion: true })]), ['a'],
    'excludeRecursion 仍是条目级判据（ST world-info.js:4870）')
  // 顶层字段是模块定义的一部分：类型错误在装载／保存边界 fail loud，不在扫描期静默当 false。
  assert.throws(() => validateModuleDefinitionText(join(tmpdir(), 'stwb'), 'id: stwb\ncontextActivationRecursive: "yes"\nrules: []\n'),
    /contextActivationRecursive 必须是布尔值/)
  assert.throws(() => compileRules([{ id: 'x', then: [{ id: 'i', kind: 'inject-text', config: { id: 'c', layer: 'pre-step', text: 'x', contextActivationRecursive: true } }] }]),
    /unknown config key/, '开关是模块级字段，写进动作配置按未知键拒绝')
})

// 多模块批次的装配夹具：模块级开关（module.yml 顶层）与 sourceModuleId 都由真实链路打标
// （module.yml → prepareAssembly → compileRules），批次形状与协调器汇总的 pre-step 一致。
async function compileContextActivation(moduleId, recursive, rules) {
  const dir = join(moduleRoot, moduleId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'module.yml'), stringify({ id: moduleId, modules: ['rule-engine'], rules, ...(recursive ? { contextActivationRecursive: true } : {}) }))
  return (await prepareAssembly(moduleRoot, moduleId, () => true)).rules.map(rule => rule.actions[0].compiledConfig)
}
const wbRule = (id, key, text, extra = {}) => ({
  id,
  then: [{ id: 'inject', kind: 'inject-text', config: {
    id, layer: 'pre-step', strategy: 'context-activation', text,
    params: { keys: [key], activation: { scan: 'history', scanDepth: 2, ...extra } },
  } }],
})
const wbSession = (id, text) => ({
  id, header: {},
  snapshotEvents: () => [{ type: 'user/message', seq: 0, data: { message: { id: 'u0', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } } }],
})
const selectedIds = (configs, session) => [...selectContextActivation(configs, session, [])].map(config => config.id).sort()

test('context-activation：递归开关按模块生效——未声明开关的模块不参与递归 pass', async () => {
  // 真值源＝手算的入选集合；批次 = 协调器汇总的多模块 pre-step 配置（executor.mjs#batchScope 的 qualified）。
  // B 的键只出现在 A 的正文里：改前（开关按批次取并集）会连带 B 一起重扫并入选
  // ['iso-a1','iso-a2','iso-b2']（同夹具在改前实现上实跑过）。
  const isolation = wbSession('stwb-iso', 'iso-a')
  const selected = selectedIds([
    ...await compileContextActivation('stwb-a', true, [wbRule('iso-a1', 'iso-a', 'A 正文 iso-a2 iso-b2'), wbRule('iso-a2', 'iso-a2', 'A2 正文')]),
    ...await compileContextActivation('stwb-b', false, [wbRule('iso-b2', 'iso-b2', 'B2 正文')]),
  ], isolation)

  // 硬条件①：B 未声明开关 → 不被 A 的递归正文触发；A 自己的递归 pass 仍照旧生效。
  assert.deepEqual(selected, ['iso-a1', 'iso-a2'], 'B 的条目不参与递归 pass')
  assert.ok(lastContextActivationDiagnostics(isolation).records.some(record => record.id === 'iso-b2' && record.stage === 'excluded' && record.reason === 'recursion'),
    'B 的条目被模块开关挡下（诊断不再是「被别的模块正文命中」）')
})

test('context-activation：两模块都开时与改前逐字一致（含跨模块正文驱动）', async () => {
  // 硬条件②：期望值＝改前实现在同一夹具上的输出（判别力证明里换回改前引擎跑一遍，本用例必须照样绿）。
  // 夹具刻意含跨模块驱动：d1 的键只出现在 c1 的正文里 —— 池是全批共享的（对齐 ST 全局扫描缓冲）。
  const equivalence = selectedIds([
    ...await compileContextActivation('stwb-c', true, [wbRule('eq-c1', 'eq-c', 'C 正文 eq-c2 eq-d1'), wbRule('eq-c2', 'eq-c2', 'C2 正文')]),
    ...await compileContextActivation('stwb-d', true, [wbRule('eq-d1', 'eq-d1', 'D1 正文 eq-d2'), wbRule('eq-d2', 'eq-d2', 'D2 正文')]),
  ], wbSession('stwb-eq', 'eq-c eq-d'))
  assert.deepEqual(equivalence, ['eq-c1', 'eq-c2', 'eq-d1', 'eq-d2'], '都开时每个模块的递归 pass 与入选集合不变')
})

test('context-activation：未声明递归开关的模块里，延迟层级池的既有语义不变', async () => {
  // 层级池是全批时钟（层级只增不减、与递归正文无关），因此不受模块开关门控：改前同结果。
  const session = wbSession('stwb-delay', 'dl-e1 dl-e2')
  const configs = await compileContextActivation('stwb-e', false, [
    wbRule('dl-e1', 'dl-e1', 'E1 正文', { delayUntilRecursion: 1 }),
    wbRule('dl-e2', 'dl-e2', 'E2 正文', { delayUntilRecursion: 2 }),
  ])
  assert.deepEqual(selectedIds(configs, session), ['dl-e1', 'dl-e2'], '开关缺省不改变延迟条目的解锁')

  // 缺省时批次不产生递归来源：没有新正文可递归 → 层级池不推进 → 只延迟到第 1 层的条目不被解锁（改前同结果）。
  const noSource = wbSession('stwb-delay-nosource', 'dl-f0 dl-f1')
  const offModule = await compileContextActivation('stwb-f', false, [
    wbRule('dl-f0', 'dl-f0', 'F0 正文'),
    wbRule('dl-f1', 'dl-f1', 'F1 正文', { delayUntilRecursion: 1 }),
  ])
  assert.deepEqual(selectedIds(offModule, noSource), ['dl-f0'], '无递归来源时层级池不推进')
})

// executor 的 pre-step 注入面（source 盖章与去重快路径）：夹具与 `prompt-config-engine.test.mjs`
// 的同名 seam 同源，只保留本分片要钉的两条判据。
const createPromptConfigs = (specs, options = {}) =>
  createPromptConfigsCore(specs, { strategyDir: new URL('../../engine/', import.meta.url).href, ...options })
const plainSession = id => ({ id, header: { delegationDepth: 0 }, snapshotEvents: () => [] })
const USER_TASK = { id: 'task-1', role: 'user', content: [{ type: 'text', text: '写一个工具' }], source: { kind: 'user' } }
// 晋升门控与本分片无关：批执行器只消费 status()。
const PROMOTION = { main: { status: () => ({ promoted: true }) }, withSubagents: { status: () => ({ promoted: true }) } }
const runBatch = (configs, session, memo = new Map()) => {
  const source = createPreStepSource({ sourceId: 'preset:activation', ctx: {}, configs, promotion: PROMOTION })
  return runPreStepBatch({
    ctx: {},
    agent: { session, options: { model: 'deepseek-chat' } },
    decision: { kind: 'enter', messages: [USER_TASK] },
    sources: [source],
    memo,
    warnOnce: () => {},
  })
}

test('executor：resolved.source 分支与 identityStampOf 盖同一份模块维（空串 sourceModuleId 不写 moduleId）', async () => {
  // 真值源＝T33 的不变量「空串与缺失同等」（`prompt-config-engine.test.mjs` 钉了 identityStampOf 一侧）。
  // 解析器自带 source 的消息走另一条分支（如 fill=instruction-hint 返回 `{ kind: ... }`），
  // 两条分支必须产出同一份盖章，否则 memo 的键与判定会按不同的模块维分叉。
  const [config] = createPromptConfigs(
    [{ id: 'hint', layer: 'pre-step', strategy: 'static', dedupe: 'session', text: 'HINT', position: 'after-all' }],
    { sourceModuleId: '' },
  )
  config.resolve = async () => ({ text: 'HINT', source: { kind: 'instruction-hint' } })
  const decision = await runBatch([config], plainSession('s-empty-module'))
  const message = decision.messages.find(item => item.source?.kind === 'instruction-hint')
  assert.ok(message !== undefined, 'resolved.source 分支确实注入')
  assert.equal(Object.hasOwn(message.source, 'moduleId'), Object.hasOwn(identityStampOf(config), 'moduleId'),
    '两条分支同一份盖章：空串模块维不得被写成 moduleId: ""')
})

test('executor：有 surface 却无代次戳时跳过 memo——被移走的注入重新注入', async () => {
  // 可达性：`compaction-epoch.mjs` 把「无代次（恢复、重放、其它宿主、既有桩）」列为真实情形，
  // 本文件的 `visibleSession` 桩就是其中之一（只有 `surface.nodes`，没有 `replaceGeneration`）。
  // 判据：memo 只是省一次扫描的缓存，丢了不得改变判定 —— 视图改写后必须重新注入。
  const [config] = createPromptConfigs([{ id: 'notice', layer: 'pre-step', strategy: 'static', dedupe: 'session', text: 'NOTICE', position: 'after-all' }])
  const store = visibleSession('s-no-generation')
  const memo = new Map()
  const run = () => runBatch([config], store.session, memo)
  const notices = decision => decision.messages.filter(message => message.source?.plugin === 'notice')

  const first = notices(await run())
  assert.equal(first.length, 1, '首次注入')
  store.push({ type: 'user/message', seq: 0, data: { message: first[0] } })
  assert.deepEqual(notices(await run()), [], '仍在可见上下文里 → 不重复注入（对照：去重本身仍在）')

  // 视图改写（节点被移走）但没有代次信号：memo 里那条「已投递」已不在当前上下文里。
  store.session.surface.nodes.length = 0
  assert.equal(notices(await run()).length, 1, '无代次戳时不查 memo，按当前上下文重新注入')
})
