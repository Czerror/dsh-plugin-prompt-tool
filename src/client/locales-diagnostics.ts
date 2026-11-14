export const DIAGNOSTIC_ZH = {
  'diagnostics.run': '诊断一次',
  'diagnostics.running': '诊断中…',
  'diagnostics.never': '尚未诊断',
  'diagnostics.ready': '最近诊断：{time}',
  'diagnostics.stale': '配置已变化，请重新诊断',
  'diagnostics.error': '诊断失败：{error}',
  'diagnostics.unavailable': '不可用规则：{count}',
  'diagnostics.dropped': '诊断账本已达上限，另有 {count} 次记录未保留。',
  'diagnostics.configs': '配置：{enabled}/{total}',
  'diagnostics.configsUnavailable': '配置数量不可用',
  'diagnostics.record': '命中 {hit} · 未命中 {miss} · 不可用 {unavailable} · 错误 {error}',
} as const

export const DIAGNOSTIC_EN: Record<keyof typeof DIAGNOSTIC_ZH, string> = {
  'diagnostics.run': 'Run diagnostics once',
  'diagnostics.running': 'Diagnosing…',
  'diagnostics.never': 'Not diagnosed yet',
  'diagnostics.ready': 'Last diagnostic: {time}',
  'diagnostics.stale': 'Configuration changed; run again',
  'diagnostics.error': 'Diagnostics failed: {error}',
  'diagnostics.unavailable': 'Unavailable rules: {count}',
  'diagnostics.dropped': 'Diagnostic ledger limit reached; {count} additional records were not retained.',
  'diagnostics.configs': 'Configurations: {enabled}/{total}',
  'diagnostics.configsUnavailable': 'Configuration count unavailable',
  'diagnostics.record': 'Hits {hit} · Misses {miss} · Unavailable {unavailable} · Errors {error}',
}
