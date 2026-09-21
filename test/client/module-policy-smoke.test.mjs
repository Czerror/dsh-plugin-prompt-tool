// 合并自 module-creation-browser.test.mjs 与 subagent-policy-browser.test.mjs
//（2026-09-17 测试归一精简 Wave 3 / C3a-S2）：两者同属「能力卡与子代理策略卡」主题，
// 原本各抄一份 Edge 启动 + CDP 样板。合并后共用一套基础设施：一个 server 提供各自路由、
// 一个 Edge 实例顺序服务两条用例，每条用例自己 navigate 到自己的 fixture 页面
//（页面导航会重建 JS 上下文，两个 fixture 的 window 状态因此互不串）。
//
// 清理采用 subagent-policy 版本的 Browser.close + 等待退出（比 module-creation 的
// kill + 固定 sleep 更干净），以消除此前在 Windows 上出现过的 profile 目录 EPERM。
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { getEngineMeta } from '../../engine/schema.mjs'
import { SUBAGENT_TOOL_POLICY_SKELETON } from '../../src/shared/engine-capabilities.ts'
import { validateSubagentToolPolicy } from '../../engine/subagent-tool-policy-core.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(new URL('../../package.json', import.meta.url))
const browserPath = process.env.PROMPT_TOOL_TEST_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const skipBrowser = !existsSync(browserPath) && '设置 PROMPT_TOOL_TEST_BROWSER 以运行真实浏览器回归'

let server
let browser
let browserExit
let ws
let send
let evaluate
let waitFor
let waitForPolicy
let click
let edit
let blur
let settleWrite
let navigate
let profile
/** 文件 1 的 fixture（引擎元数据 + 模板库），其用例内按需读取模板条目。 */
let fixture

before(async () => {
  if (skipBrowser !== false) return
  const { rolldown } = await import(pathToFileURL(createRequire(require.resolve('tsdown')).resolve('rolldown')))
  const { parse } = require('yaml')
  const ts = require('typescript')
  const list = (path) => readdirSync(path).filter((file) => file.endsWith('.yml')).map((file) => ({ file, spec: parse(readFileSync(join(path, file), 'utf8')) }))
  fixture = { meta: getEngineMeta(), templates: { templates: list(join(root, 'templates')), toolTemplates: list(join(root, 'templates/tools')) } }
  /** 两个成员各自的 rolldown 插件（除 name 外逐字相同）。 */
  const isolatedUi = (name) => ({
    name,
    resolveId(source) {
      if (['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'].includes(source)) return require.resolve(source)
      if (source.endsWith('.css')) return '\0test-css:' + source + '.mjs'
    },
    // 此用例验证事件、effect 与状态，不以虚拟 CSS 宣称像素/布局验收。
    load(id) { if (id.startsWith('\0test-css:')) return 'export default new Proxy({}, {get:(_,key)=>key})' },
    transform(code, id) { if (id.endsWith('.tsx')) return ts.transpileModule(code, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2024 } }).outputText },
  })
  const bundleFor = async (entry, pluginName) => {
    const bundle = await rolldown({ input: join(root, entry), platform: 'browser',
      transform: { define: { 'process.env.NODE_ENV': JSON.stringify('production'), 'process.env': '{}', 'import.meta.env': '{}' } },
      plugins: [isolatedUi(pluginName)],
    })
    try {
      const { output } = await bundle.generate({ format: 'iife' })
      return output.find((item) => item.type === 'chunk').code
    } finally { await bundle.close() }
  }
  const moduleJs = await bundleFor('test/fixtures/module-workbench.mjs', 'isolated-ui-test')
  const policyJs = await bundleFor('test/fixtures/subagent-policy.mjs', 'isolated-policy-ui')
  const moduleHtml = `<!doctype html><meta charset="utf-8"><div id="root"></div><script>window.fixture=${JSON.stringify(fixture)}</script><script src="/module.js"></script>`
  // 策略 fixture 需要卡片之外的焦点目标来触发失焦保存。
  const policyHtml = '<!doctype html><meta charset="utf-8"><div id="root"></div><button id="outside">outside</button><script src="/policy.js"></script>'
  server = createServer((req, res) => {
    const isScript = req.url === '/module.js' || req.url === '/policy.js'
    res.setHeader('Content-Type', isScript ? 'text/javascript' : 'text/html')
    if (req.url === '/module.js') res.end(moduleJs)
    else if (req.url === '/policy.js') res.end(policyJs)
    else if (req.url === '/policy') res.end(policyHtml)
    else res.end(moduleHtml)
  }).listen(0, '127.0.0.1')
  await new Promise((done) => server.on('listening', done))
  profile = mkdtempSync(join(tmpdir(), 'pt-module-policy-browser-'))
  browser = spawn(browserPath, ['--headless=new', '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' })
  browserExit = new Promise((done) => browser.once('exit', done))
  const portFile = join(profile, 'DevToolsActivePort')
  let port
  for (let i = 0; i < 150; i++) {
    try {
      const candidate = readFileSync(portFile, 'utf8').split('\n')[0].trim()
      if (/^\d+$/.test(candidate)) { port = candidate; break }
    } catch (error) {
      if (!['ENOENT', 'EBUSY'].includes(error.code)) throw error
    }
    await sleep(100)
  }
  assert.ok(port, '等待浏览器写完 DevToolsActivePort')
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  ws = new WebSocket(pages.find((page) => page.type === 'page').webSocketDebuggerUrl)
  await new Promise((done) => ws.addEventListener('open', done, { once: true }))
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', ({ data }) => {
    const msg = JSON.parse(data)
    if (!msg.id) return
    const request = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) request.reject(msg.error)
    else request.resolve(msg.result)
  })
  send = (method, params = {}) => new Promise((resolve, reject) => { pending.set(++id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })) })
  evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  // 两个成员原本的等待预算不同（100×50ms / 60×25ms），各自保留，避免改动任一成员的等待语义。
  waitFor = async (expression) => {
    for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await sleep(50) }
    assert.fail(`等待超时：${expression}\n${await evaluate('document.body.innerText')}`)
  }
  waitForPolicy = async (expression) => {
    for (let i = 0; i < 60; i++) { if (await evaluate(expression)) return; await sleep(25) }
    assert.fail(`等待超时：${expression}`)
  }
  click = async (text) => {
    assert.equal(await evaluate(`(()=>{const button=[...document.querySelectorAll('button')].find(e=>e.getClientRects().length&&e.textContent.trim()===${JSON.stringify(text)});if(!button)return false;button.click();return true})()`), true, text)
    await sleep(50)
  }
  edit = async (selector, value) => {
    await evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});input.focus();input.select();return true})()`)
    await send('Input.insertText', { text: value })
  }
  blur = () => evaluate('document.querySelector("#outside").focus(); true')
  settleWrite = async () => {
    await evaluate('window.pendingWrites.shift()(); true')
    await sleep(70)
  }
  navigate = async (path) => { await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}${path}` }) }
})

