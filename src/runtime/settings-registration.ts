/** settings namespace 幂等注册：注册丢失时的自愈入口（供 index.ts 与测试共用）。 */
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'

export interface SettingsRegistrationHooks<T> {
  /** 注册时的 composition base（每次尝试注册都取最新值）。 */
  base: () => T
  /** 注册成功后接线：setSource / watch / 初始 onChange。 */
  onRegistered: (scope: { get: () => T; watch: (callback: (next: T, prev: T) => void) => void }) => void
  /** 注册失败（schema 校验或重复注册竞态）时的日志出口。 */
  onError: (message: string) => void
}

/**
 * 确保 `ns` 已注册：已注册（describe 命中）直接返回 true；未注册时补注册。
 * 官方 installSettingsSection 的 inject 回调只在 settings 服务首次可用时跑一次，
 * settings 服务实例被替换（provider fiber reload）后注册丢失且不自动重建；
 * 本函数由 Web bridge 每次请求前调用兜底。
 */
export function ensureSettingsRegistered<T>(
  sctx: Context,
  ns: SettingsNamespace,
  schema: unknown,
  hooks: SettingsRegistrationHooks<T>,
): boolean {
  const already = sctx.settings.describe({ redactSecrets: true })
    .some((entry) => String(entry.ns) === String(ns))
  if (already) return true
  try {
    const scope = sctx.settings.register(ns, schema as never, { base: hooks.base() as never })
    hooks.onRegistered(scope as { get: () => T; watch: (callback: (next: T, prev: T) => void) => void })
    return true
  } catch (error) {
    hooks.onError(error instanceof Error ? error.message : String(error))
    return false
  }
}
