export const ACTION_EXAMPLES = {
  'inject-text': { config: { id: 'notice', layer: 'pre-step', text: '' } },
  assembly: { target: {} },
  // 工具裁决的种子取引擎既有缺省（`phase: 'pre'`、`decision: 'allow'`、`action: 'accept'`）；
  // `action` / `reason` / `text` 只在对方相生效（pre 读 decision，post 读 action），
  // 写成中性值不替用户选业务值。`toolNames` 必须是逗号分隔字符串：`parseToolNames` 只认字符串，
  // 数组会被解析成空 = 匹配所有工具，把定向门悄悄扩大成全工具门（同 schema.mjs 的层参数归一）。
  decision: { phase: 'pre', decision: 'allow', action: 'accept', reason: '', text: '', toolNames: '' },
  'append-context': { mode: 'context', text: '' },
  guard: { mask: { deny: [] } },
  'sdk-strip': { mask: { deny: [] } },
  'request-params': { patch: {} },
  'inbox-prepend': { target: 'next-turn', text: '' },
  'pre-step-filter': { blockPlugins: [] },
}
