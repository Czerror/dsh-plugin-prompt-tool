import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse, Document } from 'yaml'
import { convertStToPreset, convertStToPresetWithReport, mergeStPresets } from '../../src/host/sillytavern.ts'
import { importCharacterCard, applyCharacterToPreset, removeCharacterFromPreset } from '../../src/host/characters.ts'

test('ST 官方嵌套 prompt_order 决定启停和次序，缺席条目不误启用', () => {
  const spec = convertStToPreset({
    prompts: ['a', 'b', 'c', 'd'].map(identifier => ({ identifier, role: 'system', content: identifier, enabled: identifier !== 'c' })),
    prompt_order: [{ character_id: 100000, order: [{ identifier: 'b', enabled: true }] },
      { character_id: 100001, order: [{ identifier: 'c', enabled: true }, { identifier: 'a', enabled: true }, { identifier: 'b', enabled: false }] }],
  }, 'ordered')
  const configs = spec.promptConfigs
  assert.deepEqual(configs.filter(c => c.enabled).sort((a, b) => a.order - b.order).map(c => c.id), ['c', 'a'])
  assert.equal(configs.find(c => c.id === 'd').enabled, false)
})

test('ST 纯赋值卡保留源与开关，禁用卡不进入默认变量', () => {
  const spec = convertStToPreset({ prompts: [
    { identifier: 'on', role: 'system', enabled: true, content: '{{setvar::rule::BASE}}' },
    { identifier: 'off', role: 'system', enabled: false, content: '{{addvar::rule::-DISABLED}}' },
    { identifier: 'out', role: 'system', content: '{{getvar::rule}}' },
  ] }, 'variables')
  assert.equal(spec.promptConfigs.length, 3)
  assert.equal(spec.promptConfigs.find(c => c.id === 'off').enabled, false)
  assert.match(spec.promptConfigs.find(c => c.id === 'off').text, /addvar/)
  assert.notEqual(spec.variables?.rule, 'BASE-DISABLED')
})

test('合并变量默认值保留；每个来源的同名内容变量只绑定自身卡片', () => {
  const part = (id, tone) => ({ id, name: id, version: '1', engineCompat: '*', variables: { tone }, promptConfigs: [{ id: 'text', text: '{{tone}}' }] })
  const merged = mergeStPresets([part('a', 'A'), part('b', 'B')])
  assert.ok(merged.variables)
  assert.deepEqual(merged.promptConfigs.map(c => c.variables.tone), ['A', 'B'])
  assert.deepEqual(mergeStPresets([{ ...part('a', 'A'), meta: { stWarnings: ['LIMIT'] } }, part('b', 'B')]).meta.stWarnings, ['LIMIT'])
})

