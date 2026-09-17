import { useCallback, useEffect, useRef, useState } from 'react'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { EngineMeta, PromptConfigDraft } from '../prompt-tool-types.ts'
import type { PromptToolHostApi } from './host-api.ts'
import type { PresetModuleFacts } from '../../shared/engine-capabilities.ts'
import type { SkillBlockScope } from '../../shared/skills.ts'
import { bridgeCall, errorMessage, type BridgeResult, type BridgeSettingsView } from './bridge-client.ts'
import {
  EMPTY_FIELDS,
  EMPTY_META,
  type Fields,
  type HostDefaultModel,
} from './prompt-tool-fields.ts'
import { bridgeViewFromBoot, fieldsFromView, mergePresetParams } from './prompt-tool-view.ts'
import {
  EMPTY_SWITCHES,
  deepEqual,
  hasPendingVariableRows,
  promptConfigsDirty,
  shouldReloadAfterParamSave,
  shouldReloadAfterPresetSave,
  snapshotSwitches,
  switchesEqual,
  type SwitchSnapshot,
} from './dirty-state.ts'
import { instructionFileIdOf, isContentAsset, isPresetCard, liftContentText, stripContentText } from './prompt-config-content.ts'
import {
  applySaveOutcomes,
  EMPTY_INSTRUCTION_POOL,
  instructionSaveRequest,
  isCurrentInstructionSeq,
  isInstructionConflictCode,
  markDraftSaving,
  poolFromSnapshot,
  resetDraftFromSnapshot,
  saveableInstructionDrafts,
  setDraftContent,
  switchInstructionContext,
  unsavedInstructionDrafts,
  type InstructionDraftPool,
  type InstructionSaveOutcome,
} from './instruction-drafts.ts'
import {
  EMPTY_INSTRUCTION_POLICY_SNAPSHOT,
  instructionPolicyPatchForFile,
  resolveInstructionFilePolicy,
} from './instruction-policy.ts'
import type { InstructionPolicyFileOverride, InstructionPolicyPatch, InstructionPolicySnapshot } from '../../shared/instructions.ts'
import { buildParamOverrides, isCurrentPresetDraft, readParamOverridesPatch, updateLoadedParamKeys } from './param-overrides.ts'
import { modelSyncNotice } from './model-sync-notice.ts'
import { createSerialTaskQueue } from './save-queue.ts'
import { createWorkspaceDrafts, hasWorkspaceDrafts, type WorkspaceDrafts } from './workspace-drafts.ts'
import { modelChoiceValue } from '../features/models/model-options.ts'
import type { ModelReasoningView } from '../../shared/bridge-contract.ts'

/** rc8 ui-settings 共享镜像传输面：标准字段经官方 settingsScope 读写。 */
export interface PromptToolSettingsTransport {
  /** 宿主注册的 prompt-tool settings namespace 绑定。 */
  scope: SettingsScope<Record<string, unknown>>
  /** 触发一次共享 describe mirror 读取（idle 时才真正发 RPC）。 */
  ensure: () => Promise<void>
  /** 批量 path-op 写入；成功后 scope 快照已 fold 最新 revision。 */
  mutate: (ops: SettingsPathOpView[], expectedRevision?: number) => Promise<void>
}

export type SwitchKey = 'firstTurnAnchor' | 'firstTurnCustom' | 'guideCustom' | 'injectPrompt' | 'usePtcMode' | 'promoteGate' | 'promoteAfterFirstResponse' | 'personaSectionsOnly' | 'workspaceLine' | 'instructionHint' | 'anchorTurn' | 'deliberationGate' | 'cotDrip' | 'writePreset'

/** 参数类布尔开关：写激活预设 preset.yml（settings 只留全局开关）。 */
const PARAM_SWITCH_KEYS: ReadonlySet<SwitchKey> = new Set(['firstTurnAnchor', 'firstTurnCustom', 'guideCustom', 'injectPrompt', 'usePtcMode', 'promoteGate', 'promoteAfterFirstResponse', 'personaSectionsOnly', 'workspaceLine', 'instructionHint', 'anchorTurn', 'deliberationGate', 'cotDrip'])

/** 预设切换/首次加载期间写盘拒绝提示：写盘会持续拒绝，直到该预设数据成功应用。 */
const PRESET_PENDING_MESSAGE = '预设数据尚未加载完成，本次修改未保存；请稍后重试或重新打开工作台'

export interface PromptToolStore {
  editorDrafts: WorkspaceDrafts
  api: PromptToolHostApi
  fields: Fields
  /** fields 外部订阅通道（usePromptToolFields）：patch/load 变更后通知。
   *  getFields 返回引用稳定快照，selector 化的组件据此跳过无关重渲染。 */
  getFields: () => Fields
  subscribeFields: (listener: () => void) => () => void
  meta: EngineMeta
  loading: boolean
  modelCatalog: Record<string, string[]>
  /** provider/model 路由的推理档位元数据（按 modelChoiceValue 键）；未查到 = known:false。 */
  modelReasoning: Record<string, ModelReasoningView>
  /** 按需查询某路由的推理档位（结果进 modelReasoning；失败静默保持未查到）。 */
  ensureModelReasoning: (provider: string, model: string) => void
  hostDefaultModel?: HostDefaultModel
  moduleFacts?: PresetModuleFacts
  /** 技能导入来源路径输入（宿主机目录；导入即复制，不再维护目录引用）。 */
  skillsDirDraft: string
  /** 当前预设模板消息批层（pre-step）配置数；0 = 模板无配置（入口开关联动关闭）。 */
  templatePreStepCount: number
  savedSwitches: SwitchSnapshot
  savedConfigs: PromptConfigDraft[]
  /** 指令文件草稿池：正文/版本/读取状态按 fileId 索引，跨预设保留。 */
  instructionPool: InstructionDraftPool
  /** 草稿池读取（回调里读最新值，不依赖渲染快照）。 */
  getInstructionPool: () => InstructionDraftPool
  /** 存在未保存的指令文件草稿（预设保存不覆盖它们）。 */
  dirtyInstructions: boolean
  /** 显式保存指令文件（不传 fileIds = 保存全部可写文件）；只提交已改动、可写、上下文匹配的文件。 */
  persistInstructionFiles: (fileIds?: readonly string[]) => Promise<boolean>
  /** 重新读取单个指令文件并丢弃本地草稿（版本冲突时使用）。 */
  reloadInstructionFile: (fileId: string) => Promise<void>
  /** 指令卡策略快照（独立存储）：error 非空时 UI 禁用策略编辑。 */
  instructionPolicy: InstructionPolicySnapshot
  /** 策略快照读取（回调里读最新值，不依赖渲染快照）。 */
  getInstructionPolicy: () => InstructionPolicySnapshot
  /** 写单个文件的行为策略（null = 删除覆盖、恢复默认）；带 revision 乐观并发。 */
  updateInstructionPolicy: (fileId: string, override: InstructionPolicyFileOverride | null) => Promise<boolean>
  /** 独立来源总开关：仅写策略顶层 enabled，不改变官方负责人或单文件覆盖。 */
  setInstructionSourceEnabled: (enabled: boolean) => Promise<boolean>
  /** 技能资产写入忙碌态（复制导入 / 创建 / 删除）。 */
  skillsBusy: boolean
  notice: string
  noticeKind: 'ok' | 'error'
  load: () => Promise<Fields>
  showNotice: (kind: 'ok' | 'error', message: string) => void
  patch: (partial: Partial<Fields>) => void
  /** 保存全局开关与技能顺序/rank；返回两个通道是否都成功（失败字段保持 dirty）。 */
  persistSwitches: (onSaved?: () => void) => Promise<boolean>
  persistParamOverrides: () => Promise<void>
  /** 保存提示词配置；返回 false 表示未写入（预设切换中、跨预设旧草稿或失败）。 */
  persistConfigs: (configs: PromptConfigDraft[]) => Promise<boolean>
  /** 预设级模板变量（preset.yml 内容变量；writePreset 展开进 variables.yml，引擎合并进每条配置）。 */
  templateVariables: Record<string, string>
  setTemplateVariables: (value: Record<string, string>) => void
  /** 模板变量插值开关（preset.yml 顶层 variablesEnabled，缺省 true）。 */
  templateVariablesEnabled: boolean
  setTemplateVariablesEnabled: (value: boolean) => void
  /** 保存模板变量；可显式传入下一份值与开关状态（避免 setState 未生效时的旧闭包）。 */
  saveTemplateVariables: (next?: Record<string, string>, enabled?: boolean) => Promise<boolean>
  toggle: (key: SwitchKey) => void
  setPresetTemplate: (id: string) => void
  createEngineCapability: (action: 'create' | 'create-recipe', id: string) => Promise<boolean>
  removeEngineCapability: (id: string) => Promise<boolean>
  /** 导入来源路径草稿（宿主机目录；导入即复制，不保留引用）。 */
  setSkillsDirDraft: (value: string) => void
  /** 从宿主机目录复制导入到用户技能根。 */
  importSkillsDirectory: (path: string) => Promise<boolean>
  /** 创建标准技能到用户技能根。 */
  createSkill: (input: { name: string; description: string; content: string }) => Promise<boolean>
  /** 回收站删除用户技能根里的技能目录。 */
  deleteSkill: (folder: string) => Promise<boolean>
  /** 注册层屏蔽开关：模型端与用户端各自独立，scope='none' 表示恢复该技能。
   *  返回 false 表示没有提交成功——可能是写盘失败，也可能是上一次保存仍在飞（此时会给出提示，
   *  调用方不需要区分这两种情况，界面状态由随后的清单刷新决定）。 */
  setSkillBlocked: (name: string, scope: SkillBlockScope) => Promise<boolean>
  /** 添加 / 移除引用的技能文件夹（只记引用，不复制文件）。 */
  patchSkillFolders: (folders: string[]) => Promise<boolean>
  /** 打开用户技能根。 */
  openSkillsDir: (path?: string) => Promise<void>
  dirtySwitches: boolean
  dirtyConfigs: boolean
  dirty: boolean
}


