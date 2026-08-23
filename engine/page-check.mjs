/**
 * page-check — headless Chrome 页面验证工具（参考 dsh-router-standard
 * dev_page_check 机制自写，MIT）。
 *
 * 单调用完成：截图（写会话工作区 .dsh-shots/）+ DOM smoke（dump-dom 剥离
 * style/script）+ console/pageerror 提取（--enable-logging=stderr）+ title +
 * #id/.class/tag 选择器文本 + scale（device-factor 缩放）。
 * `{js:…}` 模式 = 本地 VM 引擎（语法检查 + 纯逻辑运行，无 require/process/fs）。
 *
 * CPU/进程安全三防（router v1.9.1 实弹教训）：
 *  ① 单飞锁：本进程同时只跑一个页面检查（并发返回 busy，不堆 chrome 进程）；
 *  ② 结束/超时后强制树杀（win32 taskkill /F /T；POSIX kill -9 整组），
 *     subprocess 温和 kill 杀不死无窗口 headless chrome（孤儿 renderer 累积满载）；
 *  ③ 自动重试默认开启（可重试型失败：非硬错误、未超时），重试降分辨率防 CPU 双爆。
 *
 * 参数化：工具描述/浏览器路径/超时/lite 全部 config 可配；行为与 router
 * 对齐（fresh profile、硬超时树杀、失败给原因 + 下一步）。config 错误
 * fail at apply time；执行失败返回统一 FAIL 形状（不 brick 会话）。
 */

import { existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { booleanOption, createWarnOnce, validateConfig } from './shared.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'page-check'

/** subprocess（spawn chrome）与 tools（注册工具）必须就绪。 */
export const inject = ['subprocess', 'tools']

/** Every config key this plugin accepts — anything else is a typo. */
const ALLOWED_KEYS = new Set([
  'browserPath', 'timeoutMs', 'lite', 'retry', 'description',
])

const DEFAULT_DESCRIPTION = [
  'Headless Chrome page verification: screenshot + DOM smoke + console/pageerror + title + selector text.',
  '* url: http(s):// / file:// / path (relative resolves to the session workspace; Chinese paths auto-encoded).',
  '* {js: "code"}: local JS engine (syntax check + pure-logic run, no require/process/fs; top-level return = result).',
  '* lite: true for heavy pages (960x640 single-frame, ~15s); retry: false to disable the automatic retry.',
  '* selector: "#id" / ".class" / "tag" text extraction. scale: device-scale factor (1-4).',
  '* Screenshot lands in <workspace>/.dsh-shots/ — readable via read_image.',
].join('\n')

/** 浏览器探测：DSH_PAGE_RUNNER env → Chrome/Edge 常见路径（config.browserPath 显式优先）。 */
export function pageRunnerPath(config = {}) {
  const env = process.env.DSH_PAGE_RUNNER
  if (typeof config?.browserPath === 'string' && config.browserPath.length > 0) return config.browserPath
  if (env && existsSync(env)) return env
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  for (const p of [
    join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
    join(pf, 'Microsoft\\Edge\\Application\\msedge.exe'),
    join(pf86, 'Google\\Chrome\\Application\\chrome.exe'),
    join(pf86, 'Microsoft\\Edge\\Application\\msedge.exe'),
  ]) if (existsSync(p)) return p
  return ''
}

/** DOM 工具：剥离 style/script（无完整 HTML parser，#id/.class/tag 提取足够可靠）。 */
export function stripDomNoise(html) {
  let s = String(html || '')
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '\n')
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '\n')
  return s
}

export function extractTitle(html) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return m ? m[1].trim() : ''
}

