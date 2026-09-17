import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { getEngineMeta } from '../../engine/schema.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(new URL('../../package.json', import.meta.url))
const browserPath = process.env.PROMPT_TOOL_TEST_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'

test('V2 卡片：展开语义、菜单焦点、删除/丢弃确认、portal保存与原始草稿', { skip: !existsSync(browserPath) && '设置 PROMPT_TOOL_TEST_BROWSER', timeout: 60000 }, async () => {
  const { rolldown } = await import(pathToFileURL(createRequire(require.resolve('tsdown')).resolve('rolldown')))
  const ts = require('typescript')
  const bundle = await rolldown({ input: join(root, 'test/fixtures/ui-v2-cards.mjs'), platform: 'browser',
    transform: { define: { 'process.env.NODE_ENV': JSON.stringify('production'), 'process.env': '{}', 'import.meta.env': '{}' } },
    plugins: [{ name: 'isolated-cards', resolveId(source) {
      if (['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'].includes(source)) return require.resolve(source)
      if (source.endsWith('.css')) return '\0test-css:' + source + '.mjs'
    }, load(id) { if (id.startsWith('\0test-css:')) return 'export default new Proxy({}, {get:(_,key)=>key})' },
    transform(code, id) { if (id.endsWith('.tsx')) return ts.transpileModule(code, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2024 } }).outputText } }],
  })
  let output
  try { ({ output } = await bundle.generate({ format: 'iife' })) } finally { await bundle.close() }
  const js = output.find((item) => item.type === 'chunk').code
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/app.js' ? 'text/javascript' : 'text/html')
    res.end(req.url === '/app.js' ? js : `<!doctype html><meta charset="utf-8"><div id="root"></div><script>window.fixture=${JSON.stringify({ meta: getEngineMeta() })}</script><script src="/app.js"></script>`)
  }).listen(0, '127.0.0.1')
  await new Promise((done) => server.on('listening', done))
  const profile = mkdtempSync(join(tmpdir(), 'pt-v2-cards-'))
  const browser = spawn(browserPath, ['--headless=new', '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' })
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
    ws.addEventListener('message', ({ data }) => {
      const msg = JSON.parse(data)
      if (!msg.id) return
      const request = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) request.reject(msg.error)
      else request.resolve(msg.result)
    })
    const send = (method, params = {}) => new Promise((resolve, reject) => { pending.set(++id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })) })
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails))
      return result.result.value
    }
    const waitFor = async (expression) => {
      for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await sleep(25) }
      assert.fail(`等待超时：${expression}\n焦点：${await evaluate('document.activeElement.outerHTML')}\n${await evaluate('document.body.innerText')}`)
    }
    const click = async (selector) => { await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); await sleep(30) }
    const key = async (value) => {
      const windowsVirtualKeyCode = { Enter: 13, ' ': 32, Tab: 9, Escape: 27, End: 35, Home: 36, ArrowDown: 40, ArrowUp: 38 }[value]
      const code = value === ' ' ? 'Space' : value
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: value, code, windowsVirtualKeyCode })
      if (value === 'Enter' || value === ' ') await send('Input.dispatchKeyEvent', { type: 'char', text: value === 'Enter' ? '\r' : ' ', key: value, code, windowsVirtualKeyCode })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: value, code, windowsVirtualKeyCode })
      await sleep(30)
    }
    const input = async (selector, value) => { await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.focus();Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}))})()`); await sleep(30) }
    const chooseMenu = async (label) => { await evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find(el=>el.textContent===${JSON.stringify(label)}).click()`); await sleep(30) }
    await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` })
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
    assert.equal(await evaluate(`document.querySelector('[data-config-id="ordinary"] textarea').readOnly`), true)
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
  } finally {
    ws?.close()
    browser.kill()
    server.close()
    await sleep(500)
    assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep))
    rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })
  }
})
