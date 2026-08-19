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
  subagentFlashProvider: string
  subagentFlashModel: string
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
  subagentFlashProvider: '',
  subagentFlashModel: '',
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
  subagentFlashProvider: fields.subagentFlashProvider,
  subagentFlashModel: fields.subagentFlashModel,
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
  && a.subagentFlashProvider === b.subagentFlashProvider
  && a.subagentFlashModel === b.subagentFlashModel
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

export interface PromptToolStore {
  fields: Fields
  meta: EngineMeta
  loading: boolean
  deepseekProviders: string[]
  bootstrapTokensDraft: string
  skillsDirDraft: string
  savedPromptText: string
  savedAgentsText: string
  savedSwitches: SwitchSnapshot
  savedConfigs: PromptConfigDraft[]
  savedConfigsDir: string
  savingPrompt: boolean
  savingAgents: boolean
  savingSkillsDir: boolean
  fixingSkill: string | undefined
  notice: string
  noticeKind: 'ok' | 'error'
  load: () => Promise<Fields>
  showNotice: (kind: 'ok' | 'error', message: string) => void
  patch: (partial: Partial<Fields>) => void
  savePrompt: () => void
  saveAgents: () => void
  persistSwitches: () => void
  persistConfigs: (configs: PromptConfigDraft[]) => void
  persistConfigsDir: (dir: string) => void
  toggle: (key: SwitchKey) => void
  toggleBootstrapMaxTokens: () => void
  setBootstrapTokensDraft: (value: string) => void
  commitBootstrapTokensDraft: () => void
  setSkillsDirDraft: (value: string) => void
  applySkillsDir: () => void
  applySkillsDirValue: (dir: string) => void
  toggleSkill: (folder: string) => void
  skillEnabled: (folder: string) => boolean
  fixSkill: (folder: string) => void
  openSkillsDir: () => Promise<void>
  discardPrompt: () => void
  discardAgents: () => void
  dirtyPrompt: boolean
  dirtyAgents: boolean
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
  const [savedPromptText, setSavedPromptText] = useState('')
  const [savedAgentsText, setSavedAgentsText] = useState('')
  const [savedSwitches, setSavedSwitches] = useState<SwitchSnapshot>(EMPTY_SWITCHES)
  const [savedConfigs, setSavedConfigs] = useState<PromptConfigDraft[]>([])
  const [savedConfigsDir, setSavedConfigsDir] = useState('')
  const [loading, setLoading] = useState(false)
  const [savingPrompt, setSavingPrompt] = useState(false)
  const [savingAgents, setSavingAgents] = useState(false)
  const [savingSkillsDir, setSavingSkillsDir] = useState(false)
  const [fixingSkill, setFixingSkill] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState('')
  const [noticeKind, setNoticeKind] = useState<'ok' | 'error'>('ok')
  const fieldsRef = useRef<Fields>(EMPTY_FIELDS)
  const revisionRef = useRef<number | undefined>(undefined)
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve())

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
    setSavedPromptText(next.promptText)
    setSavedAgentsText(next.agentsText)
    setSavedSwitches(snapshotSwitches(next))
    setSavedConfigs(next.promptConfigs)
    setSavedConfigsDir(next.promptConfigsDir)
    if (res.ok) revisionRef.current = res.value.revision
    return next
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const metaRes = await bridgePost<{ meta: EngineMeta }>('/meta', {})
      if (metaRes.ok) setMeta(metaRes.value.meta)
      // 自定义 /describe 只用于拿到 live runtime facts（DeepSeek 检测、技能目录快照），
      // 标准 settings 分层数据来自 rc8 共享 describe mirror 的 scope。
      const runtime = await bridgePost<BridgeSettingsView>('/describe', {})
      await settings.ensure()
      const snapshot = await waitForScope(settings.scope)
      const res = bridgeViewFromScope(snapshot, runtime)
      if (!res.ok) {
        showNotice('error', '读取配置失败：' + (res.message ?? ''))
        return EMPTY_FIELDS
      }
      applyView(res)
      setNotice('')
      return fieldsRef.current
    } catch (error) {
      showNotice('error', '读取失败：' + errorMessage(error))
      return EMPTY_FIELDS
    } finally {
      setLoading(false)
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

  const savePrompt = useCallback(() => enqueueSave(
    [{ op: 'set', path: ['promptText'], value: fieldsRef.current.promptText }],
    'preset.md 已保存并生效',
    () => setSavedPromptText(fieldsRef.current.promptText),
    setSavingPrompt,
  ), [enqueueSave])

  const saveAgents = useCallback(() => enqueueSave(
    [{ op: 'set', path: ['agentsText'], value: fieldsRef.current.agentsText }],
    'AGENTS.md 已保存并生效',
    () => setSavedAgentsText(fieldsRef.current.agentsText),
    setSavingAgents,
  ), [enqueueSave])

  const persistSwitches = useCallback(() => enqueueSave(
    [
      { op: 'set', path: ['injectAgentsPrompt'], value: fieldsRef.current.injectAgentsPrompt },
      { op: 'set', path: ['firstTurnAnchor'], value: fieldsRef.current.firstTurnAnchor },
      { op: 'set', path: ['firstTurnText'], value: fieldsRef.current.firstTurnText },
      { op: 'set', path: ['firstTurnCustom'], value: fieldsRef.current.firstTurnCustom },
      { op: 'set', path: ['guideText'], value: fieldsRef.current.guideText },
      { op: 'set', path: ['guideCustom'], value: fieldsRef.current.guideCustom },
      { op: 'set', path: ['subagentFlashProvider'], value: fieldsRef.current.subagentFlashProvider },
      { op: 'set', path: ['subagentFlashModel'], value: fieldsRef.current.subagentFlashModel },
      { op: 'set', path: ['bootstrapMaxTokens'], value: fieldsRef.current.bootstrapMaxTokens },
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
    persistSwitches()
  }, [patch, persistSwitches])

  const toggleBootstrapMaxTokens = useCallback(() => {
    const next = fieldsRef.current.bootstrapMaxTokens > 0 ? 0 : 256000
    patch({ bootstrapMaxTokens: next })
    setBootstrapTokensDraft(DEFAULT_BOOTSTRAP_DISPLAY)
    persistSwitches()
  }, [patch, persistSwitches])

  const commitBootstrapTokensDraft = useCallback(() => {
    const parsed = Number(bootstrapTokensDraft)
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      setBootstrapTokensDraft(DEFAULT_BOOTSTRAP_DISPLAY)
      patch({ bootstrapMaxTokens: 256000 })
    } else {
      patch({ bootstrapMaxTokens: parsed })
    }
    persistSwitches()
  }, [bootstrapTokensDraft, patch, persistSwitches])

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

  const discardPrompt = useCallback(() => patch({ promptText: savedPromptText }), [patch, savedPromptText])
  const discardAgents = useCallback(() => patch({ agentsText: savedAgentsText }), [patch, savedAgentsText])

  const currentSwitches = snapshotSwitches(fields)
  const dirtyPrompt = fields.promptText !== savedPromptText
  const dirtyAgents = fields.agentsText !== savedAgentsText
  const dirtySwitches = !switchesEqual(currentSwitches, savedSwitches)
  const dirtyConfigs = JSON.stringify(fields.promptConfigs) !== JSON.stringify(savedConfigs)
  const dirtyConfigsDir = fields.promptConfigsDir !== savedConfigsDir
  const dirty = dirtyPrompt || dirtyAgents || dirtySwitches || dirtyConfigs || dirtyConfigsDir

  return {
    fields,
    meta,
    loading,
    deepseekProviders,
    bootstrapTokensDraft,
    skillsDirDraft,
    savedPromptText,
    savedAgentsText,
    savedSwitches,
    savedConfigs,
    savedConfigsDir,
    savingPrompt,
    savingAgents,
    savingSkillsDir,
    fixingSkill,
    notice,
    noticeKind,
    load,
    showNotice,
    patch,
    savePrompt,
    saveAgents,
    persistSwitches,
    persistConfigs,
    persistConfigsDir,
    toggle,
    toggleBootstrapMaxTokens,
    setBootstrapTokensDraft,
    commitBootstrapTokensDraft,
    setSkillsDirDraft,
    applySkillsDir,
    applySkillsDirValue,
    toggleSkill,
    skillEnabled,
    fixSkill,
    openSkillsDir,
    discardPrompt,
    discardAgents,
    dirtyPrompt,
    dirtyAgents,
    dirtySwitches,
    dirtyConfigs,
    dirtyConfigsDir,
    dirty,
  }
}
