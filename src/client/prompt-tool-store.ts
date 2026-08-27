import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  IApiClient,
  SettingsNamespaceView,
  SettingsPathOpView,
} from '@deepseek-ai/dsh-client-connection/client'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { EngineMeta, PromptConfigDraft } from './prompt-tool-types.ts'
import {
  EMPTY_FIELDS,
  EMPTY_META,
  bridgePost,
  errorMessage,
  fieldsFromView,
  type BridgeResult,
  type BridgeSettingsView,
  type Fields,
  type HostDefaultModel,
  type StageDraft,
} from './prompt-tool-bridge.ts'

/** rc8 ui-settings 共享镜像传输面：标准字段经官方 settingsScope 读写。 */
export interface PromptToolSettingsTransport {
  /** 宿主注册的 prompt-tool settings namespace 绑定。 */
  scope: SettingsScope<Record<string, unknown>>
  /** 触发一次共享 describe mirror 读取（idle 时才真正发 RPC）。 */
  ensure: () => Promise<void>
  /** 批量 path-op 写入；成功后已把应答 fold 回共享 mirror。 */
  mutate: (ops: SettingsPathOpView[], expectedRevision?: number) => Promise<SettingsNamespaceView>
}

export interface SwitchSnapshot {
  injectAgentsPrompt: boolean
  firstTurnAnchor: boolean
  firstTurnText: string
  firstTurnCustom: boolean
  guideText: string
  guideCustom: boolean
  modelProvider: string
  modelName: string
  subagentModelProvider: string
  subagentModelName: string
  modelReasoningEffort: string
  modelTemperature: string
  modelMaxTokens: string
  subagentReasoningEffort: string
  subagentTemperature: string
  subagentMaxTokens: string
  bootstrapMaxTokens: number
  usePtcMode: boolean
  stages: StageDraft[]
  stagePreUnlock: number
  stageAdvanceTool: string
  stageSectionTemplate: string
  promoteGate: boolean
  promoteAfterFirstResponse: boolean
  maxPromoteSteps: number
  bootstrapTools: string
  compactionTools: string
  personaSectionsOnly: boolean
  workspaceLine: boolean
  instructionHint: boolean
  messageSources: string
  deferredSources: string
  deferredGraceSteps: number
  anchorTurn: boolean
  anchorTurnText: string
  deliberationGate: boolean
  deliberationMinChars: number
  deliberationMaxGatesPerTurn: number
  cotDrip: boolean
  cotDripEvery: number
  cotDripMaxPerTurn: number
  injectPrompt: boolean
  skillSwitches: Record<string, boolean>
  skillOrder: string[]
  skillsDirs: string[]
  skillRankBase: number
  residentAgentsPath: string
  presetDir: string
  presetOrder: number
  fallbackText: string
  writeAgents: boolean
  writePreset: boolean
}

const EMPTY_SWITCHES: SwitchSnapshot = {
  injectAgentsPrompt: false,
  firstTurnAnchor: false,
  firstTurnText: '',
  firstTurnCustom: false,
  guideText: '',
  guideCustom: false,
  modelProvider: '',
  modelName: '',
  subagentModelProvider: '',
  subagentModelName: '',
  modelReasoningEffort: '',
  modelTemperature: '',
  modelMaxTokens: '',
  subagentReasoningEffort: '',
  subagentTemperature: '',
  subagentMaxTokens: '',
  bootstrapMaxTokens: 0,
  usePtcMode: false,
  stages: [],
  stagePreUnlock: 0,
  stageAdvanceTool: '',
  stageSectionTemplate: '',
  promoteGate: false,
  promoteAfterFirstResponse: false,
  maxPromoteSteps: 0,
  bootstrapTools: '',
  compactionTools: '',
  personaSectionsOnly: false,
  workspaceLine: false,
  instructionHint: false,
  messageSources: '',
  deferredSources: '',
  deferredGraceSteps: 0,
  anchorTurn: false,
  anchorTurnText: '',
  deliberationGate: false,
  deliberationMinChars: 0,
  deliberationMaxGatesPerTurn: 0,
  cotDrip: false,
  cotDripEvery: 0,
  cotDripMaxPerTurn: 0,
  injectPrompt: true,
  skillSwitches: {},
  skillOrder: [],
  skillsDirs: [],
  skillRankBase: 250,
  residentAgentsPath: '',
  presetDir: '',
  presetOrder: 5,
  fallbackText: '',
  writeAgents: true,
  writePreset: true,
}

/** 本项目默认不设上限时的显示值（adapter 默认 maxTokens）。 */
const DEFAULT_BOOTSTRAP_DISPLAY = '256000'

/** 内容资产条目：preset.md（prompt-injector）/ agents.md（instruction-hint），
 *  text 走生成目录文件通道，settings 覆盖层只存轻字段。 */
const isContentAsset = (config: PromptConfigDraft): boolean =>
  config.id === 'prompt-injector' || config.fill === 'instruction-hint'

/** 剥离内容资产的 text（顶层 + params.text）：settings 载荷不承载大文本。 */
const stripContentText = (config: PromptConfigDraft): PromptConfigDraft => {
  const next: PromptConfigDraft = { ...config }
  delete next.text
  if (next.params !== undefined) {
    const params = { ...next.params }
    delete params.text
    next.params = params
  }
  return next
}

/** 渲染产物 → 编辑草稿：内容资产条目的 params.text（生成目录文件内容）提升到 text 框显示。 */
const liftContentText = (config: PromptConfigDraft): PromptConfigDraft => {
  if (!isContentAsset(config)) return config
  if ((config.text ?? '') !== '') return config
  const text = typeof config.params?.text === 'string' ? config.params.text : ''
  return text.length > 0 ? { ...config, text } : config
}