after(async () => {
  if (skipBrowser !== false) return
  if (send && ws?.readyState === WebSocket.OPEN) await send('Browser.close').catch(() => {})
  else browser.kill()
  await browserExit
  ws?.close()
  await new Promise((done) => server.close(done))
  assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep))
  rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })
})

async function openLayerSettings(layer, label) {
  if (label !== undefined) {
    await evaluate(`document.querySelector('[aria-label="按层级或策略过滤"]').click()`)
    await sleep(50)
    await click(`层级：${label}`)
  }
  if (await evaluate(`document.querySelector('[data-layer-settings-content="${layer}"]') !== null`)) return
  const id = await evaluate(`window.store.fields.promptConfigs.find(config=>config.layer==='${layer}' && document.querySelector('[data-config-id="'+config.id+'"]'))?.id`)
  assert.ok(id, `${layer} 必须先显式加载真实提示词规则`)
  const card = `[data-config-id="${id}"]`
  await evaluate(`(()=>{const button=document.querySelector('${card} header button[aria-expanded]');if(button?.getAttribute('aria-expanded')==='false')button.click()})()`)
  await waitFor(`document.querySelector('${card} [data-layer-settings="${layer}"]') !== null`)
  await evaluate(`(()=>{const details=document.querySelector('${card} [data-layer-settings="${layer}"]');if(!details.open)details.querySelector('summary').click()})()`)
  await waitFor(`document.querySelector('[data-layer-settings-content="${layer}"]') !== null`)
}

async function createInLayer(layer, label, item) {
  await openLayerSettings(layer, label)
  await evaluate(`document.querySelector('[data-engine-create-layer="${layer}"] button[aria-haspopup="menu"]').click()`)
  await sleep(50)
  await click(item)
}

test('浏览器：空提示词列表即使有引擎参数，全部、层筛选与搜索都不生成额外卡片', { skip: skipBrowser, timeout: 30000 }, async () => {
  for (const page of ['main', 'subagent']) {
    await navigate('/')
    await waitFor('window.store?.moduleFacts?.editable === true')
    await evaluate(`window.selectPage('${page}'); window.store.patch({promptConfigs:[],modelTemperature:'0.7',subagentTemperature:'0.9'})`)
    await waitFor('document.querySelectorAll("[data-config-id]").length === 0')
    const writes = await evaluate(`window.requests.filter(r=>r.endpoint==='param-overrides').length`)
    for (const view of ['全部', '层级：代理请求', '层级：工具链', '层级：子代理启动层']) {
      await evaluate(`document.querySelector('[aria-label="按层级或策略过滤"]').click()`)
      await click(view)
      for (const keyword of ['', 'modelTemperature', 'subagentTemperature', '自定义工具']) {
        await edit('input[type="search"]', keyword)
        assert.equal(await evaluate('document.querySelectorAll("article").length'), 0, `${page} / ${view} / ${keyword} 不派生卡片`)
        assert.deepEqual(await evaluate('window.store.fields.promptConfigs'), [])
      }
      await edit('input[type="search"]', '')
    }
    assert.equal(await evaluate(`window.requests.filter(r=>r.endpoint==='param-overrides').length`), writes, '过滤与搜索不保存')
  }
})

test('浏览器：真实模板实例内编辑各层引擎参数，保存不创建提示词规则', { skip: skipBrowser, timeout: 60000 }, async () => {
  for (const page of ['main', 'subagent']) {
    await navigate('/')
    await waitFor('window.store?.moduleFacts?.editable === true')
    await evaluate(`window.loadPromptTemplates(['40-agent-request.yml','60-tool-pipeline.yml','66-subagent-start.yml'])`)
    await evaluate(`window.selectPage('${page}')`)
    const configs = await evaluate('window.store.fields.promptConfigs')
    for (const layer of ['agent-request', 'tool-pipeline', 'subagent-start']) {
      await waitFor(`document.querySelector('[data-config-id="example-${layer}"]') !== null`)
      assert.equal(await evaluate(`document.querySelectorAll('[data-config-id="example-${layer}"]').length`), 1)
      assert.equal(await evaluate(`document.querySelector('[data-config-id="example-${layer}"] header button[aria-expanded]').getAttribute('aria-expanded')`), 'false')
      assert.equal(await evaluate(`document.querySelector('[data-layer-settings-content="${layer}"]') === null`), true)
    }
    assert.equal(await evaluate(`document.querySelector('[data-layer-config], [data-layer-settings-standalone]') === null`), true)
    assert.equal(await evaluate(`document.querySelector('[data-config-id="example-subagent-start"]').textContent.includes('子代理通用守则')`), true)
    assert.equal(await evaluate(`document.querySelector('[aria-label="按层级或策略过滤"]').textContent.trim()`), '全部')
    assert.equal(await evaluate(`window.requests.some(r=>r.endpoint==='param-overrides')`), false, '读取规则不保存')
    for (const [layer, asset, key, value] of [
      ['agent-request', 'main-model', 'modelTemperature', '0.7'],
      ['subagent-start', 'subagent-model', 'subagentTemperature', '0.9'],
    ]) {
      await openLayerSettings(layer)
      await evaluate(`document.querySelector('[data-layer-asset="${asset}"] button[aria-expanded]').click()`)
      const input = `[data-layer-asset="${asset}"] [aria-label="采样温度"]`
      await waitFor(`document.querySelector('${input}') !== null`)
      assert.equal(await evaluate(`document.querySelectorAll('${input}').length`), 1)
      assert.equal(await evaluate(`document.querySelector('${input}').disabled`), false)
      await edit(input, value)
      await evaluate(`document.querySelector('${input}').blur()`)
      await waitFor(`window.requests.some(r=>r.endpoint==='param-overrides' && r.body.overrides?.${key} === '${value}')`)
    }
    await evaluate(`document.querySelector('[data-config-id="example-subagent-start"] [data-layer-asset="subagent-tools"] button[aria-expanded]').click()`)
    await waitFor(`document.querySelector('[data-config-id="example-subagent-start"] [data-layer-asset="subagent-tools"] button[aria-haspopup="menu"]') !== null`)
    await evaluate(`document.querySelector('[data-config-id="example-subagent-start"] [data-layer-asset="subagent-tools"] button[aria-haspopup="menu"]').click()`)
    await click('2')
    await waitFor(`window.requests.some(r=>r.endpoint==='param-overrides' && r.body.overrides?.maxDepth === 2)`)
    await openLayerSettings('tool-pipeline')
    await evaluate(`document.querySelector('[data-engine-create-layer="tool-pipeline"] button').click()`)
    await click('添加模块 · deliberation-gate')
    await waitFor(`document.querySelector('[aria-label="深思下限（0 默认）"]') !== null`)
    await edit('[aria-label="深思下限（0 默认）"]', '25')
    await evaluate(`document.querySelector('[aria-label="深思下限（0 默认）"]').blur()`)
    await waitFor(`window.requests.some(r=>r.endpoint==='param-overrides' && r.body.overrides?.deliberationMinChars === 25)`)
    assert.equal(await evaluate(`document.querySelector('[aria-label="按层级或策略过滤"]').textContent.trim()`), '全部')
    assert.deepEqual(await evaluate('window.store.fields.promptConfigs'), configs, '引擎参数编辑不生成提示词规则')
  }
})

