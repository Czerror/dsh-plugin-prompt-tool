/**
 * B6 T5 (3) 验收：host 的 `PromptConfigSpec` 枚举与引擎 `KNOWN_*` **双向一致**。
 *
 * 背景：同一批枚举值在仓库里写过三遍——引擎 `engine/schema.mjs` 的 `KNOWN_*`（权威）、
 * 客户端 `prompt-tool-types.ts`、host 的 `PromptConfigSpec`。客户端那份由 T2 的对拍守卫看着
 * （`test/client/mirror-guards.test.mjs`），host 这份原先只靠人眼。
 *
 * 为什么不派生类型：引擎是仓库根的纯 `.mjs`（无 `.d.mts`，`src/` 侧靠 `@ts-expect-error`
 * 引入），其 `KNOWN_*` 在 TS 眼里是 `any`，派生不出字面量联合。所以改为「运行期值清单 +
 * 类型由它派生 + 本守卫双向对拍」——类型与守卫读同一份清单，不可能各自漂移。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { PROMPT_CONFIG_SPEC_ENUMS } from '../../src/host/prompt-configs.ts'
import {
  KNOWN_AUDIENCES,
  KNOWN_DEDUPES,
  KNOWN_MERGE_MODES,
  KNOWN_MODEL_SCOPES,
  KNOWN_POSITIONS,
  KNOWN_PROMOTIONS,
  KNOWN_ROLES,
  KNOWN_SLOT_KINDS,
  KNOWN_SUBJECTS,
} from '../../engine/schema.mjs'

/** 字段 → 引擎权威集合。新增枚举字段时这里必须同步（第一条断言会红）。 */
const ENGINE_SETS = {
  configKind: KNOWN_SLOT_KINDS,
  role: KNOWN_ROLES,
  position: KNOWN_POSITIONS,
  dedupe: KNOWN_DEDUPES,
  promotion: KNOWN_PROMOTIONS,
  audience: KNOWN_AUDIENCES,
  subject: KNOWN_SUBJECTS,
  modelScope: KNOWN_MODEL_SCOPES,
  mergeMode: KNOWN_MERGE_MODES,
}

test('枚举字段集合一致：PROMPT_CONFIG_SPEC_ENUMS 与引擎 KNOWN_* 一一对应', () => {
  assert.deepEqual(
    Object.keys(PROMPT_CONFIG_SPEC_ENUMS).sort(),
    Object.keys(ENGINE_SETS).sort(),
    '新增/删除一个枚举字段时，本守卫的两侧都要同步',
  )
})

test('每个枚举逐值双向一致：host 不缺少引擎的值，也不多出引擎不接受的值', () => {
  for (const [field, values] of Object.entries(PROMPT_CONFIG_SPEC_ENUMS)) {
    const engineSet = ENGINE_SETS[field]
    assert.ok(engineSet instanceof Set, `${field}: 应有对应的引擎 KNOWN_* 集合`)
    assert.ok(values.length > 0, `${field}: 值清单不得为空（空清单会让类型退化成 never）`)
    const local = new Set(values)
    assert.deepEqual(
      [...engineSet].filter((value) => !local.has(value)),
      [],
      `${field}: host 缺少引擎接受的值 —— 该值在 host 侧会被当成非法`,
    )
    assert.deepEqual(
      [...local].filter((value) => !engineSet.has(value)),
      [],
      `${field}: host 多出引擎不接受的值 —— 该值能通过 host 类型检查却被引擎拒绝`,
    )
  }
})

test('引擎集合本身非空（对拍失效模式：解析不到 → 空集 → 全绿）', () => {
  for (const [field, engineSet] of Object.entries(ENGINE_SETS)) {
    assert.ok(engineSet instanceof Set && engineSet.size > 0, `${field}: 引擎集合不得为空`)
  }
})
