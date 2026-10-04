/**
 * 工具面收窄模板 + dev-tool-search 的**跨模块契约**验收。
 *
 * 本模板与 `engine/dev-tool-search.mjs` 之间有一条隐式契约，任一端单独看都正常、
 * 合起来才失效，所以必须一起锁：
 *   插件把解锁名写进 `tool/call` 参数对象；
 *   模板的 `allowFrom: { tool, key }` 靠 `tool` 名精确匹配事件、靠 `key` 取出数组。
 * 名字或键任一写错，解锁就是**静默无效**（当次请求用完即被裁、无告警）。
 *
 * 真值源：模板文件与插件导出，两侧都是公开可读的产物；期望值由两者的语义手算。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'

import { compileRules } from '../../engine/rule-spec.mjs'
import { subjectOf } from '../../engine/conditions/subject.mjs'
import { apply as applyDevToolSearch } from '../../engine/dev-tool-search.mjs'

const raw = readFileSync(new URL('../../templates/80-tool-surface.yml', import.meta.url), 'utf8')
const parsed = parse(raw, { logLevel: 'silent' })

/** 模板声明的核心常驻集（与 engine/dev-tool-search.mjs 的 RESIDENT 应对应）。 */
const EXPECTED_ALLOW = ['pwsh', 'read', 'write', 'edit', 'glob', 'grep', 'todo_write', 'skill_search', 'skill_load', 'dev_tool_search']

test('工具面模板：通过引擎权威校验，且是单条规则对象', () => {
  assert.equal(Array.isArray(parsed), false, 'templates/*.yml 必须是单个规则对象，不是声明数组')
  const compiled = compileRules([parsed])
  assert.equal(compiled.length, 1)
  assert.equal(compiled[0].id, 'tool-surface-resident')
})

test('工具面模板：allow 集与常驻清单一致，不留 bash / str_replace_editor 之类错名', () => {
  const action = parsed.then.find((entry) => entry.kind === 'assembly')
  assert.ok(action !== undefined, '必须有 assembly 动作')
  assert.deepEqual(action.target.tools.allow, EXPECTED_ALLOW)
  // 错名是静默故障：写进 allow 的名字不存在会触发 requireMatch 的 fail-open，
  // 表现为「收窄没生效」而不是报错。
  for (const wrong of ['bash', 'str_replace_editor', 'shell', 'web_search']) {
    assert.equal(action.target.tools.allow.includes(wrong), false, `allow 不得含错名 ${wrong}`)
  }
  assert.equal(action.target.tools.requireMatch, true, '缺任一工具必须 fail-open 到完整目录')
})

test('工具面模板：allowFrom 与 dev-tool-search 的写入端同名同键（跨模块契约）', async () => {
  const action = parsed.then.find((entry) => entry.kind === 'assembly')
  const allowFrom = action.target.tools.allowFrom
  assert.deepEqual(allowFrom, { tool: 'dev_tool_search', key: 'toolNames' })

  // 从插件导出侧拿工具名，确认与模板声明的 tool 一致。
  const registered = []
  applyDevToolSearch({ tools: { register: (definition) => { registered.push(definition); return () => {} }, schemas: () => [] } })
  assert.equal(registered[0].name, allowFrom.tool, '模板的 allowFrom.tool 必须等于插件注册的工具名')
  // 参数 schema 里必须真有这个键，否则模型传了就丢。
  assert.ok(Object.hasOwn(registered[0].parameters.properties, allowFrom.key), `插件的参数里必须有 ${allowFrom.key}`)
  assert.equal(registered[0].parameters.properties[allowFrom.key].type, 'array')

  // 端到端：插件写出的参数形态，必须能被 allowFrom 的解析口径读成字符串数组。
  const written = await registered[0].execute({ toolNames: ['web_search', 'task_board_list'] }, { agent: {} })
  assert.match(written.text, /Unlocked for the next request/)
  const persisted = JSON.stringify({ query: 'web', toolNames: ['web_search', 'task_board_list'] })
  const reparsed = JSON.parse(persisted)
  assert.deepEqual(reparsed[allowFrom.key], ['web_search', 'task_board_list'], '写入与读取同一键')
})

