/**
 * 验证 lib/client.js 与 client-modules 的 queue/live facade 契约：
 * 1. 脚本执行阶段只调用 window.__ModuleLoader__.load({ id, factory })，不物化模块；
 * 2. Host facade 在 create() 时从 queue 切到 live 并排空登记；
 * 3. factory 物化后暴露 { apply, inject }，且仅 require baseline 模块表条目。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const PLUGIN_ID = 'dsh-plugin-prompt-tool'
const bundleSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

function createDocumentStub() {
  return {
    querySelector: () => null,
    createElement: (tag) => ({
      tagName: tag,
      dataset: {},
      _text: '',
      set textContent(value) { this._text = value },
      get textContent() { return this._text },
      appendChild: () => {},
    }),
    head: { appendChild: () => {} },
  }
}

function createRequireStub() {
  const react = {
    Fragment: Symbol.for('react.fragment'),
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useCallback: (fn) => fn,
    useEffect: () => {},
    memo: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    useState: (value) => [value, () => {}],
    useSyncExternalStore: () => null,
  }
  const runtime = { jsx: react.createElement, jsxs: react.createElement, Fragment: react.Fragment }
  const primitives = { IconChevronDownOutline14: () => null }
  const dom = { createRoot: () => ({ render: () => {}, unmount: () => {} }) }
  return (specifier) => {
    switch (specifier) {
      case 'react': return react
      case 'react/jsx-runtime': return runtime
      case 'react-dom/client': return dom
      case '@deepseek-ai/dsh-client-ui-primitives': return primitives
      default: throw new Error('unexpected baseline require: ' + specifier)
    }
  }
}

test('client bundle registers through queue/live facade', () => {
  const facade = {
    mode: 'queue',
    pendingQueue: [],
    registry: [],
    load(registration) {
      assert.equal(registration.id, PLUGIN_ID)
      assert.equal(typeof registration.factory, 'function')
      if (this.mode === 'queue') this.pendingQueue.push(registration)
      else this.registry.push(registration)
    },
    create() {
      assert.equal(this.mode, 'queue')
      this.mode = 'live'
      for (const registration of this.pendingQueue.splice(0)) this.load(registration)
    },
  }

  const context = vm.createContext({
    window: { __ModuleLoader__: facade },
    document: createDocumentStub(),
    console,
    setTimeout,
    clearTimeout,
  })
  vm.runInContext(bundleSource, context, { filename: 'lib/client.js' })

  // 脚本执行只完成登记：queue 有一条、live registry 尚为空，factory 未物化。
  assert.equal(facade.pendingQueue.length, 1)
  assert.equal(facade.registry.length, 0)

  // Host create() 切到 live 并排空 queue。
  facade.create()
  assert.equal(facade.pendingQueue.length, 0)
  assert.equal(facade.registry.length, 1)

  const exports = facade.registry[0].factory(createRequireStub())
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual([...exports.inject], ['settingsScope', 'uiWorkspace', 'remote'])
  // alpha.1 后 dsh-client-runtime 已删除：装配边不得再引用，且需声明新依赖面。
  assert.ok(!manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-runtime'))
  for (const dependency of [
    '@deepseek-ai/dsh-client-connection',
    '@deepseek-ai/dsh-client-ui-settings',
    '@deepseek-ai/dsh-client-ui-workspace',
    '@deepseek-ai/dsh-api-remotes',
  ]) assert.ok(manifest.dsh.client.inject.includes(dependency), `${dependency} missing from dsh.client.inject`)
})
