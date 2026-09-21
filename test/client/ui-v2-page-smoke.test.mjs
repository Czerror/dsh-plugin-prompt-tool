// 合并自 ui-v2-pages.test.mjs / ui-v2-cards-browser.test.mjs / ui-v2-drafts.test.mjs
//（2026-09-17 测试归一精简 Wave 3 / C3a-S3）。
//
// 三个成员都围绕工作台六页、都用「假 CSS」（CSS Modules 被替换），因此共享**一个 Edge 实例**：
// 每个成员保留一条独立 test()，用例内先 Page.navigate 到自己的页面 —— 重新加载即重置
// window / window.requests / window.fixture 等全局，成员之间不共享运行时状态。
//
// 各 fixture 的差异必须逐项保留，不得统一：
//   * pages 的 CSS 插件读取**真实 CSS 文件**并只导出文件里出现的类名（组件引用未出现的类名会得到
//     undefined），且 HTML 需要注入页面级 fixture 样式；
//   * cards / drafts 的 CSS 插件返回 Proxy（任意 key 都返回 key 名），HTML 不需要额外样式。
// 三套 CDP 辅助函数同名但语义不同（是否先 focus、是否派发 change 事件、settle 时长），
// 因此按语义保留多个名字而不是强行统一。
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { getEngineMeta } from '../../engine/schema.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(new URL('../../package.json', import.meta.url))
const browserPath = process.env.PROMPT_TOOL_TEST_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'

/** pages 成员专用的页面级 fixture 样式（只锁定交互与滚动；像素/主题由独立视觉验收覆盖）。 */
const PAGES_FIXTURE_CSS = '.shell{height:650px;display:flex;flex-direction:column}.canvas{overflow:auto;flex:1;scroll-padding-top:var(--pt-sticky-height,0px)}.nav{display:flex;max-width:400px;overflow:auto}.nav button{min-width:110px}.configCard,.presetCard{min-height:90px;scroll-margin-top:8px}.pageActions{position:sticky;top:0;background:white;z-index:5}.listFilterRow{display:flex;flex-wrap:wrap}.configForm{padding:16px}[hidden]{display:none!important}'

const FIXTURES = {
  pages: { input: 'test/fixtures/ui-v2-pages.mjs', css: 'real' },
  cards: { input: 'test/fixtures/ui-v2-cards.mjs', css: 'proxy' },
  drafts: { input: 'test/fixtures/ui-v2-drafts.mjs', css: 'proxy' },
}

const fixtureHtml = (key) => {
  const bootstrap = `<div id="root"></div><script>window.fixture=${JSON.stringify({ meta: getEngineMeta() })}</script><script src="/${key}.js"></script>`
  const style = key === 'pages' ? `<style>${PAGES_FIXTURE_CSS}</style>` : ''
  return `<!doctype html><meta charset="utf-8">${style}${bootstrap}`
}

/** 按 fixture 的 CSS 语义打包一个浏览器 bundle（pages = 真实类名映射，其余 = Proxy）。 */
async function bundleFixture(key, rolldown, ts) {
  const { input, css } = FIXTURES[key]
  const bundle = await rolldown({
    input: join(root, input), platform: 'browser',
    transform: { define: { 'process.env.NODE_ENV': JSON.stringify('production'), 'process.env': '{}', 'import.meta.env': '{}' } },
    plugins: [{
      name: `ui-v2-smoke-${key}`,
      resolveId(source, importer) {
        if (['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'].includes(source)) return require.resolve(source)
        if (!source.endsWith('.css')) return undefined
        // pages 需要真实路径来读取类名；其余保持原样即可（load 里不读文件）。
        return css === 'real'
          ? '\0test-css:' + resolve(dirname(importer), source) + '.mjs'
          : '\0test-css:' + source + '.mjs'
      },
      load(id) {
        if (!id.startsWith('\0test-css:')) return undefined
        if (css === 'proxy') return 'export default new Proxy({}, {get:(_,key)=>key})'
        const file = id.slice('\0test-css:'.length, -4)
        const names = existsSync(file) ? [...new Set([...readFileSync(file, 'utf8').matchAll(/\.([A-Za-z_][\w-]*)/g)].map((match) => match[1]))] : []
        return `export default ${JSON.stringify(Object.fromEntries(names.map((name) => [name, name])))}`
      },
      transform(code, id) { if (id.endsWith('.tsx')) return ts.transpileModule(code, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2024 } }).outputText },
    }],
  })
  try {
    const { output } = await bundle.generate({ format: 'iife' })
    return output.find((item) => item.type === 'chunk').code
  } finally {
    await bundle.close()
  }
}

/** 首次用例调用时创建：打包三个 fixture → 单 server 三路由 → 单 Edge 实例 → CDP 辅助。 */
let sessionPromise
function ensureSession() {
  if (sessionPromise === undefined) sessionPromise = createSession()
  return sessionPromise
}

