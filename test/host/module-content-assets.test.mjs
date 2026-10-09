// 合并自 worldbook.test.mjs(6) + custom-tools.test.mjs(7)
//（2026-09-17 测试归一精简 Wave 2）。两者都要求「先设隔离 DSH_HOME 再加载被测模块」：
// worldbook 走 lib 入口，custom-tools 直接验证 src/host/write-module.ts 与 engine 源码
//（原注释：不依赖 lib/ 或 build），合并后两类 import 都保留在这一处。
// 原 worldbook 缺 after 清理，这里统一登记还原与清理（不改变任何断言）。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml, parseDocument } from 'yaml'
import { compileCustomTool, validateCustomTools } from '../../src/host/custom-tools.ts'
import { validateDefinition } from '../../engine/tool-definition.mjs'

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
const { writeModule } = await import('../../src/host/write-module.ts')
const { apply } = await import('../../engine/tool-config-engine.mjs')

// —— 世界书条目（原 worldbook.test.mjs） ——

const dir = join(home, 'modules', 'wb-test')
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'module.yml'), JSON.stringify({ id: 'wb-test', name: '世界书测试', modules: [], rules: [
  { id: 'static-one', name: '普通配置', then: [{ id: 'inject', kind: 'inject-text', config: { id: 'static-one', strategy: 'static', order: 1, text: '普通' } }] },
  { id: 'lore-1', name: '已有条目', then: [{ id: 'inject', kind: 'inject-text', config: { id: 'lore-1', strategy: 'world-book', order: -100, text: '旧内容', params: { constant: true } } }] },
] }), 'utf8')

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

  const preset = parseYaml(readFileSync(join(dir, 'module.yml'), 'utf8'))
  const lore1 = preset.rules.find((rule) => rule.id === 'lore-1').then[0].config
  assert.equal(lore1.text, '更新内容')
  assert.equal(lore1.order, -200)
  assert.equal(preset.rules.length, 3, '普通配置保留')
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

test('writeModule：坏工具完整拒绝无写，合法 DSL 保留并由内联入口执行和释放', async () => {
  const moduleDir = join(home, '.prompt-tool', 'modules')
  const dir = join(moduleDir, 'custom-tools-test')
  mkdirSync(dir, { recursive: true })
  const tools = [
    validTool({ id: ' fallback_tool ', output: { schema: { type: 'json' } } }),
    validTool({ id: 'empty_name', name: '' }),
    validTool({ id: 'explicit_name', name: ' named_tool ' }),
    validTool({ id: 'disabled_tool', enabled: false }),
    validTool({ id: 'bad_shell', execute: { kind: 'shell' } }),
    validTool({ id: 'bad_schema', output: { schema: { type: 'unknown' } } }),
  ]
  const file = join(dir, 'module.yml')
  const doc = parseDocument('# 保留手写预设\nname: 测试工具\nmodules: []\n')
  doc.setIn(['customTools'], tools)
  writeFileSync(file, doc.toString(), 'utf8')
  const before = readFileSync(file, 'utf8')
  assert.throws(() => writeModule('', { modulesRoot: moduleDir, moduleId: 'custom-tools-test' }), /invalid customTools/)
  assert.equal(readFileSync(file, 'utf8'), before)
  assert.equal(existsSync(join(dir, 'rules')), false)
  doc.setIn(['customTools'], tools.slice(0, 4))
  writeFileSync(file, doc.toString(), 'utf8')
  writeModule('', { modulesRoot: moduleDir, moduleId: 'custom-tools-test' })
  const source = readFileSync(file, 'utf8')
  assert.match(source, /# 保留手写预设/)
  assert.deepEqual(parseYaml(source).customTools, tools.slice(0, 4))
  const generatedDir = join(dir, 'custom-tools')
  assert.equal(existsSync(generatedDir), false)
  const registered = []
  const disposed = []
  const effects = []
  const runtimeWarns = []
  apply({
    tools: { register: (tool) => { registered.push(tool); return () => disposed.push(tool.name) } },
    effect: (fn) => effects.push(fn()),
    logger: { info: () => {}, warn: (message) => runtimeWarns.push(message) },
    get: name => name === 'approval' ? { request: async () => 'allowed-once' } : undefined,
  }, { tools: tools.slice(0, 4).map(compileCustomTool), configsDir: generatedDir })
  assert.deepEqual(runtimeWarns, [])
  assert.deepEqual(registered.map((tool) => tool.name), ['fallback_tool', 'empty_name', 'named_tool'])
  assert.deepEqual(await registered[0].execute({}, { agent: { id: 'test' }, signal: new AbortController().signal }), { ok: true, answer: 'allowed-once' })
  for (const dispose of effects) dispose()
  assert.deepEqual(disposed, registered.map((tool) => tool.name))
})
