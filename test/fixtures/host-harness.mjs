/**
 * host 分片共享 harness（2026-09-17 测试归一精简 B 档 / Wave 2）。
 *
 * 抽取依据：60 个 host 测试各自搭一套临时环境，仓库内累计 `mkdtemp` 190 次、
 * `rmSync` 238 次、`DSH_HOME` 150 次；其中 11 份 `fakeReq` 的签名互不兼容
 * （`fakeReq()` / `fakeReq(body)` / `fakeReq(body, overrides)` / `fakeReq(overrides)`），
 * 且多数文件只设置 DSH_HOME 而不还原，进程内其它用例会被污染。
 *
 * 本文件不参与用例发现（测试入口只收集 `test/` 下以 `.test.mjs` 结尾的文件），是纯 harness。
 *
 * 用法（**顺序要紧**：隔离 HOME 必须在动态 import 插件入口之前）：
 *
 *     import { isolatedHome, fakeReq, fakeRes, readBridge } from '../fixtures/host-harness.mjs'
 *     const { home, presetRoot } = isolatedHome('pt-xxx-')
 *     const { registerSettingsBridge } = await import('../../lib/index.mjs')
 *
 * 为什么不在这里包 `registerSettingsBridge`：现有测试对它的实参形态并不统一
 * （既有 `(ctx, ns, getModels, getSkills, getEngineStrategyDir)` 五参调用，
 * 也有省略 ns 的四参调用），统一实参等于改变被测行为；本 harness 只负责
 * handler 表、假请求/响应与载荷解析，注册实参留给各测试自己表达。
 */
import { after } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

/** 隔离 DSH_HOME：设置环境变量、登记 after() 还原并清理；返回常用子路径。 */
export function isolatedHome(prefix) {
  const home = mkdtempSync(join(tmpdir(), prefix))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  after(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  })
  return { home, presetRoot: join(home, '.agent-presets'), skillsRoot: join(home, 'skills') }
}

/** 临时目录：登记 after() 清理，返回绝对路径（不触碰 DSH_HOME）。 */
export function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/**
 * 假 loopback 请求：默认 POST + 127.0.0.1 + localhost，body 序列化为 JSON 流。
 * `body === undefined` 时给出空流（读取端点用）；`raw` 可传原始字符串（非法 JSON 用例）。
 */
export function fakeReq({ body, raw, method = 'POST', remoteAddress = '127.0.0.1', headers = {} } = {}) {
  const payload = raw ?? (body === undefined ? '' : JSON.stringify(body))
  const stream = Readable.from(payload.length === 0 ? [] : [Buffer.from(payload, 'utf8')])
  return Object.assign(stream, {
    method,
    socket: { remoteAddress },
    headers: {
      host: 'localhost',
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(payload)),
      ...headers,
    },
  })
}

/** 假响应：记录状态码与正文，供 `readBridge` 解析。 */
export function fakeRes() {
  let status = 0
  let body = ''
  return {
    writeHead(code) { status = code },
    end(payload) { body = payload ?? '' },
    get status() { return status },
    get body() { return body },
  }
}

/** 解析统一载荷 `{ ok, value } / { ok: false, code, message }`；非 JSON 时原样返回文本。 */
export function readBridge(res) {
  let parsed
  try {
    parsed = JSON.parse(res.body)
  } catch {
    return { status: res.status, ok: false, raw: res.body }
  }
  return {
    status: res.status,
    ok: parsed.ok === true,
    value: parsed.value,
    code: parsed.code,
    message: parsed.message,
  }
}

/** 收集 `ctx.webServer.register` 注册的端点：返回 handler 表与按路径取 handler 的辅助。 */
export function handlerTable() {
  const handlers = new Map()
  return {
    handlers,
    handler: (path) => handlers.get(path),
    register: ({ path, handler }) => { handlers.set(path, handler); return () => { handlers.delete(path) } },
  }
}

/** 字节快照 + 断言辅助：用于「零写盘 / 未修改」类断言，避免各文件各写一份。 */
export function fileBytes(path) {
  return readFileSync(path)
}

export function expectUnchanged(path, before) {
  return readFileSync(path).equals(before)
}
