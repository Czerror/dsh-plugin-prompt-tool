import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react'
import styles from '../PromptUi.module.css'

/** 共享表单字段：生成 label/id 关联并渲染可选说明。 */
export function FormField(props: { label: string; hint?: string; children: ReactNode }): ReactNode {
  const id = useId()
  return (
    <div className={styles.configField}>
      <label className={styles.configFieldLabel} htmlFor={id}>{props.label}</label>
      {isValidElement(props.children) ? cloneElement(props.children as ReactElement<{ id?: string }>, { id }) : props.children}
      {props.hint && <p className={styles.configFieldHint}>{props.hint}</p>}
    </div>
  )
}
