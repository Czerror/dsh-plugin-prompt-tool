/**
 * B6 T4 验收：两条 prompt-configs 加载路径的**边界行为固化** + 共享枚举规则。
 *
 * ## 两条路径为什么不能合并
 *
 * | | host `listPromptConfigSpecs` | 引擎 `loadPromptConfigFiles` |
 * |---|---|---|
 * | 用途 | 编辑 / 列举（TUI、bridge、bootstrap 聚合） | 注入（运行时装配） |
 * | 入参 | 字符串路径 | `URL` |
 * | 空路径 | 返回 `[]`（短路） | 不适用（`readdirSync('')` 会抛） |
 * | `variables.yml` | **只跳过，不合并** | 读入并**合并进每条配置** |
 * | 结构校验 | 单对象 + 字符串 `id`，错误带文件名 | YAML 侧只校验单对象；`id` 由 `createPromptConfigs` 管 |
 * | 异常类型 | `Error` | `TypeError` |
 *
 * 差异是**刻意设计**（`CHANGELOG.md:1543-1547`）：host 不合并变量，避免把预设级变量写回配置文件。
 * 所以本文件**不要求两侧行为相同**，而是把各自的边界**固化**下来——任何一侧悄悄改变接受/拒绝
 * 范围或错误类型，都会红在这里。
 *
 * 两侧**共用**的只有枚举规则（`engine/schema.mjs promptConfigFileNames`）：扩展名、排序、
 * 跳过 `variables.yml`。这条共用让「host 让人编辑的文件」与「引擎实际加载的文件」不会漂移。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { listPromptConfigSpecs } from '../../src/host/prompt-configs.ts'
import { loadPromptConfigFiles, promptConfigFileNames } from '../../engine/schema.mjs'

/** 造一个独立临时目录；返回 `{ dir, write }`。 */
function makeDir() {
  const dir = mkdtempSync(join(tmpdir(), 'pt-paths-'))
  return {
    dir,
    write: (name, content) => writeFileSync(join(dir, name), content, 'utf8'),
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const hostLoad = (dir) => listPromptConfigSpecs(dir)
const engineLoad = (dir) => loadPromptConfigFiles(pathToFileURL(dir + '/'))

// ───────────────────────── 各自边界的固化 ─────────────────────────

test('host 路径：空路径短路返回空数组（引擎侧无此语义）', () => {
  assert.deepEqual(hostLoad(''), [], '空路径 = 无配置，不抛错')
})

test('host 路径：不可读目录抛 Error 且带目录名', () => {
  const missing = join(tmpdir(), 'pt-paths-definitely-missing')
  assert.throws(() => hostLoad(missing), (error) => {
    assert.equal(error.constructor.name, 'Error', 'host 侧是 Error，不是 TypeError')
    assert.match(error.message, /^提示词配置目录 ".*" 不可读: /)
    return true
  })
})

test('引擎路径：不可读目录抛 TypeError 且带 configsDir 前缀', () => {
  const missing = join(tmpdir(), 'pt-paths-definitely-missing')
  assert.throws(() => engineLoad(missing), (error) => {
    assert.equal(error.constructor.name, 'TypeError', '引擎侧是 TypeError，不是 Error')
    assert.match(error.message, /configsDir .* is not readable/)
    return true
  })
})

test('host 路径：JSON 标量 / 数组 / YAML 非对象都按「必须是单个配置对象」拒绝', () => {
  const bad = [['a.json', '42'], ['b.json', '[1]'], ['c.yml', '- 1'], ['d.yml', 'null']]
  for (const [name, content] of bad) {
    const { dir, write, dispose } = makeDir()
    write(name, content)
    assert.throws(() => hostLoad(dir), /must contain a single config object/, `${name}: ${content}`)
    dispose()
  }
})

test('host 路径：缺字符串 id 拒绝（引擎侧不做这项校验）', () => {
  const { dir, write, dispose } = makeDir()
  write('a.yml', 'text: hi\n')
  assert.throws(() => hostLoad(dir), /must declare a string id/)
  dispose()
})

test('引擎路径：YAML 非对象被 parsePromptConfigYaml 拒绝（错误形态与 host 不同）', () => {
  const { dir, write, dispose } = makeDir()
  write('a.yml', '- 1')
  assert.throws(() => engineLoad(dir), /prompt config yaml must contain a single object/)
  dispose()
})

test('引擎路径：JSON 分支不做结构校验（与 host 的差异固化，不是缺陷）', () => {
  // 引擎的 .json 分支直接 push JSON.parse 的结果；结构校验归 createPromptConfigs。
  // 这不是"漏校验"：JSON 是机器产物，引擎侧的统一校验在 createPromptConfigs。
  const { dir, write, dispose } = makeDir()
  write('a.json', '{"id":"a"}')
  const specs = engineLoad(dir)
  assert.equal(specs.length, 1)
  assert.equal(specs[0].id, 'a')
  dispose()
})

// ───────────────────────── 共用枚举规则 ─────────────────────────

test('两条路径看到同一批文件（扩展名 / 排序 / 跳过 variables.yml 三条规则共用）', () => {
  const { dir, write, dispose } = makeDir()
  // 混合：合法配置、非配置（.md/.txt）、JSON、variables.yml（两侧都不是配置）
  write('10-second.yml', 'id: second\ntext: b\n')
  write('00-first.yaml', 'id: first\ntext: a\n')
  write('20-third.json', '{"id":"third","text":"c"}')
  write('variables.yml', 'key: value\n')
  write('notes.md', '# not a config\n')
  write('data.txt', 'nope\n')

  const hostIds = hostLoad(dir).map((spec) => spec.id)
  const engineIds = engineLoad(dir).map((spec) => spec.id)
  assert.deepEqual(hostIds, ['first', 'second', 'third'], '按文件名排序，只取 yml/yaml/json')
  assert.deepEqual(engineIds, hostIds, '两条路径的文件集合与顺序必须一致（否则 host 编辑的文件 ≠ 引擎加载的文件）')

  assert.deepEqual(promptConfigFileNames([
    { name: 'b.yml', isFile: () => true },
    { name: 'a.yml', isFile: () => true },
    { name: 'variables.yml', isFile: () => true },
    { name: 'sub', isFile: () => false },
    { name: 'x.md', isFile: () => true },
  ]), ['a.yml', 'b.yml'], '共用枚举：排序 + 扩展名过滤 + 跳过 variables.yml + 只取文件')
  dispose()
})

test('host 版输出不含仅存在于 variables.yml 的键（刻意设计：不合并，避免写回配置文件）', () => {
  const { dir, write, dispose } = makeDir()
  write('a.yml', 'id: a\ntext: own\nvariables:\n  ownKey: from-config\n')
  write('variables.yml', 'presetOnlyKey: from-variables\n')

  const [hostSpec] = hostLoad(dir)
  assert.deepEqual(hostSpec.variables, { ownKey: 'from-config' },
    'host 只带配置自身的 variables —— 合并会让编辑器把预设级变量写回配置文件')

  // 引擎侧相反：合并，且配置自身优先。
  const [engineSpec] = engineLoad(dir)
  assert.deepEqual(engineSpec.variables, { presetOnlyKey: 'from-variables', ownKey: 'from-config' },
    '引擎侧合并 variables.yml，配置自身优先')
  dispose()
})
