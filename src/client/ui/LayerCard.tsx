/**
 * 编辑组卡的层可见性薄壳：不可见时用 `hidden` 隐藏而不是卸载——
 * 切层不丢草稿、不重跑读取，也不产生第二份卡片状态。
 * 归属判断在 shared 契约（`isEditorGroupVisible`），本组件只负责呈现。
 */
import type { ReactNode } from 'react'

export function LayerCard(props: { visible: boolean; children?: ReactNode }): ReactNode {
  return <div hidden={!props.visible}>{props.children}</div>
}
