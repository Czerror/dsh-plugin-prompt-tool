/**
 * B7 T1 → T3 —— `context-gate` 的**声明契约**：`test/engine/declarations/context-gate.yml`。
 *
 * T1 时本文件是「声明 vs 原模块 `engine/context-gate.mjs`」的等价对拍。T3 把该模块与本地下
 * 同名组合源一并删除（其行为改由预设顶层 `triggers` 段的声明表达），因此对拍的那一半
 * （原模块世界、`moduleConfig` 变体、逐日 durable 日志矩阵）已无对象可对，随模块一同退场。
 *
 * 保留下来的两件事都**不依赖原模块**，是长期防回归钉子：
 *   1. 声明文件自身的契约：id、相位判据（`not phase`）、`contexts.clear`、`messageSources`
 *      白名单取值；
 *   2. 订阅档成立的前提：`composite` 必须转发内层谓词的 `observe`。一旦有人改回「组合层不带
 *      observe」，相位就只剩冷扫、声明只能退回 `subscribe: false` 的绕法（每次判定 O(事件数)
 *      冷扫），下面的断言会立刻红并提示原因。
 *
 * 声明文件的逐条「声明 → 原始语义」映射写在 YAML 的注释块里（那份注释同时是删除前的
 * 行为档案），本文件不重复。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { compileDeclarations, compileWhen, mountDeclarations } from '../../engine/trigger-spec.mjs'
import { createPhasePredicate } from '../../engine/predicates.mjs'

const PLUGIN = 'context-gate-declaration'

/** 声明文件本体（对拍用的就是这份 YAML）。 */
const DECLARATIONS = parse(readFileSync(new URL('./declarations/context-gate.yml', import.meta.url), 'utf8'))
const CONTEXTS_DECLARATION = DECLARATIONS.find((item) => item.id === 'context-gate-runtime-contexts')
const SOURCES_DECLARATION = DECLARATIONS.find((item) => item.id === 'context-gate-pre-step-sources')

/** 相位判定：promoteOn 默认 either、includeSubagents 默认 false（见组合源 config 档案 / YAML 注释）。 */
const PHASE = { promoteOn: 'either', includeSubagents: false }

/** 收集 ctx.on 注册的监听器（按注册顺序），并返回与 Cordis 同形状的 disposer。 */
function makeCtx() {
  const listeners = new Map()
  const ctx = {
    logger: { warn: () => {} },
    get: () => undefined,
    on(type, handler, options) {
      const list = listeners.get(type) ?? []
      list.push({ handler, options })
      listeners.set(type, list)
      return () => {
        const current = listeners.get(type) ?? []
        const index = current.findIndex((entry) => entry.handler === handler)
        if (index >= 0) current.splice(index, 1)
      }
    },
  }
  return { ctx, listeners }
}

const handlersOf = (listeners, event) => (listeners.get(event) ?? []).map((entry) => entry.handler)

/** 声明路径的世界：编译 + 挂载这一份 YAML，返回监听器表。 */
function world({ declarations = DECLARATIONS } = {}) {
  const { ctx, listeners } = makeCtx()
  mountDeclarations(ctx, compileDeclarations(declarations), { plugin: PLUGIN })
  return { listeners }
}

test('声明文件契约：两处声明都在，phase 选项与组合源同值，且走订阅档', () => {
  assert.deepEqual(DECLARATIONS.map((item) => item.id),
    ['context-gate-runtime-contexts', 'context-gate-pre-step-sources'])
  for (const declaration of DECLARATIONS) {
    assert.deepEqual(declaration.when, { not: { phase: PHASE } }, '判定 = 未晋升（相位取值同组合源 config）')
  }
  assert.equal(CONTEXTS_DECLARATION.do.target.contexts.clear, true, '路径 (a) = 清空 contexts')
  assert.deepEqual(SOURCES_DECLARATION.do.sources, ['user', 'goal'], '路径 (b) = 严格白名单')

  // 订阅档（缺省）成立的前提是 `composite` 转发内层谓词的 `observe`——本用例把它钉住：
  // 一旦有人改回「组合层不带 observe」，相位就只剩冷扫、声明必须退回 `subscribe: false` 的
  // 绕法（每次判定 O(事件数) 冷扫），这条会立刻红并提示原因。
  assert.equal(typeof createPhasePredicate({ promoteOn: 'either', includeSubagents: false }).observe, 'function',
    '相位谓词本体带 observe')
  assert.equal(typeof compileWhen({ not: { phase: { promoteOn: 'either' } } }).observe, 'function',
    'composite 必须转发 observe（否则声明只能退回 subscribe: false 的冷扫绕法）')
  const declaredWorld = world({ declarations: DECLARATIONS })
  assert.equal(handlersOf(declaredWorld.listeners, 'session/event').length, 1,
    '订阅档接一条 session/event：两个带 observe 的谓词共用同一事件源（与谓词接线同纪律）')
})

test('路径 (b) 未配置形态：不写这条声明即不注册 pre-step 监听（零开销）', () => {
  const declaredWorld = world({ declarations: [CONTEXTS_DECLARATION] })
  assert.deepEqual(handlersOf(declaredWorld.listeners, 'agent/pre-step'), [], '不写声明即不注册（零开销）')
  assert.ok(handlersOf(declaredWorld.listeners, 'system-prompt/assemble').length > 0, '路径 (a) 仍生效')
})
