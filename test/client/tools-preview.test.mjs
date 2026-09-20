import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { setImmediate } from 'node:timers/promises'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { WORKSPACE_PAGE_IDS, workspacePageMeta } from '../../src/client/app/workspace/workspace-pages.ts'
import { nextTabIndex } from '../../src/client/ui/tab-key.ts'
import { loadToolSurface } from '../../src/client/features/tools/tool-surface-request.ts'
import { SETTINGS_BRIDGE_PREFIX, BRIDGE_ENDPOINTS } from '../../src/shared/bridge-contract.ts'
import { PROMPT_TOOL_DICTS } from '../../src/client/locales.ts'

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const reactModules = Object.fromEntries(['react', 'react/jsx-runtime', 'react-dom'].map((name) => [name, import.meta.resolve(name)]))
// 仅内存转译 TSX / 映射 CSS；使用已安装的 React server renderer，不写生成文件。
const loader = registerHooks({
  resolve(specifier, context, nextResolve) {
    return reactModules[specifier] === undefined ? nextResolve(specifier, context) : { url: reactModules[specifier], shortCircuit: true }
  },
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) {
      const classes = Object.fromEntries([...readFileSync(new URL(url), 'utf8').matchAll(/\.([\w-]+)/g)].map((match) => [match[1], match[1]]))
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
const { ToolSurfaceList, ToolSurfaceView } = await import('../../src/client/features/tools/ToolSurfaceView.tsx')
const { ToolsPreviewPage } = await import('../../src/client/features/tools/ToolsPreviewPage.tsx')
const { CustomToolsCard } = await import('../../src/client/features/tools/CustomToolsCard.tsx')
const { WorkspaceNavigation } = await import('../../src/client/app/workspace/WorkspaceNavigation.tsx')
const { StatusBadge } = await import('../../src/client/ui/StatusBadge.tsx')
loader.deregister()

const render = (component, props) => renderToStaticMarkup(createElement(component, props))
/** 测试用命名空间翻译：读 zh 字典并做 {name} 插值（等价官方 Translate 的调用面，键缺失即失败）。 */
const t = (key, params) => {
  const template = PROMPT_TOOL_DICTS.zh[key]
  if (template === undefined) throw new Error(`missing locale key: ${key}`)
  return template.replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? ''))
}

test('工具预览是独立顶层 tab，键盘导航及 panel 关系完整', () => {
  assert.deepEqual(WORKSPACE_PAGE_IDS, ['features', 'subagent', 'tools', 'skills', 'presets', 'characters'])
  assert.equal(workspacePageMeta('tools').labelKey, 'page.tools.label')
  assert.equal(WORKSPACE_PAGE_IDS[nextTabIndex(WORKSPACE_PAGE_IDS.length, 1, 'ArrowRight')], 'tools')
  assert.equal(WORKSPACE_PAGE_IDS[nextTabIndex(WORKSPACE_PAGE_IDS.length, 3, 'ArrowLeft')], 'tools')
  const html = render(WorkspaceNavigation, { page: 'tools', onChange() {}, t })
  assert.match(html, /id="pt-workspace-tab-tools"[^>]*role="tab"[^>]*tabindex="0"[^>]*aria-selected="true"[^>]*aria-controls="pt-workspace-panel-tools"/)
  assert.match(read('src/client/app/workspace/PromptWorkspace.tsx'), /page === 'tools'[\s\S]*?<ToolsPreviewPage api=\{props\.api\}/)
})

