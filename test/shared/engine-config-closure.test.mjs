/**
 * B6 T1 验收：**参数桥的转换规则闭合成引擎的有效配置**。
 *
 * 背景：`src/shared/engine-params.ts` 的 71 键参数目录经 `buildEngineModuleParams`
 * 转换成各引擎模块的行配置。既有守卫（`engine-param-schema.test.mjs:117-132`）用**源码
 * 解析 `ALLOWED_KEYS`** 检查了 7 个手写白名单的模块，但 B2 把另外几个模块迁到了
 * `defineConfig`（导出 `configContract`）——那批**完全没有守卫**，本文件补这一半。
 *
 * 关键立场（R9）：**不要求两侧原值相等**。`ENGINE_PARAM_DEFINITIONS` 的 `defaultValue`
 * 是**编辑草稿**，与引擎运行缺省分工不同（草稿 `contextGateEnabled: true` 而引擎缺省
 * `false`；草稿 `bootstrapMaxTokens: 0` 经参数桥转成**删键** `undefined`）。所以这里断言的是
 * 「**转换产出**能被引擎接受」这条闭合性，而不是「两边的值一样」。
 *
 * **实际配置 = 组合源的 `config:` + 参数桥的覆盖**（不是参数桥产出单独成配置）。
 * 这条由首次运行打红纠正：`tool-git-bash` 的 `timeoutMs` / `maxOutputBytes` 是
 * `int({ required: true })`，只由 `tool-git-bash.yml:12-15` 的 `config:` 提供，
 * 参数桥只覆盖 `enabled` 一格。缺了前半句，守卫会误报「不相容」。
 *
 * R7 范围限定：本支只对**当下存在的**声明集负责。7 个待删模块尚无字段声明，它们的闭合
 * 随 B7 交付；因此「模块没有声明」与「声明与产出不一致」必须是**两类可区分的失败**，
 * 否则 B7 迁移时会被同一盏红灯掩盖。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { ENGINE_PARAM_DEFINITIONS, ENGINE_PARAM_KEYS, buildEngineModuleParams } from '../../src/shared/engine-params.ts'

const engineDir = new URL('../../engine/', import.meta.url)
const compositionDir = new URL('../../engine/compositions/source/local/', import.meta.url)
const readEngine = (module) => readFileSync(new URL(`${module}.mjs`, engineDir), 'utf8')

/** engine/ 下的模块清单（只取顶层 .mjs，排除子目录与 vendor）。 */
const engineModules = readdirSync(engineDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
  .map((entry) => entry.name.replace(/\.mjs$/, ''))

/** 有 module 绑定的参数键：只有这些会经参数桥变成行配置，闭合校验的对象就是它们。 */
const boundKeys = ENGINE_PARAM_KEYS.filter((key) => ENGINE_PARAM_DEFINITIONS[key].module !== undefined)

/** 每个 module 绑定参数涉及的 row 集合（排序后便于断言）。 */
const boundRows = [...new Set(boundKeys.map((key) => ENGINE_PARAM_DEFINITIONS[key].module.row))].sort()

/** 模块的声明类型：configContract（B2 迁移）／手写 ALLOWED_KEYS（未迁移）／两者皆无。 */
function declarationOf(module) {
  const source = readEngine(module)
  if (/export const configContract = defineConfig\(/.test(source)) return 'contract'
  if (/const ALLOWED_KEYS = new Set\(\[/.test(source)) return 'allowedKeys'
  return undefined
}

/** 手写白名单的键集（未迁移模块只有这一份可读的声明）。 */
function allowedKeysOf(module) {
  const block = readEngine(module).match(/const ALLOWED_KEYS = new Set\(\[([\s\S]*?)\]\)/)?.[1]
  assert.ok(block !== undefined, `${module}: 应有 ALLOWED_KEYS`)
  const keys = [...block.matchAll(/'([^']+)'/g)].map((match) => match[1])
  assert.ok(keys.length > 0, `${module}: ALLOWED_KEYS 解析结果不得为空（解析失效会伪装成全绿）`)
  return new Set(keys)
}

/**
 * 组合源里该行的声明：行默认值 `config` 与其模块文件（B6 §4 第 7 项的同一事实）。
 *
 * 两处必须照做的事实（都由探针实测得出，不是推断）：
 *   - 行可能在**分组行内部**——`filesystem-editor.yml` 是 `cordis:group`，其 `config` 是
 *     **子行数组**（`str-replace-editor` 就嵌在里面），所以查找要递归；
 *   - 组合源用 `!!js <expr>` 表达平台条件（只出现在 `disabled`），解析前替换为 null。
 * 分组行自身与官方包行的 `name` 不是 `./engine/*.mjs`，其 `module` 为 undefined。
 */
function compositionRowOf(row) {
  for (const entry of readdirSync(compositionDir)) {
    if (!entry.endsWith('.yml')) continue
    const doc = parseYaml(readFileSync(new URL(entry, compositionDir), 'utf8').replace(/!!js .*/g, 'null'))
    if (!Array.isArray(doc)) continue
    const found = []
    const visit = (item) => {
      if (item === null || typeof item !== 'object') return
      if (item.id === row) found.push(item)
      if (Array.isArray(item.config)) for (const child of item.config) visit(child)
    }
    for (const item of doc) visit(item)
    const declared = found[0]
    if (declared === undefined) continue
    const module = String(declared.name ?? '').match(/\.\/engine\/(.+)\.mjs$/)?.[1]
    // 只有普通行（非分组）的 config 才是配置对象；分组行的 config 是子行数组。
    const config = declared.config !== null && typeof declared.config === 'object' && !Array.isArray(declared.config)
      ? declared.config
      : {}
    return { module, config, group: declared.group === true || declared.name === 'cordis:group' }
  }
  return undefined
}

/**
 * 某个绑定参数的**合法草稿值**——按 kind 程序化求值。
 *
 * 只覆盖**确实存在绑定**的 5 个 kind（boolean / number / stages / string / string-list，
 * 由 `ENGINE_PARAM_DEFINITIONS` 实测得出）。`default` 分支抛错时列出**程序化收集**的
 * kind 全集，所以将来新增一个带绑定的 kind 会立刻红在这里，而不是静默跳过。
 */
function draftOf(key) {
  const definition = ENGINE_PARAM_DEFINITIONS[key]
  if (definition.kind === 'boolean') return true
  if (definition.kind === 'string') {
    return Array.isArray(definition.options) && definition.options.length > 0 ? definition.options[0] : 'draft'
  }
  if (definition.kind === 'string-list') return ['draft']
  if (definition.kind === 'stages') return [{ name: 'read', tools: ['read'] }]
  if (definition.kind === 'number') {
    // check 是 (value) => string | undefined；逐个试候选值，取第一个被接受的。
    for (const candidate of [1, 0, 2, 16]) {
      if (definition.check === undefined || definition.check(candidate) === undefined) return candidate
    }
    throw new Error(`${key}: 无法构造满足 check 的合法草稿值（候选都被拒）`)
  }
  const allKinds = [...new Set(ENGINE_PARAM_KEYS.map((name) => ENGINE_PARAM_DEFINITIONS[name].kind))].sort()
  throw new Error(`${key}: 未知 kind ${JSON.stringify(definition.kind)} —— 请为它补草稿值。定义里出现的 kind 全集：${allKinds.join(', ')}`)
}

/** 全部绑定键的合法草稿值。 */
const draftsFor = () => Object.fromEntries(boundKeys.map((key) => [key, draftOf(key)]))

/** 参数桥产出 + 组合源行默认值 = 引擎实际收到的配置。 */
function effectiveConfig(row, produced) {
  const declared = compositionRowOf(row)
  // 行不在组合源、或该行是官方包/分组行时都没有本仓库模块——由「范围断言」那条用例统一报出，
  // 这里只负责合并，不在这里断言（否则同一个问题会在多条用例里以不同面目出现）。
  // `{ ...undefined }` 得到空对象，所以 `declared?.config` 缺省时无需额外回退。
  return { module: declared?.module, config: { ...declared?.config, ...produced[row] } }
}

test('闭合（B2 迁移模块）：组合源默认值 + 参数桥覆盖必须被该模块的 configContract 接受', async () => {
  const produced = buildEngineModuleParams(draftsFor())
  assert.ok(Object.keys(produced).length > 0, '参数桥应产出至少一个行配置')

  let checked = 0
  for (const row of Object.keys(produced)) {
    const { module, config } = effectiveConfig(row, produced)
    if (module === undefined || declarationOf(module) !== 'contract') continue
    const loaded = await import(new URL(`${module}.mjs`, engineDir))
    assert.equal(typeof loaded.configContract?.parse, 'function', `${module}: configContract.parse 应是函数`)
    assert.doesNotThrow(
      () => loaded.configContract.parse(config, loaded.name ?? module),
      `${module}: 实际配置 ${JSON.stringify(config)} 被引擎拒绝（组合源默认值与参数桥转换不相容）`,
    )
    checked += 1
  }
  assert.ok(checked >= 2, `至少应校验 2 个 configContract 模块（实际 ${checked}）—— 数量过少说明 row→module 映射失效`)
})

test('闭合（未迁移模块）：参数桥产出的键必须落在该模块的手写白名单内', () => {
  const produced = buildEngineModuleParams(draftsFor())
  let checked = 0
  for (const row of Object.keys(produced)) {
    const { module } = effectiveConfig(row, produced)
    if (module === undefined || declarationOf(module) !== 'allowedKeys') continue
    const unknown = Object.keys(produced[row]).filter((key) => !allowedKeysOf(module).has(key))
    assert.deepEqual(unknown, [], `${module}: 参数桥产出白名单外的键 ${unknown.join(', ')} —— 该键会被挂载期拒绝`)
    checked += 1
  }
  assert.ok(checked >= 5, `至少应校验 5 个手写白名单模块（实际 ${checked}）`)
})

test('范围断言（R7）：三类失败互不混淆——行缺失 / 官方包行 / 声明缺失', () => {
  const produced = buildEngineModuleParams(draftsFor())
  const missingRow = []
  const external = []
  const undeclared = []
  for (const row of Object.keys(produced)) {
    const declared = compositionRowOf(row)
    // ① 参数桥绑定的行必须真实存在于组合源，否则参数无处落位。
    if (declared === undefined) { missingRow.push(row); continue }
    // ② 官方包行没有本仓库模块（`str-replace-editor` → `@deepseek-ai/dsh-tool-str-replace-editor`）。
    if (declared.module === undefined) { external.push(row); continue }
    // ③ 有本仓库模块却没有任何声明 = **声明缺失**（B7 迁移补齐），与"声明与产出不一致"不同类。
    if (declarationOf(declared.module) === undefined) { undeclared.push(`${row} → engine/${declared.module}.mjs`); continue }
  }
  assert.deepEqual(missingRow, [], `参数桥产出的行必须都在组合源里声明：${missingRow.join(', ')}`)
  assert.deepEqual(external, ['str-replace-editor'], `只有官方包行允许没有本仓库模块（B3 T4 已核对）；实际：${external.join(', ')}`)
  assert.deepEqual(undeclared, [], `有模块却既无 configContract 也无 ALLOWED_KEYS：${undeclared.join(', ')} —— 这是**声明缺失**`)
})

test('B0 既有守卫的覆盖对象（7 个手写模块）当前确实都有可解析的声明', () => {
  // 钉住迁移进度：某模块一旦迁到 configContract，它的 ALLOWED_KEYS 消失，既有守卫
  // （engine-param-schema.test.mjs 的源码解析）会解析失败，而本文件的 contract 分支接手
  // —— 两盏灯加起来不漏。
  for (const module of ['tool-bootstrap', 'context-gate', 'promoted-code-mode', 'tool-filter', 'anchor-turn', 'deliberation-gate', 'progress-reminder']) {
    const declaration = declarationOf(module)
    assert.ok(declaration !== undefined, `engine/${module}.mjs 应至少有一种声明`)
    if (declaration === 'allowedKeys') allowedKeysOf(module)
  }
})

test('行 id → 模块文件的映射可信：每个有绑定的 row 都能定位到模块或明确是官方包', () => {
  const unresolved = []
  for (const row of boundRows) {
    const declared = compositionRowOf(row)
    if (declared?.module === undefined) { unresolved.push(row); continue }
    assert.ok(engineModules.includes(declared.module), `${row} → engine/${declared.module}.mjs 应真实存在`)
  }
  // str-replace-editor 由官方包提供（本仓库无对应 .mjs）。
  assert.deepEqual(unresolved, ['str-replace-editor'], `未解析的 row：${unresolved.join(', ')}`)
})

test('绑定形状可信：单独喂一个绑定键时只写它自己那一格', () => {
  for (const key of boundKeys) {
    const binding = ENGINE_PARAM_DEFINITIONS[key].module
    const written = buildEngineModuleParams({ [key]: draftOf(key) })[binding.row]
    // editor-default / positive / optional-cap 等 mode 可能主动不写（0 / 空值语义），跳过。
    if (written === undefined) continue
    assert.deepEqual(Object.keys(written), [binding.key ?? key], `${key} 应只写 ${binding.row}.${binding.key ?? key}`)
  }
})
