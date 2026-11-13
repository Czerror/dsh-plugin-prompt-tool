import { labelOf } from './shared.mjs'
import { subjectOf } from '../conditions/subject.mjs'
import { loadTemplate } from '../schema.mjs'
import { claimRequest, refusalRetryStream } from '../refusal-retry.mjs'

/** `request-retry.text` / `templateFile` 归一：模板正文优先，缺模板时用内联正文。 */
function retryTextOf(action, plugin, promptConfigOptions) {
  const label = labelOf(action)
  if (action.text !== undefined && typeof action.text !== 'string') throw new TypeError(`${plugin}: ${label}.text must be a string`)
  if (action.templateFile !== undefined && typeof action.templateFile !== 'string') throw new TypeError(`${plugin}: ${label}.templateFile must be a string`)
  if (action.templateFile === undefined) return action.text ?? ''
  // 与 inject-text 同一模板解析：相对模块目录、越界（preset root 之外）与不可读在挂载期 fail loud。
  const load = typeof promptConfigOptions?.loadTemplate === 'function' ? promptConfigOptions.loadTemplate : loadTemplate
  const template = load(action.templateFile, promptConfigOptions?.templateBaseUrl, promptConfigOptions?.templateModuleRoot)
  const fromTemplate = typeof template?.text === 'string' ? template.text : ''
  return fromTemplate.length > 0 ? fromTemplate : (action.text ?? '')
}

async function* retryThrough(llm, options, retryText) {
  // 只追加尾部 user 正文：不改原 messages 元素、不改 durable 历史、不新增用户轮。
  const retryOptions = { ...options, messages: [...options.messages, { role: 'user', content: [{ type: 'text', text: retryText }] }] }
  claimRequest(retryOptions)
  yield* llm.stream(retryOptions)
}

/**
 * 同一挂载 scope 的重试正文：同值共存（多来源命中仍只共享一次额度），异值拒绝后到候选
 * 并保留先到的有效装配。键是挂载 scope 的 ctx —— 一个真实 Agent 一份，不跨 Agent 串用。
 */
const retryTexts = new WeakMap()

function claimRetryText(scope, label, text, plugin, warnOnce) {
  const current = retryTexts.get(scope) ?? new Map()
  for (const [other, existing] of current) {
    if (existing === text) continue
    warnOnce(`${plugin}: request-retry ${label} conflicts with ${other} — 保留先到的重试正文，异值候选不注册`)
    return undefined
  }
  current.set(label, text)
  retryTexts.set(scope, current)
  return () => {
    current.delete(label)
    if (current.size === 0) retryTexts.delete(scope)
  }
}

export function prepareRequestRetry(action, plugin, promptConfigOptions) {
  const label = labelOf(action)
  const retryText = retryTextOf(action, plugin, promptConfigOptions)
  if (retryText.trim().length === 0) {
    throw new TypeError(`${plugin}: ${label} needs text or a non-empty templateFile — 空重试正文等于没有重试`)
  }
  return (ctx, { on, collect, take, warnOnce }) => {
    const release = claimRetryText(ctx, label, retryText, plugin, warnOnce)
    if (release === undefined) return
    collect(release)
    collect(on('llm/stream', (options, next) => {
      try {
        // 辅助调用（压缩、标题等）与已取消的请求不是原始请求：沿官方链返回，不重放。
        if (options?.purpose !== undefined || options?.signal?.aborted) return next()
        const agent = subjectOf('llm/stream', [options], warnOnce, ctx).agent
        if (!take({ agent })) return next()
        const llm = typeof ctx.get === 'function' ? ctx.get('llm') : ctx.llm
        // 同一原始请求只重放一次；缺官方 llm 服务时不认领、不改变请求。
        if (typeof llm?.stream !== 'function' || !claimRequest(options)) return next()
        return refusalRetryStream({ options, first: next(), warnOnce,
          retryStream: () => retryThrough(llm, options, retryText) })
      } catch (error) {
        warnOnce(`${plugin}: request-retry action ${label} failed: ${String(error?.message ?? error)}`)
        return next()
      }
    }))
  }
}
