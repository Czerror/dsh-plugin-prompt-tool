import { useCallback, type ReactNode } from 'react'
import type { PromptToolTranslate } from '../../locales.ts'
import type { PromptToolStore } from '../../data/use-prompt-tool-store.ts'
import type { WorkspaceViewState } from '../workbench/native-workspace-state.ts'
import type { RuleDiagnosticsSession, RuleDiagnosticTarget } from '../../data/rule-diagnostics-session.ts'
import { WorkspaceDiagnostics } from './pages/WorkspaceDiagnostics.tsx'
import { AudiencePage } from './pages/AudiencePage.tsx'
import { WorkspaceFrame } from './WorkspaceFrame.tsx'
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
  const { store, view, t, diagnostics, sessionId } = props
  const browse = view.browse
  const ruleBrowse = configPageBrowse(browse, 'features')
  const openDiagnosticTarget = useCallback((target: RuleDiagnosticTarget): void => {
    ruleBrowse.diagnosticTarget = target
    ruleBrowse.moduleFilter = target.moduleId
    ruleBrowse.combination = false
    ruleBrowse.sidebar = 'hidden'
    browse.diagnosticReturn = target
    ruleBrowse.publish()
  }, [browse, ruleBrowse])
  const returnToDiagnostics = useCallback((): void => {
    ruleBrowse.diagnosticTarget = undefined
    ruleBrowse.sidebar = 'diagnostics'
    ruleBrowse.publish()
  }, [ruleBrowse])
  const finishDiagnosticReturn = useCallback(() => { browse.diagnosticReturn = undefined }, [browse])
  const renderDiagnostics = useCallback(() => <WorkspaceDiagnostics diagnostics={diagnostics} sessionId={sessionId} t={t}
    onLocate={openDiagnosticTarget} returnTarget={browse.diagnosticReturn} onReturnFocus={finishDiagnosticReturn} />,
  [diagnostics, sessionId, t, openDiagnosticTarget, browse, finishDiagnosticReturn])

  return (
    <WorkspaceFrame store={store} t={t}>
      <AudiencePage store={store} t={t} browse={ruleBrowse} onRuleEdit={diagnostics.invalidate}
        onReturnToDiagnostics={returnToDiagnostics} renderDiagnostics={renderDiagnostics} />
    </WorkspaceFrame>
  )
}
