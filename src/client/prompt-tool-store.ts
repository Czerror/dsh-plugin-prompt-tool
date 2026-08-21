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
  usePtcMode: true,
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

export type SwitchKey = 'injectAgentsPrompt' | 'firstTurnAnchor' | 'firstTurnCustom' | 'guideCustom' | 'injectPrompt' | 'usePtcMode' | 'writeAgents' | 'writePreset'

/** 参数类布尔开关：写激活预设 preset.yml（settings 只留全局开关）。 */
const PARAM_SWITCH_KEYS: ReadonlySet<SwitchKey> = new Set(['firstTurnAnchor', 'firstTurnCustom', 'guideCustom', 'injectPrompt', 'usePtcMode'])

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
  toggle: (key: SwitchKey) => void
  toggleBootstrapMaxTokens: () => void
  setPresetTemplate: (id: string) => void
  setBootstrapTokensDraft: (value: string) => void
  commitBootstrapTokensDraft: () => void
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
  const [skillsDirDraft, setSkillsDirDraft] = useState('')
  const [templatePreStepCount, setTemplatePreStepCount] = useState(0)
  const [savedSwitches, setSavedSwitches] = useState<SwitchSnapshot>(EMPTY_SWITCHES)
  const [savedConfigs, setSavedConfigs] = useState<PromptConfigDraft[]>([])
  const [loading, setLoading] = useState(false)
  const [savingSkillsDir, setSavingSkillsDir] = useState(false)
  const [fixingSkill, setFixingSkill] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState('')
  const [noticeKind, setNoticeKind] = useState<'ok' | 'error'>('ok')
  const fieldsRef = useRef<Fields>(EMPTY_FIELDS)
  const revisionRef = useRef<number | undefined>(undefined)
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const loadSeqRef = useRef(0)

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
    setSkillsDirDraft('')
    setSavedSwitches(snapshotSwitches(next))
    setSavedConfigs(next.promptConfigs)
    if (res.ok) revisionRef.current = res.value.revision
    return next
  }, [])

  const load = useCallback(async () => {
    // 并发保护：慢的旧请求不得覆盖新请求（last-good 语义保留旧数据）。
    const seq = ++loadSeqRef.current
    setLoading(true)
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
      // 用户参数覆盖（生成目录 prompt-tool.overrides.yml；settings 不再承载参数）。
      const overridesRes = await bridgePost<{ overrides: Record<string, unknown> }>('/param-overrides', {})
      if (seq !== loadSeqRef.current) return EMPTY_FIELDS
      if (overridesRes.ok) {
        const o = overridesRes.value.overrides
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
        if (typeof o.mainPersona === 'string') paramPatch.mainPersona = o.mainPersona
        if (typeof o.subagentPersona === 'string') paramPatch.subagentPersona = o.subagentPersona
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
        if (Object.keys(paramPatch).length > 0) {
          const next = { ...fieldsRef.current, ...paramPatch }
          fieldsRef.current = next
          setFields(next)
          setSavedSwitches(snapshotSwitches(next))
        }
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
      if (seq === loadSeqRef.current) setLoading(false)
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
    const next = { ...fieldsRef.current, ...partial }
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

  /** 参数类设置：写入生成目录 prompt-tool.overrides.yml（随预设隔离，重建保留）。 */
  const persistParamOverrides = useCallback(async () => {
    const f = fieldsRef.current
    const splitList = (value: string): string[] => value.split(',').map((item) => item.trim()).filter((item) => item.length > 0)
    // 空值不写键：保留 preset.yml 模板默认。mainPersona 引擎必需非空；
    // allowKinds 空数组 = 白名单全拦（危险）；maxDepth '' = 不设置。
    const res = await bridgePost<{ overrides: unknown }>('/param-overrides', {
      overrides: {
        firstTurnAnchor: f.firstTurnAnchor,
        firstTurnText: f.firstTurnText,
        firstTurnCustom: f.firstTurnCustom,
        guideText: f.guideText,
        guideCustom: f.guideCustom,
        usePtcMode: f.usePtcMode,
        injectPrompt: f.injectPrompt,
        modelProvider: f.modelProvider,
        modelName: f.modelName,
        subagentModelProvider: f.subagentModelProvider,
        subagentModelName: f.subagentModelName,
        ...(f.modelReasoningEffort.trim().length > 0 ? { modelReasoningEffort: f.modelReasoningEffort } : {}),
        ...(f.modelTemperature.trim().length > 0 ? { modelTemperature: f.modelTemperature } : {}),
        ...(f.modelMaxTokens.trim().length > 0 ? { modelMaxTokens: f.modelMaxTokens } : {}),
        ...(f.subagentReasoningEffort.trim().length > 0 ? { subagentReasoningEffort: f.subagentReasoningEffort } : {}),
        ...(f.subagentTemperature.trim().length > 0 ? { subagentTemperature: f.subagentTemperature } : {}),
        ...(f.subagentMaxTokens.trim().length > 0 ? { subagentMaxTokens: f.subagentMaxTokens } : {}),
        ...(f.mainPersona.trim().length > 0 ? { mainPersona: f.mainPersona } : {}),
        ...(f.subagentPersona.trim().length > 0 ? { subagentPersona: f.subagentPersona } : {}),
        toolFilterAllow: splitList(f.toolFilterAllow),
        toolFilterDeny: splitList(f.toolFilterDeny),
        ...(f.maxDepth !== ''
          ? { maxDepth: f.maxDepth === 'provider-managed' ? 'provider-managed' : Number(f.maxDepth) }
          : {}),
        ...(splitList(f.allowKinds).length > 0 ? { allowKinds: splitList(f.allowKinds) } : {}),
        ...(f.firstTurnWord.trim().length > 0 ? { firstTurnWord: f.firstTurnWord } : {}),
        bootstrapMaxTokens: f.bootstrapMaxTokens,
      },
    })
    if (res.ok) {
      setSavedSwitches(snapshotSwitches(fieldsRef.current))
      // 参数已写激活预设 preset.yml：服务端重建后刷新（模型参数配置等随预设变化）。
      void load()
    } else {
      showNotice('error', '参数保存失败：' + (res.message ?? 'settings bridge unavailable'))
    }
  }, [load, showNotice])

  const persistConfigs = useCallback((configs: PromptConfigDraft[]) => {
    const contentEntries = configs.filter(isContentAsset)
    void (async () => {
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
        void load()
      } else {
        showNotice('error', '提示词配置保存失败：' + (res.message ?? 'settings bridge unavailable'))
      }
    })()
  }, [load, showNotice])

  const toggle = useCallback((key: SwitchKey) => {
    patch({ [key]: !fieldsRef.current[key] })
    if (PARAM_SWITCH_KEYS.has(key)) void persistParamOverrides()
    // writePreset 关闭/开启会重建或移除生成目录：保存后必须重新加载，
    // 否则模块卡片仍显示旧配置（不刷新）。
    else if (key === 'writePreset') persistSwitches(() => { void load() })
    else persistSwitches()
  }, [patch, persistParamOverrides, persistSwitches, load])

  const toggleBootstrapMaxTokens = useCallback(() => {
    const next = fieldsRef.current.bootstrapMaxTokens > 0 ? 0 : 256000
    patch({ bootstrapMaxTokens: next })
    setBootstrapTokensDraft(DEFAULT_BOOTSTRAP_DISPLAY)
    void persistParamOverrides()
  }, [patch, persistParamOverrides])

  const setPresetTemplate = useCallback((id: string) => {
    if (fieldsRef.current.presetTemplate === id) return
    patch({ presetTemplate: id })
    enqueueSave(
      [{ op: 'set', path: ['presetTemplate'], value: id }],
      `已切换预设模板：${id}`,
      () => { void load() },
    )
  }, [enqueueSave, load, patch])

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
        void load()
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
        void load()
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
    toggle,
    toggleBootstrapMaxTokens,
    setPresetTemplate,
    setBootstrapTokensDraft,
    commitBootstrapTokensDraft,
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
