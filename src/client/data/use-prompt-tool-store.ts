import { useCallback, useEffect, useRef, useState } from 'react'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { EngineMeta, PromptConfigDraft } from '../prompt-tool-types.ts'
import type { PromptToolHostApi } from './host-api.ts'
import type { PresetModuleFacts } from '../../shared/engine-capabilities.ts'
import { bridgeCall, errorMessage, type BridgeResult, type BridgeSettingsView } from './bridge-client.ts'
import {
  DEFAULT_BOOTSTRAP_DISPLAY,
  EMPTY_FIELDS,
  EMPTY_META,
  type Fields,
  type HostDefaultModel,
} from './prompt-tool-fields.ts'
import { bridgeViewFromBoot, fieldsFromView, mergePresetParams } from './prompt-tool-view.ts'
import {
  EMPTY_SWITCHES,
  promptConfigsDirty,
  shouldReloadAfterParamSave,
  snapshotSwitches,
  switchesEqual,
  type SwitchSnapshot,
} from './dirty-state.ts'
import { isContentAsset, liftContentText, stripContentText } from './prompt-config-content.ts'
import { buildParamOverrides, readParamOverridesPatch } from './param-overrides.ts'
import { createSerialTaskQueue } from './save-queue.ts'

/** rc8 ui-settings 共享镜像传输面：标准字段经官方 settingsScope 读写。 */
export interface PromptToolSettingsTransport {
  /** 宿主注册的 prompt-tool settings namespace 绑定。 */
  scope: SettingsScope<Record<string, unknown>>
  /** 触发一次共享 describe mirror 读取（idle 时才真正发 RPC）。 */
  ensure: () => Promise<void>
  /** 批量 path-op 写入；成功后 scope 快照已 fold 最新 revision。 */
  mutate: (ops: SettingsPathOpView[], expectedRevision?: number) => Promise<void>
}

export type SwitchKey = 'injectAgentsPrompt' | 'firstTurnAnchor' | 'firstTurnCustom' | 'guideCustom' | 'toolFilterSubagents' | 'injectPrompt' | 'usePtcMode' | 'promoteGate' | 'promoteAfterFirstResponse' | 'personaSectionsOnly' | 'workspaceLine' | 'instructionHint' | 'anchorTurn' | 'deliberationGate' | 'cotDrip' | 'writeAgents' | 'writePreset'

/** 参数类布尔开关：写激活预设 preset.yml（settings 只留全局开关）。 */
const PARAM_SWITCH_KEYS: ReadonlySet<SwitchKey> = new Set(['firstTurnAnchor', 'firstTurnCustom', 'guideCustom', 'toolFilterSubagents', 'injectPrompt', 'usePtcMode', 'promoteGate', 'promoteAfterFirstResponse', 'personaSectionsOnly', 'workspaceLine', 'instructionHint', 'anchorTurn', 'deliberationGate', 'cotDrip'])

