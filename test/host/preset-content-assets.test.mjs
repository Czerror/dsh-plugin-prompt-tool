// 合并自 worldbook.test.mjs(6) + custom-tools.test.mjs(7)
//（2026-09-17 测试归一精简 Wave 2）。两者都要求「先设隔离 DSH_HOME 再加载被测模块」：
// worldbook 走 lib 入口，custom-tools 直接验证 src/host/write-preset.ts 与 engine 源码
//（原注释：不依赖 lib/ 或 build），合并后两类 import 都保留在这一处。
// 原 worldbook 缺 after 清理，这里统一登记还原与清理（不改变任何断言）。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml, parseDocument } from 'yaml'
import { compileCustomTool, validateCustomTools } from '../../src/host/custom-tools.ts'
import { validateDefinition, validateJsonSchemaNode } from '../../engine/tool-definition.mjs'

// 隔离 DSH_HOME：writer 的路径常量在 import 时求值，必须先设 env 再加载被测模块。
const home = mkdtempSync(join(tmpdir(), 'pt-content-assets-home-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = home
after(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})
const { buildWorldBookEntry, deleteWorldBookEntry, listWorldBookEntries, upsertWorldBookEntry } = await import('../../lib/index.mjs')
const { writePreset } = await import('../../src/host/write-preset.ts')
const { apply } = await import('../../engine/tool-config-engine.mjs')

// —— 世界书条目（原 worldbook.test.mjs） ——

const dir = mkdtempSync(join(tmpdir(), 'pt-wb-preset-'))
writeFileSync(join(dir, 'preset.yml'), [
  'id: wb-test',
  'name: 世界书测试',
  'version: 1.0.0',
  'engineCompat: ">=0.4.2"',
  'promptConfigs:',
  '  - id: static-one',
  '    name: 普通配置',
  '    strategy: static',
  '    order: 1',
  '    text: 普通',
  '  - id: lore-1',
  '    name: 已有条目',
  '    strategy: world-book',
  '    order: -100',
  '    text: 旧内容',
  '    params:',
  '      constant: true',
  '',
].join('\n'), 'utf8')

test('worldbook list：只返回 world-book 策略配置', () => {
  const entries = listWorldBookEntries(dir)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].id, 'lore-1')
})

test('buildWorldBookEntry 结构工厂：固定字段与 params 键集单一权威', () => {
  const entry = buildWorldBookEntry({
    id: 'lore-x',
    name: '气味描写',
    text: '空气中弥漫着…',
    constant: false,
    keys: ['气味', 'smell'],
    secondaryKeys: ['香水'],
    caseSensitive: true,
    wholeWords: true,
    selectiveLogic: 1,
  })
  assert.equal(entry.strategy, 'world-book')
  assert.equal(entry.layer, 'pre-step')
  assert.equal(entry.position, 'before-all')
  assert.equal(entry.order, 100, 'order 缺省 100')
  assert.deepEqual(entry.params, {
    constant: false,
    keys: ['气味', 'smell'],
    secondaryKeys: ['香水'],
    caseSensitive: true,
    wholeWords: true,
    selectiveLogic: 1,
  })
  // 空列表/缺省不写键（与 ST/工具通道历史产物一致）。
  const minimal = buildWorldBookEntry({ id: 'lore-y', name: '全局', text: 't', constant: true })
  assert.deepEqual(minimal.params, { constant: true })
  assert.equal(minimal.enabled, undefined, 'enabled 缺省不写')
})

test('buildWorldBookEntry 两通道同构：模型工具参数形态 = 工厂直接构造', () => {
  const viaTool = buildWorldBookEntry({
    id: 'lore-a',
    name: '条目',
    text: '内容',
    constant: true,
    keys: ['k1'],
  })
  assert.equal(viaTool.enabled, undefined)
  assert.deepEqual(viaTool.params, { constant: true, keys: ['k1'] })
  // 工具 enabled=false 显式关闭。
  const disabled = buildWorldBookEntry({ id: 'lore-b', name: 'n', text: 't', constant: false, enabled: false })
  assert.equal(disabled.enabled, false)
})

