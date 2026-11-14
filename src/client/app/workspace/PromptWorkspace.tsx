import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { PromptToolTranslate } from '../../locales.ts'
import type { PromptToolStore } from '../../data/use-prompt-tool-store.ts'
import type { WorkspaceViewState } from '../workbench/native-workspace-state.ts'
import type { RuleDiagnosticsSession } from '../../data/rule-diagnostics-session.ts'
import { ModulesWorkspacePage } from './pages/ModulesWorkspacePage.tsx'
import { ToolsPreviewPage } from '../../features/tools/ToolsPreviewPage.tsx'
import { AudiencePage } from './pages/AudiencePage.tsx'
import { WorkspaceFrame } from './WorkspaceFrame.tsx'
import type { WorkspacePage } from './workspace-pages.ts'
import { configPageBrowse } from './workspace-browse-state.ts'

export interface PromptWorkspaceProps {
  store: PromptToolStore
  sessionId?: string
  view: WorkspaceViewState
  diagnostics: RuleDiagnosticsSession
  /** 命名空间翻译函数（调用时读当前语言）。 */
  t: PromptToolTranslate
}

export function PromptWorkspace(props: PromptWorkspaceProps): ReactNode {
  const { t } = props
  const { store, view } = props
  const page = useSyncExternalStore(view.subscribe, view.getSnapshot, view.getSnapshot)
  const browse = view.browse
  const [focusPage, setFocusPage] = useState(0)
  const [readyPage, setReadyPage] = useState<WorkspacePage>()
  const changePage = (target: WorkspacePage): void => {
    if (target !== page) {
      setReadyPage(undefined)
      // 离开当前页前保存一次（只覆盖 store 能触及的域：全局开关与指令文件；规则草稿由各模块的
      // rule editor 自己负责）。不 await、不阻断：失败由入口自己提示，草稿仍在内存里。
      void store.persistBeforeLeave()
    }
    view.select(target)
  }
  const markReady = useCallback(() => setReadyPage(page), [page])
  const navigate = (target: WorkspacePage): void => {
    changePage(target)
    setFocusPage((value) => value + 1)
  }
  // 页面与滚动 key 只认页面 id：主语由每张卡自报，页面不再随任何模块重挂。
  const scrollKey = page
  useEffect(() => {
    void store.load()
  }, [props.sessionId, store.load])
  const latestStore = useRef(store)
  latestStore.current = store
  useEffect(() => () => { void latestStore.current.persistBeforeLeave() }, [])

  const content = page === 'features'
    ? <AudiencePage store={store} audience="main" t={t} browse={configPageBrowse(browse, scrollKey)} onNavigate={navigate} />
    : page === 'subagent'
      ? <AudiencePage store={store} audience="subagent" t={t} browse={configPageBrowse(browse, scrollKey)} onNavigate={navigate} />
      : page === 'tools'
        ? <ToolsPreviewPage api={store.api} presetId={store.api.sessionPreset.snapshot()} t={t} browse={browse.tools} onNavigate={navigate} onReady={markReady} />
        : <ModulesWorkspacePage store={store} diagnostics={props.diagnostics} t={t} onReady={markReady} />

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
    >
      {content}
    </WorkspaceFrame>
  )
}
