import { forwardRef, type ButtonHTMLAttributes } from 'react'
import clsx from 'clsx'
import css from './primitives.module.css'

/** 插件自有按钮；几何参考 Harness Button，只共享主题语义颜色。 */
export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'ghost' | 'primary' | 'outline'
  size?: 'sm'
}>(function Button({ variant = 'ghost', size = 'sm', className, ...props }, ref) {
  return <button ref={ref} type="button" className={clsx(css.button, css[variant], css[size], className)} {...props} />
})
