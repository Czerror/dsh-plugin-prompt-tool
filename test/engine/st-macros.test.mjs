// ST 变量宏的保留名边界：插值内建与动态宏名不得被 setvar 一族占用。
// 判据与插值同源（engine/interpolate.mjs 的 isReservedInterpolationName），此处只断言
// 调用方观察到的行为：变量帧里没有保留名键、表达式求值为空、宏求值不受影响。
// 另含 ST 模板帧的来源判据（generationKey 只认真实对话消息）与世界书扫描范围。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { renderStText } from '../../engine/st-macros.mjs'
import { attachStRenderers } from '../../engine/st-render.mjs'
import { compileRules } from '../../engine/rule-spec.mjs'
import { stChatMessages, selectStWorldBook, lastWorldBookDiagnostics } from '../../engine/st-world-book.mjs'
import { isolatedHome } from '../fixtures/host-harness.mjs'

// 模块级开关要按完整链路验证（module.yml → ModuleSpec → compileRules 顶层选项），
// 因此先隔离 DSH_HOME 再动态 import host 侧——paths.ts 在 import 时冻结存储根。
const { moduleRoot } = isolatedHome('pt-stwb-')
const { prepareAssembly } = await import('../../src/runtime/agent-assembly.ts')
const { validateModuleDefinitionText } = await import('../../src/host/module-storage.ts')

test('st-macros：变量宏不得占用插值保留名（不落变量帧，宏求值不受影响）', () => {
  const session = { id: 'st-reserved', header: { cwd: 'C:/host-cwd' } }
  const render = (text) => renderStText(text, { session, sourceId: 'cfg-1' })

  // 主路径（对照，防止误伤）：普通键照常写入并读回，宏求值不受影响。
  assert.equal(render('{{setvar::owner::Mia}}{{getvar::owner}}'), 'Mia')
  assert.match(render('{{time}}'), /^\d{2}:\d{2}$/)
  assert.ok(/^\d+$/.test(render('{{roll::1d6}}')))

  // 关键拒绝：内建名（大小写敏感）与动态宏名（大小写不敏感）都不落变量帧，求值为空。
  const local = {}
  const global = {}
  const warnings = []
  const guarded = renderStText(
    '{{setvar::CWD::FAKE}}{{setglobalvar::CWD::FAKE-G}}{{setvar::time::FAKE-T}}{{setvar::TIME::FAKE-T}}{{setvar::DSH_HOME::FAKE}}{{setvar::owner::Mia}}',
    { session, local, global, sourceId: 'cfg-1', warn: (message) => warnings.push(message) },
  )
  assert.deepEqual({ ...local }, { owner: 'Mia' }, '保留名未落进 local 帧')
  assert.deepEqual({ ...global }, {}, '保留名未落进 global 帧')
  assert.match(warnings.join('\n'), /reserved name blocked: CWD/)
  assert.match(warnings.join('\n'), /reserved name blocked: DSH_HOME/)
  assert.match(warnings.join('\n'), /reserved name blocked: time/)
  assert.match(warnings.join('\n'), /reserved name blocked: TIME/)
  assert.equal(guarded, '', '被拒的变量宏表达式求值为空串')

  // 拒绝后引用仍取事实与宏：{{CWD}} 取宿主 cwd，{{time}} 取宏值。
  assert.equal(render('{{setvar::CWD::FAKE}}{{CWD}}'), 'C:/host-cwd')
  assert.match(render('{{setvar::time::FAKE}}{{time}}'), /^\d{2}:\d{2}$/)
  assert.equal(render('{{setvar::CWD::FAKE}}{{getvar::CWD}}'), '', 'getvar 也读不到保留名')

  // 边界：内建名大小写敏感——`dsh_home` 不是保留名，普通变量行为不变。
  assert.equal(render('{{setvar::dsh_home::lower}}{{dsh_home}}'), 'lower')
})

