/**
 * 引擎契约一致性（加载器视角）。
 *
 * 真值源：`docs/engine-reuse.md#引擎契约（加载器视角）` 的五条 + 加载器
 * `src/runtime/agent-assembly.ts:186-204`。测试只读仓库内组合源：
 *  - 本地引擎行（name 以 ./engine/ 开头）：文件与行 id 一致、name 对齐、导出 apply、
 *    inject 为字符串数组、configContract.parse 为函数；
 *  - 官方 recipe 行（cordis:group / @deepseek-ai/*）：name 非空、没有本地引擎文件。
 *
 * 断言落在加载器实际消费的形状上；不执行 apply，也不引入宿主依赖。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { parse } from 'yaml'

const repoRoot = new URL('../..', import.meta.url)
const rowsDir = new URL('engine/compositions/source/local/', repoRoot)
const engineDir = new URL('engine/', repoRoot)

const rowFiles = readdirSync(rowsDir).filter((name) => name.endsWith('.yml')).sort()

test('引擎契约：本地行满足加载器五条，官方 recipe 行不伪装成本地引擎', async () => {
  assert.ok(rowFiles.length > 0, '组合源目录不应为空')
  const seenIds = new Set()
  let local = 0
  let official = 0

  for (const file of rowFiles) {
    const rows = parse(readFileSync(new URL(file, rowsDir), 'utf8'), { logLevel: 'silent' })
    assert.ok(Array.isArray(rows) && rows.length > 0, `${file}: 应是行数组`)
    for (const row of rows) {
      assert.equal(typeof row?.id, 'string', `${file}: 行缺少 id`)
      assert.ok(row.id.length > 0, `${file}: 行 id 为空`)
      assert.equal(seenIds.has(row.id), false, `${file}: 行 id ${JSON.stringify(row.id)} 重复`)
      seenIds.add(row.id)
      assert.equal(typeof row.name, 'string', `${file}:${row.id}: 缺少 name`)

      const localFile = new URL(`${row.id}.mjs`, engineDir)
      if (row.name.startsWith('./engine/')) {
        local++
        assert.equal(row.name, `./engine/${row.id}.mjs`, `${file}:${row.id}: name 必须与 id 对齐`)
        assert.equal(existsSync(localFile), true, `${file}:${row.id}: 引擎文件不存在`)
        const module = await import(localFile.href)
        assert.equal(typeof module.apply, 'function', `${row.id}: 必须导出 apply`)
        if (module.inject !== undefined) {
          assert.ok(Array.isArray(module.inject), `${row.id}.inject 必须是数组`)
          for (const dependency of module.inject) {
            assert.equal(typeof dependency, 'string', `${row.id}.inject 元素必须是字符串`)
          }
        }
        if (module.configContract !== undefined) {
          assert.equal(typeof module.configContract.parse, 'function', `${row.id}.configContract.parse 必须是函数`)
        }
      } else {
        official++
        assert.equal(existsSync(localFile), false, `${file}:${row.id}: 官方行不应有本地引擎文件`)
      }
    }
  }

  assert.ok(local > 0, '至少应有一个本地引擎行')
  assert.ok(official > 0, '至少应有一个官方 recipe 行')
})
