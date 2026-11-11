/** 模块 pre-step 批执行与官方指令逐文件过滤；正文发现、读取和重注入归官方所有。 */
import { statSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { NamedEntries, ScopedLayers, scopeOf } from '@deepseek-ai/dsh-scope'
import { createPromotionPool, type PromotionPool } from '../../engine/promotion-pool.mjs'
import { PROMOTE_EVENTS, createWarnOnce } from '../../engine/shared.mjs'
import { runPreStepBatch, confirmDelivered } from '../../engine/executor.mjs'
import type { PreStepPromotion, PreStepSource } from '../../engine/pre-step-source.mjs'
import { composePreStepSources } from '../../engine/pre-step-source.mjs'
import { PRE_STEP_COORDINATOR_SERVICE } from '../../engine/service-names.mjs'
import { instructionFileIdentityOf, instructionPolicyPath, readInstructionPolicy, resolveInstructionPolicy } from '../host/instructions-policy.ts'
import { adaptOfficialInstructionIntros, filterOfficialInstructionMessages } from './official-instruction-filter.ts'
// 引擎条件求值器是 JS 运行时公共 owner；此处只消费其稳定帧与动作判定出口。
// @ts-expect-error engine .mjs has no declaration file
import { ruleFrame, actionMatches } from '../../engine/conditions/evaluation.mjs'

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
  filterInstructions(agent: unknown, messages: unknown[], payload?: unknown): unknown[]
  /** hint 与协调器共享本次 waterfall，最后一个调用退出后丢弃判定快照。 */
  withPreStep<T>(payload: unknown, run: () => Promise<T>): Promise<T>
  /** 当前真实 Agent 命中的局部指令关闭贡献；只读投影，不写共享策略。 */
  instructionPolicyOf(agent: unknown, messages?: unknown[]): Record<string, string[]> | undefined
}

interface SourceLayer {
  entries: NamedEntries<PreStepSource>
  undoes: Map<string, () => void>
  isEmpty(): boolean
}

