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
 *     const { home, moduleRoot } = isolatedHome('pt-xxx-')
 *     const { registerSettingsBridge } = await import('../../src/runtime/settings-bridge.ts')
 *
 * 为什么不在这里包 `registerSettingsBridge`：本文件被静态 import，包装会把「每个测试关心哪几个键」
 * 固化成第二份默认值清单，而 `test/` 下的 .mjs 不参与 typecheck——多写一个不存在的键也不会被发现。
 * 注册实参留给各测试自己表达。
 */
import { after } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { SETTINGS_BRIDGE_PREFIX } from '../../src/shared/bridge-contract.ts'

const { promptConfigToRule } = await import('../../src/host/rule-builder.ts')

/**
 * `then[0]` 的注入动作：转换器固定产出 `inject-text`，其 `config` 是搬过去的卡片载荷。
 * @typedef {import('../../src/shared/rules.ts').RuleAction & { config: Record<string, unknown> }} InjectAction
 */

/**
 * 夹具用扁平字段表达注入意图（`audience` / `modelScope` / `promotion`）。
 *
 * 生产的转换器只做搬运（ST 转换出口不再产生这些字段），意图在这里翻成现行规则语法：
 * 普通注入进规则级 `if`；`system-section` 的固定注册效果（`params.complete` /
 * `suppressRuntimeContext`）不吃规则条件，受众按引擎契约留在动作 config 上。
 *
 * @param {import('../../src/host/prompt-configs.ts').PromptConfigSpec} config
 * @returns {import('../../src/shared/rules.ts').RuleDefinition}
 */
export function fixtureRule(config) {
  const { audience, modelScope, promotion, ...rest } = config
  const rule = promptConfigToRule(rest)
  const layer = rest.layer ?? 'pre-step'
  if (layer === 'system-section' && (rest.params?.complete === true || rest.params?.suppressRuntimeContext === true)) {
    if (audience === undefined || audience === null) return rule
    // 转换器固定回一条注入动作；`inject.config` 是它搬过去的卡片载荷（RuleAction 的 Record 扩展面）。
    const [inject] = /** @type {[InjectAction]} */ (rule.then)
    return { ...rule, then: [{ ...inject, config: { ...inject.config, audience } }] }
  }
  const gates = []
  if (audience !== undefined && audience !== null) gates.push({ scope: { audience } })
  if (modelScope !== undefined && modelScope !== 'all') gates.push({ scope: { modelScope } })
  if (promotion !== undefined && promotion !== 'none') gates.push({ phase: { promoted: true, ...(promotion === 'include-subagents' ? { includeSubagents: true } : {}) } })
  return gates.length === 0 ? rule : { ...rule, if: gates.length === 1 ? gates[0] : { all: gates } }
}

/**
 * 隔离 DSH_HOME：设置环境变量、登记 after() 还原并清理；返回常用子路径。
 * @param {string} prefix
 */
export function isolatedHome(prefix) {
  const home = mkdtempSync(join(tmpdir(), prefix))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  after(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  })
  // 存储根的唯一真值源是 `src/host/paths.ts`（`storageRootOf(dshHome)` 纯函数；模块根 = 它的
  // `modules/` 子目录）。这里刻意不 import 它：本夹具被静态 import，内联拼接让「这次装到哪个 HOME」
  // 一眼可见。paths.ts 自 2026-10-16 起按调用求值，不再有 import 期冻结——设置 env 与调用之间的
  // 顺序因此不再是约束，夹具仍然先设、只为语义直白。
  return { home, moduleRoot: join(home, '.prompt-tool', 'modules'), skillsRoot: join(home, 'skills') }
}

/**
 * 临时目录：登记 after() 清理，返回绝对路径（不触碰 DSH_HOME）。
 * @param {string} prefix
 */
export function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/**
 * `fakeReq` 入参：请求体三态——`body` 走 JSON 序列化、`raw` 传原始串（非法 JSON 用例）、
 * 两者都缺省＝空流（读取端点用）。
 * @typedef {object} FakeReqInit
 * @property {unknown} [body]
 * @property {string} [raw]
 * @property {string} [method]
 * @property {string} [remoteAddress]
 * @property {Record<string, string>} [headers]
 */

/**
 * 假请求：真 Readable ＋ loopback 请求面（method / socket / headers）。
 * @typedef {Readable & { method: string, socket: { remoteAddress: string }, headers: Record<string, string> }} FakeReq
 */

/**
 * 假 loopback 请求：默认 POST + 127.0.0.1 + localhost，body 序列化为 JSON 流。
 * `body === undefined` 时给出空流（读取端点用）；`raw` 可传原始字符串（非法 JSON 用例）。
 * @param {FakeReqInit} [options]
 * @returns {FakeReq}
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

/**
 * 假响应：记录状态码与正文，供 `readBridge` 解析。
 * @typedef {{ writeHead: (code: number) => void, end: (payload?: string) => void, readonly status: number, readonly body: string }} FakeRes
 */

/** @returns {FakeRes} */
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