/** #id / .class / tag 的首个匹配元素文本（≤4000 字符）。 */
export function extractSelectorText(html, selector) {
  const s = String(selector || '').trim()
  if (!s) return ''
  const src = String(html || '')
  const esc = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const innerOf = (startIdx, openLen, tagName) => {
    const rest = src.slice(startIdx + openLen)
    // 属性正则可能停在闭合 > 之前（id/class 为末属性时 match 不含 >，
    // rest 以 '>' 开头）；tag 模式 match 已含 '>'，rest 从标签体开始。
    const body = rest.startsWith('>') ? rest.slice(1) : rest
    const closer = body.match(new RegExp('</' + tagName + '\\s*>', 'i'))
    const end = closer ? closer.index + closer[0].length : body.length
    return (body.slice(0, end).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 4000)
  }
  if (s.startsWith('#')) {
    const re = new RegExp('<[a-z0-9]+[^>]*\\bid\\s*=\\s*["\']?' + esc(s.slice(1)) + '["\'\\s>]', 'i')
    const m = src.match(re)
    if (!m) return ''
    return innerOf(m.index, m[0].length, m[0].match(/<([a-z0-9]+)/i)?.[1] || 'div')
  }
  if (s.startsWith('.')) {
    const re = new RegExp('<[a-z0-9]+[^>]*\\bclass\\s*=\\s*["\'][^"\']*\\b' + esc(s.slice(1)) + '\\b[^"\']*["\']', 'i')
    const m = src.match(re)
    if (!m) return ''
    return innerOf(m.index, m[0].length, m[0].match(/<([a-z0-9]+)/i)?.[1] || 'div')
  }
  const tag = s.replace(/[^a-z0-9]/gi, '').toLowerCase()
  if (!tag) return ''
  const m = src.match(new RegExp('<' + esc(tag) + '[\\s>]', 'i'))
  if (!m) return ''
  return innerOf(m.index, m[0].length, tag)
}

/** Chrome --enable-logging=stderr 的 console/pageerror 行提取（去重、限 60 行）。 */
export function extractConsoleLines(stderrText) {
  const t = String(stderrText || '')
  const out = []
  const seen = new Set()
  const push = (line) => {
    const l = line.trim().slice(0, 320)
    if (!l || seen.has(l)) return
    seen.add(l)
    out.push(l)
  }
  for (const m of t.matchAll(/(?:INFO|ERROR|WARNING|WARN):CONSOLE\((\d+)\):?\s*([^\r\n]*)/gi)) push('console[' + m[1] + ']: ' + m[2])
  for (const m of t.matchAll(/(Uncaught[^\r\n]{0,240})/gi)) push(m[1])
  for (const m of t.matchAll(/((?:TypeError|ReferenceError|SyntaxError|RangeError)[^\r\n]{0,180})/gi)) push(m[1])
  return out.slice(0, 60).join('\n')
}

function safeStringify(v) {
  try { return JSON.stringify(v) ?? String(v) } catch { return String(v) }
}

/** 本地 JS 引擎：vm 隔离执行（语法检查 + 纯逻辑运行；顶层 return 即返回值）。 */
export function runSandboxJs(code) {
  const src = String(code || '').trim()
  if (!src) return { ok: true, output: '', error: '' }
  const logs = []
  const sandbox = {
    console: {
      log: (...a) => logs.push(a.map((x) => (typeof x === 'string' ? x : safeStringify(x))).join(' ')),
      error: (...a) => logs.push('ERR ' + a.map((x) => (typeof x === 'string' ? x : safeStringify(x))).join(' ')),
      warn: (...a) => logs.push('WARN ' + a.map((x) => (typeof x === 'string' ? x : safeStringify(x))).join(' ')),
    },
    JSON, Math, Date, Number, String, Boolean, Array, Object, RegExp, Map, Set,
    parseInt, parseFloat, isNaN, isFinite, NaN, Infinity,
  }
  try {
    const wrapped = '"use strict";\n(function(){\n' + src + '\n})()'
    const script = new vm.Script(wrapped, { filename: 'sandbox.js' })
    const value = script.runInNewContext(sandbox, { timeout: 5000 })
    const output = logs.join('\n')
    let tail = ''
    if (value !== undefined) tail = (output ? '\n' : '') + '=> ' + safeStringify(value)
    return { ok: true, output: (output + tail).slice(0, 4000), error: '' }
  } catch (e) {
    return { ok: false, output: logs.join('\n'), error: (e && e.message) || String(e) }
  }
}

