export const ACTION_EXAMPLES = {
  'inject-text': { config: { id: 'notice', layer: 'pre-step', text: '' } },
  assembly: { target: {} },
  // 工具链拆成两个动作：pre 相的 tool-gate 与 post 相的 tool-result。种子取引擎缺省，
  // 中性值不替用户选业务值：`reason: ''` 与缺键同义，都落引擎缺省原因（用 `||`）。
  'tool-gate': { decision: 'allow', reason: '' },
  'tool-result': { action: 'accept', text: '' },
  'append-context': { text: '' },
  'stream-output': { mode: 'pass', text: '' },
  // 种子给一个合法名单：空名单无法表达「剔哪些工具」（createMask 会拒绝）。
  'tool-visibility': { deny: ['web_search'] },
  'request-params': { patch: {} },
  'inbox-prepend': { target: 'next-turn', text: '' },
  'pre-step-filter': { blockPlugins: [] },
}
