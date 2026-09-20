/**
 * pre-step 协调器：插件侧的薄装配层，用一个 pre-step 监听器统一执行两类来源。
 *
 *   - 预设来源：各预设 mount 的引擎行（prompt-config-engine）把配置注册到本服务，
 *     作用域与释放仍由注册 ctx（dsh-scope）决定——父/子 scope 继承、兄弟 scope 互不串；
 *   - 独立指令文件来源：本模块按会话工作区现场探测文件、读取独立策略
 *     （`$DSH_HOME/.prompt-tool/instructions.yml`）并编译成同样的提示词配置。
 *
 * 两类来源共用 engine/executor.mjs#runPreStepBatch 这一条批执行算法；本模块只负责
 * 「谁参战」与「参战顺序」：预设来源保留声明顺序，文件卡按全局→项目根→cwd 的探测
 * 顺序追加，最终仍按 order 排序、同值保持声明顺序。
 *
 * 文件版本可见状态（F4）：候选资格 = 文件可读 + 策略启用 + 该 (fileId, revision, epoch)
 * 身份在当前可见上下文里还没有同版本消息。可见性以 `session.deriveMessages()`（当前
 * 模型可见面）为准，缺失时回退「持久日志里最后一次成功 compaction/end 之后的消息」；
 * 因此压缩成功后同版本会重新注入一次，失败压缩不推进 epoch、不重复注入，重挂/恢复
 * 直接从持久记录重建，不依赖进程内已投递集合。
 *
 * 负责人冲突：本 mount 的组合仍挂着官方指令加载行（`@deepseek-ai/dsh-agent-instructions`）
 * 时，独立文件来源整体不参战——同一正文只由一方注入，不同时执行再靠文案去重。
 */
import { statSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { NamedEntries, ScopedLayers, scopeOf } from '@deepseek-ai/dsh-scope'
// 引擎 ESM 源文件由 tsdown 作为源码依赖打包，无独立声明文件。
// @ts-expect-error
import { createEpochPromotion, isSuccessfulCompactionEnd } from '../../engine/compaction-epoch.mjs'
// @ts-expect-error
import { PROMOTE_EVENTS, createWarnOnce, sessionEvents } from '../../engine/shared.mjs'
// @ts-expect-error
import { runPreStepBatch, confirmDelivered } from '../../engine/executor.mjs'
import { detectAgentsFiles, readAgentsFileSnapshot } from '../host/agents-cards.ts'
import { instructionPolicyPath, readInstructionPolicy, resolveInstructionPolicy } from '../host/instructions-policy.ts'
import type { InstructionPolicy } from '../shared/instructions.ts'

/** 协调服务名：引擎行通过 ctx.get 解析本服务决定走管理路径还是独立路径。 */
export const PRE_STEP_COORDINATOR_SERVICE = 'promptToolPreStep'

/** 服务契约版本：引擎与协调器不同步时按「不认识就不接管」处理。 */
export const PRE_STEP_COORDINATOR_VERSION = 1

const WARN_LABEL = 'prompt-tool:pre-step-coordinator'

/** 批执行算法消费的提示词配置（与 engine/schema.mjs 产出的形状同源）。 */
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

/** 一个预设 mount 注册进来的来源：提示词配置 + 装配事实（晋升/去重由协调器统一持有）。 */
export interface PreStepSource {
  configs: readonly PreStepPromptConfig[]
  officialInstructions?: boolean
}

/**
 * 文件来源每次 pre-step 编译出的最小候选。
 * `available: false` 表示读取失败/超限/空内容：只在「该文件曾经注入过」时转成
 * 一次性失效通知，不冒充空正文。
 */
export interface PreStepFileContribution {
  fileId: string
  displayPath: string
  revision: string
  text: string
  available: boolean
  reason?: string
  order: number
  position: string
  promotion: string
  audience: string | null
  modelScope: string
}

export interface PreStepCoordinatorOptions {
  /** 每次 pre-step 现读指令文件；缺省实现走 host 探测 + 独立策略。测试可注入。 */
  collectFiles?: (agent: unknown, session: unknown) => PreStepFileContribution[]
  /** 策略文件位置覆盖（测试隔离用）。 */
  policyFile?: string
  /** 用户级指令文件根（DSH_HOME）覆盖（测试隔离用）。 */
  home?: string
}

export interface PreStepCoordinatorService {
  readonly version: number
  /**
   * 把 preset mount 的 pre-step 配置登记进协调器。
   * @param sourceCtx 注册 ctx：同时决定来源作用域与释放时机（挂在这个 fiber 上）。
   * @param sourceId 来源 id（同一 scope 内唯一，重复注册是错误）。
   * @returns 幂等的撤销函数。
   */
  registerPreset(sourceCtx: Context, sourceId: string, source: PreStepSource): () => void
  /** 该会话最近一次 pre-step 观察到的负责人事实；未知返回 undefined。 */
  officialOwnerOf(sessionId: string): boolean | undefined
}

interface SourceLayer {
  entries: NamedEntries<PreStepSource>
  isEmpty(): boolean
}

const isRecord = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object'

/** 会话工作区：来自该会话自己的 header.cwd；缺失不拿进程 cwd 兜底。 */
function sessionCwd(session: unknown): string | undefined {
  const cwd = isRecord(session) && isRecord(session.header) ? session.header.cwd : undefined
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}

/**
 * 当前模型可见面的消息。优先 `deriveMessages()`（压缩投影后的真相）；缺失时回退
 * 持久日志里最后一次成功 compaction/end 之后的消息。
 */
function visibleMessages(session: unknown): unknown[] {
  if (isRecord(session) && typeof session.deriveMessages === 'function') {
    try {
      const list = session.deriveMessages()
      if (Array.isArray(list)) return list
    } catch {
      // 投影失败:回退持久日志。
    }
  }
  const events = sessionEvents(session)
  let boundary = -1
  for (const event of events) {
    if (isSuccessfulCompactionEnd(event)) boundary = event?.seq ?? 0
  }
  const out: unknown[] = []
  for (const event of events) {
    if ((event?.seq ?? 0) <= boundary) continue
    const data = event?.data
    // 与 engine/executor.mjs 的事件形状兼容：data 本身是消息，或 data.message(s)。
    if (isRecord(data) && isRecord(data.source)) out.push(data)
    if (isRecord(data) && isRecord(data.message)) out.push(data.message)
    if (isRecord(data) && Array.isArray(data.messages)) out.push(...data.messages)
    if (isRecord(event) && isRecord(event.message)) out.push(event.message)
  }
  return out
}

const FILE_IDENTITY_PREFIX = 'instruction-file:'

/** 记住的上次探测文件数上限（超限整体清空，只影响失效通知的展示路径）。 */
const MAX_TRACKED_FILES = 256

/** 负责人事实按会话记录的条数上限（超限整体清空，下一次 pre-step 重新填充）。 */
const MAX_TRACKED_OWNER_SESSIONS = 4096

/**
 * 旧版 writePreset 在生成目录里物化的文件卡（id `agents-file-*` / sourceKind
 * `instruction-file`）。独立来源接管后它们不再参战：既有用户目录在重新物化前
 * 仍会带着这些卡，否则同一份正文会被注入两次。
 */
function isLegacyFileCard(config: PreStepPromptConfig): boolean {
  return config.id.startsWith('agents-file-') || config.sourceKind === 'instruction-file'
}

/** 当前可见面里已存在的文件来源身份（只收本插件命名的身份）。 */
function visibleFileIdentities(session: unknown): Set<string> {
  const seen = new Set<string>()
  for (const message of visibleMessages(session)) {
    const plugin = isRecord(message) && isRecord(message.source) ? message.source.plugin : undefined
    if (typeof plugin === 'string' && plugin.startsWith(FILE_IDENTITY_PREFIX)) seen.add(plugin)
  }
  return seen
}

/** 文件来源身份：fileId + 内容版本 + 当前 surface epoch 编码进 plugin 命名空间。 */
function fileIdentity(file: PreStepFileContribution, epoch: number): string {
  if (!file.available) return `${FILE_IDENTITY_PREFIX}${file.fileId}:unavailable:e${Math.max(epoch, 0)}`
  return `${FILE_IDENTITY_PREFIX}${file.fileId}:${file.revision.slice(0, 16)}:e${Math.max(epoch, 0)}`
}

/** 某一身份是否属于某个 fileId（含历史版本与失效通知）。 */
function identityFileId(identity: string): string {
  return identity.slice(FILE_IDENTITY_PREFIX.length).split(':')[0] ?? ''
}

function messageIdOf(identity: string): string {
  return identity.replaceAll(':', '-')
}

/** 文件候选 → 批执行算法可消费的提示词配置（正文 literal，不经预设变量插值）。 */
function fileCardConfig(file: PreStepFileContribution, identity: string): PreStepPromptConfig {
  const text = `Instructions from: ${file.displayPath}\n\n${file.text}`
  return cardConfig(file, identity, text)
}

/** 失效通知：正文已消失，历史和旧版本仍在会话日志里，不谎称已撤回。 */
function unavailableCardConfig(file: PreStepFileContribution, identity: string): PreStepPromptConfig {
  const reason = file.reason ?? '文件当前不可读或为空'
  return cardConfig(
    file,
    identity,
    `Instructions from: ${file.displayPath} are no longer available (${reason}). `
      + 'The previously injected content is stale; do not rely on it.',
  )
}

function cardConfig(file: PreStepFileContribution, identity: string, text: string): PreStepPromptConfig {
  return {
    id: `agents-file-${file.fileId}`,
    layer: 'pre-step',
    enabled: true,
    order: file.order,
    position: file.position,
    promotion: file.promotion,
    audience: file.audience,
    modelScope: file.modelScope,
    role: 'user',
    dedupe: 'none',
    mergeMode: 'separate',
    sourceKind: 'instruction-file',
    form: 'instructions',
    texts: [],
    params: {},
    variables: {},
    identity: { field: 'plugin', value: identity },
    resolve: () => ({
      id: messageIdOf(identity),
      content: [{ type: 'text', text }],
      source: { kind: 'instruction-file', plugin: identity, form: 'instructions' },
    }),
  }
}

/**
 * 独立策略解析（进程内按 mtime+size 缓存）：策略缺失或损坏都返回 undefined，
 * 即「不参战」——不能把损坏的策略文件当成空配置继续注入。
 */
function createPolicyReader(policyFile?: string): () => InstructionPolicy | undefined {
  let cached: { path: string; stamp: string; policy: InstructionPolicy | undefined } | undefined
  return () => {
    const path = policyFile ?? instructionPolicyPath()
    let stamp: string
    try {
      const info = statSync(path)
      stamp = `${info.mtimeMs}:${info.size}`
    } catch {
      stamp = 'missing'
    }
    if (cached !== undefined && cached.path === path && cached.stamp === stamp) return cached.policy
    const read = readInstructionPolicy(path)
    const policy = read.error === undefined ? read.policy : undefined
    cached = { path, stamp, policy }
    return policy
  }
}

/** 缺省文件来源：按会话工作区探测 → 独立策略过滤 → 单次读取形成一致快照。 */
function defaultCollectFiles(readPolicy: () => InstructionPolicy | undefined, home?: string) {
  /**
   * fileId → 上次探测到的展示路径与策略值：文件被删除或移出范围后，用它发一次
   * 失效通知（是否真发由 fileConfigsFor 按「该会话曾注入过这个文件」判定）。
   */
  // ponytail: 进程内上限防无界增长；需要精确淘汰时改 LRU。
  const lastSeen = new Map<string, { displayPath: string; values: ReturnType<typeof resolveInstructionPolicy> }>()
  return (_agent: unknown, session: unknown): PreStepFileContribution[] => {
    const policy = readPolicy()
    if (policy === undefined || policy.enabled !== true) return []
    const cwd = sessionCwd(session)
    const cards = cwd === undefined
      ? detectAgentsFiles({ projects: false, home })
      : detectAgentsFiles({ cwd, home })
    if (lastSeen.size > MAX_TRACKED_FILES) lastSeen.clear()
    const out: PreStepFileContribution[] = []
    const detected = new Set<string>()
    for (const card of cards) {
      detected.add(card.fileId)
      const values = resolveInstructionPolicy(policy, card.fileId)
      if (!values.enabled) continue
      const snapshot = readAgentsFileSnapshot(card)
      const base = {
        fileId: card.fileId,
        displayPath: card.displayPath,
        order: values.order,
        position: values.position,
        promotion: values.promotion,
        audience: values.audience,
        modelScope: values.modelScope,
      }
      lastSeen.set(card.fileId, { displayPath: card.displayPath, values })
      // 读取失败/超限不是空文件:保留错误状态(UI 展示 + 一次性失效通知),不冒充正文。
      if (snapshot.status !== 'ready' || snapshot.revision === null) {
        out.push({ ...base, revision: 'unavailable', text: '', available: false, reason: snapshot.message ?? snapshot.status })
        continue
      }
      const text = snapshot.text.trim()
      if (text.length === 0) {
        out.push({ ...base, revision: 'unavailable', text: '', available: false, reason: 'file is empty' })
        continue
      }
      out.push({
        ...base,
        revision: snapshot.revision,
        text,
        available: true,
      })
    }
    // 上一轮还在、本次探测不到（删除或移出范围）：保留一次失效通知的候选。
    for (const [fileId, known] of lastSeen) {
      if (detected.has(fileId)) continue
      out.push({
        fileId,
        displayPath: known.displayPath,
        revision: 'unavailable',
        text: '',
        available: false,
        reason: 'file is missing',
        order: known.values.order,
        position: known.values.position,
        promotion: known.values.promotion,
        audience: known.values.audience,
        modelScope: known.values.modelScope,
      })
    }
    return out
  }
}

/**
 * 安装协调器：发布 `promptToolPreStep` 服务并注册唯一的 pre-step 监听器。
 * 普通监听器留在 prepend 门控内侧；来源监听器只登记后交出执行权。
 * 即使服务迟到或重挂，已安装的 context-gate 仍能过滤最终消息批。
 */
export function installPreStepCoordinator(
  ctx: Context,
  options: PreStepCoordinatorOptions = {},
): PreStepCoordinatorService {
  const layers = new ScopedLayers<SourceLayer>(() => {
    const entries = new NamedEntries<PreStepSource>((key) => new Error(`prompt-tool: duplicate pre-step source ${key}`))
    return { entries, isEmpty: () => entries.isEmpty() }
  }, () => {})

  const promotion = {
    main: createEpochPromotion(PROMOTE_EVENTS.either, { includeSubagents: false }),
    withSubagents: createEpochPromotion(PROMOTE_EVENTS.either, { includeSubagents: true }),
  }
  const memo = new Map<string, Set<string>>()
  ctx.on('session/event', (session: unknown, event: unknown) => {
    promotion.main.observe(session, event)
    promotion.withSubagents.observe(session, event)
    // 管理路径的去重记账与独立路径同源：以宿主真正接纳的消息确认投递，
    // 被外层门控剥离的候选不算已注入（晋升后仍可补发）。
    confirmDelivered(memo, session, event)
  })

  const warnOnce = createWarnOnce(ctx, WARN_LABEL)
  const officialOwner = new Map<string, boolean>()
  const readPolicy = createPolicyReader(options.policyFile)
  const collectFiles = options.collectFiles ?? defaultCollectFiles(readPolicy, options.home)

  const fileConfigsFor = (agent: unknown, session: unknown): PreStepPromptConfig[] => {
    const contributions = collectFiles(agent, session)
    if (contributions.length === 0) return []
    const visible = visibleFileIdentities(session)
    // 曾经注入过正文的文件（含其他版本的旧身份）：只有这类文件才有必要发失效通知。
    const injectedFileIds = new Set([...visible].map(identityFileId))
    const epoch = promotion.withSubagents.status(agent).boundary
    const out: PreStepPromptConfig[] = []
    for (const file of contributions) {
      const identity = fileIdentity(file, epoch)
      if (!file.available && !injectedFileIds.has(file.fileId)) continue
      // 同版本已在当前可见上下文里:不重复注入;内容变更/压缩后 epoch 前推时身份变化。
      if (visible.has(identity)) continue
      out.push(file.available ? fileCardConfig(file, identity) : unavailableCardConfig(file, identity))
    }
    return out
  }

  ctx.on('agent/pre-step', async (payload: unknown, next: () => Promise<unknown>) => {
    const decision = await next()
    if (!isRecord(decision) || decision.kind === 'reject') return decision
    const agent = isRecord(payload) ? payload.agent : undefined
    const session = isRecord(agent) ? agent.session : undefined
    if (agent === undefined || session === undefined) return decision
    try {
      const scope = isRecord(agent) && agent.ctx !== undefined ? scopeOf(agent.ctx as Context) : undefined
      const sources = [...layers.merge(scope, (layer) => layer.entries).values()]
      let official = false
      const configs: PreStepPromptConfig[] = []
      for (const source of sources) {
        if (source.officialInstructions === true) official = true
        for (const config of source.configs) {
          if (isLegacyFileCard(config)) {
            warnOnce(`${WARN_LABEL}: skipping legacy generated file card ${config.id} (independent file source owns instruction injection)`)
            continue
          }
          configs.push(config)
        }
      }
      const sessionId = isRecord(session) && typeof session.id === 'string' ? session.id : undefined
      // 没有任何已确认的 preset 来源（mount 没有引擎行 / 引擎行未注册）＝装配未知：
      // 按「不能确认负责人」处理，不注入文件正文，也不谎称插件负责（UI 显示未知）。
      const verified = sources.length > 0
      if (sessionId !== undefined) {
        if (officialOwner.size >= MAX_TRACKED_OWNER_SESSIONS) officialOwner.clear()
        if (verified) officialOwner.set(sessionId, official)
        else officialOwner.delete(sessionId)
      }
      if (verified && !official) configs.push(...fileConfigsFor(agent, session))
      if (configs.length === 0) return decision
      return await runPreStepBatch({ ctx, agent, decision, configs, promotion, memo, warnOnce })
    } catch (error) {
      warnOnce(`${WARN_LABEL}: coordination failed, keeping decision: ${String((error as Error | undefined)?.message ?? error)}`)
      return decision
    }
  })

  ctx.effect(() => () => {
    officialOwner.clear()
    memo.clear()
  })

  const service: PreStepCoordinatorService = {
    version: PRE_STEP_COORDINATOR_VERSION,
    registerPreset(sourceCtx, sourceId, source) {
      // 来源筛选与 resolver 的服务解析必须使用同一个上下文；批次合并不改变隔离服务。
      const boundSource: PreStepSource = {
        ...source,
        configs: source.configs.map((config) => ({
          ...config,
          resolve: (input) => config.resolve({ ...input, ctx: sourceCtx }),
        })),
      }
      return layers.effect(sourceCtx, (layer) => layer.entries.insert(sourceId, boundSource), {
        label: `prompt-tool: pre-step source ${sourceId}`,
      })
    },
    officialOwnerOf(sessionId) {
      return officialOwner.get(sessionId)
    },
  }
  ctx.provide(PRE_STEP_COORDINATOR_SERVICE, service)
  return service
}