/** 等待共享 mirror 的首次应答离开 loading（ready/idle/unavailable 都会返回）。 */
function waitForScope(scope: SettingsScope<Record<string, unknown>>): Promise<SettingsScopeSnapshot<Record<string, unknown>>> {
  const current = scope.getSnapshot()
  if (current.status !== 'loading') return Promise.resolve(current)
  return new Promise((resolve) => {
    let settled = false
    const dispose = scope.subscribe(() => {
      const next = scope.getSnapshot()
      if (next.status === 'loading') return
      if (settled) return
      settled = true
      dispose()
      resolve(next)
    })
    // 宿主 mirror 卡 loading 时兜底超时，避免 UI 永久 loading。
    setTimeout(() => {
      if (settled) return
      settled = true
      dispose()
      resolve(scope.getSnapshot())
    }, 5000)
  })
}

/**
 * 把文件草稿状态贴到指令文件卡上（视图元数据，不写进 preset.yml）。
 * 卡片正文以草稿池为准：服务端附带的 params.text 不再是文件正文的来源。
 */
function withInstructionState(
  configs: PromptConfigDraft[],
  pool: InstructionDraftPool,
  policy: InstructionPolicySnapshot,
): PromptConfigDraft[] {
  return configs.map((config) => {
    const fileId = instructionFileIdOf(config)
    if (fileId === undefined) return config
    // 行为字段来自独立策略（不是预设卡字段），文件卡的显隐/顺序/位置等以它为准。
    const resolved = resolveInstructionFilePolicy(policy.policy, fileId)
    const draft = pool.drafts.find((entry) => entry.fileId === fileId)
    if (draft === undefined) {
      // 卡存在但没有对应快照：不把未知正文当空文件，直接禁用保存。
      return {
        ...config,
        ...policyFields(resolved),
        text: '',
        contentStatus: 'unreadable' as const,
        contentMessage: '未读取到该文件正文，已禁用保存',
      }
    }
    const message = draft.error ?? draft.message
    return {
      ...config,
      ...policyFields(resolved),
      text: draft.content,
      contentStatus: draft.status,
      // 视图字段显式覆盖：池里冲突/提示已清除时卡片不得留上一帧的旧标记。
      contentMessage: message,
      contentDirty: draft.content !== draft.savedContent,
      contentConflict: draft.conflict === true ? true : undefined,
      // 负责人冲突是会话级事实（服务端观察），不是文件自身状态：只在确认冲突时显示。
      contentOwnerConflict: pool.owner?.officialInstructions === true ? true : undefined,
      contentSaving: draft.saving === true ? true : undefined,
    }
  })
}

/** 策略值 → 卡片行为字段（文件卡的行为不来自 preset.yml）。 */
function policyFields(
  resolved: { order: number; position: string; promotion: string; audience: string | null; modelScope: string; enabled: boolean; name?: string },
): Partial<PromptConfigDraft> {
  return {
    enabled: resolved.enabled,
    order: resolved.order,
    position: resolved.position,
    promotion: resolved.promotion,
    audience: resolved.audience,
    modelScope: resolved.modelScope,
    ...(resolved.name === undefined ? {} : { name: resolved.name }),
  }
}

