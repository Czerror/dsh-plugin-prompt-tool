/**
 * 宿主与发布契约（2026-09-17 测试归一精简 Wave 3）。
 *
 * 由四个同主题文件合并而成，覆盖「插件如何装配进宿主、以及发布产物与清单声明什么」：
 * 1. host-contract.test.mjs      —— 0.1.5 官方 slot 面、版本基线、五层注入时序、已删除 API 禁令；
 * 2. declaration-bundle.test.mjs —— 分发 .d.mts 的类型来源、外部导入的依赖声明、与官方服务双向可赋值；
 * 3. client-bundle-facade.test.mjs —— lib/client.js 的 queue/live facade 注册与 manifest 清单合同；
 * 4. client/slot-workbench-contract.test.mjs —— 工作台注册面、抽屉置顶、/meta 读取与技能目录入口。
 *
 * 三者共用同一份 package.json 与源码读取基准（仓库根 = `../`），合并后只保留一套顶层常量。
 * 本文件是「契约」性质：结构、清单、依赖边与禁令类断言保持源码形式；
 * 其中真实执行 bundle（vm）与真实编译声明（ts.createProgram）的部分是行为断言，
 * 两者都不得互相改写。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

const root = fileURLToPath(new URL('../', import.meta.url))
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const manifest = JSON.parse(read('package.json'))
const register = read('src/client/app/workbench/register-workbench.tsx')
const settings = read('src/client/app/workbench/SettingsTab.tsx')
const entry = read('src/client/index.ts')
const layers = read('engine/layers.mjs')
const workspace = read('src/client/app/workspace/PromptWorkspace.tsx')
const skillsSettings = read('src/client/features/skills/SkillsPage.tsx')
const source = [register, settings].join('\n')
const PLUGIN_ID = 'dsh-plugin-prompt-tool'
const bundleSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const tsdownSource = readFileSync(new URL('../tsdown.config.ts', import.meta.url), 'utf8')
const declarations = readdirSync(join(root, 'lib')).filter((file) => file.endsWith('.d.mts'))
  .map((file) => ts.createSourceFile(file, readFileSync(join(root, 'lib', file), 'utf8'), ts.ScriptTarget.Latest, true))

function sourceFiles(relative) {
  const files = []
  const walk = (url, prefix) => {
    for (const item of readdirSync(url, { withFileTypes: true })) {
      if (item.isDirectory()) walk(new URL(`${item.name}/`, url), `${prefix}${item.name}/`)
      else if (/\.(?:ts|tsx|mjs)$/.test(item.name)) files.push([`${prefix}${item.name}`, readFileSync(new URL(item.name, url), 'utf8')])
    }
  }
  walk(new URL(`../${relative}/`, import.meta.url), `${relative}/`)
  return files
}

// ═══ 一、DSH 宿主契约（原 host-contract.test.mjs） ═══
// 0.1.5 相对 0.1.3 的破坏性变化：conversation.details.tool slot 与 session.events 数组移除；
// PTC 事件由 tool/code-dispatch 改名为 tool/ptc-dispatch。本节锁定插件只消费现存契约
// （shell.overlay 由 ui-layout 声明；官方右侧栏与 sidebar.footer.action 几何探针都已移除）。

test('客户端只注册 0.1.5 官方 slot 面：settings.plugins.tab + shell.overlay 可拖动悬浮入口', () => {
  assert.ok(register.includes("ctx.slots.inject('settings.plugins.tab'"), 'settings tab 注册缺失')
  assert.match(register, /name: 'settings\.plugins\.tab', id: 'prompt-tool'/)
  // 悬浮入口：shell.overlay 触发器/抽屉；右侧栏与几何探针都已移除。
  assert.match(register, /ctx\.slots\.inject\('shell\.overlay'/)
  assert.doesNotMatch(register, /footer\.action/, '不再占用 sidebar footer 做几何探针')
  assert.doesNotMatch(register, /sidebarRightTabs|sidebar\.right\.pane\.tab|conversation\.details/)
  assert.doesNotMatch(entry, /'sidebarRightTabs'/, '客户端 inject 不应等待已移除的 tab registry')
  assert.match(entry, /'slots'/)
})

test('版本声明对齐 package.json 的官方开发基线，且 bundle 依赖边包含悬浮入口所需包', () => {
  // 基线只从 manifest 派生：官方版本升级时改 package.json 一处，不在这里重复写死。
  const baseline = manifest.devDependencies['@deepseek-ai/dsh-agent']
  assert.match(baseline, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, '主基线必须是精确 semver')
  for (const [name, range] of Object.entries(manifest.peerDependencies)) {
    if (!name.startsWith('@deepseek-ai/dsh-')) continue
    assert.equal(range, `^${baseline}`, `peerDependencies.${name} 应声明 ^${baseline}`)
  }
  for (const [name, range] of Object.entries(manifest.devDependencies)) {
    if (!name.startsWith('@deepseek-ai/dsh-')) continue
    assert.equal(range, baseline, `devDependencies.${name} 应精确锁定 ${baseline}`)
  }
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-layout'))
  assert.ok(!manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-sidebar-right'), '官方右侧栏已移除')
  assert.ok(!manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-sidebar'), '几何探针下线后不再消费宿主侧栏 slot')
  assert.ok(manifest.peerDependencies['@deepseek-ai/dsh-client-ui-layout'] !== undefined)
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-client-ui-sidebar'], undefined, 'ui-sidebar 已无消费方')
  assert.ok(manifest.peerDependencies['@deepseek-ai/dsh-client-ui-slots'] !== undefined)
})

test('引擎接线保持 0.1.5 注入时序：非 pre-step 五层按声明顺序接入', () => {
  const order = ['wireSystemSections', 'wireRuntimeContexts', 'wireAgentRequests', 'wireLlmStreams', 'wireToolPipelines']
    .map((name) => layers.indexOf(`  ${name}(ctx,`))
  assert.ok(order.every((index) => index > 0), '五层接线缺失')
  assert.deepEqual([...order].sort((a, b) => a - b), order, '五层接线顺序必须保持')
  assert.match(
    layers,
    /ctx\.on\('agent\/request', async \(payload, next\) => \{\s*const base = await next\(\)/,
    'agent/request 必须先结算下游（assembly 已就绪）再合并 patch',
  )
})

test('源码不引用 0.1.5 已删除或改名的宿主 API', () => {
  for (const [file, source] of [...sourceFiles('engine'), ...sourceFiles('src')]) {
    assert.doesNotMatch(source, /tool\/code-dispatch/, `${file} 仍引用已改名的 PTC 事件`)
    assert.doesNotMatch(source, /conversation\.details\.tool/, `${file} 仍引用已删除的详情 slot`)
    assert.doesNotMatch(source, /session\.events\b/, `${file} 仍读取已移除的 session.events 数组`)
  }
})

// ═══ 二、分发声明契约（原 declaration-bundle.test.mjs） ═══
// 验证实际分发声明，不用 src 类型检查替代发布产物的类型契约。

test('发布声明引用官方 SDK 类型，不把宿主相对模块扩充搬入插件', () => {
  const entryDeclaration = declarations.find((file) => file.fileName === 'index.d.mts')
  const imports = entryDeclaration.statements.filter(ts.isImportDeclaration).map((node) => node.moduleSpecifier.text)
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

// ═══ 三、client bundle facade 与清单合同（原 client-bundle-facade.test.mjs） ═══
// 验证 lib/client.js 与 client-modules 的 queue/live facade 契约。

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

// ═══ 四、工作台 slot 契约（原 client/slot-workbench-contract.test.mjs） ═══

test('工作台只注册 shell.overlay 可拖动悬浮入口 + 基础设置，且不碰宿主 DOM', () => {
  assert.match(register, /name: 'settings\.plugins\.tab', id: 'prompt-tool'/)
  assert.match(register, /name: 'shell\.overlay', id: 'prompt-tool-workbench'/)
  assert.doesNotMatch(register, /footer\.action|floating-geometry/, '入口位置不再依赖宿主侧栏几何')
  assert.doesNotMatch(register, /sidebarRightTabs|sidebar\.right\.pane\.tab|guide: \[\{/)
  assert.doesNotMatch(source, /createPortal|createRoot|MutationObserver|querySelector/)
  assert.doesNotMatch(source, /dsh-panel-activate/)
  assert.doesNotMatch(source, /class\*|data-pane|centerCol|logoRow|newSession/)
})

test('PromptWorkspace 由悬浮入口 controller 驱动加载', () => {
  assert.match(workspace, /controller: PromptToolWorkspaceController/)
  assert.match(workspace, /props\.controller\.subscribe/)
  assert.match(workspace, /if \(open\) void store\.load\(\)/)
})

test('client service and bundle injection edges cover the overlay/settings declarations', () => {
  assert.match(entry, /'slots'/)
  assert.doesNotMatch(entry, /sidebarRightTabs/)
  for (const dependency of [
    '@deepseek-ai/dsh-client-ui-renderer',
    '@deepseek-ai/dsh-client-ui-layout',
    '@deepseek-ai/dsh-client-ui-settings-plugins',
    '@deepseek-ai/dsh-client-ui-workspace',
  ]) {
    assert.ok(manifest.dsh.client.inject.includes(dependency), dependency + ' missing from dsh.client.inject')
    assert.ok(manifest.peerDependencies[dependency] !== undefined, dependency + ' missing from peerDependencies')
  }
})

test('悬浮入口抽屉经 body portal 置顶，不受宿主导航栏遮挡', () => {
  const overlay = read('src/client/app/workbench/WorkbenchOverlay.tsx')
  const css = read('src/client/app/workbench/Workbench.module.css')
  assert.match(overlay, /createPortal\(trigger, document\.body\)/)
  assert.match(overlay, /createPortal\(drawer, document\.body\)/)
  assert.match(css, /\.drawerLayer\s*\{[^}]*position:\s*fixed[^}]*z-index:\s*1000/s)
  assert.match(css, /\.floatingTriggerLayer\s*\{[^}]*position:\s*fixed[^}]*z-index:\s*1100/s)
  assert.match(overlay, /aria-modal="true"/)
})

test('/meta 预设下拉读 value.meta（不是顶层 meta 扩展字段）', () => {
  assert.match(settings, /const meta = res\.value\.meta as/)
  assert.match(settings, /meta\.presets/)
  assert.doesNotMatch(settings, /res\.meta\?\.meta/)
})

test('技能页展示受管实体库位置，不再维护可添加/移除的目录引用', () => {
  assert.match(skillsSettings, /const entityRoot = libraryRoot === undefined \? undefined : `\$\{libraryRoot\}\\\\\.system`/)
  assert.match(skillsSettings, /t\('skills\.library\.title'\)/)
  assert.match(skillsSettings, /t\('skills\.library\.open'\)/)
  assert.doesNotMatch(skillsSettings, /addSkillsDir|removeSkillsDir|displaySkillsDirs/, '目录引用入口已下线（外部目录只作一次性导入来源）')
  assert.doesNotMatch(skillsSettings, /skills\.dirs\.(title|meta|add|empty|pick')/, '目录引用文案不再被引用（导入相关文案保留）')
})

test('技能页同时提供宿主机目录导入与浏览器文件夹导入', () => {
  assert.match(skillsSettings, /api\.pickDirectory\(\)/)
  assert.match(skillsSettings, /t\('skills\.import\.pick'\)/)
  assert.match(skillsSettings, /store\.importSkillsDirectory\(/)
  assert.match(skillsSettings, /label=\{t\('skills\.dirs\.import'\)\}/)
  assert.match(skillsSettings, /\bdirectory\b/, '技能页仍应保留文件夹导入入口')
})
