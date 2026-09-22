/**
 * tool-config-engine — 自定义工具引擎（配置驱动 → ctx.tools.register）。
 *
 * 工具定义从 configsDir 目录加载（writePreset 渲染 custom-tools/*.yml，
 * 源 = preset.yml 顶层 customTools 段），每份一个工具定义：
 *   id / name / description / timeoutMs / parameters（标准 JSON Schema
 *   object，writePreset 已用官方 @deepseek-ai/dsh-tools 的
 *   parameterSchemaSpecToJsonSchema / valueSchemaSpecToJsonSchema 把
 *   preset.yml 的 dsh-tools DSL 转换）/ output.schema / execute.{kind, ...}
 *
 * 执行器（kind）：
 *   shell    — 命令执行（execFile 无 shell 解析，env 白名单，cwd=会话工作区）
 *   http     — fetch 请求（method/url/headers/body，{{args.x}} 插值）
 *   delegate — 委托已注册工具（经 ctx.tools.execute 的 nested dispatch 走
 *              完整官方管线：参数/输出校验、allow/deny/ask、pre/execute/post
 *              waterfall、timeout、nested token 与 durable result）
 *   fs       — 文件操作（read/write/append/list/delete，路径限定 cwd 内）
 *   ask-user — approval 通道询问用户（结果文本化）
 *
 * 安全：行 config.requireApproval = [kind...] 时该执行器先过 approval 门
 * （无 approval 服务则拒绝）；单条定义非法 warnOnce 跳过（不挂整行）。
 * 工具注册经 disposer 契约（keepDisposer），插件卸载自动撤销。
 *
 * ── 能力提供者边界（T4）────────────────────────────────────────────────────
 * 本模块是**能力提供者**，不是触发器。分类判据（与组合源 tool-config-engine.yml、
 * subagent-tool-policy.yml 及 test/engine/provider-boundary.test.mjs 同一份措辞）：
 *   - 会给模型提供可调用能力（注册工具 / 域 / 服务）的 → 能力提供者；
 *   - 干预流程（改提示词、改装配、裁决、追加）的 → 声明式触发器。
 * 因此本模块**不接入** engine/trigger.mjs：它不订阅装配 waterfall，也没有
 * when/do 声明，只在装配期把 preset.yml 的 customTools 段物化出的工具注册进官方
 * registry。强行并进触发器会让引擎同时承担「提供能力」与「干预流程」两种职责。
 *
 * 样板收敛：
 *   - 配置声明走 fields.mjs 的 `defineConfig`（未知键在挂载期 fail loud）；
 *   - 注册走 disposer 契约：单次注册用 shared.keepDisposer（register() 返回的正是
 *     它自己的 effect disposer）；需要整组原子回滚或定向撤销句柄时才用 ctx.effect；
 *   - 降级告警统一 `${name}: <what>; <fallback>` 一个前缀格式（见 provider-boundary 用例）。
 *
 * 登记入口：`engineProvider`（数据导出），供边界守卫消费。提供者登记与声明式触发器
 * 声明（约定为 `engineTriggers`）**互斥**，同一模块不得同时导出两者。
 *
 * 文件归属校正（PLAN T4）：第三个指定提供者 str-replace-editor 由
 * engine/compositions/source/local/filesystem-editor.yml:20 引用**官方**包
 * `@deepseek-ai/dsh-tool-str-replace-editor`，本仓库没有对应 `.mjs`；
 * engine/tool-git-bash.mjs 提供的是 `bash` 工具，**不是**第三个指定提供者。
 */

import { readFileSync, readdirSync, writeFileSync, appendFileSync, rmSync, statSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse as parseYaml } from './vendor/yaml/index.js'
import { importHostPackage } from './host-package.mjs'
import { validateDefinition } from './tool-definition.mjs'
import { defineConfig, passthrough } from './fields.mjs'
import { keepDisposer } from './shared.mjs'

const { ToolArgsError } = await importHostPackage('@deepseek-ai/dsh-tools')

/** Cordis 插件名，供 loader 诊断使用。 */
export const name = 'tool-config-engine'

export const inject = ['tools']

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

/**
 * 按 JSON Schema 子集校验参数值（引擎侧输入校验；官方 defineTool 的 validateArgs
 * 同样校验——registry 对裸 register 工具不校验参数，引擎自持保证"非法参数在执行前
 * 失败且实现不运行"）。object required/additionalProperties:false、array items、
 * scalar type/enum/const、oneOf 覆盖；annotation-only（无 type）视为任意 JSON。
 */
function validateJsonSchemaValue(schema, value) {
  const violations = []
  const walk = (node, value, path) => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      violations.push(path + ': invalid schema node')
      return
    }
    if (Array.isArray(node.oneOf)) {
      for (const branch of node.oneOf) {
        const before = violations.length
        walk(branch, value, path)
        if (violations.length === before) return
        violations.length = before
      }
      violations.push(path + ': does not match any oneOf branch')
      return
    }
    const type = node.type
    if (type === undefined) return // annotation-only = unconstrained
    const actualType = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value
    const matchesType = actualType === type
      || (type === 'integer' && actualType === 'number' && Number.isInteger(value))
    if (!matchesType) {
      violations.push(path + ': expected ' + type + ', got ' + actualType)
      return
    }
    if (node.enum !== undefined && !node.enum.some((item) => Object.is(item, value))) {
      violations.push(path + ': value not in enum')
    }
    if (node.const !== undefined && !Object.is(node.const, value)) {
      violations.push(path + ': value not equal to const')
    }
    if (type === 'array' && node.items !== undefined && Array.isArray(value)) {
      value.forEach((item, index) => walk(node.items, item, path + '[' + index + ']'))
    }
    if (type === 'object' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      if (Array.isArray(node.required)) {
        for (const key of node.required) {
          if (!(key in value)) violations.push(path + ': missing required property \"' + key + '\"')
        }
      }
      if (node.properties !== undefined && typeof node.properties === 'object' && !Array.isArray(node.properties)) {
        for (const [key, child] of Object.entries(node.properties)) {
          if (key in value) walk(child, value[key], path + '.' + key)
        }
      }
      if (node.additionalProperties === false && node.properties !== undefined) {
        for (const key of Object.keys(value)) {
          if (!(key in node.properties)) violations.push(path + ': unexpected property \"' + key + '\"')
        }
      }
    }
  }
  walk(schema, value, 'arguments')
  return violations
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