test('st-render：generationKey 与 condition 同源——空串来源不参与帧边界，真实来源变化仍换帧', () => {
  // {{incvar}} 只在模板真正求值时递增，因此它是「帧被复用还是被重建」的可观察接缝。
  const configs = attachStRenderers([{
    id: 'frame', layer: 'system-section', promotion: 'none', strategy: 'static',
    dedupe: 'none', enabled: true, texts: ['{{incvar::n}}'], params: { stMacros: true },
  }])
  const session = { id: 'st-frame', header: {}, snapshotEvents: () => [] }
  const agent = { session, options: { model: 'deepseek-chat' } }
  const render = (messages) => configs[0].renderSt(agent, messages)
  const source = (id, plugin) => ({ id, role: 'user', content: [{ type: 'text', text: 'x' }], source: { plugin } })
  const real = { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }

  assert.equal(render([source('p1', '')]), '1', '首帧求值一次')
  // 改前：空串 plugin 被内联判据放行并计入 hash，换 id 即换帧 → 第二次求值 → '2'。
  assert.equal(render([source('p2', '')]), '1', '空串来源的变化不得改变 generationKey（帧必须复用）')
  assert.equal(render([source('p2', ''), real]), '2', '真实来源变化必须换帧（对照：换帧语义仍在）')
  assert.equal(render([source('p2', ''), real]), '2', '同一输入复用帧')
})

/**
 * 桩：`log` 是真值源，`surface.nodes` 按宿主 `foldSurface` 语义维护——只有 replace 会移除节点。
 * 与 `prompt-config-engine.test.mjs` 的同名桩同义，这里只保留本文件用到的动作。
 * 本桩对每类事件都记节点（宿主只对消息类记），现在只有世界书用例的遮蔽场景依赖节点。
 */
function visibleSession(id) {
  const log = []
  const nodes = []
  return {
    session: { id, header: {}, snapshotEvents: () => log, surface: { nodes } },
    push(event) { log.push(event); nodes.push(log.length - 1) },
    compact(summary) {
      nodes.length = 0
      log.push({ type: 'compaction/end', seq: log.length, data: {} })
      log.push({ type: 'user/message', seq: log.length, data: { message: summary } })
      nodes.push(log.length - 1)
    },
  }
}

test('st-render：log-only 事件推进帧键——tool/call 与成功压缩都换帧，重复节点不换帧', () => {
  // {{incvar}} 只在模板真正求值时递增，是「帧被复用还是被重建」的可观察接缝。
  const configs = attachStRenderers([{
    id: 'frame-surface', layer: 'system-section', promotion: 'none', strategy: 'static',
    dedupe: 'none', enabled: true, texts: ['{{incvar::n}}'], params: { stMacros: true },
  }])
  const store = visibleSession('st-frame-surface')
  const agent = { session: store.session, options: { model: 'deepseek-chat' } }
  const message = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
  // 每步只求值一次：`{{incvar}}` 是「这一步是否重新求值了模板」的可观察接缝。
  const frameOf = () => configs[0].renderSt(agent, [])

  store.push({ type: 'user/message', seq: 0, data: { message: message('u0', '第一句') } })
  assert.equal(frameOf(), '1', '首帧求值一次')
  // `tool/call` 是 log-only 事件（宿主 `SURFACE_EVENT_TYPES` 不含它）：只进日志，但参与帧键。
  store.push({ type: 'tool/call', seq: 1, data: { id: 'call-1' } })
  const withTool = frameOf()
  assert.notEqual(withTool, '1', 'log-only 的 tool/call 推进帧')

  // 位置替换：同一 seq 在 nodes 里占两个位置。帧只读日志，节点重复不再可能扰动 generation
  // （改前靠 `seenSeq` 折叠，现在日志本身唯一）。
  store.session.surface.nodes.push(1)
  const duplicateFrame = frameOf()
  const duplicateFrameAgain = frameOf()
  assert.equal(duplicateFrameAgain, duplicateFrame, '重复节点不换帧：同一日志仍是同一代')
  assert.equal(duplicateFrame, withTool, '同一日志（含那次 tool/call）仍是同一代')

  store.push({ type: 'user/message', seq: 2, data: { message: message('u1', '第二句') } })
  const changedFrame = frameOf()
  assert.notEqual(changedFrame, duplicateFrameAgain, '历史真的变化时必须换帧（对照：换帧语义仍在）')

  // 成功压缩：`compaction/end` 是 log-only 的帧边界，推进代次（surface 只剩摘要节点）。
  // 换帧的可观察证据是这一步重新求值了模板（generation 变才丢掉 frame.text；不变则沿用缓存值）。
  store.compact(message('summary', '摘要'))
  const compactedFrame = frameOf()
  assert.notEqual(compactedFrame, changedFrame, '成功压缩推进边界后 generation 变、模板重新求值')
})