test('worldbook upsert：新增与更新（按 id），count 只统计世界书条目', () => {
  const added = upsertWorldBookEntry(dir, {
    id: 'lore-new',
    name: '新条目',
    strategy: 'world-book',
    order: -50,
    text: '新内容',
    layer: 'pre-step',
    position: 'before-all',
    params: { keys: ['新词'] },
  })
  assert.equal(added, 2, '新增后世界书条目数 = 2')

  const updated = upsertWorldBookEntry(dir, {
    id: 'lore-1',
    name: '已有条目',
    strategy: 'world-book',
    order: -200,
    text: '更新内容',
    params: { constant: true },
  })
  assert.equal(updated, 2, '更新不新增')

  const preset = parseYaml(readFileSync(join(dir, 'preset.yml'), 'utf8'))
  const lore1 = preset.promptConfigs.find((config) => config.id === 'lore-1')
  assert.equal(lore1.text, '更新内容')
  assert.equal(lore1.order, -200)
  assert.equal(preset.promptConfigs.length, 3, '普通配置保留')
})

test('worldbook upsert：缺 id 抛 TypeError', () => {
  assert.throws(
    () => upsertWorldBookEntry(dir, { name: '无 id', strategy: 'world-book' }),
    /非空字符串 id/,
  )
})

test('worldbook delete：删除并计数；不存在抛错', () => {
  const after = deleteWorldBookEntry(dir, 'lore-new')
  assert.equal(after, 1)
  assert.throws(() => deleteWorldBookEntry(dir, 'lore-new'), /不存在/)
  const entries = listWorldBookEntries(dir)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].id, 'lore-1')
})

// —— 自定义工具定义（原 custom-tools.test.mjs） ——

const validTool = (patch = {}) => ({
  id: 'custom_tool', description: '自定义工具',
  output: { schema: { type: 'object', additionalProperties: true } },
  execute: { kind: 'ask-user', question: '是否继续？' },
  ...patch,
})

test('compileCustomTool：官方 DSL 物化、身份缺省和输入不变', () => {
  const tool = validTool({
    id: ' custom_tool ', name: '  ', enabled: false,
    parameters: {
      payload: { type: 'json', required: true, description: '任意 JSON' },
      choice: { oneOf: [{ type: 'string' }, { type: 'number' }] },
      nested: {
        type: 'object', additionalProperties: false,
        properties: { values: { type: 'array', items: { type: 'json' }, required: true } },
      },
    },
    output: { schema: { type: 'json' }, label: '保留未知字段' },
    extra: { unchanged: true },
  })
  const snapshot = structuredClone(tool)
  const compiled = compileCustomTool(tool)
  assert.equal(compiled.id, 'custom_tool')
  assert.equal(compiled.name, 'custom_tool')
  assert.equal(compiled.enabled, false)
  assert.deepEqual(compiled.parameters, {
    type: 'object',
    properties: {
      payload: { description: '任意 JSON' },
      choice: { oneOf: [{ type: 'string' }, { type: 'number' }] },
      nested: { type: 'object', additionalProperties: false, properties: { values: { type: 'array', items: {} } }, required: ['values'] },
    },
    required: ['payload'],
  })
  assert.deepEqual(compiled.output, { schema: {}, label: '保留未知字段' })
  assert.deepEqual(compiled.extra, snapshot.extra)
  assert.doesNotThrow(() => validateDefinition(compiled))
  assert.deepEqual(validateCustomTools([tool]), [])
  assert.deepEqual(tool, snapshot)
  for (const name of [undefined, '', '  ']) {
    assert.equal(compileCustomTool(validTool({ name })).name, 'custom_tool')
  }
  assert.equal(compileCustomTool(validTool({ name: ' other_name ' })).name, 'other_name')
  assert.equal(compileCustomTool(validTool()).parameters, undefined)
  assert.equal(compileCustomTool(validTool()).enabled, undefined)
})

test('validateCustomTools：身份优先，重复包含停用工具且与 name 缺省一致', () => {
  const tools = [validTool({ enabled: false }), validTool({ id: ' custom_tool ', output: undefined })]
  const before = structuredClone(tools)
  const errors = validateCustomTools(tools)
  assert.equal(errors.length, 2)
  assert.ok(errors.every((error) => /customTools\[1\]\.(id|name).*customTools\[0\]/.test(error)))
  assert.deepEqual(tools, before)
  assert.match(validateCustomTools([validTool(), validTool({ id: 'other', name: 'custom_tool' })])[0], /\.name.*重复/)
  assert.deepEqual(validateCustomTools([]), [])
  assert.equal(validateCustomTools([null, [], 42, {}]).length, 4)
})

