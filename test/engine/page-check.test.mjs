import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractConsoleLines,
  extractSelectorText,
  extractTitle,
  normalizePageUrl,
  pageRunnerPath,
  runSandboxJs,
  stripDomNoise,
  apply as applyPageCheck,
} from '../../engine/page-check.mjs'

// ── DOM 工具（纯函数）───────────────────────────────────────────────────────

test('stripDomNoise 剥离 style/script', () => {
  const html = '<html><style>.a{}</style><script>var x=1</script><body><p>hi</p></body></html>'
  const out = stripDomNoise(html)
  assert.ok(!out.includes('.a{}'))
  assert.ok(!out.includes('var x=1'))
  assert.ok(out.includes('<p>hi</p>'))
})

test('extractTitle / extractSelectorText：title + #id/.class/tag', () => {
  const html = '<title>  My Page  </title><div id="app"><span class="btn">Go</span><p>para</p></div>'
  assert.equal(extractTitle(html), 'My Page')
  assert.equal(extractSelectorText(html, '#app'), 'Go para')
  assert.equal(extractSelectorText(html, '.btn'), 'Go')
  assert.equal(extractSelectorText(html, 'p'), 'para')
  assert.equal(extractSelectorText(html, '#missing'), '')
  assert.equal(extractSelectorText(html, ''), '')
})

test('extractConsoleLines：CONSOLE/Uncaught/异常类型行提取去重', () => {
  const stderr = [
    'INFO:CONSOLE(2) "hello"',
    'ERROR:CONSOLE(3) "boom"',
    'Uncaught TypeError: x is not a function',
    'Uncaught TypeError: x is not a function',
    'noise line',
  ].join('\n')
  const out = extractConsoleLines(stderr)
  assert.ok(out.includes('console[2]: "hello"'))
  assert.ok(out.includes('console[3]: "boom"'))
  assert.ok(out.includes('Uncaught TypeError'))
  assert.ok(!out.includes('noise line'))
  assert.equal((out.match(/Uncaught TypeError/g) ?? []).length, 1, '去重')
})

// ── 本地 JS 引擎 ────────────────────────────────────────────────────────────

test('runSandboxJs：语法检查 + 纯逻辑运行 + 顶层 return + 无 require/process', () => {
  const ok = runSandboxJs('const a = [1,2,3]; return a.map(x => x * 2).join(",")')
  assert.equal(ok.ok, true)
  assert.ok(ok.output.includes('=> "2,4,6"'))
  const bad = runSandboxJs('const = broken')
  assert.equal(bad.ok, false)
  assert.ok(bad.error.length > 0)
  const denied = runSandboxJs('return process.cwd()')
  assert.equal(denied.ok, false, '沙箱无 process')
  const log = runSandboxJs('console.log("hi", 42); return 1')
  assert.ok(log.output.includes('hi 42'))
})

// ── URL 归一化 ──────────────────────────────────────────────────────────────

test('normalizePageUrl：http/file 原样；相对路径 base=工作区；盘符转 file://', () => {
  assert.equal(normalizePageUrl('https://example.com/x', '/ws'), 'https://example.com/x')
  assert.equal(normalizePageUrl('file:///a/b.html', '/ws'), 'file:///a/b.html')
  assert.equal(normalizePageUrl('index.html', 'C:/ws'), 'file:///C:/ws/index.html')
  assert.equal(normalizePageUrl('C:\\a\\b.html', '/ws'), 'file:///C:/a/b.html')
})

test('pageRunnerPath：显式 browserPath 优先；探测失败返回空串', () => {
  assert.equal(pageRunnerPath({ browserPath: 'C:/fake/chrome.exe' }), 'C:/fake/chrome.exe')
  const env = process.env.DSH_PAGE_RUNNER
  delete process.env.DSH_PAGE_RUNNER
  // 本机无 Chrome/Edge 时返回空串（探测为环境相关，仅断言类型）。
  assert.equal(typeof pageRunnerPath(), 'string')
  if (env !== undefined) process.env.DSH_PAGE_RUNNER = env
})

// ── 工具注册 ────────────────────────────────────────────────────────────────

test('page-check apply：注册 page_check 工具（config fail loud）', () => {
  const registered = []
  const ctx = {
    tools: { register: (tool) => registered.push(tool) },
    logger: { warn: () => {} },
  }
  applyPageCheck(ctx, {})
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'page_check')
  assert.equal(typeof registered[0].execute, 'function')
  assert.ok(registered[0].description.includes('Headless Chrome'))
  // 自定义描述参数化。
  const custom = []
  applyPageCheck({ tools: { register: (t) => custom.push(t) }, logger: { warn: () => {} } }, { description: '自定义页面验证' })
  assert.equal(custom[0].description, '自定义页面验证')
  // 未知 config 键 fail loud。
  assert.throws(() => applyPageCheck({ tools: { register: () => {} }, logger: { warn: () => {} } }, { nope: true }), /unknown config key/)
})

test('page_check execute：{js:…} 模式走本地引擎（无浏览器也 OK）', async () => {
  let tool
  applyPageCheck({ tools: { register: (t) => { tool = t } }, logger: { warn: () => {} } }, {})
  const r = await tool.execute({ js: 'return 1 + 1' }, {})
  assert.equal(r.ok, true)
  assert.ok(r.jsOutput.includes('=> 2'))
  // 无 subprocess 服务时 url 模式返回统一 FAIL 形状（降级不抛）。
  const fail = await tool.execute({ url: 'https://example.com' }, {})
  assert.equal(fail.ok, false)
  assert.equal(typeof fail.settleError, 'string')
  assert.equal(typeof fail.domText, 'string')
})
