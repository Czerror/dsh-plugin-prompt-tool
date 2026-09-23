/**
 * 客户端手抄引擎事实的镜像守卫。
 *
 * 产品代码不 import engine/*.mjs（零引擎运行时依赖，无既有先例）；需要读引擎真实取值时
 * 由本文件 import 引擎模块做对拍，或直接驱动引擎的校验函数做**行为**断言。
 * 解析型守卫的失效模式是「解析不到 → 空集 → 全绿」，故每处解析都先自证非空。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import ts from 'typescript'
import { LAYER_FIELD_POLICY_KEYS } from '../../src/client/prompt-tool-types.ts'
import { LAYER_LABEL_KEYS, MATCH_LOGICS } from '../../src/client/features/prompts/prompt-config-policy.ts'
import { EMPTY_META } from '../../src/client/data/prompt-tool-fields.ts'
import { getEngineMeta } from '../../engine/schema.mjs'
import { MATCH_LOGIC } from '../../engine/anchor-match.mjs'
import { validateDefinition, validateJsonSchemaNode } from '../../engine/tool-definition.mjs'
import { parameterSchemaSpecToJsonSchema } from '@deepseek-ai/dsh-tools'

// CustomToolEditor.tsx 是 TSX 且引用 CSS Modules：与其余客户端测试同样用 Node module hooks 现场转译，
// 不依赖 lib/ 构建（本文件只读它的枚举常量，不渲染卡片）。
const reactModules = Object.fromEntries(['react', 'react/jsx-runtime', 'react-dom'].map((name) => [name, import.meta.resolve(name)]))
const loader = registerHooks({
  resolve(specifier, context, nextResolve) {
    return reactModules[specifier] === undefined ? nextResolve(specifier, context) : { url: reactModules[specifier], shortCircuit: true }
  },
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: 'export default {}' }
    if (url.endsWith('.tsx')) return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2024 },
    }).outputText }
    return nextLoad(url, context)
  },
})
const { FS_ACTIONS, KIND_OPTIONS, SCHEMA_TYPES } = await import('../../src/client/features/tools/CustomToolEditor.tsx')
loader.deregister()

const engineSource = readFileSync(new URL('../../engine/tool-definition.mjs', import.meta.url), 'utf8')

/** 从 engine/tool-definition.mjs 解析内联取值列表（kind / fs action）；解析结果必须非空。 */
function engineInlineValues(guardPattern, label) {
  const block = engineSource.match(guardPattern)?.[1]
  assert.ok(block !== undefined, `engine/tool-definition.mjs 应有 ${label} 校验列表`)
  const values = [...block.matchAll(/'([^']+)'/g)].map((match) => match[1])
  assert.ok(values.length > 0, `${label} 解析结果不得为空`)
  return values
}

/** 各 kind / fs action 的最小可校验定义（其余字段取满足 validateDefinition 的下限）。 */
const definitionFor = (execute) => ({
  id: 'tool-1',
  name: 'tool_1',
  description: 'd',
  output: { schema: { type: 'object' } },
  execute,
})

test('层字段能力矩阵键集与引擎每层 fields 的键集一致', () => {
  const meta = getEngineMeta()
  assert.ok(meta.layerOrder.length > 0, '引擎层序不得为空')
  for (const layer of meta.layerOrder) {
    assert.deepEqual(
      Object.keys(meta.layerFieldPolicies[layer]).sort(),
      [...LAYER_FIELD_POLICY_KEYS].sort(),
      `layer ${layer}: 客户端字段键集与引擎 fields 不一致`,
    )
  }
})

test('EMPTY_META 的键都是引擎 /meta 的真实键，且引擎的列表键都已退化为空表', () => {
  const engineMeta = getEngineMeta()
  const engineKeys = new Set([...Object.keys(engineMeta), 'editorGroups'])
  const keys = Object.keys(EMPTY_META)
  assert.ok(keys.length > 0, 'EMPTY_META 不得为空')
  for (const key of keys) assert.ok(engineKeys.has(key), `EMPTY_META.${key} 不是 getEngineMeta() 的键`)
  const requiredLists = Object.entries(engineMeta)
    .filter(([key, value]) => Array.isArray(value) && key !== 'layerOrder')
    .map(([key]) => key)
  assert.ok(requiredLists.length > 0, '引擎列表键解析结果不得为空')
  for (const key of requiredLists) assert.ok(Array.isArray(EMPTY_META[key]), `EMPTY_META 缺 ${key} 的退化空表`)
  assert.deepEqual([...EMPTY_META.layerOrder], [...engineMeta.layerOrder], '层序退化值应与引擎 layerOrder 同源')
})

