import { forwardRef, type ButtonHTMLAttributes } from 'react'
import clsx from 'clsx'
import css from './primitives.module.css'
import controls from './controls.module.css'

/** 插件自有按钮；几何参考 Harness Button，只共享主题语义颜色。 */
export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'ghost' | 'primary' | 'outline'
  size?: 'sm' | 'md'
  shape?: 'rounded' | 'pill'
  icon?: boolean
}>(function Button({ variant = 'ghost', size = 'sm', shape = 'rounded', icon, className, ...props }, ref) {
  return <button ref={ref} type="button" className={clsx(
    shape === 'pill' ? [controls.pillButton, variant === 'primary' && controls.primaryPill, size === 'sm' && controls.pillCompact] : [css.button, css[variant], css[size]],
    icon && controls.iconButton, className)} {...props} />
})
