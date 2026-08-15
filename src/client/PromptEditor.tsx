import { useCallback, useEffect, useState } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import styles from './PromptEditor.module.css'

const NS = 'prompt-tool'

export interface PromptEditorInjected {
  api: any
}

export function PromptEditor(props: PromptEditorInjected): any {
  const { api } = props
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [path, setPath] = useState('')
  const [revision, setRevision] = useState<number | undefined>(undefined)
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await api.settings.describe({})
      if (!res.result.ok) { setNotice('读取配置失败'); return }
      const ns = res.result.value.namespaces.find((n: any) => n.ns === NS)
      if (!ns) { setNotice('未找到提示词工具配置'); return }
      setText(ns.value?.promptText ?? '')
      setPath(ns.value?.promptPath ?? '')
      setRevision(ns.revision)
      setNotice('')
    } catch (e: any) {
      setNotice('读取失败：' + (e?.message ?? e))
    }
  }, [api])

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next) void load()
  }

  const openEdit = async () => {
    if (!path) { setNotice('路径未知，无法打开'); return }
    const res = await api.host.openPath({ path })
    setNotice(res.result.ok ? '已用系统编辑器打开 prompt.md' : '打开失败：' + (res.result.error?.message ?? ''))
  }

  const save = async () => {
    const res = await api.settings.mutate({
      ns: NS,
      ops: [{ op: 'set', path: ['promptText'], value: text }],
      expectedRevision: revision,
    })
    if (res.result.ok) {
      setRevision(res.result.value.revision)
      setNotice('已保存并生效')
    } else {
      setNotice('保存失败：' + (res.result.error?.message ?? ''))
    }
  }

  return (
    <li className={clsx(styles.card, open && styles.cardOpen)}>
      <button type="button" className={styles.header} aria-expanded={open} onClick={toggle}>
        <span className={styles.headText}>
          <span className={styles.name}>提示词工具</span>
          <span className={styles.description}>编辑模型行为规范 prompt.md，保存后自动生效</span>
        </span>
        <IconChevronDownOutline14 className={clsx(styles.chevron, open && styles.chevronOpen)} />
      </button>
      {open && (
        <div className={styles.body}>
          <div className={styles.actions}>
            <button type="button" className={styles.primary} onClick={save}>保存</button>
            <button type="button" className={styles.secondary} onClick={openEdit}>打开编辑</button>
            {notice && <span className={styles.notice}>{notice}</span>}
          </div>
          <textarea
            className={styles.textarea}
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
          />
        </div>
      )}
    </li>
  )
}
