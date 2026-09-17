import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { getEngineMeta } from '../../engine/schema.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(new URL('../../package.json', import.meta.url))
const browserPath = process.env.PROMPT_TOOL_TEST_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'

test('V2 页面：导航、浏览恢复、配置筛选与保存反馈', { skip: !existsSync(browserPath), timeout: 90000 }, async () => {
  const { rolldown } = await import(pathToFileURL(createRequire(require.resolve('tsdown')).resolve('rolldown')))
  const ts = require('typescript')
  const bundle = await rolldown({ input: join(root, 'test/fixtures/ui-v2-pages.mjs'), platform: 'browser',
    transform: { define: { 'process.env.NODE_ENV': JSON.stringify('production'), 'process.env': '{}', 'import.meta.env': '{}' } },
    plugins: [{ name: 'ui-pages-fixture',
      resolveId(source, importer) {
        if (['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'].includes(source)) return require.resolve(source)
        if (source.endsWith('.css')) return '\0test-css:' + resolve(dirname(importer), source) + '.mjs'
      },
      load(id) {
        if (id.startsWith('\0test-css:')) {
          const file = id.slice('\0test-css:'.length, -4)
          const names = existsSync(file) ? [...new Set([...readFileSync(file, 'utf8').matchAll(/\.([A-Za-z_][\w-]*)/g)].map((match) => match[1]))] : []
          return `export default ${JSON.stringify(Object.fromEntries(names.map((name) => [name, name])))}`
        }
      },
      transform(code, id) { if (id.endsWith('.tsx')) return ts.transpileModule(code, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2024 } }).outputText },
    }],
  })
  let output
  try { ({ output } = await bundle.generate({ format: 'iife' })) } finally { await bundle.close() }
  const js = output.find((item) => item.type === 'chunk').code
  // 此 fixture 只锁定交互与滚动；像素、主题、实际 CSS 由独立浏览器视觉验收覆盖。
  const fixtureCss = '.shell{height:650px;display:flex;flex-direction:column}.canvas{overflow:auto;flex:1;scroll-padding-top:var(--pt-sticky-height,0px)}.nav{display:flex;max-width:400px;overflow:auto}.nav button{min-width:110px}.configCard,.presetCard{min-height:90px;scroll-margin-top:8px}.pageActions{position:sticky;top:0;background:white;z-index:5}.listFilterRow{display:flex;flex-wrap:wrap}.configForm{padding:16px}[hidden]{display:none!important}'
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/app.js' ? 'text/javascript' : 'text/html')
    res.end(req.url === '/app.js' ? js : `<!doctype html><meta charset="utf-8"><style>${fixtureCss}</style><div id="root"></div><script>window.fixture=${JSON.stringify({ meta: getEngineMeta() })}</script><script src="/app.js"></script>`)
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const profile = mkdtempSync(join(tmpdir(), 'pt-pages-browser-'))
  const browser = spawn(browserPath, ['--headless=new', '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' })
  const exited = once(browser, 'exit')
  let ws
  try {
    const portFile = join(profile, 'DevToolsActivePort')
    let port
    for (let i = 0; i < 150 && !port; i++) {
      try { const candidate = readFileSync(portFile, 'utf8').split('\n')[0]; if (/^\d+$/.test(candidate)) port = candidate } catch {}
      if (!port) await sleep(100)
    }
    assert.ok(port, '隔离浏览器调试端口就绪')
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    ws = new WebSocket(pages.find((page) => page.type === 'page').webSocketDebuggerUrl)
    await new Promise((done) => ws.addEventListener('open', done, { once: true }))
    let id = 0
    const pending = new Map()
    ws.addEventListener('message', ({ data }) => { const msg = JSON.parse(data); if (!msg.id) return; const request = pending.get(msg.id); pending.delete(msg.id); if (msg.error) request.reject(msg.error); else request.resolve(msg.result) })
    const send = (method, params = {}) => new Promise((resolve, reject) => { pending.set(++id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })) })
    const evaluate = async (expression) => { const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails)); return result.result.value }
    const waitFor = async (expression) => { for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await sleep(50) } assert.fail(`等待超时：${expression}\n${await evaluate('document.body.innerText')}`) }
    const click = async (selector) => { await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); await sleep(80) }
    const clickText = async (value) => { await evaluate(`[...document.querySelectorAll('button')].find(e=>e.getClientRects().length&&e.textContent.trim()===${JSON.stringify(value)}).click()`); await sleep(80) }
    const input = async (selector, value) => { await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()`); await sleep(60) }
    await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` })
    await waitFor(`document.querySelectorAll('[data-config-id]').length===36`)
    assert.equal(await evaluate('window.previewRequests'), 0, '未打开工具页不预取')
    await input('[aria-label="过滤提示词配置"]', 'config-1')
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
    await input('[aria-label="过滤提示词配置"]', 'missing')
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
  } finally {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: 0, method: 'Browser.close' }))
    await Promise.race([exited, sleep(2000)])
    if (browser.exitCode === null) browser.kill()
    await exited
    ws?.close()
    server.close()
    for (let i = 0; i < 12; i++) { try { rmSync(profile, { recursive: true, force: true }); break } catch { await sleep(100) } }
  }
})
