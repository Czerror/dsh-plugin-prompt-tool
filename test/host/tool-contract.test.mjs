/**
 * 三个模型工具的「每一条 return 分支」× `output.schema` 覆盖回归。
 *
 * 依据（PLAN Wave 3 / T4）：官方插件教程实证（`tool-plugin-tutorial-draft.md:303`）——
 * `execute()` 返回不符合 `output.schema` 的值时，宿主把这次调用**归一化为错误**
 * （`INVALID_TOOL_OUTPUT`），而不是把无效数据交给模型。因此本文件经**真实
 * ToolRuntime 全流水线**（参数校验 → execute → lossless 快照 → output.schema 校验 → render）
 * 执行每条分支：
 *   - 有返回值的分支：必须 `isError === false`，且 `validateJsonSchemaValue(tool.output.schema, value)`
 *     零违规（宿主用的就是同一个校验函数与同一份编译后 schema）；
 *   - 工具自身 throw 的分支（没有返回值）：按设计归一化为错误，不参与 schema 断言。
 *
 * 分支清单（锚点行号 = 该 return 语句；三文件均为只读核对，本文件不改实现）：
 *   src/runtime/character-tools.ts:58-60  character_list       成功
 *   src/runtime/character-tools.ts:93    character_import     成功   ｜ :92  throw
 *   src/runtime/character-tools.ts:124   character_apply      成功   ｜ :122 throw
 *   src/runtime/character-tools.ts:154   character_remove     成功   ｜ :152 throw
 *   src/runtime/character-tools.ts:182   character_delete     成功   ｜ :181 throw
 *   src/runtime/world-book-tools.ts:109  world_book_list      成功
 *   src/runtime/world-book-tools.ts:157  world_book_upsert    成功
 *   src/runtime/world-book-tools.ts:185  world_book_delete    成功   ｜ :182 被调函数 throw（host/worldbook.ts:95）
 *   src/runtime/session-var-tools.ts:61/74/77/78/81/88/92/94   session_var 八分支
 *
 * 本回归建立时按 schema 断言抓到两条**真实缺陷**（先红后绿；修法已落在 src/runtime，
 * 本文件只做断言、不改实现，故此处记录修法以免后人重犯）：
 *   1. character_list 库非空：items 契约（character-tools.ts:39-54，additionalProperties:false）
 *      曾未声明 `hasAvatar`，而 listCharacterCards（host/characters.ts:495）无条件返回该字段
 *      → 整次调用被归一化为错误。修法：items.properties 补 `hasAvatar: { type: 'boolean', required: true }`。
 *   2. world_book_list 含无 keys 条目：曾显式产出 `keys: undefined`，宿主在 schema 校验前先做
 *      lossless JSON 快照 → 整次调用归一化为错误。修法：条件展开省略该属性
 *      （schema 里 keys 并非 required）。
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerHooks } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'

// session-var-tools 的 execute 用 `new URL('../engine/session-vars.mjs', import.meta.url)` 动态导入，
// 该相对路径只在构建产物布局（lib/ ↔ engine/）下成立；直连 src 时指向不存在的 src/engine/。
// 这里只把这一条请求重映射到仓库真实的 engine/ 目录——不改被检查的源码，也不复制其实现。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('/src/engine/session-vars.mjs')) {
      return { url: specifier.replace('/src/engine/', '/engine/'), shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

// 隔离 DSH_HOME 与预设根：工具经显式 host 参数访问磁盘，测试不在仓库目录落下任何文件。
const home = mkdtempSync(join(tmpdir(), 'pt-tool-contract-home-'))
process.env.DSH_HOME = home
const root = mkdtempSync(join(tmpdir(), 'pt-tool-contract-root-'))
const template = 'anchored'
const presetDir = join(root, template)
const presetFile = join(presetDir, 'preset.yml')
mkdirSync(presetDir, { recursive: true })
writeFileSync(presetFile, [
  'id: anchored',
  'name: 工具契约回归预设',
  'version: 1.0.0',
  'engineCompat: ">=0.4.2"',
  'modules: [prompt-config-engine]',
  'promptConfigs: []',
  '',
].join('\n'), 'utf8')

const { registerCharacterTools } = await import('../../src/runtime/character-tools.ts')
const { registerWorldBookTools } = await import('../../src/runtime/world-book-tools.ts')
const { registerSessionVarTools } = await import('../../src/runtime/session-var-tools.ts')

/** 与 test/engine/tool-config-engine.test.mjs 同一底座：真实 Context + SystemPrompt + ToolRuntime。 */
const ctx = new Context()
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)

