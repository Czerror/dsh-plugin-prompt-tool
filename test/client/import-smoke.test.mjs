// 由 import-preview-browser.test.mjs 与 import-scope-browser.test.mjs 合并
//（2026-09-17 测试归一精简 B 档 Wave 3 / C3a-S1）。
//
// 两个成员都围绕「导入预览状态机」：前者覆盖导入确认生命周期、顺序组候选与预览版本化提交、
// 有损信息完整展示；后者覆盖整包导入、在途取消、子代理筛选与创建边界。合并后共用一套基础设施 ——
// 两次 rolldown 打包（各自 fixture）、一个多路由 http server（/preview.js 与 /scope.js）、
// **一个 Edge 实例**；两条顶层用例各自 `Page.navigate` 到自己那一页（页面重载即重置 window 状态）。
//
// 断言与用例标题逐字保留：preview 成员 1 条顶层用例；scope 成员 1 条顶层用例 + 8 条子测试。
// 只用真实 DOM 交互与 fixture 记录的实际请求做断言，不用源码字符串匹配。
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync, mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
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
/** 两个成员共用的 skip 守卫：没有本地 Edge 时整组跳过（可用 PROMPT_TOOL_TEST_BROWSER 指定）。 */
const skipBrowser = !existsSync(browserPath) && '设置 PROMPT_TOOL_TEST_BROWSER 以运行真实浏览器回归'

/**
 * 懒创建的共享会话：两次打包 + 多路由 server + 一个 Edge 实例 + CDP 连接。
 * 由第一条真正执行的用例创建（两条用例都 skip 时不会启动浏览器）。
 */