test('st-render：正常路径与降级路径对同一历史给出同一 generation（surface 在场不改变帧）', () => {
  const configs = attachStRenderers([{
    id: 'frame-parity', layer: 'system-section', promotion: 'none', strategy: 'static',
    dedupe: 'none', enabled: true, texts: ['{{incvar::n}}'], params: { stMacros: true },
  }])
  const log = [{ type: 'user/message', seq: 0, data: { message: { id: 'u0', role: 'user', content: [{ type: 'text', text: '第一句' }], source: { kind: 'user' } } } }]
  const nodes = [0]
  const session = { id: 'st-frame-parity', header: {}, snapshotEvents: () => log, surface: { nodes } }
  const agent = { session, options: { model: 'deepseek-chat' } }
  const frameOf = () => configs[0].renderSt(agent, [])

  assert.equal(frameOf(), '1', '首帧求值一次')
  // `tool/call` 是 log-only 事件，不会成为 surface 节点：改前正常路径按 currentEvents 读不到它，
  // 只有降级路径（返回完整历史）读得到 → 同一历史在两条路径上算出两代，帧被无谓重建。
  log.push({ type: 'tool/call', seq: 1, data: { id: 'call-1' } })
  const withSurface = frameOf()
  delete session.surface
  const degraded = frameOf()
  assert.deepEqual({ withSurface, degraded }, { withSurface: '2', degraded: '2' },
    '同一历史两路径同代：log-only 事件都进帧键，且 surface 在场与否不改 generation')
})

test('st-render：成功压缩的 compaction/end 推进帧边界——摘要正文与压缩前逐字相同也换帧', () => {
  const configs = attachStRenderers([{
    id: 'frame-compact', layer: 'system-section', promotion: 'none', strategy: 'static',
    dedupe: 'none', enabled: true, texts: ['{{incvar::n}}'], params: { stMacros: true },
  }])
  const log = []
  const nodes = []
  const session = { id: 'st-frame-compact', header: {}, snapshotEvents: () => log, surface: { nodes } }
  const agent = { session, options: { model: 'deepseek-chat' } }
  const message = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
  // `compaction/end` 不是 surface 承载类型，只进日志（同宿主 `foldSurface`）。
  const record = (type, data) => { log.push({ type, seq: log.length, data }); if (type !== 'compaction/end') nodes.push(log.length - 1) }
  const frameOf = () => configs[0].renderSt(agent, [])

  record('user/message', { message: message('u0', '同一句') })
  assert.equal(frameOf(), '1', '首帧求值一次')

  // 摘要正文刻意与压缩前那条逐字相同：帧键里唯一能变的就是 `compaction/end` 边界本身
  // （真值源＝边界分支给 `JSON.stringify(['compaction/end', 1])`，与消息内容哈希不同）。
  nodes.length = 0
  record('compaction/end', {})
  record('user/message', { message: message('u0', '同一句') })
  assert.equal(frameOf(), '2', 'compaction/end 推进边界：正文哈希不变也必须换帧')
  assert.equal(frameOf(), '2', '同一日志复用帧（对照：不是每步都重建）')
})

