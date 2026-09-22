/**
 * 官方装配刻度：区段边界必须**运行期**从官方服务求得（B8 W2 / T4）。
 *
 * 本文件的价值在于「与官方同源」：档位名由本仓库手抄（`src/shared/official-orders.ts`），
 * 但**数值一律不抄**——这里起一个**真实官方 `SystemPrompt`**，逐个名字调用
 * `getSectionOrder` / `getContextOrder` 对拍。官方改名或新增档位时，本文件先红，
 * 而不是让 UI 显示一份过期的刻度。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import {
  OFFICIAL_CONTEXT_ORDER_GROUPS,
  OFFICIAL_SECTION_ORDER_GROUPS,
  readOfficialOrderSegments,
} from '../../src/shared/official-orders.ts'

/** 起一个真实官方 SystemPrompt 实例；档位数值只认官方实现。 */
async function officialSystemPrompt(t) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false })
  t.after(async () => { await ctx.fiber.dispose() })
  return ctx.systemPrompt
}

test('区段边界与官方逐名取值一一对应（section 6 组 + context 1 组）', async (t) => {
  const systemPrompt = await officialSystemPrompt(t)
  const view = readOfficialOrderSegments(systemPrompt)
  assert.ok(view, '真实官方服务必须能求出刻度')
  assert.equal(view.sections.length, 6, 'section 侧 6 组')
  assert.equal(view.contexts.length, 1, 'context 侧 1 组')

  const segments = [...view.sections, ...view.contexts]
  assert.equal(new Set(segments.map((segment) => segment.id)).size, 7, '区段 id 不得重复')
  for (const segment of segments) {
    assert.equal(typeof segment.id, 'string')
    assert.equal(Number.isFinite(segment.from), true, `${segment.id}.from 必须是有限数`)
    assert.equal(Number.isFinite(segment.to), true, `${segment.id}.to 必须是有限数`)
    assert.ok(segment.from <= segment.to, `${segment.id}: from 不得大于 to`)
    // 可序列化基本类型：bridge 载荷不得夹带函数或对象。
    assert.equal(JSON.parse(JSON.stringify(segment)).id, segment.id)
  }

  const byId = new Map(segments.map((segment) => [segment.id, segment]))
  for (const group of OFFICIAL_SECTION_ORDER_GROUPS) {
    const values = group.names.map((name) => systemPrompt.getSectionOrder(name))
    assert.deepEqual(
      { from: byId.get(group.id).from, to: byId.get(group.id).to },
      { from: Math.min(...values), to: Math.max(...values) },
      `${group.id} 的边界必须等于官方取值`,
    )
  }
  for (const group of OFFICIAL_CONTEXT_ORDER_GROUPS) {
    const values = group.names.map((name) => systemPrompt.getContextOrder(name))
    assert.deepEqual(
      { from: byId.get(group.id).from, to: byId.get(group.id).to },
      { from: Math.min(...values), to: Math.max(...values) },
      `${group.id} 的边界必须等于官方取值`,
    )
  }
})

test('手抄的档位名覆盖官方全集（32 section + 3 context），无遗漏、无重复、组内升序', async (t) => {
  const systemPrompt = await officialSystemPrompt(t)
  const sectionNames = OFFICIAL_SECTION_ORDER_GROUPS.flatMap((group) => [...group.names])
  const contextNames = OFFICIAL_CONTEXT_ORDER_GROUPS.flatMap((group) => [...group.names])

  assert.equal(sectionNames.length, 32, '官方 SECTION_ORDERS 共 32 项')
  assert.equal(new Set(sectionNames).size, 32, '档位名不得重复归组或漏抄')
  assert.equal(contextNames.length, 3, '官方 CONTEXT_ORDERS 共 3 项')
  assert.equal(new Set(contextNames).size, 3, '档位名不得重复归组或漏抄')

  // 每个名字都必须是官方真有的档位：官方改名/删除后这里先红，而不是等 UI 显示错刻度。
  for (const name of sectionNames) {
    assert.equal(Number.isFinite(systemPrompt.getSectionOrder(name)), true, `${name} 不是官方 section 档位`)
  }
  for (const name of contextNames) {
    assert.equal(Number.isFinite(systemPrompt.getContextOrder(name)), true, `${name} 不是官方 context 档位`)
  }

  // 组内顺序必须与官方数值升序一致——区段口径按首末档位求边界，依赖这一点。
  for (const group of OFFICIAL_SECTION_ORDER_GROUPS) {
    const values = group.names.map((name) => systemPrompt.getSectionOrder(name))
    assert.deepEqual(values, [...values].sort((a, b) => a - b), `${group.id} 组内名字必须按官方数值升序`)
  }
  const contextValues = OFFICIAL_CONTEXT_ORDER_GROUPS[0].names.map((name) => systemPrompt.getContextOrder(name))
  assert.deepEqual(contextValues, [...contextValues].sort((a, b) => a - b), 'runtime-policy 组内名字必须按官方数值升序')
})

test('服务缺失或任一档位取不到有限数时整张表降级（不下发部分区段）', () => {
  assert.equal(readOfficialOrderSegments({}), undefined, '服务缺失 ⇒ 整张表缺席')
  assert.equal(readOfficialOrderSegments({ getSectionOrder: () => 1 }), undefined, '缺 context 取值 ⇒ 缺席')
  assert.equal(readOfficialOrderSegments({ getContextOrder: () => 1 }), undefined, '缺 section 取值 ⇒ 缺席')
  assert.equal(
    readOfficialOrderSegments({ getSectionOrder: () => Number.NaN, getContextOrder: () => 1 }),
    undefined,
    '任一档位非有限数 ⇒ 整张表缺席（绝不用手抄数值兜底，也不给看似完整的缺口刻度）',
  )
  assert.equal(
    readOfficialOrderSegments({ getSectionOrder: () => undefined, getContextOrder: () => 1 }),
    undefined,
    '取值返回 undefined ⇒ 缺席',
  )
})
