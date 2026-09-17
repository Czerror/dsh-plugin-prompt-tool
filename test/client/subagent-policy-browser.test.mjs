// F02/F03/F04：真实 React DOM 标签失焦、保存中的草稿、失败重试及预设生命周期。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { SUBAGENT_TOOL_POLICY_SKELETON } from '../../src/shared/engine-capabilities.ts'
import { validateSubagentToolPolicy } from '../../engine/subagent-tool-policy-core.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(new URL('../../package.json', import.meta.url))
const browserPath = process.env.PROMPT_TOOL_TEST_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'

test('浏览器：子代理策略失焦保存与草稿隔离', { skip: !existsSync(browserPath) && '设置 PROMPT_TOOL_TEST_BROWSER 运行真实浏览器', timeout: 60000 }, async (t) => {
  const { rolldown } = await import(pathToFileURL(createRequire(require.resolve('tsdown')).resolve('rolldown')))
  const ts = require('typescript')
  const bundle = await rolldown({ input: join(root, 'test/fixtures/subagent-policy.mjs'), platform: 'browser',
    transform: { define: { 'process.env.NODE_ENV': JSON.stringify('production'), 'process.env': '{}', 'import.meta.env': '{}' } },
    plugins: [{ name: 'isolated-policy-ui',
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
    res.end(req.url === '/app.js' ? js : '<!doctype html><meta charset="utf-8"><div id="root"></div><button id="outside">outside</button><script src="/app.js"></script>')
  }).listen(0, '127.0.0.1')
  await new Promise((done) => server.on('listening', done))
  const profile = mkdtempSync(join(tmpdir(), 'pt-policy-browser-'))
  const browser = spawn(browserPath, ['--headless=new', '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' })
  const exited = new Promise((done) => browser.once('exit', done))
  let ws
  let send
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
    send = (method, params = {}) => new Promise((resolve, reject) => { pending.set(++id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })) })
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails))
      return result.result.value
    }
    const waitFor = async (expression) => {
      for (let i = 0; i < 60; i++) { if (await evaluate(expression)) return; await sleep(25) }
      assert.fail(`等待超时：${expression}`)
    }
    const name = 'input[aria-label="profile name"]'
    const reset = async (plans = {}) => {
      await evaluate(`window.reset(${JSON.stringify(plans)}); true`)
      await waitFor(`document.querySelector(${JSON.stringify(name)})?.value === 'original-a'`)
    }
    const edit = async (selector, value) => {
      await evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});input.focus();input.select();return true})()`)
      await send('Input.insertText', { text: value })
    }
    const blur = () => evaluate('document.querySelector("#outside").focus(); true')
    const settleWrite = async () => {
      await evaluate('window.pendingWrites.shift()(); true')
      await sleep(70)
    }
    await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` })
    await waitFor('window.reset !== undefined')

    await t.test('首次标签失焦保存新黑名单，卡内切换控件不写盘', async () => {
      await reset()
      await edit('#pt-sp-ceiling-deny', 'write')
      await blur()
      await waitFor('window.writes.length === 1')
      assert.deepEqual(await evaluate('window.writes[0].policy.ceiling.deny'), ['write'])
      await edit('#pt-sp-ceiling-deny', 'bash')
      await evaluate(`document.querySelector(${JSON.stringify(name)}).focus(); true`)
      await sleep(70)
      assert.equal(await evaluate('window.writes.length'), 1)
      await blur()
      await waitFor('window.writes.length === 2')
      assert.deepEqual(await evaluate('window.writes[1].policy.ceiling.deny'), ['write', 'bash'])
    })

    await t.test('旧响应不确认保存中继续输入的新草稿', async () => {
      await reset({ writes: [{ defer: true }] })
      await edit(name, 'first')
      await blur()
      await waitFor('window.pendingWrites.length === 1')
      await edit(name, 'second')
      await settleWrite()
      await blur()
      await waitFor('window.writes.length === 2')
      assert.deepEqual(await evaluate('window.writes.map(r=>r.policy.profiles[0].name)'), ['first', 'second'])
    })

    await t.test('保存中再次失焦排队，响应后保存最新已提交草稿', async () => {
      await reset({ writes: [{ defer: true }] })
      await edit(name, 'first')
      await blur()
      await waitFor('window.pendingWrites.length === 1')
      await edit(name, 'second')
      await blur()
      assert.equal(await evaluate('window.writes.length'), 1, '请求串行')
      await settleWrite()
      await waitFor('window.writes.length === 2')
      assert.deepEqual(await evaluate('window.writes.map(r=>r.policy.profiles[0].name)'), ['first', 'second'])
      await waitFor('window.saved.a.profiles[0].name === "second"')
    })

    await t.test('保存失败后保留草稿，再次失焦可以重试', async () => {
      await reset({ writes: [{ ok: false }] })
      await edit(name, 'retry')
      await blur()
      await waitFor('window.notices.some(n=>n.kind === "error")')
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(name)}).value`), 'retry')
      await evaluate(`document.querySelector(${JSON.stringify(name)}).focus(); true`)
      await blur()
      await waitFor('window.writes.length === 2 && window.saved.a.profiles[0].name === "retry"')
    })

    await t.test('关闭再打开复用共享可用骨架', async () => {
      await reset()
      const toggle = '[role="switch"][aria-label="启用子代理工具策略"]'
      await evaluate(`document.querySelector(${JSON.stringify(toggle)}).click(); true`)
      await waitFor(`window.writes.length === 1 && !document.querySelector(${JSON.stringify(toggle)}).disabled`)
      assert.equal(await evaluate('window.writes[0].policy'), null)
      await evaluate(`document.querySelector(${JSON.stringify(toggle)}).click(); true`)
      await waitFor('window.writes.length === 2')
      const policy = await evaluate('window.writes[1].policy')
      assert.deepEqual(policy, SUBAGENT_TOOL_POLICY_SKELETON)
      assert.deepEqual(validateSubagentToolPolicy(policy), [])
    })

    await t.test('预设切换隔离迟到读取、保存响应与待存队列', async () => {
      await evaluate('window.reset({reads:[{defer:true}]}); true')
      await waitFor('window.pendingReads.length === 1')
      await evaluate('window.selectPreset("b"); true')
      await waitFor(`document.querySelector(${JSON.stringify(name)})?.value === 'original-b'`)
      await evaluate('window.pendingReads.shift()(); true')
      await sleep(70)
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(name)}).value`), 'original-b')

      await reset({ writes: [{ defer: true }] })
      await edit(name, 'first-a')
      await blur()
      await waitFor('window.pendingWrites.length === 1')
      await edit(name, 'queued-a')
      await blur()
      await evaluate('window.selectPreset("b"); true')
      await waitFor(`document.querySelector(${JSON.stringify(name)})?.value === 'original-b'`)
      await edit(name, 'edited-b')
      await settleWrite()
      assert.deepEqual(await evaluate('window.notices'), [], '旧响应不向新预设发出保存成功提示')
      assert.equal(await evaluate('window.writes.length'), 1, '旧待存队列失效')
      await blur()
      await waitFor('window.writes.length === 2')
      assert.deepEqual(await evaluate('window.writes.map(r=>[r.expectedPresetId,r.policy.profiles[0].name])'), [['a', 'first-a'], ['b', 'edited-b']])
    })

    await t.test('卸载后忽略保存响应，且不继续旧队列', async () => {
      await reset({ writes: [{ defer: true }] })
      await edit(name, 'first')
      await blur()
      await waitFor('window.pendingWrites.length === 1')
      await edit(name, 'queued')
      await blur()
      await evaluate('window.unmount(); true')
      await settleWrite()
      assert.equal(await evaluate('window.writes.length'), 1)
      assert.deepEqual(await evaluate('window.notices'), [])
    })
    assert.deepEqual(await evaluate('window.errors'), [])
  } finally {
    if (send && ws?.readyState === WebSocket.OPEN) await send('Browser.close').catch(() => {})
    else browser.kill()
    await exited
    ws?.close()
    await new Promise((done) => server.close(done))
    assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep))
    rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })
  }
})
