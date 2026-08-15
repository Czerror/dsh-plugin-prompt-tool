import { useCallback, useState } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import styles from './PromptEditor.module.css'

const NS = 'prompt-tool'

export interface PromptEditorInjected {
  api: any
}

interface Fields {
  promptText: string
  promptPath: string
  anchorFirstTurn: boolean
  anchorText: string
  writeAgents: boolean
  writePreset: boolean
}

const EMPTY: Fields = {
  promptText: '',
  promptPath: '',
  anchorFirstTurn: false,
  anchorText: '',
  writeAgents: true,
  writePreset: true,
}

export function PromptEditor(props: PromptEditorInjected): any {
  const { api } = props
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [fields, setFields] = useState<Fields>(EMPTY)
  const [saved, setSaved] = useState<string | undefined>(undefined)
  const [revision, setRevision] = useState<number | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  const [noticeKind, setNoticeKind] = useState<'ok' | 'error'>('ok')

  const showNotice = useCallback((kind: 'ok' | 'error', message: string) => {
    setNotice(message)
    setNoticeKind(kind)
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.settings.describe({})
      if (!res.result.ok) { showNotice('error', '读取配置失败'); return }
      const ns = res.result.value.namespaces.find((n: any) => n.ns === NS)
      if (!ns) { showNotice('error', '未找到提示词工具配置'); return }
      const next: Fields = {
        promptText: ns.value?.promptText ?? '',
        promptPath: ns.value?.promptPath ?? '',
        anchorFirstTurn: ns.value?.anchorFirstTurn ?? false,
        anchorText: ns.value?.anchorText ?? '',
        writeAgents: ns.value?.writeAgents ?? true,
        writePreset: ns.value?.writePreset ?? true,
      }
      setFields(next)
      setSaved(JSON.stringify(next))
      setRevision(ns.revision)
      setNotice('')
    } catch (e: any) {
      showNotice('error', '读取失败：' + (e?.message ?? e))
    } finally {
      setLoading(false)
    }
  }, [api, showNotice])

  const refreshRevision = useCallback(async () => {
    try {
      const res = await api.settings.describe({})
      if (!res.result.ok) return
      const ns = res.result.value.namespaces.find((n: any) => n.ns === NS)
      if (ns) setRevision(ns.revision)
    } catch {
      // 刷新失败保持原 revision，用户可重试。
    }
  }, [api])

  const patch = (partial: Partial<Fields>) => setFields((prev) => ({ ...prev, ...partial }))

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

  const discard = () => {
    void load()
  }

  const openEdit = async () => {
    if (!fields.promptPath) { showNotice('error', '路径未知，请先保存一次或在下方直接编辑'); return }
    try {
      const res = await api.host.openPath({ path: fields.promptPath })
      if (res.result.ok) showNotice('ok', '已用系统编辑器打开 prompt.md')
      else showNotice('error', '打开失败：' + (res.result.error?.message ?? '') + '；可直接在下方编辑框保存')
    } catch (e: any) {
      showNotice('error', '打开失败：' + (e?.message ?? e) + '；可直接在下方编辑框保存')
    }
  }

  const save = async () => {
    if (saving) return
    setSaving(true)
    try {
      const res = await api.settings.mutate({
        ns: NS,
        ops: [
          { op: 'set', path: ['promptText'], value: fields.promptText },
          { op: 'set', path: ['anchorFirstTurn'], value: fields.anchorFirstTurn },
          { op: 'set', path: ['anchorText'], value: fields.anchorText },
          { op: 'set', path: ['writeAgents'], value: fields.writeAgents },
          { op: 'set', path: ['writePreset'], value: fields.writePreset },
        ],
        expectedRevision: revision,
      })
      if (res.result.ok) {
        setRevision(res.result.value.revision)
        setSaved(JSON.stringify(fields))
        showNotice('ok', '已保存并生效')
      } else {
        await refreshRevision()
        showNotice('error', '保存失败：' + (res.result.error?.message ?? '') + '（已刷新配置版本，可重试）')
      }
    } catch (e: any) {
      await refreshRevision()
      showNotice('error', '保存失败：' + (e?.message ?? e) + '（已刷新配置版本，可重试）')
    } finally {
      setSaving(false)
    }
  }

  const toggle = (key: 'anchorFirstTurn' | 'writeAgents' | 'writePreset') =>
    patch({ [key]: !fields[key] })

  const dirty = saved !== undefined && JSON.stringify(fields) !== saved

  return (
    <li className={clsx(styles.card, open && styles.cardOpen)}>
      <button type="button" className={styles.header} aria-expanded={open} onClick={toggleOpen}>
        <span className={styles.headText}>
          <span className={styles.name}>提示词工具</span>
          <span className={styles.description}>编辑模型行为规范 prompt.md 与注入开关，保存后自动生效</span>
        </span>
        {dirty && <span className={styles.pending}>未保存</span>}
        <IconChevronDownOutline14 className={clsx(styles.chevron, open && styles.chevronOpen)} />
      </button>
      {open && (
        <div className={styles.body}>
          {loading && <span className={styles.loading}>正在读取配置…</span>}

          <div className={styles.group}>
            <span className={styles.groupTitle}>注入开关</span>
            <label className={styles.row}>
              <input
                type="checkbox"
                checked={fields.anchorFirstTurn}
                onChange={() => toggle('anchorFirstTurn')}
              />
              <span className={styles.rowText}>
                <span className={styles.rowName}>首轮独立锚定轮</span>
                <span className={styles.rowDesc}>首个用户消息先入 next-step，首步只发锚定句</span>
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
                disabled={!fields.anchorFirstTurn}
                onChange={(e) => patch({ anchorText: e.target.value })}
                spellCheck={false}
              />
            </label>
            <label className={styles.row}>
              <input
                type="checkbox"
                checked={fields.writeAgents}
                onChange={() => toggle('writeAgents')}
              />
              <span className={styles.rowText}>
                <span className={styles.rowName}>写入 ~/.dsh/AGENTS.md</span>
                <span className={styles.rowDesc}>常驻层规则（默认开启）</span>
              </span>
            </label>
            <label className={styles.row}>
              <input
                type="checkbox"
                checked={fields.writePreset}
                onChange={() => toggle('writePreset')}
              />
              <span className={styles.rowText}>
                <span className={styles.rowName}>生成锚定注入 preset</span>
                <span className={styles.rowDesc}>prompt.md 注入与首轮工具引导（默认开启）</span>
              </span>
            </label>
          </div>

          <div className={styles.group}>
            <span className={styles.groupTitle}>prompt.md 内容</span>
            <textarea
              className={styles.textarea}
              aria-label="prompt.md 内容"
              value={fields.promptText}
              onChange={(e) => patch({ promptText: e.target.value })}
              spellCheck={false}
            />
          </div>

          <div className={styles.actions}>
            <button type="button" className={styles.primary} disabled={saving || !dirty} onClick={save}>{saving ? '保存中…' : '保存'}</button>
            <button type="button" className={styles.secondary} disabled={!dirty} onClick={discard}>还原</button>
            <button type="button" className={styles.secondary} onClick={openEdit}>打开编辑</button>
            {notice && <span className={clsx(styles.notice, noticeKind === 'error' && styles.noticeError)}>{notice}</span>}
          </div>
        </div>
      )}
    </li>
  )
}