test('compileCustomTool / validateCustomTools：坏执行定义、Schema 与文件身份在写盘前拒绝', () => {
  const cases = [
    [{ id: undefined, name: 'has_name' }, /id/],
    [{ id: '   ' }, /id/],
    [{ id: 42 }, /id/],
    [{ id: '../escape', name: 'valid_name' }, /id.*path separators/],
    [{ name: 'Bad Name' }, /name/],
    [{ name: null }, /name/],
    [{ name: 1 }, /name/],
    [{ description: '' }, /description/],
    [{ description: ' \n ' }, /description/],
    [{ enabled: 'false' }, /enabled/],
    [{ enabled: 0 }, /enabled/],
    [{ scope: 'both' }, /scope/],
    [{ execute: undefined }, /execute/],
    [{ execute: [] }, /execute/],
    [{ execute: { kind: 'unknown' } }, /execute\.kind/],
    [{ execute: { kind: 'shell' } }, /execute\.command/],
    [{ execute: { kind: 'shell', command: ' ' } }, /execute\.command/],
    [{ execute: { kind: 'http' } }, /execute\.url/],
    [{ execute: { kind: 'delegate' } }, /execute\.tool/],
    [{ execute: { kind: 'fs', action: 'move' } }, /execute\.action/],
    [{ enabled: false, execute: { kind: 'fs' } }, /execute\.action/],
    [{ parameters: [] }, /parameters/],
    [{ parameters: { type: 'object', properties: {} } }, /parameters/],
    [{ parameters: { arg: { type: 'string', required: 'true' } } }, /parameters.*required/],
    [{ parameters: { arg: { type: 'string', pattern: '.*' } } }, /parameters.*pattern/],
    [{ parameters: { arg: { type: 'string', enum: 1 } } }, /parameters.*enum/],
    [{ output: undefined }, /output\.schema/],
    [{ output: {} }, /output\.schema/],
    [{ output: { schema: { type: 'object', properties: {} } } }, /output\.schema.*additionalProperties/],
    [{ output: { schema: { oneOf: [{ type: 'string' }] } } }, /output\.schema.*oneOf/],
  ]
  for (const [patch, expected] of cases) {
    const tool = validTool(patch)
    const before = structuredClone(tool)
    assert.throws(() => compileCustomTool(tool), expected)
    const errors = validateCustomTools([tool])
    assert.equal(errors.length, 1)
    assert.match(errors[0], /customTools\[0\]/)
    assert.match(errors[0], expected)
    assert.deepEqual(tool, before)
  }
  const errors = validateCustomTools([
    validTool({ id: 'one', execute: { kind: 'http' } }),
    validTool({ id: 'two', description: '' }),
  ])
  assert.equal(errors.length, 2, '完整编译所有身份合法的条目，而不是遇首错就返回')
  assert.match(errors[0], /customTools\[0\].*execute\.url/)
  assert.match(errors[1], /customTools\[1\].*description/)
})

test('compileCustomTool：五种现有执行器和 fs 动态 action 保持可用', () => {
  for (const execute of [
    { kind: 'shell', command: 'Write-Output test' },
    { kind: 'http', url: 'https://example.invalid/{{args.path}}' },
    { kind: 'delegate', tool: 'existing_tool', args: { value: '{{args.value}}' } },
    ...['read', 'write', 'append', 'list', 'delete', '{{args.action}}'].map((action) => ({ kind: 'fs', action, path: '{{args.path}}' })),
    { kind: 'ask-user' },
  ]) {
    const tool = validTool({ execute })
    assert.deepEqual(compileCustomTool(tool).execute, execute)
    assert.deepEqual(validateCustomTools([tool]), [])
  }
})

test('执行字段类型、正整数超时和单定义大小在保存期拒绝，合法边界不改写', () => {
  for (const timeoutMs of [null, 0, -1, 1.5, '1000', Infinity, 2_147_483_648]) {
    assert.throws(() => compileCustomTool(validTool({ timeoutMs })), /timeoutMs/)
  }
  for (const execute of [
    { kind: 'shell', command: 'echo', shell: 42 },
    { kind: 'shell', command: 'echo', shell: '' },
    { kind: 'shell', command: 'echo', env: [] },
    { kind: 'shell', command: 'echo', env: { VALUE: 42 } },
    { kind: 'http', url: 'https://example.invalid', method: [] },
    { kind: 'http', url: 'https://example.invalid', method: 'BAD METHOD' },
    { kind: 'http', url: 'https://example.invalid', headers: { Accept: false } },
    { kind: 'http', url: 'https://example.invalid', headers: { 'bad\nname': 'value' } },
    { kind: 'delegate', tool: 'existing', args: [] },
    { kind: 'fs', action: 'read', path: 42 },
    { kind: 'fs', action: 'read' },
    { kind: 'fs', action: 'write', path: 'note.txt', content: {} },
    { kind: 'ask-user', question: false },
  ]) {
    const value = validTool({ execute })
    const before = structuredClone(value)
    assert.throws(() => compileCustomTool(value), /execute\./)
    assert.equal(validateCustomTools([value]).length, 1)
    assert.deepEqual(value, before)
  }
  assert.throws(() => compileCustomTool(validTool({ execute: { kind: 'ask-user', question: '中'.repeat(350_000) } })), /1048576.*bytes/)
  for (const execute of [
    { kind: 'shell', command: 'echo {{args.text}}', shell: 'D:/custom/pwsh.exe', env: { LANG: 'zh_CN.UTF-8' } },
    { kind: 'http', url: '{{args.url}}', method: 'post', headers: { 'X-Value': '{{args.value}}' }, body: { values: [1, true, null] } },
    { kind: 'delegate', tool: 'world_book_upsert', args: { keys: '{{args.keys}}', constant: true } },
    { kind: 'fs', action: '{{args.action}}', path: '{{args.path}}', content: '{{args.text}}' },
    { kind: 'fs', action: 'write', path: 'empty.txt', content: '' },
    { kind: 'ask-user', question: '' },
  ]) {
    const value = validTool({ execute, timeoutMs: 2_147_483_647 })
    assert.deepEqual(compileCustomTool(value).execute, execute)
    assert.deepEqual(validateCustomTools([value]), [])
  }
})

