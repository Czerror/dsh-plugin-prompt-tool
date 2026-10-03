import { forwardRef, type InputHTMLAttributes } from 'react'
import clsx from 'clsx'
import styles from './controls.module.css'

type TextInputVariant = 'config' | 'directory' | 'listFilter'

const variantClass: Record<TextInputVariant, string | undefined> = {
  config: styles.configInput,
  directory: styles.directoryInput,
  listFilter: styles.listFilter,
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & {
  variant?: TextInputVariant
  compact?: boolean
}>(function TextInput({ variant = 'config', compact = variant === 'config', className, ...props }, ref) {
  const numeric = props.type === 'number' || props.inputMode === 'numeric' || props.inputMode === 'decimal'
  return <input ref={ref} className={clsx(variantClass[variant], compact && styles.inputCompact,
    variant === 'config' && (numeric ? styles.configNumberInput : styles.contentInput), className)} {...props} />
})