/** URL 归一化：http(s)/file 原样；绝对盘符/根路径 → file://；相对路径 base = 会话工作区。 */
export function normalizePageUrl(raw, baseDir) {
  const u = String(raw || '').trim()
  if (/^https?:\/\//i.test(u)) return u
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return u
  if (/^file:/i.test(u)) {
    try { return new URL(u).href } catch { return u }
  }
  const abs = /^[a-zA-Z]:[\\/]/.test(u) || u.startsWith('/')
  const root = baseDir || process.cwd()
  try { return pathToFileURL(abs ? u : join(root, u)).href } catch { return u }
}

/** 统一失败形状（全分支同形，满足 additionalProperties:false 输出 schema）。 */
export function pageFail(message) {
  return {
    ok: false, exitCode: -1, timedOut: false, settleError: message,
    shot: '', domText: '', stderrTail: '', title: '', consoleTail: '', selectorText: '',
    jsOutput: '', jsError: '',
  }
}

/** 单飞锁 key：跨模块实例共享（本进程同时只跑一个页面检查）。 */
const PAGE_BUSY_KEY = Symbol.for('prompt-tool.pageCheckBusy')

/** win32 用 taskkill /F /T 按主 pid 杀整棵 chrome 树；POSIX kill -9 整组。fire-and-forget。 */
function forceTreeKill(ctx, pid) {
  if (!Number.isInteger(pid) || pid <= 0) return
  try {
    const sub = ctx?.get?.('subprocess')
    if (!sub || typeof sub.spawn !== 'function') return
    const isWin = process.platform === 'win32'
    sub.spawn({
      argv: isWin ? ['taskkill', '/F', '/T', '/PID', String(pid)] : ['kill', '-9', String(-pid)],
      cwd: process.cwd(),
      stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
      graceMs: 1000,
    })
  } catch { /* 兜底失败不阻塞 */ }
}

/** 单次执行体（无重试语义；参数与 pageCheckRun 相同）。 */
async function pageCheckRunOnce(ctx, args) {
  const chrome = pageRunnerPath()
  if (!chrome) return pageFail('no headless browser found (Chrome/Edge); set DSH_PAGE_RUNNER or config browserPath')
  const sessionCwd = (() => {
    try { return ctx?.get?.('agent')?.session?.header?.cwd || process.cwd() } catch { return process.cwd() }
  })()
  const url = normalizePageUrl(args?.url, sessionCwd)
  if (!/^(https?|file):/i.test(url)) return pageFail('url must be http(s):// / file:// / a path (auto-encoded)')
  const lite = args?.lite === true
  const timeoutMs = Math.min(180000, Math.max(1000, Math.floor(Number(args?.timeoutMs || (lite ? 30000 : 20000)))))
  const width = Math.min(4096, Math.max(320, Math.floor(Number(args?.width || (lite ? 960 : 1280)))))
  const height = Math.min(4096, Math.max(240, Math.floor(Number(args?.height || (lite ? 640 : 800)))))
  const domChars = Math.min(30000, Math.max(500, Math.floor(Number(args?.domChars || 8000))))
  const scale = Math.min(4, Math.max(1, Math.floor(Number(args?.scale || 1))))
  const cssSel = String(args?.selector || '').trim()
  // 截图写入会话工作区（模型可读）而非进程 cwd。
  const shotRoot = join(sessionCwd, '.dsh-shots')
  const shot = join(shotRoot, 'page-' + Date.now() + '.png')
  const profile = join(tmpdir(), 'dsh-page-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8))
  try { mkdirSync(profile, { recursive: true }) } catch { return pageFail('cannot create temp browser profile') }
  try { mkdirSync(shotRoot, { recursive: true }) } catch { /* chrome 会在写截图时给出可见错误 */ }
  const sub = ctx?.get?.('subprocess')
  if (!sub || typeof sub.spawn !== 'function') return pageFail('no subprocess service in scope')
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  let outcome
  let stdoutReader
  let stderrReader
  let settleError = ''
  let childPid = -1
  try {
    const handle = sub.spawn({
      argv: [
        chrome,
        // WebGL 修复：去 --disable-gpu + swiftshader 组合（黑图/超时根因，router v1.14 实测）。
        '--headless=new', '--no-first-run', '--no-default-browser-check',
        '--disable-dev-shm-usage', '--user-data-dir=' + profile,
        '--enable-logging=stderr',
        '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-application-cache',
        '--screenshot=' + shot,
        '--window-size=' + width + ',' + height,
        '--force-device-scale-factor=' + String(scale),
        '--virtual-time-budget=' + String(Math.min(30000, Math.max(500, Math.floor(Number(args?.virtualTimeMs || 8000))))),
        '--dump-dom',
        url,
      ],
      cwd: process.cwd(),
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 12 * 1024 * 1024, spill: { maxBytes: 16 * 1024 * 1024 } },
        stderr: { maxBytes: 1024 * 1024, spill: { maxBytes: 2 * 1024 * 1024 } },
      },
      graceMs: 2000,
      signal: ac.signal,
    })
    childPid = handle?.pid
    outcome = await handle.done
    stdoutReader = handle.collected?.stdout
    stderrReader = handle.collected?.stderr
  } catch (e) {
    settleError = (e && e.message) || String(e)
  } finally {
    clearTimeout(timer)
    // 无论成败都树杀（温和 kill 杀不死无窗口 chrome，孤儿进程累积根因）。
    forceTreeKill(ctx, childPid)
  }
  const timedOut = ac.signal.aborted
  const readTail = (reader, max) => {
    try {
      const r = reader?.readFrom?.(0)
      const t = (r && (r.text || '')) || ''
      return t.length > max ? t.slice(0, max) : t
    } catch { return '' }
  }
  const rawDom = readTail(stdoutReader, 8 * 1024 * 1024)
  const domText = stripDomNoise(rawDom).slice(0, domChars)
  const stderrFull = readTail(stderrReader, 1024 * 1024)
  const errTail = stderrFull.slice(0, 600).replace(/[\r\n]+/g, ' | ').trim()
  const consoleTail = extractConsoleLines(stderrFull)
  const selectorText = extractSelectorText(rawDom, cssSel)
  const exitCode = Number(outcome?.exitCode ?? outcome?.code ?? -1)
  const ok = !settleError && !timedOut && exitCode === 0 && domText.length > 0
  return {
    ok,
    exitCode: Number.isFinite(exitCode) ? exitCode : -1,
    timedOut,
    settleError: settleError || (!ok ? diagnosePageFail({ timedOut, exitCode, domText, errTail, shot, lite }) : ''),
    shot,
    domText,
    stderrTail: errTail,
    title: extractTitle(rawDom),
    consoleTail,
    selectorText,
    jsOutput: '',
    jsError: '',
  }
}