test('工具面模板：相位用 any 两支覆盖晋升后与压缩后，且纳入子代理', () => {
  // 单一 phase 节点无法表达「两个相位都命中」：`promoted` 缺省是 true（= 只匹配已晋升），
  // 而 `promoted: 'ignore'` 要求同时声明只接受布尔值的 `compacted`。
  const branches = parsed.if.any
  assert.ok(Array.isArray(branches) && branches.length === 2, '必须用 any 拼两支')
  assert.deepEqual(branches[0], { phase: { promoteOn: 'either', includeSubagents: true, promoted: true } })
  assert.deepEqual(branches[1], { phase: { promoteOn: 'either', includeSubagents: true, compacted: true, promoted: false } })
  for (const branch of branches) {
    assert.equal(branch.phase.includeSubagents, true, '子代理同样收窄，否则它们付全量工具描述')
    assert.equal(branch.phase.promoteOn, 'either')
  }
  // 支 1 不限 compacted = 压缩与否都命中；支 2 补上「压缩后未晋升」那一格。
  assert.equal(branches[0].phase.compacted, undefined)
  assert.equal(branches[1].phase.compacted, true)
  // 首轮（未晋升且未压缩）刻意不收窄——与「首轮保全文」同一取舍，注释里已写明。
})

test('工具面模板：规则级字段合法——不得声明 waterfallPosition（那是声明路径的字段）', () => {
  assert.equal(Object.hasOwn(parsed, 'waterfallPosition'), false)
  assert.equal(Object.hasOwn(parsed, 'channel'), false)
  assert.deepEqual(Object.keys(parsed).sort(), ['enabled', 'id', 'if', 'name', 'then'].sort())
})

test('工具面模板：any 两支实测覆盖「晋升后」与「压缩后未晋升」，首轮刻意不收窄', () => {
  // 用引擎权威路径判定：compileRules 把 `if` 归一为产物上的 `when`；
  // 载荷必须走 subjectOf 归一化（裸 { agent } 会被 agentOf 当成旧形态，一律 UNAVAILABLE）。
  const when = compileRules([parsed])[0].when
  const session = (events) => ({ id: `s-${Math.random()}`, header: { delegationDepth: 0 }, snapshotEvents: () => events })
  const withSeq = (list) => list.map((event, index) => ({ ...event, seq: index }))
  const payloadFor = (events) => subjectOf('system-prompt/assemble', [{}, { agent: { session: session(events) } }], () => {})
  const hit = (events) => when(payloadFor(events)) === true
  const PROMOTE = { type: 'tool/call', data: { name: 'pwsh' } }
  const COMPACT = { type: 'compaction/end', data: {} }

  assert.equal(hit(withSeq([])), false, '首轮不收窄——与「首轮保全文」同一取舍')
  assert.equal(hit(withSeq([PROMOTE])), true, '已晋升收窄')
  assert.equal(hit(withSeq([PROMOTE, COMPACT])), true, '压缩后未晋升收窄（成功压缩会清零 promoted）')
  assert.equal(hit(withSeq([PROMOTE, COMPACT, { type: 'tool/call', data: { name: 'read' } }])), true, '压缩后已晋升收窄')
  assert.equal(hit(withSeq([COMPACT])), true, '压缩后无晋升信号同样收窄')

  // 差分：去掉第一支后必须丢掉「已晋升」，去掉第二支后必须丢掉「压缩后未晋升」——
  // 证明两支都不是冗余。
  const onlySecond = compileRules([{ ...parsed, if: { any: [parsed.if.any[1]] } }])[0].when
  assert.equal(onlySecond(payloadFor(withSeq([PROMOTE]))) === true, false, '第二支不覆盖已晋升 ⇒ 第一支有用')
  assert.equal(onlySecond(payloadFor(withSeq([PROMOTE, COMPACT]))) === true, true, '第二支覆盖压缩后未晋升')
  const onlyFirst = compileRules([{ ...parsed, if: { any: [parsed.if.any[0]] } }])[0].when
  assert.equal(onlyFirst(payloadFor(withSeq([PROMOTE, COMPACT]))) === true, false, '第一支不覆盖压缩后未晋升 ⇒ 第二支有用')
})
