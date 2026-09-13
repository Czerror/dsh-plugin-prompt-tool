/**
 * 验证 lib/client.js 与 client-modules 的 queue/live facade 契约：
 * 1. 脚本执行阶段只调用 window.__ModuleLoader__.load({ id, factory })，不物化模块、不注入样式；
 * 2. Host facade 在 create() 时从 queue 切到 live 并排空登记；
 * 3. factory 物化后暴露 { apply, inject }，require 边只含已声明的 rc.2 平台模块；
 * 4. 未声明的平台模块请求必须显式失败，不能被静默打包成第二份单例；
 * 5. package.json#dsh 满足官方清单合同：bundle 只有 patch、client.platform=web、
 *    inject 是包名说明边而不是 Cordis 服务名。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const PLUGIN_ID = 'dsh-plugin-prompt-tool'
const bundleSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const tsdownSource = readFileSync(new URL('../tsdown.config.ts', import.meta.url), 'utf8')
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/** 从 tsdown.config.ts 的 CLIENT_EXTERNALS 解析实际声明的平台模块（源码守卫）。 */
function declaredClientExternals() {
  const block = tsdownSource.match(/const CLIENT_EXTERNALS = \[([\s\S]*?)\n\]/)
  assert.ok(block, 'tsdown.config.ts 必须声明 CLIENT_EXTERNALS')
  return [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1])
}

function createDocumentStub(record) {
  return {
    querySelector: () => null,
    createElement: (tag) => ({
      tagName: tag,
      dataset: {},
      _text: '',
      set textContent(value) { this._text = value },
      get textContent() { return this._text },
    }),
    head: { appendChild: (node) => { record.styles.push(node) } },
  }
}

function createRequireStub(record) {
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
  const primitives = { Button: (props) => react.createElement('button', props), Switch: (props) => react.createElement('button', props), IconChevronDownOutline14: () => null, useAnchoredPosition: () => null, useDismissOnOutsidePointer: () => {} }
  const dom = { createRoot: () => ({ render: () => {}, unmount: () => {} }), createPortal: (children) => children }
  return (specifier) => {
    record.requires.push(specifier)
    switch (specifier) {
      case 'react': return react
      case 'react/jsx-runtime': return runtime
      case 'react-dom': return dom
      case 'react-dom/client': return dom
      case '@deepseek-ai/dsh-client-ui-primitives': return primitives
      default: throw new Error('undeclared platform module require: ' + specifier)
    }
  }
}

test('client bundle registers through queue/live facade', () => {
  const record = { requires: [], styles: [] }
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
    document: createDocumentStub(record),
    console,
    structuredClone,
    setTimeout,
    clearTimeout,
  })
  vm.runInContext(bundleSource, context, { filename: 'lib/client.js' })

  // 脚本执行只完成登记：queue 有一条、live registry 尚为空，factory 未物化，
  // 也没有提前注入样式或 require 任何平台模块。
  assert.equal(facade.pendingQueue.length, 1)
  assert.equal(facade.registry.length, 0)
  assert.deepEqual(record.requires, [], 'factory 物化前不得请求平台模块')
  assert.deepEqual(record.styles, [], 'factory 物化前不得注入样式')

  // Host create() 切到 live 并排空 queue。
  facade.create()
  assert.equal(facade.pendingQueue.length, 0)
  assert.equal(facade.registry.length, 1)
  assert.deepEqual(record.requires, [], '登记阶段不物化 factory')

  const exports = facade.registry[0].factory(createRequireStub(record))
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual([...exports.inject], [
    'locale',
    'slots',
    'settingsScope',
    'uiWorkspace',
    'remote',
    'remote.agentPresets',
    'remote.session',
    'sessions',
  ])

  // 实际 require 集合必须落在声明的平台模块表内（未声明即抛错，测试不会静默通过）。
  const declared = declaredClientExternals()
  const required = [...new Set(record.requires)].sort()
  assert.deepEqual(required, [
    '@deepseek-ai/dsh-client-ui-primitives',
    'react',
    'react-dom',
    'react/jsx-runtime',
  ], 'require 边必须是真实基座模块')
  for (const specifier of required) {
    assert.ok(declared.includes(specifier), `${specifier} 未在 tsdown CLIENT_EXTERNALS 声明`)
  }
  assert.ok(!record.requires.some((specifier) => specifier.includes('dsh-client-runtime')), 'rc.2 无 client-runtime 预载项')

  // CSS 只在 factory 内执行：物化后每个 CSS 模块注入一个 style 标签。
  assert.ok(record.styles.length > 0, 'CSS 必须在 factory 内注入')
  assert.ok(record.styles.every((node) => node.tagName === 'style' && node.dataset.pluginCss !== undefined), 'style 标签必须带 CSS 模块标识')
})

test('manifest 合同：bundle 只有 patch、client 面使用包名说明边', () => {
  assert.deepEqual(Object.keys(manifest.dsh.bundle), ['patch'], 'DshBundleManifest 只有 patch，不接受 requires 等私有扩展')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')

  // inject 是包名说明边，不是 Cordis 服务名；服务名由运行时 ctx.inject 负责。
  const serviceNames = ['slots', 'settingsScope', 'uiWorkspace', 'remote', 'remote.agentPresets', 'remote.session', 'sessions']
  for (const entry of manifest.dsh.client.inject) {
    assert.ok(entry.startsWith('@'), `inject 必须是包名：${entry}`)
    assert.ok(!serviceNames.includes(entry), `inject 不得混入服务名：${entry}`)
    assert.ok(manifest.peerDependencies[entry] !== undefined, `${entry} 缺少 peer 声明`)
  }
  for (const dependency of [
    '@deepseek-ai/dsh-client-connection',
    '@deepseek-ai/dsh-client-ui-renderer',
    '@deepseek-ai/dsh-client-ui-layout',
    '@deepseek-ai/dsh-client-ui-workspace',
    '@deepseek-ai/dsh-client-ui-settings-plugins',
    '@deepseek-ai/dsh-client-ui-settings',
    '@deepseek-ai/dsh-api-remotes',
    '@deepseek-ai/dsh-api-session-controller',
  ]) assert.ok(manifest.dsh.client.inject.includes(dependency), `${dependency} missing from dsh.client.inject`)

  // client 平台模块身份：基座用 @deepseek-ai/cordis，不再出现已删除的 client-runtime。
  const declared = declaredClientExternals()
  assert.ok(declared.includes('@deepseek-ai/cordis'), 'cordis 基座必须使用 @deepseek-ai/cordis 身份')
  assert.ok(!declared.includes('cordis'), '不再使用裸 cordis 名字')
  assert.ok(!declared.some((specifier) => specifier.includes('dsh-client-runtime')))
})
