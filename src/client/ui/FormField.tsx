import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react'
import { HintTooltip } from './HintTooltip.tsx'
import styles from './controls.module.css'

/** 字段名称仅作说明；用 aria-labelledby 命名控件，不扩展点击区域。 */
export function FormField(props: { label: string; hint?: string; error?: string; hintMode?: 'inline' | 'tooltip'; className?: string; children: ReactNode }): ReactNode {
  const id = useId()
  const labelId = `${id}-label`
  const errorId = `${id}-error`
  const hintId = `${id}-hint`
  const control = isValidElement(props.children)
    ? cloneElement(props.children as ReactElement<{ id?: string; 'aria-labelledby'?: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string }>, {
      id,
      'aria-labelledby': props.children.props['aria-labelledby'] ?? labelId,
      ...(props.error ? { 'aria-invalid': true } : {}),
      'aria-describedby': [props.children.props['aria-describedby'], props.error ? errorId : undefined, props.hintMode !== 'tooltip' && props.hint ? hintId : undefined].filter(Boolean).join(' ') || undefined,
    })
    : props.children
  return (
    <div className={props.className === undefined ? styles.configField : `${styles.configField} ${props.className}`}>
      <span id={labelId} className={styles.configFieldLabel}>{props.label}</span>
      {props.hintMode === 'tooltip' && props.hint !== undefined
        ? <HintTooltip label={props.hint}><div className={styles.configFieldControlAnchor}>{control}</div></HintTooltip>
        : control}
      {props.hintMode !== 'tooltip' && props.hint && <p id={hintId} className={styles.configFieldHint}>{props.hint}</p>}
      {props.error && <p id={errorId} className={styles.configFieldError} role="alert">{props.error}</p>}
    </div>
  )
}
