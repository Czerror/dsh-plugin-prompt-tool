import { useCallback, useRef, useState } from 'react'
import type {
  IApiClient,
  SettingsNamespaceView,
  SettingsPathOpView,
} from '@deepseek-ai/dsh-client-connection/client'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { PromptConfigDraft } from './PromptConfigsEditor.tsx'

export const SETTINGS_BRIDGE_PREFIX = '/api/prompt-tool/settings'

export interface BridgeSettingsView { ns: string; value: unknown; base?: unknown; revision: number }
/** rc8 ui-settings 共享镜像传输面：标准字段经官方 settingsScope 读写。 */
export interface PromptToolSettingsTransport {
  /** 宿主注册的 prompt-tool settings namespace 绑定。 */
  scope: SettingsScope<Record<string, unknown>>
  /** 触发一次共享 describe mirror 读取（idle 时才真正发 RPC）。 */
  ensure: () => Promise<void>
  /** 批量 path-op 写入；成功后已把应答 fold 回共享 mirror。 */
  mutate: (ops: SettingsPathOpView[], expectedRevision?: number) => Promise<SettingsNamespaceView>
}
export type BridgeResult<T> = { ok: true; value: T; deepseekAvailable?: boolean; deepseekProviders?: string[]; deepseekError?: string; activeSkillsDir?: string; skillCatalog?: SkillCatalogEntry[] } | { ok: false; code?: string; message?: string }

export interface SkillCatalogEntry {
  folder: string
  name: string
  description: string
  valid: boolean
  issue?: string
  modelInvocable: boolean
  userInvocable: boolean
}

export interface Fields {
  promptText: string
  promptPath: string
  agentsText: string
  agentsPath: string
  injectAgentsPrompt: boolean
  anchorFirstTurn: boolean
  anchorText: string
  anchorCustom: boolean
  guideText: string
  guideCustom: boolean
  subagentFlash: boolean
  subagentFlashProvider: string
  subagentFlashModel: string
  bootstrapMaxTokens: number
  usePtcMode: boolean
  injectPrompt: boolean
  skillSwitches: Record<string, boolean>
  skillOrder: string[]
  skillCatalog: SkillCatalogEntry[]
  skillsDir: string
  activeSkillsDir: string
  skillRankBase: number
  residentAgentsPath: string
  presetDir: string
  presetOrder: number
  fallbackText: string
  writeAgents: boolean
  writePreset: boolean
  promptConfigs: PromptConfigDraft[]
  promptConfigsDir: string
}

export const EMPTY_FIELDS: Fields = {
  promptText: '',
  promptPath: '',
  agentsText: '',
  agentsPath: '',
  injectAgentsPrompt: false,
  anchorFirstTurn: false,
  anchorText: '',
  anchorCustom: false,
  guideText: '',
  guideCustom: false,
  subagentFlash: false,
  subagentFlashProvider: 'deepseek-official',
  subagentFlashModel: 'deepseek-v4-flash',
  bootstrapMaxTokens: 0,
  usePtcMode: true,
  injectPrompt: true,
  skillSwitches: {},
  skillOrder: [],
  skillCatalog: [],
  skillsDir: '',
  activeSkillsDir: '',
  skillRankBase: 250,
  residentAgentsPath: '',
  presetDir: '',
  presetOrder: 5,
  fallbackText: '',
  writeAgents: true,
  writePreset: true,
  promptConfigs: [],
  promptConfigsDir: '',
}

