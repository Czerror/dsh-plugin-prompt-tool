import { test } from 'node:test'
import assert from 'node:assert/strict'
import { convertStToPreset } from '../../src/host/sillytavern.ts'
import { createPromptConfigs } from '../../engine/schema.mjs'
import { runPreStepBatch } from '../../engine/executor.mjs'

const entry = (id, extra = {}) => ({ id, keys: [], secondary_keys: [], content: `E${id}`, enabled: true, constant: false, selective: true, insertion_order: 100, position: 'before_char', extensions: {}, ...extra })
const message = (text, id = text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const promotion = { main: { status: () => ({ promoted: true }) }, withSubagents: { status: () => ({ promoted: true }) } }
async function run(entries, texts, history = [], extras = {}) {
  const spec = convertStToPreset({ data: { name: 'Probe', character_book: { entries } } }, 'probe')
  const configs = createPromptConfigs(spec.promptConfigs.map(c => ({ ...c, variables: spec.variables })))
  const agent = { session: { id: 'probe', header: {}, snapshotEvents: () => history }, options: {} }
  const decision = await runPreStepBatch({ ctx: { get() {} }, agent, decision: { kind: 'enter', messages: texts.map(t => message(t)) }, configs, promotion, memo: new Map(), warnOnce() {}, ...extras })
  return decision.messages.filter(m => m.source?.plugin?.startsWith('lore-')).map(m => ({ id: m.source.plugin, role: m.role, text: m.content.map(c => c.text).join('') }))
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
  assert.equal(config.role, 'assistant')
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
