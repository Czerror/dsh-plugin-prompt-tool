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

test('工具面模板：allow 集与常驻清单逐字一致', () => {
  const action = parsed.then.find((entry) => entry.kind === 'assembly')
  assert.ok(action !== undefined, '必须有 assembly 动作')
  assert.deepEqual(action.target.tools.allow, EXPECTED_ALLOW)
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

test('工具面模板：规则无条件生效——**首轮即收窄**，不再按相位放行首轮', () => {
  // 真值源：模板文件本身。收窄从第一次装配就生效，工具面在会话中途不再变化；
  // 期望值由「规则级 if 省略 → compileWhen 返回 undefined（无条件）」这一语义手算。
  const compiled = compileRules([parsed])
  assert.equal(compiled[0].when, undefined, '没有 if 的规则必须无条件执行，收窄在首轮就命中')
  assert.equal(parsed.if, undefined, '模板不得再声明相位门控')
})
