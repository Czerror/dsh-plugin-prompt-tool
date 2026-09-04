/** 可复用导入按钮：隐藏原生 file input，统一触发、目录模式与重复选择重置。 */
import { useRef, type ReactNode } from 'react'
import ui from './controls.module.css'

export function ImportFileButton(props: {
  label: string
  ariaLabel: string
  title?: string
  accept?: string
  directory?: boolean
  multiple?: boolean
  disabled?: boolean
  busy?: boolean
  busyLabel?: string
  className?: string
  onFiles: (files: File[]) => void
}): ReactNode {
  const inputRef = useRef<HTMLInputElement>(null)
  const directoryProps = props.directory === true
    ? { webkitdirectory: '' } as Record<string, string>
    : undefined
  const busy = props.busy === true
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={props.accept}
        multiple={props.multiple === true || props.directory === true}
        aria-label={props.ariaLabel}
        tabIndex={-1}
        disabled={props.disabled === true || busy}
        className={ui.visuallyHidden}
        {...directoryProps}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          event.target.value = ''
          if (files.length > 0) props.onFiles(files)
        }}
      />
      <button
        type="button"
        className={props.className ?? ui.pillButton}
        disabled={props.disabled === true || busy}
        title={props.title}
        onClick={() => inputRef.current?.click()}
      >
        {busy && <span className={ui.spinner} aria-hidden="true" />}
        {busy ? props.busyLabel ?? props.label : props.label}
      </button>
    </>
  )
}