let shared
async function ensureSession() {
  if (shared !== undefined) return shared
  const { rolldown } = await import(pathToFileURL(createRequire(require.resolve('tsdown')).resolve('rolldown')))
  const ts = require('typescript')
  const bundleOf = async (fixture, name) => {
    const bundle = await rolldown({
      input: join(root, fixture), platform: 'browser',
      transform: { define: { 'process.env.NODE_ENV': JSON.stringify('production'), 'process.env': '{}', 'import.meta.env': '{}' } },
      plugins: [{
        name,
        resolveId(source) {
          if (['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'].includes(source)) return require.resolve(source)
          if (source.endsWith('.css')) return '\0test-css:' + source + '.mjs'
        },
        load(id) { if (id.startsWith('\0test-css:')) return 'export default new Proxy({}, {get:(_,key)=>key})' },
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
  const scripts = {
    '/preview.js': await bundleOf('test/fixtures/character-import.mjs', 'isolated-import-preview'),
    '/scope.js': await bundleOf('test/fixtures/import-scope.mjs', 'isolated-import-scope'),
  }
  const server = createServer((req, res) => {
    const js = scripts[req.url]
    res.setHeader('Content-Type', js === undefined ? 'text/html' : 'text/javascript')
    if (js !== undefined) return res.end(js)
    const script = req.url === '/scope' ? '/scope.js' : '/preview.js'
    res.end(`<!doctype html><meta charset="utf-8"><div id="root"></div><script src="${script}"></script>`)
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const profile = mkdtempSync(join(tmpdir(), 'pt-import-smoke-'))
  const filesDir = mkdtempSync(join(tmpdir(), 'pt-import-files-'))
  const browser = spawn(browserPath, ['--headless=new', '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' })
  const exited = once(browser, 'exit')
  const portFile = join(profile, 'DevToolsActivePort')
  for (let i = 0; !existsSync(portFile) && i < 150; i++) await sleep(100)
  const port = readFileSync(portFile, 'utf8').split('\n')[0]
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const ws = new WebSocket(pages.find((page) => page.type === 'page').webSocketDebuggerUrl)
  await new Promise((done) => ws.addEventListener('open', done, { once: true }))
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', ({ data }) => {
    const msg = JSON.parse(data)
    if (!msg.id) return
    const request = pending.get(msg.id)
    if (request === undefined) return
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
  // 两个成员原本的等待预算与失败信息取并集：120 次 × 50ms，失败时同时打印正文与未处理异常。
  const waitFor = async (expression, label = expression) => {
    for (let i = 0; i < 120; i++) { if (await evaluate(expression)) return; await sleep(50) }
    assert.fail(`等待超时：${label}\n${await evaluate('document.body.innerText')}\n${await evaluate('JSON.stringify(window.errors ?? [])')}`)
  }
  shared = { server, profile, filesDir, browser, exited, ws, send, evaluate, waitFor, origin: `http://127.0.0.1:${server.address().port}` }
  return shared
}

test('浏览器：导入确认生命周期、顺序组候选与预览版本', { skip: skipBrowser, timeout: 120000 }, async () => {
  const { send, evaluate, waitFor, origin, filesDir } = await ensureSession()
  const clickText = async (text) => {
    assert.equal(await evaluate(`(()=>{const button=[...document.querySelectorAll('button')].find(e=>e.getClientRects().length&&e.textContent.trim()===${JSON.stringify(text)});if(!button)return false;button.click();return true})()`), true, text)
    await sleep(40)
  }
  const previewOpen = `[...document.querySelectorAll('h2')].some((node) => node.textContent.includes('导入预览'))`
  const buttonState = (text) => `(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.getClientRects().length&&e.textContent.trim()===${JSON.stringify(text)});return b===undefined?null:{disabled:b.disabled,focusable:(b.focus(),document.activeElement===b)}})()`
  const requestsOf = (endpoint, preview) =>
    `window.requests.filter((r) => r.endpoint === ${JSON.stringify(endpoint)} && (r.body.preview === true) === ${preview}).length`
  const lastPreviewBody = (endpoint) =>
    `(()=>{const list=window.requests.filter((r)=>r.endpoint===${JSON.stringify(endpoint)}&&r.body.preview===true);return list.length===0?null:list.at(-1).body})()`
  const lastSubmitBody = (endpoint) =>
    `(()=>{const list=window.requests.filter((r)=>r.endpoint===${JSON.stringify(endpoint)}&&r.body.preview!==true);return list.length===0?null:list.at(-1).body})()`

  /** 真实文件输入：把磁盘文件交给浏览器 file input（真实 change 事件与 File 对象）。 */
  let fileSeq = 0
  const setFiles = async (selector, payload) => {
    const name = `case-${++fileSeq}.json`
    const target = join(filesDir, name)
    writeFileSync(target, JSON.stringify(payload), 'utf8')
    const doc = await send('DOM.getDocument', { depth: -1 })
    const node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector })
    assert.ok(node.nodeId > 0, `文件输入存在：${selector}`)
    await send('DOM.setFileInputFiles', { files: [target], nodeId: node.nodeId })
    return name
  }
  const cardPayload = { data: { name: 'Ada', first_mes: 'HI' } }
  const setCardFiles = () => setFiles('input[type=file][accept=".json"]', cardPayload)
  const setPresetFiles = () => setFiles('input[type=file][accept=".yml,.yaml,.json"]', { prompts: [], name: 'Demo' })
  const chooseGroup = async (label) => {
    await evaluate(`document.querySelector('[aria-label="选择顺序组"]').click()`)
    await sleep(80)
    await clickText(label)
    await sleep(80)
  }

  await send('Page.navigate', { url: `${origin}/preview` })
  await waitFor(`window.requests?.some((r) => r.endpoint === 'characters-list')`,
    `导入页挂载（fixture 错误：${await evaluate('JSON.stringify(window.errors ?? [])')}）`)

  // ---- 角色卡 JSON：等待确认即可操作，一次确认一次提交 ----
  const cardSubmit = requestsOf('characters-import', false)
  await setCardFiles()
  await waitFor(previewOpen, '预览卡出现')
  assert.deepEqual(await evaluate(buttonState('确认导入')), { disabled: false, focusable: true })
  assert.deepEqual(await evaluate(buttonState('取消预览')), { disabled: false, focusable: true })
  await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='确认导入');b.click();b.click();b.click()})()`)
  await waitFor(`${cardSubmit} === 1`, '一次确认一次提交')
  await sleep(150)
  assert.equal(await evaluate(cardSubmit), 1, '连点不重入')
  assert.equal(await evaluate(previewOpen), false)
  assert.equal(await evaluate(`window.notices.at(-1).kind`), 'ok')

  // 提交失败：保留预览与文件，再次确认即重试。
  await evaluate(`window.submitPlan = [{ ok: false, message: 'boom' }, { ok: true, value: { name: 'Ada' } }]`)
  await setCardFiles()
  await waitFor(previewOpen, '第二个文件出现预览')
  await clickText('确认导入')
  await waitFor(`window.notices.some((n) => n.message.includes('提交失败'))`, '提交失败提示')
  assert.equal(await evaluate(previewOpen), true, '失败后预览与文件保留')
  await clickText('确认导入')
  await waitFor(`${cardSubmit} === 3`, '重试成功')
  assert.equal(await evaluate(previewOpen), false)

  // 目标变化（服务端版本含目标身份）：过期凭据被拒，零写盘。
  await setCardFiles()
  await waitFor(previewOpen, '第三个文件出现预览')
  await evaluate(`window.submitPlan = [{ ok: false, code: 'characters-preview-stale', message: '预览已过期：目标已变化' }]`)
  await clickText('确认导入')
  await waitFor(`window.notices.some((n) => n.message.includes('预览已过期'))`, '过期提示')
  await sleep(150)
  assert.equal(await evaluate(previewOpen), false, '过期后要求重新预览')
  const cardSubmitAfterStale = await evaluate(cardSubmit)

  // 取消：零写入，队列结束。
  await setCardFiles()
  await waitFor(previewOpen, '第四个文件出现预览')
  await clickText('取消预览')
  await waitFor(`!(${previewOpen})`, '取消后关闭预览')
  await sleep(150)
  assert.equal(await evaluate(cardSubmit), cardSubmitAfterStale, '取消零写入')
  assert.equal(await evaluate(`document.querySelector('input[type=file][accept=".json"]').disabled`), false, '队列结束')

  // 卸载：等待确认时卸载，不悬挂、不继续写盘。
  const noticeCountBeforeUnmount = await evaluate('window.notices.length')
  await setCardFiles()
  await waitFor(previewOpen, '卸载前预览')
  await evaluate('window.unmount()')
  await sleep(200)
  assert.equal(await evaluate(cardSubmit), cardSubmitAfterStale, '卸载后不提交')
  assert.equal(await evaluate('window.notices.length'), noticeCountBeforeUnmount, '卸载不产生新的错误状态')
  await evaluate('window.mount()')
  await waitFor(previewOpen === 'false' ? 'true' : `${previewOpen} === false`, '重新挂载后回到空闲')

  // ---- 预设包：候选 → 选组 → ready → 版本化提交 ----
  const presetPreview = requestsOf('import-preset-package', true)
  const presetSubmit = requestsOf('import-preset-package', false)
  await evaluate(`window.previewPlan = [{ ok: true, value: {
    preview: true, state: 'needs-order-selection', sourceName: 'demo.json',
    candidates: [{ characterId: '111', entries: 1 }, { characterId: '222', entries: 2 }],
  } }]`)
  await setPresetFiles()
  await waitFor(`window.requests.some((r) => r.endpoint === 'import-preset-package' && r.body.preview === true)`, '预设预览请求')
  await waitFor(`document.body.innerText.includes('含多个 prompt_order 分组')`, '候选提示')
  assert.deepEqual(await evaluate(buttonState('确认导入')), { disabled: true, focusable: false }, '候选状态不得确认')
  assert.deepEqual(await evaluate(buttonState('取消预览')), { disabled: false, focusable: true })
  assert.equal(await evaluate(`document.body.innerText.includes('角色 111（1 条）') || document.body.innerText.includes('请选择顺序组')`), true)

  // 选组 → 立即重新预览（携带所选组），ready 后才可确认。
  await chooseGroup('角色 222（2 条）')
  await waitFor(`${presetPreview} === 2`, '选组触发重新预览')
  assert.equal((await evaluate(lastPreviewBody('import-preset-package'))).promptOrderCharacterId, '222')
  const confirmEnabled = `(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.getClientRects().length&&e.textContent.trim()==='确认导入');return b!==undefined&&!b.disabled})()`
  await waitFor(confirmEnabled, '重新预览后确认可用')
  assert.deepEqual(await evaluate(buttonState('确认导入')), { disabled: false, focusable: true })

  // 确认：提交必须带预览返回的版本凭据。
  await clickText('确认导入')
  await waitFor(`${presetSubmit} === 1`, '预设提交')
  const submitBody = await evaluate(lastSubmitBody('import-preset-package'))
  assert.match(submitBody.expectedPreviewRevision, /^rev-[0-9]+$/)
  assert.equal(submitBody.promptOrderCharacterId, '222', '提交沿用所选顺序组')

  // 换组：旧 ready 立即失效并重新预览（不是拿旧凭据换组提交）。
  await evaluate(`window.__reportWithGroups = { converter: 'st-to-preset/3', sourceName: 'demo.json', orderGroups: [{ characterId: '111', selected: true, entries: 1 }, { characterId: '222', selected: false, entries: 2 }], entries: [], diagnostics: [], summary: { inputs: 2, converted: 2, disabled: 0, excluded: 0, unsupported: 0, degraded: 0, needsReview: 0 } }`)
  await evaluate(`window.previewPlan = [{ ok: true, value: { preview: true, state: 'ready', sourceDigest: 'digest-x', previewRevision: 'rev-x', report: window.__reportWithGroups } }]`)
  await setPresetFiles()
  await waitFor(`${presetPreview} === 3`, '第三份预览')
  await waitFor(`document.querySelector('[aria-label="选择顺序组"]') !== null`, 'ready 卡的组选择器')
  // 报告里 selected 是 111：换到另一组必须重新预览，而不是沿用旧凭据提交。
  await chooseGroup('角色 222（2 条）')
  await waitFor(`${presetPreview} === 4`, '换组触发重新预览')
  assert.equal((await evaluate(lastPreviewBody('import-preset-package'))).promptOrderCharacterId, '222')

  // 乱序响应：慢的旧请求后返回也不能覆盖新状态。
  // 换组重预览期间卡片保留（确认禁用），因此可以连续发起两次预览，构造真实乱序。
  // 队列互斥：等待确认时导入按钮 busy，先取消当前预览再选新文件。
  await clickText('取消预览')
  await waitFor(`!(${previewOpen})`, '取消后回到空闲')
  await evaluate(`window.__groupReport = (id) => ({ converter: 'st-to-preset/3', sourceName: 'demo.json', orderGroups: [{ characterId: '111', selected: id === '111', entries: 1 }, { characterId: '222', selected: id === '222', entries: 2 }], entries: [], diagnostics: [], summary: { inputs: 2, converted: 2, disabled: 0, excluded: 0, unsupported: 0, degraded: 0, needsReview: 0 } })`)
  await evaluate(`window.previewPlan = [
    { value: { preview: true, state: 'ready', sourceDigest: 'digest-base', previewRevision: 'rev-base', report: window.__groupReport('111') } },
    { delay: 500, value: { preview: true, state: 'ready', sourceDigest: 'digest-slow', previewRevision: 'rev-slow', report: window.__groupReport('222') } },
    { value: { preview: true, state: 'ready', sourceDigest: 'digest-fast', previewRevision: 'rev-fast', report: window.__groupReport('222') } },
  ]`)
  await setPresetFiles()
  await waitFor(`${presetPreview} === 5`, '第五份预览')
  await waitFor(`document.querySelector('[aria-label="选择顺序组"]') !== null`, '等待组选择器')
  await chooseGroup('角色 222（2 条）')
  await sleep(40)
  assert.equal((await evaluate(buttonState('确认导入'))).disabled, true, '重预览期间确认禁用（旧 ready 已失效）')
  await sleep(40)
  await chooseGroup('角色 222（2 条）')
  for (let i = 0; i < 60 && (await evaluate(presetPreview)) < 7; i++) await sleep(50)
  assert.equal(await evaluate(presetPreview), 7, await evaluate(`JSON.stringify(window.requests.filter((r) => r.endpoint === 'import-preset-package').map((r) => ({ preview: r.body.preview === true, group: r.body.promptOrderCharacterId ?? null })))`))
  await sleep(700)
  await waitFor(previewOpen, '乱序后仍有报告卡')
  await clickText('确认导入')
  await waitFor(`${presetSubmit} === 2`, '乱序后的提交')
  const outOfOrderBody = await evaluate(lastSubmitBody('import-preset-package'))
  assert.equal(outOfOrderBody.expectedPreviewRevision, 'rev-fast', '慢的旧响应不得恢复旧 ready')
  assert.equal(await evaluate(`window.errors.length`), 0, '不应有未处理异常')

  // ---- T06 有损信息完整可查看：20/21/200 条、info、被排除条目、零告警与截断提示 ----
  await evaluate(`window.__makeReport = (n, opts = {}) => ({
    converter: 'st-to-preset/3',
    sourceName: 'demo.json',
    orderGroups: [],
    entries: opts.excluded === true
      ? [{ sourceId: 'gone', sourceIndex: 0, classification: 'excluded', codes: ['marker-dropped'], sourceName: 'demo.json' }]
      : [],
    diagnostics: [
      ...Array.from({ length: n }, (_, i) => ({ code: 'w' + i, severity: 'warning', message: 'WARN-' + i, entryId: 'e' + i, targetId: 'lore-' + i })),
      ...(opts.info === true ? [{ code: 'i0', severity: 'info', message: 'INFO-0', entryId: 'e-info', targetId: 'lore-1' }] : []),
    ],
    summary: { inputs: n, converted: n, disabled: 0, excluded: opts.excluded === true ? 1 : 0, unsupported: 0, degraded: opts.excluded === true ? 1 : 0, needsReview: n },
    ...(opts.truncated === true ? { truncated: true } : {}),
  })`)
  const warningsShown = `document.querySelectorAll('[data-preview-warnings] > li').length`
  for (const [n, opts] of [[20, {}], [21, { info: true, excluded: true }], [200, { truncated: true }]]) {
    await evaluate(`window.previewPlan = [{ value: { preview: true, state: 'ready', sourceDigest: 'digest-${n}', previewRevision: 'rev-list-${n}', report: window.__makeReport(${n}, ${JSON.stringify(opts)}) } }]`)
    await setPresetFiles()
    await waitFor(`${warningsShown} === ${n}`, `${n} 条告警全部展示（不做前端二次截断）`)
    assert.equal(await evaluate(`[...document.querySelectorAll('[data-preview-warnings] > li')].at(-1).textContent.includes('WARN-${n - 1}')`), true, '最后一条也能看到')
    assert.equal(await evaluate(`document.querySelector('[data-preview-warnings]').getAttribute('tabindex')`), '0', '列表可键盘聚焦滚动')
    if (n === 21) {
      assert.equal(await evaluate(`document.querySelectorAll('[data-preview-infos] > li').length`), 1, 'info 级降级也能查看')
      assert.equal(await evaluate(`document.querySelectorAll('[data-preview-excluded] > li').length`), 1, '被排除条目也能查看')
      assert.equal(await evaluate(`document.body.innerText.includes('来源条目 gone')`), true, '被排除条目带来源定位')
      assert.equal(await evaluate(`document.querySelector('[data-preview-warnings] > li').textContent.includes('目标 lore-0')`), true, '诊断带目标定位')
    }
    if (n === 200) {
      // 测试替身把 CSS 换成了类名 Proxy，这里只断言结构（滚动容器类 + 可聚焦），
      // 像素级滚动由 docs/ui-architecture.md 的样式所有权与人工 smoke 负责。
      assert.equal(await evaluate(`document.querySelector('[data-preview-warnings]').className.includes('previewList')`), true, '长列表使用滚动容器')
      assert.match(await evaluate('document.body.innerText'), /来源条目共 200 条/, '截断提示给出可见范围与全量计数')
    }
    assert.equal(await evaluate(buttonState('确认导入')).then((state) => state.disabled), false, '有损信息不等于不能确认')
    await clickText('取消预览')
    await waitFor(`!(${previewOpen})`, '每轮结束回到空闲')
  }
  // 零告警、零降级时明确说无需检查；有降级但零 warning 时不得宣称无需检查。
  await evaluate(`window.previewPlan = [
    { value: { preview: true, state: 'ready', sourceDigest: 'clean', previewRevision: 'rev-clean', report: window.__makeReport(0) } },
    { value: { preview: true, state: 'ready', sourceDigest: 'degraded', previewRevision: 'rev-degraded', report: window.__makeReport(0, { info: true }) } },
  ]`)
  await setPresetFiles()
  await waitFor(`document.body.innerText.includes('未发现降级、不支持或排除项')`, '零告警提示')
  assert.equal(await evaluate(`document.querySelector('[data-preview-warnings]') === null`), true)
  await clickText('取消预览')
  await waitFor(`!(${previewOpen})`, '再次回到空闲')
  await setPresetFiles()
  await waitFor(`document.body.innerText.includes('INFO-0')`, '存在 info 降级时展示提示区')
  assert.equal(await evaluate(`document.body.innerText.includes('未发现降级、不支持或排除项')`), false, '有损计数大于零时不得宣称无需检查')
  await clickText('取消预览')
  await waitFor(`!(${previewOpen})`, '结束')
})

test('浏览器：整包导入、在途取消与子代理筛选/创建', { skip: skipBrowser, timeout: 60000 }, async (t) => {
  const { send, evaluate, waitFor, origin } = await ensureSession()
  const click = async text => { assert.equal(await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.getClientRects().length&&e.textContent.trim()===${JSON.stringify(text)});if(!b)return false;b.click();return true})()`), true, text); await sleep(60) }
  const mount = async mode => { await evaluate(`window.mount(${JSON.stringify(mode)}); true`); await sleep(100) }
  const upload = async (selector, paths) => {
    await evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});const list=new DataTransfer();for(const path of ${JSON.stringify(paths)}){const file=new File(['{}'],path.split('/').at(-1),{type:'application/json'});Object.defineProperty(file,'webkitRelativePath',{value:path});list.items.add(file)}input.files=list.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
  }
  const previewOpen = `document.body.innerText.includes('导入预览（先确认再写入）')`
  const chooseView = async label => { await evaluate(`document.querySelector('[aria-label="按层级或策略过滤"]').click(); true`); await sleep(60); await click(label) }
  await send('Page.navigate', { url: `${origin}/scope` })
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
})

// 两个成员原本各自在 finally 里关浏览器；合并后集中在此处（两次用例都跑完或都 skip 后执行）。
after(async () => {
  if (shared === undefined) return
  const { browser, exited, ws, server, profile, filesDir } = shared
  const forceClose = setTimeout(() => browser.kill(), 5000)
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: 1_000_000, method: 'Browser.close' }))
  else browser.kill()
  await exited
  clearTimeout(forceClose)
  ws?.close()
  await new Promise((done) => server.close(done))
  assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep))
  rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 })
  rmSync(filesDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })
})
