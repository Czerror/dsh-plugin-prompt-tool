/**
 * 桥端点的事务入口：一次请求的**边界**只在一个地方实现。
 *
 * `settings-bridge.ts` 此前 44 个注册点各自重写同一套事务——loopback 与 Origin 校验、
 * 只收 POST、32 MiB 上限、JSON 对象形状、`{ ok }` 信封；尾部那段注册块（只为拿
 * `agents`／`tools` 而单独 `ctx.inject`）甚至把校验原文抄了第二遍。结果是边界写在 N 处、
 * 拒绝路径却只在两个端点上被测。
 *
 * 本模块把事务收成单一接缝：注册点的 handler 只写业务判断。路径仍由调用方从
 * `BRIDGE_ENDPOINTS` 取，wire 形态（路径、状态码、载荷字段）逐字不变。
 *
 * **载荷语义不进事务**：单个字段的形状（如 sessionId 类型）与各端点自己的错误码由
 * handler 判，事务只回答「这条请求是不是合法 HTTP + 合法 JSON 对象」。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { MAX_BRIDGE_BODY_BYTES } from '../shared/bridge-contract.ts'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** 统一的 JSON 响应写出；桥的每条成功/失败载荷都经它落地。 */
export function writeBridgeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(payload)
}

/**
 * 仅允许本机回环请求，镜像官方 settings bridge 的边界。
 *
 * 官方把 `/api` 注册成 prefix 路由，本插件的 exact 路由先于它命中，因此**不经过**
 * 官方连接层的 Host/Origin 鉴权，必须自守。
 */
export function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = req.headers.host
  if (typeof host !== 'string') return false
  try {
    const hostname = new URL('http://' + host).hostname
    if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') return false
  } catch {
    return false
  }
  // 浏览器跨站盲请求（字符串 body 的 POST 是 CORS 简单请求，text/plain 不触发预检）
  // 可绕过上面的 socket/Host 检查直接到达本桥；校验 Origin 拦截跨站来源。
  // 非浏览器客户端（curl 等）不带 Origin，放行。
  // 完整校验 scheme/host/port：Origin 必须与本桥自身的 Host 头端口一致，
  // 防「本地其他端口服务」伪造 loopback hostname 跨站（仅比 hostname 不够）。
  const origin = req.headers.origin
  if (origin !== undefined) {
    try {
      const originUrl = new URL(origin)
      if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') return false
      const originHost = originUrl.hostname
      if (originHost !== '127.0.0.1' && originHost !== 'localhost' && originHost !== '[::1]') return false
      const originPort = originUrl.port.length > 0 ? originUrl.port : (originUrl.protocol === 'https:' ? '443' : '80')
      const hostUrl = new URL('http://' + host)
      const hostPort = hostUrl.port.length > 0 ? hostUrl.port : '80'
      if (originPort !== hostPort) return false
    } catch {
      return false
    }
  }
  return true
}

/** 读取 JSON bridge 请求体；所有 JSON 端点统一使用 32 MiB 内存上限。 */
export async function readBridgeBody(
  req: IncomingMessage,
): Promise<{ body: unknown; tooLarge: boolean; invalidJson: boolean; receivedBytes: number }> {
  const chunks: Buffer[] = []
  let size = 0
  let overflow = false
  for await (const chunk of req) {
    if (overflow) continue
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BRIDGE_BODY_BYTES) {
      // 超限：继续消费完请求流（保持连接可用），丢弃已收内容。
      overflow = true
      chunks.length = 0
      continue
    }
    chunks.push(buffer)
  }
  if (overflow) return { body: undefined, tooLarge: true, invalidJson: false, receivedBytes: size }
  if (size === 0) return { body: undefined, tooLarge: false, invalidJson: false, receivedBytes: 0 }
  try {
    return { body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown, tooLarge: false, invalidJson: false, receivedBytes: size }
  } catch {
    return { body: undefined, tooLarge: false, invalidJson: true, receivedBytes: size }
  }
}

export function writeBridgeBodyTooLarge(res: ServerResponse, receivedBytes: number): void {
  writeBridgeJson(res, 413, {
    ok: false,
    code: 'bridge-body-too-large',
    message: `请求载荷超过 ${Math.round(MAX_BRIDGE_BODY_BYTES / 1024 / 1024)}MB 上限（已收到 ${receivedBytes} 字节）`,
  })
}

/**
 * 读请求体并把三种失败直接写成响应，成功时返回 `{ body }`。
 * 返回 `undefined` 表示「事务已经结束」，调用方必须立即 return。
 */
