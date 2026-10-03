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
}>(function TextInput({ variant, className, ...props }, ref) {
  return <input ref={ref} className={clsx(variant === undefined ? undefined : variantClass[variant], className)} {...props} />
})