test('st-world-book：扫描范围 = 模型可见的真实对话——被压缩遮蔽的关键词不再命中', () => {
  // 条目结构取自 `buildWorldBookEntry`（worldbook.ts:37）：`text` 是字符串，匹配键在
  // `params.keys`，ST 触发语义在 `params.stWorldBook`。
  const entry = (id) => ({
    id, name: id, strategy: 'world-book', order: 100, text: 'LORE', layer: 'pre-step',
    position: 'before-all', enabled: true,
    params: { constant: false, keys: ['龙'], stWorldBook: { keys: ['龙'], scanDepth: 2 } },
  })
  const say = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
  const store = visibleSession('st-wb-surface')
  store.push({ type: 'user/message', seq: 0, data: { message: say('u0', '龙现身了') } })
  store.session.surface.nodes.length = 0

  assert.deepEqual(stChatMessages(store.session), [], '遮蔽掉的对话不在扫描 haystack 里')
  assert.equal(selectStWorldBook([entry('lore')], store.session, []).size, 0,
    '关键词只出现在被遮蔽的消息里 → 条目不入选（迁移前读完整历史 → 命中）')

  // 降级对照：无 surface 时退回完整历史，命中行为与迁移前一致。
  assert.equal(selectStWorldBook([entry('lore-degraded')], { snapshotEvents: store.session.snapshotEvents }, []).size, 1,
    '无 surface 的会话仍扫完整历史')
})

test('st-world-book：{{pick}} 的 seed 含条目身份——同键条目不共用取值且各自稳定', () => {
  // 判别力：省略 sourceId 时 16 条同键条目共享 sha256([会话,'',0])，取值必然全同 → 入选 0 或 16 条。
  // 取值是 sha256 的，故只断言「不是全同」——五选一全撞概率 5·5⁻¹⁶（同 interpolate.test.mjs 的理由）。
  const key = '{{pick::a::b::c::d::e}}'
  const entry = (id) => ({
    id, name: id, strategy: 'world-book', order: 100, text: 'LORE', layer: 'pre-step',
    position: 'before-all', enabled: true, variables: {},
    params: { constant: false, keys: [key], stWorldBook: { keys: [key], scanDepth: 2 } },
  })
  // 正文只含候选取值之一：条目入选与否直接反映自己那一处 pick 的取值。
  const session = (text = 'a') => ({
    id: 'stwb-pick', header: {},
    snapshotEvents: () => [{ type: 'user/message', seq: 0, data: { message: { id: 'u0', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } } }],
  })
  const entries = Array.from({ length: 16 }, (_, index) => entry(`wb-${index}`))
  const scan = (text) => [...selectStWorldBook(entries, session(text), [])].map(config => config.id).sort()
  const selected = scan()
  assert.ok(selected.length > 0 && selected.length < entries.length,
    '不同条目各自的 seed 决定取值（共用 seed 时必然是 0 或 16 条）')
  assert.deepEqual(scan(), selected, '同一会话与条目下取值稳定')
  // T28 回归保持：seed 不含扫描正文，正文变长（仍含 'a'、不含其余候选取值）不改变任何键的取值。
  assert.deepEqual(scan('a 龙现身了并说了很长的一段话'), selected, '扫描正文变长不改变键的取值')
})

