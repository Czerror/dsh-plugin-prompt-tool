import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'

const root = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(new URL('../../package.json', import.meta.url))
const browserPath = process.env.PROMPT_TOOL_TEST_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'

test('浏览器：整包导入、在途取消与子代理筛选/创建', { skip: !existsSync(browserPath) && '设置 PROMPT_TOOL_TEST_BROWSER 运行浏览器回归', timeout: 60000 }, async t => {
  const { rolldown } = await import(pathToFileURL(createRequire(require.resolve('tsdown')).resolve('rolldown')))
  const ts = require('typescript')
  const bundle = await rolldown({ input: join(root, 'test/fixtures/import-scope.mjs'), platform: 'browser',
    transform: { define: { 'process.env.NODE_ENV': JSON.stringify('production'), 'process.env': '{}', 'import.meta.env': '{}' } },
    plugins: [{ name: 'isolated-import-scope', resolveId(source) {
      if (['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'].includes(source)) return require.resolve(source)
      if (source.endsWith('.css')) return '\0test-css:' + source + '.mjs'
    }, load(id) { if (id.startsWith('\0test-css:')) return 'export default new Proxy({}, {get:(_,key)=>key})' },
    transform(code, id) { if (id.endsWith('.tsx')) return ts.transpileModule(code, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2024 } }).outputText } }],
  })
  let output
  try { ({ output } = await bundle.generate({ format: 'iife' })) } finally { await bundle.close() }
  const js = output.find(item => item.type === 'chunk').code
  const server = createServer((req, res) => { res.setHeader('Content-Type', req.url === '/app.js' ? 'text/javascript' : 'text/html'); res.end(req.url === '/app.js' ? js : '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/app.js"></script>') }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const profile = mkdtempSync(join(tmpdir(), 'pt-import-scope-'))
  const browser = spawn(browserPath, ['--headless=new', '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' })
  const exited = once(browser, 'exit')
  let ws
  try {
    const portFile = join(profile, 'DevToolsActivePort')
    for (let i = 0; !existsSync(portFile) && i < 150; i++) await sleep(100)
    const port = readFileSync(portFile, 'utf8').split('\n')[0]
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    ws = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl)
    await new Promise(done => ws.addEventListener('open', done, { once: true }))
    let id = 0
    const pending = new Map()
    ws.addEventListener('message', ({ data }) => {
      const msg = JSON.parse(data)
      const request = pending.get(msg.id)
      if (request === undefined) return
      pending.delete(msg.id)
      if (msg.error) request.reject(msg.error)
      else request.resolve(msg.result)
    })
    const send = (method, params = {}) => new Promise((resolve, reject) => { pending.set(++id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })) })
    const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails)); return result.result.value }
    const waitFor = async expression => { for (let i = 0; i < 80; i++) { if (await evaluate(expression)) return; await sleep(40) } assert.fail(`${expression}: ${await evaluate('document.body.innerText')} / ${await evaluate('JSON.stringify(window.errors)')}`) }
    const click = async text => { assert.equal(await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.getClientRects().length&&e.textContent.trim()===${JSON.stringify(text)});if(!b)return false;b.click();return true})()`), true, text); await sleep(60) }
    const mount = async mode => { await evaluate(`window.mount(${JSON.stringify(mode)}); true`); await sleep(100) }
    const upload = async (selector, paths) => {
      await evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});const list=new DataTransfer();for(const path of ${JSON.stringify(paths)}){const file=new File(['{}'],path.split('/').at(-1),{type:'application/json'});Object.defineProperty(file,'webkitRelativePath',{value:path});list.items.add(file)}input.files=list.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
    }
    const previewOpen = `document.body.innerText.includes('导入预览（先确认再写入）')`
    const chooseView = async label => { await evaluate(`document.querySelector('[aria-label="按层级或策略过滤"]').click(); true`); await sleep(60); await click(label) }
    await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` })
    await waitFor('window.mount !== undefined')

    await t.test('F01：目录附件和多个 JSON 始终作为整包预览及提交', async () => {
      for (const files of [['pack/preset.yml', 'pack/prompt.md'], ['pack/character.json', 'pack/preset.json']]) {
        await mount('presets')
        await upload('input[webkitdirectory]', files)
        await waitFor(previewOpen)
        assert.deepEqual(await evaluate('window.requests.find(r=>r.body.preview).body.files.map(f=>f.path)'), files)
        await click('确认导入')
        await waitFor('window.requests.some(r=>r.endpoint==="import-preset-package"&&!r.body.preview)')
        assert.deepEqual(await evaluate('window.requests.find(r=>r.endpoint==="import-preset-package"&&!r.body.preview).body.files.map(f=>f.path)'), files)
        assert.equal(await evaluate('window.requests.filter(r=>r.endpoint==="import-preset-package").length'), 2)
      }
    })
    await t.test('F08：换组在途取消立即结束等待，迟到响应不恢复预览', async () => {
      await mount('presets')
      await upload('input[accept=".yml,.yaml,.json"]', ['preset.json'])
      await waitFor(previewOpen)
      await evaluate('window.previewPlan=[{hold:true}]; true')
      await evaluate(`document.querySelector('[aria-label="选择顺序组"]').click(); true`)
      await sleep(60)
      await click('角色 2（2 条）')
      await waitFor('window.releasePreview !== undefined')
      await click('取消预览')
      assert.equal(await evaluate(previewOpen), false, '取消立即清空卡片，不等待网络')
      assert.equal(await evaluate(`document.querySelector('input[accept=".yml,.yaml,.json"]').disabled`), false)
      await evaluate('window.releasePreview(); true')
      await sleep(100)
      assert.equal(await evaluate(previewOpen), false, '迟到响应不能恢复 ready')
      assert.equal(await evaluate('window.requests.filter(r=>r.endpoint==="import-preset-package"&&!r.body.preview).length'), 0)
      await upload('input[accept=".yml,.yaml,.json"]', ['next.json'])
      await waitFor(previewOpen)
      await click('取消预览')
    })
    await t.test('角色卡批次继续逐张确认，取消只跳过当前卡', async () => {
      await mount('characters')
      await upload('input[accept=".json"]', ['first.json', 'second.json'])
      await waitFor(previewOpen)
      assert.equal(await evaluate('window.requests.find(r=>r.body.preview).body.files.length'), 1)
      await click('取消预览')
      await waitFor('window.requests.filter(r=>r.body.preview).length === 2')
      await click('确认导入')
      await waitFor('window.requests.some(r=>r.endpoint==="characters-import"&&!r.body.preview)')
      assert.deepEqual(await evaluate('window.requests.find(r=>r.endpoint==="characters-import"&&!r.body.preview).body.files.map(f=>f.path)'), ['second.json'])
    })
    await t.test('角色卡重预览在途取消可直接处理下一张，卸载丢弃迟到响应', async () => {
      await mount('characters')
      await upload('input[accept=".json"]', ['first.json', 'second.json'])
      await waitFor(previewOpen)
      await evaluate('window.releasePreview=undefined; window.previewPlan=[{hold:true}]; true')
      await evaluate(`document.querySelector('[aria-label="选择顺序组"]').click(); true`)
      await sleep(60)
      await click('角色 2（2 条）')
      await waitFor('window.releasePreview !== undefined')
      await click('取消预览')
      await waitFor(`window.requests.filter(r=>r.body.preview).at(-1)?.body.files[0].path === 'second.json'`)
      await click('确认导入')
      await waitFor(`!(${previewOpen})`)
      await evaluate('window.releasePreview(); true')
      await sleep(80)
      assert.deepEqual(await evaluate('window.requests.filter(r=>r.endpoint==="characters-import"&&!r.body.preview).map(r=>r.body.files[0].path)'), ['second.json'])
      assert.equal(await evaluate(previewOpen), false)
      await evaluate('window.releasePreview=undefined; window.previewPlan=[{hold:true}]; true')
      await upload('input[accept=".json"]', ['unmount.json'])
      await waitFor('window.releasePreview !== undefined')
      await evaluate('window.unmount(); window.releasePreview(); true')
      await sleep(80)
      assert.equal(await evaluate(previewOpen), false)
      assert.equal(await evaluate('window.requests.filter(r=>r.endpoint==="characters-import"&&!r.body.preview).length'), 1)
    })
    await t.test('F05：子代理筛选值和提示词列表同步', async () => {
      await mount('subagent')
      await chooseView('层级：系统提示段')
      assert.equal(await evaluate(`document.querySelector('[aria-label="按层级或策略过滤"]').textContent.trim()`), '层级：系统提示段')
      assert.equal(await evaluate(`document.querySelector('[data-config-id="pre-config"]') === null`), true)
      assert.equal(await evaluate(`document.querySelector('[data-config-id="system-config"]') !== null`), true)
    })
    await t.test('F06：工具链保留本层能力并隐藏其他层', async () => {
      await mount('subagent')
      await chooseView('层级：工具链')
      assert.equal(await evaluate(`document.querySelector('[data-module-card-id="subagent-tool-policy"]') !== null`), true)
      assert.equal(await evaluate(`document.querySelector('[data-module-card-id="anchor-turn"]') === null`), true)
    })
    await t.test('F07：模板创建展开并定位，保留筛选和搜索', async () => {
      await mount('subagent')
      await chooseView('层级：前置步骤')
      await evaluate(`document.querySelector('input[aria-label="过滤提示词配置"]').focus(); true`)
      await send('Input.insertText', { text: 'created' })
      await click('添加能力 / 工具模块')
      await click('添加模板 · 前置步骤')
      await waitFor(`document.querySelector('[role="dialog"]')?.textContent.includes('created.yml')`)
      await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(b=>b.textContent.includes('created.yml')).click(); true`)
      await waitFor(`document.querySelector('[data-config-id="created-new"]') !== null`)
      assert.equal(await evaluate(`document.querySelector('[data-config-id="created-new"] [aria-expanded]').getAttribute('aria-expanded')`), 'true')
      await waitFor(`window.scrolls.includes('created-new')`)
      assert.equal(await evaluate(`document.querySelector('[aria-label="按层级或策略过滤"]').textContent.trim()`), '层级：前置步骤')
      assert.equal(await evaluate(`document.querySelector('input[aria-label="过滤提示词配置"]').value`), 'created')
    })
    await t.test('只读预设保持能力创建、删除与空白工具的编辑边界', async () => {
      await evaluate(`window.mount('subagent', false); true`)
      await sleep(100)
      assert.equal(await evaluate(`document.querySelector('[aria-label="删除引擎能力 subagent-tool-policy"]') === null`), true)
      await click('添加能力 / 工具模块')
      assert.equal(await evaluate(`document.body.innerText.includes('添加模块 · context-gate')`), false)
      assert.equal(await evaluate(`document.body.innerText.includes('新建空白工具')`), false)
    })
    assert.deepEqual(await evaluate('window.errors'), [])
  } finally {
    const forceClose = setTimeout(() => browser.kill(), 5000)
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: 1_000_000, method: 'Browser.close' }))
    else browser.kill()
    await exited
    clearTimeout(forceClose)
    ws?.close()
    await new Promise(done => server.close(done))
    assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep))
    rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 })
  }
})