export const snapshotSwitches = (fields: Fields): SwitchSnapshot => ({
  injectAgentsPrompt: fields.injectAgentsPrompt,
  firstTurnAnchor: fields.firstTurnAnchor,
  firstTurnText: fields.firstTurnText,
  firstTurnCustom: fields.firstTurnCustom,
  guideText: fields.guideText,
  guideCustom: fields.guideCustom,
  modelProvider: fields.modelProvider,
  modelName: fields.modelName,
  subagentModelProvider: fields.subagentModelProvider,
  subagentModelName: fields.subagentModelName,
  modelReasoningEffort: fields.modelReasoningEffort,
  modelTemperature: fields.modelTemperature,
  modelMaxTokens: fields.modelMaxTokens,
  subagentReasoningEffort: fields.subagentReasoningEffort,
  subagentTemperature: fields.subagentTemperature,
  subagentMaxTokens: fields.subagentMaxTokens,
  bootstrapMaxTokens: fields.bootstrapMaxTokens,
  usePtcMode: fields.usePtcMode,
  stages: fields.stages.map((stage) => ({ ...stage })),
  stagePreUnlock: fields.stagePreUnlock,
  stageAdvanceTool: fields.stageAdvanceTool,
  stageSectionTemplate: fields.stageSectionTemplate,
  promoteGate: fields.promoteGate,
  promoteAfterFirstResponse: fields.promoteAfterFirstResponse,
  maxPromoteSteps: fields.maxPromoteSteps,
  bootstrapTools: fields.bootstrapTools,
  compactionTools: fields.compactionTools,
  personaSectionsOnly: fields.personaSectionsOnly,
  workspaceLine: fields.workspaceLine,
  instructionHint: fields.instructionHint,
  messageSources: fields.messageSources,
  deferredSources: fields.deferredSources,
  deferredGraceSteps: fields.deferredGraceSteps,
  anchorTurn: fields.anchorTurn,
  anchorTurnText: fields.anchorTurnText,
  deliberationGate: fields.deliberationGate,
  deliberationMinChars: fields.deliberationMinChars,
  deliberationMaxGatesPerTurn: fields.deliberationMaxGatesPerTurn,
  cotDrip: fields.cotDrip,
  cotDripEvery: fields.cotDripEvery,
  cotDripMaxPerTurn: fields.cotDripMaxPerTurn,
  injectPrompt: fields.injectPrompt,
  skillSwitches: { ...fields.skillSwitches },
  skillOrder: [...fields.skillOrder],
  skillsDirs: [...fields.skillsDirs],
  skillRankBase: fields.skillRankBase,
  residentAgentsPath: fields.residentAgentsPath,
  presetDir: fields.presetDir,
  presetOrder: fields.presetOrder,
  fallbackText: fields.fallbackText,
  writeAgents: fields.writeAgents,
  writePreset: fields.writePreset,
})

const switchesEqual = (a: SwitchSnapshot, b: SwitchSnapshot): boolean =>
  a.injectAgentsPrompt === b.injectAgentsPrompt
  && a.firstTurnAnchor === b.firstTurnAnchor
  && a.firstTurnText === b.firstTurnText
  && a.firstTurnCustom === b.firstTurnCustom
  && a.guideText === b.guideText
  && a.guideCustom === b.guideCustom
  && a.modelProvider === b.modelProvider
  && a.modelName === b.modelName
  && a.subagentModelProvider === b.subagentModelProvider
  && a.subagentModelName === b.subagentModelName
  && a.modelReasoningEffort === b.modelReasoningEffort
  && a.modelTemperature === b.modelTemperature
  && a.modelMaxTokens === b.modelMaxTokens
  && a.subagentReasoningEffort === b.subagentReasoningEffort
  && a.subagentTemperature === b.subagentTemperature
  && a.subagentMaxTokens === b.subagentMaxTokens
  && a.bootstrapMaxTokens === b.bootstrapMaxTokens
  && a.usePtcMode === b.usePtcMode
  && a.injectPrompt === b.injectPrompt
  && JSON.stringify(a.skillSwitches) === JSON.stringify(b.skillSwitches)
  && JSON.stringify(a.skillOrder) === JSON.stringify(b.skillOrder)
  && JSON.stringify(a.skillsDirs) === JSON.stringify(b.skillsDirs)
  && a.skillRankBase === b.skillRankBase
  && a.residentAgentsPath === b.residentAgentsPath
  && a.presetDir === b.presetDir
  && a.presetOrder === b.presetOrder
  && a.fallbackText === b.fallbackText
  && a.writeAgents === b.writeAgents
  && a.writePreset === b.writePreset

export type SwitchKey = 'injectAgentsPrompt' | 'firstTurnAnchor' | 'firstTurnCustom' | 'guideCustom' | 'injectPrompt' | 'usePtcMode' | 'promoteGate' | 'promoteAfterFirstResponse' | 'personaSectionsOnly' | 'workspaceLine' | 'instructionHint' | 'anchorTurn' | 'deliberationGate' | 'cotDrip' | 'writeAgents' | 'writePreset'

/** 参数类布尔开关：写激活预设 preset.yml（settings 只留全局开关）。 */
const PARAM_SWITCH_KEYS: ReadonlySet<SwitchKey> = new Set(['firstTurnAnchor', 'firstTurnCustom', 'guideCustom', 'injectPrompt', 'usePtcMode', 'promoteGate', 'promoteAfterFirstResponse', 'personaSectionsOnly', 'workspaceLine', 'instructionHint', 'anchorTurn', 'deliberationGate', 'cotDrip'])

