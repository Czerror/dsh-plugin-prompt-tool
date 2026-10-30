/** 仅观测实际会话的请求压力；不执行压缩、模型调用或维护唤醒。 */
interface PressureAgent { session: { requestHeader(): { config: { provider: string; model: string } } | undefined; requestContext(): { provider: string; model: string; contextWindow?: number } | undefined } }
interface PressureContext { get(name: 'tokenMeter'): unknown }
interface PressureMeter { measure(session: PressureAgent['session']): { totalTokens: number } }
export type SoulPressure = { state: 'unknown'; observedAt: string; reason: string } | { state: 'known'; observedAt: string; tokens: number; capacity: number; ratio: number; level: 'normal' | 'organize' | 'persist' | 'urgent'; source: string; guidance: string }

export function readSoulPressure(ctx: PressureContext, agent: PressureAgent, thresholds: readonly number[]): SoulPressure {
  if (thresholds.length !== 3 || thresholds.some((value, i) => !Number.isFinite(value) || value <= 0 || value >= 1 || i > 0 && value <= thresholds[i - 1]!)) throw new Error('SOUL水位阈值必须为三个递增的0–1比例')
  const observedAt = new Date().toISOString()
  try {
    const header = agent.session.requestHeader(), route = agent.session.requestContext()
    if (!header || !route || header.config.provider !== route.provider || header.config.model !== route.model) return { state: 'unknown' as const, observedAt, reason: '当前请求缺少匹配的模型窗口事实' }
    const capacity = route.contextWindow
    if (!Number.isSafeInteger(capacity) || capacity! <= 0) return { state: 'unknown' as const, observedAt, reason: '当前模型窗口未知' }
    const meter = ctx.get('tokenMeter') as PressureMeter | undefined
    if (!meter || typeof meter.measure !== 'function') return { state: 'unknown' as const, observedAt, reason: 'tokenMeter不可用' }
    const tokens = meter.measure(agent.session).totalTokens
    if (!Number.isSafeInteger(tokens) || tokens < 0) return { state: 'unknown' as const, observedAt, reason: '压力测量无效' }
    const ratio = tokens / capacity!
    const level = ratio >= thresholds[2]! ? 'urgent' : ratio >= thresholds[1]! ? 'persist' : ratio >= thresholds[0]! ? 'organize' : 'normal'
    return { state: 'known' as const, observedAt, tokens, capacity: capacity!, ratio, level, source: 'tokenMeter.measure + session.requestContext',
      guidance: level === 'urgent' ? '优先落盘未结与关键依据，再整理上下文' : level === 'persist' ? '先落盘关键事实与承诺' : level === 'organize' ? '可开始整理上下文与未结事项' : '当前低于提示阈值' }
  } catch { return { state: 'unknown' as const, observedAt, reason: '当前会话压力不可测量' } }
}