async function createSession() {
  const { rolldown } = await import(pathToFileURL(createRequire(require.resolve('tsdown')).resolve('rolldown')))
  const ts = require('typescript')
  const bundles = {}
  for (const key of Object.keys(FIXTURES)) bundles[key] = await bundleFixture(key, rolldown, ts)

  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    const key = path.replace(/^\//, '').replace(/\.js$/, '')
    if (bundles[key] !== undefined && path.endsWith('.js')) {
      res.setHeader('Content-Type', 'text/javascript')
      res.end(bundles[key])
      return
    }
    res.setHeader('Content-Type', 'text/html')
    res.end(fixtureHtml(FIXTURES[key] === undefined ? 'pages' : key))
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')

  const profile = mkdtempSync(join(tmpdir(), 'pt-ui-v2-pages-smoke-'))
  const browser = spawn(browserPath, ['--headless=new', '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' })
  const exited = once(browser, 'exit')
  try {
    const portFile = join(profile, 'DevToolsActivePort')
    let port
    for (let i = 0; i < 150 && !port; i++) {
      try { const candidate = readFileSync(portFile, 'utf8').split('\n')[0]; if (/^\d+$/.test(candidate)) port = candidate } catch {}
      if (!port) await sleep(100)
    }
    assert.ok(port, '隔离浏览器调试端口就绪')
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const ws = new WebSocket(pages.find((page) => page.type === 'page').webSocketDebuggerUrl)
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
    const send = (method, params = {}) => new Promise((resolveCall, rejectCall) => { pending.set(++id, { resolve: resolveCall, reject: rejectCall }); ws.send(JSON.stringify({ id, method, params })) })
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails))
      return result.result.value
    }
    // waitFor：pages / drafts 用 50ms 轮询；waitForFast：cards 用 25ms 并在失败时附焦点信息。
    const waitFor = async (expression) => { for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await sleep(50) } assert.fail(`等待超时：${expression}\n${await evaluate('document.body.innerText')}`) }
    const waitForFast = async (expression) => {
      for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await sleep(25) }
      assert.fail(`等待超时：${expression}\n焦点：${await evaluate('document.activeElement.outerHTML')}\n${await evaluate('document.body.innerText')}`)
    }
    // click：不改变焦点，settle 默认 80ms（cards 传 30）；clickFocused：先 focus 再 click（drafts 语义）。
    const click = async (selector, settle = 80) => { await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); await sleep(settle) }
    const clickFocused = async (selector) => { await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.focus();e.click()})()`); await sleep(60) }
    const clickText = async (value) => { await evaluate(`[...document.querySelectorAll('button')].find(e=>e.getClientRects().length&&e.textContent.trim()===${JSON.stringify(value)}).click()`); await sleep(80) }
    const clickKey = async (key) => { assert.equal(await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>!e.disabled&&e.getClientRects().length&&e.textContent.trim()===window.t(${JSON.stringify(key)}));if(!b)return false;b.focus();b.click();return true})()`), true, key); await sleep(60) }
    const clickAria = async (expression) => { assert.equal(await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>!e.disabled&&e.getClientRects().length&&e.getAttribute('aria-label')===${expression});if(!b)return false;b.focus();b.click();return true})()`), true, expression); await sleep(60) }
    const field = (key) => `document.querySelector('[aria-label="'+window.t(${JSON.stringify(key)})+'"]')`
    // inputPage：只设值 + input/change（pages）；inputCard：先 focus + input，无 change（cards）；
    // inputDraft：按字典 key 定位、focus + input/change（drafts）。三者语义不同，故分开保留。
    const inputPage = async (selector, value) => { await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()`); await sleep(60) }
    const inputCard = async (selector, value) => { await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.focus();Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}))})()`); await sleep(30) }
    const inputDraft = async (key, value) => { await evaluate(`(()=>{const e=${field(key)};e.focus();Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()`); await sleep(30) }
    const blurDraft = async (key) => { await evaluate(`(()=>{const e=${field(key)};e.dispatchEvent(new FocusEvent('focusout',{bubbles:true,relatedTarget:document.querySelector('nav button')}));e.blur()})()`); await sleep(30) }
    const keyPress = async (value) => {
      const windowsVirtualKeyCode = { Enter: 13, ' ': 32, Tab: 9, Escape: 27, End: 35, Home: 36, ArrowDown: 40, ArrowUp: 38 }[value]
      const code = value === ' ' ? 'Space' : value
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: value, code, windowsVirtualKeyCode })
      if (value === 'Enter' || value === ' ') await send('Input.dispatchKeyEvent', { type: 'char', text: value === 'Enter' ? '\r' : ' ', key: value, code, windowsVirtualKeyCode })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: value, code, windowsVirtualKeyCode })
      await sleep(30)
    }
    const chooseMenu = async (label) => { await evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find(el=>el.textContent===${JSON.stringify(label)}).click()`); await sleep(30) }
    const count = (endpoint) => `window.requests.filter(r=>r.endpoint===${JSON.stringify(endpoint)}).length`
    const navigate = async (key) => { await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/${key}` }) }
    return {
      evaluate, waitFor, waitForFast, click, clickFocused, clickText, clickKey, clickAria,
      field, inputPage, inputCard, inputDraft, blurDraft, keyPress, chooseMenu, count, navigate, send,
      ws, browser, exited, server, profile,
    }
  } catch (error) {
    // 会话建立失败时立刻回收，避免遗留浏览器与临时目录。
    try { browser.kill() } catch {}
    server.close()
    throw error
  }
}

after(async () => {
  if (sessionPromise === undefined) return
  const s = await sessionPromise.catch(() => undefined)
  if (s === undefined) return
  if (s.ws?.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify({ id: 0, method: 'Browser.close' }))
  await Promise.race([s.exited, sleep(2000)])
  if (s.browser.exitCode === null) s.browser.kill()
  await s.exited
  s.ws?.close()
  s.server.close()
  await sleep(300)
  assert.ok(resolve(s.profile).startsWith(resolve(tmpdir()) + sep), '只清理本次隔离 profile')
  for (let i = 0; i < 12; i++) { try { rmSync(s.profile, { recursive: true, force: true }); break } catch { await sleep(100) } }
})

test('V2 页面：导航、浏览恢复、配置筛选与保存反馈', { skip: !existsSync(browserPath) && '设置 PROMPT_TOOL_TEST_BROWSER 指向 Edge/Chrome 可执行文件', timeout: 90000 }, async () => {
  const { evaluate, waitFor, click, clickText, inputPage, navigate, send } = await ensureSession()
  await navigate('pages')
  await waitFor(`document.querySelectorAll('[data-config-id]').length===36`)
  assert.equal(await evaluate('window.previewRequests'), 0, '未打开工具页不预取')
  await inputPage('[aria-label="过滤提示词配置"]', 'config-1')
  await click('[data-config-id="config-1"] button[aria-expanded]')
  await evaluate(`document.querySelector('.canvas').scrollTop=640`)
  const before = await evaluate(`document.querySelector('.canvas').scrollTop`)
  await click('#pt-workspace-tab-subagent')
  assert.equal(await evaluate(`document.querySelector('.canvas').scrollTop`), 0, '初访新页归零')
  await click('#pt-workspace-tab-features')
  assert.equal(await evaluate(`document.querySelector('[aria-label="过滤提示词配置"]').value`), 'config-1', '切页恢复搜索')
  assert.equal(await evaluate(`document.querySelector('[data-config-id="config-1"] button[aria-expanded]').getAttribute('aria-expanded')`), 'true', '切页恢复展开')
  assert.ok(Math.abs(await evaluate(`document.querySelector('.canvas').scrollTop`) - before) < 2, '切页恢复滚动')
  await evaluate(`document.querySelector('#pt-workspace-tab-features').focus()`)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End' })
  await waitFor(`document.querySelector('#pt-workspace-tab-characters').getAttribute('aria-selected')==='true'`)
  assert.equal(await evaluate(`document.activeElement.id`), 'pt-workspace-tab-characters')
  assert.equal(await evaluate(`document.querySelectorAll('[role="tab"][tabindex="0"]').length`), 1)
  assert.equal(await evaluate(`(()=>{const e=document.activeElement,r=e.getBoundingClientRect(),p=e.parentElement.getBoundingClientRect();return r.left>=p.left&&r.right<=p.right})()`), true, '末页活动 tab 可见')
  await click('#pt-workspace-tab-features')
  await inputPage('[aria-label="过滤提示词配置"]', 'missing')
  await clickText('清除筛选')
  assert.equal(await evaluate(`document.querySelectorAll('[data-config-id]').length`), 36)
  await clickText('校验')
  await waitFor(`document.querySelector('[data-workspace-sticky]')?.innerText.includes('配置校验通过')`)
  await evaluate('window.rejectSave=true')
  await click('[data-module-toolbar] .primaryPill')
  await waitFor(`document.querySelector('[data-workspace-sticky]')?.innerText.includes('fixture save failed')`)
  assert.equal(await evaluate(`document.querySelectorAll('[role="status"]').length>0`), true)
  await evaluate('window.rejectSave=false')
  await click('[data-module-toolbar] .primaryPill')
  await waitFor(`document.querySelector('[data-workspace-sticky]')?.innerText.includes('已保存')`)

  await click('#pt-workspace-tab-characters')
  await waitFor(`document.querySelectorAll('.presetCard').length===20`)
  await evaluate(`document.querySelector('.canvas').scrollTop=700`)
  await sleep(40)
  await click('#pt-workspace-tab-features')
  await evaluate('window.characterDelay=240')
  await click('#pt-workspace-tab-characters')
  await waitFor(`document.querySelectorAll('.presetCard').length===20`)
  await waitFor(`Math.abs(document.querySelector('.canvas').scrollTop-700)<2`)
  assert.ok(await evaluate(`Math.abs(document.querySelector('.canvas').scrollTop-700)<2`), '异步资源列表完成后再恢复滚动')
  await click('#pt-workspace-tab-features')
  await click('#pt-workspace-tab-characters')
  await click('#pt-workspace-tab-features')
  await click('#pt-workspace-tab-characters')
  await waitFor(`document.querySelectorAll('.presetCard').length===20`)
  await waitFor(`Math.abs(document.querySelector('.canvas').scrollTop-700)<2`)
})

test('V2 卡片：展开语义、菜单焦点、删除/丢弃确认、portal保存与原始草稿', { skip: !existsSync(browserPath) && '设置 PROMPT_TOOL_TEST_BROWSER', timeout: 60000 }, async () => {
  const { evaluate, waitForFast: waitFor, click: clickBase, keyPress: key, inputCard: input, chooseMenu, navigate } = await ensureSession()
  const click = (selector) => clickBase(selector, 30)
  await navigate('cards')
  await waitFor('window.currentFile !== undefined')
  assert.equal(await evaluate(`document.querySelector('[data-module-card]').querySelector('[aria-expanded]')===null`), true)
  assert.equal(await evaluate(`document.querySelector('[data-module-card]').querySelector('[role="switch"]')!==null`), true)
  assert.equal(await evaluate(`[...document.querySelectorAll('button[aria-controls]')].every(el=>document.getElementById(el.getAttribute('aria-controls'))!==null)`), true)
  await click('[data-module-card-id="controlled"] [aria-expanded]')
  await click('#switch-page')
  await click('#switch-page')
  assert.equal(await evaluate(`document.querySelector('[data-module-card-id="controlled"] [aria-expanded]').getAttribute('aria-expanded')`), 'true', '能力展开受控时切页保留')
  await evaluate(`[...document.querySelectorAll('button')].find(el=>el.textContent.includes('普通折叠')).focus()`)
  assert.equal(await evaluate(`document.activeElement.textContent.includes('普通折叠')`), true)
  await key('Enter')
  assert.equal(await evaluate(`document.querySelector('[aria-label="折叠内容"]')!==null`), true, await evaluate(`JSON.stringify({active:document.activeElement.outerHTML,focus:document.hasFocus()})`))
  await key(' ')
  assert.equal(await evaluate(`document.querySelector('[aria-label="折叠内容"]')===null`), true)
  await click('[aria-label="普通配置 的操作"]')
  await waitFor(`document.activeElement?.getAttribute('role')==='menuitem'`)
  assert.equal(await evaluate('document.activeElement.textContent'), '下移')
  await key('End')
  assert.equal(await evaluate('document.activeElement.textContent'), '删除')
  await key('Escape')
  assert.equal(await evaluate(`document.activeElement.getAttribute('aria-label')`), '普通配置 的操作')
  assert.equal(await evaluate('window.events.outerEscape'), 0)
  await evaluate(`(()=>{const b=document.querySelector('[data-config-id="ordinary"] [aria-label="拼接位置"]');b.focus();b.click()})()`)
  await waitFor(`document.activeElement?.getAttribute('role')==='menuitem'`)
  assert.equal(await evaluate(`document.querySelector('[role="tooltip"]')===null`), true, '字段菜单portal不展示锚点帮助')
  await key('Escape')
  assert.equal(await evaluate(`document.querySelector('[role="menu"]')===null`), true)
  await click('[aria-label="普通配置 的操作"]')
  await waitFor(`document.activeElement?.getAttribute('role')==='menuitem'`)
  await key('Tab')
  assert.equal(await evaluate(`document.querySelector('[role="menu"]')===null`), true)
  assert.equal(await evaluate(`document.activeElement!==document.body`), true)
  await click('[aria-label="普通配置 的操作"]')
  await chooseMenu('删除')
  await waitFor(`document.activeElement.textContent==='取消'`)
  assert.equal(await evaluate(`document.querySelector('[role="alertdialog"]').getAttribute('aria-describedby')!==null`), true)
  await key('Escape')
  assert.equal(await evaluate('window.events.deleted'), 0)
  assert.equal(await evaluate(`document.activeElement.getAttribute('aria-label')`), '普通配置 的操作')
  await click('[aria-label="普通配置 的操作"]')
  await chooseMenu('删除')
  await evaluate(`window.failDelete=true; const b=[...document.querySelector('[role="alertdialog"]').querySelectorAll('button')].find(el=>el.textContent==='确认删除'); b.click();b.click()`)
  await waitFor(`document.querySelector('[role="alert"]')?.textContent.includes('删除失败')`)
  assert.equal(await evaluate('window.events.deleted'), 1)
  await key('Escape')
  const textSelector = '[data-config-id="file"] textarea[aria-label="注入内容（空 = 不注入）"]'
  await input(textSelector, 'unsaved text')
  await evaluate(`const trigger=document.querySelector('[aria-label="AGENTS.md 的操作"]');trigger.focus();trigger.click()`)
  await waitFor(`document.activeElement.getAttribute('role')==='menuitem'`)
  assert.equal(await evaluate('window.events.saved'), 0, '进入卡片portal不保存')
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('[role="menuitem"]')].map(el=>el.textContent)`), ['上移', '下移'])
  await key('Escape')
  await evaluate(`document.querySelector('#outside').focus()`)
  await waitFor('window.events.saved===1')
  assert.equal(await evaluate('window.savedText'), 'unsaved text')
  await evaluate('window.setConflict(true)')
  await waitFor(`document.querySelector('[data-config-id="file"]').textContent.includes('磁盘版本已变化')`)
  await evaluate(`[...document.querySelector('[data-config-id="file"]').querySelectorAll('button')].find(el=>el.textContent==='重新读取').click()`)
  await waitFor(`document.activeElement.textContent==='取消'`)
  await key('Escape')
  assert.equal(await evaluate('window.currentFile.text'), 'unsaved text')
  assert.equal(await evaluate('window.events.saved'), 1)
  assert.equal(await evaluate('window.events.reloaded'), 0)
  await evaluate(`[...document.querySelector('[data-config-id="file"]').querySelectorAll('button')].find(el=>el.textContent==='重新读取').click()`)
  await waitFor(`document.activeElement.textContent==='取消'`)
  assert.deepEqual(await evaluate(`[...document.querySelector('[role="alertdialog"]').querySelectorAll('button')].map(el=>el.textContent)`), ['×', '取消', '重新读取'])
  await evaluate(`[...document.querySelector('[role="alertdialog"]').querySelectorAll('button')].find(el=>el.textContent==='重新读取').click()`)
  await waitFor('window.events.reloaded===1')
  assert.equal(await evaluate('window.currentFile.text'), 'fresh disk')
  const jsonSelector = '[data-config-id="ordinary"] textarea[aria-label="高级参数（JSON）"]'
  await input(jsonSelector, '{invalid')
  await evaluate(`document.querySelector('#outside').focus()`)
  await waitFor(`document.querySelector(${JSON.stringify(jsonSelector)}).getAttribute('aria-invalid')==='true'`)
  const errorLink = await evaluate(`document.querySelector(${JSON.stringify(jsonSelector)}).getAttribute('aria-describedby')`)
  assert.ok(await evaluate(`document.getElementById(${JSON.stringify(errorLink)})?.textContent.length>0`))
  await click('#switch-page')
  await click('#switch-page')
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(jsonSelector)}).value`), '{invalid')
  assert.deepEqual(await evaluate('window.currentConfig.params'), { nested: true })
  await input(jsonSelector, '{"changed":true}')
  await evaluate(`document.querySelector('#outside').focus()`)
  await waitFor('window.currentConfig.params.changed===true')
  const numberSelector = '[data-config-id="ordinary"] input[inputmode="numeric"]'
  await input(numberSelector, '-')
  await click('#switch-page')
  await click('#switch-page')
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(numberSelector)}).value`), '-')
  assert.equal(await evaluate('window.currentConfig.order'), 2)
  await input(numberSelector, '7')
  await evaluate(`document.querySelector('#outside').focus()`)
  await waitFor('window.currentConfig.order===7')
  assert.equal(await evaluate(`[...window.fieldDrafts.values()].some(d=>d.text!==d.source||d.error)`), false)
  await evaluate(`document.querySelector('[data-config-id="ordinary"] details').open=false; window.patchOrdinary({role:'future-role'})`)
  await waitFor(`document.querySelector('[data-config-id="ordinary"] [aria-label="消息角色"]').textContent.includes('future-role')`)
  assert.equal(await evaluate(`document.querySelector('[data-config-id="ordinary"] details').open`), false, '普通更新不重开details')
  await evaluate('window.setReadOnly(true)')
  await waitFor(`document.querySelector('[data-config-id="ordinary"] input').readOnly`)
  assert.equal(await evaluate(`[...document.querySelectorAll('[data-config-id="ordinary"] textarea')].every(input=>input.readOnly||input.matches(':disabled'))`), true)
  assert.equal(await evaluate(`document.querySelector('[data-config-id="ordinary"] [role="switch"]').disabled`), true)
  assert.equal(await evaluate(`document.querySelector('[data-config-id="ordinary"] [aria-controls]').disabled`), false)
  await evaluate('window.setReadOnly(false);window.setSaving(true)')
  await input(textSelector, 'typed while saving')
  await evaluate(`document.querySelector('#outside').focus()`)
  assert.equal(await evaluate('window.events.saved'), 1, '保存中继续输入不会并发写入')
  assert.equal(await evaluate('window.currentFile.text'), 'typed while saving')
  await evaluate('window.setSaving(false)')
  await evaluate(`document.querySelector(${JSON.stringify(textSelector)}).focus();document.querySelector('#outside').focus()`)
  await waitFor('window.events.saved===2')
  assert.equal(await evaluate('window.savedText'), 'typed while saving')
  await click('[aria-label="普通配置 的操作"]')
  await chooseMenu('删除')
  await evaluate(`window.failDelete=false;[...document.querySelector('[role="alertdialog"]').querySelectorAll('button')].find(el=>el.textContent==='确认删除').click()`)
  await waitFor(`document.querySelector('[data-config-id="ordinary"]')===null`)
  assert.equal(await evaluate(`document.activeElement.closest('[data-config-id]')?.getAttribute('data-config-id')`), 'file', '成功删除聚焦邻卡')
  await evaluate(`document.querySelector('[aria-label="测试官方开关"]').focus()`)
  await waitFor(`document.querySelector('[role="tooltip"]')?.textContent==='官方开关帮助'`)
  assert.equal(await evaluate(`document.querySelector('[aria-label="测试官方开关"]').getAttribute('aria-describedby')===document.querySelector('[role="tooltip"]').id`), true)
  await key('Escape')
  assert.equal(await evaluate(`document.querySelector('[role="tooltip"]')===null`), true)
})

