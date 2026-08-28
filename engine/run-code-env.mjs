/**
 * run-code-env — prompt-tool 的 PTC 环境注入配置。
 *
 * 官方 Code Mode 的 worker 线程刻意以 `env: {}` 启动（比普通 shell 的
 * credential scrub 更严格），因此 run_code 程序里的 `process.env` 恒为空。
 * 本插件不试图推翻该安全设计，而是在每个 run_code 程序执行前注入一个
 * 冻结的 `env` 全局：
 *
 *   const env = Object.freeze(JSON.parse(<curated json>))
 *
 * `env` 的内容只来自三处，且全部经过白名单/敏感名过滤：
 *   1. 宿主 process.env 中列在 `envKeys` 里的键；
 *   2. `ctx.shellEnv` 受管快照（DSH_HOME / DSH_SESSION_ID / 插件贡献的 DSH_*）；
 *   3. 当前会话工作区（DSH_WORKSPACE）。
 *
 * 模型侧始终可写 `env.PATH`、`env.HOME`、`env.DSH_HOME` 等；不要读
 * `process.env`（恒为 {}）。本插件只在存在 run_code 传输的 scope 生效，
 * native 模式自动空转。
 */

import { validateConfig } from './shared.mjs'

/** Cordis 插件名，供 loader 诊断使用。 */
export const name = 'run-code-env'

/** Every config key this plugin accepts — anything else is a typo. */
const ALLOWED_KEYS = new Set(['enabled', 'envKeys'])

/** 需要 tools 视图与 systemPrompt 段。shellEnv 为机会型读取，不写进 inject。 */
export const inject = ['tools', 'systemPrompt']

/** 默认暴露的系统环境变量（无凭据形态）。 */
export const DEFAULT_ENV_KEYS = [
  'PATH',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'USERNAME',
  'COMPUTERNAME',
  'OS',
  'TEMP',
  'TMP',
  'SystemRoot',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'LOCALAPPDATA',
  'APPDATA',
]

/** 任何疑似凭据的名字一律不放行。 */
export const SENSITIVE_ENV_RE = /KEY|PASSWORD|SECRET|TOKEN/i

/** run_code 定义对象只 patch 一次（跨 HMR 安全）。 */
const PATCHED = new WeakSet()

/**
 * 校验 envKeys：非空字符串数组；缺省/空数组回退默认白名单。
 * 单个键为敏感名时在 buildEnv 阶段过滤，这里只校验形状。
 */
export function normalizeEnvKeys(value) {
  if (value === undefined) return [...DEFAULT_ENV_KEYS]
  if (!Array.isArray(value) || value.length === 0) return [...DEFAULT_ENV_KEYS]
  const keys = value.map((key) => (typeof key === 'string' ? key.trim() : ''))
    .filter((key) => key.length > 0)
  return keys.length > 0 ? [...new Set(keys)] : [...DEFAULT_ENV_KEYS]
}

/**
 * 在 process.env 里按平台语义查找一个键；Windows 大小写不敏感。
 * @param env - 宿主环境对象（通常是 process.env）
 * @param key - 期望键名
 */
function lookupEnv(env, key) {
  if (env === undefined || env === null) return undefined
  if (process.platform === 'win32') {
    const wanted = key.toUpperCase()
    const match = Object.keys(env).find((candidate) => candidate.toUpperCase() === wanted)
    return match === undefined ? undefined : env[match]
  }
  return env[key]
}

/**
 * 构造本次 run_code 注入的 env 对象。所有来源统一脱敏。
 * @param ctx - Cordis context（机会型读取 shellEnv）
 * @param keys - 白名单键
 * @param agent - 当前执行 agent（可空）
 */
