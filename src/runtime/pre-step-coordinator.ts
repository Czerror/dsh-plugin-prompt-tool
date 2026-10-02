/** 模块 pre-step 批执行与官方指令逐文件过滤；正文发现、读取和重注入归官方所有。 */
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { NamedEntries, ScopedLayers, scopeOf } from '@deepseek-ai/dsh-scope'
// @ts-expect-error 引擎 ESM 随插件打包。
import { createEpochPromotion } from '../../engine/compaction-epoch.mjs'
// @ts-expect-error 引擎 ESM 随插件打包。
import { PROMOTE_EVENTS, createWarnOnce } from '../../engine/shared.mjs'
// @ts-expect-error 引擎 ESM 随插件打包。
import { runPreStepBatch, confirmDelivered } from '../../engine/executor.mjs'
import { instructionFileIdFromDisplayPath } from '../host/agents-cards.ts'
import { instructionPolicyPath, readInstructionPolicy, resolveInstructionPolicy } from '../host/instructions-policy.ts'
import { filterOfficialInstructionMessages } from './official-instruction-filter.ts'

export const PRE_STEP_COORDINATOR_SERVICE = 'promptToolPreStep'
export const PRE_STEP_COORDINATOR_VERSION = 1
const WARN_LABEL = 'prompt-tool:pre-step-coordinator'
const MAX_TRACKED_OWNER_SESSIONS = 4096

export interface PreStepPromptConfig {
  id: string
  layer: string
  enabled?: boolean
  order: number
  position: string
  promotion: string
  audience: string | null
  modelScope: string
  role: string
  dedupe: string
  mergeMode: string
  sourceKind: string
  form?: string
  texts: string[]
  params: Record<string, unknown>
  variables: Record<string, unknown>
  identity: { field: 'plugin'; value: string }
  resolve: (input: Record<string, unknown>) => unknown
}

export interface PreStepSource {
  configs: readonly PreStepPromptConfig[]
  officialInstructions?: boolean
}

export interface PreStepCoordinatorOptions {
  policyFile?: string
  home?: string
}

export interface PreStepCoordinatorService {
  readonly version: number
  registerPreset(sourceCtx: Context, sourceId: string, source: PreStepSource): () => void
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
  const promotion = {
    main: createEpochPromotion(PROMOTE_EVENTS.either, { includeSubagents: false }),
    withSubagents: createEpochPromotion(PROMOTE_EVENTS.either, { includeSubagents: true }),
  }
  const memo = new Map<string, Set<string>>()
  const officialOwner = new Map<string, boolean>()
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
      const identity = source.baselineIdentity ?? (isRecord(baseline) ? baseline.source.baselineIdentity : undefined)
      let projectRoot: string | undefined
      if (cwd !== undefined && typeof identity === 'string') {
        try {
          const parsed: unknown = JSON.parse(identity)
          if (isRecord(parsed) && typeof parsed.projectRoot === 'string' && !parsed.projectRoot.includes('\0')) projectRoot = resolve(cwd, parsed.projectRoot)
        } catch {
          // 不猜新版本的身份编码；无法定位的项目文件原样放行。
        }
      }
      const id = instructionFileIdFromDisplayPath(path, projectRoot, options.home)
      return id !== undefined && !resolveInstructionPolicy(snapshot.policy, id).enabled
    })
    for (const diagnostic of result.diagnostics) warnOnce(`${WARN_LABEL}: ${diagnostic}`)
    return result.messages
  }

  ctx.on('session/event', (session: unknown, event: unknown) => {
    promotion.main.observe(session, event)
    promotion.withSubagents.observe(session, event)
    confirmDelivered(memo, session, event)
  })

  ctx.on('agent/pre-step', async (payload: unknown, next: () => Promise<PreStepDecision>) => {
    const decision = await next()
    if (!active || !isRecord(decision) || decision.kind === 'reject') return decision
    const agent = isRecord(payload) ? payload.agent : undefined
    const session = isRecord(agent) ? agent.session : undefined
    if (agent === undefined || session === undefined) return decision
    try {
      const scope = isRecord(agent) && agent.ctx !== undefined ? scopeOf(agent.ctx as Context) : undefined
      const sources = [...layers.merge(scope, (layer) => layer.entries).values()]
      const configs = sources.flatMap(source => source.configs).filter(config =>
        !config.id.startsWith('agents-file-') && config.sourceKind !== 'instruction-file')
      const sessionId = isRecord(session) && typeof session.id === 'string' ? session.id : undefined
      if (sessionId !== undefined) {
        if (officialOwner.size >= MAX_TRACKED_OWNER_SESSIONS) officialOwner.clear()
        if (sources.length > 0) officialOwner.set(sessionId, sources.some(source => source.officialInstructions === true))
        else officialOwner.delete(sessionId)
      }
      return configs.length === 0 ? decision
        : await runPreStepBatch({ ctx, agent, decision, configs, promotion, memo, warnOnce })
    } catch (error) {
      warnOnce(`${WARN_LABEL}: coordination failed, keeping decision: ${String((error as Error | undefined)?.message ?? error)}`)
      return decision
    }
  })
  // prepend 让官方普通监听器先生成消息，再在进入历史之前过滤；普通配置仍用原执行顺序。
  ctx.on('agent/pre-step', async (payload: unknown, next: () => Promise<PreStepDecision>) => {
    const decision = await next()
    if (!active || !isRecord(decision) || decision.kind === 'reject' || !Array.isArray(decision.messages)) return decision
    const messages = filterInstructions(isRecord(payload) ? payload.agent : undefined, decision.messages)
    return messages === decision.messages ? decision : { ...decision, messages: messages as typeof decision.messages }
  }, { prepend: true })

  ctx.effect(() => () => {
    active = false
    officialOwner.clear()
    memo.clear()
  })
  const service: PreStepCoordinatorService = {
    version: PRE_STEP_COORDINATOR_VERSION,
    filterInstructions,
    registerPreset(sourceCtx, sourceId, source) {
      const boundSource: PreStepSource = {
        ...source,
        configs: source.configs.map(config => ({ ...config, resolve: input => config.resolve({ ...input, ctx: sourceCtx }) })),
      }
      return layers.effect(sourceCtx, layer => {
        const previous = layer.undoes.get(sourceId)
        if (previous !== undefined) {
          warnOnce(`${WARN_LABEL}: pre-step source ${sourceId} re-registered in the same scope; the latest mount takes over`)
          layer.undoes.delete(sourceId)
          previous()
        }
        const undo = layer.entries.insert(sourceId, boundSource)
        layer.undoes.set(sourceId, undo)
        return () => {
          if (layer.undoes.get(sourceId) === undo) layer.undoes.delete(sourceId)
          undo()
        }
      }, { label: `prompt-tool: pre-step source ${sourceId}` })
    },
    officialOwnerOf: sessionId => officialOwner.get(sessionId),
  }
  ctx.provide(PRE_STEP_COORDINATOR_SERVICE, service)
  return service
}