export function usePromptToolStore(api: PromptToolHostApi, settings: PromptToolSettingsTransport): PromptToolStore {
  const editorDrafts = useRef(createWorkspaceDrafts()).current
  const [modelCatalog, setModelCatalog] = useState<Record<string, string[]>>({})
  const [modelReasoning, setModelReasoning] = useState<Record<string, ModelReasoningView>>({})
  const [hostDefaultModel, setHostDefaultModel] = useState<HostDefaultModel | undefined>(undefined)
  const [moduleFacts, setModuleFacts] = useState<PresetModuleFacts | undefined>(undefined)
  const [fields, setFields] = useState<Fields>(EMPTY_FIELDS)
  const [meta, setMeta] = useState<EngineMeta>(EMPTY_META)
  const [skillsDirDraft, setSkillsDirDraft] = useState('')
  const [templatePreStepCount, setTemplatePreStepCount] = useState(0)
  const [savedSwitches, setSavedSwitches] = useState<SwitchSnapshot>(EMPTY_SWITCHES)
  const [savedConfigs, setSavedConfigsState] = useState<PromptConfigDraft[]>([])
  const savedConfigsRef = useRef<PromptConfigDraft[]>([])
  const setSavedConfigs = useCallback((next: PromptConfigDraft[]) => {
    savedConfigsRef.current = next
    setSavedConfigsState(next)
  }, [])
  const [instructionPool, setInstructionPool] = useState<InstructionDraftPool>(EMPTY_INSTRUCTION_POOL)
  const [instructionPolicy, setInstructionPolicy] = useState<InstructionPolicySnapshot>(EMPTY_INSTRUCTION_POLICY_SNAPSHOT)
  const [templateVariables, setTemplateVariablesState] = useState<Record<string, string>>({})
  const templateVariablesRef = useRef<Record<string, string>>({})
  const savedTemplateVariablesRef = useRef<Record<string, string>>({})
  const [templateVariablesEnabled, setTemplateVariablesEnabled] = useState(true)
  const [loading, setLoading] = useState(false)
  // 技能写入用并发计数而不是单一布尔：多个写操作同时在飞时，任何一个先结束都不能把界面
  // 重新放开，否则用户会在另一个操作仍在写盘时点到开关，而那次点击会被忙期守卫丢弃。
  const [skillsBusyCount, setSkillsBusyCount] = useState(0)
  const skillsBusy = skillsBusyCount > 0
  const beginSkillWrite = useCallback(() => { setSkillsBusyCount((count) => count + 1) }, [])
  const endSkillWrite = useCallback(() => { setSkillsBusyCount((count) => Math.max(0, count - 1)) }, [])
  const [notice, setNotice] = useState('')
  const [noticeKind, setNoticeKind] = useState<'ok' | 'error'>('ok')
  const fieldsRef = useRef<Fields>(EMPTY_FIELDS)
  /** fields 订阅者集合：patch/load 每次产生新 fields 引用时广播。
   *  ponytail: 单订阅通道（无 selector 缓存层），selector 在消费侧 useRef 缓存。 */
  const fieldsListenersRef = useRef(new Set<() => void>())
  const publishFields = useCallback((next: Fields) => {
    fieldsRef.current = next
    setFields(next)
    for (const listener of fieldsListenersRef.current) listener()
  }, [])
  const getFields = useCallback(() => fieldsRef.current, [])
  const subscribeFields = useCallback((listener: () => void) => {
    fieldsListenersRef.current.add(listener)
    return () => { fieldsListenersRef.current.delete(listener) }
  }, [])
  /** 指令文件草稿池（独立于 fields）：patch/保存/重新读取都经此发布。 */
  const instructionPoolRef = useRef<InstructionDraftPool>(EMPTY_INSTRUCTION_POOL)
  const instructionPolicyRef = useRef<InstructionPolicySnapshot>(EMPTY_INSTRUCTION_POLICY_SNAPSHOT)
  const instructionSeqRef = useRef(0)
  /** 上一次指令上下文对应的会话 id：变化即建立新上下文（旧草稿保留但不可写）。 */
  const instructionSessionRef = useRef<string | undefined>(undefined)
  const publishInstructions = useCallback((next: InstructionDraftPool) => {
    instructionPoolRef.current = next
    setInstructionPool(next)
  }, [])
  /** 卡片是草稿池的派生视图：池变化后同步正文与状态，避免界面停留旧版本。 */
  const syncInstructionCards = useCallback((pool: InstructionDraftPool) => {
    const current = fieldsRef.current
    publishFields({ ...current, promptConfigs: withInstructionState(current.promptConfigs, pool, instructionPolicyRef.current) })
  }, [publishFields])
  const publishInstructionPolicy = useCallback((next: InstructionPolicySnapshot) => {
    instructionPolicyRef.current = next
    setInstructionPolicy(next)
  }, [])
  const revisionRef = useRef<number | undefined>(undefined)
  const saveQueueRef = useRef(createSerialTaskQueue())
  const presetSaveQueueRef = useRef(createSerialTaskQueue())
  const loadSeqRef = useRef(0)
  /** 用户草稿版本：patch 时递增。load 应答返回时若版本变化，跳过覆盖，避免
   *  保存后的静默刷新吞掉用户在读取期间的编辑。 */
  const draftVersionRef = useRef(0)
  const setTemplateVariables = useCallback((next: Record<string, string>) => {
    draftVersionRef.current += 1
    templateVariablesRef.current = next
    setTemplateVariablesState(next)
  }, [])
  /** 已成功应用快照的预设 id：与当前 fields.presetTemplate 不一致时（切换/加载进行中）
   *  拒绝写盘，避免旧预设字段被当成当前预设数据写进新预设。 */
  const loadedPresetRef = useRef<string | undefined>(undefined)
  /** applyView 自动预选的 provider：无模型名时不作为用户显式参数落盘。 */
  const autoModelProviderRef = useRef<string | undefined>(undefined)
  const autoSubagentModelProviderRef = useRef<string | undefined>(undefined)
  /** 最近一次 load 时 preset.yml params 现有键集：persist 只发送「已有键或已改动」，
   *  未动过的键不写——避免 UI 默认值固化覆盖模板 moduleConfigs 默认。 */
  const loadedKeysRef = useRef<Set<string>>(new Set())
  const paramBaselineRef = useRef<SwitchSnapshot>(EMPTY_SWITCHES)

  const showNotice = useCallback((kind: 'ok' | 'error', message: string) => {
    setNotice(message)
    setNoticeKind(kind)
  }, [])

  /** 模型目录惰性加载：独立于主 load（/describe 不再阻塞等模型查询）。 */
  /** 模型目录：默认走 10 分钟缓存；refresh=true 时请求宿主越过 TTL 重新查询。 */
  const loadModels = useCallback(async (refresh = false): Promise<void> => {
    const res = refresh ? await bridgeCall('models', { refresh: true }) : await bridgeCall('models')
    if (res.ok) setModelCatalog(res.value.modelCatalog ?? {})
  }, [])

  /** 已发起过查询的路由键：避免同一路由随每次渲染重复请求（结果无论成败都不重发）。 */
  const reasoningRequestedRef = useRef(new Set<string>())
  const ensureModelReasoning = useCallback((provider: string, model: string): void => {
    if (provider.length === 0 || model.length === 0) return
    const key = modelChoiceValue(provider, model)
    if (reasoningRequestedRef.current.has(key)) return
    reasoningRequestedRef.current.add(key)
    void (async () => {
      const res = await bridgeCall('modelReasoning', { provider, model })
      // 未查到（失败/超时/未注册）：保持「未查到」，不写入空档位，UI 不虚构选项。
      if (!res.ok) return
      setModelReasoning((previous) => ({ ...previous, [key]: res.value.reasoning }))
    })()
  }, [])

  const applyView = useCallback((res: BridgeResult<BridgeSettingsView>): Fields => {
    setTemplatePreStepCount(res.ok && typeof res.templatePreStepCount === 'number' ? res.templatePreStepCount : 0)
    setModelCatalog(res.ok ? res.modelCatalog ?? {} : {})
    setHostDefaultModel(res.ok ? res.hostDefaultModel : undefined)
    setModuleFacts(res.ok ? res.moduleFacts : undefined)
    const next = mergePresetParams(fieldsFromView(res), res.ok ? res.presetParams : undefined)
    // 检测到 DeepSeek 路由且用户未设置服务商时，直接预选第一个检测到的 provider
    // （模型名为空则路由不激活，继承主会话语义不变；用户后续选择模型名即生效）。
    // 自动预选值记录到 ref：它只是显示兜底，不作为用户显式参数写进 preset.yml。
    autoModelProviderRef.current = undefined
    if (res.ok && next.modelProvider === '' && (res.providers?.length ?? 0) > 0) {
      autoModelProviderRef.current = res.providers![0]!
      next.modelProvider = autoModelProviderRef.current
    }
    // 子代理服务商同样预选：模型名为空则固定路由不激活（继承主会话），仅让模型名下拉有候选。
    autoSubagentModelProviderRef.current = undefined
    if (res.ok && next.subagentModelProvider === '' && (res.providers?.length ?? 0) > 0) {
      autoSubagentModelProviderRef.current = res.providers![0]!
      next.subagentModelProvider = autoSubagentModelProviderRef.current
    }
    publishFields(next)
    setSkillsDirDraft('')
    setSavedSwitches(snapshotSwitches(next))
    setSavedConfigs(next.promptConfigs)
    // revision 只在首次建立，后续由 enqueueSave 的 mutate 应答维护——/bootstrap 的
    // descriptor 有 30s 服务端缓存，用其 revision 倒退会导致下一次保存 409。
    if (res.ok && revisionRef.current === undefined) revisionRef.current = res.value.revision
    return next
  }, [])

  const load = useCallback(async (options?: { silent?: boolean; presetConfigs?: PromptConfigDraft[] }) => {
    // 并发保护：慢的旧请求不得覆盖新请求（last-good 语义保留旧数据）。
    const seq = ++loadSeqRef.current
    const draftVersion = draftVersionRef.current
    const samePreset = loadedPresetRef.current === fieldsRef.current.presetTemplate
    const localConfigs = fieldsRef.current.promptConfigs.filter(isPresetCard)
    // 读取保护也覆盖“请求开始前”已有的草稿；不能只检查 await 期间的版本变化。
    const retainedConfigs = options?.presetConfigs ?? (samePreset && !deepEqual(localConfigs, savedConfigsRef.current.filter(isPresetCard)) ? localConfigs : undefined)
    const retainVariables = samePreset && !deepEqual(templateVariablesRef.current, savedTemplateVariablesRef.current)
    const sessionId = api.currentSessionId()
    // silent：保存后静默刷新（不闪 loading、避免重渲染风暴与滚动跳动）；失败仍报错。
    if (!options?.silent) setLoading(true)
    try {
      // /bootstrap 聚合读取：meta + describe runtime facts + 参数覆盖 + 模板变量 +
      // 实际生效配置一次取回（此前 5 端点串行，preset.yml 每端点读盘解析）。
      // 带当前会话 id：服务端据此解析该本地 Agent 的工作区，返回对应指令文件快照。
      // 会话/工作区切换：建立新的指令上下文。草稿保留但旧上下文不可写，未保存的文件
      // 与版本在切换到新工作区后必须重新读取校验，防止把 A 的正文写进 B 的文件集。
      if (sessionId !== instructionSessionRef.current) {
        instructionSessionRef.current = sessionId
        publishInstructions(switchInstructionContext(instructionPoolRef.current, ++instructionSeqRef.current))
        publishFields({ ...fieldsRef.current, promptConfigs: fieldsRef.current.promptConfigs.filter((config) => instructionFileIdOf(config) === undefined) })
      }
      const instructionSnapshot = instructionPoolRef.current
      const policySnapshot = instructionPolicyRef.current
      const boot = await bridgeCall('bootstrap', sessionId === undefined ? {} : { sessionId })
      if (seq !== loadSeqRef.current || sessionId !== api.currentSessionId()) return EMPTY_FIELDS
      // 读取期间用户已修改草稿：不应用服务端快照覆盖，保留草稿；后续保存/读取再同步。
      if (draftVersionRef.current !== draftVersion) return fieldsRef.current
      if (!boot.ok) {
        showNotice('error', '读取配置失败：' + (boot.message ?? 'bootstrap unavailable'))
        return EMPTY_FIELDS
      }
      // 两次读取都完成后才应用快照；任何 await 期间的新上下文/草稿/文件结果优先。
      const policyRes = await bridgeCall('instructionsPolicy')
      if (seq !== loadSeqRef.current || sessionId !== api.currentSessionId()) return EMPTY_FIELDS
      if (draftVersionRef.current !== draftVersion || instructionPoolRef.current !== instructionSnapshot) return fieldsRef.current
      if (boot.meta !== undefined) setMeta(boot.meta.meta)
      // /bootstrap 已携带 settings descriptor（value/base/revision）：直接作为 fields
      // 主源，不再 await settings.ensure()——宿主全量 describe mirror 是切换预设后
      // 配置卡十几秒才出现的瓶颈。
      const res = bridgeViewFromBoot(boot)
      applyView(res)
      // 用户参数覆盖（激活预设 preset.yml params；settings 不再承载参数）。
      if (boot.ok && boot.overrides !== undefined) {
        const o = boot.overrides.overrides
        loadedKeysRef.current = new Set(Object.keys(o))
        const paramPatch = readParamOverridesPatch(o)
        if (Object.keys(paramPatch).length > 0) {
          const next = { ...fieldsRef.current, ...paramPatch }
          publishFields(next)
          setSavedSwitches(snapshotSwitches(next))
        }
      }
      // 指令文件（独立来源）：正文、身份、版本、读取状态来自同一次读取。
      if (boot.ok && boot.instructions !== undefined) {
        publishInstructions(poolFromSnapshot(boot.instructions, ++instructionSeqRef.current, instructionPoolRef.current))
        // 切到别的工作区后，未保存草稿的文件可能已不在当前可见范围：保留草稿，但要说清楚。
        const visible = new Set(boot.instructions.files.map((file) => file.fileId))
        const stranded = unsavedInstructionDrafts(instructionPoolRef.current).filter((draft) => !visible.has(draft.fileId))
        if (stranded.length > 0) {
          showNotice('error', `有 ${stranded.length} 个未保存的指令文件草稿不在当前工作区（${stranded.map((draft) => draft.displayPath).join('、')}），已保留；切回原工作区后可继续保存`)
        }
      }
      // 指令卡策略（独立存储，默认禁用）：读失败时明确标记，UI 据此禁用策略编辑。
      const policyValue = policyRes.ok ? policyRes.value : undefined
      // 响应缺少策略快照（老宿主/异常载荷）不得当成「空策略」放开编辑。
      if (instructionPolicyRef.current === policySnapshot) publishInstructionPolicy(policyValue?.policy === undefined
        ? { ...EMPTY_INSTRUCTION_POLICY_SNAPSHOT, error: `未读取到指令策略：${policyRes.ok ? '响应缺少策略快照' : policyRes.message ?? 'settings bridge unavailable'}` }
        : {
          policy: policyValue.policy,
          revision: policyValue.revision ?? null,
          exists: policyValue.exists === true,
          ...(policyValue.error === undefined ? {} : { error: policyValue.error }),
        })
      // 预设级模板变量（preset.yml 内容变量；失败不阻断主流程）。
      if (boot.ok && boot.variables !== undefined) {
        savedTemplateVariablesRef.current = boot.variables.variables
        if (!retainVariables) {
          templateVariablesRef.current = boot.variables.variables
          setTemplateVariablesState(boot.variables.variables)
        }
        setTemplateVariablesEnabled(boot.variables.enabled !== false)
      }
      // 实际生效配置（引擎从生成目录加载；settings.promptConfigs 仅为覆盖层，
      // 默认为空不代表无配置）。非空时以实际配置为准，并同步已保存快照避免误判 dirty。
      if (boot.ok && boot.promptConfigs !== undefined
        && Array.isArray(boot.promptConfigs.promptConfigs) && boot.promptConfigs.promptConfigs.length > 0) {
        // 引擎自动生成的模型参数配置（model-params / subagent-model-params）由
        // 「模型设置」卡片管理，不进入模块列表（避免重复编辑入口）。
        const engineGenerated = new Set(['model-params', 'subagent-model-params'])
        const userConfigs = boot.promptConfigs.promptConfigs.filter((config) => !engineGenerated.has(config.id))
        // 内容资产条目（prompt-injector / instruction-hint）：params.text（生成目录文件渲染产物）
        // 提升到 text 框显示，编辑入口统一为模块卡片。
        const actual = withInstructionState(userConfigs.map(liftContentText), instructionPoolRef.current, instructionPolicyRef.current)
        const next = { ...fieldsRef.current, promptConfigs: actual }
        publishFields(next)
        setSavedConfigs(actual)
      }
      if (retainedConfigs !== undefined) {
        const restored = [...retainedConfigs, ...fieldsRef.current.promptConfigs.filter((config) => !isPresetCard(config))]
        publishFields({ ...fieldsRef.current, promptConfigs: restored })
        // 明确保存的定义是权威应答；生成目录的暂时空快照不能让新卡消失。
        if (options?.presetConfigs !== undefined) setSavedConfigs(restored)
      }
      // 快照已完整应用：该预设自此可写（切换/首次加载期间由 loadedPresetRef 拦截写盘）。
      loadedPresetRef.current = fieldsRef.current.presetTemplate
      paramBaselineRef.current = snapshotSwitches(fieldsRef.current)
      setNotice('')
      return fieldsRef.current
    } catch (error) {
      if (seq === loadSeqRef.current && sessionId === api.currentSessionId() && draftVersionRef.current === draftVersion) showNotice('error', '读取失败：' + errorMessage(error))
      return EMPTY_FIELDS
    } finally {
      if (seq === loadSeqRef.current && !options?.silent) setLoading(false)
    }
  }, [api, applyView, publishInstructionPolicy, publishInstructions, settings, showNotice])

  // 挂载即后台拉取模型目录（不阻塞工作台首屏；10min 缓存兜底重复打开）。
  useEffect(() => {
    void loadModels()
  }, [loadModels])

  // 目录就绪后补查当前可见路由的推理档位（会话选择 / 预设主模型 / 子代理模型 / 宿主默认）。
  // 只查这几条可见路由：不遍历整个目录，也不把目录当授权白名单。
  useEffect(() => {
    reasoningRequestedRef.current.clear()
    const current = fieldsRef.current
    const face = api.sessionModel.snapshot()
    const sessionSelection = face.selection
    const routes: Array<{ provider?: string; model?: string }> = [
      { provider: sessionSelection?.provider, model: sessionSelection?.model },
      { provider: current.modelProvider, model: current.modelName },
      { provider: current.subagentModelProvider, model: current.subagentModelName },
      { provider: hostDefaultModel?.provider, model: hostDefaultModel?.model },
    ]
    for (const route of routes) {
      if (route.provider !== undefined && route.model !== undefined) {
        ensureModelReasoning(route.provider, route.model)
      }
    }
  }, [api, ensureModelReasoning, hostDefaultModel?.model, hostDefaultModel?.provider, modelCatalog])

  const refreshRevision = useCallback(async () => {
    try {
      await settings.ensure()
      const snapshot = await waitForScope(settings.scope)
      if (snapshot.revision !== undefined) revisionRef.current = snapshot.revision
    } catch {
      // 刷新失败保持原 revision，用户可重试。
    }
  }, [settings])

  const patch = useCallback((partial: Partial<Fields>) => {
    draftVersionRef.current += 1
    let next = { ...fieldsRef.current, ...partial }
    // 文件卡正文镜像进文件草稿池：预设保存不承载它们，文件只能经显式保存写盘。
    if (Array.isArray(partial.promptConfigs)) {
      let pool = instructionPoolRef.current
      for (const config of partial.promptConfigs) {
        const fileId = instructionFileIdOf(config)
        if (fileId === undefined || typeof config.text !== 'string') continue
        const draft = pool.drafts.find((entry) => entry.fileId === fileId)
        if (draft === undefined || draft.content === config.text) continue
        pool = setDraftContent(pool, fileId, config.text)
      }
      if (pool !== instructionPoolRef.current) publishInstructions(pool)
      // 卡片视图（状态徽标、正文）以草稿池为准，避免编辑后状态停在上一帧。
      next = { ...next, promptConfigs: withInstructionState(next.promptConfigs, instructionPoolRef.current, instructionPolicyRef.current) }
    }
    // complete 互斥：官方 complete 段一个 scope 只能有一个，开启任一 enabled 配置的
    // complete 时自动关闭其他 enabled 配置的 complete。disabled 配置不参与（引擎
    // effectiveList 已过滤，不注册即不独占；重新启用时由本次收敛）。顶层人设的
    // complete 不在本数组内，跨层冲突由 settings bridge 写盘前 fail loud。
    if (Array.isArray(next.promptConfigs)) {
      const activeComplete = (config: PromptConfigDraft): boolean => config.enabled !== false && config.params?.complete === true
      const enabledComplete = next.promptConfigs.some(activeComplete)
      if (enabledComplete) {
        const kept = next.promptConfigs.findIndex(activeComplete)
        next = {
          ...next,
          promptConfigs: next.promptConfigs.map((config, index) =>
            index === kept || config.enabled === false
              ? config
              : { ...config, params: { ...config.params, complete: false } }),
        }
      }
    }
    publishFields(next)
  }, [publishFields, publishInstructions])

  const enqueueSave = useCallback((ops: SettingsPathOpView[], okMessage: string | undefined, onSaved: () => void, setBusy?: (busy: boolean) => void): Promise<boolean> => {
    setBusy?.(true)
    return saveQueueRef.current.enqueue(async () => {
      try {
        await settings.mutate(ops, revisionRef.current)
        revisionRef.current = settings.scope.getSnapshot().revision
        onSaved()
        if (okMessage) showNotice('ok', okMessage)
        return true
      } catch (error) {
        // settings 注册重建（fiber reload）会把 namespace revision 归零，客户端
        // 持有的版本号随即过期：冲突时重试一次不带 expectedRevision（官方语义 =
        // 不检查并发，last-write-wins），全局开关不会再被过期版本号卡死。
        const message = errorMessage(error)
        if (/expected revision|changed since it was read/i.test(message)) {
          try {
            await settings.mutate(ops)
            revisionRef.current = settings.scope.getSnapshot().revision
            onSaved()
            if (okMessage) showNotice('ok', okMessage)
            return true
          } catch (retryError) {
            await refreshRevision()
            showNotice('error', '保存失败：' + errorMessage(retryError) + '（已刷新配置版本，可重试）')
          }
        } else {
          await refreshRevision()
          showNotice('error', '保存失败：' + message + '（已刷新配置版本，可重试）')
        }
        return false
      } finally {
        setBusy?.(false)
      }
    })
  }, [refreshRevision, settings, showNotice])

  /** 全局开关保存：技能状态已不进 settings（注册层屏蔽表由自己的端点写入）。 */
  const persistSwitches = useCallback((onSaved?: () => void): Promise<boolean> => {
    const savedSnapshot = snapshotSwitches(fieldsRef.current)
    return enqueueSave(
      [
        { op: 'set', path: ['presetOrder'], value: fieldsRef.current.presetOrder },
        { op: 'set', path: ['fallbackText'], value: fieldsRef.current.fallbackText },
        { op: 'set', path: ['writePreset'], value: fieldsRef.current.writePreset },
      ],
      undefined,
      () => {
        setSavedSwitches(savedSnapshot)
        onSaved?.()
      },
    )
  }, [enqueueSave])

  /** 参数类设置：写入激活预设 preset.yml（savePresetParams；随预设隔离）。
   *  与提示词配置共用预设队列；请求成功只把「发起时快照」标记为已保存。若用户在请求期间
   *  继续编辑，则跳过静默重载，避免磁盘旧快照覆盖未保存草稿。 */
  const persistParamOverrides = useCallback(async () => {
    const f = fieldsRef.current
    const savedSnapshot = snapshotSwitches(f)
    const draftVersion = draftVersionRef.current
    // 待编辑变量行（空 key）不落盘；此时不重载，避免服务端状态覆盖草稿使编辑行消失。
    const configsWereClean = !promptConfigsDirty(f.promptConfigs, savedConfigs)
      && !hasPendingVariableRows(f.promptConfigs)
    const autoModelProvider = autoModelProviderRef.current
    const autoSubagentModelProvider = autoSubagentModelProviderRef.current
    await presetSaveQueueRef.current.enqueue(async () => {
      // 切换进行中（目标预设数据未应用）：参数仍是旧预设值，拒绝写入 presetTemplate。
      if (loadedPresetRef.current !== undefined && loadedPresetRef.current !== fieldsRef.current.presetTemplate) {
        showNotice('error', PRESET_PENDING_MESSAGE)
        return
      }
      if (!isCurrentPresetDraft(f, fieldsRef.current)) {
        showNotice('error', '预设已切换，旧参数草稿未写入')
        return
      }
      const overrides = buildParamOverrides(f, {
        loadedKeys: loadedKeysRef.current,
        baseline: paramBaselineRef.current,
        autoModelProvider,
        autoSubagentModelProvider,
      })
      const res = await bridgeCall('paramOverrides', { overrides, expectedPresetId: f.presetTemplate })
      if (!isCurrentPresetDraft(f, fieldsRef.current)) return
      if (res.ok) {
        updateLoadedParamKeys(loadedKeysRef.current, overrides)
        paramBaselineRef.current = savedSnapshot
        // 只标记发起时快照；若期间有新编辑，当前 fields 仍保持 dirty。
        setSavedSwitches(savedSnapshot)
        // 预设已落盘，但宿主默认模型同步可能未完成：分别表达，不谎报全绿。
        const syncNotice = modelSyncNotice(res.value.modelSync, '预设已保存')
        if (syncNotice !== undefined) showNotice(syncNotice.kind, syncNotice.message)
        const currentSnapshot = snapshotSwitches(fieldsRef.current)
        // 服务端会过滤未完成阶段；此时不重载，保留 UI 正在编辑的空草稿行。
        if (shouldReloadAfterPresetSave(
          draftVersion,
          draftVersionRef.current,
          configsWereClean && shouldReloadAfterParamSave(currentSnapshot, savedSnapshot),
        )) {
          // 参数已写激活预设 preset.yml：服务端重建后刷新（模型参数配置等随预设变化）。
          await load({ silent: true })
        }
      } else {
        showNotice('error', '参数保存失败：' + (res.message ?? 'settings bridge unavailable'))
      }
    })
  }, [load, savedConfigs, showNotice])

  /**
   * 指令文件显式保存：只提交「已改动 + 读取就绪 + 有基线版本 + 上下文匹配」的文件。
   * 逐文件结果；失败与冲突都保留草稿，不触发预设重建，也不重载覆盖用户输入。
   */
  const persistInstructionFiles = useCallback(async (fileIds?: readonly string[]): Promise<boolean> => {
    const pool = instructionPoolRef.current
    const pending = unsavedInstructionDrafts(pool).filter((draft) => fileIds === undefined || fileIds.includes(draft.fileId))
    if (pending.length === 0) return true
    const targets = saveableInstructionDrafts(pool)
      .filter((draft) => fileIds === undefined || fileIds.includes(draft.fileId))
    const sessionId = api.currentSessionId()
    const isCurrent = (): boolean => isCurrentInstructionSeq(instructionPoolRef.current, pool.seq)
      && instructionPoolRef.current.contextId === pool.contextId
      && sessionId === api.currentSessionId() && sessionId === instructionSessionRef.current
    if (!isCurrent()) return false
    const requests = new Map(targets.flatMap((draft) => {
      const request = instructionSaveRequest(instructionPoolRef.current, draft.fileId, sessionId)
      return request === undefined ? [] : [[draft.fileId, request] as const]
    }))
    for (const fileId of requests.keys()) {
      const saving = markDraftSaving(instructionPoolRef.current, fileId, true)
      publishInstructions(saving)
      syncInstructionCards(saving)
    }
    const results: InstructionSaveOutcome[] = pending.filter((draft) => !requests.has(draft.fileId)).map((draft) => ({
      fileId: draft.fileId, ok: false, message: draft.error ?? draft.message ?? '文件尚不可写、存在冲突或正在保存',
    }))
    for (const [fileId, request] of requests) {
      // 每次发送前和应答后都复核；切换工作区后不能继续提交批次中的旧文件。
      if (!isCurrent()) return false
      const current = instructionPoolRef.current.drafts.find((draft) => draft.fileId === fileId)
      if (current?.saving !== true || current.revision !== request.expectedRevision || current.contextId !== request.contextId) {
        results.push({ fileId, ok: false, message: '文件已重新读取，本次旧草稿未继续保存' })
        continue
      }
      const res = await bridgeCall('agentsFile', request)
      if (!isCurrent()) return false
      const latest = instructionPoolRef.current.drafts.find((draft) => draft.fileId === fileId)
      if (latest?.saving !== true || latest.revision !== request.expectedRevision || latest.contextId !== request.contextId) {
        results.push({ fileId, ok: false, message: '文件已重新读取，迟到保存结果未应用' })
        continue
      }
      const result: InstructionSaveOutcome = res.ok && typeof res.value.revision === 'string'
        ? { fileId, ok: true, revision: res.value.revision }
        : { fileId, ok: false, message: res.ok ? '保存响应缺少文件版本' : res.message ?? '写盘失败', conflict: !res.ok && isInstructionConflictCode(res.code) }
      results.push(result)
      // 已成功的文件立即确认；后续文件失败或切换上下文也不丢失成功基线。
      const settled = applySaveOutcomes(instructionPoolRef.current, [result], requests)
      publishInstructions(settled)
      syncInstructionCards(settled)
    }
    const failures = results.filter((result) => !result.ok)
    if (failures.length > 0) {
      const label = (fileId: string): string => instructionPoolRef.current.drafts.find((draft) => draft.fileId === fileId)?.displayPath ?? fileId
      showNotice('error', `指令文件保存失败（${failures.length}/${results.length}）：${failures.map((failure) => `${label(failure.fileId)}：${failure.message ?? '未知错误'}`).join('；')}`)
      return false
    }
    showNotice('ok', `已保存指令文件：${results.length} 个`)
    return true
  }, [api, publishInstructions, showNotice, syncInstructionCards])

  /**
   * 写单个文件的指令卡策略（独立于预设）：enabled/顺序/位置/晋升/受众/模型范围/显示名。
   * 带读取时 revision 的乐观并发；失败保留快照并提示，不偷偷改本地状态。
   */
  const persistInstructionPolicy = useCallback((policy: InstructionPolicyPatch): Promise<boolean> => saveQueueRef.current.enqueue(async () => {
    const current = instructionPolicyRef.current
    if (current.error !== undefined) {
      showNotice('error', `指令策略不可写：${current.error}`)
      return false
    }
    const res = await bridgeCall('instructionsPolicy', {
      policy,
      expectedRevision: current.revision,
    })
    if (instructionPolicyRef.current !== current) return false
    if (!res.ok || res.value.policy === undefined || res.value.error !== undefined) {
      showNotice('error', '指令策略保存失败：' + (res.ok ? res.value.error ?? '响应缺少策略快照' : res.message ?? 'settings bridge unavailable'))
      return false
    }
    publishInstructionPolicy({ policy: res.value.policy, revision: res.value.revision, exists: res.value.exists })
    syncInstructionCards(instructionPoolRef.current)
    showNotice('ok', '指令策略已保存（影响后续注入，不撤回已进入会话的内容）')
    return true
  }), [publishInstructionPolicy, showNotice, syncInstructionCards])

  const updateInstructionPolicy = useCallback((fileId: string, override: InstructionPolicyFileOverride | null): Promise<boolean> => (
    persistInstructionPolicy(instructionPolicyPatchForFile(fileId, override))
  ), [persistInstructionPolicy])
  const setInstructionSourceEnabled = useCallback((enabled: boolean): Promise<boolean> => (
    persistInstructionPolicy({ enabled })
  ), [persistInstructionPolicy])

  /** 冲突处理：重新读取单个文件并丢弃本地草稿（不自动重载，避免悄悄覆盖用户输入）。 */
  const reloadInstructionFile = useCallback(async (fileId: string): Promise<void> => {
    const sessionId = api.currentSessionId()
    const pool = instructionPoolRef.current
    const draft = pool.drafts.find((entry) => entry.fileId === fileId)
    if (pool.contextId === null || draft?.contextId !== pool.contextId || sessionId !== instructionSessionRef.current) return
    const res = await bridgeCall('promptConfigs', sessionId === undefined ? {} : { sessionId })
    if (sessionId !== api.currentSessionId() || !isCurrentInstructionSeq(instructionPoolRef.current, pool.seq)
      || instructionPoolRef.current.contextId !== pool.contextId) return
    if (instructionPoolRef.current.drafts.find((entry) => entry.fileId === fileId) !== draft) {
      showNotice('error', '重新读取期间文件草稿已更新，本次读取未覆盖新草稿')
      return
    }
    if (!res.ok || res.value.instructions === undefined) {
      showNotice('error', `重新读取指令文件失败：${res.ok ? '未返回指令文件快照' : res.message ?? 'settings bridge unavailable'}`)
      return
    }
    if (res.value.instructions.context.contextId !== pool.contextId) {
      showNotice('error', '指令文件上下文已变化，本次读取未应用；请重新加载工作台')
      return
    }
    const file = res.value.instructions.files.find((entry) => entry.fileId === fileId)
    if (file === undefined) {
      showNotice('error', '该指令文件不在当前工作区范围内，本地草稿已保留但不可写')
      return
    }
    const reset = resetDraftFromSnapshot(instructionPoolRef.current, file)
    publishInstructions(reset)
    syncInstructionCards(reset)
    showNotice('ok', `已重新读取指令文件：${file.displayPath}`)
  }, [api, publishInstructions, showNotice, syncInstructionCards])

  /** 保存后是否静默重载。切换预设时传 false（随后的 settings.mutate 回调会统一 load，
   *  避免一次切换触发两次全量读取）。返回 false = 未写入（切换中/跨预设旧草稿/失败），
   *  调用方（如开关预设）据此中止后续流程。 */
  const persistConfigs = useCallback((configs: PromptConfigDraft[], options?: { reload?: boolean; rebuild?: boolean; includeInstructions?: boolean }): Promise<boolean> => {
    const expectedPresetId = fieldsRef.current.presetTemplate
    const contentEntries = configs.filter(isContentAsset)
    const draftVersion = draftVersionRef.current
    const switchesWereClean = switchesEqual(snapshotSwitches(fieldsRef.current), savedSwitches)
    // 待编辑变量行（空 key）不落盘（服务端 savePresetParams 清理）；此时跳过保存后静默重载，
    // 否则服务端状态覆盖草稿，刚点开的变量编辑行立即消失。
    const pendingVariableRows = hasPendingVariableRows(configs)
    return presetSaveQueueRef.current.enqueue(async () => {
      // 切换进行中（目标预设数据未应用）：fields 仍是旧预设字段，拒绝写入 presetTemplate。
      if (loadedPresetRef.current !== undefined && loadedPresetRef.current !== fieldsRef.current.presetTemplate) {
        showNotice('error', PRESET_PENDING_MESSAGE)
        return false
      }
      if (expectedPresetId !== fieldsRef.current.presetTemplate) {
        showNotice('error', '预设已切换，旧提示词草稿未写入')
        return false
      }
      // 内容资产（preset.md）：合并为单次 /import-preset（批量载荷），服务端只触发一次重建。
      if (contentEntries.length > 0) {
        const contents = contentEntries.map((config) => ({
          scope: 'preset' as const,
          content: config.text ?? '',
        }))
        const res = await bridgeCall('importPreset', { contents, expectedPresetId })
        if (expectedPresetId !== fieldsRef.current.presetTemplate) return false
        if (!res.ok) {
          showNotice('error', 'preset.md 保存失败：' + (res.message ?? 'settings bridge unavailable'))
          return false
        }
      }
      // 指令文件与预设是两类资产：只提交已改动且可写的文件（逐文件版本校验），
      // 未修改的文件不写盘；文件失败不回滚预设写盘，也不假装整体成功。
      const instructionsSaved = options?.includeInstructions === false || await persistInstructionFiles()
      if (expectedPresetId !== fieldsRef.current.presetTemplate) return false
      // promptConfigs 按预设存储：写激活预设 preset.yml（settings 不再承载）。
      // 防御：初始化期空数组自动保存不得覆盖服务端已有配置（历史教训：beta-2-42
      // 的 129 张配置卡被一次清空）；用户主动清空（此前已加载非空配置）允许落盘空数组。
      if (configs.length === 0 && savedConfigs.length === 0) return instructionsSaved
      const res = await bridgeCall('paramOverrides', {
        expectedPresetId,
        // 引擎探测生成的文件卡不进预设（文件即真相）：只持久化用户自己的卡片。
        promptConfigs: configs.filter(isPresetCard).map(stripContentText),
        ...(options?.rebuild === false ? { rebuild: false } : {}),
      })
      if (expectedPresetId !== fieldsRef.current.presetTemplate) return false
      if (res.ok) {
        setSavedConfigs(configs)
        const syncNotice = modelSyncNotice(res.value.modelSync, '提示词配置已保存')
        if (instructionsSaved && syncNotice !== undefined) showNotice(syncNotice.kind, syncNotice.message)
        if (instructionsSaved && options?.reload !== false && !pendingVariableRows && shouldReloadAfterPresetSave(
          draftVersion,
          draftVersionRef.current,
          switchesWereClean && !promptConfigsDirty(fieldsRef.current.promptConfigs, configs),
        )) {
          await load({ silent: true, presetConfigs: configs.filter(isPresetCard) })
        }
        return instructionsSaved
      } else {
        showNotice('error', '提示词配置保存失败：' + (res.message ?? 'settings bridge unavailable'))
        return false
      }
    })
  }, [api, load, persistInstructionFiles, savedConfigs, savedSwitches, showNotice])

  /** 模板变量：写激活预设 preset.yml 内容变量（后端 savePresetParams + afterOverridesChange 触发重建）。 */
  const saveTemplateVariables = useCallback(async (next?: Record<string, string>, enabledOverride?: boolean): Promise<boolean> => {
    // 切换进行中（目标预设数据未应用）：变量仍是旧预设值，拒绝写入 presetTemplate。
    if (loadedPresetRef.current !== undefined && loadedPresetRef.current !== fieldsRef.current.presetTemplate) {
      showNotice('error', PRESET_PENDING_MESSAGE)
      return false
    }
    const expectedPresetId = fieldsRef.current.presetTemplate
    // 空 key 行不落盘，但必须保留在本地草稿，不能把编辑中的整张卡清掉。
    const cleaned = Object.fromEntries(
      Object.entries(next ?? templateVariablesRef.current).filter(([key]) => key.trim().length > 0),
    )
    const res = await bridgeCall('presetVariables', {
      expectedPresetId,
      variables: cleaned,
      // 开关 onChange 与保存同帧触发：优先用调用方传入的新值，避免读到上一帧 enabled。
      enabled: enabledOverride ?? templateVariablesEnabled,
    })
    if (!res.ok) {
      showNotice('error', `模板变量保存失败：${res.message ?? '未知错误'}`)
      return false
    }
    if (expectedPresetId === fieldsRef.current.presetTemplate) savedTemplateVariablesRef.current = cleaned
    return expectedPresetId === fieldsRef.current.presetTemplate
  }, [templateVariablesEnabled, showNotice])

  const toggle = useCallback((key: SwitchKey) => {
    patch({ [key]: !fieldsRef.current[key] })
    if (PARAM_SWITCH_KEYS.has(key)) void persistParamOverrides()
    // writePreset 关闭/开启会重建或移除生成目录：保存后必须重新加载，
    // 否则模块卡片仍显示旧配置（不刷新）。
    else if (key === 'writePreset') void persistSwitches(() => { void load({ silent: true }) })
    else void persistSwitches()
  }, [patch, persistParamOverrides, persistSwitches, load])

  const setPresetTemplate = useCallback(async (id: string) => {
    if (fieldsRef.current.presetTemplate === id) return
    if (hasWorkspaceDrafts(editorDrafts, fieldsRef.current.presetTemplate)) {
      showNotice('error', '当前预设仍有未保存的工具、人设、策略或字段草稿，请返回对应页面保存或修正后再切换')
      return
    }
    await presetSaveQueueRef.current.enqueue(async () => {})
    // 切换即保存：模块列表有未保存的提示词配置修改时先提交（写当前激活预设），
    // 避免切换后 load() 重置 fields 丢失修改。已保存/无修改则直接切换；
    // 保存未成功（失败/被拒）时不切换，把草稿完整留在当前预设。
    const dirtyConfigs = promptConfigsDirty(fieldsRef.current.promptConfigs, savedConfigs)
    if (dirtyConfigs) {
      // 免双 load：保存成功后由下方 enqueueSave 的 onSaved 统一静默重载。
      // 切换前只落盘当前预设，不重建；settings 切换后目标预设只重建一次。
      // 指令文件草稿与预设无关：切换不隐式保存、不清空它们（独立显式保存）。
      const savedDraft = await persistConfigs(fieldsRef.current.promptConfigs, { reload: false, rebuild: false, includeInstructions: false })
      if (!savedDraft) {
        showNotice('error', '当前预设的提示词配置未保存成功，已取消切换')
        return
      }
    }
    const switchResult = await api.switchPreset(id)
    patch({ presetTemplate: id })
    await enqueueSave(
      [{ op: 'set', path: ['presetTemplate'], value: id }],
      switchResult.applied
        ? `已切换预设模板：${id}（当前空会话已重组）`
        : `已切换默认预设模板：${id}`,
      () => {
        if (switchResult.message !== undefined) {
          showNotice('error', switchResult.message)
        }
      },
    )
    // 队列完成后再刷新：新数据应用前 fields 仍是旧预设字段，写路径守卫以此拦截误写。
    await load({ silent: true })
  }, [editorDrafts, enqueueSave, load, patch, persistConfigs, savedConfigs, showNotice])

  const createEngineCapability = useCallback(async (action: 'create' | 'create-recipe', id: string): Promise<boolean> => {
    const request = action === 'create' ? { action: 'create' as const, capabilityId: id } : { action: 'create-recipe' as const, recipeId: id }
    const result = await bridgeCall('engineCapability', { ...request, expectedPresetId: fieldsRef.current.presetTemplate })
    if (!result.ok) {
      showNotice('error', '引擎能力创建失败：' + (result.message ?? 'settings bridge unavailable'))
      return false
    }
    showNotice('ok', result.value.changed ? `已创建引擎能力：${id}` : `引擎能力已存在：${id}`)
    await load({ silent: true })
    return true
  }, [load, showNotice])

  const removeEngineCapability = useCallback(async (id: string): Promise<boolean> => {
    const result = await bridgeCall('engineCapability', { action: 'remove', capabilityId: id, expectedPresetId: fieldsRef.current.presetTemplate })
    if (!result.ok) {
      showNotice('error', '引擎能力删除失败：' + (result.message ?? 'settings bridge unavailable'))
      return false
    }
    showNotice('ok', result.value.changed ? `已删除引擎能力：${id}` : `引擎能力不存在：${id}`)
    await load({ silent: true })
    return true
  }, [load, showNotice])

  /** 从宿主机目录导入技能包：复制进用户技能根，之后由官方提供者直接发现。 */
  const importSkillsDirectory = useCallback(async (path: string): Promise<boolean> => {
    const source = path.trim()
    if (source.length === 0) {
      showNotice('error', '请先填写要导入的目录路径')
      return false
    }
    beginSkillWrite()
    try {
      const res = await bridgeCall('skillsImportDirectory', { path: source })
      if (!res.ok) {
        showNotice('error', '导入技能目录失败：' + (res.message ?? 'settings bridge unavailable'))
        return false
      }
      const { count, overwritten } = res.value
      showNotice('ok', overwritten > 0
        ? `已从 ${source} 复制 ${count} 个文件到用户技能目录，覆盖 ${overwritten} 个同名技能（旧版本已进回收站）`
        : `已从 ${source} 复制 ${count} 个文件到用户技能目录`)
      await load({ silent: true })
      return true
    } catch (error) {
      showNotice('error', '导入技能目录失败：' + errorMessage(error))
      return false
    } finally {
      endSkillWrite()
    }
  }, [load, showNotice])

  /** 创建标准技能：写进用户技能根，官方自动发现。 */
  const createSkill = useCallback(async (input: { name: string; description: string; content: string }): Promise<boolean> => {
    beginSkillWrite()
    try {
      const res = await bridgeCall('skillCreate', input)
      if (!res.ok) {
        showNotice('error', '创建技能失败：' + (res.message ?? 'settings bridge unavailable'))
        return false
      }
      showNotice('ok', `已创建技能：${res.value.id}`)
      await load({ silent: true })
      return true
    } catch (error) {
      showNotice('error', '创建技能失败：' + errorMessage(error))
      return false
    } finally {
      endSkillWrite()
    }
  }, [load, showNotice])

  /** 回收站删除：整个技能目录移入用户根的 .system/prompt-tool/.trash，可人工恢复。 */
  const deleteSkill = useCallback(async (folder: string): Promise<boolean> => {
    beginSkillWrite()
    try {
      const res = await bridgeCall('skillDelete', { folder })
      if (!res.ok) {
        showNotice('error', `删除技能 ${folder} 失败：` + (res.message ?? 'settings bridge unavailable'))
        return false
      }
      showNotice('ok', `已删除技能 ${folder}；目录已移入回收站 ${res.value.path}，可人工恢复`)
      await load({ silent: true })
      return true
    } catch (error) {
      showNotice('error', `删除技能 ${folder} 失败：` + errorMessage(error))
      return false
    } finally {
      endSkillWrite()
    }
  }, [load, showNotice])

  /** 注册层屏蔽开关：只写插件状态，不改任何技能文件；scope='none' 表示恢复该技能。 */
  // 屏蔽开关的并发守卫：scope 由「另一端当前状态 + 本次点击」算出，两次连点若都基于旧状态
  // 就会互相覆盖（后一次带着过期的一端提交）。这里用即时生效的 ref 挡住忙期内的重复提交，
  // 同时置起 skillsBusy，让写盘期间界面上的开关与删除按钮一起禁用。
  const skillBlockRef = useRef(false)
  const setSkillBlocked = useCallback(async (name: string, scope: SkillBlockScope): Promise<boolean> => {
    if (skillBlockRef.current) {
      showNotice('error', '技能屏蔽正在保存，请稍候再试')
      return false
    }
    skillBlockRef.current = true
    beginSkillWrite()
    try {
      const res = await bridgeCall('skillBlock', { name, scope })
      if (!res.ok) {
        showNotice('error', `技能 ${name} 屏蔽设置失败：` + (res.message ?? 'settings bridge unavailable'))
        return false
      }
      showNotice('ok', scope === 'none' ? `已恢复技能：${name}` : `已更新技能 ${name} 的注册层屏蔽`)
      await load({ silent: true })
      return true
    } catch (error) {
      showNotice('error', `技能 ${name} 屏蔽设置失败：` + errorMessage(error))
      return false
    } finally {
      skillBlockRef.current = false
      endSkillWrite()
    }
  }, [load, showNotice])

  /** 添加 / 移除引用的技能文件夹：只记引用，不复制文件。 */
  const patchSkillFolders = useCallback(async (folders: string[]): Promise<boolean> => {
    beginSkillWrite()
    try {
      const res = await bridgeCall('skillsFolders', { folders })
      if (!res.ok) {
        showNotice('error', '技能文件夹保存失败：' + (res.message ?? 'settings bridge unavailable'))
        return false
      }
      showNotice('ok', `已更新技能文件夹引用（${folders.length} 个）`)
      await load({ silent: true })
      return true
    } catch (error) {
      showNotice('error', '技能文件夹保存失败：' + errorMessage(error))
      return false
    } finally {
      endSkillWrite()
    }
  }, [load, showNotice])

  const openSkillsDir = useCallback(async (path?: string) => {
    const target = path ?? fieldsRef.current.skillsRoot
    if (!target) { showNotice('error', '技能目录路径未知，请先重新读取配置'); return }
    try {
      await api.openPath(target)
      showNotice('ok', '已打开技能目录：' + target)
    } catch (error) {
      showNotice('error', '打开失败：' + errorMessage(error))
    }
  }, [api, showNotice])

  const currentSwitches = snapshotSwitches(fields)
  const dirtySwitches = !switchesEqual(currentSwitches, savedSwitches)
  // 预设卡与文件卡分开算脏：文件正文只走显式保存，不进入预设的 debounce 自动保存。
  const presetCards = fields.promptConfigs.filter(isPresetCard)
  const savedPresetCards = savedConfigs.filter(isPresetCard)
  const dirtyPresetConfigs = presetCards.length !== savedPresetCards.length
    || presetCards.some((config, index) => config !== savedPresetCards[index])
  const dirtyInstructions = unsavedInstructionDrafts(instructionPool).length > 0
  const dirtyConfigs = dirtyPresetConfigs || dirtyInstructions
  const dirty = dirtySwitches || dirtyConfigs

  // 任意 UI 修改自动保存：模块列表的提示词配置修改（顶端总开关/卡片字段/增删/排序，
  // 全部经 patch({ promptConfigs }) 落 fields）debounce 后统一走 persistConfigs——
  // 与手动「保存」共用同一写盘逻辑（跳过校验：编辑中间态直存，后端容错；
  // 手动保存按钮仍保留校验路径）。保存成功 load() 更新 savedConfigs → dirty 消失自愈。
  useEffect(() => {
    if (!dirtyPresetConfigs) return
    const timer = setTimeout(() => { void persistConfigs(fields.promptConfigs, { includeInstructions: false }) }, 800)
    return () => clearTimeout(timer)
  }, [dirtyPresetConfigs, fields.promptConfigs, persistConfigs])

  // 返回引用稳定化：memo 子组件以 props.store 同一性跳过父级重渲染（订阅式 selector
  // 化依赖稳定 store 引用）；每次渲染重建内容对象但复用 ref 外壳。
  const storeRef = useRef<PromptToolStore>()
  storeRef.current = {
    editorDrafts,
    api,
    fields,
    getFields,
    subscribeFields,
    meta,
    loading,
    modelCatalog,
    modelReasoning,
    ensureModelReasoning,
    hostDefaultModel,
    moduleFacts,
    skillsDirDraft,
    templatePreStepCount,
    savedSwitches,
    savedConfigs,
    instructionPool,
    getInstructionPool: () => instructionPoolRef.current,
    dirtyInstructions,
    persistInstructionFiles,
    reloadInstructionFile,
    instructionPolicy,
    getInstructionPolicy: () => instructionPolicyRef.current,
    updateInstructionPolicy,
    setInstructionSourceEnabled,
    skillsBusy,
    notice,
    noticeKind,
    load,
    showNotice,
    patch,
    persistSwitches,
    persistParamOverrides,
    persistConfigs,
    templateVariables,
    setTemplateVariables,
    templateVariablesEnabled,
    setTemplateVariablesEnabled,
    saveTemplateVariables,
    toggle,
    setPresetTemplate,
    createEngineCapability,
    removeEngineCapability,
    setSkillsDirDraft,
    importSkillsDirectory,
    createSkill,
    deleteSkill,
    setSkillBlocked,
    patchSkillFolders,
    openSkillsDir,
    dirtySwitches,
    dirtyConfigs,
    dirty,
  }
  return storeRef.current
}
