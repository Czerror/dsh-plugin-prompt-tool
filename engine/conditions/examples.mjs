export const PREDICATE_EXAMPLES = {
  text: { subject: 'userMessage', keys: ['keyword'] },
  phase: { promoted: false },
  source: { kind: 'user' },
  count: { of: 'tool-call', per: 'turn', min: 1 },
  names: { allow: ['bash'] },
  session: { type: 'user/message', present: false },
  preset: { presetId: 'preset-id' },
  scope: { audience: 'main', modelScope: 'all' },
  anchor: { keys: ['We'], fallbackAfter: 1 },
}