test('浏览器：子代理结束卡选择注入主会话时才出现正文，保存仍属于本条规则', { skip: skipBrowser, timeout: 30000 }, async () => {
  await navigate('/')
  await waitFor('window.store?.moduleFacts?.editable === true')
  await evaluate(`window.loadPromptTemplates(['75-subagent-end.yml'])`)
  await waitFor(`document.querySelector('[data-config-id="example-subagent-end"]') !== null`)
  const originalIds = await evaluate('window.store.fields.promptConfigs.map(config=>config.id)')
  await evaluate(`document.querySelector('[data-config-id="example-subagent-end"] header button[aria-expanded]').click()`)
  await waitFor(`document.querySelector('[aria-label="结束后的行为"]') !== null`)
  assert.equal(await evaluate(`document.querySelector('[aria-label="注入内容（空 = 不注入）"]') === null`), true)
  await evaluate(`document.querySelector('[aria-label="结束后的行为"]').click()`)
  await click('向主会话注入文本')
  await waitFor(`document.querySelector('[aria-label="注入内容（空 = 不注入）"]') !== null`)
  await edit('[aria-label="注入内容（空 = 不注入）"]', '核对子代理结果后继续。')
  await evaluate(`document.querySelector('[aria-label="按层级或策略过滤"]').focus()`)
  await waitFor(`window.store.savedConfigs?.some(config=>config.id==='example-subagent-end' && config.params.action==='inject-main' && config.text==='核对子代理结果后继续。')`)
  assert.deepEqual(await evaluate('window.store.fields.promptConfigs.map(config=>config.id)'), originalIds)
})

test('浏览器：两页顶部创建菜单严格只有九层模板', { skip: skipBrowser, timeout: 30000 }, async () => {
  for (const page of ['main', 'subagent']) {
    await navigate('/')
    await waitFor('window.store?.moduleFacts?.editable === true')
    await evaluate(`window.selectPage('${page}')`)
    await waitFor(`document.querySelector('[data-module-toolbar] button[aria-haspopup="menu"]') !== null`)
    await evaluate(`document.querySelector('[data-module-toolbar] button[aria-haspopup="menu"]').click()`)
    await waitFor(`document.querySelector('[role="menuitem"]') !== null`)
    const items = await evaluate(`[...document.querySelectorAll('[role="menuitem"]')].map(item=>item.textContent.trim())`)
    assert.equal(items.length, 9, `${page} 顶部不能混入工具、变量、能力或组合`)
    assert.ok(items.every((item) => item.startsWith('添加模板 · ')))
    assert.equal(new Set(items).size, 9)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await evaluate(`document.querySelector('[aria-label="按层级或策略过滤"]').click()`)
    await sleep(50)
    await click('层级：模型流')
    await click('创建第一条配置')
    await waitFor(`document.querySelector('[role="dialog"]')?.textContent.includes('50-llm-stream.yml')`)
    assert.equal(await evaluate(`document.querySelector('[role="dialog"]').textContent.includes('10-pre-step.yml')`), false)
    assert.equal(await evaluate(`document.querySelector('[aria-label="按层级或策略过滤"]').textContent.trim()`), '层级：模型流')
  }
})

