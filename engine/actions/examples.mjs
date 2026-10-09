export const ACTION_EXAMPLES = {
  'inject-text': { config: { id: 'notice', layer: 'pre-step', text: '' } },
  assembly: { target: {} },
  // 工具裁决的种子取引擎既有缺省（`phase: 'pre'`、`decision: 'allow'`、`action: 'accept'`）；
  // `action` / `reason` / `text` 只在对方相生效（pre 读 decision，post 读 action），
  // 写成中性值不替用户选业务值。`toolNames` 的「匹配所有工具」是**空串或空数组**
  // （`shared.mjs#toolNameSet` 的 `names.size === 0` → `undefined`）；种子之外的两种形态都能
  // 解析成定向名单：字符串走 `parseToolNames`，数组直接进 `NAME_LIST.parse`（同 schema.mjs 的层参数归一）。
  decision: { phase: 'pre', decision: 'allow', action: 'accept', reason: '', text: '', toolNames: '' },
  'append-context': { mode: 'context', text: '' },
  guard: { mask: { deny: [] } },
  'sdk-strip': { mask: { deny: [] } },
  'request-params': { patch: {} },
  'inbox-prepend': { target: 'next-turn', text: '' },
  'pre-step-filter': { blockPlugins: [] },
}
