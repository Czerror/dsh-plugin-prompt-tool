/** 官方指令 owner 的公共事件替身；真实发行物在隔离 smoke 中另验。 */
/** @typedef {import('@deepseek-ai/dsh-agent').Agent} Agent */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
export const deliveries = new WeakMap()
export const failingBudgets = new Set()
export const name = 'fixture-official-instructions'
export const inject = ['agents']
/** @param {import('@deepseek-ai/cordis').Context} ctx @param {{maxBytes: number}} config */
export function apply(ctx, config) {
  if (failingBudgets.has(config.maxBytes)) throw new Error('LATE OFFICIAL INIT FAILURE')
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const result = await next()
    if (result.kind === 'reject') return result
    deliveries.set(agent, [...deliveries.get(agent) ?? [], config.maxBytes])
    return { ...result, messages: [...result.messages, createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `OFFICIAL INSTRUCTIONS ${config.maxBytes}` }] })] }
  })
}
