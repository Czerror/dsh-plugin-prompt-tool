// 验证实际分发声明，不用 src 类型检查替代发布产物的类型契约。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import ts from 'typescript'

const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const declarations = readdirSync(join(root, 'lib')).filter((file) => file.endsWith('.d.mts'))
  .map((file) => ts.createSourceFile(file, readFileSync(join(root, 'lib', file), 'utf8'), ts.ScriptTarget.Latest, true))

test('发布声明引用官方 SDK 类型，不把宿主相对模块扩充搬入插件', () => {
  const entry = declarations.find((file) => file.fileName === 'index.d.mts')
  const imports = entry.statements.filter(ts.isImportDeclaration).map((node) => node.moduleSpecifier.text)
  assert.ok(imports.includes('@deepseek-ai/dsh-agent'), 'AgentOptions 必须引用官方类型')
  assert.ok(imports.includes('@deepseek-ai/dsh-subagent'), 'SubagentRuntime 必须引用官方类型')
  for (const file of declarations) {
    const visit = (node) => {
      if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
        assert.equal(node.name.text.startsWith('.'), false, `${file.fileName} 不应包含失去原目录语义的 ${node.name.text}`)
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
})

test('发布声明的外部导入均有生产或 peer 依赖声明', () => {
  const packages = new Set(Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }))
  for (const file of declarations) {
    for (const node of file.statements) {
      if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) continue
      const specifier = node.moduleSpecifier?.text
      if (!specifier || specifier.startsWith('.') || specifier.startsWith('node:')) continue
      const parts = specifier.split('/')
      const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
      assert.ok(packages.has(name), `${file.fileName}: ${name} 不能只依赖 devDependencies`)
    }
  }
})

test('实际分发声明与官方子代理服务和模型选项双向可赋值', () => {
  const filename = join(root, 'test/published-consumer.mts')
  const source = `
    import type { PluginSubagentSeam, resolveSubagentStartOptions } from '../lib/index.mjs'
    import type { AgentOptions } from '@deepseek-ai/dsh-agent'
    import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
    declare const host: Pick<SubagentRuntime, 'list' | 'getProvider'>
    const plugin: PluginSubagentSeam = host
    const back: typeof host = plugin
    declare const result: ReturnType<typeof resolveSubagentStartOptions>
    const options: AgentOptions | undefined = result
    const reverse: typeof result = options
    type IsAny<T> = 0 extends (1 & T) ? true : false
    const typed: IsAny<typeof result> = false
  `
  const options = { noEmit: true, strict: true, skipLibCheck: true, target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext }
  const host = ts.createCompilerHost(options)
  const getSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (file, ...args) => resolve(file) === filename
    ? ts.createSourceFile(file, source, options.target, true)
    : getSourceFile(file, ...args)
  const program = ts.createProgram([filename], options, host)
  const diagnostics = ts.getPreEmitDiagnostics(program)
  assert.equal(diagnostics.length, 0, ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (file) => file, getCurrentDirectory: () => root, getNewLine: () => '\n',
  }))
})
