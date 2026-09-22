/**
 * B6 T5 (7) 验收：`ENGINE_MANAGED_PATHS` 与组合源 yml 的声明一致。
 *
 * 同一个事实在两处：「`prompt-config-engine.mjs` 的配置目录叫 `prompt-configs`」
 *   - 组合源 yml 的 `configsDir: ../prompt-configs`（**装配时**的配置值）；
 *   - `preset-install.ts` 的 `ENGINE_MANAGED_PATHS`（**预设 id 迁移时**的改写目标）。
 * 二者分工不同、都要保留：迁移面对的是**用户预设**里可能已过时的值，靠读它无法判断该改成
 * 什么。但它们共享「哪个模块用哪个目录」这一事实——所以需要守卫：一旦 yml 改了目录名而表
 * 没跟着改，迁移就会把用户预设的 `configsDir` 指向一个不存在的目录。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { ENGINE_MANAGED_PATHS } from '../../src/host/preset-install.ts'

const compositionDir = new URL('../../engine/compositions/source/local/', import.meta.url)
const engineDir = new URL('../../engine/', import.meta.url)

/**
 * 在组合源里找 `name: …/engine/<moduleFile>` 的行，返回它自己的 config 对象。
 * 行可能嵌在 `cordis:group` 的子行数组里（与 `engine-config-closure` 测试同一事实），
 * 且组合源用 `!!js` 表达平台条件，解析前替换为 null。
 */
function compositionConfigOf(moduleFile) {
  for (const entry of readdirSync(compositionDir)) {
    if (!entry.endsWith('.yml')) continue
    const doc = parseYaml(readFileSync(new URL(entry, compositionDir), 'utf8').replace(/!!js .*/g, 'null'))
    if (!Array.isArray(doc)) continue
    const found = []
    const visit = (item) => {
      if (item === null || typeof item !== 'object') return
      if (String(item.name ?? '').endsWith(`/engine/${moduleFile}`)) found.push(item)
      if (Array.isArray(item.config)) for (const child of item.config) visit(child)
    }
    for (const item of doc) visit(item)
    const declared = found[0]
    if (declared === undefined) continue
    return declared.config !== null && typeof declared.config === 'object' && !Array.isArray(declared.config)
      ? declared.config
      : {}
  }
  return undefined
}

test('受管路径映射与组合源 yml 声明逐条一致', () => {
  const entries = Object.entries(ENGINE_MANAGED_PATHS)
  assert.ok(entries.length > 0, '映射不得为空（否则本守卫全绿但什么也没查）')
  for (const [moduleFile, managed] of entries) {
    const config = compositionConfigOf(moduleFile)
    assert.ok(config !== undefined, `${moduleFile}: 组合源里应有引用它的行`)
    assert.equal(config[managed.field], `../${managed.directory}`,
      `${moduleFile}: yml 的 ${managed.field} 与 ENGINE_MANAGED_PATHS 的目录不一致 —— 迁移会把 configsDir 指错`)
  }
})

test('映射里的模块文件真实存在（防止指向已改名的模块）', () => {
  for (const moduleFile of Object.keys(ENGINE_MANAGED_PATHS)) {
    assert.ok(existsSync(new URL(moduleFile, engineDir)), `engine/${moduleFile} 应存在`)
  }
})

test('受管字段名是这两个之一（写错字段名会让迁移静默不改写）', () => {
  for (const [moduleFile, managed] of Object.entries(ENGINE_MANAGED_PATHS)) {
    assert.ok(['configsDir', 'policyFile'].includes(managed.field),
      `${moduleFile}: field 应是 configsDir 或 policyFile，实际 ${managed.field}`)
    assert.ok(!managed.directory.startsWith('/') && !managed.directory.includes('..'),
      `${moduleFile}: directory 应是相对预设目录的纯路径`)
  }
})