export interface PromptToolStore {
  api: PromptToolHostApi
  fields: Fields
  /** fields 外部订阅通道（usePromptToolFields）：patch/load 变更后通知。
   *  getFields 返回引用稳定快照，selector 化的组件据此跳过无关重渲染。 */
  getFields: () => Fields
  subscribeFields: (listener: () => void) => () => void
  meta: EngineMeta
  loading: boolean
  providers: string[]
  modelCatalog: Record<string, string[]>
  hostDefaultModel?: HostDefaultModel
  moduleFacts?: PresetModuleFacts
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
  createEngineCapability: (action: 'create' | 'create-recipe', id: string) => Promise<void>
  removeEngineCapability: (id: string) => Promise<void>
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

export function usePromptToolStore(api: PromptToolHostApi, settings: PromptToolSettingsTransport): PromptToolStore {
  const [providers, setProviders] = useState<string[]>([])
  const [modelCatalog, setModelCatalog] = useState<Record<string, string[]>>({})
  const [hostDefaultModel, setHostDefaultModel] = useState<HostDefaultModel | undefined>(undefined)
  const [moduleFacts, setModuleFacts] = useState<PresetModuleFacts | undefined>(undefined)
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
  const revisionRef = useRef<number | undefined>(undefined)
  const saveQueueRef = useRef(createSerialTaskQueue())
  const paramSaveQueueRef = useRef(createSerialTaskQueue())
  const loadSeqRef = useRef(0)
  /** 用户草稿版本：patch 时递增。load 应答返回时若版本变化，跳过覆盖，避免
   *  保存后的静默刷新吞掉用户在读取期间的编辑。 */
  const draftVersionRef = useRef(0)
  /** applyView 自动预选的 provider：无模型名时不作为用户显式参数落盘。 */
  const autoModelProviderRef = useRef<string | undefined>(undefined)
  const autoSubagentModelProviderRef = useRef<string | undefined>(undefined)
  /** 最近一次 load 时 preset.yml params 现有键集：persist 只发送「已有键或已改动」，
   *  未动过的键不写——避免 UI 默认值固化覆盖模板 moduleConfigs 默认。 */
  const loadedKeysRef = useRef<Set<string>>(new Set())

  const showNotice = useCallback((kind: 'ok' | 'error', message: string) => {
    setNotice(message)
    setNoticeKind(kind)
  }, [])

  /** 模型目录惰性加载：独立于主 load（/describe 不再阻塞等模型查询）。 */
  const loadModels = useCallback(async (): Promise<void> => {
    const res = await bridgeCall('models')
    if (res.ok) setModelCatalog(res.value.modelCatalog ?? {})
  }, [])

  const applyView = useCallback((res: BridgeResult<BridgeSettingsView>): Fields => {
    setTemplatePreStepCount(res.ok && typeof res.templatePreStepCount === 'number' ? res.templatePreStepCount : 0)
    setProviders(res.ok ? res.providers ?? [] : [])
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
    setBootstrapTokensDraft(next.bootstrapMaxTokens > 0 ? String(next.bootstrapMaxTokens) : DEFAULT_BOOTSTRAP_DISPLAY)
    setGateStepsDraft(next.maxPromoteSteps > 0 ? String(next.maxPromoteSteps) : '4')
    setSkillsDirDraft('')
    setSavedSwitches(snapshotSwitches(next))
    setSavedConfigs(next.promptConfigs)
    // revision 只在首次建立，后续由 enqueueSave 的 mutate 应答维护——/bootstrap 的
    // descriptor 有 30s 服务端缓存，用其 revision 倒退会导致下一次保存 409。
    if (res.ok && revisionRef.current === undefined) revisionRef.current = res.value.revision
    return next
  }, [])

  const load = useCallback(async (options?: { silent?: boolean }) => {
    // 并发保护：慢的旧请求不得覆盖新请求（last-good 语义保留旧数据）。
    const seq = ++loadSeqRef.current
    const draftVersion = draftVersionRef.current
    // silent：保存后静默刷新（不闪 loading、避免重渲染风暴与滚动跳动）；失败仍报错。
    if (!options?.silent) setLoading(true)
    try {
      // /bootstrap 聚合读取：meta + describe runtime facts + 参数覆盖 + 模板变量 +
      // 实际生效配置一次取回（此前 5 端点串行，preset.yml 每端点读盘解析）。
      const boot = await bridgeCall('bootstrap')
      if (seq !== loadSeqRef.current) return EMPTY_FIELDS
      // 读取期间用户已修改草稿：不应用服务端快照覆盖，保留草稿；后续保存/读取再同步。
      if (draftVersionRef.current !== draftVersion) return fieldsRef.current
      if (!boot.ok) {
        showNotice('error', '读取配置失败：' + (boot.message ?? 'bootstrap unavailable'))
        return EMPTY_FIELDS
      }
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
      }      // 预设级模板变量（preset.yml 内容变量；失败不阻断主流程）。
      if (boot.ok && boot.variables !== undefined) {
        setTemplateVariables(boot.variables.variables)
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
        const actual = userConfigs.map(liftContentText)
        const next = { ...fieldsRef.current, promptConfigs: actual }
        publishFields(next)
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
    draftVersionRef.current += 1
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
    publishFields(next)
  }, [publishFields])

  const enqueueSave = useCallback((ops: SettingsPathOpView[], okMessage: string | undefined, onSaved: () => void, setBusy?: (busy: boolean) => void) => {
    setBusy?.(true)
    void saveQueueRef.current.enqueue(async () => {
      try {
        await settings.mutate(ops, revisionRef.current)
        revisionRef.current = settings.scope.getSnapshot().revision
        onSaved()
        if (okMessage) showNotice('ok', okMessage)
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
          } catch (retryError) {
            await refreshRevision()
            showNotice('error', '保存失败：' + errorMessage(retryError) + '（已刷新配置版本，可重试）')
          }
        } else {
          await refreshRevision()
          showNotice('error', '保存失败：' + message + '（已刷新配置版本，可重试）')
        }
      } finally {
        setBusy?.(false)
      }
    })
  }, [refreshRevision, settings, showNotice])