test('st-world-book：递归只由 module.yml 顶层 stWorldBookRecursive 决定，条目级 recursive 有/无同结果', async () => {
  const dir = join(moduleRoot, 'stwb')
  mkdirSync(dir, { recursive: true })
  // 真值源：开关只在 module.yml 顶层（规格见 docs/SillyTavern.md）；`stWorldBook.recursive`
  // 是旧导入遗留，`recursive_scanning` 在 ST 运行期本就不被读取。
  // 夹具走与 `variablesEnabled` 同一条链路：module.yml 顶层 → ModuleSpec → prepareAssembly 的
  // compileRules 顶层选项 → 校验后打标到 compiledConfig（装配期真实入口，不是手搓 config）。
  const compile = async (recursive, entries) => {
    writeFileSync(join(dir, 'module.yml'), stringify({ id: 'stwb', modules: ['rule-engine'], rules: entries, ...(recursive ? { stWorldBookRecursive: true } : {}) }))
    return (await prepareAssembly(moduleRoot, 'stwb', () => true)).rules.map(rule => rule.actions[0].compiledConfig)
  }
  // 条目结构同 `buildWorldBookEntry`：正文在 text，匹配键在 params.keys，ST 语义在 params.stWorldBook。
  const entry = (id, text, extra = {}) => ({
    id, then: [{ id: 'inject', kind: 'inject-text', config: {
      id, layer: 'pre-step', strategy: 'world-book', text,
      params: { keys: [`key-${id}`], stWorldBook: { keys: [`key-${id}`], scanDepth: 2, ...extra } },
    } }],
  })
  const session = {
    id: 'stwb', header: {},
    snapshotEvents: () => [{ type: 'user/message', seq: 0, data: { message: { id: 'u0', role: 'user', content: [{ type: 'text', text: 'key-a 现身' }], source: { kind: 'user' } } } }],
  }
  const scan = async (recursive, entries) => [...selectStWorldBook(await compile(recursive, entries), session, [])].map(config => config.id).sort()
  // a 的正文含 b 的键：只有递归 pass 才可能让 b 入选（b 的键在对话里不出现）。
  const plain = [entry('a', 'A 正文 key-b'), entry('b', 'B 正文')]
  const declared = [entry('a', 'A 正文 key-b', { recursive: true }), entry('b', 'B 正文', { recursive: true })]

  assert.deepEqual(await scan(true, plain), ['a', 'b'], '全局开关打开：正文里的键触发第二条')
  assert.deepEqual(await scan(true, declared), ['a', 'b'], '条目级 recursive 有/无不改变扫描结果')
  assert.deepEqual(await scan(false, plain), ['a'], '全局开关缺省（未声明）= 不递归，对齐 ST world_info_recursive 默认 false')
  assert.deepEqual(await scan(false, declared), ['a'], '存量模块里孤立的条目级 recursive 不再打开递归')
  assert.deepEqual(await scan(true, [entry('a', 'A 正文 key-b'), entry('b', 'B 正文', { excludeRecursion: true })]), ['a'],
    'excludeRecursion 仍是条目级判据（ST world-info.js:4870）')
  // 顶层字段是模块定义的一部分：类型错误在装载／保存边界 fail loud，不在扫描期静默当 false。
  assert.throws(() => validateModuleDefinitionText(join(tmpdir(), 'stwb'), 'id: stwb\nstWorldBookRecursive: "yes"\nrules: []\n'),
    /stWorldBookRecursive 必须是布尔值/)
  assert.throws(() => compileRules([{ id: 'x', then: [{ id: 'i', kind: 'inject-text', config: { id: 'c', layer: 'pre-step', text: 'x', stWorldBookRecursive: true } }] }]),
    /unknown config key/, '开关是模块级字段，写进动作配置按未知键拒绝')
})

// 多模块批次的装配夹具：模块级开关（module.yml 顶层）与 sourceModuleId 都由真实链路打标
// （module.yml → prepareAssembly → compileRules），批次形状与协调器汇总的 pre-step 一致。
async function compileStWorldBook(moduleId, recursive, rules) {
  const dir = join(moduleRoot, moduleId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'module.yml'), stringify({ id: moduleId, modules: ['rule-engine'], rules, ...(recursive ? { stWorldBookRecursive: true } : {}) }))
  return (await prepareAssembly(moduleRoot, moduleId, () => true)).rules.map(rule => rule.actions[0].compiledConfig)
}
const wbRule = (id, key, text, extra = {}) => ({
  id,
  then: [{ id: 'inject', kind: 'inject-text', config: {
    id, layer: 'pre-step', strategy: 'world-book', text,
    params: { keys: [key], stWorldBook: { keys: [key], scanDepth: 2, ...extra } },
  } }],
})
const wbSession = (id, text) => ({
  id, header: {},
  snapshotEvents: () => [{ type: 'user/message', seq: 0, data: { message: { id: 'u0', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } } }],
})
const selectedIds = (configs, session) => [...selectStWorldBook(configs, session, [])].map(config => config.id).sort()

