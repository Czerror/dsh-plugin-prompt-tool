/**
 * code-presentation — 晋升后 Code Mode (PTC) wire 呈现。
 *
 * 从 tool-bootstrap 拆出的独立关注点：bootstrap 负责首轮工具目录窄化，
 * 本模块只负责晋升后把工具呈现切换为 Code Mode（单 run_code，由
 * tools.presentAs('code') 提供）。"只要 PTC 不要 bootstrap" = 组合只挂本行；
 * PTC+bootstrap = 同时挂两行（行序：tool-bootstrap 在前，本行在后）。
 *
 * 相位与 tool-bootstrap / context-gate 同源：epoch-aware promotion
 * （compaction-epoch.mjs）。晋升后（tool/call 或 assistant/message，按
 * promoteOn，默认 either）应用 Code Mode；compaction/end 释放（压缩后回到
 * 受控相位，重新晋升再应用）。
 *
 * SUBAGENTS: includeSubagents=false（默认）时子代理（delegationDepth > 0）
 * 首次请求即应用呈现（继承完整目录语义）；true 时子代理跟随主会话相位。
 *
 * Robustness: 应用/释放失败降级（绝不 brick 会话）；invalid config fail at
 * apply time，即 preset 挂载处可见可修。
 */

import { createEpochPromotion } from './compaction-epoch.mjs'
import { booleanOption, parsePromoteOn, validateConfig } from './shared.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'code-presentation'

/** 无 inject：监听器只在使用时触碰 ctx 服务（同 tool-bootstrap 纪律）。 */
export const inject = []

/** Every config key this plugin accepts — anything else is a typo. */
const ALLOWED_KEYS = new Set(['usePtcMode', 'includeSubagents', 'promoteOn'])

/** Register the post-promotion Code Mode presentation. */
export function apply(ctx, config) {
  const source = validateConfig(name, config, ALLOWED_KEYS)
  // 默认 false：PTC (Code Mode) 呈现是 opt-in，未声明 = 原生完整工具目录。
  const usePtcMode = booleanOption(name, source.usePtcMode, 'usePtcMode', false)
  if (!usePtcMode) return
  const includeSubagents = booleanOption(name, source.includeSubagents, 'includeSubagents', false)
  const promoteEvents = parsePromoteOn(name, source.promoteOn)
  const promotion = createEpochPromotion(promoteEvents, { includeSubagents })

  const presentationBySession = new WeakMap()
  const agentBySession = new WeakMap()
  const presentationState = (session) => {
    let state = presentationBySession.get(session)
    if (state === undefined) {
      state = { applied: false, disposer: undefined }
      presentationBySession.set(session, state)
    }
    return state
  }
  const applyCodePresentation = (agent) => {
    const session = agent?.session
    if (session === undefined) return
    const state = presentationState(session)
    if (state.applied) return
    const tools = agent.ctx?.tools
    if (tools === undefined || typeof tools.presentAs !== 'function') return
    state.disposer = tools.presentAs('code')
    state.applied = true
  }
  const releaseCodePresentation = (session) => {
    const state = presentationBySession.get(session)
    if (state === undefined) return
    if (typeof state.disposer === 'function') {
      try { state.disposer() } catch { /* never brick the session */ }
    }
    state.disposer = undefined
    state.applied = false
  }

  ctx.on('session/event', (session, event) => promotion.observe(session, event))
  ctx.on('session/event', (session, event) => {
    if (event.type === 'compaction/end') {
      releaseCodePresentation(session)
      return
    }
    if (event.type !== 'step/end' && event.type !== 'turn/end') return
    const agent = agentBySession.get(session)
    if (agent !== undefined && promotion.status(agent).promoted) applyCodePresentation(agent)
  })

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    // Downstream errors propagate untouched; only this filter's own logic is guarded.
    const assembled = await next()
    try {
      const agent = context.agent
      if (agent === undefined || agent.session === undefined) return assembled
      agentBySession.set(agent.session, agent)
      if ((agent.session?.header?.delegationDepth ?? 0) > 0 && !includeSubagents) {
        // 默认：子代理继承完整目录 → 直接应用呈现。
        applyCodePresentation(agent)
        return assembled
      }
      if (promotion.status(agent).promoted) applyCodePresentation(agent)
      return assembled
    } catch {
      // 呈现失败不阻断会话：保持原样。
      return assembled
    }
  })
}
