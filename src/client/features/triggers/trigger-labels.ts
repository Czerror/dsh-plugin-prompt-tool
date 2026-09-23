import type { PromptToolLocaleKey, PromptToolTranslate } from '../../locales.ts'
import { TRIGGERS_ZH } from '../../locales-triggers.ts'

/** 内部协议名只作未知扩展的兜底；已知选项以本地化名称呈现。 */
export function triggerLabel(t: PromptToolTranslate, name: string): string {
  const key = `triggers.label.${name}` as PromptToolLocaleKey
  return Object.hasOwn(TRIGGERS_ZH, key) ? t(key) : name
}
