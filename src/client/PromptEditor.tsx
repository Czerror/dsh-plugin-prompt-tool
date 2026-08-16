import { useCallback, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { IApiClient, RpcResponse, SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-client-connection/client'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import styles from './PromptEditor.module.css'

const NS = 'prompt-tool'

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
  injectPrompt: boolean
  skillSwitches: Record<string, boolean>
  writeAgents: boolean
  writePreset: boolean
}

const EMPTY_SWITCHES: SwitchSnapshot = {
  injectAgentsPrompt: false,
  anchorFirstTurn: false,
  anchorText: '',
  injectPrompt: true,
  skillSwitches: {},
  writeAgents: true,
  writePreset: true,
}

const snapshotSwitches = (fields: Fields): SwitchSnapshot => ({
  injectAgentsPrompt: fields.injectAgentsPrompt,
  anchorFirstTurn: fields.anchorFirstTurn,
  anchorText: fields.anchorText,
  injectPrompt: fields.injectPrompt,
  skillSwitches: { ...fields.skillSwitches },
  writeAgents: fields.writeAgents,
  writePreset: fields.writePreset,
})

const switchesEqual = (a: SwitchSnapshot, b: SwitchSnapshot): boolean =>
  a.injectAgentsPrompt === b.injectAgentsPrompt
  && a.anchorFirstTurn === b.anchorFirstTurn
  && a.anchorText === b.anchorText
  && a.injectPrompt === b.injectPrompt
  && JSON.stringify(a.skillSwitches) === JSON.stringify(b.skillSwitches)
  && a.writeAgents === b.writeAgents
  && a.writePreset === b.writePreset

type SettingsDescribeResponse = RpcResponse<{
  writable: boolean
  hasDocument: boolean
  namespaces: SettingsNamespaceView[]
}>

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
  const [loaded, setLoaded] = useState(false)
  const [fields, setFields] = useState<Fields>(EMPTY)
  const [savedPromptText, setSavedPromptText] = useState('')
  const [savedAgentsText, setSavedAgentsText] = useState('')
  const [savedSwitches, setSavedSwitches] = useState<SwitchSnapshot>(EMPTY_SWITCHES)
  const [loading, setLoading] = useState(false)
  const [savingPrompt, setSavingPrompt] = useState(false)
  const [savingAgents, setSavingAgents] = useState(false)
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
      const res: SettingsDescribeResponse = await api.settings.describe({})
      if (!res.result.ok) { showNotice('error', '读取配置失败'); return }
      const ns = res.result.value.namespaces.find((entry) => entry.ns === NS)
      if (!ns) { showNotice('error', '未找到提示词工具配置'); return }
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
  }, [api, showNotice])

  const refreshRevision = useCallback(async () => {
    try {
      const res: SettingsDescribeResponse = await api.settings.describe({})
      if (!res.result.ok) return
      const ns = res.result.value.namespaces.find((entry) => entry.ns === NS)
      if (ns) revisionRef.current = ns.revision
    } catch {
      // 刷新失败保持原 revision，用户可重试。
    }
  }, [api])

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

  const enqueueSave = useCallback((ops: SettingsPathOpView[], okMessage: string | undefined, onSaved: () => void, setBusy?: (busy: boolean) => void) => {
    setBusy?.(true)
    saveQueueRef.current = saveQueueRef.current.then(async () => {
      try {
        const res = await api.settings.mutate({ ns: NS, ops, expectedRevision: revisionRef.current })
        if (res.result.ok) {
          revisionRef.current = res.result.value.revision
          onSaved()
          if (okMessage) showNotice('ok', okMessage)
        } else {
          await refreshRevision()
          showNotice('error', '保存失败：' + (res.result.error?.message ?? '') + '（已刷新配置版本，可重试）')
        }
      } catch (error) {
        await refreshRevision()
        showNotice('error', '保存失败：' + errorMessage(error) + '（已刷新配置版本，可重试）')
      } finally {
        setBusy?.(false)
      }
    }).catch(() => {})
  }, [api, refreshRevision, showNotice])

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
      { op: 'set', path: ['injectPrompt'], value: fieldsRef.current.injectPrompt },
      { op: 'set', path: ['skillSwitches'], value: fieldsRef.current.skillSwitches },
      { op: 'set', path: ['writeAgents'], value: fieldsRef.current.writeAgents },
      { op: 'set', path: ['writePreset'], value: fieldsRef.current.writePreset },
    ],
    undefined,
    () => setSavedSwitches(snapshotSwitches(fieldsRef.current)),
  )

  const toggle = (key: 'injectAgentsPrompt' | 'anchorFirstTurn' | 'injectPrompt' | 'writeAgents' | 'writePreset') => {
    patch({ [key]: !fieldsRef.current[key] })
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
                  <span className={styles.rowDesc}>开启时注入 preset.md；关闭后不再注入 preset.md。若 AGENTS 头部注入开启，关闭本开关仍会只注入 AGENTS.md</span>
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
                <button type="button" className={styles.secondary} disabled={!dirtyPrompt} onClick={discardPrompt}>还原</button>
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
                    <span className={styles.rowName}>注入 AGENTS.md 到 preset 头部</span>
                    <span className={styles.rowDesc}>开启时把 AGENTS.md 拼接到 preset.md 内容头部注入；与写入 ~/.dsh/AGENTS.md 的全局开关相互独立</span>
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
                <button type="button" className={styles.secondary} disabled={!dirtyAgents} onClick={discardAgents}>还原</button>
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
              title="锚定轮与 preset"
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
                  <span className={styles.rowName}>生成锚定注入 preset</span>
                  <span className={styles.rowDesc}>开启时生成并刷新 preset 目录，承载首轮工具引导与上述注入件；关闭时不生成，已有文件保持原样</span>
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
                  <span className={styles.rowName}>首轮独立锚定轮</span>
                  <span className={styles.rowDesc}>开启时 preset 挂载 turn-anchor：首个真实用户消息先入 next-step，首步只发锚定句</span>
                </span>
              </label>
              <label className={clsx(styles.rowStack, !fields.anchorFirstTurn && styles.rowDisabled)}>
                <span className={styles.rowText}>
                  <span className={styles.rowName}>锚定句文本（可自定义）</span>
                  <span className={styles.rowDesc}>独立锚定轮发给模型的输入内容</span>
                </span>
                <textarea
                  className={styles.anchorInput}
                  value={fields.anchorText}
                  disabled={!fields.writePreset || !fields.anchorFirstTurn}
                  onChange={(e) => patch({ anchorText: e.target.value })}
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