/** delegate args 映射：完整引用（{{args.x}}）透传原始类型（数组/数字/布尔不字符串化）；
 *  部分引用（前缀-{{args.x}}）插值为字符串；非插值值原样。 */
function mapDelegateArgs(execArgs, args) {
  const FULL_REF_RE = /^\{\{args\.([A-Za-z0-9_.]+)\}\}$/
  const mapValue = (value) => {
    if (Array.isArray(value)) return value.map(mapValue)
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, mapValue(child)]))
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
  return execArgs !== undefined && execArgs !== null && typeof execArgs === 'object'
    ? Object.fromEntries(Object.entries(execArgs).map(([key, value]) => [key, mapValue(value)]))
    : args
}

/** 执行器分发：返回成功值（registry 按 output.schema 校验）。 */
function createExecute(ctx, def, requireApproval) {
  const exec = def.execute
  return async (args, run) => {
    if (def.parameters !== undefined) {
      const violations = validateJsonSchemaValue(def.parameters, args)
      if (violations.length > 0) {
        throw new ToolArgsError(violations)
      }
    }
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
            ...(error === null ? {} : { error: String(error.message) }),
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
      const tools = ctx.tools ?? ctx.get('tools')
      if (tools === undefined || typeof tools.execute !== 'function') {
        return { ok: false, error: 'no tool runtime is available for delegate' }
      }
      const delegatedArgs = mapDelegateArgs(exec.args, args)
      // nested dispatch：走完整官方管线（校验/allow-deny-ask/pre-execute/post/
      // timeout/nested token/durable result），调用身份由外层 callId 稳定派生，
      // 禁止 Date.now() 生成调用身份。
      const result = await tools.execute({
        callId: `${run.callId}:delegate:${exec.tool}`,
        rootCallId: run.rootCallId,
        name: exec.tool,
        agent: run.agent,
        parent: run.token,
        arguments: delegatedArgs,
        signal: run.signal,
      })
      if (result.isError) {
        return { ok: false, error: String(result.error?.message ?? result.error ?? `delegated tool ${exec.tool} failed`) }
      }
      for (const context of result.additionalContexts ?? []) {
        run.deferContext(context)
      }
      if (result.concludesTurn === true) run.concludeTurn()
      return { ok: true, value: result.value }
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

/** 单份工具定义文件 → 编译为完整官方 ToolDefinition（不含 id）。
 *  parameters/output.schema 已是 writePreset 物化的标准 JSON Schema；无参数
 *  工具补空 object Schema（真实 ctx.tools.schemas() 需要 parameters 存在）。 */
function compileTool(ctx, def, requireApproval) {
  return {
    name: def.name,
    description: sanitizeDescription(def.description),
    parameters: def.parameters ?? { type: 'object', properties: {} },
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

/**
 * 配置契约：白名单由字段声明派生（此前没有白名单，未知键被静默忽略）。
 * requireApproval 迁移前对**非数组取 `[]`**、对数组**过滤掉非字符串项**（宽容而非报错），
 * configsDir 对非字符串/空串取默认值——两者都用 passthrough 保住该语义。
 * 本任务只新增「未知键报错」，缺键与错类型的既有行为逐字段不变。
 */
export const configContract = defineConfig({
  configsDir: passthrough((value) => (typeof value === 'string' && value.length > 0 ? value : './custom-tools')),
  requireApproval: passthrough((value) => (Array.isArray(value) ? value.filter((kind) => typeof kind === 'string') : [])),
})

/**
 * 能力提供者登记（T4 边界守卫的数据源）。
 * `provides.kind === 'dynamic'`：模型可见的工具名由 preset.yml 的 customTools 段在
 * 装配期决定（物化为 custom-tools/*.yml），引擎侧无法静态枚举——守卫只断言登记形状、
 * 注册通道，以及「提供者不导出触发器声明」这条互斥。
 */
export const engineProvider = {
  kind: 'provider',
  moduleId: name,
  registers: 'tools',
  provides: { kind: 'dynamic', source: 'preset.yml#customTools → custom-tools/*.yml' },
}

/** 插件入口：扫描 configsDir 注册全部自定义工具。 */
export function apply(ctx, config) {
  const { configsDir: dirName, requireApproval } = configContract.parse(config, name)
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
      // 注册走 disposer 契约：register() 返回的正是它自己的 effect disposer，
      // keepDisposer 把该 disposer 纳入本插件的资源所有权（卸载即撤销）。fiber 已卸载时
      // register() 内部先抛 INACTIVE_EFFECT（与改写前 ctx.effect 的前置断言同一错误），
      // 因此注册不会发生——降级语义与错误消息逐字不变。
      keepDisposer(ctx, ctx.tools.register(tool), `${name}: ${def.name}`)
      ctx.logger?.info(`${name}: registered custom tool ${def.name} (${def.execute.kind})`)
    } catch (error) {
      ctx.logger?.warn(`${name}: skipping tool ${JSON.stringify(def?.id ?? def?.name)}: ${error?.message ?? error}`)
    }
  }
}
