import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { parse } from 'yaml'
import { patchToolParameter } from '../../src/client/features/tools/custom-tool-parameters.ts'
import { compileCustomTool } from '../../src/host/custom-tools.ts'

const require = createRequire(import.meta.url)
const reactUrls = Object.fromEntries(['react', 'react/jsx-runtime', 'react/jsx-dev-runtime']
  .map((specifier) => [specifier, pathToFileURL(require.resolve(specifier)).href]))
const loader = registerHooks({
  // 本地链接的官方 primitive 使用同一 React，避免 SSR 命中宿主仓库另一份 dispatcher。
  resolve(specifier, context, nextResolve) {
    if (Object.hasOwn(reactUrls, specifier)) return { shortCircuit: true, url: reactUrls[specifier] }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: 'export default {}' }
    if (url.endsWith('.tsx')) return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2024 },
    }).outputText }
    return nextLoad(url, context)
  },
})
const { CustomToolCard } = await import('../../src/client/features/tools/CustomToolEditor.tsx')
loader.deregister()

const tool = (parameters, execute = { kind: 'ask-user' }) => ({
  id: 'editor_tool', name: 'editor_tool', description: '编辑器测试', parameters,
  output: { schema: { type: 'json' } }, execute,
})

test('参数类型默认值与高级 JSON roundtrip 均能编译，描述修改不丢嵌套约束', () => {
  for (const type of ['object', 'array', 'oneOf']) {
    const parameter = patchToolParameter({}, { type })
    if (type === 'object') assert.equal(parameter.additionalProperties, true)
    if (type === 'array') assert.deepEqual(parameter.items, { type: 'json' })
    const parameters = { value: JSON.parse(JSON.stringify(parameter)) }
    assert.doesNotThrow(() => compileCustomTool(tool(parameters)), type)
  }
  const parameters = {
    object: { type: 'object', additionalProperties: false, properties: { count: { type: 'integer', required: true } } },
    array: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
    choice: { oneOf: [{ type: 'string', enum: ['a'] }, { type: 'integer' }], required: true },
  }
  const before = structuredClone(parameters)
  const edited = Object.fromEntries(Object.entries(parameters).map(([key, spec]) => [key, patchToolParameter(spec, { description: '改描述' })]))
  assert.deepEqual(parameters, before)
  for (const [key, spec] of Object.entries(before)) assert.deepEqual(edited[key], { ...spec, description: '改描述' })
  assert.doesNotThrow(() => compileCustomTool(tool(JSON.parse(JSON.stringify(edited)))))
  assert.deepEqual(patchToolParameter({ type: 'string', enum: ['a'], future: { keep: true } }, { required: true }), {
    type: 'string', enum: ['a'], future: { keep: true }, required: true,
  }, '未知模板字段只保留，不由行编辑丢弃')
  assert.doesNotThrow(() => compileCustomTool(tool({ value: patchToolParameter(parameters.choice, { type: 'array' }) })))
})

test('所有已有工具模板经参数描述编辑和 JSON roundtrip 后仍能完整编译', () => {
  const dir = new URL('../../templates/tools/', import.meta.url)
  for (const file of readdirSync(dir)) {
    const source = parse(readFileSync(new URL(file, dir), 'utf8'))
    const parameters = Object.fromEntries(Object.entries(source.parameters ?? {}).map(([key, spec]) => [key, patchToolParameter(spec, { description: '更新描述' })]))
    const next = JSON.parse(JSON.stringify({ ...source, parameters }))
    assert.doesNotThrow(() => compileCustomTool(next), file)
    assert.deepEqual(next.execute, source.execute, `${file} 执行器不变`)
  }
})

test('工具卡暴露 fs 内容、复杂参数 JSON、输出 JSON 和超时输入', () => {
  for (const action of ['write', 'append']) {
    const html = renderToStaticMarkup(createElement(CustomToolCard, {
      tool: tool({ choice: { oneOf: [{ type: 'string' }, { type: 'number' }] } }, {
        kind: 'fs', action, path: 'note.txt', content: '首行\n{{args.text}}',
      }), index: 0, expanded: true, canMoveUp: false, canMoveDown: false,
    }))
    assert.match(html, /aria-label="文件内容"/)
    assert.match(html, /首行\n\{\{args.text\}\}/)
    assert.match(html, /aria-label="高级参数 JSON"/)
    assert.match(html, /oneOf/)
    assert.match(html, /aria-label="输出 schema JSON"/)
    assert.match(html, /aria-label="工具超时毫秒"/)
  }
})