test('角色应用把变量绑定到卡片，移除不破坏预设原变量', () => {
  const root = mkdtempSync(join(tmpdir(), 'pt-st-variable-'))
  try {
    mkdirSync(join(root, 'target'))
    const file = join(root, 'target', 'preset.yml')
    writeFileSync(file, new Document({ id: 'target', name: 'target', modules: ['prompt-config-engine'], variables: { tone: 'HOST' }, promptConfigs: [] }).toString())
    const imported = importCharacterCard(root, [{ path: 'card.json', content: JSON.stringify({ data: { name: 'Card', description: 'DESC', system_prompt: '{{description}}' } }) }])
    assert.equal(imported.ok, true)
    assert.equal(applyCharacterToPreset(root, 'target', imported.id).ok, true)
    const applied = parse(readFileSync(file, 'utf8'))
    assert.equal(applied.variables.tone, 'HOST')
    assert.ok(applied.promptConfigs.some(c => c.variables?.description === 'DESC'))
    assert.equal(removeCharacterFromPreset(root, 'target', imported.id).ok, true)
    assert.deepEqual(parse(readFileSync(file, 'utf8')).variables, { tone: 'HOST' })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('角色卡 mes_example 保留来源角色、次序和一次性身份，注入角色统一为 user', () => {
  const { spec, report } = convertStToPresetWithReport({ data: { name: 'Ada', mes_example: '<START>\n{{user}}: QUESTION\n{{char}}: ANSWER\n<START>\nUser: NEXT\nAda: REPLY', first_mes: 'HELLO' } }, 'examples')
  const examples = spec.promptConfigs.filter(c => c.id.startsWith('dialogue-example-'))
  assert.deepEqual(examples.map(c => [c.role, c.text]), [['user', 'QUESTION'], ['user', 'ANSWER'], ['user', 'NEXT'], ['user', 'REPLY']])
  // 原角色保留在 stSource.role，报告按 degraded 记录而不是宣称等价。
  assert.deepEqual(examples.map(c => c.params.stSource.role), ['user', 'assistant', 'user', 'assistant'])
  assert.deepEqual(
    report.entries.filter(e => e.targetId.startsWith('dialogue-example-')).map(e => e.classification),
    ['equivalent', 'degraded', 'equivalent', 'degraded'],
  )
  assert.ok(examples.every(c => c.dedupe === 'session' && c.order < -40))
  assert.equal(spec.promptConfigs.find(c => c.id === 'first-mes').role, 'user')
})

test('日期宏不登记空值；转换不修改输入对象或执行扩展代码', () => {
  const input = { data: { name: 'Ada', system_prompt: '{{date}} {{time}}', extensions: { regex_scripts: [{ content: 'CODE' }] } } }
  const snapshot = structuredClone(input)
  const spec = convertStToPreset(input, 'time')
  assert.deepEqual(input, snapshot)
  assert.equal(spec.variables?.date, undefined)
  assert.equal(spec.variables?.time, undefined)
  assert.equal(spec.meta.stWarnings.length, 1)
})

test('世界书 extensions 蛇形别名写入 params，冲突按既有拼写优先且不修改源对象', () => {
  const input = { entries: { 0: {
    uid: 0, key: ['P'], keysecondary: ['S', 'T'], content: 'E0', disable: false,
    extensions: { selective_logic: 3, use_probability: false, probability: 0 },
  } } }
  const snapshot = structuredClone(input)
  const configs = convertStToPreset(input, 'book').promptConfigs
  const config = configs.find(c => c.id === 'lore-0')
  assert.deepEqual(config.params.keys, ['P'])
  assert.deepEqual(config.params.secondaryKeys, ['S', 'T'])
  assert.equal(config.params.selectiveLogic, 3)
  assert.equal(config.params.stWorldBook.useProbability, false)
  assert.equal(config.params.stWorldBook.probability, 0)
  assert.deepEqual(input, snapshot)

  // 冲突规则：extensions 内既有拼写优先于新增别名，extensions 整体优先于条目顶层。
  const conflicted = convertStToPreset({ entries: { 0: {
    uid: 0, key: ['P'], content: 'E0', selectiveLogic: 1, selective_logic: 1,
    extensions: { selectiveLogic: 2, selective_logic: 3, useProbability: true, use_probability: false },
  } } }, 'book').promptConfigs[0]
  assert.equal(conflicted.params.selectiveLogic, 2)
  assert.equal(conflicted.params.stWorldBook.useProbability, true)
})

test('独立世界书顶层 key/keysecondary/selective_logic 与角色卡内嵌等价字段产出一致', () => {
  const shared = { keys: ['P'], secondary_keys: ['S', 'T'], content: 'E0', enabled: true, constant: false, selective: true }
  const embedded = convertStToPreset({ data: { name: 'C', character_book: { entries: [
    { ...shared, id: 0, extensions: { selective_logic: 3, use_probability: false, probability: 0 } },
  ] } } }, 'card').promptConfigs.find(c => c.id === 'lore-0')
  const standalone = convertStToPreset({ entries: { 0: { ...shared, uid: 0, key: shared.keys, keysecondary: shared.secondary_keys,
    extensions: { selective_logic: 3, use_probability: false, probability: 0 } } } }, 'book').promptConfigs.find(c => c.id === 'lore-0')
  for (const key of ['selectiveLogic', 'keys', 'secondaryKeys']) {
    assert.deepEqual(standalone.params[key], embedded.params[key], key)
  }
  assert.equal(standalone.params.stWorldBook.useProbability, false)
  assert.equal(embedded.params.stWorldBook.useProbability, false)
  assert.equal(standalone.params.stWorldBook.probability, 0)
})

/** T16 世界书条件字段夹具：role=1 避免角色降级诊断干扰断言。 */
const conditionEntry = (extra) => ({
  id: 0, keys: ['P'], content: 'E0', enabled: true, constant: false, selective: true, role: 1, extensions: {}, ...extra,
})

test('T16 世界书条件字段：delayUntilRecursion 与 useGroupScoring 双拼写写入 stWorldBook', () => {
  const snake = convertStToPreset({ entries: { 0: conditionEntry({
    uid: 0, key: ['P'], extensions: { delay_until_recursion: 2, use_group_scoring: true } }) } }, 'cond').promptConfigs[0]
  assert.equal(snake.params.stWorldBook.delayUntilRecursion, 2)
  assert.equal(snake.params.stWorldBook.useGroupScoring, true)

  const camel = convertStToPreset({ data: { name: 'C', character_book: { entries: [
    conditionEntry({ delayUntilRecursion: 3, useGroupScoring: false }),
  ] } } }, 'cond2').promptConfigs.find(c => c.id === 'lore-0')
  assert.equal(camel.params.stWorldBook.delayUntilRecursion, 3)
  assert.equal(camel.params.stWorldBook.useGroupScoring, false)

  // 缺省不写键（引擎按缺省语义处理），显式 0/false 保留为事实。
  const absent = convertStToPreset({ entries: { 0: conditionEntry({ uid: 0, key: ['P'] }) } }, 'cond3').promptConfigs[0]
  assert.equal('delayUntilRecursion' in absent.params.stWorldBook, false)
  assert.equal('useGroupScoring' in absent.params.stWorldBook, false)
  const zero = convertStToPreset({ entries: { 0: conditionEntry({ uid: 0, key: ['P'], delayUntilRecursion: 0 }) } }, 'cond4').promptConfigs[0]
  assert.equal(zero.params.stWorldBook.delayUntilRecursion, 0)
})

/** T11–T14 世界书触发键宏夹具：role=1 避免角色降级诊断干扰断言。 */
const keyMacroEntry = (extra) => ({
  id: 25, keys: [], secondary_keys: [], content: 'E25', enabled: true, constant: false,
  selective: true, insertion_order: 100, position: 'before_char', role: 1, extensions: {}, ...extra,
})

test('T17 characterFilter 按真实嵌套对象形态保留并显式拒绝', () => {
  const filter = { names: ['Ada', 'Bob'], tags: [12, 34], isExclude: true }
  const { spec, report } = convertStToPresetWithReport({ entries: { 0: conditionEntry({
    uid: 0, key: ['P'], characterFilter: filter }) } }, 'filter')
  const config = spec.promptConfigs[0]
  assert.deepEqual(config.params.stWorldBook.characterFilter, filter, '嵌套对象完整保留')
  const diagnostics = report.diagnostics.filter(item => item.code === 'st-worldbook-character-filter')
  assert.equal(diagnostics.length, 1)
  assert.deepEqual([diagnostics[0].severity, diagnostics[0].entryId, diagnostics[0].field],
    ['warning', '0', 'characterFilter'])
  assert.match(diagnostics[0].message, /不受支持/)
  assert.equal(report.summary.needsReview, 1)

  // 未使用（缺省 / 两个数组都为空）零诊断；空对象仍按事实保留。
  const unused = convertStToPresetWithReport({ entries: { 0: conditionEntry({ uid: 0, key: ['P'] }) } }, 'nofilter')
  assert.equal(unused.report.diagnostics.filter(item => item.code === 'st-worldbook-character-filter').length, 0)
  const empty = convertStToPresetWithReport({ entries: { 0: conditionEntry({
    uid: 0, key: ['P'], characterFilter: { names: [], tags: [], isExclude: true } }) } }, 'emptyfilter')
  assert.equal(empty.report.diagnostics.filter(item => item.code === 'st-worldbook-character-filter').length, 0)
  assert.deepEqual(empty.spec.promptConfigs[0].params.stWorldBook.characterFilter, { names: [], tags: [], isExclude: true })

  // 角色卡内嵌世界书与独立世界书同源；非法形态（数组 / 字符串）不当作过滤启用。
  const embedded = convertStToPreset({ data: { name: 'C', character_book: { entries: [
    conditionEntry({ id: 0, keys: ['P'], characterFilter: filter })] } } }, 'cardfilter').promptConfigs.find(c => c.id === 'lore-0')
  assert.deepEqual(embedded.params.stWorldBook.characterFilter, filter)
  const malformed = convertStToPresetWithReport({ entries: { 0: conditionEntry({
    uid: 0, key: ['P'], characterFilter: ['Ada'] }) } }, 'badfilter')
  assert.equal(malformed.report.diagnostics.filter(item => item.code === 'st-worldbook-character-filter').length, 0)
  assert.equal('characterFilter' in malformed.spec.promptConfigs[0].params.stWorldBook, false)

  // 仅 isExclude 非默认、两个维度都为空时 ST 同样不产生过滤，因此不告警。
  const excludeOnly = convertStToPresetWithReport({ entries: { 0: conditionEntry({
    uid: 0, key: ['P'], characterFilter: { names: [], tags: [], isExclude: false } }) } }, 'excludeonly')
  assert.equal(excludeOnly.report.diagnostics.filter(item => item.code === 'st-worldbook-character-filter').length, 0)
})

test('T18 automationId / outletName 双形态读取与自动化依赖诊断', () => {
  // 顶层驼峰（ST 独立世界书真实形态）与 extensions 蛇形都要读到。
  const camel = convertStToPresetWithReport({ entries: { 0: conditionEntry({
    uid: 0, key: ['P'], automationId: 'auto-1' }) } }, 'camel')
  assert.equal(camel.spec.promptConfigs[0].params.stWorldBook.automationId, 'auto-1')
  const camelDiag = camel.report.diagnostics.filter(item => item.code === 'st-worldbook-automation')
  assert.equal(camelDiag.length, 1)
  assert.deepEqual([camelDiag[0].severity, camelDiag[0].entryId, camelDiag[0].field], ['warning', '0', 'automationId'])
  assert.doesNotMatch(camelDiag[0].message, /不会自动注入/, '有主键时不宣称不会注入')

  const snake = convertStToPresetWithReport({ entries: { 0: conditionEntry({
    uid: 0, key: ['P'], extensions: { automation_id: 'auto-2' } }) } }, 'snake')
  assert.equal(snake.spec.promptConfigs[0].params.stWorldBook.automationId, 'auto-2')
  assert.equal(snake.report.diagnostics.filter(item => item.code === 'st-worldbook-automation').length, 1)

  // 无主键且非常驻：文案明确「不会自动注入」。
  const orphan = convertStToPresetWithReport({ entries: { 0: conditionEntry({ uid: 0, keys: [], key: [], automationId: 'auto-3' }) } }, 'orphan')
  assert.match(orphan.report.diagnostics.find(item => item.code === 'st-worldbook-automation').message, /不会自动注入/)

  // 空值 / 缺省零噪音（素材实测 automationId 每条存在但非空值 0）。
  const empty = convertStToPresetWithReport({ entries: { 0: conditionEntry({
    uid: 0, key: ['P'], automationId: '', outletName: '' }) } }, 'empty')
  assert.equal(empty.report.diagnostics.filter(item => item.code === 'st-worldbook-automation').length, 0)
  assert.equal(empty.report.diagnostics.filter(item => item.code === 'st-worldbook-controls').length, 0)
  assert.equal('automationId' in empty.spec.promptConfigs[0].params.stWorldBook, false)
  assert.equal('outletName' in empty.spec.promptConfigs[0].params.stWorldBook, false)

  // 非字符串形态（数字 0 / 布尔 false）视为未设置：不得被 String() 归一成非空值而误报。
  for (const value of [0, false, 0.0, {}]) {
    const odd = convertStToPresetWithReport({ entries: { 0: conditionEntry({
      uid: 0, key: ['P'], automationId: value, outletName: value }) } }, `odd-${typeof value}`)
    assert.equal(odd.report.diagnostics.filter(item => item.code === 'st-worldbook-automation').length, 0, `automationId=${String(value)} 零诊断`)
    assert.equal(odd.report.diagnostics.filter(item => item.code === 'st-worldbook-controls').length, 0, `outletName=${String(value)} 零诊断`)
    assert.equal('automationId' in odd.spec.promptConfigs[0].params.stWorldBook, false)
  }

  // outletName 沿用 unsupported-controls：保留事实但内容不被误注入。
  const outlet = convertStToPresetWithReport({ entries: { 0: conditionEntry({ uid: 0, key: ['P'], outletName: 'OUT' }) } }, 'outlet')
  assert.equal(outlet.spec.promptConfigs[0].params.stWorldBook.outletName, 'OUT')
  assert.equal(outlet.report.diagnostics.filter(item => item.code === 'st-worldbook-controls').length, 1)
  assert.equal(outlet.report.entries.find(entry => entry.sourceId === '0').classification, 'unsupported')
})

test('T19 prompts[].system_prompt 只保留事实，层归属仍按 role', () => {
  const { spec, report } = convertStToPresetWithReport({ prompts: [
    { identifier: 'main', role: 'system', content: 'MAIN', system_prompt: true },
    { identifier: 'aux', role: 'user', content: 'AUX', system_prompt: true },
    { identifier: 'plain', role: 'user', content: 'PLAIN', system_prompt: false },
  ] }, 'sysflag')
  const byId = new Map(spec.promptConfigs.map(c => [c.id, c]))
  // 核实结论（ST 1.19.0 openai.js:1240-1257）：system_prompt 只是「内置/全局 prompt」的管理位，
  // 发送角色与位置仍由 role 与 prompt_order 决定，因此不改变层归属。
  assert.equal(byId.get('main').layer, 'system-section')
  assert.equal(byId.get('aux').layer, 'pre-step')
  assert.equal(byId.get('aux').role, 'user')
  assert.equal(byId.get('main').params.stSource.systemPrompt, true)
  assert.equal(byId.get('aux').params.stSource.systemPrompt, true)
  assert.equal(byId.get('plain').params?.stSource?.systemPrompt, undefined)

  const info = report.diagnostics.filter(item => item.code === 'st-prompt-system-flag')
  assert.deepEqual(info.map(item => [item.severity, item.entryId, item.field]),
    [['info', 'main', 'system_prompt'], ['info', 'aux', 'system_prompt']])
  assert.match(info[1].message, /不改变发送角色/)
  // info 不改变既有 stWarnings 表现，也不改变报告分类。
  assert.equal(report.summary.needsReview, 0)
  assert.equal(spec.meta.stWarnings, undefined)
  const aux = report.entries.find(entry => entry.sourceId === 'aux')
  assert.deepEqual([aux.classification, aux.layer, aux.role], ['equivalent', 'pre-step', 'user'])
  const main = report.entries.find(entry => entry.sourceId === 'main')
  assert.deepEqual([main.classification, main.layer], ['equivalent', 'system-section'])
})

test('T20 角色卡 depth_prompt 保留为默认禁用配置并登记扫描变量', () => {
  const card = { data: { name: 'Ada', description: 'DESC', creator_notes: 'NOTES',
    extensions: { depth_prompt: { prompt: 'DEEP', depth: 4, role: 0 } } } }
  const { spec, report } = convertStToPresetWithReport(card, 'deepprompt')
  const config = spec.promptConfigs.find(c => c.id === 'st-depth-prompt')
  assert.equal(config.enabled, false, '默认禁用：ST 只在群聊自动注入，本项目不默认注入')
  assert.equal(config.text, 'DEEP')
  assert.deepEqual([config.layer, config.role, config.position], ['pre-step', 'user', 'before-all'])
  assert.equal(config.params.stSource.field, 'extensions.depth_prompt')
  assert.deepEqual([config.params.stSource.depth, config.params.stSource.role], [4, 0])
  assert.equal(spec.variables.depth_prompt, 'DEEP', '登记为内容变量供扫描开关使用')
  assert.equal(spec.variables.creator_notes, 'NOTES')
  const entry = report.entries.find(item => item.targetId === 'st-depth-prompt')
  assert.deepEqual([entry.classification, entry.layer], ['degraded', 'pre-step'])
  assert.deepEqual(entry.codes, ['depth-prompt-group-only'])
  assert.equal(report.diagnostics.filter(item => item.code === 'st-depth-prompt').length, 1)
  assert.equal(report.summary.disabled, 1)

  // 没有 depth_prompt / creator_notes 的卡片不产出该配置与变量（零噪音）。
  const plain = convertStToPreset({ data: { name: 'Bob', description: 'D' } }, 'plain')
  assert.equal(plain.promptConfigs.some(c => c.id === 'st-depth-prompt'), false)
  assert.equal(plain.variables?.creator_notes, undefined)
  assert.equal(plain.variables?.depth_prompt, undefined)
})

test('T11 世界书 keys 的未解析宏登记为空占位并产出可定位诊断', () => {
  const card = { data: { name: 'Ada', character_book: { entries: [keyMacroEntry({ keys: ['{{user}}'] })] } } }
  const { spec, report } = convertStToPresetWithReport(card, 'keymacro')
  assert.equal(spec.variables.user, '', '未定义宏登记为空占位')
  const config = spec.promptConfigs.find(c => c.id === 'lore-25')
  assert.deepEqual(config.params.keys, ['{{user}}'], '源键内容不被改写')
  const diagnostics = report.diagnostics.filter(item => item.code === 'st-key-macro')
  assert.equal(diagnostics.length, 1, '每个条目一条键宏诊断')
  assert.deepEqual([diagnostics[0].severity, diagnostics[0].entryId, diagnostics[0].field],
    ['warning', '25', 'keys'])
  assert.match(diagnostics[0].message, /模板变量/)
  assert.ok(spec.meta.stWarnings.includes(diagnostics[0].message), 'warning 进入 stWarnings')
  assert.equal(report.summary.needsReview, 1, 'warning 计入 needsReview')
})

test('T13 键宏登记不覆盖既有变量，字面键、char 宏与已定义变量不回归', () => {
  const card = { data: { name: 'Ada', description: 'DESC', character_book: { entries: [
    keyMacroEntry({ keys: ['P', '{{char}}', '{{user}}'] }),
  ] } } }
  const spec = convertStToPreset(card, 'noregress')
  assert.equal(spec.variables.char, 'Ada', 'char 变量不被空占位覆盖')
  assert.equal(spec.variables.description, 'DESC', '卡片正文变量不被空占位覆盖')
  assert.equal(spec.variables.user, '')
  assert.equal(spec.variables.DSH_HOME, undefined, '内置路径变量不登记')
  assert.deepEqual(spec.promptConfigs.find(c => c.id === 'lore-25').params.keys, ['P', '{{char}}', '{{user}}'])

  // 正文已引用的宏同样不覆盖；键里的同名宏仍按条目产出诊断（可见性不因登记顺序丢失）。
  const both = convertStToPresetWithReport({ data: { name: 'Ada', system_prompt: 'S {{user}}', character_book: {
    entries: [keyMacroEntry({ keys: ['{{user}}'] })] } } }, 'bodyfirst')
  assert.equal(both.spec.variables.user, '')
  assert.equal(both.report.diagnostics.filter(item => item.code === 'st-key-macro').length, 1)
})

test('T14 键宏边界：secondaryKeys 登记、大小写不敏感、运行时宏不登记、畸形引用不抛错', () => {
  const book = (entry) => ({ data: { name: 'Ada', character_book: { entries: [entry] } } })
  const sec = convertStToPresetWithReport(book(keyMacroEntry({ keys: ['P'], secondary_keys: ['{{sidekick}}'] })), 'sec')
  assert.equal(sec.spec.variables.sidekick, '')
  assert.deepEqual(sec.report.diagnostics.filter(item => item.code === 'st-key-macro').map(item => item.field),
    ['secondaryKeys'])

  const upper = convertStToPreset(book(keyMacroEntry({ keys: ['{{USER}}'], secondary_keys: ['{{user}}'] })), 'upper')
  assert.equal(Object.keys(upper.variables).filter(key => key.toLowerCase() === 'user').length, 1, '同一宏只登记一次')
  assert.equal(upper.variables.USER, '')

  const runtime = convertStToPresetWithReport(book(keyMacroEntry({ keys: ['{{time}}', '{{DSH_HOME}}', '{{random::a,b}}'] })), 'runtime')
  assert.equal(runtime.report.diagnostics.filter(item => item.code === 'st-key-macro').length, 0)
  assert.equal(runtime.spec.variables?.time, undefined)
  assert.equal(runtime.spec.variables?.DSH_HOME, undefined)

  const malformed = convertStToPresetWithReport(book(keyMacroEntry({ keys: ['{{', '{{}}', '{{a{{b}}', 'plain'] })), 'malformed')
  assert.deepEqual(malformed.spec.promptConfigs.find(c => c.id === 'lore-25').params.keys, ['{{', '{{}}', '{{a{{b}}', 'plain'])
  assert.equal(malformed.spec.variables.b, '', '畸形引用按可识别的最内层宏宽容处理，不抛错')

  // 诊断上限与 truncated 语义不变：超限只截断观测，不改变生成的配置。
  const many = convertStToPresetWithReport({ data: { name: 'Ada', character_book: { entries:
    Array.from({ length: 250 }, (_, index) => keyMacroEntry({ id: index + 1, keys: [`{{macro${index}}}`] })) } } }, 'many')
  assert.equal(many.spec.promptConfigs.length, 250)
  assert.equal(many.report.diagnostics.length, 200)
  assert.equal(many.report.truncated, true)
})