test('V2 草稿与资源：原文恢复、快照保存、技能目标及危险删除', { skip: !existsSync(browserPath) && '设置 PROMPT_TOOL_TEST_BROWSER 指向 Edge/Chrome 可执行文件', timeout: 90000 }, async () => {
  const { evaluate, waitFor, clickFocused: click, clickKey, clickAria, field, inputDraft: input, blurDraft: blur, count, navigate } = await ensureSession()
  await navigate('drafts')
  await waitFor(`document.querySelector('[data-tool-card]')!==null`)
  await click('[data-tool-card] button[aria-expanded]')
  await input('toolEditor.json.advanced', '{ broken')
  await blur('toolEditor.json.advanced')
  assert.equal(await evaluate(`${field('toolEditor.json.advanced')}.getAttribute('aria-invalid')`), 'true', await evaluate(`JSON.stringify({value:${field('toolEditor.json.advanced')}.value,fields:[...window.store.editorDrafts.tools.get('test').fields]})`))
  await input('toolEditor.timeoutAria', '1e')
  await blur('toolEditor.timeoutAria')
  await click('[data-page="persona"]')
  await click('[data-page="tools"]')
  assert.equal(await evaluate(`${field('toolEditor.json.advanced')}.value`), '{ broken', '无效 JSON 原文跨页保留')
  assert.equal(await evaluate(`${field('toolEditor.json.advanced')}.getAttribute('aria-invalid')`), 'true')
  assert.equal(await evaluate(`${field('toolEditor.timeoutAria')}.value`), '1e', '数字中间态跨页保留')
  assert.equal(await evaluate(`${field('toolEditor.timeoutAria')}.getAttribute('aria-invalid')`), 'true')
  await input('toolEditor.field.idAria', 'tool-one:x')
  assert.equal(await evaluate(`${field('toolEditor.json.advanced')}.value`), '{ broken', '改名迁移原始JSON草稿')
  assert.equal(await evaluate(`window.store.editorDrafts.tools.get('test').fields.has('tool-one:parameters')`), false, '旧标识不遗留孤儿草稿')
  const beforeInvalidSave = await evaluate(`window.requests.filter(r=>r.endpoint==='custom-tools'&&r.body.customTools).length`)
  await click('[data-tool-card] button[aria-haspopup="menu"]')
  await clickKey('toolEditor.remove')
  await clickKey('toolEditor.cancel')
  assert.equal(await evaluate(`document.activeElement===document.querySelector('[data-tool-card] button[aria-haspopup="menu"]')`), true, '工具删除取消还焦菜单按钮')
  await clickKey('customTools.save')
  assert.equal(await evaluate(`window.requests.filter(r=>r.endpoint==='custom-tools'&&r.body.customTools).length`), beforeInvalidSave, '无效输入不提交')
  await input('toolEditor.json.advanced', '{}'); await blur('toolEditor.json.advanced')
  await input('toolEditor.timeoutAria', '1200'); await blur('toolEditor.timeoutAria')
  await input('toolEditor.field.descriptionAria', 'submitted tool')
  await evaluate('window.delay=350')
  await clickKey('customTools.save')
  await input('toolEditor.field.descriptionAria', 'later tool')
  await click('[data-page="persona"]')
  await click('[data-page="tools"]')
  await waitFor(`window.store.editorDrafts.tools.get('test').saving===false`)
  assert.equal(await evaluate(`${field('toolEditor.field.descriptionAria')}.value`), 'later tool')
  assert.equal(await evaluate(`window.store.editorDrafts.tools.get('test').saved[0].description`), 'submitted tool')
  assert.equal(await evaluate(`window.dirty()`), true)
  assert.equal(await evaluate(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===window.t('customTools.save'))?.disabled`), false, '回页组件收到在途保存结果')

  await click('[data-page="persona"]')
  await waitFor(`document.querySelector('article button[aria-expanded]')!==null`)
  await click('article button[aria-expanded]')
  await input('persona.prefix.aria', 'submitted persona')
  await clickKey('persona.save')
  await input('persona.prefix.aria', 'later persona')
  await click('[data-page="tools"]'); await click('[data-page="persona"]')
  if (await evaluate(`${field('persona.prefix.aria')}===null`)) await click('article button[aria-expanded]')
  await waitFor(`window.store.editorDrafts.persona.get('test').saving===false`)
  assert.equal(await evaluate(`${field('persona.prefix.aria')}.value`), 'later persona')
  assert.equal(await evaluate(`window.store.editorDrafts.persona.get('test').saved.prefix`), 'submitted persona')
  assert.equal(await evaluate(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===window.t('persona.save'))?.disabled`), false)

  await evaluate('window.delay=0')
  await click('[data-page="skills"]')
  await waitFor(`document.querySelector('[data-skill-delete]')!==null`)

  // 来源分组：按官方优先级分组渲染（drafts fixture 的 CSS 是 Proxy，断言只用语义属性与文案）。
  // 分组标题走字典键，不再取共享常量的中文标签；期望值在页面里用同一个 t 求值，断言里不写死文案。
  assert.equal(
    await evaluate(`JSON.stringify([...document.querySelectorAll('section[aria-label]')].map(s=>s.getAttribute('aria-label')).filter(l=>l===window.t('skills.source.project-dsh')||l===window.t('skills.source.user-dsh')))`),
    await evaluate(`JSON.stringify([window.t('skills.source.project-dsh'),window.t('skills.source.user-dsh')])`),
    '来源分组顺序与官方优先级一致')
  assert.equal(await evaluate(`document.querySelectorAll('[role="switch"][aria-label]').length`), 4, '两个技能行各有模型与用户两个调用策略开关')
  assert.equal(await evaluate(`document.body.innerText.includes(window.t('skills.group.meta',{count:1,rank:100}))`), true, '分组头部展示来源优先级 100')
  assert.equal(await evaluate(`document.body.innerText.includes(window.t('skills.group.meta',{count:1,rank:400}))`), true, '分组头部展示来源优先级 400')

  // 文件层调用策略：两个开关各自独立，只提交 skill-policy 载荷（name + 标记文件 path + scope），
  // 由服务端改写该技能 SKILL.md 的 frontmatter；技能实体留在原处，写盘失败不做乐观更新。
  const modelToggle = (name) => `window.t('skills.row.modelToggle.aria',{name:'${name}'})`
  const userToggle = (name) => `window.t('skills.row.userToggle.aria',{name:'${name}'})`
  const fieldOf = (name) => `window.store.getFields().skillCatalog.find(s=>s.name==='${name}')`
  const switchOf = (label) => `document.querySelector('[role="switch"][aria-label="'+${label}+'"]')`
  // 只有写盘空闲（skillsBusy=false）时开关才可用：每次点击前先等它可用，顺带证明上一次写入已完全收尾。
  const clickToggle = async (label) => { await waitFor(`${switchOf(label)}.disabled===false`); await clickAria(label) }
  const alphaPath = 'D:/isolated/skills/alpha/SKILL.md'

  // 关用户端：scope=user 只停用用户端，模型端事实与开关都不动；只关一端不出现 data-blocked。
  await clickToggle(userToggle('alpha'))
  await waitFor(`${count('skill-policy')}===1`)
  assert.equal(await evaluate(`JSON.stringify(window.requests.find(r=>r.endpoint==='skill-policy').body)`),
    `{"name":"alpha","path":"${alphaPath}","side":"user","enabled":false}`, '只关用户端时载荷带该技能自己的标记文件路径')
  await waitFor(`${fieldOf('alpha')}.userInvocable===false`)
  assert.equal(await evaluate(`${fieldOf('alpha')}.modelInvocable`), true, '模型端事实不受影响')
  assert.equal(await evaluate(`${switchOf(userToggle('alpha'))}.getAttribute('aria-checked')`), 'false', '用户开关反映停用后的 frontmatter 事实')
  assert.equal(await evaluate(`${switchOf(modelToggle('alpha'))}.getAttribute('aria-checked')`), 'true', '模型开关保持开启')
  assert.equal(await evaluate(`document.querySelectorAll('[data-blocked]').length`), 0, '只关一端不算两端不可用')

  // 再关模型端 → scope=all：两端都停用，卡片才出现 data-blocked，徽章改报两端停用。
  await clickToggle(modelToggle('alpha'))
  await waitFor(`${count('skill-policy')}===2`)
  assert.equal(await evaluate(`JSON.stringify(window.requests.filter(r=>r.endpoint==='skill-policy')[1].body)`),
    `{"name":"alpha","path":"${alphaPath}","side":"model","enabled":false}`)
  await waitFor(`${fieldOf('alpha')}.modelInvocable===false`)
  await waitFor(`document.querySelectorAll('[data-blocked]').length===1`)
  assert.equal(await evaluate(`document.querySelector('[data-blocked]').innerText.includes(window.t('skills.status.blocked'))`), true, '两端不可用卡片显示整体停用文案')
  // 两端都停用后开关仍可用：逐端恢复必须留在界面上，不能被写成死端。
  await waitFor(`${switchOf(modelToggle('alpha'))}.disabled===false`)
  assert.equal(await evaluate(`${switchOf(userToggle('alpha'))}.disabled`), false, '两端都停用时用户开关仍可用')
  // 页签归类与状态谓词同源：两端都停用的技能在「两端不可用」页签里仍可见、仍可操作。
  await click('#pt-skills-tab-blocked')
  assert.equal(await evaluate(`document.body.innerText.includes(window.t('skills.visible',{count:1}))`), true, '「两端不可用」页签只收两端都停用的技能')
  assert.equal(await evaluate(`${switchOf(modelToggle('alpha'))}!==null`), true, '两端不可用的技能在该页签里仍可操作')
  await click('#pt-skills-tab-all')
  assert.equal(await evaluate(`document.body.innerText.includes(window.t('skills.visible',{count:2}))`), true, '回到「全部」页签看到两个技能')

  // 恢复：两端都停用后逐端恢复——先点用户端只剩模型端停用（scope=model）。
  await clickToggle(userToggle('alpha'))
  await waitFor(`${count('skill-policy')}===3`)
  assert.equal(await evaluate(`JSON.stringify(window.requests.filter(r=>r.endpoint==='skill-policy')[2].body)`),
    `{"name":"alpha","path":"${alphaPath}","side":"user","enabled":true}`, '恢复用户端只提交本端状态')
  await waitFor(`${fieldOf('alpha')}.userInvocable===true`)
  assert.equal(await evaluate(`${fieldOf('alpha')}.modelInvocable`), false, '模型端仍停用')
  await clickToggle(modelToggle('alpha'))
  await waitFor(`${count('skill-policy')}===4`)
  assert.equal(await evaluate(`JSON.stringify(window.requests.filter(r=>r.endpoint==='skill-policy')[3].body)`),
    `{"name":"alpha","path":"${alphaPath}","side":"model","enabled":true}`)
  await waitFor(`${fieldOf('alpha')}.modelInvocable===true`)
  assert.equal(await evaluate(`${switchOf(modelToggle('alpha'))}.getAttribute('aria-checked')`), 'true')
  assert.equal(await evaluate(`${switchOf(userToggle('alpha'))}.getAttribute('aria-checked')`), 'true')
  assert.equal(await evaluate(`document.querySelectorAll('[data-blocked]').length`), 0, '两端恢复后不再有 data-blocked')

  // 写盘失败不乐观更新：在途期间条目字段与开关都还是磁盘事实，失败后同样不变，错误进入通知。
  await evaluate(`window.failedSkill='alpha';window.delay=300`)
  await clickToggle(userToggle('alpha'))
  await waitFor(`${count('skill-policy')}===5`)
  assert.equal(await evaluate(`${fieldOf('alpha')}.userInvocable`), true, '在途期间不乐观更新客户端事实')
  assert.equal(await evaluate(`${switchOf(userToggle('alpha'))}.getAttribute('aria-checked')`), 'true', '在途期间开关保持磁盘事实')
  await waitFor(`document.querySelector('[data-notice]').textContent.includes('failed alpha')`)
  assert.equal(await evaluate(`${fieldOf('alpha')}.userInvocable`), true, '失败不乐观更新客户端事实')
  assert.equal(await evaluate(`${fieldOf('alpha')}.modelInvocable`), true)
  assert.equal(await evaluate(`${switchOf(userToggle('alpha'))}.getAttribute('aria-checked')`), 'true', '失败后开关回到磁盘事实')
  assert.equal(await evaluate(`document.querySelectorAll('[data-blocked]').length`), 0)
  await evaluate(`window.failedSkill='';window.delay=0`)

  // 技能资产卡默认折叠：展开后才是导入、创建与引用入口。
  await evaluate(`(()=>{const b=[...document.querySelectorAll('button[aria-expanded]')].find(e=>e.textContent.includes(window.t('skills.library.title')));if(b&&b.getAttribute('aria-expanded')!=='true')b.click()})()`)
  await sleep(80)
  assert.equal(await evaluate(`document.querySelector('[aria-label="'+window.t('skills.import.path.aria')+'"]')!==null`), true, '展开后出现复制导入入口')
  assert.equal(await evaluate(`document.querySelector('[aria-label="'+window.t('skills.folders.aria')+'"]')!==null`), true, '展开后出现文件夹引用入口')

  // 创建技能：写用户技能根，提交成功后收起表单。
  await clickKey('skills.create.open')
  await input('skills.create.name', 'gamma')
  await input('skills.create.description', 'created by test')
  await input('skills.create.content', '# gamma')
  await clickKey('skills.create.submit')
  await waitFor(`${count('skill-create')}===1`)
  assert.equal(await evaluate(`JSON.stringify(window.requests.find(r=>r.endpoint==='skill-create').body)`),
    '{"name":"gamma","description":"created by test","content":"# gamma"}')
  await waitFor(`window.store.getFields().skillCatalog.some(s=>s.name==='gamma')`)
  assert.equal(await evaluate(`${field('skills.create.name')}===null`), true, '成功后收起创建表单')

  // 复制导入：宿主机目录只作一次性复制来源，不建立第二发现根。
  await input('skills.import.path.aria', 'D:/drop/gamma')
  await clickKey('skills.import.fromDir')
  await waitFor(`${count('skills-import-directory')}===1`)
  assert.equal(await evaluate(`JSON.stringify(window.requests.find(r=>r.endpoint==='skills-import-directory').body)`), '{"path":"D:/drop/gamma"}')
  await waitFor(`document.querySelector('[aria-label="'+window.t('skills.import.path.aria')+'"]').value===''`)

  // 宿主目录与浏览器上传都先等待覆盖确认；取消不重发，确认只携带列出的目录。
  await evaluate(`window.skillImportConflicts=['gamma']`)
  await input('skills.import.path.aria', 'D:/drop/gamma')
  await clickKey('skills.import.fromDir')
  await waitFor(`document.querySelector('[role="alertdialog"]')!==null`)
  assert.equal(await evaluate(count('skills-import-directory')), 2, '确认前只有一次探测请求')
  await click('[role="alertdialog"] button:not([data-danger])')
  await waitFor(`window.store.skillsBusy===false`)
  assert.equal(await evaluate(count('skills-import-directory')), 2, '取消不覆盖')
  await clickKey('skills.import.fromDir')
  await waitFor(`document.querySelector('[role="alertdialog"]')!==null`)
  await click('[role="alertdialog"] button[data-danger]')
  await waitFor(`${count('skills-import-directory')}===4 && window.store.skillsBusy===false`)
  assert.equal(await evaluate(`JSON.stringify(window.requests.filter(r=>r.endpoint==='skills-import-directory').at(-1).body)`),
    '{"path":"D:/drop/gamma","overwrite":["gamma"]}')
  await evaluate(`(()=>{const input=document.querySelector('input[webkitdirectory]');const files=new DataTransfer();const f=new File(['skill body'],'SKILL.md');Object.defineProperty(f,'webkitRelativePath',{value:'pack/gamma/SKILL.md'});files.items.add(f);input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  await waitFor(`document.querySelector('[role="alertdialog"]')!==null`)
  assert.equal(await evaluate(count('skills-import')), 1)
  await click('[role="alertdialog"] button[data-danger]')
  await waitFor(`${count('skills-import')}===2`)
  assert.equal(await evaluate(`JSON.stringify(window.requests.filter(r=>r.endpoint==='skills-import').at(-1).body.overwrite)`), '["gamma"]')
  assert.equal(await evaluate(`window.requests.filter(r=>r.endpoint==='skills-import')[0].body.files[0].content === window.requests.filter(r=>r.endpoint==='skills-import')[1].body.files[0].content`), true, '确认重用同一上传载荷')
  await evaluate('window.skillImportConflicts=[]')
  await evaluate('window.skillImportWarning="retained-backup"')
  await input('skills.import.path.aria', 'D:/drop/cleanup-warning')
  await clickKey('skills.import.fromDir')
  await waitFor('window.store.skillsBusy===false')
  assert.equal(await evaluate('document.querySelector("[data-notice]").textContent.includes("导入已完成，清理提示：retained-backup")'), true)
  await evaluate('window.skillImportWarning=undefined')

  // 文件夹引用：只登记路径，不复制文件；移除只删记录。
  await input('skills.folders.aria', 'D:/referenced/skills')
  await clickKey('skills.folders.add')
  await waitFor(`${count('skills-folders')}===1`)
  assert.equal(await evaluate(`JSON.stringify(window.requests.find(r=>r.endpoint==='skills-folders').body)`), '{"folders":["D:/referenced/skills"]}')
  await waitFor(`window.store.getFields().skillFolders.length===1`)
  await clickKey('skills.folders.remove')
  await waitFor(`${count('skills-folders')}===2`)
  assert.equal(await evaluate(`JSON.stringify(window.requests.filter(r=>r.endpoint==='skills-folders')[1].body)`), '{"folders":[]}')
  await waitFor(`window.store.getFields().skillFolders.length===0`)

  // 引用目录保存失败：错误进入通知、引用列表不变、输入草稿保留（失败不半提交、不静默清空）。
  await evaluate('window.rejectSkillsFolders=true')
  await input('skills.folders.aria', 'D:/referenced/broken')
  await clickKey('skills.folders.add')
  await waitFor(`${count('skills-folders')}===3`)
  await waitFor(`document.querySelector('[data-notice]').textContent.includes('skills folders rejected')`)
  assert.equal(await evaluate(`window.store.getFields().skillFolders.length`), 0, '失败不写入引用列表')
  assert.equal(await evaluate(`document.querySelector('[aria-label="'+window.t('skills.folders.aria')+'"]').value`), 'D:/referenced/broken', '失败保留输入草稿')
  await evaluate('window.rejectSkillsFolders=false')
  // 故障复位后重放同一次提交：草稿还在，成功路径必须走通（失败后的可恢复性）。
  await clickKey('skills.folders.add')
  await waitFor(`${count('skills-folders')}===4`)
  await waitFor(`window.store.getFields().skillFolders.length===1`)
  assert.equal(await evaluate(`JSON.stringify(window.store.getFields().skillFolders)`), JSON.stringify(['D:/referenced/broken']))

  // 回收站删除：确认后按目录名提交，失败保留技能行与错误提示。
  await click('[data-skill-delete="alpha"]')
  await waitFor(`document.querySelector('[role="alertdialog"]')!==null`)
  await click('[role="alertdialog"] button[data-danger]')
  await waitFor(`${count('skill-delete')}===1`)
  assert.equal(await evaluate(`JSON.stringify(window.requests.find(r=>r.endpoint==='skill-delete').body)`), `{"name":"alpha","path":"${alphaPath}"}`)
  await waitFor(`window.store.getFields().skillCatalog.every(s=>s.name!=='alpha')`)

  await evaluate('window.rejectSkillDelete=true')
  await click('[data-skill-delete="gamma"]')
  await waitFor(`document.querySelector('[role="alertdialog"]')!==null`)
  await click('[role="alertdialog"] button[data-danger]')
  await waitFor(`${count('skill-delete')}===2`)
  await waitFor(`document.querySelector('[data-notice]').textContent.includes('delete rejected')`)
  assert.equal(await evaluate(`window.store.getFields().skillCatalog.some(s=>s.name==='gamma')`), true, '删除失败保留技能行')
  await evaluate('window.rejectSkillDelete=false')
  await waitFor(`document.querySelector('[role="alertdialog"]')!==null`)
  await click('[role="alertdialog"] button[data-danger]')
  await waitFor(`${count('skill-delete')}===3`)
  await waitFor(`window.store.getFields().skillCatalog.every(s=>s.name!=='gamma')`)

  // 局部刷新只改技能字段；同名目录的确认与请求必须绑定点击的条目。
  const bootstrapBefore = await evaluate(count('bootstrap'))
  await evaluate(`window.store.patch({modelName:'unsaved-model',stages:[{name:'draft-stage',tools:'read'}]});window.keptConfigs=window.store.getFields().promptConfigs`)
  await evaluate(`(()=>{const base=window.getSkills()[0];window.setSkills([
    {...base,id:'project-common',name:'project-helper',folder:'common',path:'D:/project/skills/common/SKILL.md',canDelete:false},
    {...base,id:'custom-common',name:'custom-helper',folder:'common',dir:'D:/referenced/skills',path:'D:/referenced/skills/common/SKILL.md',source:'custom',availability:'active',canDelete:true},
    {...base,id:'user-common',name:'user-helper',folder:'common',dir:'D:/isolated/skills',path:'D:/isolated/skills/common/SKILL.md',source:'user-dsh',canDelete:true}
  ]);window.skillsComplete=false;return window.store.refreshSkills()})()`)
  assert.equal(await evaluate('window.store.getFields().modelName'), 'unsaved-model')
  assert.equal(await evaluate('window.store.getFields().stages[0].name'), 'draft-stage')
  assert.equal(await evaluate('window.store.getFields().promptConfigs===window.keptConfigs'), true)
  assert.equal(await evaluate(count('bootstrap')), bootstrapBefore, '技能刷新不重新读取整个工作台')
  assert.equal(await evaluate('document.body.innerText.includes(window.t("skills.incomplete"))'), true)
  assert.equal(await evaluate(`${switchOf(modelToggle('custom-helper'))}.disabled`), false, '观测未知不禁止引用技能文件开关')
  await clickToggle(modelToggle('custom-helper'))
  await waitFor(`${fieldOf('custom-helper')}.modelInvocable===false && window.store.skillsBusy===false`)
  await click('[data-skill-path="D:/isolated/skills/common/SKILL.md"]')
  await waitFor('document.querySelector("[role=alertdialog]")!==null')
  assert.equal(await evaluate('document.querySelector("[role=alertdialog]").innerText.includes(window.t("skills.delete.title",{name:"user-helper"}))'), true)
  assert.equal(await evaluate('document.querySelector("[role=alertdialog]").innerText.includes("D:/isolated/skills/common/SKILL.md")'), true)
  await click('[role="alertdialog"] button[data-danger]')
  await waitFor(`window.store.getFields().skillCatalog.every(s=>s.name!=='user-helper') && window.store.skillsBusy===false`)
  assert.equal(await evaluate(`JSON.stringify(window.requests.filter(r=>r.endpoint==='skill-delete').at(-1).body)`), '{"name":"user-helper","path":"D:/isolated/skills/common/SKILL.md"}')
  assert.equal(await evaluate(`window.store.getFields().skillCatalog.some(s=>s.name==='project-helper')`), true)
  await click('[data-skill-path="D:/referenced/skills/common/SKILL.md"]')
  await waitFor('document.querySelector("[role=alertdialog]")!==null')
  await click('[role="alertdialog"] button[data-danger]')
  await waitFor(`window.store.getFields().skillCatalog.every(s=>s.name!=='custom-helper') && window.store.skillsBusy===false`)
  assert.equal(await evaluate(`JSON.stringify(window.requests.filter(r=>r.endpoint==='skill-delete').at(-1).body)`), '{"name":"custom-helper","path":"D:/referenced/skills/common/SKILL.md"}')

  // 较慢旧响应不能复活已清空的清单；会话身份随请求传递。
  await evaluate(`(async()=>{window.skillsListDelay=120;const old=window.store.refreshSkills();window.setSkills([]);window.skillsComplete=true;window.skillsListDelay=0;window.currentSessionId='next-session';await window.store.refreshSkills();await old})()`)
  assert.equal(await evaluate('window.store.getFields().skillCatalog.length'), 0)
  assert.equal(await evaluate('window.store.getFields().skillsComplete'), true)
  assert.equal(await evaluate(`window.requests.filter(r=>r.endpoint==='skills-list').at(-1).body.sessionId`), 'next-session')
  assert.equal(await evaluate('window.store.getFields().modelName'), 'unsaved-model')
  assert.equal(await evaluate(count('bootstrap')), bootstrapBefore)

  await click('[data-page="presets"]')
  await clickAria(`window.t('presetSwitcher.delete.aria',{name:'Other'})`)
  await waitFor(`document.querySelector('[role="alertdialog"]')!==null`)
  const confirmButton = `[...document.querySelector('[role="alertdialog"]').querySelectorAll('button')].find(e=>e.textContent.trim()===window.t('presetSwitcher.delete.confirm'))`
  const cancelButton = `[...document.querySelector('[role="alertdialog"]').querySelectorAll('button')].find(e=>e.textContent.trim()===window.t('presetSwitcher.delete.cancel'))`
  assert.equal(await evaluate(`${confirmButton}?.className`), 'pillButton', '确认删除与取消同为胶囊按钮')
  assert.equal(await evaluate(`${confirmButton}?.hasAttribute('data-danger')`), true, '确认删除使用统一的描边染红危险形态')
  assert.equal(await evaluate(`${cancelButton}?.className`), 'pillButton', '取消按钮与确认按钮同族几何')
  assert.equal(await evaluate(`${cancelButton}?.hasAttribute('data-danger')`), false, '取消按钮不是危险形态')
  await clickKey('presetSwitcher.delete.cancel')
  assert.equal(await evaluate(count('preset-delete')), 0, '取消删除零请求')
  await evaluate('window.rejectDelete=true;window.delay=100')
  await clickAria(`window.t('presetSwitcher.delete.aria',{name:'Other'})`)
  await clickKey('presetSwitcher.delete.confirm')
  await waitFor(`document.querySelector('[role="alertdialog"]')?.innerText.includes('delete rejected')`)
  await evaluate('window.rejectDelete=false;window.delay=200')
  await evaluate(`(()=>{const b=[...document.querySelectorAll('[role="alertdialog"] button')].find(e=>e.textContent.trim()===window.t('presetSwitcher.delete.confirm'));b.click();b.click()})()`)
  await waitFor(`document.querySelector('[role="alertdialog"]')===null`)
  assert.equal(await evaluate(count('preset-delete')), 2, '失败后重试双击只有一次新请求')

  // 删除配置只清理该配置的字段，保留同预设其他配置的原始草稿。
  await click('[data-page="configs"]')
  const editOrder = async (id, value) => {
    await click(`[data-config-id="${id}"] button[aria-controls]`)
    await evaluate(`(()=>{const card=document.querySelector('[data-config-id="${id}"]');const label=[...card.querySelectorAll('label')].find(e=>e.textContent===window.t('form.order.label'));const e=document.getElementById(label.htmlFor);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    await sleep(30)
  }
  await editOrder('one', '1e')
  await editOrder('two', '-')
  await evaluate(`(()=>{const card=document.querySelector('[data-config-id="two"]');const label=[...card.querySelectorAll('label')].find(e=>e.textContent===window.t('form.id.label'));const e=document.getElementById(label.htmlFor);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'two:new');e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  await waitFor(`document.querySelector('[data-config-id="two:new"]')!==null`)
  assert.equal(await evaluate(`window.store.editorDrafts.fields.get('test:two:new:order').text`), '-', '配置改名保留字段草稿')
  const deleteConfig = async (id) => {
    await click(`[data-config-id="${id}"] button[aria-haspopup="menu"]`)
    await clickKey('card.delete')
    await clickKey('card.confirmDelete')
  }
  await deleteConfig('one')
  assert.equal(await evaluate(`[...window.store.editorDrafts.fields.keys()].some(k=>k.startsWith('test:one:'))`), false)
  assert.equal(await evaluate(`window.store.editorDrafts.fields.get('test:two:new:order').text`), '-', '其他配置草稿保留')
  await deleteConfig('two:new')
  assert.equal(await evaluate(`[...window.store.editorDrafts.fields.keys()].some(k=>k.startsWith('test:two:'))`), false)

  // 策略编辑器跨卸载共享在途保存队列，干净重挂重新读取，部署只读封锁写入。
  await evaluate('window.delay=300')
  await click('[data-page="policy"]')
  await waitFor(`${field('profile name')}!==null`)
  await input('profile name', 'submitted policy'); await blur('profile name')
  await waitFor('window.policyInFlight===1')
  await input('profile name', 'later policy')
  await click('[data-page="tools"]'); await click('[data-page="policy"]')
  assert.equal(await evaluate(`${field('profile name')}.value`), 'later policy')
  await blur('profile name')
  await waitFor(`window.policyServer.profiles[0].name==='later policy'`)
  assert.equal(await evaluate('window.policyMaxInFlight'), 1, '在途旧请求与新页面保存保持串行')
  await click('[data-page="tools"]')
  await evaluate(`window.policyServer.profiles[0].name='external policy';window.delay=0`)
  await click('[data-page="policy"]')
  await waitFor(`${field('profile name')}.value==='external policy'`)
  await input('policy.expansion.maxAria', '7'); await blur('policy.expansion.maxAria')
  await waitFor('window.policyServer.modelExpansion.maxAdditionalTools===7')
  await click('[data-page="tools"]')
  await evaluate('window.policyServer.modelExpansion.maxAdditionalTools=9')
  await click('[data-page="policy"]')
  await waitFor(`${field('policy.expansion.maxAria')}.value==='9'`)
  await blur('policy.expansion.maxAria')
  assert.equal(await evaluate('window.policyServer.modelExpansion.maxAdditionalTools'), 9, '干净数字草稿不覆盖外部新值')
  const beforeReadOnly = await evaluate(count('subagent-tool-policy'))
  await click('[data-readonly]')
  assert.equal(await evaluate(`${field('policy.toggleLabel')}.disabled`), true)
  assert.equal(await evaluate(`${field('profile name')}.closest('fieldset').disabled`), true)
  await evaluate(`${field('policy.toggleLabel')}.click()`)
  assert.equal(await evaluate(count('subagent-tool-policy')), beforeReadOnly, '只读开关零写入')
})
