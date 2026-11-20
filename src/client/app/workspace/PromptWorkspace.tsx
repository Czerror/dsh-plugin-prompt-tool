import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
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
import { IconCloseFillRegular } from '../../ui/icons.tsx'
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
  // 辅助模态归触发入口；规则草稿和浏览状态仍由共享 view.browse 持有。
  const [page, setPage] = useState<WorkspacePage>('features')
  const browse = view.browse
  const auxiliaryPanel = useRef<HTMLDialogElement>(null)
  const backdropStart = useRef(false)
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
    setPage(target)
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
    ruleBrowse.moduleFilter = undefined
    ruleBrowse.combination = false
    browse.diagnosticReturn = target
    auxiliaryTrigger.current = undefined
    ruleBrowse.publish()
    changePage('features')
  }
  const returnToDiagnostics = (): void => {
    const ruleBrowse = configPageBrowse(browse, 'features')
    ruleBrowse.diagnosticTarget = undefined
    ruleBrowse.publish()
    changePage('modules')
  }
  const finishDiagnosticReturn = useCallback(() => { browse.diagnosticReturn = undefined }, [browse])
  const openModule = (moduleId: string, ruleKey?: string): void => {
    const current = configPageBrowse(browse, 'features')
    current.allModules = true
    current.moduleFilter = moduleId
    current.filter = ''
    current.viewFilter = 'all'
    current.combination = false
    current.expanded = ruleKey === undefined ? undefined : JSON.stringify([moduleId, ruleKey])
    current.publish()
    navigate('features')
  }

  const auxiliary = page === 'modules' ? <ModulesWorkspacePage store={store} onOpenModule={openModule} diagnostics={props.diagnostics} resultsDisclosure={browse.diagnosticsResults} t={t} onReady={markReady}
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
        {...{ closedby: 'any' }} onClose={() => navigate('features')}
        onPointerDown={event => {
          if (!('closedBy' in HTMLDialogElement.prototype)) backdropStart.current = event.button === 0 && outsideDialog(event)
        }}
        onPointerCancel={() => { backdropStart.current = false }}
        onClick={event => {
          if (backdropStart.current && outsideDialog(event)) event.currentTarget.close()
          backdropStart.current = false
        }}>
        <header className={css.moduleCenterHeader}><h2>{t('rules.moduleCenter')}</h2>
          <Button icon aria-label={t('rules.closePanel', { name: t('rules.moduleCenter') })} onClick={() => auxiliaryPanel.current?.close()}><IconCloseFillRegular /></Button>
        </header>
        {auxiliary}
      </dialog>}
    </WorkspaceFrame>
  )
}

function outsideDialog(event: { currentTarget: HTMLDialogElement; target: EventTarget; clientX: number; clientY: number }): boolean {
  if (event.target !== event.currentTarget) return false
  const rect = event.currentTarget.getBoundingClientRect()
  return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom
}
