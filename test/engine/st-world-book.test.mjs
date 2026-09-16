import { test } from 'node:test'
import assert from 'node:assert/strict'
import { convertStToPreset } from '../../src/host/sillytavern.ts'
import { createPromptConfigs } from '../../engine/schema.mjs'
import { runPreStepBatch } from '../../engine/executor.mjs'
import { lastWorldBookDiagnostics, selectStWorldBook } from '../../engine/st-world-book.mjs'

const entry = (id, extra = {}) => ({ id, keys: [], secondary_keys: [], content: `E${id}`, enabled: true, constant: false, selective: true, insertion_order: 100, position: 'before_char', extensions: {}, ...extra })
const message = (text, id = text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const promotion = { main: { status: () => ({ promoted: true }) }, withSubagents: { status: () => ({ promoted: true }) } }
async function runBook(book, texts, history = [], extras = {}) {
  const spec = convertStToPreset(book, 'probe')
  const configs = createPromptConfigs(spec.promptConfigs.map(c => ({ ...c, variables: spec.variables })))
  const agent = { session: { id: 'probe', header: {}, snapshotEvents: () => history }, options: {} }
  const decision = await runPreStepBatch({ ctx: { get() {} }, agent, decision: { kind: 'enter', messages: texts.map(t => message(t)) }, configs, promotion, memo: new Map(), warnOnce() {}, ...extras })
  return decision.messages.filter(m => m.source?.plugin?.startsWith('lore-')).map(m => ({ id: m.source.plugin, role: m.role, text: m.content.map(c => c.text).join('') }))
}
async function run(entries, texts, history = [], extras = {}) {
  return runBook({ data: { name: 'Probe', character_book: { entries } } }, texts, history, extras)
}

test('ST 世界书必须先命中主键；0/1/2/3 逻辑与 selective 开关正确', async () => {
  for (const [logic, text, expected] of [[0, 'P', false], [0, 'S', false], [0, 'P S', true], [1, 'P S', true], [2, 'P S', false], [3, 'P S', false], [3, 'P S T', true]]) {
    const result = await run([entry(1, { keys: ['P'], secondary_keys: ['S', 'T'], extensions: { selectiveLogic: logic } })], [text])
    assert.equal(result.length > 0, expected, `logic=${logic}, text=${text}`)
  }
  assert.equal((await run([entry(1)], ['N'])).length, 0, '无主键非常驻条目不注入')
  assert.equal((await run([entry(1, { keys: ['P'], secondary_keys: ['S'], selective: false, extensions: { selectiveLogic: 3 } })], ['P'])).length, 1)
})

test('ST 世界书扫描最近历史且尊重深度0，不扫描插件注入消息', async () => {
  const history = [{ type: 'user/message', data: { message: message('P', 'previous') } }]
  assert.equal((await run([entry(1, { keys: ['P'], extensions: { scan_depth: 2 } })], ['N'], history)).length, 1)
  assert.equal((await run([entry(1, { keys: ['P'], extensions: { scan_depth: 0 } })], ['P'])).length, 0)
  history[0].data.message.source = { plugin: 'lore-other', kind: 'world-book' }
  assert.equal((await run([entry(1, { keys: ['P'] })], ['N'], history)).length, 0)
})

test('ST 世界书整词和消息扫描顺序采用ST边界，普通模式不受影响', async () => {
  assert.equal((await run([entry(1, { keys: ['a b'], extensions: { match_whole_words: true } })], ['za bc'])).length, 1, 'ST 多词短语按子串')
  assert.equal((await run([entry(1, { keys: ['a'], extensions: { match_whole_words: true } })], ['za'])).length, 0)
  const history = [{ type: 'user/message', data: { message: message('OLD', 'previous') } }]
  assert.equal((await run([entry(1, { keys: ['/NEW.*OLD/s'], extensions: { scan_depth: 2 } })], ['NEW'], history)).length, 1, 'ST 从新到旧扫描')
})

test('ST 世界书概率0不注入，group_override只选优先级最高者，最终正文低order在前', async () => {
  assert.equal((await run([entry(1, { constant: true, extensions: { useProbability: true, probability: 0 } })], ['N'])).length, 0)
  const grouped = [entry(1, { constant: true, insertion_order: 100, extensions: { group: 'G', group_override: true } }), entry(2, { constant: true, insertion_order: 200, extensions: { group: 'G', group_override: true } })]
  assert.deepEqual((await run(grouped, ['N'])).map(x => x.id), ['lore-2'])
  grouped.forEach(e => { e.extensions = {} })
  assert.deepEqual((await run(grouped, ['N'])).map(x => x.id), ['lore-1', 'lore-2'])
})

test('独立ST世界书顶层entries可导入；不支持的插入点保存来源并告警', () => {
  const spec = convertStToPreset({ entries: { 0: { uid: 0, key: [], content: 'E0', constant: true, disable: false, order: 10, position: 4, depth: 0, role: 2 } } }, 'book')
  assert.equal(spec.promptConfigs.length, 1)
  const config = spec.promptConfigs[0]
  assert.equal(config.params.stWorldBook.position, 4)
  assert.equal(config.params.stWorldBook.depth, 0)
  // role=2（assistant）在导入期降级为 user，原角色保留在 stWorldBook.role。
  assert.equal(config.role, 'user')
  assert.equal(config.params.stWorldBook.role, 2)
  assert.ok(spec.meta.stWarnings.some(w => w.includes('深度')))
})

test('ST 世界书连续轮次：sticky到期、cooldown抑制、delay等待，不被重复求值延长', async () => {
  const spec = convertStToPreset({ data: { character_book: { entries: [
    entry(1, { keys: ['P'], extensions: { scan_depth: 1, sticky: 2 } }),
    entry(2, { keys: ['P'], extensions: { scan_depth: 1, cooldown: 2 } }),
    entry(3, { constant: true, extensions: { delay: 3 } }),
  ] } } }, 'timers')
  const configs = createPromptConfigs(spec.promptConfigs)
  const history = []
  const agent = { session: { id: 'timers', header: {}, snapshotEvents: () => history }, options: {} }
  const step = async (text) => {
    const msg = message(text, `u${history.length}`)
    const options = { ctx: { get() {} }, agent, decision: { kind: 'enter', messages: [msg] }, configs, promotion, memo: new Map(), warnOnce() {} }
    const ids = decision => decision.messages.filter(m => m.source?.plugin?.startsWith('lore-')).map(m => m.source.plugin)
    const first = ids(await runPreStepBatch(options))
    assert.deepEqual(ids(await runPreStepBatch(options)), first, '同一轮重复装配幂等')
    history.push({ type: 'user/message', data: { message: msg } })
    return first
  }
  assert.deepEqual(await step('P'), ['lore-1', 'lore-2'])
  assert.deepEqual(await step('N'), ['lore-1'])
  assert.deepEqual(await step('N'), ['lore-3'])
  assert.deepEqual(await step('P'), ['lore-1', 'lore-2', 'lore-3'])
  assert.deepEqual(await step('N'), ['lore-1', 'lore-3'])
  assert.deepEqual(await step('N'), ['lore-3'])
  assert.deepEqual(await step('N'), ['lore-3'])
})

test('ST 世界书递归仅显式开启，匹配角色字段；协调器复制配置后仍能选择', async () => {
  const spec = convertStToPreset({ data: { description: 'ONLY-IN-DESCRIPTION', character_book: { entries: [
    entry(1, { constant: true, content: 'NEXT' }),
    entry(2, { keys: ['NEXT'], extensions: { recursive_scanning: true } }),
    entry(3, { keys: ['ONLY-IN-DESCRIPTION'], extensions: { match_character_description: true } }),
  ] } } }, 'recursive')
  const configs = createPromptConfigs(spec.promptConfigs.map(c => ({ ...c, variables: spec.variables })))
  const copied = configs.map(c => ({ ...c, resolve: input => c.resolve(input) }))
  const result = await runPreStepBatch({ ctx: { get() {} }, agent: { session: { id: 'copy', header: {}, snapshotEvents: () => [] }, options: {} },
    decision: { kind: 'enter', messages: [message('N')] }, configs: copied, promotion, memo: new Map(), warnOnce() {} })
  assert.deepEqual(result.messages.filter(m => m.source?.plugin?.startsWith('lore-')).map(m => m.source.plugin), ['lore-1', 'lore-2', 'lore-3'])
})

test('ST 世界书 extensions 蛇形 selective_logic 与驼峰同义，四种逻辑与部分/全部副键命中一致', async () => {
  const cases = [[0, 'P S', true], [0, 'P S T', true], [0, 'P', false], [0, 'S', false],
    [1, 'P S', true], [1, 'P S T', false], [2, 'P S', false], [2, 'P Q', true],
    [3, 'P S', false], [3, 'P S T', true]]
  for (const [logic, text, expected] of cases) {
    const snake = await run([entry(1, { keys: ['P'], secondary_keys: ['S', 'T'], extensions: { selective_logic: logic } })], [text])
    const camel = await run([entry(1, { keys: ['P'], secondary_keys: ['S', 'T'], extensions: { selectiveLogic: logic } })], [text])
    assert.equal(snake.length > 0, expected, `蛇形 logic=${logic}, text=${text}`)
    assert.deepEqual(snake, camel, `两种拼写等价 logic=${logic}, text=${text}`)
  }
  // 编辑器/独立世界书形状：顶层 key/keysecondary + 顶层 selective_logic
  const standalone = await runBook({ entries: { 0: { uid: 0, key: ['P'], keysecondary: ['S', 'T'], content: 'E0', selective: true, selective_logic: 3 } } }, ['P S'])
  assert.equal(standalone.length, 0, '顶层蛇形 selective_logic=3 需要全部副键命中')
  const standaloneAll = await runBook({ entries: { 0: { uid: 0, key: ['P'], keysecondary: ['S', 'T'], content: 'E0', selective: true, selective_logic: 3 } } }, ['P S T'])
  assert.equal(standaloneAll.length, 1)
})

test('ST 世界书 use_probability 关闭时不执行概率过滤，false/0 与缺省不混淆', async () => {
  const inject = extra => run([entry(1, { constant: true, ...extra })], ['N'])
  assert.equal((await inject({ extensions: { use_probability: false, probability: 0 } })).length, 1, '关闭开关且概率 0 仍注入')
  assert.equal((await inject({ extensions: { useProbability: false, probability: 0 } })).length, 1, '驼峰关闭开关保持既有行为')
  assert.equal((await inject({ extensions: { use_probability: true, probability: 0 } })).length, 0, '开启开关且概率 0 不注入')
  assert.equal((await inject({ extensions: { probability: 0 } })).length, 0, '缺省开关保持既有默认过滤')
  assert.equal((await inject({ extensions: { use_probability: false, probability: 0 }, enabled: false })).length, 0, '禁用条目不因关闭概率过滤而启用')
  assert.equal((await inject({ extensions: { use_probability: false } })).length, 1, '缺省概率为 100')
})

/** 诊断夹具：同一批条目的「真实注入结果」与「诊断记录」必须来自同一路径。 */
function diagConfigs(entries) {
  const spec = convertStToPreset({ data: { name: 'Probe', character_book: { entries } } }, 'probe')
  return createPromptConfigs(spec.promptConfigs.map(c => ({ ...c, variables: spec.variables })))
}

test('世界书诊断区分候选/入选/已提交与真实拒绝原因，且不改变注入结果', async () => {
  const entries = [
    entry(1, { keys: ['P'], extensions: { scan_depth: 1 } }),
    entry(2, { constant: true, enabled: false }),
    entry(3, { constant: true, extensions: { probability: 0 } }),
    entry(4, { keys: ['P'], secondary_keys: ['S'], extensions: { scan_depth: 1, selectiveLogic: 3 } }),
  ]
  assert.deepEqual((await run(entries, ['P'])).map(x => x.id), ['lore-1'], '真实注入结果：只有 lore-1')
  const session = { id: 'diag', header: {}, snapshotEvents: () => [] }
  const selection = selectStWorldBook(diagConfigs(entries), session, [message('P')], () => {})
  const stages = id => selection.diagnostics.records.filter(record => record.id === id).map(record => `${record.stage}:${record.reason}`)
  assert.deepEqual(selection.diagnostics.records.map(record => record.id).length > 0, true)
  assert.deepEqual(stages('lore-1'), ['candidate:key-match', 'selected:ungrouped'])
  assert.deepEqual(stages('lore-2'), ['excluded:disabled'])
  assert.deepEqual(stages('lore-3'), ['rejected:probability'], '概率过滤发生在进入候选之前')
  assert.deepEqual(stages('lore-4'), ['rejected:secondary-miss'])
  assert.equal(selection.diagnostics.truncated, false)
  for (const config of selection) selection.commit(config)
  assert.deepEqual(stages('lore-1'), ['candidate:key-match', 'selected:ungrouped', 'committed:injected'])
  assert.deepEqual(stages('lore-3'), ['rejected:probability'], '未入选条目不会记录已提交')
  // 会话快照：与本次选择记录同源，供只读端点读取；读取本身不触发任何求值。
  const snapshot = lastWorldBookDiagnostics(session)
  assert.deepEqual(snapshot.records, selection.diagnostics.records)
  assert.equal(snapshot.step, 1)
  assert.equal(lastWorldBookDiagnostics({ id: 'cold', header: {}, snapshotEvents: () => [] }).records.length, 0)
})

test('T07 观测边界 199/200/201：截断标志在写入记录的同一次求值里置真', () => {
  const makeSession = (id) => ({ id, header: {}, snapshotEvents: () => [] })
  for (const [size, expected, truncated] of [[199, 199, false], [200, 200, false], [201, 200, true]]) {
    const session = makeSession(`snap-${size}`)
    const entries = Array.from({ length: size }, (_, index) => entry(index + 1, { constant: true, disable: true }))
    const selection = selectStWorldBook(diagConfigs(entries), session, [message('N')], () => {})
    assert.equal(selection.size, 0, `${size} 条禁用条目都不入选`)
    assert.equal(selection.diagnostics.records.length, expected, `${size} 条观测的记录上限`)
    assert.equal(selection.diagnostics.truncated, truncated, `${size} 条的截断标志`)
    const snapshot = lastWorldBookDiagnostics(session)
    assert.equal(snapshot, selection.diagnostics, '会话最近快照与本次选择是同一份事实')
    assert.equal(snapshot.truncated, truncated)
    assert.equal(snapshot.evaluated, true)
  }
})

test('T07 67 条常驻配置在 commit 阶段越限时两个快照都报 truncated', () => {
  const session = { id: 'snap-commit', header: {}, snapshotEvents: () => [] }
  const configs = diagConfigs(Array.from({ length: 67 }, (_, index) => entry(index + 1, { constant: true })))
  const selection = selectStWorldBook(configs, session, [message('N')], () => {})
  assert.equal(selection.size, 67, '全部常驻条目入选')
  const snapshot = lastWorldBookDiagnostics(session)
  assert.equal(snapshot.truncated, false, '选择阶段尚未越限')
  assert.equal(snapshot.records.length, 134, '67 条候选 + 67 条入选')

  // 执行器在真正插入后才 commit：最后一条追加时越限，必须写回同一份快照。
  for (const config of selection) selection.commit(config)
  const committed = snapshot.records.filter((record) => record.stage === 'committed')
  assert.equal(committed.length, 66, '第 67 条 commit 越限')
  assert.equal(snapshot.truncated, true, 'commit 阶段越限必须更新同一快照的截断标志')
  assert.equal(selection.diagnostics.truncated, true, '选择结果与读取端看到同一事实')
  assert.equal(lastWorldBookDiagnostics(session).truncated, true)
})

test('T07 空集合替换历史快照，并与"尚未求值"可区分', () => {
  const session = { id: 'snap-empty', header: {}, snapshotEvents: () => [] }
  assert.deepEqual(lastWorldBookDiagnostics(session), { records: [], truncated: false, step: 0, evaluated: false }, '未求值时不伪报已检查')

  const first = selectStWorldBook(diagConfigs([entry(1, { constant: true })]), session, [message('N')], () => {})
  assert.equal(first.size, 1)
  assert.ok(lastWorldBookDiagnostics(session).records.length > 0)
  assert.equal(lastWorldBookDiagnostics(session).step, 1, '快照带本次 step 标识')

  // 本次没有任何世界书配置：空结果替换历史快照，不能被读成「本次又注入了旧条目」。
  const empty = selectStWorldBook([], session, [message('N')], () => {})
  assert.equal(empty.size, 0)
  const snapshot = lastWorldBookDiagnostics(session)
  assert.equal(snapshot.evaluated, true)
  assert.deepEqual(snapshot.records, [], '空选择替换历史快照')
  assert.equal(snapshot.step, 0)
  assert.equal(snapshot.truncated, false)
})

test('T07 会话之间互不串记录，重复读取返回同一份只读快照', () => {
  const a = { id: 'snap-a', header: {}, snapshotEvents: () => [] }
  const b = { id: 'snap-b', header: {}, snapshotEvents: () => [] }
  selectStWorldBook(diagConfigs([entry(1, { constant: true })]), a, [message('N')], () => {})
  selectStWorldBook(diagConfigs([entry(2, { constant: true })]), b, [message('N')], () => {})
  const snapshotA = lastWorldBookDiagnostics(a)
  const snapshotB = lastWorldBookDiagnostics(b)
  assert.notEqual(snapshotA, snapshotB, '不同会话不共享快照')
  assert.deepEqual(snapshotA.records.filter((record) => record.stage === 'selected').map((record) => record.id), ['lore-1'])
  assert.deepEqual(snapshotB.records.filter((record) => record.stage === 'selected').map((record) => record.id), ['lore-2'])
  const before = JSON.stringify(snapshotA.records)
  assert.equal(lastWorldBookDiagnostics(a), snapshotA, '重复读取是同一对象')
  assert.equal(lastWorldBookDiagnostics(a), lastWorldBookDiagnostics(a))
  assert.equal(JSON.stringify(lastWorldBookDiagnostics(a).records), before, '只读读取不改变记录')
})

test('世界书诊断记录扫描窗口、分组胜负与主要拒绝原因', async () => {
  const entries = [
    entry(1, { keys: ['Z'], extensions: { scan_depth: 3 } }),
    entry(2, { constant: true, extensions: { delay: 5 } }),
    entry(3, { constant: true, insertion_order: 200, extensions: { group: 'G', group_override: true } }),
    entry(4, { constant: true, insertion_order: 100, extensions: { group: 'G', group_override: true } }),
  ]
  const session = { id: 'diag-reasons', header: {}, snapshotEvents: () => [] }
  const selection = selectStWorldBook(diagConfigs(entries), session, [message('Q')], () => {})
  const record = (id, stage) => selection.diagnostics.records.find(item => item.id === id && item.stage === stage)
  assert.deepEqual(record('lore-1', 'rejected').reason, 'primary-miss')
  assert.equal(record('lore-1', 'rejected').scanDepth, 3, '记录真实扫描窗口')
  assert.equal(record('lore-2', 'excluded').reason, 'delay')
  assert.equal(record('lore-2', 'excluded').delay, 5)
  assert.deepEqual([...selection].map(config => config.id), ['lore-3'], '分组只选出高 order 者')
  assert.equal(record('lore-3', 'selected').reason, 'group-winner')
  assert.equal(record('lore-4', 'rejected').reason, 'group-lost')
})

test('世界书诊断有界截断，超量条目不影响入选集合', async () => {
  const entries = Array.from({ length: 320 }, (_, index) => entry(index + 1, { constant: true, extensions: { probability: 0 } }))
  const result = await run(entries, ['N'])
  assert.deepEqual(result, [], '概率 0 全被过滤')
  const session = { id: 'diag-limit', header: {}, snapshotEvents: () => [] }
  const selection = selectStWorldBook(diagConfigs(entries), session, [message('N')], () => {})
  assert.equal(selection.size, 0)
  assert.equal(selection.diagnostics.records.length, 200, '记录有上限')
  assert.equal(selection.diagnostics.truncated, true)
})

test('读取诊断不改变入选集合、顺序、抽样次数与粘滞时间窗', async () => {
  const entries = [
    entry(1, { keys: ['P'], extensions: { scan_depth: 1, sticky: 1 } }),
    entry(2, { constant: true, extensions: { probability: 50 } }),
  ]
  const simulate = read => {
    const configs = diagConfigs(entries)
    const history = []
    const session = { id: `diag-diff-${read}`, header: {}, snapshotEvents: () => history }
    const steps = []
    for (const [index, text] of ['P', 'N', 'P', 'N'].entries()) {
      const msg = message(text, `${read ? 'read' : 'plain'}-${index}`)
      const selection = selectStWorldBook(configs, session, [msg], () => {})
      if (read) assert.ok(selection.diagnostics.records.length > 0)
      steps.push([...selection].map(config => config.id).sort().join(','))
      for (const config of selection) selection.commit(config)
      history.push({ type: 'user/message', data: { message: msg } })
    }
    return steps
  }
  const original = Math.random
  let calls = 0
  const count = () => { calls += 1; return 0.4 }
  Math.random = count
  let withRead, withoutRead, readCalls, plainCalls
  try {
    calls = 0
    withRead = simulate(true)
    readCalls = calls
    calls = 0
    withoutRead = simulate(false)
    plainCalls = calls
  } finally {
    Math.random = original
  }
  assert.deepEqual(withRead, withoutRead, '读取诊断不改变入选集合与顺序')
  assert.equal(readCalls, plainCalls, '读取诊断不改变概率抽样次数')
  assert.deepEqual(withRead, ['lore-1,lore-2', 'lore-2', 'lore-1,lore-2', 'lore-2'], '粘滞/概率窗口语义保持')
})

test('T20 depth_prompt 禁用配置保留在产物里但不进入注入结果', async () => {
  const spec = convertStToPreset({ data: { name: 'Ada', extensions: { depth_prompt: { prompt: 'DEEP-ONLY', depth: 4, role: 0 } },
    character_book: { entries: [entry(1, { keys: ['P'] })] } } }, 'deepprompt')
  const configs = createPromptConfigs(spec.promptConfigs.map(c => ({ ...c, variables: spec.variables })))
  assert.equal(configs.some(config => config.id === 'st-depth-prompt'), true, '禁用配置仍在产物里可复核')
  const decision = await runPreStepBatch({ ctx: { get() {} }, agent: { session: { id: 'deep', header: {}, snapshotEvents: () => [] }, options: {} },
    decision: { kind: 'enter', messages: [message('P')] }, configs, promotion, memo: new Map(), warnOnce() {} })
  const ids = decision.messages.map(message => message.source?.plugin)
  assert.equal(ids.includes('st-depth-prompt'), false, '禁用配置不注入')
  assert.equal(ids.includes('lore-1'), true)
})

test('T21 matchCreatorNotes / matchCharacterDepthPrompt 扫描开关按需并入卡片全文', async () => {
  const book = (entries) => ({ data: { name: 'Ada', creator_notes: 'NOTES-ONLY',
    extensions: { depth_prompt: { prompt: 'DEEP-ONLY', depth: 4, role: 0 } }, character_book: { entries } } })
  const on = await runBook(book([
    entry(1, { keys: ['NOTES-ONLY'], extensions: { match_creator_notes: true } }),
    entry(2, { keys: ['DEEP-ONLY'], extensions: { match_character_depth_prompt: true } }),
  ]), ['N'])
  assert.deepEqual(on.map(x => x.id), ['lore-1', 'lore-2'], '开关开启时按 creator notes / depth prompt 命中')

  const off = await runBook(book([
    entry(1, { keys: ['NOTES-ONLY'] }),
    entry(2, { keys: ['DEEP-ONLY'] }),
  ]), ['N'])
  assert.deepEqual(off, [], '未开启开关时扫描文本保持既有范围（不改变触发面）')

  // 关闭状态下普通键与既有角色字段扫描不回归。
  const baseline = await runBook(book([
    entry(3, { keys: ['P'], extensions: { match_character_description: true } }),
  ]), ['P'])
  assert.deepEqual(baseline.map(x => x.id), ['lore-3'])
})

test('T12 世界书键宏：未赋值不误触发，赋值后命中，同一轮重复求值幂等', async () => {
  const spec = convertStToPreset({ data: { name: 'Probe', character_book: { entries: [
    entry(25, { keys: ['{{user}}'], extensions: { scan_depth: 2 } }),
  ] } } }, 'keymacro')
  assert.equal(spec.variables.user, '', '转换期已登记空占位')
  const agent = { session: { id: 'keymacro', header: {}, snapshotEvents: () => [] }, options: {} }
  const ids = async (configs, text) => {
    const decision = await runPreStepBatch({ ctx: { get() {} }, agent, decision: { kind: 'enter', messages: [message(text)] }, configs, promotion, memo: new Map(), warnOnce() {} })
    return decision.messages.filter(m => m.source?.plugin?.startsWith('lore-')).map(m => m.source.plugin)
  }
  const build = (variables) => createPromptConfigs(spec.promptConfigs.map(c => ({ ...c, variables })))
  const unset = build(spec.variables)
  assert.deepEqual(await ids(unset, 'Alice'), [], '未赋值：键渲染为空，条目不被误触发')
  assert.deepEqual(await ids(unset, '{{user}}'), [], '未赋值：字面量也不参与匹配')

  const assigned = build({ ...spec.variables, user: 'Alice' })
  assert.deepEqual(await ids(assigned, 'Alice'), ['lore-25'], '赋值后含该值的消息命中并注入')
  assert.deepEqual(await ids(assigned, 'Bob'), [], '赋值后其他文本仍不命中')
  assert.deepEqual(await ids(assigned, 'Alice'), ['lore-25'], '同一轮重复求值幂等')
})

/** T16 对拍夹具：直接翻译 world-info.js:428-473（getScore）与 5292-5328（组内评分淘汰）。 */
const stGetScore = (keys, secondaryKeys, logic, text) => {
  const primary = keys.filter(key => text.includes(key)).length
  const secondary = secondaryKeys.filter(key => text.includes(key)).length
  if (keys.length === 0) return 0
  if (secondaryKeys.length > 0) {
    if (logic === 0) return primary + secondary
    if (logic === 3) return secondary === secondaryKeys.length ? primary + secondary : primary
  }
  return primary
}
const stScoringKeeps = (members, scores) => {
  if (!members.some(member => member.useGroupScoring)) return members.map(() => true)
  const maxScore = Math.max(...scores)
  return members.map((member, index) => !member.useGroupScoring || scores[index] >= maxScore)
}

test('T16 delayUntilRecursion：非递归 pass 抑制、层级池推进与递归驱动', async () => {
  // 单层级且没有任何递归驱动时，pass 0 抑制后没有下一个 pass，条目保持未激活——对齐 ST：
  // 层级池初始化即取走最小层级（world-info.js:4759），只有池里仍有剩余（:5129）或有递归
  // 新正文（:5097）才会开下一个 pass。
  assert.deepEqual(await run([entry(1, { constant: true, extensions: { delay_until_recursion: true } })], ['N']), [],
    '没有递归驱动时延迟条目保持未激活')

  // 有递归驱动（常驻递归条目提供新正文）时，下一次递归 pass 即解锁最小层级。
  const driven = await run([
    entry(1, { constant: true, insertion_order: 200, content: 'NEXT', extensions: { recursive_scanning: true } }),
    entry(2, { keys: ['NEXT'], insertion_order: 100, extensions: { delay_until_recursion: true } }),
  ], ['N'])
  assert.deepEqual(driven.map(x => x.id), ['lore-2', 'lore-1'], '递归驱动使延迟条目在下一 pass 解锁')

  // 多个层级：池中剩余层级逐个打开（1 → 3），两条都在层级满足后激活。
  const layered = await run([
    entry(1, { constant: true, insertion_order: 100, extensions: { delay_until_recursion: 1 } }),
    entry(2, { constant: true, insertion_order: 200, extensions: { delay_until_recursion: 3 } }),
  ], ['N'])
  assert.deepEqual(layered.map(x => x.id), ['lore-1', 'lore-2'], '两个层级都打开后按 order 注入')

  // 假值与缺省不受影响（既有行为不回归）。
  for (const value of [false, 0, undefined]) {
    const config = entry(3, { constant: true, extensions: value === undefined ? {} : { delay_until_recursion: value } })
    assert.deepEqual((await run([config], ['N'])).map(x => x.id), ['lore-3'], `delayUntilRecursion=${String(value)} 不抑制`)
  }
})

test('T16 delayUntilRecursion：sticky 命中绕过门控，诊断记录稳定原因码', () => {
  const history = []
  const session = { id: 'delay-sticky', header: {}, snapshotEvents: () => history }
  const configs = diagConfigs([entry(1, { keys: ['P'], extensions: { scan_depth: 1, sticky: 3 } })])
  const first = selectStWorldBook(configs, session, [message('P', 'm1')], () => {})
  assert.deepEqual([...first].map(config => config.id), ['lore-1'])
  for (const config of first) first.commit(config)
  history.push({ type: 'user/message', data: { message: message('P', 'm1') } })

  configs[0].params.stWorldBook.delayUntilRecursion = true
  const second = selectStWorldBook(configs, session, [message('N', 'm2')], () => {})
  assert.deepEqual([...second].map(config => config.id), ['lore-1'], 'sticky 命中时延迟门控被绕过')
  assert.equal(second.diagnostics.records.some(record => record.reason === 'delay-until-recursion'), false)

  // 非 sticky 的同类条目在 pass 0 被抑制并记录原因码（观测与真实结果同源）。
  const other = selectStWorldBook(diagConfigs([entry(2, { constant: true, extensions: { delay_until_recursion: 2 } })]),
    { id: 'delay-note', header: {}, snapshotEvents: () => [] }, [message('N')], () => {})
  const record = other.diagnostics.records.find(item => item.reason === 'delay-until-recursion')
  assert.equal(record?.stage, 'excluded')
  assert.equal(record?.delayUntilRecursion, 2)
})

test('T16 useGroupScoring：与 ST getScore 对拍，未开启者不被淘汰但计入最高分', async () => {
  const group = [
    entry(1, { keys: ['P'], insertion_order: 300, extensions: { group: 'G', use_group_scoring: true } }),
    entry(2, { keys: ['P', 'Q'], insertion_order: 200, extensions: { group: 'G' } }),
    entry(3, { keys: ['P', 'R'], insertion_order: 100, extensions: { group: 'G', use_group_scoring: true } }),
  ]
  const text = 'P Q'
  const members = [{ useGroupScoring: true }, { useGroupScoring: undefined }, { useGroupScoring: true }]
  const scores = [
    stGetScore(['P'], [], 0, text),
    stGetScore(['P', 'Q'], [], 0, text),
    stGetScore(['P', 'R'], [], 0, text),
  ]
  assert.deepEqual(scores, [1, 2, 1], '夹具分数：ST 按命中键数计分')
  assert.deepEqual(stScoringKeeps(members, scores), [false, true, false], '夹具：只有开启评分者会被淘汰')

  const selected = await run(group, [text])
  assert.deepEqual(selected.map(x => x.id), ['lore-2'], '评分后只剩未开启评分的条目 2')

  const session = { id: 'scoring', header: {}, snapshotEvents: () => [] }
  const selection = selectStWorldBook(diagConfigs(group), session, [message(text)], () => {})
  assert.deepEqual([...selection].map(config => config.id), ['lore-2'])
  const lost = selection.diagnostics.records.filter(record => record.reason === 'group-score-lost')
  assert.deepEqual(lost.map(record => [record.id, record.score, record.maxScore]),
    [['lore-1', 1, 2], ['lore-3', 1, 2]], '诊断记录分数与最高分')

  // 关闭评分时回到既有权重随机路径（Math.random=0 选中 available 首项），入选集合不受评分影响。
  const original = Math.random
  Math.random = () => 0
  try {
    const off = group.map(({ extensions, ...rest }) => ({ ...rest, extensions: { group: extensions.group } }))
    assert.deepEqual((await run(off, [text])).map(x => x.id), ['lore-1'], '未开启评分时行为不变')

    // 组内有 sticky 命中时整组跳过评分（ST filterGroupsByScoring 5300-5305）：
    // 第二轮条目 4 的分数低于条目 5，但评分不执行，sticky 成员不被淘汰。
    const stickyGroup = [
      entry(4, { keys: ['P'], insertion_order: 200, extensions: { group: 'S', scan_depth: 1, sticky: 3, use_group_scoring: true } }),
      entry(5, { keys: ['P', 'Q'], insertion_order: 100, extensions: { group: 'S' } }),
    ]
    const stickyHistory = []
    const stickyConfigs = diagConfigs(stickyGroup)
    const stickySession = { id: 'sticky-score', header: {}, snapshotEvents: () => stickyHistory }
    const round = (text, id) => {
      const msg = message(text, id)
      const result = selectStWorldBook(stickyConfigs, stickySession, [msg], () => {})
      const ids = [...result].map(config => config.id)
      for (const config of result) result.commit(config)
      stickyHistory.push({ type: 'user/message', data: { message: msg } })
      return { ids, result }
    }
    assert.deepEqual(round('P', 's1').ids, ['lore-4'], '第一轮权重随机选中条目 4 并进入 sticky 窗口')
    const second = round('P Q', 's2')
    assert.deepEqual(second.ids, ['lore-4'], 'sticky 命中时跳过评分，不被条目 5 的高分淘汰')
    assert.equal(second.result.diagnostics.records.some(record => record.reason === 'group-score-lost'), false)
  } finally {
    Math.random = original
  }
})