/**
 * 解析统一载荷 `{ ok, value } / { ok: false, code, message }`；非 JSON 时原样返回文本。
 * `value` 的形状由具体端点决定（`BridgeValueMap`），本夹具不假装知道——消费方自行收窄。
 * @param {FakeRes} res
 * @returns {{ status: number, ok: boolean, value?: unknown, code?: string, message?: string, raw?: string }}
 */
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

/**
 * 端点 handler 桩：按假 req/res 声明（假请求是真实 `IncomingMessage` 的部分形状）——接入真实类型时再收窄。
 * @typedef {(req: FakeReq, res: FakeRes) => Promise<void>} BridgeHandler
 */

/**
 * webServer 注册入参：只按 `path` 记表，`kind` 原样接受不解释。
 * @typedef {{ kind?: string, path: string, handler: BridgeHandler }} BridgeRoute
 */

/**
 * 收集 `ctx.webServer.register` 注册的端点：返回 handler 表与按路径取 handler 的辅助。
 * @returns {{ handlers: Map<string, BridgeHandler>, handler: (path: string) => BridgeHandler | undefined, register: (route: BridgeRoute) => () => void }}
 */
export function handlerTable() {
  const handlers = new Map()
  return {
    handlers,
    handler: (path) => handlers.get(path),
    register: ({ path, handler }) => { handlers.set(path, handler); return () => { handlers.delete(path) } },
  }
}

/**
 * 描述符快照元素：桥只读 `ns` / `value`，其余字段按端点自取。
 * @typedef {{ ns: string, value: unknown, base?: unknown, revision?: number }} SettingsDescriptor
 */

/**
 * 宿主注入作用域桩（`ctx.inject` 回调的入参）：只含桥用例真正用到的服务面。
 * @typedef {object} HostScope
 * @property {(name: string) => unknown} get
 * @property {{ describe: () => SettingsDescriptor[], mutate: (ns: string, ops: unknown[], expectedRevision?: number) => Promise<void> }} settings
 * @property {{ register: (route: BridgeRoute) => () => void }} webServer
 * @property {(fn: () => void | (() => void)) => void} effect
 */

/**
 * `makeHostContext` 的可覆写项；各文件只传差异项，其余走下面的默认值。
 * @typedef {object} HostContextOptions
 * @property {() => unknown} [get]
 * @property {() => SettingsDescriptor[]} [describe]
 * @property {(ns: string, ops: unknown[], expectedRevision?: number) => Promise<void>} [mutate]
 * @property {Record<string, unknown>} [value]
 * @property {(fn: () => void | (() => void)) => void} [effect]
 */

/**
 * 宿主 Context 桩：桥用例的共用脚手架（handlers ＋ settings ＋ webServer ＋ inject ＋ 一次调用）。
 *
 * 只放各文件真正共用的默认值；差异项（多 namespace 的 describe、晚到服务、带 disposer 的 effect）
 * 用选项覆盖，不在这里长成配置表。`wave1-safety`、`instructions-policy-endpoint`、
 * `instruction-scope-guard` 已迁到 src 直连；仍刻意**不**迁 `lib/index.mjs` 派系的
 * `module-prompt-configs`——它的 `loadPromptTemplates` 打的是构建产物的模板路径锚。
 *
 * @param {HostContextOptions} [options]
 */
export function makeHostContext(options = {}) {
  /** @type {Map<string, BridgeHandler>} */
  const handlers = new Map()
  /** @type {HostScope} */
  const sctx = {
    get: options.get ?? (() => undefined),
    settings: {
      describe: options.describe ?? (() => [{ ns: 'prompt-tool', value: options.value ?? {}, base: {} }]),
      mutate: options.mutate ?? (async () => {}),
    },
    webServer: { register: ({ path, handler }) => { handlers.set(path, handler); return () => { handlers.delete(path) } } },
    effect: options.effect ?? ((fn) => fn()),
  }
  /** @type {{ inject: (deps: string[], cb: (scope: HostScope) => void) => void }} */
  const ctx = { inject: (_deps, cb) => cb(sctx) }
  /**
   * 调一次桥端点：路径由共享前缀拼出，返回解析后的统一载荷（`{ status, ok, value, code, message }`）。
   * @param {string} endpoint
   * @param {unknown} [body]
   * @param {FakeReqInit} [overrides]
   */
  const call = async (endpoint, body = {}, overrides = {}) => {
    const handler = handlers.get(SETTINGS_BRIDGE_PREFIX + endpoint)
    if (handler === undefined) throw new Error(`端点未注册：${endpoint}`)
    const res = fakeRes()
    await handler(fakeReq({ body, ...overrides }), res)
    return readBridge(res)
  }
  return { ctx, handlers, call }
}

/**
 * 字节快照 + 断言辅助：用于「零写盘 / 未修改」类断言，避免各文件各写一份。
 * @param {string} path
 * @returns {Buffer}
 */
export function fileBytes(path) {
  return readFileSync(path)
}

/**
 * @param {string} path
 * @param {Buffer} before
 * @returns {boolean}
 */
export function expectUnchanged(path, before) {
  return readFileSync(path).equals(before)
}