test('浏览器：层内能力与组合创建保持筛选，变量空态立即渲染，只读禁用', { skip: skipBrowser, timeout: 60000 }, async () => {
  for (const page of ['main', 'subagent']) {
    await navigate('/')
    await waitFor('window.store?.moduleFacts?.editable === true')
    await evaluate(`window.loadPromptTemplates(['10-pre-step.yml','30-runtime-context.yml','60-tool-pipeline.yml'])`)
    await evaluate(`window.selectPage('${page}')`)
    const count = await evaluate('window.store.fields.promptConfigs.length')
    await createInLayer('pre-step', '前置步骤', '连锁创建 · phase-control')
    await waitFor(`window.store.moduleFacts.effectiveModules.includes('context-gate') && window.store.moduleFacts.effectiveModules.includes('tool-bootstrap')`)
    assert.equal(await evaluate('window.store.fields.promptConfigs.length'), count, '能力组合不创建假提示词卡')
    assert.equal(await evaluate(`document.querySelector('[aria-label="按层级或策略过滤"]').textContent.trim()`), '层级：前置步骤')
    await edit('input[type="search"]', 'context')
    await waitFor(`document.querySelector('[data-engine-create-layer="pre-step"]') !== null`)
    await evaluate(`document.querySelector('[data-engine-create-layer="pre-step"] button').click()`)
    await sleep(50)
    await click('添加模块 · anchor-turn')
    await waitFor(`window.store.moduleFacts.effectiveModules.includes('anchor-turn')`)
    assert.equal(await evaluate('document.querySelector("input[type=search]").value'), 'context', '层内创建不清搜索')
    await edit('input[type="search"]', '')
    await openLayerSettings('tool-pipeline', '工具链')
    await evaluate(`document.querySelector('[data-engine-create-layer="tool-pipeline"] button').click()`)
    await waitFor(`document.querySelector('[role="menuitem"]') !== null`)
    const labels = await evaluate(`[...document.querySelectorAll('[role="menuitem"]')].map(item=>item.textContent.trim())`)
    assert.equal(labels.includes('添加模块 · tool-filter'), page === 'main')
    assert.ok(labels.includes('连锁创建 · deliberation'))
    assert.equal(labels.some((label) => label.includes('phase-control')), false, '跨层组合只在首能力主层出现')
    await click('连锁创建 · deliberation')
    await waitFor(`window.store.moduleFacts.effectiveModules.includes('deliberation-gate') && window.store.moduleFacts.effectiveModules.includes('progress-reminder')`)
    await openLayerSettings('runtime-context', '运行上下文')
    assert.equal(await evaluate(`document.querySelector('[aria-label="模板变量名"]') === null`), true)
    await evaluate(`[...document.querySelector('[data-layer-asset="variables"]').querySelectorAll('button')].find(button=>button.textContent==='添加').focus()`)
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await send('Input.dispatchKeyEvent', { type: 'char', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await waitFor(`document.querySelector('[aria-label="模板变量名"]') !== null`)
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    assert.equal(await evaluate(`document.activeElement === document.querySelector('[aria-label="模板变量名"]')`), true, '创建按钮卸载后焦点应进入新变量名输入框')
    assert.equal(await evaluate(`document.querySelector('[aria-label="按层级或策略过滤"]').textContent.trim()`), '层级：运行上下文')
    assert.equal(await evaluate('window.store.fields.promptConfigs.length'), count)
  }
  for (const [editable, writePreset] of [[false, true], [true, false]]) {
    await navigate('/')
    await waitFor('window.store?.moduleFacts?.editable === true')
    await evaluate(`window.loadPromptTemplates(['30-runtime-context.yml','60-tool-pipeline.yml'])`)
    await evaluate(`window.presetEditable=${editable}; window.writePreset=${writePreset}; window.store.load()`)
    await waitFor(`window.store.moduleFacts.editable === ${editable} && window.store.fields.writePreset === ${writePreset}`)
    assert.equal(await evaluate(`document.querySelector('[data-module-toolbar] button[aria-haspopup="menu"]').disabled`), true)
    const before = await evaluate('window.store.fields.promptConfigs.length')
    await openLayerSettings('tool-pipeline', '工具链')
    assert.equal(await evaluate(`document.querySelector('[data-engine-create-layer]') === null`), true)
    assert.equal(await evaluate(`[...document.querySelector('[data-layer-asset="custom-tools"]').querySelectorAll('button')].filter(b=>['新建空白工具','添加工具模板…'].includes(b.textContent)).every(b=>b.disabled)`), true)
    await openLayerSettings('runtime-context', '运行上下文')
    assert.equal(await evaluate(`[...document.querySelector('[data-layer-asset="variables"]').querySelectorAll('button')].find(b=>b.textContent==='添加').disabled`), true)
    assert.equal(await evaluate('window.store.fields.promptConfigs.length'), before)
    assert.equal(await evaluate(`window.requests.some(r=>r.endpoint==='engine-capability'||(r.endpoint==='custom-tools'&&r.body.customTools)||r.endpoint==='preset-variables')`), false)
  }
})

test('浏览器：工具模板切换实例锚点，Escape关闭后回到原按钮', { skip: skipBrowser, timeout: 30000 }, async () => {
  await navigate('/')
  await waitFor('window.store?.moduleFacts?.editable === true')
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  await evaluate(`window.store.patch({promptConfigs:[{id:'pipe-a',layer:'tool-pipeline',strategy:'static'},{id:'pipe-b',layer:'tool-pipeline',strategy:'static'}]})`)
  for (const id of ['pipe-a', 'pipe-b']) {
    await evaluate(`document.querySelector('[data-config-id="${id}"] header button[aria-expanded]').click()`)
    await waitFor(`document.querySelector('[data-config-id="${id}"] [data-layer-settings]') !== null`)
    await evaluate(`document.querySelector('[data-config-id="${id}"] [data-layer-settings] summary').click()`)
    await waitFor(`document.querySelector('[data-config-id="${id}"] [data-layer-asset="custom-tools"]') !== null`)
    await evaluate(`(()=>{window.clickedToolTrigger=[...document.querySelector('[data-config-id="${id}"] [data-layer-asset="custom-tools"]').querySelectorAll('button')].find(b=>b.textContent==='添加工具模板…');Object.assign(window.clickedToolTrigger.style,{position:'fixed',left:'220px',top:'400px'});window.clickedToolTrigger.click()})()`)
    await waitFor(`document.querySelector('[role="dialog"][aria-label="选择内置模板"]')?.style.visibility !== 'hidden' && document.querySelector('[role="dialog"][aria-label="选择内置模板"]') !== null`)
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    // 本夹具替换了CSS，position:fixed不在；断言定位器给出的top与真实触发按钮一致。
    const anchored = await evaluate(`(()=>{const el=document.querySelector('[role="dialog"][aria-label="选择内置模板"]'),a=window.clickedToolTrigger.getBoundingClientRect(),top=parseFloat(el.style.top);return Math.abs(top-a.bottom-8)<2||Math.abs(a.top-top-el.offsetHeight-8)<2})()`)
    assert.equal(anchored, true, `${id} 定位器必须使用本次层内按钮`)
    await waitFor(`document.activeElement?.closest('[role="dialog"]') !== null`)
    assert.equal(await evaluate(`document.activeElement?.closest('[role="dialog"]') !== null`), true, '模板浮层打开后自动获得键盘焦点')
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await waitFor(`document.querySelector('[role="dialog"][aria-label="选择内置模板"]') === null`)
    assert.equal(await evaluate('document.activeElement === window.clickedToolTrigger'), true)
  }
  await click('添加注入模板')
  await click('添加模板 · 前置步骤')
  await waitFor(`document.querySelector('[role="dialog"]') !== null`)
  await click('×')
  assert.equal(await evaluate(`document.activeElement === document.querySelector('[data-module-toolbar] button[aria-haspopup="menu"]')`), true, '顶部模板仍回到顶部按钮')
})

test('浏览器：六层空卡、跨层工具创建、筛选草稿与能力卡装配', { skip: skipBrowser, timeout: 60000 }, async () => {
  const chooseView = async (name) => {
    await evaluate(`document.querySelector('[aria-label="按层级或策略过滤"]').click()`)
    await sleep(50)
    await click(name)
  }
  await navigate('/')
  await waitFor('window.store?.moduleFacts?.editable === true')
  // 指令文件复用标准配置卡（与 example-pre-step 同类）：在列表里出卡，不是新的置顶固定卡。
  await waitFor(`[...document.querySelectorAll('article')].some((card) => card.textContent.includes('AGENTS：'))`)
  const agentsCards = await evaluate(`[...document.querySelectorAll('article')].map((card) => card.textContent).filter((text) => text.includes('AGENTS：'))`)
  assert.equal(agentsCards.length, 2)
  assert.ok(agentsCards.every((text) => text.includes('前置步骤 · 动态填充 · 位置：用户消息后')), '指令文件卡折叠态保留插入点、策略和位置')
  assert.ok(agentsCards.every((text) => !text.includes('独立指令文件来源')), '来源开关不塞进新的指令文件卡')
  assert.equal(await evaluate(`document.body.innerText.includes('独立指令文件来源')`), true, '来源开关仍在列表工具栏行')
  await evaluate(`[...document.querySelectorAll('button[aria-expanded]')].find((b) => b.textContent.includes('AGENTS：AGENTS.md')).click()`)
  await waitFor(`document.querySelector('[aria-label="注入内容（空 = 不注入）"]')?.value==='项目指令正文'`)
  assert.equal(await evaluate(`document.querySelector('[aria-label="填充来源"]')?.textContent.includes('指令提示')`), true, '展开后完整读取填充来源')
  await evaluate(`window.loadPromptTemplates(['60-tool-pipeline.yml'])`)
  await openLayerSettings('tool-pipeline', '工具链')
  await waitFor(`document.querySelector('[data-layer-asset="custom-tools"]') !== null`)
  await click('新建空白工具')
  assert.equal(await evaluate(`document.querySelector('[aria-label="按层级或策略过滤"]').textContent.trim()`), '层级：工具链', '创建工具不改动筛选')
  await waitFor(`document.body.innerText.includes('tool-1 · my_tool')`)
  assert.equal(await evaluate(`document.querySelector('[aria-label="启用工具 tool-1"]').closest('article').querySelector('[aria-expanded="true"]')!==null`), true)
  for (const view of ['层级：系统提示段', '世界书', '层级：工具链']) await chooseView(view)
  await openLayerSettings('tool-pipeline')
  await waitFor(`document.body.innerText.includes('tool-1 · my_tool')`)
  await click('新建空白工具')
  await waitFor(`document.body.innerText.includes('tool-2 · my_tool_2')`)
  await evaluate(`window.rejectToolSave=true;[...document.querySelector('section[aria-label="自定义工具编辑"]').querySelectorAll('button')].find(e=>e.textContent==='保存').click()`)
  await waitFor(`window.store.notice==='test: incomplete tool'`)
  assert.equal(await evaluate(`document.querySelectorAll('[aria-label^="启用工具 tool-"]').length`), 2)

  await evaluate(`window.toolTrigger=[...document.querySelector('[data-layer-asset="custom-tools"]').querySelectorAll('button')].find(b=>b.textContent==='添加工具模板…');window.toolTrigger.click()`)
  const toolTemplate = fixture.templates.toolTemplates[0]
  await waitFor(`document.body.innerText.includes(${JSON.stringify(toolTemplate.file)})`)
  await evaluate(`document.querySelectorAll('button').forEach(e=>{if(e.textContent.includes(${JSON.stringify(toolTemplate.file)}))e.click()})`)
  assert.equal(await evaluate(`document.querySelector('[aria-label="按层级或策略过滤"]').textContent.trim()`), '层级：工具链', '创建不改动列表筛选')
  assert.equal(await evaluate(`document.querySelector('[role="dialog"]')===null`), true, '工具模板选中后必须关闭浮层')
  assert.equal(await evaluate('document.activeElement === window.toolTrigger'), true, '选中后焦点恢复实际层内按钮')
  // 自定义工具编辑器内置在真实工具链提示词配置卡中。
  await chooseView('层级：工具链')
  await waitFor(`document.querySelector('[data-config-id="example-tool-pipeline"]') !== null`)
  await waitFor(`document.querySelector(${JSON.stringify(`[aria-label="启用工具 ${toolTemplate.spec.id}"]`)})!==null`)

  // 真实模板 + 真实自动保存 effect；生成快照暂时为空也不能丢卡。
  await evaluate('window.staleGenerated=true')
  await chooseView('全部')
  const configsBeforeTemplates = await evaluate('window.store.getFields().promptConfigs.length')
  for (const [index, [file, layer]] of [['10-pre-step.yml', '前置步骤'], ['20-system-section.yml', '系统提示段'], ['30-runtime-context.yml', '运行上下文'], ['40-agent-request.yml', '代理请求'], ['50-llm-stream.yml', '模型流'], ['60-tool-pipeline.yml', '工具链']].entries()) {
    await click('添加注入模板')
    await click(`添加模板 · ${layer}`)
    await waitFor(`document.body.innerText.includes(${JSON.stringify(file)})`)
    await evaluate(`document.querySelectorAll('button').forEach(e=>{if(e.textContent.includes(${JSON.stringify(file)}))e.click()})`)
    await waitFor(`window.store.savedConfigs.length===${index + configsBeforeTemplates + 1}`)
    assert.equal(await evaluate(`document.querySelector('[aria-label="按层级或策略过滤"]').textContent.trim()`), '全部', '创建模板不改动列表筛选')
    assert.equal(await evaluate(`document.querySelector('[data-config-layer]')!==null`), true, `${file} 应展开`)
    assert.equal(await evaluate('window.store.getFields().promptConfigs.length'), index + configsBeforeTemplates + 1)
  }
  await evaluate('window.staleGenerated=false')
  await evaluate('window.store.load()')
  assert.equal(await evaluate('window.store.getFields().promptConfigs.length'), configsBeforeTemplates + 6)
  // 变量从本层空态创建，点击后必须立即重渲染，不依赖另一轮展开。
  await chooseView('层级：运行上下文')
  await waitFor(`document.querySelector('[data-config-id]') !== null`)
  await evaluate(`document.querySelector('[data-config-id] header button[aria-expanded]').click(); true`)
  await waitFor(`document.querySelector('[data-layer-settings="runtime-context"]') !== null`)
  await evaluate(`document.querySelector('[data-layer-settings="runtime-context"] summary').click(); true`)
  await waitFor(`document.querySelector('[data-layer-asset="variables"]') !== null`)
  await evaluate(`[...document.querySelector('[data-layer-asset="variables"]').querySelectorAll('button')].find(button=>button.textContent==='添加').click()`)
  await waitFor(`document.querySelector('[aria-label="模板变量名"]')!==null`)
  await evaluate(`document.querySelector('[aria-label="模板变量名"]').dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: document.querySelector('[aria-label="按层级或策略过滤"]') }))`)
  await waitFor(`window.requests.some(r=>r.endpoint==='preset-variables')`)
  await evaluate('window.store.load()')
  assert.equal(await evaluate(`document.querySelector('[aria-label="模板变量名"]')!==null`), true)
  await chooseView('全部')

  await createInLayer('pre-step', '前置步骤', '添加模块 · context-gate')
  await waitFor(`window.store.moduleFacts.effectiveModules.includes('context-gate')`)
  await createInLayer('pre-step', '前置步骤', '添加模块 · anchor-turn')
  await waitFor(`window.store.moduleFacts.effectiveModules.includes('anchor-turn')`)
  assert.equal(await evaluate(`[...document.querySelectorAll('[data-module-card="true"]')].some((card)=>card.textContent.includes('context-gate')||card.textContent.includes('anchor-turn'))`), false, '能力不再以独立卡片出现')
  await openLayerSettings('pre-step', '前置步骤')
  await waitFor(`document.querySelector('[data-layer-capability="context-gate"]') !== null`)
  assert.equal(await evaluate(`document.querySelectorAll('[data-layer-capability]').length`), 2, '本层两个已装配能力都列出')
  assert.equal(await evaluate(`document.querySelector('[data-layer-capability="anchor-turn"]') !== null`), true, '另一个能力同区可见')
  // 参数也在同一设置区里：与本层其余实例卡同源。
  assert.equal(await evaluate(`document.querySelector('[data-layer-param-group="context-gate"]') !== null`), true, '参数组随能力装配出现')
  assert.equal(await evaluate(`document.querySelector('[aria-label="编辑行为"]')===null`), true, '不再有编辑目标下拉')
  assert.equal(await evaluate(`document.querySelector('[aria-label="按层级或策略过滤"]').textContent.trim()`), '层级：前置步骤')
  assert.deepEqual(await evaluate('window.store.moduleFacts.effectiveModules'), ['context-gate', 'anchor-turn'])
})

test('浏览器：子代理策略失焦保存与草稿隔离', { skip: skipBrowser, timeout: 60000 }, async (t) => {
  await navigate('/policy')
  await waitForPolicy('window.reset !== undefined')
  const name = 'input[aria-label="profile name"]'
  const reset = async (plans = {}) => {
    await evaluate(`window.reset(${JSON.stringify(plans)}); true`)
    await waitForPolicy(`document.querySelector(${JSON.stringify(name)})?.value === 'original-a'`)
  }

  await t.test('首次标签失焦保存新黑名单，卡内切换控件不写盘', async () => {
    await reset()
    await edit('#pt-sp-ceiling-deny', 'write')
    await blur()
    await waitForPolicy('window.writes.length === 1')
    assert.deepEqual(await evaluate('window.writes[0].policy.ceiling.deny'), ['write'])
    await edit('#pt-sp-ceiling-deny', 'bash')
    await evaluate(`document.querySelector(${JSON.stringify(name)}).focus(); true`)
    await sleep(70)
    assert.equal(await evaluate('window.writes.length'), 1)
    await blur()
    await waitForPolicy('window.writes.length === 2')
    assert.deepEqual(await evaluate('window.writes[1].policy.ceiling.deny'), ['write', 'bash'])
  })

  await t.test('旧响应不确认保存中继续输入的新草稿', async () => {
    await reset({ writes: [{ defer: true }] })
    await edit(name, 'first')
    await blur()
    await waitForPolicy('window.pendingWrites.length === 1')
    await edit(name, 'second')
    await settleWrite()
    await blur()
    await waitForPolicy('window.writes.length === 2')
    assert.deepEqual(await evaluate('window.writes.map(r=>r.policy.profiles[0].name)'), ['first', 'second'])
  })

  await t.test('保存中再次失焦排队，响应后保存最新已提交草稿', async () => {
    await reset({ writes: [{ defer: true }] })
    await edit(name, 'first')
    await blur()
    await waitForPolicy('window.pendingWrites.length === 1')
    await edit(name, 'second')
    await blur()
    assert.equal(await evaluate('window.writes.length'), 1, '请求串行')
    await settleWrite()
    await waitForPolicy('window.writes.length === 2')
    assert.deepEqual(await evaluate('window.writes.map(r=>r.policy.profiles[0].name)'), ['first', 'second'])
    await waitForPolicy('window.saved.a.profiles[0].name === "second"')
  })

  await t.test('保存失败后保留草稿，再次失焦可以重试', async () => {
    await reset({ writes: [{ ok: false }] })
    await edit(name, 'retry')
    await blur()
    await waitForPolicy('window.notices.some(n=>n.kind === "error")')
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(name)}).value`), 'retry')
    await evaluate(`document.querySelector(${JSON.stringify(name)}).focus(); true`)
    await blur()
    await waitForPolicy('window.writes.length === 2 && window.saved.a.profiles[0].name === "retry"')
  })

  await t.test('关闭再打开复用共享可用骨架', async () => {
    await reset()
    const toggle = '[role="switch"][aria-label="启用子代理工具策略"]'
    await evaluate(`document.querySelector(${JSON.stringify(toggle)}).click(); true`)
    await waitForPolicy(`window.writes.length === 1 && !document.querySelector(${JSON.stringify(toggle)}).disabled`)
    assert.equal(await evaluate('window.writes[0].policy'), null)
    await evaluate(`document.querySelector(${JSON.stringify(toggle)}).click(); true`)
    await waitForPolicy('window.writes.length === 2')
    const policy = await evaluate('window.writes[1].policy')
    assert.deepEqual(policy, SUBAGENT_TOOL_POLICY_SKELETON)
    assert.deepEqual(validateSubagentToolPolicy(policy), [])
  })

  await t.test('预设切换隔离迟到读取、保存响应与待存队列', async () => {
    await evaluate('window.reset({reads:[{defer:true}]}); true')
    await waitForPolicy('window.pendingReads.length === 1')
    await evaluate('window.selectPreset("b"); true')
    await waitForPolicy(`document.querySelector(${JSON.stringify(name)})?.value === 'original-b'`)
    await evaluate('window.pendingReads.shift()(); true')
    await sleep(70)
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(name)}).value`), 'original-b')

    await reset({ writes: [{ defer: true }] })
    await edit(name, 'first-a')
    await blur()
    await waitForPolicy('window.pendingWrites.length === 1')
    await edit(name, 'queued-a')
    await blur()
    await evaluate('window.selectPreset("b"); true')
    await waitForPolicy(`document.querySelector(${JSON.stringify(name)})?.value === 'original-b'`)
    await edit(name, 'edited-b')
    await settleWrite()
    assert.deepEqual(await evaluate('window.notices'), [], '旧响应不向新预设发出保存成功提示')
    assert.equal(await evaluate('window.writes.length'), 1, '旧待存队列失效')
    await blur()
    await waitForPolicy('window.writes.length === 2')
    assert.deepEqual(await evaluate('window.writes.map(r=>[r.expectedPresetId,r.policy.profiles[0].name])'), [['a', 'first-a'], ['b', 'edited-b']])
  })

  await t.test('卸载后忽略保存响应，且不继续旧队列', async () => {
    await reset({ writes: [{ defer: true }] })
    await edit(name, 'first')
    await blur()
    await waitForPolicy('window.pendingWrites.length === 1')
    await edit(name, 'queued')
    await blur()
    await evaluate('window.unmount(); true')
    await settleWrite()
    assert.equal(await evaluate('window.writes.length'), 1)
    assert.deepEqual(await evaluate('window.notices'), [])
  })
  assert.deepEqual(await evaluate('window.errors'), [])
})

