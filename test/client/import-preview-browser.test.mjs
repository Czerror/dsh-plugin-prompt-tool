// T01/T03/T04 客户端行为：导入确认生命周期、顺序组候选与预览版本（真实 Edge + React DOM + 真实 File 输入）。
//
// 只断言行为：等待确认时按钮可用/可聚焦、一次确认一次提交、连点不重入、提交失败保留预览并可重试、
// 过期凭据被拒、取消零写入、多文件串行、卸载不悬挂、候选状态确认禁用、换组重新预览、乱序响应被丢弃。
// 断言来源是真实 DOM 交互与 fixture 记录的实际请求，不用源码字符串匹配。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync, mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const root = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(new URL('../../package.json', import.meta.url))
const browserPath = process.env.PROMPT_TOOL_TEST_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'

test('浏览器：导入确认生命周期、顺序组候选与预览版本', { skip: !existsSync(browserPath) && '设置 PROMPT_TOOL_TEST_BROWSER 以运行真实浏览器回归', timeout: 120000 }, async () => {
  const { rolldown } = await import(pathToFileURL(createRequire(require.resolve('tsdown')).resolve('rolldown')))
  const ts = require('typescript')
  const bundle = await rolldown({ input: join(root, 'test/fixtures/character-import.mjs'), platform: 'browser',
    transform: { define: { 'process.env.NODE_ENV': JSON.stringify('production'), 'process.env': '{}', 'import.meta.env': '{}' } },
    plugins: [{
      name: 'isolated-ui-test',
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
    res.end(req.url === '/app.js' ? js : '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/app.js"></script>')
  }).listen(0, '127.0.0.1')
  await new Promise((done) => server.on('listening', done))
  const profile = mkdtempSync(join(tmpdir(), 'pt-import-browser-'))
  const filesDir = mkdtempSync(join(tmpdir(), 'pt-import-files-'))
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
    const waitFor = async (expression, label = expression) => {
      for (let i = 0; i < 120; i++) { if (await evaluate(expression)) return; await sleep(50) }
      assert.fail(`等待超时：${label}\n${await evaluate('document.body.innerText')}`)
    }
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

    await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` })
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
  } finally {
    ws?.close()
    browser.kill()
    server.close()
    await sleep(500)
    assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep))
    rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })
    rmSync(filesDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })
  }
})
