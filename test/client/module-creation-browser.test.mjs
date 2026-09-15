import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync, readdirSync, mkdtempSync, existsSync, rmSync } from 'node:fs'
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

test('浏览器：六层空卡、跨层工具创建、筛选草稿与行为下拉', { skip: !existsSync(browserPath) && '设置 PROMPT_TOOL_TEST_BROWSER 以运行真实浏览器回归', timeout: 60000 }, async () => {
  const { rolldown } = await import(pathToFileURL(createRequire(require.resolve('tsdown')).resolve('rolldown')))
  const { parse } = require('yaml'), ts = require('typescript')
  const list = (path) => readdirSync(path).filter((file) => file.endsWith('.yml')).map((file) => ({ file, spec: parse(readFileSync(join(path, file), 'utf8')) }))
  const fixture = { meta: getEngineMeta(), templates: { templates: list(join(root, 'templates')), toolTemplates: list(join(root, 'templates/tools')) } }
  const bundle = await rolldown({ input: join(root, 'test/fixtures/module-workbench.mjs'), platform: 'browser',
    transform: { define: { 'process.env.NODE_ENV': JSON.stringify('production'), 'process.env': '{}', 'import.meta.env': '{}' } },
    plugins: [{
      name: 'isolated-ui-test',
      resolveId(source) {
        if (['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'].includes(source)) return require.resolve(source)
        if (source.endsWith('.css')) return '\0test-css:' + source + '.mjs'
      },
      // 此用例验证事件、effect 与状态，不以虚拟 CSS 宣称像素/布局验收。
      load(id) { if (id.startsWith('\0test-css:')) return 'export default new Proxy({}, {get:(_,key)=>key})' },
      transform(code, id) { if (id.endsWith('.tsx')) return ts.transpileModule(code, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2024 } }).outputText },
    }],
  })
  let output
  try { ({ output } = await bundle.generate({ format: 'iife' })) } finally { await bundle.close() }
  const js = output.find((item) => item.type === 'chunk').code
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/app.js' ? 'text/javascript' : 'text/html')
    res.end(req.url === '/app.js' ? js : `<!doctype html><meta charset="utf-8"><div id="root"></div><script>window.fixture=${JSON.stringify(fixture)}</script><script src="/app.js"></script>`)
  }).listen(0, '127.0.0.1')
  await new Promise((done) => server.on('listening', done))
  const profile = mkdtempSync(join(tmpdir(), 'pt-create-browser-'))
  const browser = spawn(browserPath, ['--headless=new', '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' })
  let ws
  try {
    const portFile = join(profile, 'DevToolsActivePort')
    for (let i = 0; !existsSync(portFile) && i < 150; i++) await sleep(100)
    const port = readFileSync(portFile, 'utf8').split('\n')[0]
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
      for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await sleep(50) }
      assert.fail(`等待超时：${expression}\n${await evaluate('document.body.innerText')}`)
    }
    const click = async (text) => {
      assert.equal(await evaluate(`(()=>{const button=[...document.querySelectorAll('button')].find(e=>e.getClientRects().length&&e.textContent.trim()===${JSON.stringify(text)});if(!button)return false;button.click();return true})()`), true, text)
      await sleep(50)
    }
    const chooseView = async (name) => {
      await evaluate(`document.querySelector('[aria-label="按层级或策略过滤"]').click()`)
      await sleep(50)
      await click(name)
    }
    await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` })
    await waitFor('window.store?.moduleFacts?.editable === true')
    // 指令文件复用标准配置卡（与 example-pre-step 同类）：在列表里出卡，不是新的置顶固定卡。
    await waitFor(`[...document.querySelectorAll('article')].some((card) => card.textContent.includes('AGENTS：'))`)
    const agentsCards = await evaluate(`[...document.querySelectorAll('article')].map((card) => card.textContent).filter((text) => text.includes('AGENTS：'))`)
    assert.equal(agentsCards.length, 2)
    assert.ok(agentsCards.every((text) => text.includes('前置步骤 · 动态填充 · 指令提示 · 位置：用户消息后')), '指令文件卡要带标准层级/策略/位置信息')
    assert.ok(agentsCards.every((text) => !text.includes('独立指令文件来源')), '来源开关不塞进新的指令文件卡')
    assert.equal(await evaluate(`document.body.innerText.includes('独立指令文件来源')`), true, '来源开关仍在列表工具栏行')
    await evaluate(`[...document.querySelectorAll('button[aria-expanded]')].find((b) => b.textContent.includes('AGENTS：AGENTS.md')).click()`)
    await waitFor(`document.querySelector('[aria-label="注入内容（空 = 不注入）"]')?.value==='项目指令正文'`)
    await chooseView('层级：前置步骤')
    await click('添加能力 / 工具模块')
    await click('新建空白工具')
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
    assert.equal(await evaluate(`document.querySelector('[aria-label="按层级或策略过滤"]').textContent.trim()`), '层级：工具链')
    assert.equal(await evaluate(`document.querySelector('[role="dialog"]')===null`), true, '工具模板选中后必须关闭浮层')

    // 真实模板 + 真实自动保存 effect；生成快照暂时为空也不能丢卡。
    await evaluate('window.staleGenerated=true')
    for (const [index, [file, layer]] of [['10-pre-step.yml', '前置步骤'], ['20-system-section.yml', '系统提示段'], ['30-runtime-context.yml', '运行上下文'], ['40-agent-request.yml', '代理请求'], ['50-llm-stream.yml', '模型流'], ['60-tool-pipeline.yml', '工具链']].entries()) {
      await click('添加能力 / 工具模块')
      await click(`添加模板 · ${layer}`)
      await waitFor(`document.body.innerText.includes(${JSON.stringify(file)})`)
      await evaluate(`document.querySelectorAll('button').forEach(e=>{if(e.textContent.includes(${JSON.stringify(file)}))e.click()})`)
      await waitFor(`window.store.savedConfigs.length===${index + 3}`)
      assert.equal(await evaluate(`document.querySelector('[aria-label="按层级或策略过滤"]').textContent.trim()`), `层级：${layer}`)
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
    await waitFor(`document.querySelector('[aria-label="编辑行为"]')?.textContent.trim()==='anchor-turn'`)
    assert.equal(await evaluate(`document.querySelectorAll('[aria-label="编辑行为"]').length`), 1)
    await evaluate(`document.querySelector('[aria-label="编辑行为"]').click()`)
    await sleep(50)
    await click('context-gate')
    assert.deepEqual(await evaluate('window.store.moduleFacts.effectiveModules'), ['context-gate', 'anchor-turn'])
  } finally {
    ws?.close()
    browser.kill()
    server.close()
    await sleep(500)
    assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep))
    rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })
  }
})
