import { useCallback, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import styles from './PromptEditor.module.css'

const SETTINGS_BRIDGE_PREFIX = '/api/prompt-tool/settings'

type BridgePathOp = { op: 'set' | 'unset'; path: string[]; value?: unknown }
interface BridgeSettingsView { ns: string; value: unknown; base?: unknown; revision: number }
type BridgeResult<T> = { ok: true; value: T; deepseekAvailable?: boolean; deepseekProviders?: string[]; deepseekError?: string } | { ok: false; code?: string; message?: string }

async function bridgePost<T>(path: string, body: unknown): Promise<BridgeResult<T>> {
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

export interface PromptEditorInjected {
  api: IApiClient
}

export type PromptEditorProps = PropsRuntime<'settings.plugin.item'> & InjectFace<PromptEditorInjected>

interface SkillCatalogEntry {
  folder: string
  name: string
  description: string
}

interface Fields {
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
  bootstrapMaxTokens: number
  usePtcMode: boolean
  injectPrompt: boolean
  skillSwitches: Record<string, boolean>
  skillCatalog: SkillCatalogEntry[]
  writeAgents: boolean
  writePreset: boolean
}

const EMPTY: Fields = {
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
  bootstrapMaxTokens: 0,
  usePtcMode: true,
  injectPrompt: true,
  skillSwitches: {},
  skillCatalog: [],
  writeAgents: true,
  writePreset: true,
}

interface SwitchSnapshot {
  injectAgentsPrompt: boolean
  anchorFirstTurn: boolean
  anchorText: string
  anchorCustom: boolean
  guideText: string
  guideCustom: boolean
  subagentFlash: boolean
  bootstrapMaxTokens: number
  usePtcMode: boolean
  injectPrompt: boolean
  skillSwitches: Record<string, boolean>
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
  bootstrapMaxTokens: 0,
  usePtcMode: true,
  injectPrompt: true,
  skillSwitches: {},
  writeAgents: true,
  writePreset: true,
}

/** 本项目默认不设上限时的显示值（adapter 默认 maxTokens）。 */
const DEFAULT_BOOTSTRAP_DISPLAY = '256000'

const snapshotSwitches = (fields: Fields): SwitchSnapshot => ({
  injectAgentsPrompt: fields.injectAgentsPrompt,
  anchorFirstTurn: fields.anchorFirstTurn,
  anchorText: fields.anchorText,
  anchorCustom: fields.anchorCustom,
  guideText: fields.guideText,
  guideCustom: fields.guideCustom,
  subagentFlash: fields.subagentFlash,
  bootstrapMaxTokens: fields.bootstrapMaxTokens,
  usePtcMode: fields.usePtcMode,
  injectPrompt: fields.injectPrompt,
  skillSwitches: { ...fields.skillSwitches },
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
  && a.bootstrapMaxTokens === b.bootstrapMaxTokens
  && a.usePtcMode === b.usePtcMode
  && a.injectPrompt === b.injectPrompt
  && JSON.stringify(a.skillSwitches) === JSON.stringify(b.skillSwitches)
  && a.writeAgents === b.writeAgents
  && a.writePreset === b.writePreset

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}

const readString = (source: Record<string, unknown>, key: string): string | undefined => {
  const value = source[key]
  return typeof value === 'string' ? value : undefined
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
    return [{ folder, name, description: readString(record, 'description') ?? '' }]
  })
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

function CollapsibleSection(props: { title: string; hint?: string; open: boolean; onToggle: () => void; children: ReactNode }): ReactNode {
  return (
    <div className={styles.subSection}>
      <button type="button" className={styles.subHeader} aria-expanded={props.open} onClick={props.onToggle}>
        <span className={styles.subTitle}>{props.title}</span>
        {props.hint && <span className={styles.subCount}>{props.hint}</span>}
        <IconChevronDownOutline14 className={clsx(styles.chevron, props.open && styles.chevronOpen)} />
      </button>
      {props.open && <div className={styles.subBody}>{props.children}</div>}
    </div>
  )
}

export function PromptEditor(props: PromptEditorProps): ReactNode {
  const { api } = props
  const [open, setOpen] = useState(false)
  const [promptOpen, setPromptOpen] = useState(false)
  const [agentsOpen, setAgentsOpen] = useState(false)
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [presetOpen, setPresetOpen] = useState(false)
  const [deepseekAvailable, setDeepseekAvailable] = useState(false)
  const [deepseekProviders, setDeepseekProviders] = useState<string[]>([])
  const [deepseekError, setDeepseekError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [fields, setFields] = useState<Fields>(EMPTY)
  const [bootstrapTokensDraft, setBootstrapTokensDraft] = useState(DEFAULT_BOOTSTRAP_DISPLAY)
  const [savedPromptText, setSavedPromptText] = useState('')
  const [savedAgentsText, setSavedAgentsText] = useState('')
  const [savedSwitches, setSavedSwitches] = useState<SwitchSnapshot>(EMPTY_SWITCHES)
  const [loading, setLoading] = useState(false)
  const [savingPrompt, setSavingPrompt] = useState(false)
  const [savingAgents, setSavingAgents] = useState(false)
  const [restoringPrompt, setRestoringPrompt] = useState(false)
  const [restoringAgents, setRestoringAgents] = useState(false)
  const [notice, setNotice] = useState('')
  const [noticeKind, setNoticeKind] = useState<'ok' | 'error'>('ok')
  const fieldsRef = useRef<Fields>(EMPTY)
  const revisionRef = useRef<number | undefined>(undefined)
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve())

  const showNotice = useCallback((kind: 'ok' | 'error', message: string) => {
    setNotice(message)
    setNoticeKind(kind)
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await bridgePost<BridgeSettingsView>('/describe', {})
      if (!res.ok) { showNotice('error', '读取配置失败：' + (res.message ?? '')); return }
      setDeepseekAvailable(res.deepseekAvailable === true)
      setDeepseekProviders(res.deepseekProviders ?? [])
      setDeepseekError(res.deepseekError ?? '')
      const ns = res.value
      const value = asRecord(ns.value)
      const base = asRecord(ns.base)
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
        bootstrapMaxTokens: readNumber(value, 'bootstrapMaxTokens', readNumber(base, 'bootstrapMaxTokens', 0)),
        usePtcMode: readBoolean(value, 'usePtcMode', readBoolean(base, 'usePtcMode', true)),
        injectPrompt: readBoolean(value, 'injectPrompt', readBoolean(base, 'injectPrompt', true)),
        skillSwitches: value.skillSwitches !== undefined || base.skillSwitches !== undefined
          ? { ...readSkillSwitches(base, 'skillSwitches'), ...readSkillSwitches(value, 'skillSwitches') }
          : {},
        skillCatalog: readSkillCatalog(value, 'skillCatalog').length > 0
          ? readSkillCatalog(value, 'skillCatalog')
          : readSkillCatalog(base, 'skillCatalog'),
        writeAgents: readBoolean(value, 'writeAgents', readBoolean(base, 'writeAgents', true)),
        writePreset: readBoolean(value, 'writePreset', readBoolean(base, 'writePreset', true)),
      }
      fieldsRef.current = next
      setFields(next)
      setBootstrapTokensDraft(next.bootstrapMaxTokens > 0 ? String(next.bootstrapMaxTokens) : DEFAULT_BOOTSTRAP_DISPLAY)
      setSavedPromptText(next.promptText)
      setSavedAgentsText(next.agentsText)
      setSavedSwitches(snapshotSwitches(next))
      revisionRef.current = ns.revision
      setNotice('')
    } catch (error) {
      showNotice('error', '读取失败：' + errorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [showNotice])

  const refreshRevision = useCallback(async () => {
    try {
      const res = await bridgePost<BridgeSettingsView>('/describe', {})
      if (!res.ok) return
      revisionRef.current = res.value.revision
    } catch {
      // 刷新失败保持原 revision，用户可重试。
    }
  }, [])

  const restoreOriginal = useCallback(async (scope: 'preset' | 'agents') => {
    const setBusy = scope === 'preset' ? setRestoringPrompt : setRestoringAgents
    setBusy(true)
    try {
      const res = await bridgePost<BridgeSettingsView>('/restore-originals', {
        scope,
        expectedRevision: revisionRef.current,
      })
      if (!res.ok) {
        await refreshRevision()
        showNotice('error', '从项目还原失败：' + (res.message ?? '') + '（已刷新配置版本，可重试）')
        return
      }
      revisionRef.current = res.value.revision
      await load()
      showNotice('ok', scope === 'preset' ? 'preset.md 已从项目原文还原到设置' : 'AGENTS.md 已从项目原文还原到设置')
    } catch (error) {
      await refreshRevision()
      showNotice('error', '从项目还原失败：' + errorMessage(error) + '（已刷新配置版本，可重试）')
    } finally {
      setBusy(false)
    }
  }, [load, refreshRevision, showNotice])

  const patch = (partial: Partial<Fields>) => {
    const next = { ...fieldsRef.current, ...partial }
    fieldsRef.current = next
    setFields(next)
  }

  const toggleOpen = () => {
    const next = !open
    setOpen(next)
    if (!next) return
    if (!loaded) {
      setLoaded(true)
      void load()
    } else if (!dirty) {
      // 无未保存草稿时，每次展开同步最新 settings（其他客户端可能已修改）。
      void load()
    }
  }

  const openEdit = async () => {
    if (!fields.promptPath) { showNotice('error', '路径未知，请先保存一次或在下方直接编辑'); return }
    try {
      const res = await api.host.openPath({ path: fields.promptPath })
      if (res.result.ok) showNotice('ok', '已用系统编辑器打开 preset.md')
      else showNotice('error', '打开失败：' + (res.result.error?.message ?? '') + '；可直接在下方编辑框保存')
    } catch (error) {
      showNotice('error', '打开失败：' + errorMessage(error) + '；可直接在下方编辑框保存')
    }
  }

  const openAgents = async () => {
    if (!fields.agentsPath) { showNotice('error', '路径未知，请先保存一次或在下方直接编辑'); return }
    try {
      const res = await api.host.openPath({ path: fields.agentsPath })
      if (res.result.ok) showNotice('ok', '已用系统编辑器打开 AGENTS.md')
      else showNotice('error', '打开失败：' + (res.result.error?.message ?? '') + '；可直接在下方编辑框保存')
    } catch (error) {
      showNotice('error', '打开失败：' + errorMessage(error) + '；可直接在下方编辑框保存')
    }
  }

  const enqueueSave = useCallback((ops: BridgePathOp[], okMessage: string | undefined, onSaved: () => void, setBusy?: (busy: boolean) => void) => {
    setBusy?.(true)
    saveQueueRef.current = saveQueueRef.current.then(async () => {
      try {
        const res = await bridgePost<BridgeSettingsView>('/mutate', { ops, expectedRevision: revisionRef.current })
        if (res.ok) {
          revisionRef.current = res.value.revision
          onSaved()
          if (okMessage) showNotice('ok', okMessage)
        } else {
          await refreshRevision()
          showNotice('error', '保存失败：' + (res.message ?? '') + '（已刷新配置版本，可重试）')
        }
      } catch (error) {
        await refreshRevision()
        showNotice('error', '保存失败：' + errorMessage(error) + '（已刷新配置版本，可重试）')
      } finally {
        setBusy?.(false)
      }
    }).catch(() => {})
  }, [refreshRevision, showNotice])

  const savePrompt = () => enqueueSave(
    [{ op: 'set', path: ['promptText'], value: fieldsRef.current.promptText }],
    'preset.md 已保存并生效',
    () => setSavedPromptText(fieldsRef.current.promptText),
    setSavingPrompt,
  )

  const saveAgents = () => enqueueSave(
    [{ op: 'set', path: ['agentsText'], value: fieldsRef.current.agentsText }],
    'AGENTS.md 已保存并生效',
    () => setSavedAgentsText(fieldsRef.current.agentsText),
    setSavingAgents,
  )

  const persistSwitches = () => enqueueSave(
    [
      { op: 'set', path: ['injectAgentsPrompt'], value: fieldsRef.current.injectAgentsPrompt },
      { op: 'set', path: ['anchorFirstTurn'], value: fieldsRef.current.anchorFirstTurn },
      { op: 'set', path: ['anchorText'], value: fieldsRef.current.anchorText },
      { op: 'set', path: ['anchorCustom'], value: fieldsRef.current.anchorCustom },
      { op: 'set', path: ['guideText'], value: fieldsRef.current.guideText },
      { op: 'set', path: ['guideCustom'], value: fieldsRef.current.guideCustom },
      { op: 'set', path: ['subagentFlash'], value: fieldsRef.current.subagentFlash },
      { op: 'set', path: ['bootstrapMaxTokens'], value: fieldsRef.current.bootstrapMaxTokens },
      { op: 'set', path: ['usePtcMode'], value: fieldsRef.current.usePtcMode },
      { op: 'set', path: ['injectPrompt'], value: fieldsRef.current.injectPrompt },
      { op: 'set', path: ['skillSwitches'], value: fieldsRef.current.skillSwitches },
      { op: 'set', path: ['writeAgents'], value: fieldsRef.current.writeAgents },
      { op: 'set', path: ['writePreset'], value: fieldsRef.current.writePreset },
    ],
    undefined,
    () => setSavedSwitches(snapshotSwitches(fieldsRef.current)),
  )

  const toggle = (key: 'injectAgentsPrompt' | 'anchorFirstTurn' | 'anchorCustom' | 'guideCustom' | 'subagentFlash' | 'injectPrompt' | 'usePtcMode' | 'writeAgents' | 'writePreset') => {
    if (key === 'subagentFlash' && !deepseekAvailable) {
      showNotice('error', '未检测到 DeepSeek 模型配置，子代理 Flash 开关不可用')
      return
    }
    patch({ [key]: !fieldsRef.current[key] })
    persistSwitches()
  }

  const toggleBootstrapMaxTokens = () => {
    const next = fieldsRef.current.bootstrapMaxTokens > 0 ? 0 : 256000
    patch({ bootstrapMaxTokens: next })
    setBootstrapTokensDraft(DEFAULT_BOOTSTRAP_DISPLAY)
    persistSwitches()
  }

  const commitBootstrapTokensDraft = () => {
    const parsed = Number(bootstrapTokensDraft)
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      // 清空或非法输入不关闭开关：恢复为项目默认 256000（不设上限）。
      setBootstrapTokensDraft(DEFAULT_BOOTSTRAP_DISPLAY)
      patch({ bootstrapMaxTokens: 256000 })
    } else {
      patch({ bootstrapMaxTokens: parsed })
    }
    persistSwitches()
  }

  const skillEnabled = (folder: string) => fields.skillSwitches[folder] !== false

  const toggleSkill = (folder: string) => {
    const enabled = fieldsRef.current.skillSwitches[folder] !== false
    patch({ skillSwitches: { ...fieldsRef.current.skillSwitches, [folder]: !enabled } })
    persistSwitches()
  }

  const currentSwitches = snapshotSwitches(fields)
  const dirtyPrompt = fields.promptText !== savedPromptText
  const dirtyAgents = fields.agentsText !== savedAgentsText
  const dirtySwitches = !switchesEqual(currentSwitches, savedSwitches)
  const dirty = dirtyPrompt || dirtyAgents || dirtySwitches
  const promptSwitchDirty = fields.injectPrompt !== savedSwitches.injectPrompt
  const agentsSwitchDirty = fields.injectAgentsPrompt !== savedSwitches.injectAgentsPrompt
    || fields.writeAgents !== savedSwitches.writeAgents
  const skillsSwitchDirty = JSON.stringify(fields.skillSwitches) !== JSON.stringify(savedSwitches.skillSwitches)
  const presetSwitchDirty = fields.writePreset !== savedSwitches.writePreset
    || fields.anchorFirstTurn !== savedSwitches.anchorFirstTurn
    || fields.anchorText !== savedSwitches.anchorText
    || fields.bootstrapMaxTokens !== savedSwitches.bootstrapMaxTokens
    || fields.usePtcMode !== savedSwitches.usePtcMode

  const discardPrompt = () => patch({ promptText: savedPromptText })
  const discardAgents = () => patch({ agentsText: savedAgentsText })

  return (
    <li className={clsx(styles.card, open && styles.cardOpen)}>
      <button type="button" className={styles.header} aria-expanded={open} onClick={toggleOpen}>
        <span className={styles.headText}>
          <span className={styles.name}>提示词工具</span>
          <span className={styles.description}>编辑 preset.md / AGENTS.md 与各层注入开关，保存后自动生效</span>
        </span>
        {dirty && <span className={styles.pending}>未保存</span>}
        <IconChevronDownOutline14 className={clsx(styles.chevron, open && styles.chevronOpen)} />
      </button>
      {open && (
          <div className={styles.body}>
            {loading && <span className={styles.loading}>正在读取配置…</span>}

            <CollapsibleSection
              title="Preset预设"
              hint={dirtyPrompt || promptSwitchDirty ? '未保存' : undefined}
              open={promptOpen}
              onToggle={() => setPromptOpen(!promptOpen)}
            >
              <label className={styles.row}>
                <input
                  type="checkbox"
                  checked={fields.injectPrompt}
                    disabled={!fields.writePreset}
                  onChange={() => toggle('injectPrompt')}
                />
                <span className={styles.rowText}>
                  <span className={styles.rowName}>注入 preset.md（锚定层）</span>
                  <span className={styles.rowDesc}>注入会话晋升后的 agent/pre-step，消息插入决策消息开头，每会话一次</span>
                </span>
              </label>
              <textarea
                className={styles.textarea}
                aria-label="preset.md 内容"
                value={fields.promptText}
                onChange={(e) => patch({ promptText: e.target.value })}
                spellCheck={false}
              />
              <div className={styles.actions}>
                <button type="button" className={styles.primary} disabled={savingPrompt || savingAgents || !dirtyPrompt} onClick={savePrompt}>{savingPrompt ? '保存中…' : '保存'}</button>
                <button type="button" className={styles.secondary} disabled={!dirtyPrompt} onClick={discardPrompt}>还原草稿</button>
                <button type="button" className={styles.secondary} disabled={savingPrompt || savingAgents || restoringPrompt || restoringAgents} onClick={() => void restoreOriginal('preset')}>{restoringPrompt ? '还原中…' : '项目还原'}</button>
                <button type="button" className={styles.secondary} onClick={openEdit}>打开</button>
              </div>
            </CollapsibleSection>

            <CollapsibleSection
              title="AGENTS设置"
              hint={dirtyAgents || agentsSwitchDirty ? '未保存' : undefined}
              open={agentsOpen}
              onToggle={() => setAgentsOpen(!agentsOpen)}
            >
              <label className={styles.row}>
                  <input
                    type="checkbox"
                    checked={fields.injectAgentsPrompt}
                    disabled={!fields.writePreset}
                    onChange={() => toggle('injectAgentsPrompt')}
                  />
                  <span className={styles.rowText}>
                    <span className={styles.rowName}>注入 AGENTS.md</span>
                    <span className={styles.rowDesc}>注入会话晋升后的第一个 agent/pre-step，消息追加在决策消息末尾，每会话一次</span>
                  </span>
                </label>
                <label className={styles.row}>
                  <input
                    type="checkbox"
                    checked={fields.writeAgents}
                    onChange={() => toggle('writeAgents')}
                  />
                  <span className={styles.rowText}>
                    <span className={styles.rowName}>写入 ~/.dsh/AGENTS.md</span>
                    <span className={styles.rowDesc}>保持 AGENTS.md 的全局常驻注入；关闭后不再写入，已有文件保持原样</span>
                  </span>
                </label>
              <textarea
                className={styles.textarea}
                aria-label="AGENTS.md 内容"
                value={fields.agentsText}
                onChange={(e) => patch({ agentsText: e.target.value })}
                spellCheck={false}
              />
              <div className={styles.actions}>
                <button type="button" className={styles.primary} disabled={savingPrompt || savingAgents || !dirtyAgents} onClick={saveAgents}>{savingAgents ? '保存中…' : '保存'}</button>
                <button type="button" className={styles.secondary} disabled={!dirtyAgents} onClick={discardAgents}>还原草稿</button>
                <button type="button" className={styles.secondary} disabled={savingPrompt || savingAgents || restoringPrompt || restoringAgents} onClick={() => void restoreOriginal('agents')}>{restoringAgents ? '还原中…' : '项目还原'}</button>
                <button type="button" className={styles.secondary} onClick={openAgents}>打开</button>
              </div>
            </CollapsibleSection>

            <CollapsibleSection
              title="Skills设置"
              hint={`${fields.skillCatalog.length} 个${skillsSwitchDirty ? ' · 未保存' : ''}`}
              open={skillsOpen}
              onToggle={() => setSkillsOpen(!skillsOpen)}
            >
              {fields.skillCatalog.length === 0 ? (
                <span className={styles.subEmpty}>skills 目录下没有技能</span>
              ) : fields.skillCatalog.map((skill) => (
                <label key={skill.folder} className={styles.row}>
                  <input
                    type="checkbox"
                    checked={skillEnabled(skill.folder)}
                    onChange={() => toggleSkill(skill.folder)}
                  />
                  <span className={styles.rowText}>
                    <span className={styles.rowName}>{skill.name || skill.folder}</span>
                    <span className={styles.rowDesc}>skills/{skill.folder}{skill.description ? ` · ${skill.description}` : ''}</span>
                  </span>
                </label>
              ))}
            </CollapsibleSection>

            <CollapsibleSection
              title="锚定与 preset"
              hint={presetSwitchDirty ? '未保存' : undefined}
              open={presetOpen}
              onToggle={() => setPresetOpen(!presetOpen)}
            >

              <label className={styles.row}>
                <input
                  type="checkbox"
                  checked={fields.writePreset}
                  onChange={() => toggle('writePreset')}
                />
                <span className={styles.rowText}>
                  <span className={styles.rowName}>启用锚定预设</span>
                  <span className={styles.rowDesc}>总开关：开启时生成并刷新 ~/.dsh/.agent-presets/prompt-tool/，整套锚定预设才有载体；关闭时移除已生成的目录，下面锚定开关随之失效</span>
                </span>
              </label>

              <label className={styles.row}>
                <input
                  type="checkbox"
                  checked={fields.usePtcMode}
                  disabled={!fields.writePreset}
                  onChange={() => toggle('usePtcMode')}
                />
                <span className={styles.rowText}>
                  <span className={styles.rowName}>使用 PTC 模式</span>
                  <span className={styles.rowDesc}>默认开启：晋升后把 wire 切换为 Code Mode（PTC，单一 run_code），完整插件工具通过生成 SDK 调用。关闭后恢复原生完整工具目录</span>
                </span>
              </label>

              <div className={styles.row}>
                <input
                  id="prompt-tool-bootstrap-max-tokens"
                  type="checkbox"
                  checked={fields.bootstrapMaxTokens > 0}
                  disabled={!fields.writePreset}
                  onChange={toggleBootstrapMaxTokens}
                />
                <label htmlFor="prompt-tool-bootstrap-max-tokens" className={styles.rowText}>
                  <span className={styles.rowName}>首轮输出封顶</span>
                  <span className={styles.rowDesc}>关闭时显示项目默认 256000（不设上限）；开启后右侧数值生效，晋升后自动剥离。清空或输入 0 会恢复 256000，不关闭开关</span>
                </label>
                <input
                  className={styles.bootstrapTokensInput}
                  type="number"
                  min={1}
                  step={1}
                  value={bootstrapTokensDraft}
                  disabled={!fields.writePreset || fields.bootstrapMaxTokens === 0}
                  onChange={(e) => setBootstrapTokensDraft(e.target.value)}
                  onBlur={commitBootstrapTokensDraft}
                />
              </div>
              <label className={styles.row}>
                <input
                  type="checkbox"
                  checked={fields.subagentFlash}
                  disabled={!fields.writePreset || !deepseekAvailable}
                  onChange={() => toggle('subagentFlash')}
                />
                <span className={styles.rowText}>
                  <span className={styles.rowName}>子代理固定 Flash 模型</span>
                  <span className={styles.rowDesc}>{deepseekAvailable ? '开启时采用 dsh-router-standard 的 Flash 子代理方案：固定 Flash 路由 + 任务分类人设 + 三锚；宿主直派子代理（含 dsh-mnemon）也会自动补 Flash 路由。关闭时继承主会话模型，工具目录全量放行' : `未检测到 DeepSeek 模型配置，此开关不可用。providers=[${deepseekProviders.join(', ') || '空'}]${deepseekError ? ' error=' + deepseekError : ''}`}</span>
                </span>
              </label>
              <label className={styles.row}>
                <input
                  type="checkbox"
                  checked={fields.anchorFirstTurn}
                  disabled={!fields.writePreset}
                  onChange={() => toggle('anchorFirstTurn')}
                />
                <span className={styles.rowText}>
                  <span className={styles.rowName}>追加任务引导</span>
                  <span className={styles.rowDesc}>总开关：开启后在首条真实用户消息之后追加任务引导；关闭时下方首句与每轮的自定义开关、编辑框全部禁用</span>
                </span>
              </label>
              <label className={styles.row}>
                <input
                  type="checkbox"
                  checked={fields.anchorCustom}
                  disabled={!fields.writePreset || !fields.anchorFirstTurn}
                  onChange={() => toggle('anchorCustom')}
                />
                <span className={styles.rowText}>
                  <span className={styles.rowName}>使用自定义引导（首句）</span>
                  <span className={styles.rowDesc}>开启时使用下方文本作为引导；关闭时忽略下方文本，按任务自动选择 we/let 引导</span>
                </span>
              </label>
              <label className={clsx(styles.rowStack, (!fields.anchorFirstTurn || !fields.anchorCustom) && styles.rowDisabled)}>
                <span className={styles.rowText}>
                  <span className={styles.rowName}>自定义引导文本（首句）</span>
                  <span className={styles.rowDesc}>仅在上方“使用自定义引导（首句）”开启时生效；关闭时自动文本优先</span>
                </span>
                <textarea
                  className={styles.anchorInput}
                  value={fields.anchorText}
                  disabled={!fields.writePreset || !fields.anchorFirstTurn || !fields.anchorCustom}
                  onChange={(e) => patch({ anchorText: e.target.value })}
                  onBlur={() => persistSwitches()}
                  spellCheck={false}
                />
              </label>
              <label className={styles.row}>
                <input
                  type="checkbox"
                  checked={fields.guideCustom}
                  disabled={!fields.writePreset || !fields.anchorFirstTurn}
                  onChange={() => toggle('guideCustom')}
                />
                <span className={styles.rowText}>
                  <span className={styles.rowName}>使用自定义引导（每轮）</span>
                  <span className={styles.rowDesc}>开启时每轮固定使用下方文本作为引导；关闭时忽略下方文本，按任务自动选择</span>
                </span>
              </label>
              <label className={clsx(styles.rowStack, (!fields.anchorFirstTurn || !fields.guideCustom) && styles.rowDisabled)}>
                <span className={styles.rowText}>
                  <span className={styles.rowName}>自定义引导文本（每轮）</span>
                  <span className={styles.rowDesc}>仅在上方“使用自定义引导（每轮）”开启时生效；留空则不注入</span>
                </span>
                <textarea
                  className={styles.anchorInput}
                  value={fields.guideText}
                  disabled={!fields.writePreset || !fields.anchorFirstTurn || !fields.guideCustom}
                  onChange={(e) => patch({ guideText: e.target.value })}
                  onBlur={() => persistSwitches()}
                  spellCheck={false}
                />
              </label>
            </CollapsibleSection>

            {notice && <span className={clsx(styles.notice, noticeKind === 'error' && styles.noticeError)}>{notice}</span>}
        </div>
      )}
    </li>
  )
}
