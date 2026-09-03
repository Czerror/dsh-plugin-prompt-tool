/** 设置输入行：编辑框失焦即保存（与 anchor 文本一致）。 */
import type { ReactNode } from 'react'
import ui from './controls.module.css'

export function SettingInputRow(props: {
  id: string
  label: string
  hint: string
  value: string
  type?: 'text' | 'number'
  placeholder?: string
  disabled?: boolean
  onInput: (value: string) => void
  onCommit: () => void
}): ReactNode {
  return (
    <div className={ui.rowGroup}>
      <div className={ui.settingRowStack}>
        <span className={ui.settingCopy}><strong>{props.label}</strong><small>{props.hint}</small></span>
        <div className={ui.directoryControl}>
          <input
            id={props.id}
            className={ui.directoryInput}
            type={props.type ?? 'text'}
            value={props.value}
            aria-label={props.label}
            placeholder={props.placeholder}
            disabled={props.disabled}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => props.onInput(event.target.value)}
            onBlur={props.onCommit}
          />
        </div>
      </div>
    </div>
  )
}
