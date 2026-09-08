import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react'
import { HintTooltip } from './HintTooltip.tsx'
import styles from './controls.module.css'

/** 共享表单字段：生成 label/id 关联并渲染可选说明。 */
export function FormField(props: { label: string; hint?: string; hintMode?: 'inline' | 'tooltip'; className?: string; children: ReactNode }): ReactNode {
  const id = useId()
  const control = isValidElement(props.children)
    ? cloneElement(props.children as ReactElement<{ id?: string }>, { id })
    : props.children
  return (
    <div className={props.className === undefined ? styles.configField : `${styles.configField} ${props.className}`}>
      <label className={styles.configFieldLabel} htmlFor={id}>{props.label}</label>
      {props.hintMode === 'tooltip' && props.hint !== undefined
        ? <HintTooltip label={props.hint}><div className={styles.configFieldControlAnchor}>{control}</div></HintTooltip>
        : control}
      {props.hintMode !== 'tooltip' && props.hint && <p className={styles.configFieldHint}>{props.hint}</p>}
    </div>
  )
}
