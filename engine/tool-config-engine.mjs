/**
 * tool-config-engine — 自定义工具引擎（配置驱动 → ctx.tools.register）。
 *
 * 工具定义从 configsDir 目录加载（writePreset 渲染 custom-tools/*.yml，
 * 源 = preset.yml 顶层 customTools 段），每份一个工具定义：
 *   id / name / description / scope / timeoutMs / parameters（dsh-tools schema
 *   DSL 的 JSON 形态）/ output.schema / execute.{kind, ...}
 *
 * 执行器（kind）：
 *   shell    — 命令执行（execFile 无 shell 解析，env 白名单，cwd=会话工作区）
 *   http     — fetch 请求（method/url/headers/body，{{args.x}} 插值）
 *   delegate — 委托已注册工具（ctx.tools.get + 透传参数，高级用法：
 *              目标工具 execute 直接调用，不经 registry 校验管线）
 *   fs       — 文件操作（read/write/append/list/delete，路径限定 cwd 内）
 *   ask-user — approval 通道询问用户（结果文本化）
 *
 * 安全：行 config.requireApproval = [kind...] 时该执行器先过 approval 门
 * （无 approval 服务则拒绝）；单条定义非法 warnOnce 跳过（不挂整行）。
 * 工具注册经 ctx.effect，插件卸载自动撤销。
 */

import { readFileSync, readdirSync, writeFileSync, appendFileSync, rmSync, statSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse as parseYaml } from './vendor/yaml/index.js'

/** Cordis 插件名，供 loader 诊断使用。 */
export const name = 'tool-config-engine'

export const inject = ['tools']

/** 工具名规范（模型可见，schemas() 白名单要求）。 */
const TOOL_NAME_RE = /^[a-z][a-z0-9_]*$/

/** 合法参数节点类型（dsh-tools ValueSchemaSpec 的 type 枚举）。 */
const SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'array', 'object', 'json', 'oneOf'])

/** shell 执行器的 env 白名单（无凭据形态；与 run-code-env 同基调）。 */
const ENV_ALLOWLIST = [
  'PATH', 'PATHEXT', 'SystemRoot', 'COMSPEC', 'TEMP', 'TMP',
  'USERPROFILE', 'HOME', 'DSH_HOME', 'DSH_WORKSPACE', 'DSH_SESSION_ID',
]

/** 插值 {{args.x.y}} → 参数深取值（缺失保留字面）。 */
function interpolateArgs(text, args) {
  return String(text ?? '').replace(/\{\{args\.([A-Za-z0-9_.]+)\}\}/g, (_whole, path) => {
    let value = args
    for (const part of String(path).split('.')) {
      if (value === null || typeof value !== 'object') return _whole
      value = value[part]
    }
    return value === undefined || value === null ? _whole : String(value)
  })
}

/** 递归校验 schema 节点（宽松：type 枚举 + object 必须声明 additionalProperties + required 必须 true）。 */
function validateSchemaNode(node, path, seen) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    throw new TypeError(`${path} must be an object`)
  }
  if (seen.has(node)) throw new TypeError(`${path} is circular`)
  seen.add(node)
  try {
    if (typeof node.type !== 'string' || !SCHEMA_TYPES.has(node.type)) {
      throw new TypeError(`${path}.type must be one of ${[...SCHEMA_TYPES].join('/')}`)
    }
    if (node.type === 'object' && typeof node.additionalProperties !== 'boolean') {
      throw new TypeError(`${path}.additionalProperties must be explicitly true or false`)
    }
    if (node.required !== undefined && node.required !== true) {
      throw new TypeError(`${path}.required must be true when present`)
    }
    if (node.type === 'object' && node.properties !== undefined) {
      for (const [key, child] of Object.entries(node.properties)) {
        validateSchemaNode(child, `${path}.properties.${key}`, seen)
      }
    }
    if (node.type === 'array' && node.items !== undefined) {
      validateSchemaNode(node.items, `${path}.items`, seen)
    }
    if (node.type === 'oneOf' && Array.isArray(node.oneOf)) {
      if (node.oneOf.length < 2) throw new TypeError(`${path}.oneOf needs at least two branches`)
      for (const [index, branch] of node.oneOf.entries()) {
        validateSchemaNode(branch, `${path}.oneOf[${index}]`, seen)
      }
    }
  } finally {
    seen.delete(node)
  }
}

