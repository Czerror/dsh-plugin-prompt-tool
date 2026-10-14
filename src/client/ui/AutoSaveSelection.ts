import { createContext } from 'react'

/** 编辑区域选择完成后通知调用方提交；控件不持有业务草稿。 */
export const AutoSaveSelection = createContext<(() => void) | undefined>(undefined)
