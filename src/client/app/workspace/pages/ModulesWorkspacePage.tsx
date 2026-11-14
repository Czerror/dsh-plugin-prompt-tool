import type { ReactNode } from 'react'
import type { PromptToolStore } from '../../../data/use-prompt-tool-store.ts'
import type { RuleDiagnosticsSession } from '../../../data/rule-diagnostics-session.ts'
import type { PromptToolTranslate } from '../../../locales.ts'
import { ModulesPage } from '../../../features/modules/ModulesPage.tsx'
import { ContextActivationDiagnosticsCard } from '../../../features/prompts/ContextActivationDiagnosticsCard.tsx'

export function ModulesWorkspacePage(props: {
  store: PromptToolStore
  diagnostics: RuleDiagnosticsSession
  t: PromptToolTranslate
  onReady: () => void
}): ReactNode {
  return <>
    <ModulesPage {...props} />
    <ContextActivationDiagnosticsCard store={props.store} t={props.t} />
  </>
}
