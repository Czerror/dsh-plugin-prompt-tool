/**
 * 跨层镜像守卫（B0）。
 *
 * 两组断言，检查对象不同，**不得混为一谈**（R11）：
 *  - 第一组：三处**已经发生**的漂移各自的针对性守卫（先红 → T2 修完转绿）。
 *  - 第二组：四类**当时无人守卫**的镜像（用定向变异证明有效，见本文件末尾各条）。
 *
 * 这些守卫读源码/目录/真实渲染结果，不修改被检查对象；不 import src 的 TS 模块，
 * 因此可直接用 node --test 运行。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
// engine/*.mjs 是纯 ESM，可直接 import：比正则解析源码更接近「实际取值」，
// 也不会被格式调整（如把字面量表改成派生）误伤。src 的 TS 模块仍不 import。
import { LAYER_CONTRACTS } from '../../engine/schema.mjs'

const repoRoot = new URL('../../', import.meta.url)
const readSource = (relativePath) => readFileSync(new URL(relativePath, repoRoot), 'utf8')

/** 从 engine/<module>.mjs 解析它接受的配置键（权威来源）。 */
function engineAllowedKeys(module) {
  const block = readSource(`engine/${module}.mjs`)
    .match(/const ALLOWED_KEYS = new Set\(\[([\s\S]*?)\]\)/)?.[1]
  assert.ok(block !== undefined, `engine/${module}.mjs 应有 ALLOWED_KEYS 声明`)
  const keys = [...block.matchAll(/'([^']+)'/g)].map((match) => match[1])
  // 解析型守卫的失效模式是「解析不到 → 空集 → 全绿」，故必须自证非空。
  assert.ok(keys.length > 0, `engine/${module}.mjs 的 ALLOWED_KEYS 解析结果不得为空`)
  return new Set(keys)
}

/** 从 test/host/engine-params-bridge.test.mjs 解析它手抄的那份 ALLOWED 镜像。 */
function mirroredAllowedKeys() {
  const block = readSource('test/host/engine-params-bridge.test.mjs')
    .match(/const ALLOWED = \{([\s\S]*?)\n {2}\}/)?.[1]
  assert.ok(block !== undefined, 'engine-params-bridge.test.mjs 应有手抄 ALLOWED 镜像')
  const mirrors = new Map()
  for (const entry of block.matchAll(/'([a-z-]+)':\s*new Set\(\[([\s\S]*?)\]\)/g)) {
    mirrors.set(entry[1], new Set([...entry[2].matchAll(/'([^']+)'/g)].map((match) => match[1])))
  }
  // B7 T3：手写 ALLOWED_KEYS 的本地模块从 7 个收缩到 1 个（`instruction-hint`），镜像规模随之下降。
  assert.ok(mirrors.size >= 1, `手抄镜像应覆盖 ≥1 个本地模块，实际 ${mirrors.size}`)
  for (const [module, keys] of mirrors) assert.ok(keys.size > 0, `${module} 镜像解析结果不得为空`)
  return mirrors
}

test('第一组(a)：手抄 ALLOWED 镜像与 engine/*.mjs 的 ALLOWED_KEYS 双向一致', () => {
  for (const [module, mirrored] of mirroredAllowedKeys()) {
    const actual = engineAllowedKeys(module)
    assert.deepEqual(
      [...actual].filter((key) => !mirrored.has(key)),
      [],
      `${module}: 手抄镜像缺键 —— 引擎接受但参数桥断言不检查，该键可绕过检查`,
    )
    assert.deepEqual(
      [...mirrored].filter((key) => !actual.has(key)),
      [],
      `${module}: 手抄镜像多键 —— 引擎会拒绝，镜像应删`,
    )
  }
})

test('第一组(b)：bridge 契约 content 联合与 LAYER_EDITING 实际取值同域', () => {
  // 从**运行时导出**取引擎真实产出的 content 取值（LAYER_CONTRACTS 由 LAYER_EDITING 展开）。
  const produced = new Set(Object.values(LAYER_CONTRACTS).map((contract) => contract.content))
  assert.ok(produced.size >= 5, `LAYER_EDITING 的 content 取值应 ≥5 种，实际 ${produced.size}`)

  const layerContract = readSource('src/shared/bridge-contract.ts')
    .match(/export interface LayerContract \{([\s\S]*?)\n\}/)?.[1]
  assert.ok(layerContract !== undefined, 'bridge-contract.ts 应有 LayerContract 接口')
  const union = layerContract.match(/content: ([^\n]+)/)?.[1]
  assert.ok(union !== undefined, 'LayerContract 应有 content 联合')
  const declared = new Set([...union.matchAll(/'([a-z-]+)'/g)].map((match) => match[1]))
  assert.ok(declared.size > 0, 'content 联合解析结果不得为空')

  assert.deepEqual(
    [...declared].filter((value) => !produced.has(value)),
    [],
    'content 联合含引擎从不产生的取值（值域漂移）',
  )
  assert.deepEqual(
    [...produced].filter((value) => !declared.has(value)),
    [],
    'content 联合漏了引擎会产生的取值',
  )
})

test('第一组(c)：docs/engine-reuse.md 的 library / local 模块计数与实际一致', () => {
  const countYml = (dir) => readdirSync(new URL(dir, repoRoot))
    .filter((entry) => entry.endsWith('.yml')).length
  const libraryActual = countYml('engine/compositions/library')
  const localActual = countYml('engine/compositions/source/local')
  assert.ok(libraryActual > 0 && localActual > 0, '组合模块目录不得为空')

  const doc = readSource('docs/engine-reuse.md')
  const libraryClaim = doc.match(/当前原样切出\s*(\d+)\s*个模块/)?.[1]
  const localClaim = doc.match(/(\d+)\s*个本地自有或本地改写模块/)?.[1]
  assert.ok(libraryClaim !== undefined, 'engine-reuse.md 应声明 library 模块数')
  assert.ok(localClaim !== undefined, 'engine-reuse.md 应声明 local 模块数')

  assert.equal(Number(libraryClaim), libraryActual, 'engine-reuse.md 的 library 计数与目录实际不符')
  assert.equal(Number(localClaim), localActual, 'engine-reuse.md 的 local 计数与目录实际不符')
})
