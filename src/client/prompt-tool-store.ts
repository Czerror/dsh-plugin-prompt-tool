import { useCallback, useRef, useState } from 'react'
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
  subagentModelProvider: string
  subagentModelName: string
  bootstrapMaxTokens: number
  usePtcMode: boolean
  injectPrompt: boolean
  skillSwitches: Record<string, boolean>
  skillOrder: string[]
  skillsDir: string
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
  subagentModelProvider: '',
  subagentModelName: '',
  bootstrapMaxTokens: 0,
  usePtcMode: true,
  injectPrompt: true,
  skillSwitches: {},
  skillOrder: [],
  skillsDir: '',
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

export const snapshotSwitches = (fields: Fields): SwitchSnapshot => ({
  injectAgentsPrompt: fields.injectAgentsPrompt,
  firstTurnAnchor: fields.firstTurnAnchor,
  firstTurnText: fields.firstTurnText,
  firstTurnCustom: fields.firstTurnCustom,
  guideText: fields.guideText,
  guideCustom: fields.guideCustom,
  subagentModelProvider: fields.subagentModelProvider,
  subagentModelName: fields.subagentModelName,
  bootstrapMaxTokens: fields.bootstrapMaxTokens,
  usePtcMode: fields.usePtcMode,
  injectPrompt: fields.injectPrompt,
  skillSwitches: { ...fields.skillSwitches },
  skillOrder: [...fields.skillOrder],
  skillsDir: fields.skillsDir,
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
  && a.subagentModelProvider === b.subagentModelProvider
  && a.subagentModelName === b.subagentModelName
  && a.bootstrapMaxTokens === b.bootstrapMaxTokens
  && a.usePtcMode === b.usePtcMode
  && a.injectPrompt === b.injectPrompt
  && JSON.stringify(a.skillSwitches) === JSON.stringify(b.skillSwitches)
  && JSON.stringify(a.skillOrder) === JSON.stringify(b.skillOrder)
  && a.skillsDir === b.skillsDir
  && a.skillRankBase === b.skillRankBase
  && a.residentAgentsPath === b.residentAgentsPath
  && a.presetDir === b.presetDir
  && a.presetOrder === b.presetOrder
  && a.fallbackText === b.fallbackText
  && a.writeAgents === b.writeAgents
  && a.writePreset === b.writePreset

export type SwitchKey = 'injectAgentsPrompt' | 'firstTurnAnchor' | 'firstTurnCustom' | 'guideCustom' | 'injectPrompt' | 'usePtcMode' | 'writeAgents' | 'writePreset'

/** 参数类布尔开关：写入生成目录 overrides（settings 只留总开关）。 */
const PARAM_SWITCH_KEYS: ReadonlySet<SwitchKey> = new Set(['firstTurnAnchor', 'firstTurnCustom', 'guideCustom'])

export interface PromptToolStore {
  fields: Fields
  meta: EngineMeta
  loading: boolean
  deepseekProviders: string[]
  bootstrapTokensDraft: string
  skillsDirDraft: string
  savedSwitches: SwitchSnapshot
  savedConfigs: PromptConfigDraft[]
  savedConfigsDir: string
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
  persistConfigsDir: (dir: string) => void
  toggle: (key: SwitchKey) => void
  toggleBootstrapMaxTokens: () => void
  setPresetTemplate: (id: string) => void
  setBootstrapTokensDraft: (value: string) => void
  commitBootstrapTokensDraft: () => void
  setSkillsDirDraft: (value: string) => void
  applySkillsDir: () => void
  applySkillsDirValue: (dir: string) => void
  toggleSkill: (folder: string) => void
  skillEnabled: (folder: string) => boolean
  fixSkill: (folder: string) => void
  openSkillsDir: () => Promise<void>
  importPreset: (scope: 'preset' | 'agents', content: string) => Promise<void>
  dirtySwitches: boolean
  dirtyConfigs: boolean
  dirtyConfigsDir: boolean
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
    deepseekProviders: runtime.ok ? runtime.deepseekProviders : undefined,
    activeSkillsDir: runtime.ok ? runtime.activeSkillsDir : undefined,
    skillCatalog: runtime.ok ? runtime.skillCatalog : undefined,
  }
}

export function usePromptToolStore(api: IApiClient, settings: PromptToolSettingsTransport): PromptToolStore {
  const [deepseekProviders, setDeepseekProviders] = useState<string[]>([])
  const [fields, setFields] = useState<Fields>(EMPTY_FIELDS)
  const [meta, setMeta] = useState<EngineMeta>(EMPTY_META)
  const [bootstrapTokensDraft, setBootstrapTokensDraft] = useState(DEFAULT_BOOTSTRAP_DISPLAY)
  const [skillsDirDraft, setSkillsDirDraft] = useState('')
  const [savedSwitches, setSavedSwitches] = useState<SwitchSnapshot>(EMPTY_SWITCHES)
  const [savedConfigs, setSavedConfigs] = useState<PromptConfigDraft[]>([])
  const [savedConfigsDir, setSavedConfigsDir] = useState('')
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

  const applyView = useCallback((res: BridgeResult<BridgeSettingsView>): Fields => {
    setDeepseekProviders(res.ok ? res.deepseekProviders ?? [] : [])
    const next = fieldsFromView(res)
    fieldsRef.current = next
    setFields(next)
    setBootstrapTokensDraft(next.bootstrapMaxTokens > 0 ? String(next.bootstrapMaxTokens) : DEFAULT_BOOTSTRAP_DISPLAY)
    setSkillsDirDraft(next.skillsDir)
    setSavedSwitches(snapshotSwitches(next))
    setSavedConfigs(next.promptConfigs)
    setSavedConfigsDir(next.promptConfigsDir)
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
      // 内容资产在生成目录文件（settings 不再承载大文本）；按需拉取填充编辑器预览。
      const presetContent = await bridgePost<{ content: string }>('/preset-content', { scope: 'preset' })
      if (seq !== loadSeqRef.current) return EMPTY_FIELDS
      if (presetContent.ok) {
        patch({ promptText: presetContent.value.content })
      }
      const agentsContent = await bridgePost<{ content: string }>('/preset-content', { scope: 'agents' })
      if (seq !== loadSeqRef.current) return EMPTY_FIELDS
      if (agentsContent.ok) {
        patch({ agentsText: agentsContent.value.content })
      }
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
        if (typeof o.subagentModelProvider === 'string') paramPatch.subagentModelProvider = o.subagentModelProvider
        if (typeof o.subagentModelName === 'string') paramPatch.subagentModelName = o.subagentModelName
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
        const actual = configsRes.value.promptConfigs
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

  const persistSwitches = useCallback(() => enqueueSave(
    [
      { op: 'set', path: ['injectAgentsPrompt'], value: fieldsRef.current.injectAgentsPrompt },
      { op: 'set', path: ['usePtcMode'], value: fieldsRef.current.usePtcMode },
      { op: 'set', path: ['injectPrompt'], value: fieldsRef.current.injectPrompt },
      { op: 'set', path: ['skillSwitches'], value: fieldsRef.current.skillSwitches },
      { op: 'set', path: ['skillOrder'], value: fieldsRef.current.skillOrder },
      { op: 'set', path: ['skillsDir'], value: fieldsRef.current.skillsDir },
      { op: 'set', path: ['skillRankBase'], value: fieldsRef.current.skillRankBase },
      { op: 'set', path: ['residentAgentsPath'], value: fieldsRef.current.residentAgentsPath },
      { op: 'set', path: ['presetDir'], value: fieldsRef.current.presetDir },
      { op: 'set', path: ['presetOrder'], value: fieldsRef.current.presetOrder },
      { op: 'set', path: ['fallbackText'], value: fieldsRef.current.fallbackText },
      { op: 'set', path: ['writeAgents'], value: fieldsRef.current.writeAgents },
      { op: 'set', path: ['writePreset'], value: fieldsRef.current.writePreset },
    ],
    undefined,
    () => setSavedSwitches(snapshotSwitches(fieldsRef.current)),
  ), [enqueueSave])

  /** 参数类设置：写入生成目录 prompt-tool.overrides.yml（随预设隔离，重建保留）。 */
  const persistParamOverrides = useCallback(async () => {
    const f = fieldsRef.current
    const res = await bridgePost<{ overrides: unknown }>('/param-overrides', {
      overrides: {
        firstTurnAnchor: f.firstTurnAnchor,
        firstTurnText: f.firstTurnText,
        firstTurnCustom: f.firstTurnCustom,
        guideText: f.guideText,
        guideCustom: f.guideCustom,
        subagentModelProvider: f.subagentModelProvider,
        subagentModelName: f.subagentModelName,
        bootstrapMaxTokens: f.bootstrapMaxTokens,
      },
    })
    if (res.ok) {
      setSavedSwitches(snapshotSwitches(fieldsRef.current))
    } else {
      showNotice('error', '参数保存失败：' + (res.message ?? 'settings bridge unavailable'))
    }
  }, [showNotice])

  const persistConfigs = useCallback((configs: PromptConfigDraft[]) => enqueueSave(
    [{ op: 'set', path: ['promptConfigs'], value: configs }],
    undefined,
    () => setSavedConfigs(configs),
  ), [enqueueSave])

  const persistConfigsDir = useCallback((dir: string) => enqueueSave(
    [{ op: 'set', path: ['promptConfigsDir'], value: dir }],
    undefined,
    () => setSavedConfigsDir(dir),
  ), [enqueueSave])

  const toggle = useCallback((key: SwitchKey) => {
    patch({ [key]: !fieldsRef.current[key] })
    if (PARAM_SWITCH_KEYS.has(key)) void persistParamOverrides()
    else persistSwitches()
  }, [patch, persistParamOverrides, persistSwitches])

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

  const applySkillsDirValue = useCallback((dir: string) => {
    const next = dir.trim()
    patch({ skillsDir: next })
    enqueueSave(
      [{ op: 'set', path: ['skillsDir'], value: next }],
      next.length > 0 ? `自定义技能目录已保存并生效：${next}` : '已切回自动技能目录（当前 profile 下 skills/）',
      () => {
        setSavedSwitches(snapshotSwitches(fieldsRef.current))
        void load()
      },
      setSavingSkillsDir,
    )
  }, [enqueueSave, load, patch])

  const applySkillsDir = useCallback(() => {
    applySkillsDirValue(skillsDirDraft)
  }, [applySkillsDirValue, skillsDirDraft])

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

  const openSkillsDir = useCallback(async () => {
    const path = fieldsRef.current.activeSkillsDir || fieldsRef.current.skillsDir
    if (!path) { showNotice('error', '技能目录路径未知，请先重新读取配置'); return }
    try {
      const res = await api.host.openPath({ path })
      if (res.result.ok) showNotice('ok', '已打开技能目录：' + path)
      else showNotice('error', '打开失败：' + (res.result.error?.message ?? ''))
    } catch (error) {
      showNotice('error', '打开失败：' + errorMessage(error))
    }
  }, [api, showNotice])

  const importPreset = useCallback(async (scope: 'preset' | 'agents', content: string) => {
    const res = await bridgePost<{ scope: string }>('/import-preset', { scope, content })
    if (res.ok) {
      if (scope === 'preset') {
        patch({ promptText: content })
      } else {
        patch({ agentsText: content })
      }
      showNotice('ok', scope === 'preset' ? 'preset.md 已导入并生效' : 'AGENTS.md 已导入并生效')
      await load()
    } else {
      showNotice('error', '导入失败：' + (res.message ?? 'settings bridge unavailable'))
    }
  }, [load, patch, showNotice])

  const currentSwitches = snapshotSwitches(fields)
  const dirtySwitches = !switchesEqual(currentSwitches, savedSwitches)
  const dirtyConfigs = JSON.stringify(fields.promptConfigs) !== JSON.stringify(savedConfigs)
  const dirtyConfigsDir = fields.promptConfigsDir !== savedConfigsDir
  const dirty = dirtySwitches || dirtyConfigs || dirtyConfigsDir

  return {
    fields,
    meta,
    loading,
    deepseekProviders,
    bootstrapTokensDraft,
    skillsDirDraft,
    savedSwitches,
    savedConfigs,
    savedConfigsDir,
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
    persistConfigsDir,
    toggle,
    toggleBootstrapMaxTokens,
    setPresetTemplate,
    setBootstrapTokensDraft,
    commitBootstrapTokensDraft,
    setSkillsDirDraft,
    applySkillsDir,
    applySkillsDirValue,
    toggleSkill,
    skillEnabled,
    fixSkill,
    openSkillsDir,
    importPreset,
    dirtySwitches,
    dirtyConfigs,
    dirtyConfigsDir,
    dirty,
  }
}
