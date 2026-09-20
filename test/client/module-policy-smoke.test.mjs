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
  await chooseView('层级：前置步骤')
  await click('添加能力 / 工具模块')
  await click('新建空白工具')
  // 创建不改动列表筛选：工具草稿已建立，但当前层级视图不显示工具卡。
  assert.equal(await evaluate(`document.body.innerText.includes('tool-1 · my_tool')`), false, '创建工具不改动筛选')
  await chooseView('层级：工具链')
  await waitFor(`document.body.innerText.includes('tool-1 · my_tool')`)
  assert.equal(await evaluate(`document.querySelector('[aria-label="启用工具 tool-1"]').closest('article').querySelector('[aria-expanded="true"]')!==null`), true)
  for (const view of ['层级：系统提示段', '世界书', '层级：工具链']) await chooseView(view)
  await waitFor(`document.body.innerText.includes('tool-1 · my_tool')`)
  await click('添加能力 / 工具模块')
  await click('新建空白工具')
  await waitFor(`document.body.innerText.includes('tool-2 · my_tool_2')`)
  await evaluate(`window.rejectToolSave=true;[...document.querySelector('section[aria-label="自定义工具编辑"]').querySelectorAll('button')].find(e=>e.textContent==='保存').click()`)
  await waitFor(`window.store.notice==='test: incomplete tool'`)
  assert.equal(await evaluate(`document.querySelectorAll('[aria-label^="启用工具 tool-"]').length`), 2)

  await chooseView('世界书')
  await click('添加能力 / 工具模块')
  await click('添加工具模板…')
  const toolTemplate = fixture.templates.toolTemplates[0]
  await waitFor(`document.body.innerText.includes(${JSON.stringify(toolTemplate.file)})`)
  await evaluate(`document.querySelectorAll('button').forEach(e=>{if(e.textContent.includes(${JSON.stringify(toolTemplate.file)}))e.click()})`)
  await waitFor(`document.querySelector(${JSON.stringify(`[aria-label="启用工具 ${toolTemplate.spec.id}"]`)})!==null`)
  assert.equal(await evaluate(`document.querySelector('[aria-label="按层级或策略过滤"]').textContent.trim()`), '世界书', '创建不改动列表筛选')
  assert.equal(await evaluate(`document.querySelector('[role="dialog"]')===null`), true, '工具模板选中后必须关闭浮层')

  // 真实模板 + 真实自动保存 effect；生成快照暂时为空也不能丢卡。
  await evaluate('window.staleGenerated=true')
  await chooseView('全部')
  for (const [index, [file, layer]] of [['10-pre-step.yml', '前置步骤'], ['20-system-section.yml', '系统提示段'], ['30-runtime-context.yml', '运行上下文'], ['40-agent-request.yml', '代理请求'], ['50-llm-stream.yml', '模型流'], ['60-tool-pipeline.yml', '工具链']].entries()) {
    await click('添加能力 / 工具模块')
    await click(`添加模板 · ${layer}`)
    await waitFor(`document.body.innerText.includes(${JSON.stringify(file)})`)
    await evaluate(`document.querySelectorAll('button').forEach(e=>{if(e.textContent.includes(${JSON.stringify(file)}))e.click()})`)
    await waitFor(`window.store.savedConfigs.length===${index + 3}`)
    assert.equal(await evaluate(`document.querySelector('[aria-label="按层级或策略过滤"]').textContent.trim()`), '全部', '创建模板不改动列表筛选')
    assert.equal(await evaluate(`document.querySelector('[aria-label="注入内容（空 = 不注入）"]')!==null`), true, `${file} 应展开`)
    assert.equal(await evaluate('window.store.getFields().promptConfigs.length'), index + 3)
  }
  await evaluate('window.staleGenerated=false')
  await evaluate('window.store.load()')
  assert.equal(await evaluate('window.store.getFields().promptConfigs.length'), 8)
  await click('添加能力 / 工具模块')
  await click('添加模板变量')
  await waitFor(`document.querySelector('[aria-label="模板变量名"]')!==null`)
  await evaluate(`document.querySelector('[aria-label="模板变量名"]').dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: document.querySelector('[aria-label="按层级或策略过滤"]') }))`)
  await waitFor(`window.requests.some(r=>r.endpoint==='preset-variables')`)
  await evaluate('window.store.load()')
  assert.equal(await evaluate(`document.querySelector('[aria-label="模板变量名"]')!==null`), true)

  await click('添加能力 / 工具模块')
  await click('添加模块 · context-gate')
  await waitFor(`window.store.moduleFacts.effectiveModules.includes('context-gate')`)
  await click('添加能力 / 工具模块')
  await click('添加模块 · anchor-turn')
  await waitFor(`document.body.innerText.includes('anchor-turn')`)
  // 一项能力一张卡：两张独立卡片，创建的那张展开；筛选与页面入口不变。
  assert.equal(await evaluate(`[...document.querySelectorAll('[data-module-card="true"]')].filter((card)=>['context-gate','anchor-turn'].some((id)=>card.textContent.includes(id))).length`), 2)
  assert.equal(await evaluate(`[...document.querySelectorAll('[data-module-card="true"]')].some((card)=>card.textContent.includes('anchor-turn')&&card.querySelector('[aria-expanded="true"]')!==null)`), true, '创建的能力卡展开')
  assert.equal(await evaluate(`document.querySelector('[aria-label="编辑行为"]')===null`), true, '不再有编辑目标下拉')
  assert.equal(await evaluate(`document.querySelector('[aria-label="按层级或策略过滤"]').textContent.trim()`), '全部')
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

