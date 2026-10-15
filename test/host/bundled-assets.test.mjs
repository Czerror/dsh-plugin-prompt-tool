/**
 * 随包分发物的结构契约。
 *
 * `modules/`、`templates/` 都是数据，内容随时会变——所以这里只做**通用**校验：遍历目录，
 * 对每个分发物跑同一套结构不变量，不含任何模块特有的正文、规则 id 或动作形状，
 * 新增模块零成本纳入。
 *
 * 真值源是唯一引擎编译器（`compileRules` / `validateCustomTools`）与目录内容本身，
 * 不复刻规则或工具的字段校验。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { compileRules } from '../../engine/rule-spec.mjs'
import { validateCustomTools } from '../../src/host/custom-tools.ts'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const subdirectories = path => readdirSync(join(repoRoot, path), { withFileTypes: true })
  .filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
const yamlFiles = path => readdirSync(join(repoRoot, path)).filter(name => name.endsWith('.yml')).sort()
const readYaml = path => parseYaml(readFileSync(join(repoRoot, path), 'utf8'), { logLevel: 'silent' })

const moduleIds = subdirectories('modules')
const ruleTemplates = yamlFiles('templates')
const toolTemplates = yamlFiles('templates/tools')

test('随包模块：目录名即定义 id、name 非空，定义通过引擎权威校验', () => {
  assert.ok(moduleIds.length > 0, 'modules/ 下必须有随包模块')
  for (const id of moduleIds) {
    const spec = readYaml(`modules/${id}/module.yml`)
    assert.equal(spec.id, id, `${id}: 定义 id 与目录名一致`)
    assert.equal(typeof spec.name, 'string', `${id}: name 必须是字符串`)
    assert.ok(spec.name.trim().length > 0, `${id}: name 不能为空`)
    // 只 parseYaml 会漏掉引擎侧不变量（真踩过：同规则内两个分支动作重名，YAML 合法、引擎拒绝）。
    assert.doesNotThrow(() => compileRules(spec.rules ?? [], { configOrder: spec.configOrder ?? {} }),
      `${id}: rules 必须被引擎接受`)
  }
})

test('随包模块：包内目录只含 module.yml，运行时切片不随包分发', () => {
  for (const id of moduleIds) {
    assert.deepEqual(readdirSync(join(repoRoot, 'modules', id)).sort(), ['module.yml'],
      `${id}: rules/ 与 configs/ 都是运行时产物，进工作区就会被打进 npm 包`)
  }
})

test('随包规则模板：每个文件是单条规则对象并过引擎编译器', () => {
  assert.ok(ruleTemplates.length > 0, 'templates/ 下必须有随包规则模板')
  for (const file of ruleTemplates) {
    const parsed = readYaml(`templates/${file}`)
    assert.equal(Array.isArray(parsed), false, `${file}: templates/*.yml 是单条规则对象，不是声明数组`)
    assert.doesNotThrow(() => compileRules([parsed]), `${file}: 模板规则必须被引擎接受`)
  }
})

test('随包工具模板：每个文件是单个工具定义并通过自定义工具校验', () => {
  assert.ok(toolTemplates.length > 0, 'templates/tools/ 下必须有随包工具模板')
  for (const file of toolTemplates) {
    const parsed = readYaml(`templates/tools/${file}`)
    assert.equal(Array.isArray(parsed), false, `${file}: 是单个工具定义，不是数组`)
    assert.deepEqual(validateCustomTools([parsed]), [], `${file}: 必须通过自定义工具校验`)
  }
})