export interface SwitchSnapshot {
  injectAgentsPrompt: boolean
  anchorFirstTurn: boolean
  anchorText: string
  anchorCustom: boolean
  guideText: string
  guideCustom: boolean
  subagentFlash: boolean
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
  anchorFirstTurn: false,
  anchorText: '',
  anchorCustom: false,
  guideText: '',
  guideCustom: false,
  subagentFlash: false,
  subagentFlashProvider: 'deepseek-official',
  subagentFlashModel: 'deepseek-v4-flash',
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
  anchorFirstTurn: fields.anchorFirstTurn,
  anchorText: fields.anchorText,
  anchorCustom: fields.anchorCustom,
  guideText: fields.guideText,
  guideCustom: fields.guideCustom,
  subagentFlash: fields.subagentFlash,
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
  && a.anchorFirstTurn === b.anchorFirstTurn
  && a.anchorText === b.anchorText
  && a.anchorCustom === b.anchorCustom
  && a.guideText === b.guideText
  && a.guideCustom === b.guideCustom
  && a.subagentFlash === b.subagentFlash
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

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

const readString = (source: Record<string, unknown>, key: string): string | undefined => {
  const value = source[key]
  return typeof value === 'string' ? value : undefined
}

const readStringArray = (source: Record<string, unknown>, key: string): string[] => {
  const value = source[key]
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

const readBoolean = (source: Record<string, unknown>, key: string, fallback: boolean): boolean => {
  const value = source[key]
  return typeof value === 'boolean' ? value : fallback
}

const readNumber = (source: Record<string, unknown>, key: string, fallback: number): number => {
  const value = source[key]
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

const readSkillSwitches = (source: Record<string, unknown>, key: string): Record<string, boolean> => {
  const value = source[key]
  if (value === null || typeof value !== 'object') return {}
  const entries = Object.entries(value as Record<string, unknown>)
  const result: Record<string, boolean> = {}
  for (const [name, enabled] of entries) {
    if (typeof enabled === 'boolean') result[name] = enabled
  }
  return result
}

const readSkillCatalog = (source: Record<string, unknown>, key: string): SkillCatalogEntry[] => {
  const value = source[key]
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (entry === null || typeof entry !== 'object') return []
    const record = entry as Record<string, unknown>
    const folder = readString(record, 'folder')
    const name = readString(record, 'name')
    if (folder === undefined || name === undefined) return []
    return [{
      folder,
      name,
      description: readString(record, 'description') ?? '',
      // 向后兼容旧宿主：旧版 /describe 只返回 folder/name/description（且旧扫描
      // 已过滤非法名），缺字段按旧语义默认 true；新版宿主显式携带 valid=false。
      valid: readBoolean(record, 'valid', true),
      ...(typeof record.issue === 'string' && record.issue.length > 0 ? { issue: record.issue } : {}),
      modelInvocable: readBoolean(record, 'modelInvocable', true),
      userInvocable: readBoolean(record, 'userInvocable', true),
    }]
  })
}

const readPromptConfigs = (source: Record<string, unknown>, key: string): PromptConfigDraft[] => {
  const value = source[key]
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (entry === null || typeof entry !== 'object') return []
    const record = entry as Record<string, unknown>
    return typeof record.id === 'string' && record.id.length > 0 ? [entry as PromptConfigDraft] : []
  })
}

export const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