test('浏览器：参数镜像控件同步半成品输入与错误态，一次失焦只保存一次', { skip: skipBrowser, timeout: 60000 }, async () => {
  const chooseView = async (name) => {
    await evaluate(`document.querySelector('[aria-label="按层级或策略过滤"]').click()`)
    await sleep(50)
    await click(name)
  }
  await navigate('/')
  await waitFor('window.store?.moduleFacts?.editable === true')
  // 创建「深思门」能力：deliberationMinChars 同时出现在能力卡与工具管线共享设置区。
  await click('添加能力 / 工具模块')
  await click('添加模块 · deliberation-gate')
  await chooseView('层级：工具链')
  await waitFor(`document.querySelector('#pt-param-deliberationMinChars') !== null`)
  // 能力卡由创建定位自动展开；共享设置卡需要手动展开才渲染镜像控件。
  await evaluate(`[...document.querySelectorAll('button[aria-expanded]')].find((button) => button.textContent.includes('工具能力设置'))?.click(); true`)
  const primary = '#pt-param-deliberationMinChars'
  const mirror = '#pt-param-tool-pipeline-deliberation-gate-deliberationMinChars'
  await waitFor(`document.querySelector(${JSON.stringify(mirror)}) !== null`)
  // module fixture 没有额外的焦点目标，直接 blur 元素本身即可触发卡片的 onBlur 保存语义。
  const blurField = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).blur(); true`)
  const saves = `window.requests.filter((request) => request.endpoint === 'param-overrides').length`
  const before = await evaluate(saves)
  assert.notEqual(await evaluate(`document.querySelector(${JSON.stringify(primary)}).id`),
    await evaluate(`document.querySelector(${JSON.stringify(mirror)}).id`), '两处渲染点的 DOM id 不同')
  // 半成品输入：另一处立即读到同一个值（同一草稿键），且尚未落盘。
  await edit(mirror, '12a')
  await waitFor(`document.querySelector(${JSON.stringify(primary)}).value === '12a'`)
  assert.equal(await evaluate(saves), before, '未完成的输入不保存')
  // 失焦校验失败：错误态同为共享草稿，两处一起 aria-invalid 并各播报同一条错误。
  await blurField(mirror)
  await waitFor(`document.querySelector(${JSON.stringify(primary)}).getAttribute('aria-invalid') === 'true'`)
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(mirror)}).getAttribute('aria-invalid')`), 'true')
  assert.equal(await evaluate(`[...document.querySelectorAll('[role="alert"]')].filter((node) => node.textContent.includes('必须是非负整数')).length`), 2)
  assert.equal(await evaluate(saves), before, '校验失败不落盘')
  // 合法值：一次失焦只提交一次参数保存，两处回落到同一个字段值。
  await edit(primary, '20')
  await blurField(primary)
  await waitFor(`${saves} === ${before + 1}`)
  await sleep(200)
  assert.equal(await evaluate(saves), before + 1, '一次语义变更只保存一次')
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(mirror)}).value`), '20')
  assert.equal(await evaluate('window.store.fields.deliberationMinChars'), 20)
  assert.equal(await evaluate(`document.querySelectorAll('[role="alert"]').length`), 0, '保存成功后清掉错误态')
})