/** 失败诊断文案：原因 + 下一步（失败不静默）。 */
function diagnosePageFail(f) {
  const causes = []
  if (f.timedOut) causes.push('TIMEOUT (hard kill)')
  else if (f.exitCode === 0 && f.domText.length === 0) causes.push('exit 0 but empty DOM (page may not have loaded JS / --dump-dom raced)')
  else causes.push('exit=' + f.exitCode)
  if (!f.shot || !existsSync(f.shot)) causes.push('no screenshot artifact')
  else causes.push('screenshot at ' + f.shot)
  const stderr = String(f.errTail || '').replace(/\s+/g, ' ').slice(0, 200)
  let advice = 'Next steps: '
  advice += f.lite ? '' : '1) lite:true (960x640 single-frame, ~15s); '
  advice += '2) check the path (relative resolves to the session workspace); '
  advice += '3) external validator (python -m playwright screenshot ...) + read_image; '
  advice += '4) timeoutMs/virtualTimeMs bigger for heavy WebGL.'
  return causes.join('; ') + (stderr ? ' | stderr: ' + stderr : '') + ' | ' + advice
}

/** 页面验证执行体：{js:…} 直走本地引擎；否则 headless Chrome（单飞锁 + 可重试）。 */
export async function pageCheckRun(ctx, args) {
  if (args?.js !== undefined && args?.js !== null && String(args.js).trim() !== '') {
    const r = runSandboxJs(String(args.js))
    return {
      ok: r.ok, exitCode: r.ok ? 0 : -1, timedOut: false, settleError: '',
      shot: '', domText: '', stderrTail: '', title: '', consoleTail: '', selectorText: '',
      jsOutput: r.output, jsError: r.error,
    }
  }
  const busySlot = globalThis[PAGE_BUSY_KEY] ?? (globalThis[PAGE_BUSY_KEY] = { v: false, owner: '', at: 0 })
  if (busySlot.v) {
    if (Date.now() - busySlot.at > 10 * 60 * 1000) {
      busySlot.v = false
      busySlot.owner = ''
      busySlot.at = 0
    } else {
      return pageFail('another page-check is running (single-flight) since ' + new Date(busySlot.at || Date.now()).toISOString()
        + ' (owner: ' + (busySlot.owner || 'unknown') + '); retry after it settles')
    }
  }
  busySlot.v = true
  busySlot.owner = (() => { try { return ctx?.get?.('agent')?.session?.id || 'sess' } catch { return 'sess' } })()
  busySlot.at = Date.now()
  try {
    const first = await pageCheckRunOnce(ctx, args)
    if (first.ok) return first
    // 自动重试默认开启（重页首载偶发）；硬错误（settleError 且未超时）不重试，retry:false 可关。
    if (args?.retry === false || (first.settleError && !first.timedOut)) return first
    const boost = {
      ...args,
      width: Math.min(1024, Number(args?.width || 1280)),
      height: 640,
      scale: 1,
      virtualTimeMs: Math.min(60000, Math.floor(Number(args?.virtualTimeMs || 8000) * 2)),
      timeoutMs: Math.min(240000, Math.round(Number(args?.timeoutMs || 20000) * 1.5)),
    }
    return await pageCheckRunOnce(ctx, boost)
  } finally {
    busySlot.v = false
    busySlot.owner = ''
  }
}

