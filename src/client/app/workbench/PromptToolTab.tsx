import type { ReactNode } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { PromptWorkspace } from '../workspace/PromptWorkspace.tsx'
import type { PromptToolWorkbenchFace } from './workbench-face.ts'

type PromptToolTabProps = PropsRuntime<'sidebar.right.pane.tab'> & InjectFace<PromptToolWorkbenchFace>

/** 官方右侧栏 tab body：六页工作台在官方面板内渲染，关闭 tab 即退出工作台。 */
export function PromptToolTab(props: PromptToolTabProps): ReactNode {
  const { tab } = props.useTabInfo()
  return (
    <PromptWorkspace
      api={props.api}
      settings={props.settings}
      onClose={() => { tab.actions.close() }}
    />
  )
}