test('st-world-book：递归开关按模块生效——未声明开关的模块不参与递归 pass', async () => {
  // 真值源＝手算的入选集合；批次 = 协调器汇总的多模块 pre-step 配置（executor.mjs#batchScope 的 qualified）。
  // B 的键只出现在 A 的正文里：改前（开关按批次取并集）会连带 B 一起重扫并入选
  // ['iso-a1','iso-a2','iso-b2']（同夹具在改前实现上实跑过）。
  const isolation = wbSession('stwb-iso', 'iso-a')
  const selected = selectedIds([
    ...await compileStWorldBook('stwb-a', true, [wbRule('iso-a1', 'iso-a', 'A 正文 iso-a2 iso-b2'), wbRule('iso-a2', 'iso-a2', 'A2 正文')]),
    ...await compileStWorldBook('stwb-b', false, [wbRule('iso-b2', 'iso-b2', 'B2 正文')]),
  ], isolation)

  // 硬条件①：B 未声明开关 → 不被 A 的递归正文触发；A 自己的递归 pass 仍照旧生效。
  assert.deepEqual(selected, ['iso-a1', 'iso-a2'], 'B 的条目不参与递归 pass')
  assert.ok(lastWorldBookDiagnostics(isolation).records.some(record => record.id === 'iso-b2' && record.stage === 'excluded' && record.reason === 'recursion'),
    'B 的条目被模块开关挡下（诊断不再是「被别的模块正文命中」）')
})

test('st-world-book：两模块都开时与改前逐字一致（含跨模块正文驱动）', async () => {
  // 硬条件②：期望值＝改前实现在同一夹具上的输出（判别力证明里换回改前引擎跑一遍，本用例必须照样绿）。
  // 夹具刻意含跨模块驱动：d1 的键只出现在 c1 的正文里 —— 池是全批共享的（对齐 ST 全局扫描缓冲）。
  const equivalence = selectedIds([
    ...await compileStWorldBook('stwb-c', true, [wbRule('eq-c1', 'eq-c', 'C 正文 eq-c2 eq-d1'), wbRule('eq-c2', 'eq-c2', 'C2 正文')]),
    ...await compileStWorldBook('stwb-d', true, [wbRule('eq-d1', 'eq-d1', 'D1 正文 eq-d2'), wbRule('eq-d2', 'eq-d2', 'D2 正文')]),
  ], wbSession('stwb-eq', 'eq-c eq-d'))
  assert.deepEqual(equivalence, ['eq-c1', 'eq-c2', 'eq-d1', 'eq-d2'], '都开时每个模块的递归 pass 与入选集合不变')
})

test('st-world-book：未声明递归开关的模块里，延迟层级池的既有语义不变', async () => {
  // 层级池是全批时钟（层级只增不减、与递归正文无关），因此不受模块开关门控：改前同结果。
  const session = wbSession('stwb-delay', 'dl-e1 dl-e2')
  const configs = await compileStWorldBook('stwb-e', false, [
    wbRule('dl-e1', 'dl-e1', 'E1 正文', { delayUntilRecursion: 1 }),
    wbRule('dl-e2', 'dl-e2', 'E2 正文', { delayUntilRecursion: 2 }),
  ])
  assert.deepEqual(selectedIds(configs, session), ['dl-e1', 'dl-e2'], '开关缺省不改变延迟条目的解锁')

  // 缺省时批次不产生递归来源：没有新正文可递归 → 层级池不推进 → 只延迟到第 1 层的条目不被解锁（改前同结果）。
  const noSource = wbSession('stwb-delay-nosource', 'dl-f0 dl-f1')
  const offModule = await compileStWorldBook('stwb-f', false, [
    wbRule('dl-f0', 'dl-f0', 'F0 正文'),
    wbRule('dl-f1', 'dl-f1', 'F1 正文', { delayUntilRecursion: 1 }),
  ])
  assert.deepEqual(selectedIds(offModule, noSource), ['dl-f0'], '无递归来源时层级池不推进')
})
