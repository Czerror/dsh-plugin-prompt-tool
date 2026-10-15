/** 标签输入：数组逐项保留，兼容既有逗号分隔字符串。 */
import { useId, useRef, useState, type ReactNode } from 'react'
import { HintTooltip } from './HintTooltip.tsx'
import { IconCloseFillRegular } from './icons.tsx'
import styles from './controls.module.css'

type TagInputBaseProps = {
  id?: string
  label: string
  hint?: string
  placeholder?: string
  removeLabel?: (tag: string) => string
  disabled?: boolean
  hintMode?: 'inline' | 'tooltip'
  onCommit?: () => void
}
type StringTagInputProps = TagInputBaseProps & { value: string; onChange: (value: string) => void }
type ArrayTagInputProps = TagInputBaseProps & { value: string[]; onChange: (value: string[]) => void }
type TagInputProps = StringTagInputProps | ArrayTagInputProps

function isStringInput(props: TagInputProps): props is StringTagInputProps {
  return typeof props.value === 'string'
}

export function TagInput(props: StringTagInputProps): ReactNode
export function TagInput(props: ArrayTagInputProps): ReactNode
export function TagInput(props: TagInputProps): ReactNode {
  const { label, hint, hintMode, value, placeholder, removeLabel, disabled, onCommit } = props
  const generatedId = useId()
  const id = props.id ?? generatedId
  const [draft, setDraft] = useState('')
  const composing = useRef(false)
  const tags = typeof value === 'string' ? value.split(',').map((tag) => tag.trim()).filter((tag) => tag.length > 0) : value

  const change = (next: string[]) => {
    if (isStringInput(props)) props.onChange(next.join(', '))
    else props.onChange(next)
    onCommit?.()
  }

  const withDraft = () => {
    const next = typeof value === 'string' ? draft.trim() : draft
    return next.trim().length === 0 || tags.includes(next) ? tags : [...tags, next]
  }

  const commitDraft = () => {
    if (disabled || composing.current) return
    const next = withDraft()
    setDraft('')
    if (next !== tags) change(next)
  }

  const remove = (tag: string) => {
    if (disabled) return
    change(withDraft().filter((item) => item !== tag))
    setDraft('')
  }

  const control = (
    <div className={styles.tagInput} data-disabled={disabled ? '' : undefined}>
        {tags.map((tag, index) => (
          <span key={`${index}-${tag}`} className={styles.tagChip}>
            <span className={styles.tagChipText}>{tag}</span>
            {!disabled && (
              <button type="button" className={styles.tagChipRemove} aria-label={removeLabel?.(tag) ?? `移除 ${tag}`} onMouseDown={(event) => event.preventDefault()} onClick={() => remove(tag)}><IconCloseFillRegular /></button>
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
          onCompositionStart={() => { composing.current = true }}
          onCompositionEnd={() => { composing.current = false }}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return
            if (event.key === 'Enter' || (typeof value === 'string' && event.key === ',')) {
              event.preventDefault()
              commitDraft()
            } else if (event.key === 'Backspace' && draft.length === 0 && tags.length > 0) {
              remove(tags[tags.length - 1]!)
            }
          }}
          onBlur={commitDraft}
        />
    </div>
  )
  const field = (
    <div className={styles.settingRowStack}>
      <span className={styles.settingCopy}><label htmlFor={id}><strong>{label}</strong></label>{hint && hintMode !== 'tooltip' && <small>{hint}</small>}</span>
      {hint && hintMode === 'tooltip' ? <HintTooltip label={hint}>{control}</HintTooltip> : control}
    </div>
  )
  return (
    <div className={styles.rowGroup}>
      {field}
    </div>
  )
}