export interface PromptToolStore {
  fields: Fields
  meta: EngineMeta
  loading: boolean
  providers: string[]
  modelCatalog: Record<string, string[]>
  hostDefaultModel?: HostDefaultModel
  bootstrapTokensDraft: string
  /** 新技能目录路径输入（多目录卡片：输入路径添加）。 */
  skillsDirDraft: string
  /** 当前预设模板消息批层（pre-step）配置数；0 = 模板无配置（入口开关联动关闭）。 */
  templatePreStepCount: number
  savedSwitches: SwitchSnapshot
  savedConfigs: PromptConfigDraft[]
  savingSkillsDir: boolean
  fixingSkill: string | undefined
  notice: string
  noticeKind: 'ok' | 'error'
  load: () => Promise<Fields>
  showNotice: (kind: 'ok' | 'error', message: string) => void
  patch: (partial: Partial<Fields>) => void
  persistSwitches: () => void
  persistParamOverrides: () => Promise<void>
  persistConfigs: (configs: PromptConfigDraft[]) => void
  /** 预设级模板变量（preset.yml 内容变量；writePreset 展开进 variables.yml，引擎合并进每条配置）。 */
  templateVariables: Record<string, string>
  setTemplateVariables: (value: Record<string, string>) => void
  /** 模板变量插值开关（preset.yml 顶层 variablesEnabled，缺省 true）。 */
  templateVariablesEnabled: boolean
  setTemplateVariablesEnabled: (value: boolean) => void
  /** 保存模板变量；可显式传入下一份值（如清空场景，避免 setState 未生效时的旧闭包）。 */
  saveTemplateVariables: (next?: Record<string, string>) => Promise<void>
  toggle: (key: SwitchKey) => void
  toggleBootstrapMaxTokens: () => void
  setPresetTemplate: (id: string) => void
  setBootstrapTokensDraft: (value: string) => void
  commitBootstrapTokensDraft: () => void
  /** 门控回退步数草稿（数字输入，失焦提交；0 = 引擎默认 4）。 */
  gateStepsDraft: string
  setGateStepsDraft: (value: string) => void
  commitGateStepsDraft: () => void
  setSkillsDirDraft: (value: string) => void
  /** 追加技能目录（按添加顺序；重复路径拒绝）。 */
  addSkillsDir: (dir: string) => void
  /** 移除技能目录引用（只删引用，不删原文件）。 */
  removeSkillsDir: (dir: string) => void
  toggleSkill: (folder: string) => void
  skillEnabled: (folder: string) => boolean
  fixSkill: (folder: string) => void
  /** 打开指定技能目录；不传 = 打开第一个生效目录。 */
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

/** 把 rc8 scope 快照 + 自定义 /describe 的 runtime facts 组装成旧 BridgeResult 视图。 */
function bridgeViewFromScope(
  snapshot: SettingsScopeSnapshot<Record<string, unknown>>,
  runtime: BridgeResult<BridgeSettingsView>,
): BridgeResult<BridgeSettingsView> {
  if (snapshot.status !== 'ready' || snapshot.value === undefined) {
    return {
      ok: false,
      message: snapshot.status === 'unavailable'
        ? 'settings namespace "prompt-tool" is not exposed'
        : 'settings namespace "prompt-tool" is not ready',
    }
  }
  return {
    ok: true,
    value: {
      ns: 'prompt-tool',
      value: snapshot.value,
      base: snapshot.base,
      revision: snapshot.revision ?? 0,
    },
    providers: runtime.ok ? runtime.providers : undefined,
    modelCatalog: runtime.ok ? runtime.modelCatalog : undefined,
    activeSkillsDirs: runtime.ok ? runtime.activeSkillsDirs : undefined,
    skillCatalog: runtime.ok ? runtime.skillCatalog : undefined,
    templatePreStepCount: runtime.ok ? runtime.templatePreStepCount : undefined,
    hostDefaultModel: runtime.ok ? runtime.hostDefaultModel : undefined,
  }
}

export function usePromptToolStore(api: IApiClient, settings: PromptToolSettingsTransport): PromptToolStore {
  const [providers, setProviders] = useState<string[]>([])
  const [modelCatalog, setModelCatalog] = useState<Record<string, string[]>>({})
  const [hostDefaultModel, setHostDefaultModel] = useState<HostDefaultModel | undefined>(undefined)
  const [fields, setFields] = useState<Fields>(EMPTY_FIELDS)
  const [meta, setMeta] = useState<EngineMeta>(EMPTY_META)
  const [bootstrapTokensDraft, setBootstrapTokensDraft] = useState(DEFAULT_BOOTSTRAP_DISPLAY)
  const [gateStepsDraft, setGateStepsDraft] = useState('4')
  const [skillsDirDraft, setSkillsDirDraft] = useState('')
  const [templatePreStepCount, setTemplatePreStepCount] = useState(0)
  const [savedSwitches, setSavedSwitches] = useState<SwitchSnapshot>(EMPTY_SWITCHES)
  const [savedConfigs, setSavedConfigs] = useState<PromptConfigDraft[]>([])
  const [templateVariables, setTemplateVariables] = useState<Record<string, string>>({})
  const [templateVariablesEnabled, setTemplateVariablesEnabled] = useState(true)
  const [loading, setLoading] = useState(false)
  const [savingSkillsDir, setSavingSkillsDir] = useState(false)
  const [fixingSkill, setFixingSkill] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState('')
  const [noticeKind, setNoticeKind] = useState<'ok' | 'error'>('ok')
  const fieldsRef = useRef<Fields>(EMPTY_FIELDS)
  const revisionRef = useRef<number | undefined>(undefined)
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const loadSeqRef = useRef(0)
  /** 最近一次 load 时 preset.yml params 现有键集：persist 只发送「已有键或已改动」，
   *  未动过的键不写——避免 UI 默认值固化覆盖模板 moduleConfigs 默认（liangshen 等）。 */
  const loadedKeysRef = useRef<Set<string>>(new Set())

  const showNotice = useCallback((kind: 'ok' | 'error', message: string) => {
    setNotice(message)
    setNoticeKind(kind)
  }, [])

  /** 模型目录惰性加载：独立于主 load（/describe 不再阻塞等模型查询）。 */
  const loadModels = useCallback(async (): Promise<void> => {
    const res = await bridgePost<{ modelCatalog: Record<string, string[]> }>('/models', {})
    if (res.ok) setModelCatalog(res.value.modelCatalog ?? {})
  }, [])

  const applyView = useCallback((res: BridgeResult<BridgeSettingsView>): Fields => {
    setTemplatePreStepCount(res.ok && typeof res.templatePreStepCount === 'number' ? res.templatePreStepCount : 0)
    setProviders(res.ok ? res.providers ?? [] : [])
    setModelCatalog(res.ok ? res.modelCatalog ?? {} : {})
    setHostDefaultModel(res.ok ? res.hostDefaultModel : undefined)
    const next = fieldsFromView(res)
    // 引擎参数按预设存储（激活预设 preset.yml）：settings 不再承载，
    // 参数键由 /describe 的 presetParams 合并（类型匹配键覆盖，其余保持）。
    if (res.ok && res.presetParams !== undefined) {
      const params = res.presetParams
      const nextRecord = next as unknown as Record<string, unknown>
      for (const key of Object.keys(params)) {
        const value = params[key]
        if (value === undefined || value === null || key === 'promptConfigs') continue
        const current = nextRecord[key]
        if (current === undefined) continue
        if (typeof current === 'boolean' && typeof value === 'boolean') {
          nextRecord[key] = value
        } else if (typeof current === 'number' && typeof value === 'number') {
          nextRecord[key] = value
        } else if (typeof current === 'string' && typeof value === 'string') {
          nextRecord[key] = value
        }
      }
    }
    // 检测到 DeepSeek 路由且用户未设置服务商时，直接预选第一个检测到的 provider
    // （模型名为空则路由不激活，继承主会话语义不变；用户后续选择模型名即生效）。
    if (res.ok && next.modelProvider === '' && (res.providers?.length ?? 0) > 0) {
      next.modelProvider = res.providers![0]!
    }
    // 子代理服务商同样预选：模型名为空则固定路由不激活（继承主会话），仅让模型名下拉有候选。
    if (res.ok && next.subagentModelProvider === '' && (res.providers?.length ?? 0) > 0) {
      next.subagentModelProvider = res.providers![0]!
    }
    fieldsRef.current = next
    setFields(next)
    setBootstrapTokensDraft(next.bootstrapMaxTokens > 0 ? String(next.bootstrapMaxTokens) : DEFAULT_BOOTSTRAP_DISPLAY)
    setGateStepsDraft(next.maxPromoteSteps > 0 ? String(next.maxPromoteSteps) : '4')
    setSkillsDirDraft('')
    setSavedSwitches(snapshotSwitches(next))
    setSavedConfigs(next.promptConfigs)
    if (res.ok) revisionRef.current = res.value.revision
    return next
  }, [])

  const load = useCallback(async (options?: { silent?: boolean }) => {
    // 并发保护：慢的旧请求不得覆盖新请求（last-good 语义保留旧数据）。
    const seq = ++loadSeqRef.current
    // silent：保存后静默刷新（不闪 loading、避免重渲染风暴与滚动跳动）；失败仍报错。
    if (!options?.silent) setLoading(true)
    try {
      const metaRes = await bridgePost<{ meta: EngineMeta }>('/meta', {})
      if (seq !== loadSeqRef.current) return EMPTY_FIELDS
      if (metaRes.ok) setMeta(metaRes.value.meta)
      // 自定义 /describe 只用于拿到 live runtime facts（DeepSeek 检测、技能目录快照），
      // 标准 settings 分层数据来自 rc8 共享 describe mirror 的 scope。
      const runtime = await bridgePost<BridgeSettingsView>('/describe', {})
      await settings.ensure()
      const snapshot = await waitForScope(settings.scope)
      const res = bridgeViewFromScope(snapshot, runtime)
      if (seq !== loadSeqRef.current) return EMPTY_FIELDS
      if (!res.ok) {
        showNotice('error', '读取配置失败：' + (res.message ?? ''))
        return EMPTY_FIELDS
      }
      applyView(res)
      // 用户参数覆盖（激活预设 preset.yml params；settings 不再承载参数）。
      const overridesRes = await bridgePost<{ overrides: Record<string, unknown> }>('/param-overrides', {})
      if (seq !== loadSeqRef.current) return EMPTY_FIELDS
      if (overridesRes.ok) {
        const o = overridesRes.value.overrides
        loadedKeysRef.current = new Set(Object.keys(o))
        const paramPatch: Partial<Fields> = {}
        if (typeof o.firstTurnAnchor === 'boolean') paramPatch.firstTurnAnchor = o.firstTurnAnchor
        if (typeof o.firstTurnText === 'string') paramPatch.firstTurnText = o.firstTurnText
        if (typeof o.firstTurnCustom === 'boolean') paramPatch.firstTurnCustom = o.firstTurnCustom
        if (typeof o.guideText === 'string') paramPatch.guideText = o.guideText
        if (typeof o.guideCustom === 'boolean') paramPatch.guideCustom = o.guideCustom
        if (typeof o.modelProvider === 'string') paramPatch.modelProvider = o.modelProvider
        if (typeof o.modelName === 'string') paramPatch.modelName = o.modelName
        if (typeof o.subagentModelProvider === 'string') paramPatch.subagentModelProvider = o.subagentModelProvider
        if (typeof o.subagentModelName === 'string') paramPatch.subagentModelName = o.subagentModelName
        // 模型参数三件套（主对话 + 子代理）：引擎按这些 params 生成 model-params
        // 配置（agent-request patch），UI 侧统一在「模型设置」卡片编辑显示，
        // 不依赖模块列表里的 model-params 卡片。
        if (typeof o.modelReasoningEffort === 'string') paramPatch.modelReasoningEffort = o.modelReasoningEffort
        if (typeof o.modelTemperature === 'string') paramPatch.modelTemperature = o.modelTemperature
        if (typeof o.modelMaxTokens === 'string') paramPatch.modelMaxTokens = o.modelMaxTokens
        if (typeof o.subagentReasoningEffort === 'string') paramPatch.subagentReasoningEffort = o.subagentReasoningEffort
        if (typeof o.subagentTemperature === 'string') paramPatch.subagentTemperature = o.subagentTemperature
        if (typeof o.subagentMaxTokens === 'string') paramPatch.subagentMaxTokens = o.subagentMaxTokens
        if (typeof o.usePtcMode === 'boolean') paramPatch.usePtcMode = o.usePtcMode
        if (typeof o.injectPrompt === 'boolean') paramPatch.injectPrompt = o.injectPrompt
        if (Array.isArray(o.toolFilterAllow)) paramPatch.toolFilterAllow = o.toolFilterAllow.join(', ')
        else if (typeof o.toolFilterAllow === 'string') paramPatch.toolFilterAllow = o.toolFilterAllow
        if (Array.isArray(o.toolFilterDeny)) paramPatch.toolFilterDeny = o.toolFilterDeny.join(', ')
        else if (typeof o.toolFilterDeny === 'string') paramPatch.toolFilterDeny = o.toolFilterDeny
        if (o.maxDepth !== undefined && o.maxDepth !== null && o.maxDepth !== '') {
          paramPatch.maxDepth = String(o.maxDepth)
        }
        if (Array.isArray(o.allowKinds)) paramPatch.allowKinds = o.allowKinds.join(', ')
        else if (typeof o.allowKinds === 'string') paramPatch.allowKinds = o.allowKinds
        if (typeof o.firstTurnWord === 'string') paramPatch.firstTurnWord = o.firstTurnWord
        if (typeof o.bootstrapMaxTokens === 'number') paramPatch.bootstrapMaxTokens = o.bootstrapMaxTokens
        // 晋升门控（tool-bootstrap 参数桥）。
        if (typeof o.promoteGate === 'boolean') paramPatch.promoteGate = o.promoteGate
        if (typeof o.promoteAfterFirstResponse === 'boolean') paramPatch.promoteAfterFirstResponse = o.promoteAfterFirstResponse
        if (typeof o.maxPromoteSteps === 'number') paramPatch.maxPromoteSteps = o.maxPromoteSteps
        if (Array.isArray(o.bootstrapTools)) paramPatch.bootstrapTools = o.bootstrapTools.join(', ')
        else if (typeof o.bootstrapTools === 'string') paramPatch.bootstrapTools = o.bootstrapTools
        if (Array.isArray(o.compactionTools)) paramPatch.compactionTools = o.compactionTools.join(', ')
        else if (typeof o.compactionTools === 'string') paramPatch.compactionTools = o.compactionTools
        // 渐进披露（stages 模式）：引擎形态 [{name, tools: string[]}] → UI 草稿。
        if (Array.isArray(o.stages)) {
          paramPatch.stages = o.stages
            .filter((stage): stage is { name?: unknown; tools?: unknown } =>
              stage !== null && typeof stage === 'object')
            .map((stage) => ({
              name: typeof stage.name === 'string' ? stage.name : '',
              tools: Array.isArray(stage.tools)
                ? stage.tools.filter((item): item is string => typeof item === 'string').join(', ')
                : '',
            }))
        }
        if (typeof o.stagePreUnlock === 'number') paramPatch.stagePreUnlock = o.stagePreUnlock
        if (typeof o.stageAdvanceTool === 'string') paramPatch.stageAdvanceTool = o.stageAdvanceTool
        if (typeof o.stageSectionTemplate === 'string') paramPatch.stageSectionTemplate = o.stageSectionTemplate
        if (typeof o.personaSectionsOnly === 'boolean') paramPatch.personaSectionsOnly = o.personaSectionsOnly
        if (typeof o.workspaceLine === 'boolean') paramPatch.workspaceLine = o.workspaceLine
        if (typeof o.instructionHint === 'boolean') paramPatch.instructionHint = o.instructionHint
        // context-gate 注入门控。
        if (Array.isArray(o.messageSources)) paramPatch.messageSources = o.messageSources.join(', ')
        else if (typeof o.messageSources === 'string') paramPatch.messageSources = o.messageSources
        if (Array.isArray(o.deferredSources)) paramPatch.deferredSources = o.deferredSources.join(', ')
        else if (typeof o.deferredSources === 'string') paramPatch.deferredSources = o.deferredSources
        if (typeof o.deferredGraceSteps === 'number') paramPatch.deferredGraceSteps = o.deferredGraceSteps
        // 锚定/深思可选模块（anchor-turn / deliberation-gate / cot-drip 参数桥）。
        if (typeof o.anchorTurn === 'boolean') paramPatch.anchorTurn = o.anchorTurn
        if (typeof o.anchorTurnText === 'string') paramPatch.anchorTurnText = o.anchorTurnText
        if (typeof o.deliberationGate === 'boolean') paramPatch.deliberationGate = o.deliberationGate
        if (typeof o.deliberationMinChars === 'number') paramPatch.deliberationMinChars = o.deliberationMinChars
        if (typeof o.deliberationMaxGatesPerTurn === 'number') paramPatch.deliberationMaxGatesPerTurn = o.deliberationMaxGatesPerTurn
        if (typeof o.cotDrip === 'boolean') paramPatch.cotDrip = o.cotDrip
        if (typeof o.cotDripEvery === 'number') paramPatch.cotDripEvery = o.cotDripEvery
        if (typeof o.cotDripMaxPerTurn === 'number') paramPatch.cotDripMaxPerTurn = o.cotDripMaxPerTurn
        if (Object.keys(paramPatch).length > 0) {
          const next = { ...fieldsRef.current, ...paramPatch }
          fieldsRef.current = next
          setFields(next)
          setSavedSwitches(snapshotSwitches(next))
        }
      }
      // 预设级模板变量（preset.yml 内容变量；失败不阻断主流程）。
      const varsRes = await bridgePost<{ variables: Record<string, string>; enabled: boolean }>('/preset-variables', {})
      if (seq !== loadSeqRef.current) return EMPTY_FIELDS
      if (varsRes.ok && varsRes.value.variables !== null && typeof varsRes.value.variables === 'object') {
        setTemplateVariables(varsRes.value.variables)
        setTemplateVariablesEnabled(varsRes.value.enabled !== false)
      }
      // 实际生效配置（引擎从生成目录加载；settings.promptConfigs 仅为覆盖层，
      // 默认为空不代表无配置）。非空时以实际配置为准，并同步已保存快照避免误判 dirty。
      const configsRes = await bridgePost<{ promptConfigs: PromptConfigDraft[] }>('/prompt-configs', {})
      if (seq !== loadSeqRef.current) return EMPTY_FIELDS
      if (configsRes.ok && Array.isArray(configsRes.value.promptConfigs) && configsRes.value.promptConfigs.length > 0) {
        // 引擎自动生成的模型参数配置（model-params / subagent-model-params）由
        // 「模型设置」卡片管理，不进入模块列表（避免重复编辑入口）。
        const engineGenerated = new Set(['model-params', 'subagent-model-params'])
        const userConfigs = configsRes.value.promptConfigs.filter((config) => !engineGenerated.has(config.id))
        // 内容资产条目（prompt-injector / instruction-hint）：params.text（生成目录文件渲染产物）
        // 提升到 text 框显示，编辑入口统一为模块卡片。
        const actual = userConfigs.map(liftContentText)
        const next = { ...fieldsRef.current, promptConfigs: actual }
        fieldsRef.current = next
        setFields(next)
        setSavedConfigs(actual)
      }
      setNotice('')
      return fieldsRef.current
    } catch (error) {
      showNotice('error', '读取失败：' + errorMessage(error))
      return EMPTY_FIELDS
    } finally {
      if (seq === loadSeqRef.current && !options?.silent) setLoading(false)
    }
  }, [applyView, settings, showNotice])

  // 挂载即后台拉取模型目录（不阻塞工作台首屏；10min 缓存兜底重复打开）。
  useEffect(() => {
    void loadModels()
  }, [loadModels])

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
    let next = { ...fieldsRef.current, ...partial }
    // complete 互斥：system-section/persona 共用官方 complete 语义（预设内仅一个），
    // 开启任一 enabled 配置的 complete 时自动关闭其他 enabled 配置的 complete。
    // disabled 配置不参与（引擎 effectiveList 已过滤，不注册即不独占；重新启用时由本次收敛）。
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
    fieldsRef.current = next
    setFields(next)
  }, [])

  const enqueueSave = useCallback((ops: SettingsPathOpView[], okMessage: string | undefined, onSaved: () => void, setBusy?: (busy: boolean) => void) => {
    setBusy?.(true)
    saveQueueRef.current = saveQueueRef.current.then(async () => {
      try {
        const view = await settings.mutate(ops, revisionRef.current)
        revisionRef.current = view.revision
        onSaved()
        if (okMessage) showNotice('ok', okMessage)
      } catch (error) {
        await refreshRevision()
        showNotice('error', '保存失败：' + errorMessage(error) + '（已刷新配置版本，可重试）')
      } finally {
        setBusy?.(false)
      }
    }).catch(() => {})
  }, [refreshRevision, settings, showNotice])

  const persistSwitches = useCallback((onSaved?: () => void) => enqueueSave(
    [
      { op: 'set', path: ['injectAgentsPrompt'], value: fieldsRef.current.injectAgentsPrompt },
      { op: 'set', path: ['skillSwitches'], value: fieldsRef.current.skillSwitches },
      { op: 'set', path: ['skillOrder'], value: fieldsRef.current.skillOrder },
      { op: 'set', path: ['skillsDirs'], value: fieldsRef.current.skillsDirs },
      { op: 'set', path: ['skillRankBase'], value: fieldsRef.current.skillRankBase },
      { op: 'set', path: ['residentAgentsPath'], value: fieldsRef.current.residentAgentsPath },
      { op: 'set', path: ['presetDir'], value: fieldsRef.current.presetDir },
      { op: 'set', path: ['presetOrder'], value: fieldsRef.current.presetOrder },
      { op: 'set', path: ['fallbackText'], value: fieldsRef.current.fallbackText },
      { op: 'set', path: ['writeAgents'], value: fieldsRef.current.writeAgents },
      { op: 'set', path: ['writePreset'], value: fieldsRef.current.writePreset },
    ],
    undefined,
    () => {
      setSavedSwitches(snapshotSwitches(fieldsRef.current))
      onSaved?.()
    },
  ), [enqueueSave])

  /** 参数类设置：写入激活预设 preset.yml（savePresetParams；随预设隔离）。 */
  const persistParamOverrides = useCallback(async () => {
    const f = fieldsRef.current
    const splitList = (value: string): string[] => value.split(',').map((item) => item.trim()).filter((item) => item.length > 0)
    const loadedKeys = loadedKeysRef.current
    // 条件发送：preset.yml 已有该键（含模板默认键）或字段值 != UI 默认 → 发送；
    // 未动过的键不写——既保留「改回留空清旧值」（已有键总是发送空值删键），
    // 又避免 UI 默认值固化覆盖模板 moduleConfigs 默认（liangshen promoteGate=true
    // 等被首次保存的 false 静默改写——参数桥优先后的回归）。
    const emit = (key: string, value: unknown, empty: unknown): Record<string, unknown> =>
      loadedKeys.has(key) || JSON.stringify(value) !== JSON.stringify(empty) ? { [key]: value } : {}
    const res = await bridgePost<{ overrides: unknown }>('/param-overrides', {
      overrides: {
        ...emit('firstTurnAnchor', f.firstTurnAnchor, false),
        ...emit('firstTurnText', f.firstTurnText, ''),
        ...emit('firstTurnCustom', f.firstTurnCustom, false),
        ...emit('guideText', f.guideText, ''),
        ...emit('guideCustom', f.guideCustom, false),
        ...emit('usePtcMode', f.usePtcMode, false),
        ...emit('injectPrompt', f.injectPrompt, true),
        ...emit('modelProvider', f.modelProvider, ''),
        ...emit('modelName', f.modelName, ''),
        ...emit('subagentModelProvider', f.subagentModelProvider, ''),
        ...emit('subagentModelName', f.subagentModelName, ''),
        ...emit('modelReasoningEffort', f.modelReasoningEffort, ''),
        ...emit('modelTemperature', f.modelTemperature, ''),
        ...emit('modelMaxTokens', f.modelMaxTokens, ''),
        ...emit('subagentReasoningEffort', f.subagentReasoningEffort, ''),
        ...emit('subagentTemperature', f.subagentTemperature, ''),
        ...emit('subagentMaxTokens', f.subagentMaxTokens, ''),
        ...emit('toolFilterAllow', splitList(f.toolFilterAllow), []),
        ...emit('toolFilterDeny', splitList(f.toolFilterDeny), []),
        ...emit('maxDepth', f.maxDepth === '' ? '' : f.maxDepth === 'provider-managed' ? 'provider-managed' : Number(f.maxDepth), ''),
        ...emit('allowKinds', splitList(f.allowKinds), []),
        ...emit('firstTurnWord', f.firstTurnWord, ''),
        ...emit('bootstrapMaxTokens', f.bootstrapMaxTokens, 0),
        // 晋升门控/渐进披露/验证工具：已有键或已改动才发送；空值由 savePresetParams
        // 删键回落模板/引擎默认；false/0 引擎布尔归一或默认等价。
        ...emit('promoteGate', f.promoteGate, false),
        ...emit('promoteAfterFirstResponse', f.promoteAfterFirstResponse, false),
        ...emit('maxPromoteSteps', f.maxPromoteSteps, 0),
        ...emit('bootstrapTools', splitList(f.bootstrapTools), []),
        ...emit('compactionTools', splitList(f.compactionTools), []),
        ...emit('stages', f.stages
          .map((stage) => ({
            name: stage.name.trim(),
            tools: splitList(stage.tools),
          }))
          .filter((stage) => stage.name.length > 0 && stage.tools.length > 0), []),
        ...emit('stagePreUnlock', f.stagePreUnlock, 0),
        ...emit('stageAdvanceTool', f.stageAdvanceTool, ''),
        ...emit('stageSectionTemplate', f.stageSectionTemplate, ''),
        ...emit('personaSectionsOnly', f.personaSectionsOnly, false),
        ...emit('workspaceLine', f.workspaceLine, false),
        ...emit('instructionHint', f.instructionHint, false),
        // context-gate 注入门控。
        ...emit('messageSources', splitList(f.messageSources), []),
        ...emit('deferredSources', splitList(f.deferredSources), []),
        ...emit('deferredGraceSteps', f.deferredGraceSteps, 0),
        // 锚定/深思可选模块：已有键或已改动才发送；false/0 引擎布尔归一或默认等价。
        ...emit('anchorTurn', f.anchorTurn, false),
        ...emit('anchorTurnText', f.anchorTurnText, ''),
        ...emit('deliberationGate', f.deliberationGate, false),
        ...emit('deliberationMinChars', f.deliberationMinChars, 0),
        ...emit('deliberationMaxGatesPerTurn', f.deliberationMaxGatesPerTurn, 0),
        ...emit('cotDrip', f.cotDrip, false),
        ...emit('cotDripEvery', f.cotDripEvery, 0),
        ...emit('cotDripMaxPerTurn', f.cotDripMaxPerTurn, 0),
      },
    })
    if (res.ok) {
      setSavedSwitches(snapshotSwitches(fieldsRef.current))
      // 参数已写激活预设 preset.yml：服务端重建后刷新（模型参数配置等随预设变化）。
      void load({ silent: true })
    } else {
      showNotice('error', '参数保存失败：' + (res.message ?? 'settings bridge unavailable'))
    }
  }, [load, showNotice])

  const persistConfigs = useCallback((configs: PromptConfigDraft[]): Promise<void> => {
    const contentEntries = configs.filter(isContentAsset)
    return (async () => {
      // 内容资产：text 先写生成目录文件（afterPresetImport 触发重建，渲染产物 params.text 更新）。
      for (const config of contentEntries) {
        const scope = config.id === 'prompt-injector' ? 'preset' : 'agents'
        const res = await bridgePost<{ scope: string }>('/import-preset', { scope, content: config.text ?? '' })
        if (!res.ok) {
          showNotice('error', `${scope === 'preset' ? 'preset.md' : 'agents.md'} 保存失败：` + (res.message ?? 'settings bridge unavailable'))
          return
        }
      }
      // promptConfigs 按预设存储：写激活预设 preset.yml（settings 不再承载）。
      const res = await bridgePost<{ promptConfigs: unknown }>('/param-overrides', {
        promptConfigs: configs.map(stripContentText),
      })
      if (res.ok) {
        setSavedConfigs(configs)
        void load({ silent: true })
      } else {
        showNotice('error', '提示词配置保存失败：' + (res.message ?? 'settings bridge unavailable'))
      }
    })()
  }, [load, showNotice])

  /** 模板变量：写激活预设 preset.yml 内容变量（后端 savePresetParams + afterOverridesChange 触发重建）。 */
  const saveTemplateVariables = useCallback(async (next?: Record<string, string>) => {
    // 空 key 行（待编辑）不落盘；本地同步清理保持显示一致。
    const cleaned = Object.fromEntries(
      Object.entries(next ?? templateVariables).filter(([key]) => key.trim().length > 0),
    )
    const res = await bridgePost<{ variables: unknown }>('/preset-variables', {
      variables: cleaned,
      enabled: templateVariablesEnabled,
    })
    if (!res.ok) {
      showNotice('error', `模板变量保存失败：${res.message ?? '未知错误'}`)
      return
    }
    setTemplateVariables(cleaned)
  }, [templateVariables, templateVariablesEnabled, showNotice])

  const toggle = useCallback((key: SwitchKey) => {
    patch({ [key]: !fieldsRef.current[key] })
    if (PARAM_SWITCH_KEYS.has(key)) void persistParamOverrides()
    // writePreset 关闭/开启会重建或移除生成目录：保存后必须重新加载，
    // 否则模块卡片仍显示旧配置（不刷新）。
    else if (key === 'writePreset') persistSwitches(() => { void load({ silent: true }) })
    else persistSwitches()
  }, [patch, persistParamOverrides, persistSwitches, load])

  const toggleBootstrapMaxTokens = useCallback(() => {
    const next = fieldsRef.current.bootstrapMaxTokens > 0 ? 0 : 256000
    patch({ bootstrapMaxTokens: next })
    setBootstrapTokensDraft(DEFAULT_BOOTSTRAP_DISPLAY)
    void persistParamOverrides()
  }, [patch, persistParamOverrides])

  const setPresetTemplate = useCallback(async (id: string) => {
    if (fieldsRef.current.presetTemplate === id) return
    // 切换即保存：模块列表有未保存的提示词配置修改时先提交（写当前激活预设），
    // 避免切换后 load() 重置 fields 丢失修改。已保存/无修改则直接切换。
    const dirtyConfigs = JSON.stringify(fieldsRef.current.promptConfigs) !== JSON.stringify(savedConfigs)
    if (dirtyConfigs) {
      await persistConfigs(fieldsRef.current.promptConfigs)
    }
    patch({ presetTemplate: id })
    enqueueSave(
      [{ op: 'set', path: ['presetTemplate'], value: id }],
      `已切换预设模板：${id}`,
      () => { void load({ silent: true }) },
    )
  }, [enqueueSave, load, patch, persistConfigs, savedConfigs])

  const commitBootstrapTokensDraft = useCallback(() => {
    const parsed = Number(bootstrapTokensDraft)
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      setBootstrapTokensDraft(DEFAULT_BOOTSTRAP_DISPLAY)
      patch({ bootstrapMaxTokens: 256000 })
    } else {
      patch({ bootstrapMaxTokens: parsed })
    }
    void persistParamOverrides()
  }, [bootstrapTokensDraft, patch, persistParamOverrides])

  /** 门控回退步数提交：0 = 引擎默认 4（不写 params）。 */
  const commitGateStepsDraft = useCallback(() => {
    const parsed = Number(gateStepsDraft)
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      setGateStepsDraft(String(fieldsRef.current.maxPromoteSteps > 0 ? fieldsRef.current.maxPromoteSteps : 4))
      return
    }
    patch({ maxPromoteSteps: parsed })
    setGateStepsDraft(String(parsed))
    void persistParamOverrides()
  }, [gateStepsDraft, patch, persistParamOverrides])

  const addSkillsDir = useCallback((dir: string) => {
    const next = dir.trim()
    if (next.length === 0) return
    const current = fieldsRef.current.skillsDirs
    if (current.includes(next)) {
      showNotice('error', '该目录已在列表中')
      return
    }
    const dirs = [...current, next]
    patch({ skillsDirs: dirs })
    enqueueSave(
      [{ op: 'set', path: ['skillsDirs'], value: dirs }],
      `技能目录已添加：${next}`,
      () => {
        setSavedSwitches(snapshotSwitches(fieldsRef.current))
        void load({ silent: true })
      },
      setSavingSkillsDir,
    )
  }, [enqueueSave, load, patch, showNotice])

  const removeSkillsDir = useCallback((dir: string) => {
    const dirs = fieldsRef.current.skillsDirs.filter((item) => item !== dir)
    patch({ skillsDirs: dirs })
    enqueueSave(
      [{ op: 'set', path: ['skillsDirs'], value: dirs }],
      `已移除技能目录引用：${dir}`,
      () => {
        setSavedSwitches(snapshotSwitches(fieldsRef.current))
        void load({ silent: true })
      },
      setSavingSkillsDir,
    )
  }, [enqueueSave, load, patch, showNotice])

  const skillEnabled = useCallback((folder: string) => fieldsRef.current.skillSwitches[folder] !== false, [])

  const toggleSkill = useCallback((folder: string) => {
    const enabled = fieldsRef.current.skillSwitches[folder] !== false
    patch({ skillSwitches: { ...fieldsRef.current.skillSwitches, [folder]: !enabled } })
    persistSwitches()
  }, [patch, persistSwitches])

  interface SkillFixValue {
    folder: string
    fixedFolder: string
    name: string
    actions: string[]
  }
  const fixSkill = useCallback(async (folder: string) => {
    setFixingSkill(folder)
    try {
      const res = await bridgePost<SkillFixValue>('/skill-fix', { folder })
      if (res.ok) {
        showNotice('ok', `已修复技能 ${res.value.folder} → ${res.value.fixedFolder}：${res.value.actions.join('；') || '无需改动'}`)
        await load()
      } else {
        showNotice('error', '一键修复失败：' + (res.message ?? 'settings bridge unavailable'))
      }
    } catch (error) {
      showNotice('error', '一键修复失败：' + errorMessage(error))
    } finally {
      setFixingSkill(undefined)
    }
  }, [load, showNotice])

  const openSkillsDir = useCallback(async (path?: string) => {
    const target = path ?? fieldsRef.current.activeSkillsDirs[0] ?? ''
    if (!target) { showNotice('error', '技能目录路径未知，请先重新读取配置'); return }
    try {
      const res = await api.host.openPath({ path: target })
      if (res.result.ok) showNotice('ok', '已打开技能目录：' + target)
      else showNotice('error', '打开失败：' + (res.result.error?.message ?? ''))
    } catch (error) {
      showNotice('error', '打开失败：' + errorMessage(error))
    }
  }, [api, showNotice])

  const currentSwitches = snapshotSwitches(fields)
  const dirtySwitches = !switchesEqual(currentSwitches, savedSwitches)
  const dirtyConfigs = JSON.stringify(fields.promptConfigs) !== JSON.stringify(savedConfigs)
  const dirty = dirtySwitches || dirtyConfigs

  // 任意 UI 修改自动保存：模块列表的提示词配置修改（顶端总开关/卡片字段/增删/排序，
  // 全部经 patch({ promptConfigs }) 落 fields）debounce 后统一走 persistConfigs——
  // 与手动「保存」共用同一写盘逻辑（跳过校验：编辑中间态直存，后端容错；
  // 手动保存按钮仍保留校验路径）。保存成功 load() 更新 savedConfigs → dirty 消失自愈。
  useEffect(() => {
    if (!dirtyConfigs) return
    const timer = setTimeout(() => { void persistConfigs(fields.promptConfigs) }, 800)
    return () => clearTimeout(timer)
  }, [dirtyConfigs, fields.promptConfigs, persistConfigs])

  return {
    fields,
    meta,
    loading,
    providers,
    modelCatalog,
    hostDefaultModel,
    bootstrapTokensDraft,
    skillsDirDraft,
    templatePreStepCount,
    savedSwitches,
    savedConfigs,
    savingSkillsDir,
    fixingSkill,
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
    toggleBootstrapMaxTokens,
    setPresetTemplate,
    setBootstrapTokensDraft,
    commitBootstrapTokensDraft,
    gateStepsDraft,
    setGateStepsDraft,
    commitGateStepsDraft,
    setSkillsDirDraft,
    addSkillsDir,
    removeSkillsDir,
    toggleSkill,
    skillEnabled,
    fixSkill,
    openSkillsDir,
    dirtySwitches,
    dirtyConfigs,
    dirty,
  }
}
