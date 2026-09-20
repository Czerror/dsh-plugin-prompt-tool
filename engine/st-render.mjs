/** ST 模板变量帧：只求值显式导入的模板，不决定任何官方插入点的执行顺序。 */
import { createHash } from 'node:crypto'
import { renderStText } from './st-macros.mjs'
import { sessionVarsSnapshot } from './session-vars.mjs'
import { sessionEvents, isDelegated, matchesModel } from './shared.mjs'
import { stripUnresolvedRefs } from './interpolate.mjs'
import { isSuccessfulCompactionEnd } from './compaction-epoch.mjs'

function visible(config, agent) {
  if (config.enabled === false) return false
  const delegated = isDelegated(agent?.session)
  if (config.audience === 'main' && delegated) return false
  if (config.audience === 'subagent' && !delegated) return false
  return matchesModel(config.modelScope, agent?.options?.model)
}

/** 历史与尚未入库的真实输入使用同一消息身份；插件注入消息不触发第二次赋值。 */
function generationKey(session, pending) {
  const events = sessionEvents(session)
  // 宿主先 assemble/pre-step，之后才 append step/start；不能用 step/start 切帧。
  const boundary = events.findLast(event => event?.type === 'turn/start' || event?.type === 'step/end' || isSuccessfulCompactionEnd(event))
  if (boundary) return JSON.stringify([boundary.type, boundary.seq, boundary.data?.turn, boundary.data?.step])
  const seen = new Set()
  const hash = createHash('sha256')
  const add = (message, kind) => {
    if (!message || message.source?.plugin || (message.source?.kind && message.source.kind !== 'user')) return
    const value = JSON.stringify([kind, message.id ?? null, message.content ?? []])
    if (seen.has(value)) return
    seen.add(value)
    hash.update(value)
  }
  for (const event of events) {
    if (event?.type === 'user/message' || event?.type === 'assistant/message') {
      add(event.data?.message ?? event.data, event.type)
    } else if (event?.type === 'tool/call') hash.update(JSON.stringify([event.type, event.seq, event.data?.id]))
  }
  for (const message of pending) add(message, `${message.role ?? 'user'}/message`)
  return hash.digest('hex')
}

export function attachStRenderers(configs) {
  const claimed = new Set()
  const templates = configs.filter(config => {
    if (config.enabled === false) return false
    if (config.group !== undefined && config.exclusive === true) {
      if (claimed.has(config.group)) return false
      claimed.add(config.group)
    }
    return config.params?.stMacros === true
  })
  if (!templates.length) return configs
  // 状态只活在本次 mount 与会话对象的生命周期内；不持有会话 id 的无界全局 Map。
  const sessions = new WeakMap()
  const tokens = new WeakMap()
  for (const target of templates) {
    target.renderSt = (agent, messages = [], warn = () => {}, token, eligible) => {
      const session = agent?.session
      const cached = token && tokens.get(token)
      if (cached) {
        if (!visible(target, agent)) return ''
        if (!cached.text.has(target)) cached.evaluate(target)
        return cached.text.get(target) ?? ''
      }
      const manual = sessionVarsSnapshot(session)
      const generation = generationKey(session, messages)
      const key = `${generation}:${JSON.stringify(manual)}`
      const previous = session && sessions.get(session)
      let frame = previous
      if (!frame || frame.key !== key) {
        const initialLocal = { ...(previous?.generation === generation ? previous.initialLocal : previous?.local), ...manual }
        for (const key of Object.keys(previous?.manual ?? {})) if (!Object.hasOwn(manual, key)) delete initialLocal[key]
        const initialGlobal = { ...(previous?.generation === generation ? previous.initialGlobal : previous?.global) }
        frame = { key, generation, manual, initialLocal, initialGlobal, local: { ...initialLocal }, global: { ...initialGlobal }, text: new Map() }
        const evaluate = config => {
          try {
            const local = { ...frame.local }, global = { ...frame.global }
            const text = renderStText(config.texts.join('\n\n'), { variables: config.variables, local, global, session, sourceId: config.id, warn })
            const cleaned = stripUnresolvedRefs(text)
            if (cleaned.stripped.length) warn(`prompt-config-engine: ST 模板 ${config.id} 有 ${cleaned.stripped.length} 处未支持引用，已移除`)
            frame.local = local
            frame.global = global
            frame.text.set(config, cleaned.text)
          } catch (error) {
            frame.text.set(config, '')
            warn(`prompt-config-engine: ST 模板 ${config.id} 求值失败：${String(error?.message ?? error)}`)
          }
        }
        frame.evaluate = evaluate
        // 命中、晋升和去重受限的模板由执行器确认资格后才求值：`eligible` 是本批
        // 执行器判定的获准集合（含声明式条件），渲染器不复制判定；非执行器调用
        // （如 system-section 层）没有集合，退回「可见 + 无晋升约束」的保守判定。
        const approved = eligible === undefined
          ? (config) => visible(config, agent) && config.promotion === 'none'
          : (config) => eligible.has(config)
        for (const config of templates.filter(config => approved(config)
          && config.strategy === 'static' && config.dedupe === 'none')
          .sort((a, b) => a.order - b.order)) evaluate(config)
        if (session) sessions.set(session, frame)
      }
      if (token && typeof token === 'object') tokens.set(token, frame)
      if (!visible(target, agent)) return ''
      if (!frame.text.has(target)) frame.evaluate(target)
      return frame.text.get(target) ?? ''
    }
  }
  return configs
}