  const persistSwitches = useCallback((onSaved?: () => void) => {
    const savedSnapshot = snapshotSwitches(fieldsRef.current)
    return enqueueSave(
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
        setSavedSwitches(savedSnapshot)
        onSaved?.()
      },
    )
  }, [enqueueSave])

  /** 参数类设置：写入激活预设 preset.yml（savePresetParams；随预设隔离）。
   *  保存进独立队列；请求成功只把「发起时快照」标记为已保存。若用户在请求期间
   *  继续编辑，则跳过静默重载，避免磁盘旧快照覆盖未保存草稿。 */
  const persistParamOverrides = useCallback(async () => {
    const run = async (): Promise<void> => {
      const f = fieldsRef.current
      const savedSnapshot = snapshotSwitches(f)
      const overrides = buildParamOverrides(f, {
        loadedKeys: loadedKeysRef.current,
        autoModelProvider: autoModelProviderRef.current,
        autoSubagentModelProvider: autoSubagentModelProviderRef.current,
      })
      const res = await bridgeCall('paramOverrides', { overrides })
      if (res.ok) {
        // 只标记发起时快照；若期间有新编辑，当前 fields 仍保持 dirty。
        setSavedSwitches(savedSnapshot)
        const currentSnapshot = snapshotSwitches(fieldsRef.current)
        // 服务端会过滤未完成阶段；此时不重载，保留 UI 正在编辑的空草稿行。
        if (shouldReloadAfterParamSave(currentSnapshot, savedSnapshot)) {
          // 参数已写激活预设 preset.yml：服务端重建后刷新（模型参数配置等随预设变化）。
          void load({ silent: true })
        }
      } else {
        showNotice('error', '参数保存失败：' + (res.message ?? 'settings bridge unavailable'))
      }
    }
    await paramSaveQueueRef.current.enqueue(run)
  }, [load, savedConfigs, showNotice])

  /** 保存后是否静默重载。切换预设时传 false（随后的 settings.mutate 回调会统一 load，
   *  避免一次切换触发两次全量读取）。 */
  const persistConfigs = useCallback((configs: PromptConfigDraft[], options?: { reload?: boolean; rebuild?: boolean }): Promise<void> => {
    const contentEntries = configs.filter(isContentAsset)
    return (async () => {
      // 内容资产：text 先写生成目录文件。合并为单次 /import-preset（批量载荷），
      // 服务端只触发一次重建——此前逐条请求每条各重建一次（多次写盘+recomposition）。
      if (contentEntries.length > 0) {
        const contents = contentEntries.map((config) => ({
          scope: config.id === 'prompt-injector' ? 'preset' as const : 'agents' as const,
          content: config.text ?? '',
        }))
        const res = await bridgeCall('importPreset', { contents })
        if (!res.ok) {
          showNotice('error', 'preset.md/agents.md 保存失败：' + (res.message ?? 'settings bridge unavailable'))
          return
        }
      }
      // promptConfigs 按预设存储：写激活预设 preset.yml（settings 不再承载）。
      // 防御：初始化期空数组自动保存不得覆盖服务端已有配置（历史教训：beta-2-42
      // 的 129 张配置卡被一次清空）；用户主动清空（此前已加载非空配置）允许落盘空数组。
      if (configs.length === 0 && savedConfigs.length === 0) return
      const res = await bridgeCall('paramOverrides', {
        promptConfigs: configs.map(stripContentText),
        ...(options?.rebuild === false ? { rebuild: false } : {}),
      })
      if (res.ok) {
        setSavedConfigs(configs)
        if (options?.reload !== false) void load({ silent: true })
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
    const res = await bridgeCall('presetVariables', {
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
    const dirtyConfigs = promptConfigsDirty(fieldsRef.current.promptConfigs, savedConfigs)
    if (dirtyConfigs) {
      // 免双 load：保存成功后由下方 enqueueSave 的 onSaved 统一静默重载。
      // 切换前只落盘当前预设，不重建；settings 切换后目标预设只重建一次。
      await persistConfigs(fieldsRef.current.promptConfigs, { reload: false, rebuild: false })
    }
    const switchResult = await api.switchPreset(id)
    patch({ presetTemplate: id })
    enqueueSave(
      [{ op: 'set', path: ['presetTemplate'], value: id }],
      switchResult.applied
        ? `已切换预设模板：${id}（当前空会话已重组）`
        : `已切换默认预设模板：${id}`,
      () => {
        void load({ silent: true })
        if (switchResult.message !== undefined) {
          showNotice('error', switchResult.message)
        }
      },
    )
  }, [enqueueSave, load, patch, persistConfigs, savedConfigs])

  const createEngineCapability = useCallback(async (action: 'create' | 'create-recipe', id: string): Promise<void> => {
    const request = action === 'create' ? { action: 'create' as const, capabilityId: id } : { action: 'create-recipe' as const, recipeId: id }
    const result = await bridgeCall('engineCapability', request)
    if (!result.ok) {
      showNotice('error', '引擎能力创建失败：' + (result.message ?? 'settings bridge unavailable'))
      return
    }
    showNotice('ok', result.value.changed ? `已创建引擎能力：${id}` : `引擎能力已存在：${id}`)
    await load({ silent: true })
  }, [load, showNotice])

  const removeEngineCapability = useCallback(async (id: string): Promise<void> => {
    const result = await bridgeCall('engineCapability', { action: 'remove', capabilityId: id })
    if (!result.ok) {
      showNotice('error', '引擎能力删除失败：' + (result.message ?? 'settings bridge unavailable'))
      return
    }
    showNotice('ok', result.value.changed ? `已删除引擎能力：${id}` : `引擎能力不存在：${id}`)
    await load({ silent: true })
  }, [load, showNotice])

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

  const fixSkill = useCallback(async (folder: string) => {
    setFixingSkill(folder)
    try {
      const res = await bridgeCall('skillFix', { folder })
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
      await api.openPath(target)
      showNotice('ok', '已打开技能目录：' + target)
    } catch (error) {
      showNotice('error', '打开失败：' + errorMessage(error))
    }
  }, [api, showNotice])

  const currentSwitches = snapshotSwitches(fields)
  const dirtySwitches = !switchesEqual(currentSwitches, savedSwitches)
  const dirtyConfigs = promptConfigsDirty(fields.promptConfigs, savedConfigs)
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

  // 返回引用稳定化：memo 子组件以 props.store 同一性跳过父级重渲染（订阅式 selector
  // 化依赖稳定 store 引用）；每次渲染重建内容对象但复用 ref 外壳。
  const storeRef = useRef<PromptToolStore>()
  storeRef.current = {
    api,
    fields,
    getFields,
    subscribeFields,
    meta,
    loading,
    providers,
    modelCatalog,
    hostDefaultModel,
    moduleFacts,
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
    createEngineCapability,
    removeEngineCapability,
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
  return storeRef.current
}
