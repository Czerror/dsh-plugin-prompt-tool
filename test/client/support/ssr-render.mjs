/**
 * 客户端 SSR 渲染 harness（2026-09-17 测试归一精简 B 档 / Wave 3）。
 *
 * 抽取依据：`test/client/` 已有 6 个文件各自抄一份同样的样板——
 * `registerHooks` 内存转译 TSX / 映射 CSS Modules、`renderToStaticMarkup` 渲染、
 * 读 zh 字典做 `{name}` 插值的 `t` 桩。本模块把这三件事收敛为一份，
 * 使 `workspace-navigation`、`menu-select`、`prompt-config-form-layout`、
 * `template-picker-anchor`、`review-fixes` 等从「读源码字符串」升级为
 * 「真实渲染断言」时不必再复制样板。
 *
 * 边界（与 docs/ui-architecture.md §12.1 一致）：只用 Node 内置能力 +
 * 已安装的 React server renderer，**不新增 jsdom / happy-dom / Testing Library**。
 * SSR 能断言真实 DOM 属性、文案、结构与顺序；**不能**断言 portal 内容、
 * 真实 CSS 计算值、真实事件与焦点——那些必须留在 Edge smoke。
 *
 * 用法：
 *
 *     import { withSsr, renderElement, makeTranslate } from './support/ssr-render.mjs'
 *     const t = makeTranslate()
 *     const { PromptConfigList } = await withSsr(['../../src/client/features/prompts/PromptConfigList.tsx'])
 *     const html = renderElement(PromptConfigList, { t, ...props })
 */
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { PROMPT_TOOL_DICTS } from '../../../src/client/locales.ts'

const REACT_MODULES = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/server']

/**
 * 注册内存转译 loader 并动态 import 指定模块，返回**扁平化的具名导出**集合
 * （`const { ToolSurfaceView } = await withSsr([...])`）。路径写法与其它测试一致
 * （相对 `test/client/`，例如 `'../../src/client/ui/X.tsx'`）。
 * loader 在本函数返回前注销，不污染后续用例；导出名冲突即抛错，避免静默取错组件。
 */
export async function withSsr(specifiers) {
  const reactResolved = Object.fromEntries(REACT_MODULES.map((name) => [name, import.meta.resolve(name)]))
  const loader = registerHooks({
    resolve(specifier, context, nextResolve) {
      const url = reactResolved[specifier]
      return url === undefined ? nextResolve(specifier, context) : { url, shortCircuit: true }
    },
    load(url, context, nextLoad) {
      if (url.endsWith('.css')) {
        const classes = Object.fromEntries(
          [...readFileSync(new URL(url), 'utf8').matchAll(/\.([\w-]+)/g)].map((match) => [match[1], match[1]]),
        )
        return { format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(classes)}` }
      }
      if (url.endsWith('.tsx')) {
        const { outputText } = ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
          fileName: new URL(url).pathname,
          compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2024 },
        })
        return { format: 'module', shortCircuit: true, source: outputText }
      }
      return nextLoad(url, context)
    },
  })
  try {
    const loaded = {}
    for (const specifier of specifiers) {
      const module = await import(specifier)
      for (const [name, value] of Object.entries(module)) {
        if (name in loaded && loaded[name] !== value) throw new Error(`SSR harness 导出名冲突：${name}（${specifier}）`)
        loaded[name] = value
      }
    }
    return loaded
  } finally {
    loader.deregister()
  }
}

/** 渲染为静态 HTML 字符串（等价现有 6 个文件的 `render` 辅助）。 */
export function renderElement(component, props) {
  return renderToStaticMarkup(createElement(component, props))
}

/** zh 字典翻译桩：`{name}` 插值，键缺失即抛错（与官方 Translate 调用面一致）。 */
export function makeTranslate() {
  return (key, params) => {
    const template = PROMPT_TOOL_DICTS.zh[key]
    if (template === undefined) throw new Error(`missing locale key: ${key}`)
    return template.replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? ''))
  }
}
