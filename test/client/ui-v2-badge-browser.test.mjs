import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'

const root = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(join(root, 'package.json'))
const browserPath = process.env.PROMPT_TOOL_TEST_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'

test('V2 真实CSS：长名称胶囊、透明主题表面与真实鼠标过滤选择', { skip: !existsSync(browserPath), timeout: 30000 }, async () => {
  const { rolldown } = await import(pathToFileURL(createRequire(require.resolve('tsdown')).resolve('rolldown')))
  const { transform } = require('lightningcss'), ts = require('typescript')
  const css = []
  const entry = `import React from 'react';import {createRoot} from 'react-dom/client';
import {StatusBadge} from ${JSON.stringify(join(root, 'src/client/ui/StatusBadge.tsx').replaceAll('\\', '/'))};
import {MenuSelect} from ${JSON.stringify(join(root, 'src/client/ui/MenuSelect.tsx').replaceAll('\\', '/'))};
import ui from ${JSON.stringify(join(root, 'src/client/ui/controls.module.css').replaceAll('\\', '/'))};
const names=['Anchored Standard(prompt-tool)','夏瑾 天琴座 Beta 2.42（SillyTavern 转换）'];
const cards=names.map((name,index)=>
React.createElement('article',{key:name,style:{width:'240px'},'data-card':index},React.createElement('div',{className:ui.presetCardHead},
React.createElement('strong',{className:ui.presetCardName},name),React.createElement(StatusBadge,{className:ui.presetHeadBadge,tone:'success',label:'使用中'}))));
function Filter(){const [value,setValue]=React.useState('all');return React.createElement(MenuSelect,{value,ariaLabel:'按层级或策略过滤',options:[{value:'all',label:'全部'},{value:'world-book',label:'世界书',group:'内容策略'},{value:'pre-step',label:'前置步骤',group:'插入点'},{value:'system-section',label:'系统提示段',group:'插入点'}],onChange:next=>{window.filterValue=next;setValue(next)}})}
createRoot(document.getElementById('root')).render(React.createElement(React.Fragment,null,...cards,
React.createElement('section',{className:ui.pageActions,'data-sticky':true},'模块列表 / 保存配置',React.createElement(Filter))));`
  const bundle = await rolldown({ input: 'badge-fixture', platform: 'browser', transform: { define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}', 'import.meta.env': '{}' } },
    plugins: [{ name: 'real-badge-css',
      resolveId(source, importer) {
        if (source === 'badge-fixture') return '\0badge-fixture.mjs'
        if (['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'].includes(source)) return require.resolve(source)
        if (source.endsWith('.css')) return '\0badge-css:' + (isAbsolute(source) ? source : source.startsWith('.') ? resolve(dirname(importer), source) : createRequire(importer).resolve(source)) + '.mjs'
      },
      load(id) {
        if (id === '\0badge-fixture.mjs') return entry
        if (id.startsWith('\0badge-css:')) {
          const path = id.slice('\0badge-css:'.length, -4)
          const result = transform({ filename: path, code: readFileSync(path), cssModules: path.endsWith('.module.css') ? { pattern: '[hash]_[local]' } : false })
          css.push(result.code.toString())
          return `export default ${JSON.stringify(Object.fromEntries(Object.entries(result.exports ?? {}).map(([key, value]) => [key, value.name])))}`
        }
      },
      transform(code, id) { if (id.endsWith('.tsx')) return ts.transpileModule(code, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2024 } }).outputText },
    }],
  })
  let output
  try { ({ output } = await bundle.generate({ format: 'iife' })) } finally { await bundle.close() }
  const js = output.find((item) => item.type === 'chunk').code
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/app.js' ? 'text/javascript' : 'text/html')
    res.end(req.url === '/app.js' ? js : `<!doctype html><meta charset="utf-8"><style>${css.join('\n')}body{font:12px/18px sans-serif;margin:8px}article{margin-bottom:16px}strong{font:600 13px/20px sans-serif!important}</style><div id="root"></div><script src="/app.js"></script>`)
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const profile = mkdtempSync(join(tmpdir(), 'pt-badge-browser-'))
  const browser = spawn(browserPath, ['--headless=new', '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' })
  const exited = once(browser, 'exit')
  let ws
  try {
    let port
    for (let i = 0; i < 150 && !port; i++) {
      try { const value = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; if (/^\d+$/.test(value)) port = value } catch {}
      if (!port) await delay(50)
    }
    assert.ok(port, '隔离浏览器调试端口就绪')
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    ws = new WebSocket(pages.find((page) => page.type === 'page').webSocketDebuggerUrl)
    await once(ws, 'open')
    let id = 0
    const pending = new Map()
    ws.addEventListener('message', ({ data }) => { const msg = JSON.parse(data); if (!msg.id) return; const item = pending.get(msg.id); pending.delete(msg.id); if (msg.error) item.reject(msg.error); else item.resolve(msg.result) })
    const send = (method, params = {}) => new Promise((resolve, reject) => { pending.set(++id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })) })
    const evaluate = async (expression) => { const result = await send('Runtime.evaluate', { expression, returnByValue: true }); assert.equal(result.exceptionDetails, undefined); return result.result.value }
    await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` })
    for (let i = 0; i < 100 && !await evaluate('document.querySelectorAll("[data-card]").length===2'); i++) await delay(30)
    for (const width of [240, 160]) for (const scale of [1, 2]) {
      const rows = await evaluate(`(()=>{document.querySelectorAll('[data-card]').forEach(e=>e.style.width=${width}+'px');return [...document.querySelectorAll('[data-card]')].map(card=>{const tag=card.querySelector('[data-tone=success]:last-child');tag.style.fontSize=${scale * 12}+'px';tag.style.lineHeight=${scale * 18}+'px';const title=card.querySelector('strong');title.style.setProperty('font-size',${scale * 13}+'px','important');title.style.setProperty('line-height',${scale * 20}+'px','important');const range=document.createRange();range.selectNodeContents(tag);return {lines:range.getClientRects().length,textWidth:range.getBoundingClientRect().width,width:tag.getBoundingClientRect().width,cardWidth:card.clientWidth,overflow:card.scrollWidth>card.clientWidth+1}})})()`)
      assert.equal(rows.length, 2)
      for (const row of rows) { assert.equal(row.lines, 1, JSON.stringify({ width, scale, row })); assert.equal(row.overflow, false); assert.ok(row.textWidth <= row.width) }
    }
    for (const scheme of ['light', 'dark']) for (const surface of ['transparent', 'rgb(80 100 140 / .12)', 'initial']) {
      const color = await evaluate(`(()=>{document.documentElement.style.colorScheme=${JSON.stringify(scheme)};const e=document.querySelector('[data-sticky]');e.style.setProperty('--dsw-alias-bg-base',${JSON.stringify(surface)});e.style.setProperty('--dsw-alias-bg-layer-2',${JSON.stringify(surface)});return getComputedStyle(e).backgroundColor})()`)
      assert.match(color, /^rgb\(/, `操作区基底必须不透明：${scheme}/${surface} → ${color}`)
    }
    const pointerClick = async (selector) => {
      await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();if(r.top<0||r.bottom>innerHeight)e.scrollIntoView({block:'center'})})()`)
      await delay(40)
      const point = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`)
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
      await delay(80)
    }
    await evaluate(`window.trace=[];for(const name of ['pointerdown','mousedown','focusin','focusout','mouseup','click'])document.addEventListener(name,e=>window.trace.push([name,e.target.textContent?.slice(0,35),!!document.querySelector('[role=menu]')]),true)`)
    await pointerClick('[aria-label="按层级或策略过滤"]')
    assert.equal(await evaluate('!!document.querySelector("[role=menu]")'), true, '真实鼠标打开过滤菜单')
    await evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find(e=>e.textContent.trim()==='系统提示段').dataset.targetFilter='true'`)
    await pointerClick('[data-target-filter="true"]')
    assert.equal(await evaluate('window.filterValue'), 'system-section', JSON.stringify(await evaluate('window.trace')))
  } finally {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: 0, method: 'Browser.close' }))
    await Promise.race([exited, delay(2000)])
    if (browser.exitCode === null) browser.kill()
    await exited
    ws?.close(); server.close()
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
