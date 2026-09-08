/**
 * persona 段名判定：官方新版把单段 `deployment:persona` 拆成
 * `deployment:persona-prefix` / `deployment:persona-suffix`，旧预设仍可能
 * 携带旧段名或裸名 `persona`；三处消费点共用一份集合，避免判定漂移。
 */
export const PERSONA_SECTION_NAMES: ReadonlySet<string> = new Set([
  'deployment:persona-prefix',
  'deployment:persona-suffix',
  'deployment:persona',
  'persona',
])

/** 段名是否为 persona 段（未知/非字符串一律 false）。 */
export function isPersonaSectionName(value: unknown): boolean {
  return typeof value === 'string' && PERSONA_SECTION_NAMES.has(value)
}