function pageCheckRender(_args, v) {
  const head = Number.isFinite(v.exitCode) ? v.exitCode : -1
  let text = 'page-check: ' + (v.ok ? 'OK' : 'FAIL')
    + ' (exit=' + head + (v.timedOut ? ', TIMED OUT' : '') + (v.settleError ? ', ' + v.settleError : '') + ')\n'
  if (v.title) text += 'title: ' + v.title + '\n'
  if (v.selectorText) text += 'selector: ' + v.selectorText + '\n'
  if (v.consoleTail) text += '---- console/pageerror ----\n' + v.consoleTail + '\n'
  text += 'screenshot: ' + (v.shot || '') + '\n'
  if (v.stderrTail) text += 'stderr: ' + v.stderrTail + '\n'
  if (v.jsError) text += 'js-error: ' + v.jsError + '\n'
  if (v.jsOutput) text += '---- js output ----\n' + v.jsOutput + '\n'
  if (v.domText) text += '---- dom smoke ----\n' + v.domText.slice(0, 1500) + (v.domText.length > 1500 ? '\n…' : '') + '\n'
  return [{ type: 'text', text }]
}

/** Register the model-facing `page_check` tool. */
export function apply(ctx, config) {
  const source = validateConfig(name, config, ALLOWED_KEYS)
  const description = typeof source.description === 'string' && source.description.length > 0
    ? source.description
    : DEFAULT_DESCRIPTION
  const warnOnce = createWarnOnce(ctx, name)
  ctx.tools.register({
    name: 'page_check',
    description,
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL (http(s):// / file:// / path, relative resolves to the session workspace).' },
        js: { type: 'string', description: 'Local JS engine mode: syntax check + pure-logic run (no require/process/fs).' },
        selector: { type: 'string', description: 'Text of "#id" / ".class" / "tag" element to extract.' },
        lite: { type: 'boolean', description: 'Single-frame low-res mode for heavy pages (960x640).' },
        retry: { type: 'boolean', description: 'false = disable the automatic retry (default retries once).' },
        width: { type: 'integer', description: 'Viewport width (default 1280 / lite 960).' },
        height: { type: 'integer', description: 'Viewport height (default 800 / lite 640).' },
        scale: { type: 'integer', description: 'Device-scale factor 1-4 (default 1).' },
        domChars: { type: 'integer', description: 'DOM smoke chars (default 8000, max 30000).' },
        virtualTimeMs: { type: 'integer', description: 'Virtual time budget ms (default 8000).' },
        timeoutMs: { type: 'integer', description: 'Hard timeout ms (default 20000 / lite 30000).' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          exitCode: { type: 'integer' },
          timedOut: { type: 'boolean' },
          settleError: { type: 'string' },
          shot: { type: 'string' },
          domText: { type: 'string' },
          stderrTail: { type: 'string' },
          title: { type: 'string' },
          consoleTail: { type: 'string' },
          selectorText: { type: 'string' },
          jsOutput: { type: 'string' },
          jsError: { type: 'string' },
        },
        required: ['ok', 'exitCode', 'timedOut', 'settleError', 'shot', 'domText', 'stderrTail', 'title', 'consoleTail', 'selectorText', 'jsOutput', 'jsError'],
      },
      render: pageCheckRender,
    },
    async execute(args) {
      try {
        return await pageCheckRun(ctx, args ?? {})
      } catch (error) {
        warnOnce(`${name}: page_check failed, returning FAIL: ${String((error && error.message) || error)}`)
        return pageFail(String((error && error.message) || error))
      }
    },
  })
}