export async function readBridgeBodyForHandler(req: IncomingMessage, res: ServerResponse): Promise<{ body: unknown } | undefined> {
  const result = await readBridgeBody(req)
  if (result.tooLarge) {
    writeBridgeBodyTooLarge(res, result.receivedBytes)
    return undefined
  }
  if (result.invalidJson) {
    writeBridgeJson(res, 400, { ok: false, code: 'bridge-request-invalid', message: 'malformed JSON body' })
    return undefined
  }
  if (result.body !== undefined && !isRecord(result.body)) {
    writeBridgeJson(res, 400, { ok: false, code: 'bridge-request-invalid', message: 'request body must be an object' })
    return undefined
  }
  return { body: result.body }
}

/**
 * 端点声明的请求体需求。
 *
 * - `required` / `optional`：解析 JSON 对象（空体得到 `{}`），字段形状由 handler 判。
 * - `none`：**不碰请求流**——这类端点要么只回固定应答，要么自己把 `tx.req` 当原始流消费
 *   （上传、原始文件流）。替它们排空流会把要读的数据吃掉。
 */
export type BridgeBodyMode = 'required' | 'optional' | 'none'

/** 已解析的请求：handler 需要的一切请求事实都在这里，不再回头碰 `req`/`res`。 */
export interface BridgeTransaction {
  /** 原始请求；只有读原始流与读自定义头时才需要。 */
  req: IncomingMessage
  /** 解析并校验过形状的请求体；`body: 'none'` 时为空对象。 */
  record: Record<string, unknown>
  /** 写出响应（信封由调用方组装，状态码由业务判断决定）。 */
  write(status: number, body: unknown): void
  /** 当前编辑目标目录（`x-module-id` 解析结果；未声明时由 host 回退）；每次调用重新解析。 */
  editDir(): string
}

export interface BridgeRouteSpec {
  body?: BridgeBodyMode
  handle(tx: BridgeTransaction): Promise<void> | void
}

export interface BridgeTransactionDeps {
  /**
   * 解析请求声明的编辑目标。**每次 `tx.editDir()` 都重新调用**，不做请求内缓存：
   * 「请求处理期间编辑目标被换掉就拒绝」这类判据依赖两次解析结果可能不同
   * （未声明 `x-module-id` 时解析的是**当前**编辑目标，一次请求处理期间它会变）。
   *
   * 返回空字符串表示「没有可用的模块目录」，由 handler 决定是否拒绝。
   */
  editDir(req: IncomingMessage): string
}

/**
 * 把一次请求跑完：边界 → 解析 → `handle(tx)` → 兜底。
 *
 * 顺序固定（loopback/Origin → 方法 → 体积 → JSON 对象），任一环节失败即结束事务，
 * handler 不会被调用。`handle` 抛错按 500 如实反馈；handler 一个字都没写也按 500 反馈
 * ——静默成功会变成客户端的「空响应」，那比报错更难查。
 */
export function bridgeTransaction(
  spec: BridgeRouteSpec,
  deps: BridgeTransactionDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const mode: BridgeBodyMode = spec.body ?? 'required'
  return async (req, res) => {
    if (!isLoopbackRequest(req)) {
      writeBridgeJson(res, 403, { ok: false, code: 'settings-not-exposed', message: 'loopback requests only' })
      return
    }
    if (req.method !== 'POST') {
      writeBridgeJson(res, 405, { ok: false, code: 'settings-not-exposed', message: 'method not allowed: ' + (req.method ?? '') })
      return
    }
    let record: Record<string, unknown> = {}
    if (mode !== 'none') {
      const parsed = await readBridgeBodyForHandler(req, res)
      if (parsed === undefined) return
      record = isRecord(parsed.body) ? parsed.body : {}
    }
    let handled = false
    const tx: BridgeTransaction = {
      req,
      record,
      write: (status, body) => { handled = true; writeBridgeJson(res, status, body) },
      editDir: () => deps.editDir(req),
    }
    try {
      await spec.handle(tx)
    } catch (error) {
      // handler 已经写过响应就不再补写（响应头已发出）。
      if (handled) return
      handled = true
      const message = error instanceof Error ? error.message : String(error)
      writeBridgeJson(res, 500, { ok: false, code: 'bridge-handler-failed', message })
      return
    }
    if (!handled) writeBridgeJson(res, 500, { ok: false, code: 'bridge-handler-silent', message: 'endpoint handler wrote no response' })
  }
}
