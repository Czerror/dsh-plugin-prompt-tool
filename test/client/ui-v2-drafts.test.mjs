import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { getEngineMeta } from '../../engine/schema.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(new URL('../../package.json', import.meta.url))
const browserPath = process.env.PROMPT_TOOL_TEST_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'

test('V2 草稿与资源：原文恢复、快照保存、技能目标及危险删除', { skip: !existsSync(browserPath), timeout: 90000 }, async () => {
  const { rolldown } = await import(pathToFileURL(createRequire(require.resolve('tsdown')).resolve('rolldown')))
  const ts = require('typescript')
  const bundle = await rolldown({ input: join(root, 'test/fixtures/ui-v2-drafts.mjs'), platform: 'browser',
    transform: { define: { 'process.env.NODE_ENV': JSON.stringify('production'), 'process.env': '{}', 'import.meta.env': '{}' } },
    plugins: [{ name: 'ui-drafts-fixture',
      resolveId(source) {
        if (['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'].includes(source)) return require.resolve(source)
        if (source.endsWith('.css')) return '\0test-css:' + source + '.mjs'
      },
      load(id) { if (id.startsWith('\0test-css:')) return 'export default new Proxy({}, {get:(_,key)=>key})' },
      transform(code, id) { if (id.endsWith('.tsx')) return ts.transpileModule(code, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2024 } }).outputText },
    }],
  })
  let output
  try { ({ output } = await bundle.generate({ format: 'iife' })) } finally { await bundle.close() }
  const js = output.find((item) => item.type === 'chunk').code
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/app.js' ? 'text/javascript' : 'text/html')
    res.end(req.url === '/app.js' ? js : `<!doctype html><meta charset="utf-8"><div id="root"></div><script>window.fixture=${JSON.stringify({ meta: getEngineMeta() })}</script><script src="/app.js"></script>`)
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const profile = mkdtempSync(join(tmpdir(), 'pt-drafts-browser-'))
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
    const click = async (selector) => { await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.focus();e.click()})()`); await sleep(60) }
    const clickKey = async (key) => { assert.equal(await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>!e.disabled&&e.getClientRects().length&&e.textContent.trim()===window.t(${JSON.stringify(key)}));if(!b)return false;b.focus();b.click();return true})()`), true, key); await sleep(60) }
    const clickAria = async (expression) => { assert.equal(await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>!e.disabled&&e.getClientRects().length&&e.getAttribute('aria-label')===${expression});if(!b)return false;b.focus();b.click();return true})()`), true, expression); await sleep(60) }
    const field = (key) => `document.querySelector('[aria-label="'+window.t(${JSON.stringify(key)})+'"]')`
    const input = async (key, value) => { await evaluate(`(()=>{const e=${field(key)};e.focus();Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()`); await sleep(30) }
    const blur = async (key) => { await evaluate(`(()=>{const e=${field(key)};e.dispatchEvent(new FocusEvent('focusout',{bubbles:true,relatedTarget:document.querySelector('nav button')}));e.blur()})()`); await sleep(30) }
    const count = (endpoint) => `window.requests.filter(r=>r.endpoint===${JSON.stringify(endpoint)}).length`
    await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` })
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
    await clickKey('skills.selectAll')
    await input('skills.filter.aria', 'alpha')
    await input('skills.filter.aria', '')
    assert.equal(await evaluate(`document.querySelectorAll('label input[type="checkbox"]:checked').length`), 1, '隐藏选择被剔除')
    await clickKey('skills.selectAll')
    await evaluate(`window.failedSkill='beta'`)
    const beforeBatch = await evaluate(count('skill-toggle'))
    await clickKey('skills.batchEnable')
    await waitFor(`${count('skill-toggle')}===${beforeBatch + 2}`)
    await waitFor(`document.querySelectorAll('label input[type="checkbox"]:checked').length===1`)
    assert.equal(await evaluate(`document.querySelector('label input[type="checkbox"]:checked').parentElement.getAttribute('aria-label')`), '选择 beta', '只保留失败目标')
    await waitFor(`window.store.getFields().skillCatalog.find(s=>s.folder==='alpha').disabled===false`)
    assert.equal(await evaluate(`window.store.getFields().skillCatalog.find(s=>s.folder==='beta').disabled`), true, '真实 store 刷新后保留失败项的磁盘状态')
    assert.equal(await evaluate(`document.querySelector('[role="switch"][aria-label="'+window.t('skills.row.enable.aria',{name:'alpha'})+'"]').getAttribute('aria-checked')`), 'true', '成功批量后开关立即反映刷新事实')

    await click('[data-page="presets"]')
    await clickAria(`window.t('presetSwitcher.delete.aria',{name:'Other'})`)
    await waitFor(`document.querySelector('[role="alertdialog"]')!==null`)
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
  } finally {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: 0, method: 'Browser.close' }))
    await Promise.race([exited, sleep(2000)])
    if (browser.exitCode === null) browser.kill()
    await exited
    ws?.close(); server.close()
    for (let i = 0; i < 12; i++) { try { rmSync(profile, { recursive: true, force: true }); break } catch { await sleep(100) } }
  }
})