/** 工具定义轻校验（fail loud → 调用方 warnOnce 跳过该条）。 */
function validateDefinition(def) {
  if (def === null || typeof def !== 'object' || Array.isArray(def)) throw new TypeError('tool definition must be an object')
  if (typeof def.id !== 'string' || def.id.length === 0) throw new TypeError('tool definition needs a non-empty string id')
  if (typeof def.name !== 'string' || !TOOL_NAME_RE.test(def.name)) {
    throw new TypeError(`tool name ${JSON.stringify(def.name)} must match ${TOOL_NAME_RE}`)
  }
  if (typeof def.description !== 'string' || def.description.trim().length === 0) {
    throw new TypeError(`tool ${def.id}: description is required`)
  }
  if (def.parameters !== undefined) {
    if (def.parameters === null || typeof def.parameters !== 'object' || Array.isArray(def.parameters)) {
      throw new TypeError(`tool ${def.id}: parameters must be an object map`)
    }
    for (const [key, child] of Object.entries(def.parameters)) {
      validateSchemaNode(child, `parameters.${key}`, new Set())
    }
  }
  const output = def.output
  if (output === null || typeof output !== 'object' || Array.isArray(output)) {
    throw new TypeError(`tool ${def.id}: output is required`)
  }
  validateSchemaNode(output.schema, 'output.schema', new Set())
  const exec = def.execute
  if (exec === null || typeof exec !== 'object' || Array.isArray(exec)) {
    throw new TypeError(`tool ${def.id}: execute is required`)
  }
  if (typeof exec.kind !== 'string' || !['shell', 'http', 'delegate', 'fs', 'ask-user'].includes(exec.kind)) {
    throw new TypeError(`tool ${def.id}: execute.kind must be shell/http/delegate/fs/ask-user`)
  }
  if (exec.kind === 'shell' && (typeof exec.command !== 'string' || exec.command.trim().length === 0)) {
    throw new TypeError(`tool ${def.id}: execute.command is required for shell`)
  }
  if (exec.kind === 'http' && (typeof exec.url !== 'string' || exec.url.trim().length === 0)) {
    throw new TypeError(`tool ${def.id}: execute.url is required for http`)
  }
  if (exec.kind === 'delegate' && (typeof exec.tool !== 'string' || exec.tool.length === 0)) {
    throw new TypeError(`tool ${def.id}: execute.tool is required for delegate`)
  }
  if (exec.kind === 'fs' && (typeof exec.action !== 'string'
    || (!['read', 'write', 'append', 'list', 'delete'].includes(exec.action) && !exec.action.includes('{{args.')))) {
    throw new TypeError(`tool ${def.id}: execute.action must be read/write/append/list/delete (or {{args.*}} template) for fs`)
  }
  if (def.scope !== undefined && !['main', 'subagent', 'both'].includes(def.scope)) {
    throw new TypeError(`tool ${def.id}: scope must be main/subagent/both`)
  }
  if (def.enabled !== undefined && typeof def.enabled !== 'boolean') {
    throw new TypeError(`tool ${def.id}: enabled must be a boolean`)
  }
}

/** approval 门：requireApproval 含该 kind 时先请求批准；无 approval 服务拒绝。 */
async function approvalGate(ctx, exec, kind, reason) {
  const approval = ctx.get('approval')
  if (approval === undefined || typeof approval.request !== 'function') {
    return { ok: false, message: `tool ${exec.name} (${kind}) requires approval, but no approval channel is available` }
  }
  if (exec.agent === undefined) {
    return { ok: false, message: `tool ${exec.name} (${kind}) requires approval, but the call has no agent` }
  }
  const outcome = await approval.request({
    agent: exec.agent,
    toolName: exec.name,
    callId: exec.callId,
    reason,
    signal: exec.signal,
  })
  if (outcome === 'allowed-once') return { ok: true }
  return { ok: false, message: `approval for tool ${exec.name} was ${outcome}` }
}

/** cwd 内路径限定（防越界；resolve 后必须位于 cwd 之下）。 */
function withinCwd(cwd, target) {
  const resolved = resolve(cwd, target)
  const root = resolve(cwd)
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(`path ${JSON.stringify(target)} escapes the workspace`)
  }
  return resolved
}

