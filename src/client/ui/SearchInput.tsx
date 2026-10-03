import { forwardRef, type InputHTMLAttributes } from 'react'
import clsx from 'clsx'
import { IconSearchOutlineRegular } from './icons.tsx'
import css from './SearchInput.module.css'

/** 工具预览、规则与技能共用的搜索框：图标留位由此持有，查询状态归调用方。 */
export const SearchInput = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { inline?: boolean }>(
  function SearchInput({ inline, className, ...props }, ref) {
    return <div className={clsx(css.root, inline && css.inline)}>
      <IconSearchOutlineRegular className={css.icon} aria-hidden="true" />
      <input {...props} ref={ref} type="search" className={clsx(css.input, className)} />
    </div>
  },
)
