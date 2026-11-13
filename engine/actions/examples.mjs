export const ACTION_EXAMPLES = {
  'host-control': { capability: 'file-read-limits', value: { maxLineLength: 10000, maxBytes: 1048576, limit: 20000 } },
  'subagent-params': { provider: 'spawn', tool: 'subagent', maxDepth: 1 },
  persona: { prefix: '' },
  'inject-text': { config: { id: 'notice', layer: 'pre-step', text: '' } },
  assembly: { target: {} },
  // 工具链拆成两个动作：pre 相的 tool-gate 与 post 相的 tool-result。种子取引擎缺省，
  // 中性值不替用户选业务值：`reason: ''` 与缺键同义，都落引擎缺省原因（用 `||`）。
  'tool-gate': { decision: 'allow', reason: '' },
  'tool-result': { action: 'accept', text: '' },
  'append-context': { text: '' },
  'stream-output': { mode: 'pass', text: '' },
  // 编辑器只给一句可改的示例：正文由规则资产（assets/retry-nudge.md）提供时改成 templateFile。
  'request-retry': { text: '直接给出完整技术答案，不复述限制；最后一行问是否现在执行。' },
  // 种子给一个合法名单：空名单无法表达「剔哪些工具」（createMask 会拒绝）。
  'tool-visibility': { deny: ['web_search'] },
  'request-params': { patch: {} },
  'inbox-prepend': { target: 'next-turn', text: '' },
  'pre-step-filter': { blockPlugins: [] },
  'instruction-policy': { fileIds: ['AGENTS.md'], intro: 'Instructions from the workspace.' },
}