test('层标签字典的键集与引擎 layerLabels 一致', () => {
  const engineLabels = Object.keys(getEngineMeta().layerLabels)
  assert.ok(engineLabels.length > 0, '引擎 layerLabels 不得为空')
  assert.deepEqual(Object.keys(LAYER_LABEL_KEYS).sort(), [...engineLabels].sort(), '客户端层标签键集与引擎 layerLabels 漂移')
})

test('组合逻辑取值与引擎 MATCH_LOGIC 逐值一致（含下拉顺序）', () => {
  assert.deepEqual([...MATCH_LOGICS], ['any', 'all', 'not', 'notAny'])
  assert.deepEqual([...MATCH_LOGICS].sort(), Object.values(MATCH_LOGIC).sort(), '表单取值必须与引擎 MATCH_LOGIC 同源')
})

test('自定义工具 kind / fs action 枚举与引擎校验列表一致（解析 + 行为双向）', () => {
  const engineKinds = engineInlineValues(/!\[([^\]]*)\]\.includes\(exec\.kind\)/, 'execute.kind')
  assert.deepEqual([...KIND_OPTIONS].sort(), [...engineKinds].sort(), 'kind 枚举与引擎不一致')
  for (const kind of KIND_OPTIONS) {
    const execute = kind === 'shell' ? { kind, command: 'echo' }
      : kind === 'http' ? { kind, url: 'https://example.com' }
        : kind === 'delegate' ? { kind, tool: 'read' }
          : kind === 'fs' ? { kind, action: 'read', path: 'a.txt' }
            : { kind }
    assert.doesNotThrow(() => validateDefinition(definitionFor(execute)), `引擎应接受 kind=${kind}`)
  }
  assert.throws(() => validateDefinition(definitionFor({ kind: 'python' })), /execute\.kind/, '引擎应拒绝列表外的 kind')

  const engineFsActions = engineInlineValues(/!\[([^\]]*)\]\.includes\(exec\.action\)/, 'fs execute.action')
  assert.deepEqual([...FS_ACTIONS].sort(), [...engineFsActions].sort(), 'fs action 枚举与引擎不一致')
  for (const action of FS_ACTIONS) {
    assert.doesNotThrow(() => validateDefinition(definitionFor({ kind: 'fs', action, path: 'a.txt' })), `引擎应接受 fs action=${action}`)
  }
})

test('parameters type 下拉 = 引擎物化类型集 + UI 专有的作者侧形态 json/oneOf', () => {
  const materialized = SCHEMA_TYPES.filter((type) => type !== 'json' && type !== 'oneOf')
  const declaredBlock = engineSource.match(/const JSON_SCHEMA_TYPES = new Set\(\[([^\]]*)\]\)/)?.[1]
  assert.ok(declaredBlock !== undefined, 'engine/tool-definition.mjs 应有 JSON_SCHEMA_TYPES 声明')
  const declared = [...declaredBlock.matchAll(/'([^']+)'/g)].map((match) => match[1])
  assert.ok(declared.length > 0, 'JSON_SCHEMA_TYPES 解析结果不得为空')
  assert.deepEqual([...materialized].sort(), [...declared].sort(), '物化类型集与引擎 JSON_SCHEMA_TYPES 不一致')
  for (const type of materialized) {
    assert.doesNotThrow(() => validateJsonSchemaNode({ type }, 'p', new Set()), `引擎应接受物化类型 ${type}`)
  }
  // json / oneOf 是作者侧（preset.yml DSL）形态：引擎拒绝它们出现在 type，只能由 host 物化后再校验。
  for (const type of ['json', 'oneOf']) {
    assert.throws(() => validateJsonSchemaNode({ type }, 'p', new Set()), /must be one of/, `引擎应拒绝未物化的 type=${type}`)
  }
  // 物化结果：json → 仅注释节点（= 任意 JSON），oneOf → 分支联合；两者都必须是引擎可接受的节点。
  const asJson = parameterSchemaSpecToJsonSchema({ probe: { type: 'json' } })
  assert.deepEqual(asJson.properties.probe, {}, 'type: json 应物化为仅注释节点（任意 JSON）')
  const asOneOf = parameterSchemaSpecToJsonSchema({ probe: { oneOf: [{ type: 'string' }, { type: 'number' }] } })
  assert.equal(asOneOf.properties.probe.oneOf.length, 2, 'oneOf 应物化为分支联合')
  for (const node of [asJson, asOneOf]) {
    assert.doesNotThrow(() => validateJsonSchemaNode(node, 'p', new Set()), '作者侧形态物化后必须是引擎可接受的节点')
  }
})