test('编辑保留在主会话，工具预览没有保存或安装管理入口', () => {
  const edit = render(CustomToolsCard, { onNotice() {}, t })
  assert.match(edit, /自定义工具编辑/)
  assert.match(edit, /添加能力 \/ 工具模块/)
  assert.doesNotMatch(edit, /从模板新建|新建工具/)
  assert.doesNotMatch(edit, /当前会话工具|预设工具能力来源/)
  assert.match(read('src/client/app/workspace/pages/EngineLayersPanel.tsx'), /<CustomToolsCard/)
  for (const path of [
    'src/client/features/tools/CustomToolsCard.tsx',
    'src/client/app/workspace/pages/SubagentPage.tsx',
    'src/client/features/subagents/DelegationToolsCard.tsx',
  ]) assert.doesNotMatch(read(path), /<ToolSurfaceView|listAgentPresets|currentSessionId/)
  assert.match(read('src/client/features/tools/CustomToolsCard.tsx'), /if \(!active\) return/)
  assert.match(read('src/client/features/tools/CustomToolsCard.tsx'), /const cleanup = \(\): void => \{\s+active = false/)
  assert.match(read('src/client/features/tools/CustomToolsCard.tsx'), /return cleanup\s+\}, \[editor, revision\]\)/)
  for (const path of ['ToolsPreviewPage.tsx', 'ToolSurfaceView.tsx', 'tool-surface-request.ts']) {
    const source = read(`src/client/features/tools/${path}`)
    assert.doesNotMatch(source, /CustomToolCard|hiddenNames|bridgeCall\('customTools'|switchPreset|\.resume\(|PluginCard\.(?:tsx|module\.css)/)
  }
})

test('子代理仅保留实例策略解析，旧工具面标签、session 输入和渲染回调全部移除', () => {
  const policy = read('src/client/features/subagents/SubagentToolPolicyCard.tsx')
  const delegation = read('src/client/features/subagents/DelegationToolsCard.tsx')
  assert.doesNotMatch(policy + delegation, /renderToolSurface|currentSessionId|childSessionId|已运行子代理工具面|子代理 session id/)
  assert.match(policy, /t\('policy\.preview\.title'\)/, '预览标题必须来自 prompt-tool 字典')
  assert.match(PROMPT_TOOL_DICTS.zh['policy.preview.title'], /实例解析预览/)
  assert.match(policy, /bridgeCall\('subagentToolPolicyPreview', previewInput\)/)
  // 策略编辑器唯一入口 = 工具链层的层设置区资产分区；页面不再注入能力卡插槽，
  // 「工具与深度」卡只保留深度与入口提示，避免双入口。
  const chat = read('src/client/app/workspace/pages/MainSessionPage.tsx')
  const subagent = read('src/client/app/workspace/pages/SubagentPage.tsx')
  const panel = read('src/client/app/workspace/pages/EngineLayersPanel.tsx')
  assert.match(panel, /id === 'subagent-tool-policy' && \(\s*<SubagentToolPolicyCard/)
  assert.doesNotMatch(chat, /renderCapabilityExtra/)
  assert.doesNotMatch(subagent, /renderCapabilityExtra/)
  assert.match(delegation, /policy\.delegation\.policyMoved/)
  assert.doesNotMatch(delegation, /<SubagentToolPolicyCard/)
})

test('自定义工具按预设隔离，system 或关闭 writePreset 时禁用写入但保留展开与草稿身份', () => {
  const main = read('src/client/app/workspace/pages/MainSessionPage.tsx')
  // 编辑器由统一层装配入口在工具链层的设置区里渲染（两页共用一份）；页面只传创建意图与只读判定。
  assert.match(read('src/client/app/workspace/pages/EngineLayersPanel.tsx'), /id === 'custom-tools' && \(/)
  assert.match(main, /toolCreate,/)
  assert.match(main, /const canEditPreset = store\.fields\.writePreset && store\.moduleFacts\?\.editable === true/)
  // 只读边界由层设置内容统一下发（自定义工具编辑器与资产同源）。
  assert.match(read('src/client/app/workspace/pages/EngineLayersPanel.tsx'), /disabled=\{!canEditPreset\}/)
  const source = read('src/client/features/tools/CustomToolsCard.tsx')
  const html = render(CustomToolsCard, { disabled: true, onNotice() {}, t })
  assert.match(html, /当前预设工具只读/)
  assert.match(html, /<fieldset[^>]*aria-label="自定义工具配置"/)
  assert.match(source, /const disabled = props\.disabled === true \|\| loading \|\| loadError\.length > 0/)
  assert.doesNotMatch(source, /<fieldset[^>]*\bkey=/, '只读切换不能重挂工具草稿')
  assert.match(source, /disabled=\{disabled\}/, '只读边界下发给每张卡')
  // 只读边界下移到卡内：卡头操作区与表单各为 fieldset，折叠按钮留在边界外保持可点。
  const editor = read('src/client/features/tools/CustomToolEditor.tsx')
  assert.match(editor, /<fieldset className=\{styles\.cardScopeActions\} disabled=\{props\.disabled === true\}>/)
  assert.match(editor, /<fieldset className=\{styles\.configForm\} disabled=\{props\.disabled === true\}>/)
  const toggle = editor.slice(editor.indexOf('configToggle'), editor.indexOf('configHeaderActions'))
  assert.doesNotMatch(toggle, /disabled=\{props\.disabled/, '折叠按钮不得进入只读边界')
  assert.match(source, /props\.createIntent/)
  assert.match(source, /if \(disabled\) return/)
  assert.match(source, /const save = \(\): void => \{\s+if \(disabled \|\| editor\.saving\) return/)
  assert.match(source, /const updateTools = \(next: ToolDraft\[\]\): void => \{\s+if \(!disabled\) setTools\(next\)/)
  assert.equal((source.match(/\bsetTools\(/g) ?? []).length, 2, '只有初始加载和受保护的编辑入口可更新工具草稿')
})

test('官方目录式搜索、可折叠分组与标题右侧预设选择；不再嵌套 tabs', () => {
  const snapshot = { sessionId: 'current-session', selectable: true }
  const html = render(ToolsPreviewPage, {
    api: { sessionModel: { subscribe() { return () => {} }, snapshot: () => snapshot }, listAgentPresets() { throw new Error('当前会话视角不得加载预设') } },
    t,
  })
  assert.match(html, /aria-label="搜索工具"/)
  assert.match(html, /aria-label="当前会话工具"/)
  assert.match(html, /aria-label="预设工具能力"/)
  assert.match(html, /aria-label="预设工具能力来源"/)
  assert.match(read('src/client/features/tools/ToolSurfaceView.tsx'), /<StatusBadge tone="success" label=\{t\('tools\.surface\.badge\.visible'\)\} \/>/)
  assert.equal((html.match(/class="toolGroupToggle" aria-expanded="true"/g) ?? []).length, 2)
  assert.doesNotMatch(html, /role="tablist"|role="tabpanel"/)
  assert.ok(html.indexOf('搜索工具') < html.indexOf('当前会话工具'))
  assert.match(html, /current-session/)
  assert.match(html, /冻结 generation/)
  assert.match(html, /不会自动 resume 会话/)
  assert.match(html, /刷新预设列表/)
  const preset = render(ToolSurfaceView, { presetId: 'next-preset', label: '预设工具能力', t })
  assert.match(preset, /后续 generation/)
  assert.match(preset, /不代表当前会话/)
  assert.match(preset, /next-preset/)
  assert.doesNotMatch(preset, /current-session/)
  const source = read('src/client/features/tools/ToolsPreviewPage.tsx')
  assert.match(source, /useSyncExternalStore\(face\.subscribe, face\.snapshot, face\.snapshot\)/)
  assert.match(source, /query=\{query\}/)
  assert.match(read('src/client/features/tools/ToolSurfaceView.tsx'), /<ToolSurfaceContent key=\{key\}/)
})

test('完整显示所有工具：同名自定义、第三方、空描述与长列表均不隐藏', () => {
  const tools = [
    { name: 'custom_tool', description: '编辑卡同名工具' },
    { name: 'mcp_tool', description: '第三方工具' },
    { name: 'empty_description', description: '' },
    { name: 'custom_tool', description: '<script>alert(1)</script>\n第二行' },
    ...Array.from({ length: 120 }, (_, index) => ({ name: `tool_${index}`, description: '工具描述' })),
  ]
  const html = render(ToolSurfaceList, { tools, filter: '', t })
  assert.equal((html.match(/data-tool-card="true"/g) ?? []).length, tools.length)
  assert.equal((html.match(/aria-label="查看工具 custom_tool"/g) ?? []).length, 2)
  assert.match(html, /mcp_tool/)
  assert.match(html, /显示 124 \/ 124 个工具/)
  const expanded = render(ToolSurfaceList, { tools, filter: '', expandedName: 'custom_tool', sourceLabel: '当前会话工具', sourceId: 'session-a', t })
  assert.match(expanded, /&lt;script&gt;alert\(1\)&lt;\/script&gt;\n第二行/)
  assert.match(expanded, /<dl class="toolFacts">/)
  assert.match(expanded, /完整名称/)
  assert.match(expanded, /模型可见/)
  assert.match(expanded, /class="badge"[\s\S]*?class="dot" data-tone="success"[\s\S]*?class="tag" data-tone="success">模型可见</)
  assert.match(expanded, /session-a/)
  assert.doesNotMatch(expanded, /运行中|已启用|配置状态|fiberPhase/)
  assert.match(render(ToolSurfaceList, { tools, filter: '', expandedName: 'empty_description', t }), /（无描述）/)
  assert.doesNotMatch(html, /<script>/)
  assert.doesNotMatch(read('src/client/features/tools/tools.module.css'), /max-height:|line-clamp/)
})

test('工具卡双列网格按页面容器收为单列，并保留键盘展开属性', () => {
  const css = read('src/client/features/tools/tools.module.css')
  assert.match(css, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/)
  assert.match(css, /\.toolsPreviewPage\s*\{[^}]*container: tool-preview \/ inline-size/)
  assert.match(css, /@container tool-preview \(max-width: 680px\)\s*\{\s*\.toolSurfaceCards\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\)/)
  assert.match(css, /\.toolCardToggle:focus-visible/)
  const closed = render(ToolSurfaceList, { tools: [{ name: 'read', description: '读取' }], filter: '', t })
  assert.match(closed, /aria-expanded="false" aria-controls=/)
  assert.doesNotMatch(closed, /<dl/)
  const open = render(ToolSurfaceList, { tools: [{ name: 'read', description: '读取' }], filter: '', expandedName: 'read', t })
  assert.match(open, /aria-expanded="true" aria-controls=/)
  assert.match(open, /<dl/)
})

test('状态胶囊统一复用 StatusBadge：StatusDot + 官方 Tag', () => {
  const dot = read('src/client/ui/StatusDot.tsx')
  assert.match(dot, /data-tone=\{props\.tone\}/)
  assert.match(dot, /aria-hidden="true"/)
  const dotCss = read('src/client/ui/StatusDot.module.css')
  assert.match(dotCss, /background: var\(--status-dot\)/)
  assert.match(dotCss, /box-shadow: 0 0 0 3px color-mix/, '状态点按用户反馈保留柔和静态光晕')
  assert.doesNotMatch(dotCss, /animation:|@keyframes/, '状态点不使用循环动画')
  const badge = read('src/client/ui/StatusBadge.tsx')
  assert.match(badge, /import \{ StatusDot, type StatusDotTone \} from '\.\/StatusDot\.tsx'/)
  assert.match(badge, /<StatusDot tone=\{props\.tone\} \/>/)
  assert.match(badge, /<Tag tone=\{props\.tone\}>\{props\.label\}<\/Tag>/)
  assert.match(render(StatusBadge, { tone: 'success', label: '使用中', className: 'slot' }), /class="badge slot"[\s\S]*?class="dot" data-tone="success"[\s\S]*?class="tag" data-tone="success">使用中</)
  for (const path of [
    'src/client/features/tools/ToolSurfaceView.tsx',
    'src/client/features/skills/SkillRow.tsx',
    'src/client/features/presets/PresetSwitcher.tsx',
    'src/client/features/characters/CharactersPage.tsx',
  ]) {
    assert.match(read(path), /from '\.\.\/\.\.\/ui\/StatusBadge\.tsx'/, `${path} 应复用共享状态徽章`)
  }
  assert.match(read('src/client/features/presets/PresetSwitcher.tsx'), /<StatusBadge className=\{styles\.presetHeadBadge\} tone="success" label=\{t\('presetSwitcher\.badge\.active'\)\} \/>/)
  assert.match(read('src/client/features/characters/CharactersPage.tsx'), /<StatusBadge className=\{ui\.presetHeadBadge\} tone="success" label=\{t\('characters\.badge\.imported'\)\} \/>/)
  assert.doesNotMatch(read('src/client/ui/controls.module.css'), /presetInUse/)
  assert.match(read('src/client/app/workspace/WorkspaceFrame.tsx'), /<StatusDot tone=\{store\.loading \? 'neutral' : 'success'\}[^>]*\/>/)
  assert.doesNotMatch(read('src/client/app/workspace/PromptWorkspace.module.css'), /\.statusDot|pt-pulse/)
  assert.doesNotMatch(read('src/client/features/tools/tools.module.css'), /toolVisibleDot/)
  assert.doesNotMatch(read('src/client/ui/controls.module.css'), /skillStatusChip|skillStatusDot/)
})

test('搜索只过滤名称或描述，空列表与无匹配状态分开', () => {
  const tools = [{ name: 'Read_File', description: '读取文件' }, { name: 'other', description: 'Read docs' }]
  assert.equal((render(ToolSurfaceList, { tools, filter: ' READ ', t }).match(/data-tool-card=/g) ?? []).length, 2)
  assert.match(render(ToolSurfaceList, { tools, filter: '文件', t }), /显示 1 \/ 2 个工具/)
  assert.match(render(ToolSurfaceList, { tools, filter: 'missing', t }), /无匹配工具/)
  assert.match(render(ToolSurfaceList, { tools: [], filter: '', t }), /该来源暂无可见工具/)
  assert.match(render(ToolSurfaceView, { sessionId: '', label: '当前会话工具', t }), /尚未选择当前会话/)
  assert.match(render(ToolSurfaceView, { presetId: '', label: '预设工具能力', t }), /请选择预设/)
})

test('来源切换、刷新及卸载均丢弃过期成功和失败响应，bridge 载荷不变', async (t) => {
  const requests = []
  t.mock.method(globalThis, 'fetch', (url, init) => new Promise((resolve) => requests.push({ url, body: JSON.parse(init.body), resolve })))
  const received = []
  const receive = (result) => received.push(result)
  const finish = async (index, result) => {
    requests[index].resolve(Response.json(result))
    await setImmediate()
  }
  const success = (source, name) => ({ ok: true, value: { source: 'presetId' in source ? 'preset' : 'session', ...source, tools: [{ name, description: '' }] } })
  const sources = [{ sessionId: 'same-id' }, { presetId: 'same-id' }, { presetId: 'next' }, { presetId: 'next' }, { sessionId: 'last' }]
  let cancel = loadToolSurface(sources[0], receive)
  for (const source of sources.slice(1)) {
    cancel()
    cancel = loadToolSurface(source, receive)
  }
  await finish(4, success(sources[4], 'latest'))
  for (const index of [3, 1, 0]) await finish(index, success(sources[index], 'stale'))
  await finish(2, { ok: false, message: '过期错误' })
  assert.deepEqual(received, [success(sources[4], 'latest')])
  cancel()
  const unmount = loadToolSurface({ sessionId: 'unmounted' }, receive)
  unmount()
  await finish(5, success({ sessionId: 'unmounted' }, 'ignored'))
  assert.equal(received.length, 1)
  assert.deepEqual(requests.slice(0, 5).map((request) => request.body), sources)
  assert.ok(requests.every((request) => request.url === SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.toolSurface))
})

test('无来源不发请求，当前请求的网络失败与重试结果可达', async (t) => {
  const received = []
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline') })
  loadToolSurface({ sessionId: '' }, (result) => received.push(result))()
  loadToolSurface({ presetId: '' }, (result) => received.push(result))()
  await setImmediate()
  assert.equal(fetch.mock.callCount(), 0)
  const cancel = loadToolSurface({ sessionId: 'cold' }, (result) => received.push(result))
  await setImmediate()
  assert.deepEqual(received, [{ ok: false, message: 'offline' }])
  cancel()
  fetch.mock.mockImplementation(async () => Response.json({ ok: true, value: { source: 'session', sessionId: 'cold', tools: [] } }))
  const retry = loadToolSurface({ sessionId: 'cold' }, (result) => received.push(result))
  await setImmediate()
  assert.equal(received.at(-1).ok, true)
  retry()
})
