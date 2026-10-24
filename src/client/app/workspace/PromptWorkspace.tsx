import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { PromptToolHostApi } from '../../data/host-api.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { usePromptToolStore, type PromptToolSettingsTransport } from '../../data/use-prompt-tool-store.ts'
import type { PromptToolWorkspaceController } from '../workbench/workspace-controller.ts'
import { ModulesPage } from '../../features/modules/ModulesPage.tsx'
import { SkillsPage } from '../../features/skills/SkillsPage.tsx'
import { ToolsPreviewPage } from '../../features/tools/ToolsPreviewPage.tsx'
import { AudiencePage } from './pages/AudiencePage.tsx'
import { WorkspaceFrame } from './WorkspaceFrame.tsx'
import type { WorkspacePage } from './workspace-pages.ts'
import { configPageBrowse, createWorkspaceBrowseState } from './workspace-browse-state.ts'

export interface PromptWorkspaceProps {
  api: PromptToolHostApi
  settings: PromptToolSettingsTransport
  /** 悬浮入口抽屉的开关；主面板没有抽屉，用 active 表达展示状态。 */
  controller: PromptToolWorkspaceController
  /** 页面是否处于展示状态；缺省时跟随 controller.open（抽屉入口）。 */
  active?: boolean
  /** 命名空间翻译函数（调用时读当前语言）。 */
  t: PromptToolTranslate
  onClose: () => void
}

export function PromptWorkspace(props: PromptWorkspaceProps): ReactNode {
  const { t } = props
  const store = usePromptToolStore(props.api, props.settings)
  const [page, setPage] = useState<WorkspacePage>('features')
  const browse = useRef(createWorkspaceBrowseState()).current
  const [focusPage, setFocusPage] = useState(0)
  const [readyPage, setReadyPage] = useState<WorkspacePage>()
  const changePage = (target: WorkspacePage): void => {
    if (target !== page) {
      setReadyPage(undefined)
      // 离开当前页前保存一次（只覆盖 store 能触及的域：全局开关与指令文件；规则草稿由各模块的
      // rule editor 自己负责）。不 await、不阻断：失败由入口自己提示，草稿仍在内存里。
      void store.persistBeforeLeave()
    }
    setPage(target)
  }
  const markReady = useCallback(() => setReadyPage(page), [page])
  const navigate = (target: WorkspacePage): void => {
    changePage(target)
    setFocusPage((value) => value + 1)
  }
  // 页面与滚动 key 只认页面 id：主语由每张卡自报，页面不再随任何模块重挂。
  const scrollKey = page
  const open = useSyncExternalStore(
    props.controller.subscribe,
    props.controller.getSnapshot,
    props.controller.getSnapshot,
  ).open

  const active = props.active ?? open
  useEffect(() => {
    if (active) void store.load()
  }, [active, store.load])

  const content = page === 'features'
    ? <AudiencePage store={store} audience="main" t={t} browse={configPageBrowse(browse, scrollKey)} onNavigate={navigate} />
    : page === 'subagent'
      ? <AudiencePage store={store} audience="subagent" t={t} browse={configPageBrowse(browse, scrollKey)} onNavigate={navigate} />
      : page === 'tools'
        ? <ToolsPreviewPage api={props.api} presetId={props.api.sessionPreset.snapshot()} t={t} browse={browse.tools} onNavigate={navigate} onReady={markReady} />
        : page === 'skills'
          ? <SkillsPage store={store} api={props.api} t={t} browse={browse.skills} />
          : <ModulesPage store={store} t={t} onReady={markReady} />

  return (
    <WorkspaceFrame
      store={store}
      page={page}
      t={t}
      onPageChange={changePage}
      scrollKey={scrollKey}
      scrollPositions={browse.scroll}
      focusPage={focusPage}
      contentReady={page !== 'modules' && page !== 'tools' || readyPage === page}
      onClose={() => { void store.persistBeforeLeave(); props.onClose() }}
    >
      {content}
    </WorkspaceFrame>
  )
}
