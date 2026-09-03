/** 标签输入：chip 增删 + 回车/逗号添加；底层仍为逗号分隔字符串，零数据层改动。 */
import { useState, type ReactNode } from 'react'
import styles from './controls.module.css'

export function TagInput(props: {
  id: string
  label: string
  hint: string
  value: string
  placeholder?: string
  disabled?: boolean
  onChange: (value: string) => void
  onCommit: () => void
}): ReactNode {
  const { id, label, hint, value, placeholder, disabled, onChange, onCommit } = props
  const [draft, setDraft] = useState('')
  const tags = value.split(',').map((tag) => tag.trim()).filter((tag) => tag.length > 0)

  const commitDraft = () => {
    const next = draft.trim()
    setDraft('')
    if (next.length === 0 || tags.includes(next)) return
    onChange([...tags, next].join(', '))
    onCommit()
  }

  const remove = (tag: string) => {
    onChange(tags.filter((item) => item !== tag).join(', '))
    onCommit()
  }

  return (
    <div className={styles.rowGroup}>
      <div className={styles.settingRowStack}>
        <span className={styles.settingCopy}><strong>{label}</strong><small>{hint}</small></span>
        <div className={styles.tagInput} data-disabled={disabled ? '' : undefined}>
          {tags.map((tag) => (
            <span key={tag} className={styles.tagChip}>
              {tag}
              {!disabled && (
                <button type="button" className={styles.tagChipRemove} aria-label={`移除 ${tag}`} onClick={() => remove(tag)}>×</button>
              )}
            </span>
          ))}
          <input
            id={id}
            className={styles.tagInputField}
            value={draft}
            aria-label={label}
            placeholder={tags.length === 0 ? (placeholder ?? '输入后回车添加') : undefined}
            disabled={disabled}
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ',') {
                event.preventDefault()
                commitDraft()
              } else if (event.key === 'Backspace' && draft.length === 0 && tags.length > 0) {
                remove(tags[tags.length - 1]!)
              }
            }}
            onBlur={commitDraft}
          />
        </div>
      </div>
    </div>
  )
}
