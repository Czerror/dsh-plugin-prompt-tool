import { labelOf } from './shared.mjs'
import { subjectOf } from '../conditions/subject.mjs'

async function* replacedStream(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
}

export function prepareStreamOutput(action, plugin) {
  const label = labelOf(action)
  const mode = action.mode ?? 'pass'
  if (!['pass', 'replace'].includes(mode)) throw new TypeError(`${plugin}: ${label}.mode must be pass or replace`)
  if (action.text !== undefined && typeof action.text !== 'string') throw new TypeError(`${plugin}: ${label}.text must be a string`)
  const text = action.text ?? ''
  return (ctx, { on, collect, take, warnOnce }) => collect(on('llm/stream', (options, next) => {
    if (mode !== 'replace' || text.length === 0) return next()
    try {
      const agent = subjectOf('llm/stream', [options], warnOnce, ctx).agent
      if (take({ agent })) return replacedStream(text)
    } catch (error) {
      warnOnce(`${plugin}: stream-output action ${label} failed: ${String(error?.message ?? error)}`)
    }
    return next()
  }))
}
