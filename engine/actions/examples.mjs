export const ACTION_EXAMPLES = {
  'inject-text': { config: { id: 'notice', layer: 'pre-step', text: '' } },
  assembly: { target: {} },
  decision: { phase: 'pre', decision: 'allow' },
  'append-context': { mode: 'context', text: '' },
  guard: { mask: { deny: [] } },
  'sdk-strip': { mask: { deny: [] } },
  'request-params': { patch: {} },
  'inbox-prepend': { target: 'next-turn', text: '' },
  'pre-step-filter': { blockPlugins: [] },
}