/** host 闭包与 src/index.ts:543-571 的装配同形（presetRoot = 预设根，activeDir = 激活预设目录）。 */
registerCharacterTools(ctx, { presetRoot: () => root, templateName: () => template, rebuild: () => {} })
registerWorldBookTools(ctx, { activeDir: () => presetDir, presetRoot: () => root, rebuild: () => {} })
registerSessionVarTools(ctx)

/** ctx.inject(['tools'], …) 的回调不在同一 tick 内触发：有界自旋等到九个工具都可见，不用 sleep。 */
async function waitForRegistration() {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (ctx.tools.get('session_var') !== undefined && ctx.tools.get('character_delete') !== undefined) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error('三个工具模块未在预期时间内注册到 ctx.tools')
}
await waitForRegistration()

after(async () => {
  await ctx.fiber.dispose()
  rmSync(root, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

let callSeq = 0
/** 走真实注册表执行一次调用；session 缺省表示无 agent 上下文。 */
async function call(name, args, session) {
  return ctx.tools.execute({
    callId: `contract-${++callSeq}`,
    name,
    arguments: args,
    signal: new AbortController().signal,
    ...(session === undefined ? {} : { agent: { session } }),
  })
}

/** 成功分支口径：宿主没有把这次调用归一化为错误，且返回值对 output.schema 零违规。 */
function expectContracted(name, result) {
  const detail = result.isError ? ` — 宿主裁决：${result.error.message}` : ''
  assert.equal(result.isError, false, `${name} 被宿主归一化为错误（应返回符合 output.schema 的值）${detail}`)
  const violations = validateJsonSchemaValue(ctx.tools.get(name).output.schema, result.value, 'value')
  assert.deepEqual(violations, [], `${name} 返回值越过 output.schema：${violations.join('; ')}`)
  return result.value
}

/** throw 分支口径：工具自身抛错（无返回值），宿主按设计归一化为错误。 */
function expectThrowBranch(name, result, pattern) {
  assert.equal(result.isError, true, `${name} 应抛错并被宿主归一化为错误`)
  assert.match(result.error.message, pattern)
}

/** 角色卡 id 必须是 [a-z0-9][a-z0-9-]*（host/preset-install.ts:5-9）——用它触发工具的错误分支。 */
const INVALID_ID = 'Bad_Id'

const cardJson = JSON.stringify({
  spec: 'chara_card_v3',
  name: '回归角色',
  data: { name: '回归角色', description: '一位回归角色。', personality: '冷静。', first_mes: '你好。' },
})
/** 由 character_import 分支填充，供后续分支复用。 */
let cardId = ''

// ─────────────────────────── character_* ───────────────────────────

test('character_list:57-59 空库：返回 { characters: [] }', async () => {
  const value = expectContracted('character_list', await call('character_list', {}))
  assert.deepEqual(value, { characters: [] })
})

test('character_import:91 失败分支：内容非法时抛错（无返回值）', async () => {
  expectThrowBranch('character_import', await call('character_import', { name: '坏卡', content: '{ not json' }), /角色卡转换失败/)
})

test('character_import:92 成功分支：返回 { id, name }', async () => {
  const value = expectContracted('character_import', await call('character_import', { name: '回归角色', content: cardJson }))
  assert.equal(typeof value.id, 'string')
  assert.equal(typeof value.name, 'string')
  assert.match(value.id, /^[a-z0-9][a-z0-9-]*$/)
  cardId = value.id
})

test('character_list:57-59 非空库：每张卡都必须落在 items 契约内（曾红：hasAvatar 未声明，现由 schema 补声明修复）', async () => {
  const value = expectContracted('character_list', await call('character_list', {}))
  assert.equal(value.characters.length, 1)
  assert.equal(value.characters[0].id, cardId)
})

test('character_apply:121 失败分支：卡不存在时抛错（无返回值）', async () => {
  expectThrowBranch('character_apply', await call('character_apply', { id: 'no-such-card' }), /不存在或参数损坏/)
})

test('character_apply:123 成功分支：返回 { id, count }', async () => {
  const value = expectContracted('character_apply', await call('character_apply', { id: cardId }))
  assert.equal(value.id, cardId)
  assert.equal(Number.isInteger(value.count), true, 'count 必须是整数（schema: integer）')
})

test('world_book_list:102 空预设：返回 { entries: [] }', async () => {
  const value = expectContracted('world_book_list', await call('world_book_list', {}))
  assert.deepEqual(value, { entries: [] })
})

test('world_book_upsert:150 新增分支：自动 id + 返回 { id, count }', async () => {
  const value = expectContracted('world_book_upsert', await call('world_book_upsert', {
    name: '回归气味', content: '进门有雨味。', keys: ['雨'],
  }))
  assert.match(value.id, /^lore-/, '缺省 id 由工具生成')
  assert.equal(Number.isInteger(value.count), true)
})

test('world_book_list:102 全部条目带 keys：keys/enabled/constant 均落在契约内', async () => {
  const value = expectContracted('world_book_list', await call('world_book_list', {}))
  const entry = value.entries.find((item) => item.keys !== undefined)
  assert.ok(entry, '上一用例写入的带 keys 条目应可见')
  assert.equal(entry.enabled, true)
  assert.equal(entry.constant, false)
  assert.deepEqual(entry.keys, ['雨'])
})

test('world_book_upsert:150 更新分支：指定 id + note 写卡记忆，返回 { id, count }', async () => {
  const id = `chara-${cardId}-note`
  const value = expectContracted('world_book_upsert', await call('world_book_upsert', {
    id, name: '回归卡条目', content: '卡条目正文', note: '回归笔记',
  }))
  assert.equal(value.id, id)
  assert.equal(Number.isInteger(value.count), true)
})

test('world_book_upsert:150 → world_book_list:102 含无 keys 条目（曾红：keys: undefined 破坏 lossless 快照，现由条件展开修复）', async () => {
  expectContracted('world_book_upsert', await call('world_book_upsert', {
    name: '回归常驻', content: '常驻正文', constant: true,
  }))
  const value = expectContracted('world_book_list', await call('world_book_list', {}))
  assert.ok(value.entries.length >= 2)
})

test('[边界] world_book_list:102 keys 非字符串（越界输入，须手改 preset.yml）：宿主拒绝整次调用', async () => {
  // 三个工具与工作台的 keys 写入侧都是 string（world-book-tools.ts:123、client/prompt-config-policy.ts:157），
  // 只有手改存储能造出该输入；此处记录「越界输入必被宿主拒绝」，实现若改为 String() 归一，本断言应改回 expectContracted。
  writeFileSync(presetFile, readFileSync(presetFile, 'utf8').replace(/promptConfigs:[\s\S]*$/, [
    'promptConfigs:',
    '  - id: numeric-keys',
    '    name: 数字键条目',
    '    strategy: world-book',
    '    layer: pre-step',
    '    order: 1',
    '    text: 正文',
    '    params:',
    '      constant: false',
    '      keys: [1, 2]',
    '',
  ].join('\n')), 'utf8')
  const result = await call('world_book_list', {})
  assert.equal(result.isError, true)
  assert.match(result.error.message, /keys\[0\]" must be a string/)
})

test('world_book_delete:178 成功分支：返回 { id, count }', async () => {
  const id = 'lore-delete-me'
  expectContracted('world_book_upsert', await call('world_book_upsert', { id, name: '待删条目', content: '待删正文', keys: ['删'] }))
  const value = expectContracted('world_book_delete', await call('world_book_delete', { id }))
  assert.equal(value.id, id)
  assert.equal(Number.isInteger(value.count), true)
})

test('world_book_delete:178 失败路径（条目不存在的 throw，无 return）', async () => {
  expectThrowBranch('world_book_delete', await call('world_book_delete', { id: 'no-such-entry' }), /不存在/)
})

test('character_remove:151 失败分支：非法 id 时抛错（无返回值）', async () => {
  expectThrowBranch('character_remove', await call('character_remove', { id: INVALID_ID }), /非法角色卡 id/)
})

test('character_remove:153 成功分支：返回 { id, count }（含未导入卡 count=0 的变体）', async () => {
  const removed = expectContracted('character_remove', await call('character_remove', { id: cardId }))
  assert.equal(removed.id, cardId)
  assert.equal(Number.isInteger(removed.count), true)
  const again = expectContracted('character_remove', await call('character_remove', { id: cardId }))
  assert.equal(again.count, 0, '已移除的卡再次移除是 no-op，仍须合规')
})

test('character_delete:180 失败分支：非法 id 时抛错（无返回值）', async () => {
  expectThrowBranch('character_delete', await call('character_delete', { id: INVALID_ID }), /非法角色卡 id/)
})

test('character_delete:181 成功分支：返回 { id }', async () => {
  const value = expectContracted('character_delete', await call('character_delete', { id: cardId }))
  assert.deepEqual(value, { id: cardId })
})

// ─────────────────────────── session_var ───────────────────────────

/** session_var 的变量挂在 session 对象上；同一 session 共享给相邻分支用例。 */
const session = {}

test('session_var:61 无 agent 上下文：返回 { ok: false, error }', async () => {
  const value = expectContracted('session_var', await call('session_var', { action: 'list' }))
  assert.deepEqual(value, { ok: false, error: 'no active session' })
})

test('session_var:74 list：返回 { ok: true, variables }', async () => {
  const empty = expectContracted('session_var', await call('session_var', { action: 'list' }, session))
  assert.equal(empty.ok, true)
  assert.equal(typeof empty.variables, 'object')
  await call('session_var', { action: 'set', key: '心情', value: '好' }, session)
  const filled = expectContracted('session_var', await call('session_var', { action: 'list' }, session))
  assert.deepEqual(filled.variables, { 心情: '好' })
})

test('session_var:77 get 缺 key：返回 { ok: false, error }', async () => {
  const value = expectContracted('session_var', await call('session_var', { action: 'get' }, session))
  assert.equal(value.ok, false)
  assert.match(value.error, /get 需要 key/)
})

test('session_var:78 get：未设置返回空串，命中返回值', async () => {
  const missing = expectContracted('session_var', await call('session_var', { action: 'get', key: '未设置' }, session))
  assert.deepEqual(missing, { ok: true, key: '未设置', value: '' })
  const hit = expectContracted('session_var', await call('session_var', { action: 'get', key: '心情' }, session))
  assert.deepEqual(hit, { ok: true, key: '心情', value: '好' })
})

test('session_var:81 set 缺 key：返回 { ok: false, error }', async () => {
  const value = expectContracted('session_var', await call('session_var', { action: 'set' }, session))
  assert.equal(value.ok, false)
  assert.match(value.error, /set 需要 key/)
})

test('session_var:88 set：设值分支与空值清除分支都返回 { ok: true, key, value }', async () => {
  const set = expectContracted('session_var', await call('session_var', { action: 'set', key: '状态', value: '警觉' }, session))
  assert.deepEqual(set, { ok: true, key: '状态', value: '警觉' })
  const cleared = expectContracted('session_var', await call('session_var', { action: 'set', key: '状态', value: '' }, session))
  assert.deepEqual(cleared, { ok: true, key: '状态', value: '' })
})

test('session_var:92 clear：单键与全部两个变体都返回 { ok: true, key }', async () => {
  await call('session_var', { action: 'set', key: '临时', value: 'x' }, session)
  const one = expectContracted('session_var', await call('session_var', { action: 'clear', key: '临时' }, session))
  assert.deepEqual(one, { ok: true, key: '临时' })
  const all = expectContracted('session_var', await call('session_var', { action: 'clear' }, session))
  assert.deepEqual(all, { ok: true, key: '' })
})

test('session_var:94 未知 action：参数枚举先拒（该 return 在实现内不可达），其字面形状仍合契约', async () => {
  const result = await call('session_var', { action: 'nope' }, session)
  assert.equal(result.isError, true)
  assert.match(result.error.message, /"action" must be one of/)
  // 该分支只能由绕过 defineTool 参数校验的调用到达；此处校验它的字面返回值形态本身不越界。
  const violations = validateJsonSchemaValue(ctx.tools.get('session_var').output.schema, { ok: false, error: '未知 action: nope' }, 'value')
  assert.deepEqual(violations, [])
})

// ─────────────────────────── 负例（回归非空转） ───────────────────────────

test('负例：故意构造的越界返回值必被宿主归一化为错误，且本文件的判定口径能抓到它', async () => {
  // 用真实工具的编译后 schema + 越界值直接判定（证明校验口径不是空转）。
  const real = ctx.tools.get('character_delete')
  const violations = validateJsonSchemaValue(real.output.schema, { id: 42 }, 'value')
  assert.ok(violations.length > 0, '整数 id 必须被 output.schema 判为越界')

  // 同 schema、故意返回越界值的定义注册进真实注册表：宿主必须把调用归一化为错误。
  ctx.tools.register({ ...real, name: 'contract_mutant', execute: async () => ({ id: 42 }) })
  const result = await call('contract_mutant', { id: 'whatever' })
  assert.equal(result.isError, true)
  assert.match(result.error.message, /returned invalid output/)

  // 全文件共用的判定口径对该越界返回必须报红——否则前面每条分支的断言都没有意义。
  assert.throws(() => expectContracted('contract_mutant', result), /被宿主归一化为错误|越过 output\.schema/)
})
