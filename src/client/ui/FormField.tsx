import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react'
import { HintTooltip } from './HintTooltip.tsx'
import styles from './controls.module.css'

/** 共享表单字段：生成 label/id 关联并渲染可选说明。 */
export function FormField(props: { label: string; hint?: string; error?: string; hintMode?: 'inline' | 'tooltip'; className?: string; children: ReactNode }): ReactNode {
  const id = useId()
  const errorId = `${id}-error`
  const hintId = `${id}-hint`
  const control = isValidElement(props.children)
    ? cloneElement(props.children as ReactElement<{ id?: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string }>, {
      id,
      ...(props.error ? { 'aria-invalid': true } : {}),
      'aria-describedby': [props.children.props['aria-describedby'], props.error ? errorId : undefined, props.hintMode !== 'tooltip' && props.hint ? hintId : undefined].filter(Boolean).join(' ') || undefined,
    })
    : props.children
  return (
    <div className={props.className === undefined ? styles.configField : `${styles.configField} ${props.className}`}>
      <label className={styles.configFieldLabel} htmlFor={id}>{props.label}</label>
      {props.hintMode === 'tooltip' && props.hint !== undefined
        ? <HintTooltip label={props.hint}><div className={styles.configFieldControlAnchor}>{control}</div></HintTooltip>
        : control}
      {props.hintMode !== 'tooltip' && props.hint && <p id={hintId} className={styles.configFieldHint}>{props.hint}</p>}
      {props.error && <p id={errorId} className={styles.configFieldError} role="alert">{props.error}</p>}
    </div>
  )
}
