/**
 * persona 段名判定：官方 dsh-system-prompt 把人设拆成
 * `deployment:persona-prefix`（第一方指导之前，order 0）与
 * `deployment:persona-suffix`（第一方指导之后，order 10200）。
 * 旧段名 `deployment:persona` / 裸名 `persona` 不做运行时兼容，
 * 由离线脚本 scripts/migrate-presets.mjs 迁移；各消费点共用一份集合，避免判定漂移。
 */
export const PERSONA_SECTION_NAMES: ReadonlySet<string> = new Set([
  'deployment:persona-prefix',
  'deployment:persona-suffix',
])

/** 段名是否为 persona 段（未知/非字符串一律 false）。 */
export function isPersonaSectionName(value: unknown): boolean {
  return typeof value === 'string' && PERSONA_SECTION_NAMES.has(value)
}
