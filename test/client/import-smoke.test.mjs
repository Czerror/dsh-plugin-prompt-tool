// 真实 Edge、原生 File 输入和 React feature；请求只到隔离内存宿主。
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync, mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve, sep } from 'node:path'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'

const root = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(new URL('../../package.json', import.meta.url))
const browserPath = process.env.PROMPT_TOOL_TEST_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const skipBrowser = !existsSync(browserPath) && '设置 PROMPT_TOOL_TEST_BROWSER 以运行真实浏览器回归'
let shared
async function ensureSession() {
  if (shared) return shared
  const { rolldown } = await import(pathToFileURL(createRequire(require.resolve('tsdown')).resolve('rolldown')))
  const ts = require('typescript')
  const { transform: cssTransform } = require('lightningcss')
  const styles = []
  const bundleOf = async (fixture) => {
    const bundle = await rolldown({ input: join(root, fixture), platform: 'browser',
      transform: { define: { 'process.env.NODE_ENV': JSON.stringify('production'), 'process.env': '{}', 'import.meta.env': '{}' } },
      plugins: [{ name: 'isolated-import-ui',
        resolveId(source, importer) {
          if (['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'].includes(source)) return require.resolve(source)
          if (source.endsWith('.css')) return '\0test-css:' + (source.startsWith('.') ? resolve(dirname(importer), source) : require.resolve(source)) + '.mjs'
        },
        load(id) {
          if (!id.startsWith('\0test-css:')) return
          const filename = id.slice('\0test-css:'.length, -4)
          const result = cssTransform({ filename, code: readFileSync(filename), cssModules: filename.endsWith('.module.css') })
          styles.push(result.code.toString())
          return 'export default ' + JSON.stringify(Object.fromEntries(Object.entries(result.exports ?? {}).map(([key, value]) => [key, value.name])))
        },
        transform(code, id) { if (id.endsWith('.tsx')) return ts.transpileModule(code, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2024 } }).outputText },
      }],
    })
    try { return (await bundle.generate({ format: 'iife' })).output.find((item) => item.type === 'chunk').code }
    finally { await bundle.close() }
  }
  const scripts = { '/preview.js': await bundleOf('test/client/import-ui.fixture.mjs'), '/scope.js': await bundleOf('test/fixtures/import-scope.mjs') }
  const server = createServer((req, res) => {
    if (scripts[req.url]) { res.setHeader('Content-Type', 'text/javascript'); return res.end(scripts[req.url]) }
    res.setHeader('Content-Type', 'text/html')
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--dsw-alias-bg-layer-2:#fff;--dsw-alias-label-primary:#222;--dsw-alias-label-secondary:#666;--dsw-alias-border-l1:#ddd;--dsw-alias-border-l2:#bbb;--dsw-alias-state-business-primary:#2463eb;--dsw-font-xs-13:13px sans-serif;--dsw-font-xxs-12:12px sans-serif;--dsw-font-xs-strong-13:600 13px sans-serif}body{margin:0}button,input,select{font:inherit}${styles.join('\n')}</style><div id="root"></div><script src="${req.url === '/scope' ? '/scope.js' : '/preview.js'}"></script>`)
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const profile = mkdtempSync(join(process.cwd(), 'pt-import-browser-'))
  const filesDir = mkdtempSync(join(process.cwd(), 'pt-import-files-'))
  const browser = spawn(browserPath, ['--headless=new', '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' })
  const exited = once(browser, 'exit')
  const portFile = join(profile, 'DevToolsActivePort')
  for (let i = 0; !existsSync(portFile) && i < 150; i++) await sleep(100)
  const port = readFileSync(portFile, 'utf8').split('\n')[0]
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const ws = new WebSocket(pages.find((page) => page.type === 'page').webSocketDebuggerUrl)
  await new Promise((done) => ws.addEventListener('open', done, { once: true }))
  let sequence = 0
  const pending = new Map()
  ws.addEventListener('message', ({ data }) => { const message = JSON.parse(data); const entry = pending.get(message.id); if (!entry) return; pending.delete(message.id); if (message.error) entry.reject(message.error); else entry.resolve(message.result) })
  const send = (method, params = {}) => new Promise((resolve, reject) => { pending.set(++sequence, { resolve, reject }); ws.send(JSON.stringify({ id: sequence, method, params })) })
  const evaluate = async (expression) => { const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); assert.equal(response.exceptionDetails, undefined, JSON.stringify(response.exceptionDetails)); return response.result.value }
  const waitFor = async (expression) => { for (let i = 0; i < 120; i++) { if (await evaluate(expression)) return; await sleep(50) } assert.fail(`${expression}\n${await evaluate('document.body.innerText')}\n${await evaluate('JSON.stringify(window.errors)')}`) }
  const click = async (label) => { assert.equal(await evaluate(`(()=>{const button=[...document.querySelectorAll('button')].find(e=>e.getClientRects().length&&e.textContent.trim()===${JSON.stringify(label)});if(!button)return false;button.focus();button.click();return true})()`), true, label); await sleep(35) }
  shared = { server, profile, filesDir, browser, exited, ws, send, evaluate, waitFor, click, origin: `http://127.0.0.1:${server.address().port}` }
  return shared
}