test('共享 Schema 校验：循环拒绝，annotation-only 与 oneOf 的合法子节点接受', () => {
  const node = { type: 'array' }
  node.items = node
  assert.throws(() => validateJsonSchemaNode(node, 'parameters'), /parameters\.items is circular/)
  assert.throws(() => compileCustomTool(validTool({ parameters: { value: node } })), /parameters.*circular/)
  assert.doesNotThrow(() => validateJsonSchemaNode({ oneOf: [{ type: 'null' }, { description: '任意 JSON' }] }, 'output.schema'))
  assert.throws(() => validateJsonSchemaNode({ type: '' }, 'output.schema'), /output\.schema\.type/)
  assert.throws(() => validateJsonSchemaNode({ value: { type: 'string' } }, 'parameters'), /must declare type or oneOf/)
})

test('writePreset：完整编译同源、坏手写定义 warn-and-skip、原始 DSL 保留并可运行', () => {
  const presetDir = join(home, '.agent-presets')
  const dir = join(presetDir, 'custom-tools-test')
  mkdirSync(dir, { recursive: true })
  const tools = [
    validTool({ id: ' fallback_tool ', output: { schema: { type: 'json' } } }),
    validTool({ id: 'empty_name', name: '' }),
    validTool({ id: 'explicit_name', name: ' named_tool ' }),
    validTool({ id: 'disabled_tool', enabled: false }),
    validTool({ id: 'bad_shell', execute: { kind: 'shell' } }),
    validTool({ id: 'bad_schema', output: { schema: { type: 'unknown' } } }),
  ]
  const file = join(dir, 'preset.yml')
  const doc = parseDocument('# 保留手写预设\nname: 测试工具\nmodules: []\n')
  doc.setIn(['customTools'], tools)
  writeFileSync(file, doc.toString(), 'utf8')
  const warns = []
  writePreset('', { presetDir, presetTemplate: 'custom-tools-test', presetOrder: 5, promptConfigs: [], warn: (message) => warns.push(message) })
  assert.equal(warns.length, 2)
  assert.match(warns[0], /bad_shell.*execute\.command.*skipped/)
  assert.match(warns[1], /bad_schema.*output\.schema.*skipped/)
  const source = readFileSync(file, 'utf8')
  assert.match(source, /# 保留手写预设/)
  assert.deepEqual(parseYaml(source).customTools, tools)
  const generatedDir = join(dir, 'custom-tools')
  const files = readdirSync(generatedDir).sort()
  assert.deepEqual(files, ['0001-fallback_tool.yml', '0002-empty_name.yml', '0003-explicit_name.yml', '0004-disabled_tool.yml'])
  for (const [index, file] of files.entries()) {
    assert.deepEqual(parseYaml(readFileSync(join(generatedDir, file), 'utf8')), compileCustomTool(tools[index]))
  }
  const registered = []
  const disposed = []
  const effects = []
  const runtimeWarns = []
  apply({
    tools: { register: (tool) => { registered.push(tool); return () => disposed.push(tool.name) } },
    effect: (fn) => effects.push(fn()),
    logger: { info: () => {}, warn: (message) => runtimeWarns.push(message) },
  }, { configsDir: generatedDir })
  assert.deepEqual(runtimeWarns, [])
  assert.deepEqual(registered.map((tool) => tool.name), ['fallback_tool', 'empty_name', 'named_tool'])
  for (const dispose of effects) dispose()
  assert.deepEqual(disposed, registered.map((tool) => tool.name))
})
