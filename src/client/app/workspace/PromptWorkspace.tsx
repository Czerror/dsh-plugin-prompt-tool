import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { PromptToolTranslate } from '../../locales.ts'
import type { PromptToolStore } from '../../data/use-prompt-tool-store.ts'
import type { WorkspaceViewState } from '../workbench/native-workspace-state.ts'
import type { RuleDiagnosticsSession, RuleDiagnosticTarget } from '../../data/rule-diagnostics-session.ts'
import { ModulesWorkspacePage } from './pages/ModulesWorkspacePage.tsx'
import { AudiencePage } from './pages/AudiencePage.tsx'
import { WorkspaceFrame } from './WorkspaceFrame.tsx'
import type { WorkspacePage } from './workspace-pages.ts'
import { configPageBrowse } from './workspace-browse-state.ts'
import { Button } from '../../ui/Button.tsx'
import css from './PromptWorkspace.module.css'

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
  const auxiliaryPanel = useRef<HTMLDialogElement>(null)
  const auxiliaryTrigger = useRef<HTMLElement>()
  useLayoutEffect(() => {
    if (page === 'modules') auxiliaryPanel.current?.showModal()
    else if (auxiliaryTrigger.current?.isConnected) { auxiliaryTrigger.current.focus(); auxiliaryTrigger.current = undefined }
  }, [page])
  const [focusPage, setFocusPage] = useState(0)
  const [readyPage, setReadyPage] = useState<WorkspacePage>()
  const changePage = (target: WorkspacePage): void => {
    if (target === 'modules' && page !== 'modules') auxiliaryTrigger.current = document.activeElement as HTMLElement
    if (target !== page) {
      setReadyPage(undefined)
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
  const openDiagnosticTarget = (target: RuleDiagnosticTarget): void => {
    const ruleBrowse = configPageBrowse(browse, 'features')
    ruleBrowse.diagnosticTarget = target
    ruleBrowse.combination = false
    browse.diagnosticReturn = target
    changePage('features')
  }
  const returnToDiagnostics = (): void => {
    configPageBrowse(browse, 'features').diagnosticTarget = undefined
    changePage('modules')
  }
  const finishDiagnosticReturn = useCallback(() => { browse.diagnosticReturn = undefined }, [browse])
  const openModule = (moduleId: string, ruleKey?: string): void => {
    const current = configPageBrowse(browse, 'features')
    current.allModules = true
    current.filter = moduleId
    current.viewFilter = 'all'
    current.combination = false
    current.expanded = ruleKey === undefined ? undefined : JSON.stringify([moduleId, ruleKey])
    current.publish()
    navigate('features')
  }

  const auxiliary = page === 'modules' ? <ModulesWorkspacePage store={store} moduleBrowse={browse.moduleManager} onOpenModule={openModule} diagnostics={props.diagnostics} resultsDisclosure={browse.diagnosticsResults} t={t} onReady={markReady}
            onLocate={openDiagnosticTarget} returnTarget={browse.diagnosticReturn} onReturnFocus={finishDiagnosticReturn} /> : undefined

  return (
    <WorkspaceFrame
      store={store}
      page={page}
      t={t}
      onPageChange={changePage}
      scrollKey={scrollKey}
      scrollPositions={browse.scroll}
      focusPage={focusPage}
      contentReady={page !== 'modules' || readyPage === page}
    >
      <AudiencePage store={store} t={t} browse={configPageBrowse(browse, 'features')} onNavigate={navigate} onRuleEdit={props.diagnostics.invalidate} onReturnToDiagnostics={returnToDiagnostics} />
      {auxiliary && <dialog ref={auxiliaryPanel} className={css.surfaceDrawer} aria-label={t('rules.moduleCenter')}
        onClose={() => navigate('features')}>
        <h2>{t('rules.moduleCenter')}</h2>
        <Button shape="pill" variant="outline" onClick={() => navigate('features')}>{t('rules.backToStructure')}</Button>
        {auxiliary}
      </dialog>}
    </WorkspaceFrame>
  )
}
