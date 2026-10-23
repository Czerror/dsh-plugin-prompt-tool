/** 模块 pre-step 批执行与官方指令逐文件过滤；正文发现、读取和重注入归官方所有。 */
import { statSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { NamedEntries, ScopedLayers, scopeOf } from '@deepseek-ai/dsh-scope'
import { createPromotionPool, type PromotionPool } from '../../engine/promotion-pool.mjs'
import { PROMOTE_EVENTS, createWarnOnce } from '../../engine/shared.mjs'
import { runPreStepBatch, confirmDelivered } from '../../engine/executor.mjs'
import type { PreStepPromotion, PreStepSource } from '../../engine/pre-step-source.mjs'
import { PRE_STEP_COORDINATOR_SERVICE } from '../../engine/service-names.mjs'
import { instructionFileIdentityOf, instructionPolicyPath, readInstructionPolicy, resolveInstructionPolicy } from '../host/instructions-policy.ts'
import { filterOfficialInstructionMessages } from './official-instruction-filter.ts'

export { PRE_STEP_COORDINATOR_SERVICE }
export const PRE_STEP_COORDINATOR_VERSION = 2
const WARN_LABEL = 'prompt-tool:pre-step-coordinator'

export type { PreStepSource }

export interface PreStepCoordinatorOptions {
  policyFile?: string
  home?: string
}

export interface PreStepCoordinatorService {
  readonly version: number
  /** 唯一 promotion owner：source 生产者与批执行共用这一份。 */
  readonly promotionPool: PromotionPool
  readonly promotion: PreStepPromotion
  registerPreset(sourceId: string, source: PreStepSource): () => void
  officialOwnerOf(sessionId: string): boolean | undefined
  /** hint 转换前也调用同一过滤器，保证监听器重挂顺序不让已关闭正文变成 hint。 */
  filterInstructions(agent: unknown, messages: unknown[]): unknown[]
}

interface SourceLayer {
  entries: NamedEntries<PreStepSource>
  undoes: Map<string, () => void>
  isEmpty(): boolean
}

const isRecord = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object'

/** 文件修改时重读；损坏策略不猜，报告诊断并保留官方原消息。 */
function createPolicyReader(policyFile?: string) {
  let cached: { stamp: string; snapshot: ReturnType<typeof readInstructionPolicy> } | undefined
  return () => {
    const path = policyFile ?? instructionPolicyPath()
    let stamp: string
    try {
      const info = statSync(path)
      stamp = `${path}:${info.mtimeMs}:${info.ctimeMs}:${info.size}`
    } catch {
      stamp = `${path}:missing`
    }
    if (cached?.stamp === stamp) return cached.snapshot
    const snapshot = readInstructionPolicy(path)
    cached = { stamp, snapshot }
    return snapshot
  }
}

export function installPreStepCoordinator(ctx: Context, options: PreStepCoordinatorOptions = {}): PreStepCoordinatorService {
  const layers = new ScopedLayers<SourceLayer>(() => {
    const entries = new NamedEntries<PreStepSource>((key) => new Error(`prompt-tool: duplicate pre-step source ${key}`))
    return { entries, undoes: new Map(), isEmpty: () => entries.isEmpty() }
  }, () => {})
  // 唯一 promotion owner：pool 自己订阅 session/event，source 生产者与批执行都复用它。
  const promotionPool = createPromotionPool(ctx)
  const promotion = {
    main: promotionPool.tracker(PROMOTE_EVENTS.either, { includeSubagents: false }),
    withSubagents: promotionPool.tracker(PROMOTE_EVENTS.either, { includeSubagents: true }),
  }
  const memo = new Map<string, Set<string>>()
  // 负责人事实：全仓没有生产者写 `officialInstructions: true`，协调器不再把「有规则来源」
  // 当成「官方未装配」上报（那是插件观察不到的否定事实）→ `officialOwnerOf` 恒为 undefined
  // → bridge 的 `observed ?? null` 上报 null；管线的整体去留见 ADR-0003。
  const warnOnce = createWarnOnce(ctx, WARN_LABEL)
  const readPolicy = createPolicyReader(options.policyFile)
  let active = true
  const filterInstructions = (agent: unknown, messages: unknown[]): unknown[] => {
    if (!active || !messages.some(message => isRecord(message) && message.source?.kind === 'agent-instructions')) return messages
    const snapshot = readPolicy()
    if (snapshot.error !== undefined) {
      warnOnce(`${WARN_LABEL}: ${snapshot.error}；已放行官方指令`)
      return messages
    }
    if (!Object.values(snapshot.policy.files).some(file => file.enabled === false)) return messages
    const session = isRecord(agent) ? agent.session : undefined
    const cwd = isRecord(session) && typeof session.header?.cwd === 'string' ? session.header.cwd : undefined
    let baseline = messages.findLast(message => isRecord(message) && message.source?.kind === 'agent-instructions' && message.source.baseline === true)
    if (baseline === undefined && isRecord(session) && typeof session.deriveMessages === 'function') {
      try {
        const visible = session.deriveMessages()
        if (Array.isArray(visible)) baseline = visible.findLast(message => isRecord(message) && message.source?.kind === 'agent-instructions' && message.source.baseline === true)
      } catch {
        warnOnce(`${WARN_LABEL}: 无法确认官方基线项目根，已放行身份不明的项目指令`)
      }
    }
    const result = filterOfficialInstructionMessages(messages, (path, source) => {
      const identity = instructionFileIdentityOf(path, {
        baselineIdentity: source.baselineIdentity,
        batchBaselineIdentity: isRecord(baseline) ? baseline.source.baselineIdentity : undefined,
        cwd,
        home: options.home,
      })
      if ('problem' in identity) {
        // 不猜新版本的身份编码：放行，但每种原因只告警一次，不再静默。
        warnOnce(`${WARN_LABEL}: 无法确认官方指令身份（${identity.problem}），已放行：${path}`, identity.problem)
        return false
      }
      return !resolveInstructionPolicy(snapshot.policy, identity.fileId).enabled
    })
    for (const diagnostic of result.diagnostics) warnOnce(`${WARN_LABEL}: ${diagnostic}`)
    return result.messages
  }

  ctx.on('session/event', (session: unknown, event: unknown) => {
    confirmDelivered(memo, session, event)
  })

  // prepend：必须在最外层。更内层的监听器（官方 dsh-tool-skill 的目录发布）是 `await next()`
  // 之后才 append messages，内层过滤时看不到它们；只有本监听器先拿到完整 decision 才删得掉。
  ctx.on('agent/pre-step', async (payload: unknown, next: () => Promise<PreStepDecision>) => {
    const decision = await next()
    if (!active || !isRecord(decision) || decision.kind === 'reject') return decision
    const agent = isRecord(payload) ? payload.agent : undefined
    const session = isRecord(agent) ? agent.session : undefined
    if (agent === undefined || session === undefined) return decision
    try {
      const scope = isRecord(agent) && agent.ctx !== undefined ? scopeOf(agent.ctx as Context) : undefined
      const sources = [...layers.merge(scope, (layer) => layer.entries).values()]
      // 只按旧生成卡的 id 前缀跳过；编译后的 sourceKind 恒带 `plugin:` 前缀（见 schema.mjs），
      // 声明 `instruction-file` 的用户配置照常注入。
      const filtered = sources.map(source => ({
        ...source,
        configs: source.configs.filter(config => !config.id.startsWith('agents-file-')),
      }))
      return await runPreStepBatch({
        sources: filtered,
        ctx, agent, payload, decision, memo, warnOnce,
      })
    } catch (error) {
      warnOnce(`${WARN_LABEL}: coordination failed, keeping decision: ${String((error as Error | undefined)?.message ?? error)}`)
      return decision
    }
  }, { prepend: true })
  // prepend 让官方普通监听器先生成消息，再在进入历史之前过滤；普通配置仍用原执行顺序。
  ctx.on('agent/pre-step', async (payload: unknown, next: () => Promise<PreStepDecision>) => {
    const decision = await next()
    if (!active || !isRecord(decision) || decision.kind === 'reject' || !Array.isArray(decision.messages)) return decision
    const messages = filterInstructions(isRecord(payload) ? payload.agent : undefined, decision.messages)
    return messages === decision.messages ? decision : { ...decision, messages: messages as typeof decision.messages }
  }, { prepend: true })

  ctx.effect(() => () => {
    active = false
    memo.clear()
    promotionPool.dispose()
  })
  const service: PreStepCoordinatorService = {
    version: PRE_STEP_COORDINATOR_VERSION,
    promotionPool,
    promotion,
    filterInstructions,
    registerPreset(sourceId, source) {
      if (source.configs.length > 0 || (source.ruleActions?.length ?? 0) > 0) {
        if (source.promotion !== undefined && source.promotion !== promotion) {
          throw new TypeError(`prompt-tool: pre-step source ${sourceId} must use the coordinator promotion owner`)
        }
        if (source.promotion === undefined) source = { ...source, promotion }
      }
      const sourceCtx = source.ctx as Context
      return layers.effect(sourceCtx, layer => {
        const previous = layer.undoes.get(sourceId)
        if (previous !== undefined) {
          warnOnce(`${WARN_LABEL}: pre-step source ${sourceId} re-registered in the same scope; the latest mount takes over`)
          layer.undoes.delete(sourceId)
          previous()
        }
        const undo = layer.entries.insert(sourceId, source)
        layer.undoes.set(sourceId, undo)
        return () => {
          if (layer.undoes.get(sourceId) === undo) layer.undoes.delete(sourceId)
          undo()
        }
      }, { label: `prompt-tool: pre-step source ${sourceId}` })
    },
    officialOwnerOf: () => undefined,
  }
  ctx.provide(PRE_STEP_COORDINATOR_SERVICE, service)
  return service
}
