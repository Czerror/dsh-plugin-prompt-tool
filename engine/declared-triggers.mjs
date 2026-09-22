/**
 * declared-triggers — 声明式触发器的运行时（B7）。
 *
 * 链路：`preset.yml` 顶层 `triggers` 段 →（`writePreset` 保存期校验 + 物化）→ 预设根
 * `triggers.yml` → 本模块读入、编译、注册。
 *
 * ## 声明由预设提供，引擎不带默认（2026-09-22 拍板）
 *
 * 所以 `triggers.yml` 缺失 = **没有声明**，不是错误：不注册任何触发器，也不让预设启动失败
 * ——与 `subagent-tool-policy` 的 ENOENT 降级同一纪律。文件在但内容非法才是真错误：
 * fail loud（且保存期就会先被 `engine/trigger-spec.mjs` 拒一次，这里是第二道）。
 *
 * ## 为什么 `apply` 是 async
 *
 * `preset` 原语要在**挂载期一次**解析官方模块导出（判定期零 IO，见 `predicates.mjs` 的
 * 三条硬约束），而那是动态 import。async `apply` 有官方先例（`dsh-api-remotes`、
 * `dsh-client-connection`），本仓库此前没有——这是第一处。
 */
import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from './vendor/yaml/index.js'
import { defineConfig, passthrough } from './fields.mjs'
import { createWarnOnce, keepDisposer } from './shared.mjs'
import { compileDeclarations, mountDeclarations } from './trigger-spec.mjs'
import { loadStandingMountFor } from './predicates.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'declared-triggers'

/** 只经 `ctx.on`（动作注册）与 agent scope 的 tools 工作，无宿主服务依赖。 */
export const inject = []

export const configContract = defineConfig({
  triggersFile: passthrough((value) => (typeof value === 'string' && value.length > 0 ? value : '../triggers.yml')),
})

/**
 * 声明文件的路径：相对路径按**本模块**（`.engine/`）解析，所以 `../triggers.yml` = 预设根
 * ——与 `subagent-tool-policy` 的 `policyFile` 同一解析方式。
 *
 * 绝对路径必须走 `isAbsolute` 分支：`new URL(绝对路径, base)` 只在 POSIX 形态下忽略 base，
 * Windows 盘符会被当成 URL scheme 并抛 `ERR_INVALID_URL_SCHEME`。而「测试/嵌入可显式
 * 指定绝对路径」是本模块的契约（`loadStandingMountFor(entry)` 有同一约定）。
 */
function resolveTriggersFile(config) {
  const raw = typeof config?.triggersFile === 'string' && config.triggersFile.length > 0
    ? config.triggersFile
    : '../triggers.yml'
  if (isAbsolute(raw)) return raw
  return fileURLToPath(new URL(raw, import.meta.url))
}

/** 读声明；文件缺失返回 `undefined`（= 没有声明，交由调用方静默返回）。 */
function readTriggerSpecs(config) {
  let raw
  try {
    raw = readFileSync(resolveTriggersFile(config), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
  const parsed = parseYaml(raw, { logLevel: 'silent' })
  if (!Array.isArray(parsed)) {
    throw new TypeError(`${name}: triggers.yml must be a YAML array of trigger declarations`)
  }
  return parsed
}

export async function apply(ctx, config) {
  const source = configContract.parse(config, name)
  const specs = readTriggerSpecs(source)
  if (specs === undefined || specs.length === 0) return
  // `preset` 原语需要官方模块导出（判定期零 IO，故在这里一次解析）；其余原语用不到它。
  const standingMountFor = await loadStandingMountFor()
  // 声明非法在这里 fail loud——保存期已校验过一次，这里再炸说明文件被绕过保存手改了。
  const compiled = compileDeclarations(specs, { ctx, standingMountFor })
  const dispose = mountDeclarations(ctx, compiled, { plugin: name, warnOnce: createWarnOnce(ctx, name) })
  keepDisposer(ctx, dispose, `${name}: declarations`)
}
