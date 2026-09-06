import { memo, type ReactNode } from 'react'
import type { PromptToolStore } from '../../../data/use-prompt-tool-store.ts'
import { ModelRouteModuleCard } from '../../../features/models/ModelRouteCard.tsx'
import { DelegationToolsModuleCard } from '../../../features/subagents/DelegationToolsCard.tsx'
import { ToolSurfaceView } from '../../../features/tools/ToolSurfaceView.tsx'
import { ConfigListWithTemplates } from './ConfigListWithTemplates.tsx'
import ui from '../../../ui/controls.module.css'
/** 子代理页：子代理引擎模块区块（列表上方，与主会话同构）+ 子代理配置列表
 *  （audience != main 即公用或仅子代理）。子代理独有：子代理模型、工具与深度
 *  （toolFilter / allowKinds / maxDepth）；主会话引擎模块（tool-bootstrap /
 *  context-gate / 工具管线）不在此重复（避免双入口）。 */
export const SubagentPage = memo(function SubagentPage(props: { store: PromptToolStore }): ReactNode {
  const { store } = props
  return (
    <>
      <section className={ui.section} aria-label="子代理">
        <div className={ui.configList}>
          <ModelRouteModuleCard store={store} scope="subagent" />
          <DelegationToolsModuleCard store={store} renderToolSurface={(sessionId, label) => <ToolSurfaceView sessionId={sessionId} label={label} />} />
        </div>
      </section>
      <div className={ui.subagentConfigs}>
        <ConfigListWithTemplates store={store} scope="subagent" />
      </div>
    </>
  )
})