/** 执行器分发：返回成功值（registry 按 output.schema 校验）。 */
function createExecute(ctx, def, requireApproval) {
  const exec = def.execute
  return async (args, run) => {
    if (requireApproval.includes(exec.kind)) {
      const gate = await approvalGate(ctx, run, exec.kind, `custom tool ${def.name} (${exec.kind})`)
      if (!gate.ok) return { ok: false, error: gate.message }
    }
    if (exec.kind === 'shell') {
      const command = interpolateArgs(exec.command, args)
      const cwd = run.agent?.session?.header?.cwd ?? process.cwd()
      const shell = exec.shell ?? (process.platform === 'win32' ? 'pwsh' : 'sh')
      // pwsh/powershell：重定向输出时强制 UTF-8（默认随控制台代码页，中文会乱码）。
      const psPrefix = '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new();$OutputEncoding=[System.Text.UTF8Encoding]::new();'
      const argv = shell === 'pwsh' ? ['-NoProfile', '-NonInteractive', '-Command', `${psPrefix}${command}`]
        : shell === 'powershell' ? ['-NoProfile', '-NonInteractive', '-Command', `${psPrefix}${command}`]
          : shell === 'cmd' ? ['/D', '/S', '/C', command]
            : ['-c', command]
      const env = { ...Object.fromEntries(ENV_ALLOWLIST.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]])), ...(exec.env ?? {}) }
      const output = await new Promise((resolvePromise) => {
        let killTimer
        const child = execFile(shell, argv, { cwd, env, windowsHide: true }, (error, stdout, stderr) => {
          clearTimeout(killTimer)
          resolvePromise({
            exitCode: error === null ? 0 : (typeof error.code === 'number' ? error.code : 1),
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            error: error === null ? undefined : String(error.message),
          })
        })
        const timeout = def.timeoutMs
        if (timeout !== undefined && Number.isSafeInteger(timeout) && timeout > 0) {
          killTimer = setTimeout(() => child.kill(), timeout)
        }
      })
      return output
    }
    if (exec.kind === 'http') {
      const url = interpolateArgs(exec.url, args)
      const headers = Object.fromEntries(Object.entries(exec.headers ?? {}).map(([key, value]) => [key, interpolateArgs(String(value), args)]))
      const rawBody = exec.body
      const body = rawBody === undefined ? undefined : JSON.stringify(JSON.parse(interpolateArgs(JSON.stringify(rawBody), args)))
      const timeout = def.timeoutMs ?? 15000
      const response = await fetch(url, {
        method: String(exec.method ?? 'GET').toUpperCase(),
        headers,
        ...(body !== undefined ? { body } : {}),
        signal: AbortSignal.timeout(timeout),
      })
      const text = await response.text()
      return { status: response.status, ok: response.ok, body: text }
    }
    if (exec.kind === 'delegate') {
      const tools = ctx.get('tools')
      const target = tools?.get?.(exec.tool)
      if (target === undefined || typeof target.execute !== 'function') {
        return { ok: false, error: `delegated tool ${exec.tool} is not registered` }
      }
      // 高级用法：透传参数直接调用目标 execute（不经 registry 校验管线）。
      // args 映射：完整引用（{{args.x}}）透传原始类型（数组/数字/布尔不字符串化）；
      // 部分引用（前缀-{{args.x}}）插值为字符串；非插值值原样。
      const FULL_REF_RE = /^\{\{args\.([A-Za-z0-9_.]+)\}\}$/
      const mapDelegateArg = (value) => {
        if (Array.isArray(value)) return value.map(mapDelegateArg)
        if (value !== null && typeof value === 'object') {
          return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, mapDelegateArg(child)]))
        }
        if (typeof value === 'string') {
          const ref = FULL_REF_RE.exec(value)
          if (ref !== null) {
            let resolved = args
            for (const part of ref[1].split('.')) {
              if (resolved === null || typeof resolved !== 'object') {
                resolved = undefined
                break
              }
              resolved = resolved[part]
            }
            return resolved === undefined ? value : resolved
          }
          return interpolateArgs(value, args)
        }
        return value
      }
      const delegatedArgs = exec.args !== undefined && exec.args !== null && typeof exec.args === 'object'
        ? Object.fromEntries(Object.entries(exec.args).map(([key, value]) => [key, mapDelegateArg(value)]))
        : args
      const minimalExec = {
        name: def.name,
        callId: `delegate-${def.name}-${Date.now().toString(36)}`,
        agent: run.agent,
        parent: run.parent,
        signal: run.signal,
        arguments: delegatedArgs,
        deferContext: () => {},
        concludeTurn: () => {},
      }
      try {
        return { ok: true, value: await target.execute(delegatedArgs, minimalExec) }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
    if (exec.kind === 'fs') {
      const cwd = run.agent?.session?.header?.cwd ?? process.cwd()
      try {
        const file = withinCwd(cwd, interpolateArgs(exec.path, args))
        const action = interpolateArgs(exec.action, args)
        if (action === 'read') {
          const raw = readFileSync(file, 'utf8')
          return { ok: true, content: raw }
        }
        if (action === 'write') {
          writeFileSync(file, interpolateArgs(String(exec.content ?? ''), args), 'utf8')
          return { ok: true, path: file }
        }
        if (action === 'append') {
          appendFileSync(file, interpolateArgs(String(exec.content ?? ''), args), 'utf8')
          return { ok: true, path: file }
        }
        if (action === 'list') {
          const entries = readdirSync(file, { withFileTypes: true }).map((entry) => entry.name)
          return { ok: true, entries }
        }
        if (action === 'delete') {
          const info = statSync(file)
          rmSync(file, { recursive: info.isDirectory(), force: true })
          return { ok: true, path: file }
        }
        return { ok: false, error: `unknown fs action ${action}` }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
    if (exec.kind === 'ask-user') {
      const approval = ctx.get('approval')
      if (approval === undefined || typeof approval.request !== 'function') {
        return { ok: false, error: 'no approval channel is available' }
      }
      if (run.agent === undefined) return { ok: false, error: 'no active agent for ask-user' }
      const outcome = await approval.request({
        agent: run.agent,
        toolName: def.name,
        callId: run.callId,
        reason: String(exec.question ?? `${def.name}: confirm?`),
        signal: run.signal,
      })
      return { ok: true, answer: outcome }
    }
    return { ok: false, error: `unknown execute kind ${exec.kind}` }
  }
}

/** 宿主 system-prompt 对 section 文本做 {{var}} 变量校验（变量名须匹配 [a-z][a-z0-9_]* 且已注册），
 *  工具 description 进入 tools:sdk 段；description 中的双花括号字面量会炸掉整轮提示词组装
 *  （malformed / unknown prompt variable reference）。把配对的 {{...}} 统一降级为单花括号
 *  示意（{...}），其余字面保留；不配对的 {{ 宿主按字面处理，无需处理。 */
function sanitizeDescription(text) {
  return text.replace(/\{\{([^{}]*)\}\}/g, '{$1}')
}

/** 单份工具定义文件 → 编译为 ToolDefinition 结构（不含 id）。 */
function compileTool(ctx, def, requireApproval) {
  return {
    name: def.name,
    description: sanitizeDescription(def.description),
    ...(def.parameters !== undefined && Object.keys(def.parameters).length > 0 ? { parameters: def.parameters } : {}),
    output: {
      schema: def.output.schema,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    ...(Number.isSafeInteger(def.timeoutMs) && def.timeoutMs > 0 ? { timeoutMs: def.timeoutMs } : {}),
    execute: createExecute(ctx, def, requireApproval),
  }
}

/** 工具定义文件加载（*.yml / *.json；与 prompt-config-engine configsDir 同构）。 */
function loadToolFiles(dirUrl) {
  const resolved = isAbsolute(dirUrl)
    ? pathToFileURL(dirUrl).href
    : dirUrl
  const dir = new URL(resolved.endsWith('/') ? resolved : `${resolved}/`, import.meta.url)
  const localDir = fileURLToPath(dir)
  // 相对 configsDir 只允许解析到引擎父目录（预设根）内：防组合行声明越界目录；
  // 绝对路径（显式配置/测试桩）保持允许。
  if (!isAbsolute(dirUrl)) {
    const presetRoot = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\\\/]$/, '')
    if (localDir !== presetRoot && !localDir.startsWith(presetRoot + sep)) {
      throw new Error(`${name}: configsDir ${JSON.stringify(dirUrl)} escapes preset root`)
    }
  }
  const files = readdirSync(localDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(ya?ml|json)$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
  const out = []
  for (const entry of files) {
    const raw = readFileSync(join(localDir, entry.name), 'utf8')
    const parsed = /\.json$/i.test(entry.name) ? JSON.parse(raw) : parseYaml(raw, { logLevel: 'silent' })
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) out.push(parsed)
  }
  return out
}

/** 插件入口：扫描 configsDir 注册全部自定义工具。 */
export function apply(ctx, config) {
  const dirName = typeof config?.configsDir === 'string' && config.configsDir.length > 0
    ? config.configsDir
    : './custom-tools'
  const requireApproval = Array.isArray(config?.requireApproval)
    ? config.requireApproval.filter((kind) => typeof kind === 'string')
    : []
  let definitions = []
  try {
    definitions = loadToolFiles(dirName)
  } catch (error) {
    ctx.logger?.warn(`${name}: cannot load ${dirName}: ${error?.message ?? error}`)
    return
  }
  for (const def of definitions) {
    try {
      validateDefinition(def)
      if (def.enabled === false) {
        ctx.logger?.info(`${name}: skipping disabled tool ${JSON.stringify(def.name)}`)
        continue
      }
      const tool = compileTool(ctx, def, requireApproval)
      ctx.effect(() => ctx.tools.register(tool), `${name}: ${def.name}`)
      ctx.logger?.info(`${name}: registered custom tool ${def.name} (${def.execute.kind})`)
    } catch (error) {
      ctx.logger?.warn(`${name}: skipping tool ${JSON.stringify(def?.id ?? def?.name)}: ${error?.message ?? error}`)
    }
  }
}