export async function bridgePost<T>(path: string, body: unknown): Promise<BridgeResult<T>> {
  try {
    const response = await fetch(SETTINGS_BRIDGE_PREFIX + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const payload = await response.json() as unknown
    if (payload !== null && typeof payload === 'object') return payload as BridgeResult<T>
    return { ok: false, message: 'settings bridge unavailable' }
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}

export function fieldsFromView(res: BridgeResult<BridgeSettingsView>): Fields {
  const ns = res.ok ? res.value : undefined
  const value = asRecord(ns?.value)
  const base = asRecord(ns?.base)
  const next: Fields = {
    promptText: readString(value, 'promptText') ?? readString(base, 'promptText') ?? '',
    promptPath: readString(value, 'promptPath') ?? readString(base, 'promptPath') ?? '',
    agentsText: readString(value, 'agentsText') ?? readString(base, 'agentsText') ?? '',
    agentsPath: readString(value, 'agentsPath') ?? readString(base, 'agentsPath') ?? '',
    injectAgentsPrompt: readBoolean(value, 'injectAgentsPrompt', readBoolean(base, 'injectAgentsPrompt', false)),
    anchorFirstTurn: readBoolean(value, 'anchorFirstTurn', readBoolean(base, 'anchorFirstTurn', false)),
    anchorText: readString(value, 'anchorText') ?? readString(base, 'anchorText') ?? '',
    anchorCustom: readBoolean(value, 'anchorCustom', readBoolean(base, 'anchorCustom', false)),
    guideText: readString(value, 'guideText') ?? readString(base, 'guideText') ?? '',
    guideCustom: readBoolean(value, 'guideCustom', readBoolean(base, 'guideCustom', false)),
    subagentFlash: readBoolean(value, 'subagentFlash', readBoolean(base, 'subagentFlash', false)),
    subagentFlashProvider: readString(value, 'subagentFlashProvider') ?? readString(base, 'subagentFlashProvider') ?? 'deepseek-official',
    subagentFlashModel: readString(value, 'subagentFlashModel') ?? readString(base, 'subagentFlashModel') ?? 'deepseek-v4-flash',
    bootstrapMaxTokens: readNumber(value, 'bootstrapMaxTokens', readNumber(base, 'bootstrapMaxTokens', 0)),
    usePtcMode: readBoolean(value, 'usePtcMode', readBoolean(base, 'usePtcMode', true)),
    injectPrompt: readBoolean(value, 'injectPrompt', readBoolean(base, 'injectPrompt', true)),
    skillSwitches: value.skillSwitches !== undefined || base.skillSwitches !== undefined
      ? { ...readSkillSwitches(base, 'skillSwitches'), ...readSkillSwitches(value, 'skillSwitches') }
      : {},
    skillOrder: readStringArray(value, 'skillOrder').length > 0
      ? readStringArray(value, 'skillOrder')
      : readStringArray(base, 'skillOrder'),
    skillCatalog: res.ok && res.skillCatalog !== undefined && res.skillCatalog.length > 0
      ? res.skillCatalog
      : readSkillCatalog(value, 'skillCatalog').length > 0
        ? readSkillCatalog(value, 'skillCatalog')
        : readSkillCatalog(base, 'skillCatalog'),
    skillsDir: readString(value, 'skillsDir') ?? readString(base, 'skillsDir') ?? '',
    activeSkillsDir: res.ok && res.activeSkillsDir !== undefined
      ? res.activeSkillsDir
      : readString(value, 'activeSkillsDir') ?? readString(base, 'activeSkillsDir') ?? '',
    skillRankBase: readNumber(value, 'skillRankBase', readNumber(base, 'skillRankBase', 250)),
    residentAgentsPath: readString(value, 'residentAgentsPath') ?? readString(base, 'residentAgentsPath') ?? '',
    presetDir: readString(value, 'presetDir') ?? readString(base, 'presetDir') ?? '',
    presetOrder: readNumber(value, 'presetOrder', readNumber(base, 'presetOrder', 5)),
    fallbackText: readString(value, 'fallbackText') ?? readString(base, 'fallbackText') ?? '',
    writeAgents: readBoolean(value, 'writeAgents', readBoolean(base, 'writeAgents', true)),
    writePreset: readBoolean(value, 'writePreset', readBoolean(base, 'writePreset', true)),
    promptConfigs: value.promptConfigs !== undefined
      ? readPromptConfigs(value, 'promptConfigs')
      : readPromptConfigs(base, 'promptConfigs'),
    promptConfigsDir: readString(value, 'promptConfigsDir') ?? readString(base, 'promptConfigsDir') ?? '',
  }
  return next
}

export type SwitchKey = 'injectAgentsPrompt' | 'anchorFirstTurn' | 'anchorCustom' | 'guideCustom' | 'subagentFlash' | 'injectPrompt' | 'usePtcMode' | 'writeAgents' | 'writePreset'

export interface PromptToolStore {
  fields: Fields
  loading: boolean
  deepseekAvailable: boolean
  deepseekProviders: string[]
  deepseekError: string
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
    const dispose = scope.subscribe(() => {
      const next = scope.getSnapshot()
      if (next.status === 'loading') return
      dispose()
      resolve(next)
    })
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
    deepseekAvailable: runtime.ok ? runtime.deepseekAvailable : undefined,
    deepseekProviders: runtime.ok ? runtime.deepseekProviders : undefined,
    deepseekError: runtime.ok ? runtime.deepseekError : undefined,
    activeSkillsDir: runtime.ok ? runtime.activeSkillsDir : undefined,
    skillCatalog: runtime.ok ? runtime.skillCatalog : undefined,
  }
}

export function usePromptToolStore(api: IApiClient, settings: PromptToolSettingsTransport): PromptToolStore {
  const [deepseekAvailable, setDeepseekAvailable] = useState(false)
  const [deepseekProviders, setDeepseekProviders] = useState<string[]>([])
  const [deepseekError, setDeepseekError] = useState('')
  const [fields, setFields] = useState<Fields>(EMPTY_FIELDS)
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
    setDeepseekAvailable(res.ok && res.deepseekAvailable === true)
    setDeepseekProviders(res.ok ? res.deepseekProviders ?? [] : [])
    setDeepseekError(res.ok ? res.deepseekError ?? '' : '')
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
      { op: 'set', path: ['anchorFirstTurn'], value: fieldsRef.current.anchorFirstTurn },
      { op: 'set', path: ['anchorText'], value: fieldsRef.current.anchorText },
      { op: 'set', path: ['anchorCustom'], value: fieldsRef.current.anchorCustom },
      { op: 'set', path: ['guideText'], value: fieldsRef.current.guideText },
      { op: 'set', path: ['guideCustom'], value: fieldsRef.current.guideCustom },
      { op: 'set', path: ['subagentFlash'], value: fieldsRef.current.subagentFlash },
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
    if (key === 'subagentFlash' && !deepseekAvailable) {
      showNotice('error', '未检测到 DeepSeek 模型配置，子代理 Flash 开关不可用')
      return
    }
    patch({ [key]: !fieldsRef.current[key] })
    persistSwitches()
  }, [deepseekAvailable, patch, persistSwitches, showNotice])

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
    loading,
    deepseekAvailable,
    deepseekProviders,
    deepseekError,
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
