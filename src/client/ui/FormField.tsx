import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import styles from './controls.module.css'

/** 共享表单字段：生成 label/id 关联并渲染可选说明。 */
export function FormField(props: { label: string; hint?: string; hintMode?: 'inline' | 'tooltip'; className?: string; children: ReactNode }): ReactNode {
  const id = useId()
  const field = (
    <div className={props.className === undefined ? styles.configField : `${styles.configField} ${props.className}`}>
      <label className={styles.configFieldLabel} htmlFor={id}>{props.label}</label>
      {isValidElement(props.children) ? cloneElement(props.children as ReactElement<{ id?: string }>, { id }) : props.children}
      {props.hintMode !== 'tooltip' && props.hint && <p className={styles.configFieldHint}>{props.hint}</p>}
    </div>
  )
  return props.hintMode === 'tooltip' && props.hint !== undefined
    ? <Tooltip label={props.hint} side="right" delayMs={500} maxWidth={360}>{field}</Tooltip>
    : field
}
