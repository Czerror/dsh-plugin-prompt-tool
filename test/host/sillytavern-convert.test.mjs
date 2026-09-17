// ST 转译（Wave 2 合并，2026-09-17 测试归一精简）：合并自 st-compatibility.test.mjs（16 条）、
// sillytavern.test.mjs（11 条）、st-integration-r14.test.mjs（2 条），共 29 条；
// 用例标题与断言逐条保留。
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse, Document } from 'yaml'

// 隔离 DSH_HOME：角色卡应用/移除会写到 DSH_HOME，必须在动态 import 之前生效。
const home = mkdtempSync(join(tmpdir(), 'pt-st-home-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = home
const { buildWorldBookEntry } = await import('../../src/host/worldbook.ts')
const { convertStToPreset, convertStToPresetWithReport, mergeStPresets, stPresetId } = await import('../../src/host/sillytavern.ts')
const { importCharacterCard, applyCharacterToPreset, removeCharacterFromPreset } = await import('../../src/host/characters.ts')
const { Session, snapshotSessionEvent } = await import('@deepseek-ai/dsh-session')
const { Context } = await import('@deepseek-ai/cordis')
const { createScope } = await import('@deepseek-ai/dsh-scope')
const { agentEvents } = await import('@deepseek-ai/dsh-agent')
const { applyPromptConfigs, createPromptConfigs } = await import('../../engine/prompt-config-engine.mjs')
const { installPreStepCoordinator } = await import('../../src/runtime/pre-step-coordinator.ts')
// 发布入口通道：原 sillytavern.test.mjs 经 lib/index.mjs 验证（发布产物可转换），
// 合并后保留该通道；内部实现用例仍走上面的 src 直连绑定。
const lib = await import('../../lib/index.mjs')
after(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})

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

// —— 转换纯逻辑（原 sillytavern.test.mjs，11 条） ——
// 这 11 条走**发布入口**（lib/index.mjs）的同名导出，与源文件的通道一致。
/** 官方 agent-presets discovery 的目录名校验（lib/index.js PRESET_ID）。 */
const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/

test('stPresetId：中英混合文件名 slug 化（官方 agent-presets 可发现）', () => {
  // 调用方契约：baseName 已剥 .json 扩展名（settings-bridge/characters 均 replace(/\.json$/i,'')）。
  const id = lib.stPresetId('夏瑾-天琴座-beta-2-42')
  assert.match(id, PRESET_ID, 'id 必须满足官方 PRESET_ID')
  assert.equal(id, 'beta-2-42')
})

test('stPresetId：纯中文文件名退化为 st-<hash>（唯一且合法）', () => {
  const id = lib.stPresetId('夏瑾')
  assert.match(id, PRESET_ID)
  assert.match(id, /^st-[0-9a-f]{6}$/)
  // 不同文件名 → 不同 id（防止多张中文卡互相覆盖）
  assert.notEqual(lib.stPresetId('天琴座'), id)
})

test('stPresetId：英文文件名保持 slug', () => {
  assert.equal(lib.stPresetId('My Card v2'), 'my-card-v2')
})

test('convertStToPreset：变量指令保留在卡片，导入期不产生赋值副作用', () => {
  // 真实素材（明月秋青 v5.0 一类）：分卡用 addvar 拼出 {{POV_rules}}/{{anti_rules}}，后续卡片再引用。
  const card = {
    name: '变量族卡',
    data: {
      system_prompt: [
        '{{addvar::POV_rules::- 第一人称}}',
        '{{addvar::POV_rules::，禁止旁白}}',
        '{{setglobalvar::output_language::简体中文}}',
        '{{incvar::counter}}',
        '语言 {{output_language}} 规则 {{POV_rules}} 缺省 {{missing_var::回退值}}',
      ].join('\n'),
    },
  }
  const spec = lib.convertStToPreset(card, 'st-var-family')
  assert.equal(spec.variables.POV_rules, '', '普通引用仅登记默认占位')
  assert.equal(spec.variables.output_language, '', 'global 不在导入期执行')
  assert.equal('counter' in spec.variables, false, 'incvar 留给运行时')
  const system = spec.promptConfigs.find((config) => config.id === 'system-prompt')
  assert.match(system.text, /\{\{addvar/, '保留模板供运行时求值')
  assert.equal(system.params.stMacros, true)
  assert.match(system.text, /\{\{POV_rules\}\}/, '引用保留为变量引用，由引擎解析')
})

test('convertStToPreset：跨行注释剥离、ST 宏归一、字段宏登记为内容变量', () => {
  const card = {
    name: '测试卡',
    data: {
      description: '描写 {{char}} 的场景',
      personality: '性格文本',
      scenario: '场景文本',
      system_prompt: '{{// 注释开头\n{ "thinking": { "type": "disabled" } }\n注释结尾 }}\n正文 {{roll 1d6}} 与 {{random:a,b}} 与 {{description}} 与 {{persona}}',
    },
  }
  const spec = lib.convertStToPreset(card, 'st-macro-card')
  assert.equal(spec.variables.description, '描写 测试卡 的场景', '字段宏登记为内容变量并清洗 {{char}}')
  assert.equal(spec.variables.personality, '性格文本')
  assert.equal(spec.variables.scenario, '场景文本')
  assert.equal(spec.variables.persona, '', '卡内无 persona 字段但正文引用 → 空占位（不留字面）')

  const system = spec.promptConfigs.find((config) => config.id === 'system-prompt')
  assert.ok(system !== undefined, '系统提示卡存在')
  assert.doesNotMatch(system.text, /\{\{\/\//, '跨行注释宏被剥离')
  assert.doesNotMatch(system.text, /thinking/, '注释正文（含 JSON）随注释一并剥离')
  assert.match(system.text, /\{\{roll::1d6\}\}/, '空格形态骰子归一到本项目语法')
  assert.match(system.text, /\{\{random::a,b\}\}/, '单冒号形态 random 归一到本项目语法')
  assert.match(system.text, /\{\{description\}\}/, '字段宏保留为变量引用，由引擎解析')
})

test('convertStToPreset：世界书正则键保留原样且不写幽灵字段 useRegex', () => {
  const card = {
    name: '测试卡',
    data: {
      character_book: {
        entries: [
          { keys: ['/^剑\\d+$/'], content: '剑术规则', comment: '剑术', insertion_order: 10 },
          { keys: ['普通词'], content: '普通条目', comment: '普通', insertion_order: 20 },
        ],
      },
    },
  }
  const spec = lib.convertStToPreset(card, 'test-card')
  assert.deepEqual(spec.modules, [
    'prompt-config-engine', 'character-tools', 'world-book-tools',
    'session-var-tools', 'tool-config-engine', 'tool-filter',
  ], 'ST 只装配提示词执行与管理工具模块')
  const lore = spec.promptConfigs.filter((config) => config.strategy === 'world-book')
  assert.equal(lore.length, 2, '两条世界书条目都转换')
  assert.equal(lore[0].params.keys[0], '/^剑\\d+$/')
  assert.equal('useRegex' in lore[0].params, false, '不写幽灵字段 useRegex')
  assert.equal('useRegex' in lore[1].params, false)
})

test('convertStToPreset：空世界书不装工具，tool-filter 仍按需就绪', () => {
  const spec = lib.convertStToPreset({
    name: '空卡',
    data: { character_book: { entries: [{ content: '   ' }] } },
  }, 'empty-card')
  assert.deepEqual(spec.modules, [
    'prompt-config-engine', 'character-tools', 'session-var-tools', 'tool-config-engine', 'tool-filter',
  ])
  assert.equal(spec.moduleConfigs['tool-filter'], undefined, '字段缺省时过滤器为空操作')
})

test('convertStToPreset：世界书最终正文 order 升序（ST 激活后 unshift）', () => {
  const card = {
    name: '排序卡',
    data: {
      character_book: {
        entries: [
          { keys: ['A'], content: 'a', comment: 'a', insertion_order: 10 },
          { keys: ['B'], content: 'b', comment: 'b', insertion_order: 200 },
        ],
      },
    },
  }
  const spec = lib.convertStToPreset(card, 'order-card')
  const lore = spec.promptConfigs
    .filter((config) => config.strategy === 'world-book')
    .sort((x, y) => Number(x.order) - Number(y.order))
  assert.equal(lore.length, 2)
  assert.equal(lore[0].order, 10, '正文低 order 在前，激活优先级另按降序处理')
  assert.equal(lore[1].order, 200)
})

test('convertStToPreset：世界书条目结构 = buildWorldBookEntry 工厂同参数产物（两通道同构）', () => {
  const card = {
    name: '同构卡',
    data: {
      character_book: {
        entries: [
          {
            keys: ['气味'],
            secondary_keys: ['香水'],
            content: '空气中弥漫着…',
            comment: '气味描写',
            insertion_order: 10,
            constant: true,
            case_sensitive: true,
            match_whole_words: true,
          },
        ],
      },
    },
  }
  const spec = lib.convertStToPreset(card, 'iso-card')
  const lore = spec.promptConfigs.filter((config) => config.strategy === 'world-book')
  assert.equal(lore.length, 1)
  const expected = lib.buildWorldBookEntry({
    id: lore[0].id,
    name: lore[0].name,
    text: lore[0].text,
    order: lore[0].order,
    enabled: lore[0].enabled,
    constant: lore[0].params.constant,
    keys: lore[0].params.keys,
    secondaryKeys: lore[0].params.secondaryKeys,
    caseSensitive: lore[0].params.caseSensitive,
    wholeWords: lore[0].params.wholeWords,
  })
  const { stWorldBook, stMacros, ...params } = lore[0].params
  const { role, ...withoutRole } = lore[0]
  assert.deepEqual({ ...withoutRole, params }, expected, '通用结构复用工厂，ST 专属语义在 params 中')
  assert.equal(stMacros, true)
  assert.equal(stWorldBook.scanDepth, 2)
  assert.equal(role, 'user')
})

test('convertStToPreset：marker 条目与 SPresetSettings 设置 dump 整体丢弃', () => {
  const card = {
    name: '标记卡',
    prompts: [
      { identifier: 'main', name: '主提示', marker: true, content: 'MARKER_PLACEHOLDER', role: 'system', enabled: true },
      { identifier: 'SPresetSettings', name: 'SPreset配置', content: '{"RegexBinding":{"regexes":[]}}', enabled: false },
      { identifier: 'e5f4a3b2-1111-2222-3333-444455556666', name: '真实提示', content: '你是助手。', role: 'system', enabled: true },
    ],
  }
  const spec = lib.convertStToPreset(card, 'marker-card')
  const ids = spec.promptConfigs.map((config) => config.id)
  assert.ok(!ids.includes('main'), 'marker: true 条目丢弃（ST 不发送其 content）')
  assert.ok(!ids.includes('SPresetSettings'), 'SPresetSettings 设置 dump 丢弃')
  assert.equal(spec.promptConfigs.length, 1, '仅保留真实提示词条目')
  assert.equal(spec.promptConfigs[0].text, '你是助手。')
  assert.deepEqual([...spec.meta.stDroppedMarkers].sort(), ['SPresetSettings', 'main'], '丢弃计数进 meta 审计')
  // 无丢弃时不写审计键
  const clean = lib.convertStToPreset({ name: '净卡', prompts: [] }, 'clean-card')
  assert.equal(clean.meta.stDroppedMarkers, undefined, '无丢弃不写审计键')
})

test('convertStToPreset：非 marker 的 main 同名条目保留（借名装真实提示词）', () => {
  const card = {
    name: '借名卡',
    prompts: [
      { identifier: 'main', name: '主提示', content: '你是助手。', role: 'system', enabled: true },
    ],
  }
  const spec = lib.convertStToPreset(card, 'borrowed-main')
  const main = spec.promptConfigs.find((config) => config.id === 'main')
  assert.ok(main, '非 marker 的 main 条目保留')
  assert.equal(main.text, '你是助手。')
  assert.equal(main.enabled, true)
})

// —— 端到端集成（原 st-integration-r14.test.mjs，2 条） ——
// T23：ST 转译完整性（R7–R14）的端到端集成。
//
// 合成夹具覆盖本轮接入的全部新形态（键宏、delayUntilRecursion、useGroupScoring、
// creator notes / depth prompt 扫描开关、characterFilter、automationId、
// prompts[].system_prompt、extensions.depth_prompt），走真实链路：
// 转换（convertStToPresetWithReport）→ pre-step 协调器注入 → 官方
// `@deepseek-ai/dsh-session` 持久化与重载。不使用 stub 加载器。
const ENGINE_DIR = new URL('../../engine/', import.meta.url).href
const signalOf = () => new AbortController().signal
let sessionCounter = 0

const userMessage = (text, id = `u-${text}`) => ({
  id,
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})

const messagesOf = (decision) => (Array.isArray(decision?.messages) ? decision.messages : [])

/** 宿主写入路径：本步承认的消息逐条成为持久事件。 */
const persist = (session, messages) => {
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  for (const message of messages) session.append('user/message', message, { surfaceOp: 'append' })
}

/** 官方持久化 → 重新加载 → 派生请求（任何非法角色都会在 Session.create 处抛错）。 */
const replay = (messages) => {
  const id = `r14-${++sessionCounter}`
  const live = Session.create(`${id}-live`)
  persist(live, messages)
  const seed = JSON.parse(JSON.stringify(live.snapshotEvents().map((event) => snapshotSessionEvent(event))))
  return Session.create(`${id}-restored`, seed).deriveMessages().map((message) => message.role)
}

/** 真实装配 + 真实 pre-step 派发，返回本步注入的插件来源 id。 */
async function inject(configs, texts) {
  const app = new Context()
  installPreStepCoordinator(app, { collectFiles: () => [] })
  const agent = { session: { id: `r14-${++sessionCounter}`, header: { delegationDepth: 0 }, snapshotEvents: () => [], deriveMessages: () => [] }, options: { model: 'pro' } }
  const scope = createScope(app, agent)
  agent.ctx = scope.ctx
  applyPromptConfigs(scope.ctx, createPromptConfigs(configs, { strategyDir: ENGINE_DIR }), { prepend: true, sourceId: 'r14:fixture' })
  const decision = await agentEvents(app, agent).waterfall(
    'agent/pre-step',
    { messages: texts.map((text) => userMessage(text)), turn: 1, step: 1, signal: signalOf() },
    async () => ({ kind: 'enter', messages: texts.map((text) => userMessage(text)) }),
  )
  const injected = messagesOf(decision)
  const result = { injected, plugins: injected.map((message) => message.source?.plugin) }
  await scope.dispose()
  return result
}

/** 合成夹具：覆盖 R7–R13 接入的全部字段形态。 */
const fixture = {
  name: 'R14 夹具',
  prompts: [
    { identifier: 'main', role: 'system', content: 'MAIN-SECTION', enabled: true, system_prompt: true },
    { identifier: 'aux', role: 'user', content: 'AUX-USER', enabled: true, system_prompt: true },
  ],
  data: {
    name: 'Ada',
    description: 'DESC',
    creator_notes: 'NOTES-ONLY',
    first_mes: 'GREETING',
    extensions: { depth_prompt: { prompt: 'DEEP-ONLY', depth: 4, role: 0 } },
    character_book: { entries: [
      { id: 25, keys: ['{{user}}'], content: 'USER-LORE', constant: false, selective: true, role: 1, extensions: {} },
      { id: 26, keys: ['DELAYED'], content: 'DELAYED-LORE', constant: true, role: 1, extensions: { delay_until_recursion: true } },
      { id: 27, keys: ['P'], content: 'SCORED-LORE', role: 1, extensions: { group: 'G', use_group_scoring: true } },
      { id: 28, keys: ['NOTES-ONLY'], content: 'NOTES-LORE', role: 1, extensions: { match_creator_notes: true } },
      { id: 29, keys: ['P'], content: 'FILTERED-LORE', role: 1, characterFilter: { names: ['Ada'], tags: [], isExclude: false } },
      { id: 30, keys: ['P'], content: 'AUTO-LORE', role: 1, automationId: 'auto-1' },
    ] },
  },
}

test('T23 合成夹具：转换 → 真实 pre-step 注入 → 官方会话重载', async () => {
  const { spec, report } = convertStToPresetWithReport(fixture, 'r14')
  const codes = new Set(report.diagnostics.map((item) => item.code))
  for (const code of ['st-key-macro', 'st-worldbook-character-filter', 'st-worldbook-automation', 'st-prompt-system-flag', 'st-depth-prompt']) {
    assert.equal(codes.has(code), true, `夹具必须覆盖诊断 ${code}`)
  }
  // R7/R13：变量登记与禁用配置在产物里。
  assert.equal(spec.variables.user, '')
  assert.equal(spec.variables.creator_notes, 'NOTES-ONLY')
  assert.equal(spec.variables.depth_prompt, 'DEEP-ONLY')
  assert.equal(spec.promptConfigs.find((config) => config.id === 'st-depth-prompt').enabled, false)

  const { injected } = await inject(spec.promptConfigs.map((config) => ({ ...config, variables: spec.variables })), ['P'])
  // merged 配置按位置合并成一条消息（source.plugin 为 `merged:<position>`），
  // 因此断言按注入正文核对，而不是按单个配置 id。
  const text = injected.flatMap((message) => message.content ?? []).map((block) => String(block.text ?? '')).join('\n')
  assert.doesNotMatch(text, /USER-LORE/, 'R7：未赋值的键宏条目不误触发')
  assert.doesNotMatch(text, /DELAYED-LORE/, 'R8：延迟到递归的条目在首个 pass 不注入')
  assert.doesNotMatch(text, /DEEP-ONLY/, 'R13：depth_prompt 禁用配置不注入')
  assert.doesNotMatch(text, /MAIN-SECTION/, 'system-section 不进 pre-step')
  assert.match(text, /NOTES-LORE/, 'R9：扫描开关按 creator notes 命中并注入')
  assert.match(text, /SCORED-LORE/, 'R8：组内评分不影响未开启评分的单成员组')
  assert.match(text, /FILTERED-LORE/, 'R10：角色过滤不被静默跳过（保留并照常注入）')
  assert.match(text, /AUTO-LORE/, 'R11：自动化条目保留并照常注入')
  assert.match(text, /AUX-USER/, 'R12：system_prompt 标记不改变层归属（role=user 仍在 pre-step）')
  assert.match(text, /GREETING/, '开场白照常注入')
  assert.ok(injected.every((message) => message.role === 'user'), 'pre-step 出口只发出 user')

  // 官方回放：注入批次可持久化 → 重新加载 → 派生请求，角色全部合法。
  assert.deepEqual(replay(injected), injected.map(() => 'user'))
})

test('T23 V0.66.png#25 形态：未赋值不触发 → 赋值后触发，且都能通过官方回放', async () => {
  const card = { data: { name: 'Ada', character_book: { entries: [
    { id: 25, keys: ['{{user}}'], content: 'USER-LORE', constant: false, selective: true, role: 1, extensions: {} },
  ] } } }
  const spec = convertStToPreset(card, 'v066')
  assert.equal(spec.variables.user, '')

  const unset = await inject(spec.promptConfigs.map((config) => ({ ...config, variables: spec.variables })), ['Alice'])
  assert.equal(unset.plugins.includes('lore-25'), false, '未赋值时该键不参与匹配')
  assert.deepEqual(replay(unset.injected), unset.injected.map(() => 'user'))

  const assigned = await inject(
    spec.promptConfigs.map((config) => ({ ...config, variables: { ...spec.variables, user: 'Alice' } })), ['Alice'])
  assert.equal(assigned.plugins.includes('lore-25'), true, '赋值后含该值的消息命中并注入')
  assert.deepEqual(replay(assigned.injected), assigned.injected.map(() => 'user'))
  const text = assigned.injected.filter((message) => message.source?.plugin === 'lore-25')
    .flatMap((message) => message.content).map((block) => block.text).join('')
  assert.equal(text, 'USER-LORE', '注入正文与卡片内容一致')
})