export function buildEnv(ctx, keys, agent) {
  const env = {}
  const hostEnv = typeof process === 'undefined' ? undefined : process.env

  for (const key of keys) {
    if (SENSITIVE_ENV_RE.test(key)) continue
    const value = lookupEnv(hostEnv, key)
    if (value !== undefined && value !== null) env[key] = String(value)
  }

  // 受管 DSH_* 快照：shellEnv 不存在或 collect 失败时静默降级。
  try {
    const shellEnv = ctx?.get?.('shellEnv')
    if (shellEnv !== undefined && typeof shellEnv.collect === 'function') {
      const execution = agent === undefined ? {} : { agent }
      const managed = shellEnv.collect(execution) ?? {}
      for (const [key, value] of Object.entries(managed)) {
        if (typeof value === 'string' && !SENSITIVE_ENV_RE.test(key)) env[key] = value
      }
    }
  } catch {
    // shellEnv 缺失/失败只意味着没有受管变量，不阻断 PTC。
  }

  // DSH_HOME 兜底：启动器/宿主进程通常显式设置了 DSH_HOME（本机为
  // D:\AI\DeepSeek harness\.dsh）。shellEnv 不可用时退回到该值；shellEnv
  // 已给出受管值时这里不会覆盖。
  if (env.DSH_HOME === undefined) {
    const ambientHome = lookupEnv(hostEnv, 'DSH_HOME')
    if (ambientHome !== undefined && ambientHome !== null && !SENSITIVE_ENV_RE.test('DSH_HOME')) {
      env.DSH_HOME = String(ambientHome)
    }
  }

  const cwd = agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0 && !SENSITIVE_ENV_RE.test('DSH_WORKSPACE')) {
    env.DSH_WORKSPACE = cwd
  }

  return env
}

/** 生成注入前缀：JSON 双序列化后作为 JS 字符串字面量安全嵌入。 */
export function injectEnvPrefix(code, env) {
  const payload = JSON.stringify(env ?? {}) ?? '{}'
  const literal = JSON.stringify(payload)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
  return `const env = Object.freeze(JSON.parse(${literal}));\n${code}`
}

/** 渲染 PTC 提示段；native（无 run_code）返回空串。 */
function envSectionText(ctx, keys) {
  const names = [...keys]
    .filter((key) => !SENSITIVE_ENV_RE.test(key))
  const sample = names.includes('HOME') ? 'HOME' : names[0]
  return [
    '## run_code environment',
    '',
    'Inside every run_code program a frozen global `env` is available; `process.env` is always empty by design.',
    `Available keys: ${names.join(', ') || '(none)'}`,
    'Managed DSH_* facts (for example DSH_HOME, DSH_SESSION_ID) and DSH_WORKSPACE are also present when the harness provides them.',
    sample ? `Example: \`const home = env.${sample}\`` : 'Example: const cwd = env.DSH_WORKSPACE',
    'Read values from `env.*`; never try to read `process.env`.',
  ].join('\n')
}

/** 给 run_code 的 ToolDefinition 打补丁：execute 前注入 env 前缀。 */
export function patchRunCodeTool(tool, ctx, keys) {
  if (tool === undefined || tool.name !== 'run_code') return false
  if (PATCHED.has(tool)) return false
  PATCHED.add(tool)

  const originalExecute = tool.execute.bind(tool)
  tool.execute = async (rawArgs, exec) => {
    const args = rawArgs ?? {}
    const env = buildEnv(ctx, keys, exec?.agent)
    const code = injectEnvPrefix(typeof args.code === 'string' ? args.code : '', env)
    return originalExecute({ ...args, code }, exec)
  }
  return true
}

/** 注册 PTC env 注入：只在目标 scope 出现 run_code 时生效。 */
export function apply(ctx, config) {
  const source = validateConfig(name, config, ALLOWED_KEYS)
  const enabled = source.enabled !== false
  const keys = normalizeEnvKeys(source.envKeys)

  const tryPatch = (scope) => {
    if (!enabled) return
    try {
      patchRunCodeTool(ctx.tools.get('run_code', scope), ctx, keys)
    } catch {
      // run_code 尚未物化或 registry 不可用：下一次 assemble/execute 再试。
    }
  }

  // 动态工具变化后，新 scope 的 run_code transport 可能刚创建。
  ctx.on('tools/change', () => tryPatch())

  // 组装前先确保当前 scope 的 run_code 已 patch（此时 SDK 会引用它）。
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    tryPatch(context?.scope)
    return next()
  })

  // 第一条 run_code 调用是最终兜底：dispatch 前按调用 agent 补 patch。
  ctx.on('tools/execute', async (exec, next) => {
    if (enabled && exec?.name === 'run_code') tryPatch(exec.agent)
    return next()
  })

  if (enabled) {
    ctx.systemPrompt.section({
      name: 'tools:run-code-env',
      // alpha.1 官方 SDK 提示段固定在 5000；对齐保留在 per-tool 指导之后。
      order: 5000,
      text: (context) => {
        const schemas = ctx.tools.schemas(context?.scope)
        if (!Array.isArray(schemas) || !schemas.some((schema) => schema?.name === 'run_code')) return ''
        return envSectionText(ctx, keys)
      },
    })
  }
}