test('浏览器：复审修复覆盖创建、搜索、只读和折叠的生产装配链', { skip: skipBrowser, timeout: 60000 }, async (t) => {
  const chooseView = async (name) => {
    await evaluate(`document.querySelector('[aria-label="按层级或策略过滤"]').click()`)
    await sleep(50)
    await click(name)
  }
  const reset = async () => { await navigate('/'); await waitFor('window.store?.moduleFacts?.editable === true') }
  const openSettings = async (id, layer) => {
    await evaluate(`document.querySelector('[data-config-id="${id}"] header button[aria-expanded]').click()`)
    await waitFor(`document.querySelector('[data-layer-settings="${layer}"]') !== null`)
    await evaluate(`document.querySelector('[data-layer-settings="${layer}"] summary').click()`)
  }
  await t.test('层内工具连续创建立即生成独立草稿，切页保留不重放且不保存', async () => {
    for (const page of ['main', 'subagent']) {
      for (const instanceCount of [1, 2]) {
        await reset()
        await evaluate(`window.selectPage('${page}'); window.store.patch({promptConfigs:Array.from({length:${instanceCount}},(_,index)=>({id:'pipe-'+index,layer:'tool-pipeline',strategy:'static'}))})`)
        await openLayerSettings('tool-pipeline', '工具链')
        await waitFor(`window.store.editorDrafts.tools.get('test')?.loaded === true`)
        await evaluate(`(()=>{const button=[...document.querySelector('[data-layer-asset="custom-tools"]').querySelectorAll('button')].find(b=>b.textContent==='新建空白工具');button.click();button.click()})()`)
        await waitFor(`window.store.editorDrafts.tools.get('test')?.tools.length === 2`)
        assert.equal(await evaluate(`document.querySelector('[aria-label="按层级或策略过滤"]').textContent.trim()`), '层级：工具链')
        await chooseView('层级：前置步骤')
        await evaluate(`window.selectPage('away')`)
        await evaluate(`window.selectPage('${page}')`)
        await openLayerSettings('tool-pipeline', '工具链')
        await waitFor(`document.querySelectorAll('[aria-label^="启用工具 tool-"]').length === 2`)
        assert.deepEqual(await evaluate(`window.store.editorDrafts.tools.get('test').tools.map(t=>t.id)`), ['tool-1', 'tool-2'])
        assert.equal(await evaluate(`window.requests.filter(r=>r.endpoint==='custom-tools'&&r.body.customTools).length`), 0)
      }
    }
  })
  await t.test('N2：技术键、中文标签、能力名只保留真实实例，空层不派生卡且不扩大批量启停', async () => {
    await reset()
    await evaluate(`window.loadPromptTemplates(['60-tool-pipeline.yml'])`)
    await createInLayer('tool-pipeline', '工具链', '添加模块 · deliberation-gate')
    await waitFor(`window.store.moduleFacts.effectiveModules.includes('deliberation-gate')`)
    await chooseView('全部')
    await evaluate(`window.store.patch({promptConfigs:[{id:'pipe-a',name:'普通规则',layer:'tool-pipeline',strategy:'static',enabled:true}]})`)
    for (const keyword of ['deliberationMinChars', '深思', 'deliberation-gate']) {
      await edit('input[type="search"]', keyword)
      await waitFor(`document.querySelector('[data-config-id="pipe-a"]') !== null`)
      await openSettings('pipe-a', 'tool-pipeline')
      await waitFor(`document.querySelector('[data-layer-param-group="deliberation-gate"]') !== null`)
      assert.equal(await evaluate(`window.store.fields.promptConfigs[0].enabled`), true)
      assert.equal(await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.startsWith('停用可见'))?.disabled`), true)
      await evaluate(`document.querySelector('[data-config-id="pipe-a"] header button[aria-expanded]').click()`)
    }
    await evaluate(`window.store.patch({promptConfigs:[]})`)
    await waitFor(`document.querySelector('[data-config-id="pipe-a"]') === null`)
    assert.equal(await evaluate('document.querySelectorAll("article").length'), 0, '能力名命中也不能创建额外卡片')
    await edit('input[type="search"]', '不存在的设置')
    await waitFor(`document.body.innerText.includes('没有匹配')`)
    await edit('input[type="search"]', '')
    assert.equal(await evaluate('window.store.fields.promptConfigs.length'), 0)
  })
  await t.test('V4/V6：变量即时折叠，三种可写状态与当前会话模型独立', async () => {
    for (const [editable, writePreset] of [[false, true], [true, false], [true, true]]) {
      await reset()
      await evaluate(`window.loadPromptTemplates(['30-runtime-context.yml','40-agent-request.yml'])`)
      await evaluate(`window.presetEditable=${editable}; window.writePreset=${writePreset}; window.store.load()`)
      await waitFor(`window.store.moduleFacts.editable === ${editable} && window.store.fields.writePreset === ${writePreset}`)
      await evaluate(`window.store.setTemplateVariables({test:'value'})`)
      await openLayerSettings('runtime-context', '运行上下文')
      await waitFor(`document.querySelector('[data-layer-asset="variables"] input') !== null`)
      const writable = editable && writePreset
      assert.equal(await evaluate(`document.querySelector('[aria-label="模板变量名"]').readOnly`), !writable)
      assert.equal(await evaluate(`document.querySelector('[aria-label="启用模板变量插值"]').disabled`), !writable)
      const writes = await evaluate(`window.requests.filter(r=>r.endpoint==='preset-variables').length`)
      await evaluate(`document.querySelector('[data-layer-asset="variables"] button[aria-expanded]').click()`)
      await waitFor(`document.querySelector('[data-layer-asset="variables"] button[aria-expanded]').getAttribute('aria-expanded')==='false'`)
      await chooseView('层级：代理请求'); await chooseView('层级：运行上下文')
      await openLayerSettings('runtime-context')
      assert.equal(await evaluate(`document.querySelector('[data-layer-asset="variables"] button[aria-expanded]').getAttribute('aria-expanded')`), 'false')
      await evaluate(`document.querySelector('[data-layer-asset="variables"] button[aria-expanded]').click()`)
      await waitFor(`document.querySelector('[aria-label="模板变量名"]') !== null`)
      assert.equal(await evaluate(`window.requests.filter(r=>r.endpoint==='preset-variables').length`), writes)
      await openLayerSettings('agent-request', '代理请求')
      await evaluate(`[...document.querySelectorAll('button[aria-expanded]')].find(b=>b.textContent.includes('模型路由')).click()`)
      await waitFor(`document.querySelector('[data-layer-asset="main-model"] [aria-label="采样温度"]') !== null`)
      assert.equal(await evaluate(`document.querySelector('[data-layer-asset="main-model"] [aria-label="采样温度"]').disabled`), !writable)
      assert.equal(await evaluate(`document.querySelector('[aria-label="预设模型"]').disabled`), !writable)
      assert.equal(await evaluate(`document.querySelector('[aria-label="会话模型"]').disabled`), false)
      const presetWrites = await evaluate(`window.requests.filter(r=>r.endpoint==='param-overrides').length`)
      await evaluate(`document.querySelector('[aria-label="会话模型"]').click()`)
      await click('model-b')
      await waitFor(`window.sessionSelection?.model === 'model-b'`)
      assert.equal(await evaluate(`window.requests.filter(r=>r.endpoint==='param-overrides').length`), presetWrites)
    }
  })
  await t.test('V5：三个无设置层不生成空设置壳', async () => {
    await reset()
    for (const layer of ['llm-stream', 'turn-stop', 'subagent-end']) {
      await evaluate(`window.store.patch({promptConfigs:[{id:'empty-${layer}',layer:'${layer}',strategy:'static'}]})`)
      await waitFor(`document.querySelector('[data-config-id="empty-${layer}"]') !== null`)
      await evaluate(`document.querySelector('[data-config-id="empty-${layer}"] header button[aria-expanded]').click()`)
      assert.equal(await evaluate(`document.querySelector('[data-layer-settings="${layer}"]') === null`), true)
    }
  })
})

test('浏览器：参数镜像控件同步半成品输入与错误态，一次失焦只保存一次', { skip: skipBrowser, timeout: 60000 }, async () => {
  const chooseView = async (name) => {
    await evaluate(`document.querySelector('[aria-label="按层级或策略过滤"]').click()`)
    await sleep(50)
    await click(name)
  }
  await navigate('/')
  await waitFor('window.store?.moduleFacts?.editable === true')
  // 装配「上下文门控」能力：deferredGraceSteps 属于 pre-step 层，随后会出现在该层每张实例卡里。
  await createInLayer('pre-step', '前置步骤', '添加模块 · context-gate')
  await waitFor(`window.store.moduleFacts.effectiveModules.includes('context-gate')`)
  // 同层两张实例卡：每张卡内部各有一份「本层引擎设置」，两处读同一份值。
  await evaluate(`window.store.patch({ promptConfigs: [
    { id: 'mirror-a', name: '镜像 A', layer: 'pre-step', strategy: 'static', order: 0, enabled: true, text: 'A' },
    { id: 'mirror-b', name: '镜像 B', layer: 'pre-step', strategy: 'static', order: 10, enabled: true, text: 'B' }
  ] }); true`)
  await chooseView('层级：前置步骤')
  await waitFor(`document.querySelector('[data-config-id="mirror-a"]') !== null`)
  // 列表是手风琴（一次展开一张卡）：在 A 卡里编辑，切到 B 卡验证读到同一份共享草稿。
  const openSettings = async (id) => {
    await evaluate(`document.querySelector('[data-config-id="${id}"] header button[aria-expanded]').click(); true`)
    await waitFor(`document.querySelector('[data-config-id="${id}"] [data-layer-settings="pre-step"]') !== null`)
    await evaluate(`document.querySelector('[data-config-id="${id}"] [data-layer-settings="pre-step"] summary').click(); true`)
  }
  const primary = '#pt-param-layer-pre-step-mirror-a-context-gate-deferredGraceSteps'
  const mirror = '#pt-param-layer-pre-step-mirror-b-context-gate-deferredGraceSteps'
  await openSettings('mirror-a')
  await waitFor(`document.querySelector(${JSON.stringify(primary)}) !== null`)
  // module fixture 没有额外的焦点目标，直接 blur 元素本身即可触发字段的 onBlur 保存语义。
  const blurField = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).blur(); true`)
  const saves = `window.requests.filter((request) => request.endpoint === 'param-overrides').length`
  const before = await evaluate(saves)
  // 半成品输入：写进共享草稿，尚未落盘。
  await edit(primary, '12a')
  assert.equal(await evaluate(saves), before, '未完成的输入不保存')
  // 失焦校验失败：字段进入 aria-invalid 并播报错误。
  await blurField(primary)
  await waitFor(`document.querySelector(${JSON.stringify(primary)}).getAttribute('aria-invalid') === 'true'`)
  assert.equal(await evaluate(`[...document.querySelectorAll('[role="alert"]')].filter((node) => node.textContent.includes('必须是非负整数')).length`), 1)
  assert.equal(await evaluate(saves), before, '校验失败不落盘')
  // 切到同层另一张卡：读到同一份半成品与同一条错误（同源同步，不是第二份状态）。
  await openSettings('mirror-b')
  await waitFor(`document.querySelector(${JSON.stringify(mirror)}) !== null`)
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(mirror)}).value`), '12a', '另一张卡读到同一份未完成输入')
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(mirror)}).getAttribute('aria-invalid')`), 'true', '错误态同样同步')
  // 在 B 卡改成合法值并失焦：一次语义变更只提交一次保存。
  await edit(mirror, '3')
  await blurField(mirror)
  await waitFor(`${saves} === ${before + 1}`)
  await sleep(200)
  assert.equal(await evaluate(saves), before + 1, '一次语义变更只保存一次')
  assert.equal(await evaluate('window.store.fields.deferredGraceSteps'), 3)
  assert.equal(await evaluate(`document.querySelectorAll('[role="alert"]').length`), 0, '保存成功后清掉错误态')
  // 切回 A 卡：读到保存后的同一份值。
  await openSettings('mirror-a')
  await waitFor(`document.querySelector(${JSON.stringify(primary)}) !== null`)
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(primary)}).value`), '3', '两张卡始终读同一份值')
})