interface InstructionPolicySnapshot {
  frame: any
  policy: Record<string, string[]>
  intro?: string
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
  const instructionCalls = new WeakMap<object, { agent: unknown; refs: number; evaluated: boolean; snapshot?: InstructionPolicySnapshot }>()
  const withPreStep = async <T>(payload: unknown, run: () => Promise<T>): Promise<T> => {
    if (!isRecord(payload)) return run()
    const call = instructionCalls.get(payload) ?? { agent: payload.agent, refs: 0, evaluated: false }
    instructionCalls.set(payload, call)
    call.refs += 1
    try { return await run() }
    finally { if (--call.refs === 0) instructionCalls.delete(payload) }
  }
  // 负责人事实：全仓没有生产者写 `officialInstructions: true`，协调器不再把「有规则来源」
  // 当成「官方未装配」上报（那是插件观察不到的否定事实）→ `officialOwnerOf` 恒为 undefined
  // → bridge 的 `observed ?? null` 上报 null；管线的整体去留见 ADR-0003。
  const warnOnce = createWarnOnce(ctx, WARN_LABEL)
  const readPolicy = createPolicyReader(options.policyFile)
  let active = true
  const instructionPolicySnapshotOf = (agent: unknown, messages: unknown[], reportOutcomes = false): InstructionPolicySnapshot | undefined => {
    try {
      const scope = isRecord(agent) && agent.ctx !== undefined ? scopeOf(agent.ctx as Context) : undefined
      if (scope === undefined) return undefined
      const sources = [...layers.merge(scope, (layer) => layer.entries).values()]
      const report = reportOutcomes ? composePreStepSources(sources).report : undefined
      const frame = ruleFrame('agent/pre-step', [{ agent, messages }], warnOnce, ctx, report)
      frame.frozenActionMatches = new Map<object, boolean>()
      const result = new Map<string, Set<string>>()
      let intro: string | undefined
      for (const source of sources) {
        for (const entry of (source.ruleActions ?? []) as Array<Record<string, any>>) {
          if (entry.kind !== 'instruction-policy' || !isRecord(entry.action)) continue
          let matched = false
          try { matched = actionMatches(entry, frame) }
          catch (error) {
            warnOnce(`${WARN_LABEL}: 指令策略动作 ${String(entry.id ?? '')} 判定失败，已放行：${String((error as Error)?.message ?? error)}`)
            frame.actionOutcomes.set(entry, 'error')
            try { report?.(entry.rule, 'agent/pre-step', 'error') } catch { /* 诊断不影响注入。 */ }
          }
          frame.frozenActionMatches.set(entry, matched)
          if (!matched) continue
          if (intro === undefined && typeof entry.action.intro === 'string') intro = entry.action.intro
          if (!Array.isArray(entry.action.fileIds)) continue
          const ruleId = typeof entry.rule?.id === 'string' ? entry.rule.id : String(entry.id ?? '')
          for (const fileId of entry.action.fileIds) {
            if (typeof fileId !== 'string' || fileId.length === 0) continue
            const rules = result.get(fileId) ?? new Set<string>()
            rules.add(ruleId)
            result.set(fileId, rules)
          }
        }
      }
      return {
        frame,
        policy: Object.fromEntries([...result.entries()].map(([fileId, rules]) => [fileId, [...rules]])),
        ...(intro === undefined ? {} : { intro }),
      }
    } catch (error) {
      warnOnce(`${WARN_LABEL}: 当前 Agent 指令策略判定失败，已放行：${String((error as Error)?.message ?? error)}`)
      return undefined
    }
  }
  const snapshotForCall = (agent: unknown, messages: unknown[], payload?: unknown): InstructionPolicySnapshot | undefined => {
    const call = isRecord(payload) ? instructionCalls.get(payload) : undefined
    if (call === undefined || call.agent !== agent) return instructionPolicySnapshotOf(agent, messages)
    if (!call.evaluated) {
      call.evaluated = true
      call.snapshot = instructionPolicySnapshotOf(agent, messages, true)
    }
    return call.snapshot
  }
  const filterInstructions = (agent: unknown, messages: unknown[], payload?: unknown): unknown[] => {
    if (!active || !messages.some(message => isRecord(message) && message.source?.kind === 'agent-instructions')) return messages
    const instructionSnapshot = snapshotForCall(agent, messages, payload)
    const snapshot = readPolicy()
    const localPolicy = instructionSnapshot?.policy ?? {}
    const localIntro = instructionSnapshot?.intro
    if (snapshot.error !== undefined) warnOnce(`${WARN_LABEL}: ${snapshot.error}；仅保留当前 Agent 的局部关闭贡献`)
    if (!Object.values(snapshot.policy.files).some(file => file.enabled === false) && Object.keys(localPolicy).length === 0 && localIntro === undefined) return messages
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
      return localPolicy[identity.fileId] !== undefined || !resolveInstructionPolicy(snapshot.policy, identity.fileId).enabled
    })
    for (const diagnostic of result.diagnostics) warnOnce(`${WARN_LABEL}: ${diagnostic}`)
    if (localIntro === undefined) return result.messages
    const introDiagnostics: string[] = []
    const adapted = adaptOfficialInstructionIntros(result.messages, () => localIntro, introDiagnostics)
    for (const diagnostic of introDiagnostics) warnOnce(`${WARN_LABEL}: ${diagnostic}`)
    return adapted
  }

  ctx.on('session/event', (session: unknown, event: unknown) => {
    confirmDelivered(memo, session, event)
  })

  // 一个 prepend 监听器显式排定「过滤官方指令 → 规则批」；官方监听器在 `await next()`
  // 之后才 append messages，所以先拿完整 decision、过滤，再交给 batch。
  ctx.on('agent/pre-step', (payload: unknown, next: () => Promise<PreStepDecision>) => withPreStep(payload, async () => {
    const decision = await next()
    if (!active || !isRecord(decision) || decision.kind === 'reject') return decision
    const agent = isRecord(payload) ? payload.agent : undefined
    const session = isRecord(agent) ? agent.session : undefined
    const messages = Array.isArray(decision.messages) ? decision.messages : undefined
    const instructionSnapshot = messages === undefined ? undefined : snapshotForCall(agent, messages, payload)
    let filteredMessages = messages
    try {
      filteredMessages = messages === undefined ? undefined : filterInstructions(agent, messages, payload) as typeof messages
    } catch (error) {
      warnOnce(`${WARN_LABEL}: instruction policy failed, keeping decision: ${String((error as Error)?.message ?? error)}`)
    }
    const filteredDecision = filteredMessages === undefined || filteredMessages === messages
      ? decision
      : { ...decision, messages: filteredMessages as typeof decision.messages }
    if (agent === undefined || session === undefined) return filteredDecision
    try {
      const scope = isRecord(agent) && agent.ctx !== undefined ? scopeOf(agent.ctx as Context) : undefined
      const sources = [...layers.merge(scope, (layer) => layer.entries).values()]
      // 只按旧生成卡的 id 前缀跳过；编译后的 sourceKind 恒带 `plugin:` 前缀（见 schema.mjs），
      // 声明 `instruction-file` 的用户配置照常注入。
      const filtered = sources.map(source => ({
        ...source,
        configs: source.configs.filter(config => !config.id.startsWith('agents-file-')),
      }))
      if (instructionSnapshot !== undefined) {
        const filteredFrame = ruleFrame('agent/pre-step', [{ ...(isRecord(payload) ? payload : {}), agent, messages: filteredDecision.messages ?? [] }], warnOnce, ctx)
        instructionSnapshot.frame.args = filteredFrame.args
        instructionSnapshot.frame.subject = filteredFrame.subject
        // Policy actions already consumed this frame; other rule actions must see fresh condition facts.
        instructionSnapshot.frame.decisions = new Map()
      }
      return await runPreStepBatch({
        sources: filtered,
        ctx, agent, payload, decision: filteredDecision, memo, warnOnce,
        ...(instructionSnapshot === undefined ? {} : { ruleFrame: instructionSnapshot.frame }),
      })
    } catch (error) {
      warnOnce(`${WARN_LABEL}: coordination failed, keeping decision: ${String((error as Error | undefined)?.message ?? error)}`)
      return filteredDecision
    }
  }), { prepend: true })

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
    withPreStep,
    instructionPolicyOf(agent, messages) {
      try {
        if (!active || !isRecord(agent) || agent.ctx === undefined || !agent.ctx.get?.(PRE_STEP_COORDINATOR_SERVICE)) return undefined
      } catch { return undefined }
      let sessionMessages = messages
      if (sessionMessages === undefined && isRecord(agent) && isRecord(agent.session) && typeof agent.session.deriveMessages === 'function') {
        try { sessionMessages = agent.session.deriveMessages() } catch { return undefined }
      }
      if (!Array.isArray(sessionMessages)) return undefined
      const result = instructionPolicySnapshotOf(agent, sessionMessages)
      return result?.policy
    },
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