test('浏览器：导入导出完整生命周期、字节、覆盖、队列与无障碍', { skip: skipBrowser, timeout: 120000 }, async (suite) => {
  const { send, evaluate, waitFor, click, origin, filesDir } = await ensureSession()
  await send('Page.navigate', { url: `${origin}/preview` })
  await waitFor('window.mount !== undefined')
  const mount = async (mode = 'presets') => { await evaluate(`window.mount(${JSON.stringify(mode)}); true`); await sleep(70); await click(mode === 'characters' ? '导入角色卡…' : '导入预设…') }
  let serial = 0
  const files = async (names = ['preset.json'], bytes = '{}') => {
    const paths = names.map((name) => { const path = join(filesDir, `${++serial}-${name}`); writeFileSync(path, bytes); return path })
    const doc = await send('DOM.getDocument', { depth: -1 })
    const input = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]:not([webkitdirectory])' })
    assert.ok(input.nodeId > 0)
    await send('DOM.setFileInputFiles', { files: paths, nodeId: input.nodeId })
  }
  const ready = () => waitFor(`document.querySelector('input[aria-invalid]') !== null && [...document.querySelectorAll('button')].some(b=>['创建预设','保存为新角色'].includes(b.textContent.trim())&&!b.disabled)`)
  const commits = `window.requests.filter(r=>['characters-import','import-preset-package'].includes(r.endpoint)&&!r.body.preview)`
  const chooseGroup = async (label) => { await evaluate(`document.querySelector('[aria-label="选择顺序组"]').click(); true`); await sleep(40); await click(label) }

  await suite.test('PNG 原字节先暂存，确认互斥，完成后显式切换', async () => {
    await mount()
    await files(['avatar.png'], Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 255]))
    await ready()
    assert.deepEqual(await evaluate('window.requests.find(r=>r.endpoint==="asset-upload").bytes'), [137, 80, 78, 71, 13, 10, 26, 10, 255])
    assert.equal(await evaluate(`${commits}.length`), 0)
    if (process.env.PT_IMPORT_SCREENSHOT) {
      await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 960, deviceScaleFactor: 1, mobile: false })
      const screenshot = await send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(process.env.PT_IMPORT_SCREENSHOT, Buffer.from(screenshot.data, 'base64'))
      await send('Emulation.clearDeviceMetricsOverride')
    }
    await evaluate(`window.holdSubmit=true; (()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent==='创建预设');b.click();b.click()})(); true`)
    await waitFor('window.releaseSubmit !== undefined')
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
    assert.equal(await evaluate(`${commits}.length`), 1)
    assert.equal(await evaluate('document.querySelector("[role=dialog]") !== null'), true)
    await evaluate('window.releaseSubmit(); true')
    await waitFor('document.body.innerText.includes("已导入 1 项")')
    assert.equal(await evaluate('window.switched'), '')
    assert.equal(await evaluate(`${commits}[0].body.expectedSourceDigest`), 'digest')
    assert.ok(await evaluate(`${commits}[0].body.expectedPreviewRevision`))
    await click('切换到该预设')
    assert.equal(await evaluate('window.switched'), 'imported')
  })
  await suite.test('读取／上传失败有就地反馈；双选择不会覆盖在途来源', async () => {
    await mount(); await evaluate('window.uploadError="cannot read file"; true'); await files();
    await waitFor('document.body.innerText.includes("cannot read file")')
    assert.equal(await evaluate(`${commits}.length`), 0)
    assert.equal(await evaluate('document.activeElement.getAttribute("role")'), 'alert')
    await evaluate('window.uploadError=""; true'); await click('重新预览'); await ready(); await click('取消')
    await mount(); await evaluate('window.holdUpload=true; true'); await files(); await waitFor('window.releaseUpload !== undefined')
    await click('取消'); await evaluate('window.releaseUpload(); true'); await sleep(80)
    assert.equal(await evaluate('document.querySelector("[role=dialog]")'), null)
    assert.equal(await evaluate('window.requests.filter(r=>r.body?.preview).length'), 0)
    assert.equal(await evaluate('window.requests.filter(r=>r.endpoint==="asset-release").length'), 1)
  })
  await suite.test('文件夹保留字节；FileReader 读取失败不提交', async () => {
    await mount()
    const selectFolder = `(()=>{const input=document.querySelector('input[webkitdirectory]');const data=new DataTransfer();for(const [path,bytes] of [['pack/preset.yml',[105,100,58,32,97]],['pack/avatar.png',[137,80,78,71,255]]]){const file=new File([new Uint8Array(bytes)],path.split('/').at(-1));Object.defineProperty(file,'webkitRelativePath',{value:path});data.items.add(file)}input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true})()`
    await evaluate(selectFolder); await ready()
    assert.deepEqual(await evaluate('window.requests.find(r=>r.body?.preview).body.files.map(f=>({path:f.path,encoding:f.encoding,bytes:[...atob(f.content)].map(c=>c.charCodeAt(0))}))'), [{ path: 'pack/preset.yml', encoding: 'base64', bytes: [105,100,58,32,97] }, { path: 'pack/avatar.png', encoding: 'base64', bytes: [137,80,78,71,255] }])
    await click('取消'); await mount()
    await evaluate('window.readData=FileReader.prototype.readAsDataURL; FileReader.prototype.readAsDataURL=function(){this.onerror()}; true')
    await evaluate(selectFolder); await waitFor('document.querySelector("[role=alert]") !== null')
    await evaluate('FileReader.prototype.readAsDataURL=window.readData; true')
    assert.equal(await evaluate(`${commits}.length`), 0)
  })
  await suite.test('同一事件周期的双选择只上传一次', async () => {
    await mount()
    await evaluate(`(()=>{const input=document.querySelector('input[type=file]:not([webkitdirectory])');const pick=name=>{const data=new DataTransfer();data.items.add(new File(['{}'],name));input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}))};pick('first.json');pick('second.json');return true})()`)
    await ready()
    assert.deepEqual(await evaluate('window.requests.filter(r=>r.endpoint==="asset-upload").map(r=>r.name)'), ['first.json'])
  })
  await suite.test('过期和提交失败均保留来源，重新预览后才可再次提交', async () => {
    for (const code of ['preset-preview-stale', 'install-failed']) {
      await mount(); await files(); await ready()
      await evaluate(`window.submitPlan=[{ok:false,code:${JSON.stringify(code)},message:'changed target'}]; true`)
      await click('创建预设'); await waitFor('document.body.innerText.includes("changed target")')
      assert.equal(await evaluate('[...document.querySelectorAll("button")].some(b=>b.textContent==="创建预设")'), false)
      await click('重新预览'); await ready(); await click('创建预设'); await waitFor('document.body.innerText.includes("已导入 1 项")')
      assert.equal(await evaluate('window.requests.filter(r=>r.endpoint==="asset-upload").length'), 1)
      assert.equal(await evaluate(`${commits}.length`), 2)
    }
  })
  await suite.test('候选、选组乱序响应及来源类型选择始终使旧确认失效', async () => {
    await mount(); await evaluate(`window.previewPlan=[{value:{state:'needs-order-selection',summary:undefined,candidates:[{characterId:'1',entries:1},{characterId:'2',entries:2}]}}]; true`)
    await files(); await waitFor('document.body.innerText.includes("含多个 prompt_order 分组")')
    assert.equal(await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent==="创建预设").disabled'), true)
    await chooseGroup('角色 2（2 条）'); await ready()
    await evaluate('window.previewPlan=[{hold:true}]; true'); await chooseGroup('角色 1（1 条）'); await waitFor('window.releasePreview !== undefined')
    assert.equal(await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent==="创建预设").disabled'), true)
    await chooseGroup('角色 2（2 条）'); await ready(); const revision = await evaluate('window.requests.filter(r=>r.body?.preview).length')
    await evaluate('window.releasePreview(); true'); await sleep(80); await click('创建预设')
    await waitFor(`${commits}.length===1`)
    assert.equal(await evaluate(`${commits}[0].body.promptOrderCharacterId`), '2')
    assert.equal(await evaluate('window.requests.filter(r=>r.body?.preview).length'), revision)
    await mount(); await evaluate(`window.previewPlan=[{value:{state:'needs-kind-selection',summary:undefined,kinds:['native-preset','native-character']}}]; true`); await files()
    await waitFor('document.body.innerText.includes("选择来源类型")')
    await evaluate(`document.querySelector('input[name$="-kind"]').click(); true`); await ready()
    assert.equal(await evaluate('window.requests.filter(r=>r.body?.preview).at(-1).body.sourceKind'), 'native-preset')
  })
  await suite.test('覆盖确认取消首聚焦，取消回到同一预览；当前草稿阻止覆盖', async () => {
    await mount(); await files(); await ready()
    await evaluate(`[...document.querySelectorAll('label')].find(e=>e.textContent==='更新现有项目').querySelector('input').click(); true`)
    await waitFor('[...document.querySelectorAll("button")].some(b=>b.textContent==="更新项目"&&!b.disabled)')
    await click('更新项目'); await waitFor('document.querySelector("[role=alertdialog]") !== null')
    assert.equal(await evaluate('document.activeElement.textContent'), '返回检查')
    assert.equal(await evaluate('document.querySelectorAll("[aria-modal=true]").length'), 1)
    await click('返回检查'); assert.equal(await evaluate(`${commits}.length`), 0)
    await evaluate('window.store.dirtyConfigs=true; window.store.fields.promptConfigs.push({id:"draft",text:"keep me"}); true')
    await click('更新项目'); await click('更新项目')
    await waitFor('document.body.innerText.includes("预览已过期")')
    assert.equal(await evaluate('window.saved'), 1)
    assert.equal(await evaluate('window.saveOptions.includeInstructions'), false)
    assert.equal(await evaluate(`${commits}.length`), 0)
  })
  await suite.test('完整告警、降级 info、排除项与截断说明均可访问', async () => {
    await mount()
    await evaluate(`window.previewPlan=[{value:{report:{converter:'test',sourceName:'lossy',orderGroups:[],summary:{inputs:101,converted:1,disabled:0,excluded:1,unsupported:0,degraded:1,needsReview:101},truncated:true,entries:[{sourceId:'excluded-entry',sourceName:'Excluded',classification:'excluded',codes:['UNSUPPORTED']}],diagnostics:[...Array.from({length:100},(_,i)=>({severity:'warning',code:'W'+i,message:'WARNING-'+i,entryId:'source-'+i,targetId:'target-'+i})),{severity:'info',code:'info',message:'INFO-0',entryId:'source-info'}]}}}]; true`)
    await files(); await ready()
    assert.equal(await evaluate('document.querySelectorAll("[data-preview-warnings] li").length'), 100)
    assert.equal(await evaluate('document.body.innerText.includes("WARNING-99")'), true)
    assert.equal(await evaluate('document.body.innerText.includes("source-99") && document.body.innerText.includes("target-99")'), true)
    assert.equal(await evaluate('document.body.innerText.includes("INFO-0") && document.body.innerText.includes("excluded-entry")'), true)
    assert.equal(await evaluate('document.body.innerText.includes("报告已达服务端上限")'), true)
    assert.equal(await evaluate('document.body.innerText.includes("未发现降级、不支持或排除项")'), false)
    await mount(); await evaluate(`window.previewPlan=[{value:{report:{converter:'test',sourceName:'lossy',orderGroups:[],entries:[],diagnostics:[{severity:'info',code:'info',message:'INFO-only'}],summary:{inputs:1,converted:1,disabled:0,excluded:0,unsupported:0,degraded:1,needsReview:1}}}}]; true`)
    await files(); await ready()
    assert.equal(await evaluate('document.querySelector("[data-preview-warnings]")'), null)
    assert.equal(await evaluate('document.body.innerText.includes("未发现降级、不支持或排除项")'), false)
  })
  await suite.test('角色逐卡跳过、结束和卸载都不会提交后续；结果计数真实', async () => {
    await mount('characters'); await files(['first.png', 'second.json', 'third.yml']); await ready()
    await click('跳过这张'); await ready(); await click('保存为新角色'); await waitFor('document.body.innerText.includes("第 3 / 3 张")')
    await click('结束本次导入'); await waitFor('document.body.innerText.includes("已导入 1 项 · 跳过 2 项 · 失败 0 项")')
    assert.equal(await evaluate(`${commits}.length`), 1)
    await mount('characters'); await files(['first.png', 'second.json']); await ready()
    await evaluate('window.holdSubmit=true; true'); await click('保存为新角色'); await waitFor('window.releaseSubmit !== undefined')
    await evaluate('window.unmount(); window.releaseSubmit(); true'); await sleep(80)
    assert.equal(await evaluate('window.requests.filter(r=>r.endpoint==="asset-upload").length'), 1)
    assert.equal(await evaluate(`${commits}.length`), 1)
  })
  await suite.test('成功后的刷新失败只重试刷新，不重传或重复安装', async () => {
    await mount('characters'); await files(); await ready(); await evaluate('window.refreshError=true; true'); await click('保存为新角色')
    await waitFor('document.body.innerText.includes("已导入，但列表刷新失败")')
    await evaluate('window.refreshError=false; true'); await click('重试刷新'); await waitFor('!document.body.innerText.includes("refresh failed")')
    assert.equal(await evaluate(`${commits}.length`), 1)
  })
  await suite.test('导出范围、缺失资源、记忆逐项选择、版本与重复点击', async () => {
    await evaluate('window.mount(); true'); await sleep(80)
    await evaluate(`window.exportPlan=[{ok:true,value:{id:'current',name:'Current',content:'',revision:'blocked',files:[],blockers:['missing.md'],memoryConflicts:[{id:'memory-one',name:'Unknown memory'}],excludedMemoryCount:0}}]; true`)
    await click('导出预设…'); await waitFor('document.body.innerText.includes("missing.md")')
    assert.equal(await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent==="导出 ZIP").disabled'), true)
    await evaluate(`[...document.querySelectorAll('label')].find(e=>e.textContent==='排除内容').querySelector('input').click(); true`)
    await waitFor('window.requests.filter(r=>r.endpoint==="export-preset").length===2')
    await evaluate(`document.querySelector('input[name$="-mode"]:not(:checked)').click(); true`)
    await waitFor('[...document.querySelectorAll("button")].some(b=>b.textContent==="导出 YAML"&&!b.disabled)')
    await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent==='导出 YAML');b.click();b.click()})(); true`)
    await waitFor('document.body.innerText.includes("浏览器已开始下载")')
    assert.deepEqual(await evaluate('window.downloads'), ['current.preset.yml'])
    const body = await evaluate('window.requests.filter(r=>r.endpoint==="export-preset"&&!r.body.preview)[0].body')
    assert.deepEqual(body, { id: 'current', mode: 'definition', memoryChoices: { 'memory-one': 'exclude' }, expectedRevision: 'export-rev' })
  })
  await suite.test('原生报告和长路径可见，320px、焦点与 reduced-motion', async () => {
    await mount(); await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 640, deviceScaleFactor: 1, mobile: false })
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await files(); await ready()
    assert.equal(await evaluate('document.documentElement.scrollWidth <= 320'), true)
    assert.equal(await evaluate('document.body.innerText.includes("2 个文件")'), true)
    await evaluate(`document.documentElement.style.setProperty('--dsw-alias-bg-layer-2','#171717');document.documentElement.style.setProperty('--dsw-alias-label-primary','#eee');document.documentElement.style.fontSize='200%';true`)
    assert.equal(await evaluate('document.documentElement.scrollWidth <= 320'), true)
    await evaluate(`(()=>{const buttons=[...document.querySelectorAll('[role=dialog] button')].filter(b=>!b.disabled);buttons.at(-1).focus();return true})()`)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab' })
    assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), '关闭导入')
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
    await waitFor('document.querySelector("[role=dialog]") === null')
    assert.equal(await evaluate('document.activeElement.textContent'), '导入预设…')
    await send('Emulation.clearDeviceMetricsOverride')
    assert.deepEqual(await evaluate('window.errors'), [])
  })
})

test('浏览器：子代理筛选、模板创建与只读边界保持', { skip: skipBrowser, timeout: 30000 }, async () => {
  const { send, evaluate, waitFor, click, origin } = await ensureSession()
  await send('Page.navigate', { url: `${origin}/scope` }); await waitFor('window.mount !== undefined')
  await evaluate('window.mount("subagent"); true'); await sleep(80)
  const choose = async (label) => { await evaluate(`document.querySelector('[aria-label="按层级或策略过滤"]').click(); true`); await sleep(50); await click(label) }
  await choose('层级：系统提示段')
  assert.equal(await evaluate('document.querySelector("[data-config-id=pre-config]") === null'), true)
  assert.equal(await evaluate('document.querySelector("[data-config-id=system-config]") !== null'), true)
  await choose('层级：工具链')
  // 该层没有配置卡：用不写盘的兜底容器列出本层已装配能力（能力卡已退场）。
  await waitFor('document.querySelector("[data-layer-settings-standalone=tool-pipeline]") !== null')
  assert.equal(await evaluate('document.querySelector("[data-layer-capability=subagent-tool-policy]") !== null'), true, '兜底容器列出本层已装配能力')
  assert.equal(await evaluate('document.querySelector("[data-layer-capability=anchor-turn]") === null'), true, '只列本层能力，不列其他层')
  assert.equal(await evaluate('document.querySelector("[data-module-card-id]") === null'), true, '独立能力卡已退场')
  await choose('层级：前置步骤')
  await evaluate(`document.querySelector('input[aria-label="过滤提示词配置"]').focus(); true`); await send('Input.insertText', { text: 'created' })
  await click('添加能力 / 工具模块'); await click('添加模板 · 前置步骤')
  await waitFor('document.querySelector("[role=dialog]")?.textContent.includes("created.yml")')
  await evaluate('[...document.querySelectorAll("[role=dialog] button")].find(b=>b.textContent.includes("created.yml")).click(); true')
  await waitFor('document.querySelector("[data-config-id=created-new]") !== null')
  assert.equal(await evaluate('document.querySelector("[data-config-id=created-new] [aria-expanded]").getAttribute("aria-expanded")'), 'true')
  await waitFor('window.scrolls.includes("created-new")')
  assert.equal(await evaluate(`document.querySelector('input[aria-label="过滤提示词配置"]').value`), 'created')
  await evaluate('window.mount("subagent",false); true'); await sleep(80); await click('添加能力 / 工具模块')
  assert.equal(await evaluate('document.body.innerText.includes("新建空白工具")'), false)
  assert.equal(await evaluate('document.body.innerText.includes("添加模块 · context-gate")'), false)
  assert.deepEqual(await evaluate('window.errors'), [])
})

after(async () => {
  if (!shared) return
  const { browser, exited, ws, server, profile, filesDir } = shared
  const forced = setTimeout(() => browser.kill(), 5000)
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: 1000000, method: 'Browser.close' })); else browser.kill()
  await exited; clearTimeout(forced); ws.close(); await new Promise((done) => server.close(done))
  for (const directory of [profile, filesDir]) { assert.ok(resolve(directory).startsWith(resolve(process.cwd()) + sep)); rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) }
})
