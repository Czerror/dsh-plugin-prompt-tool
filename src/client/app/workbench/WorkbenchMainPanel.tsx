import { useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PromptToolHostApi } from '../../data/host-api.ts'
import type { PromptToolSettingsTransport } from '../../data/use-prompt-tool-store.ts'
import { PromptWorkspace } from '../workspace/PromptWorkspace.tsx'
import { PromptToolWorkspaceController } from './workspace-controller.ts'
import css from './Workbench.module.css'

/** Face the sidebar-entry panel needs from the workbench wiring; the translation comes from the slot locale. */
export interface WorkbenchMainPanelFace {
  api: PromptToolHostApi
  settings: PromptToolSettingsTransport
  /** Close the main panel and return to the Conversation. */
  closePanel: () => void
}

type WorkbenchMainPanelProps = PropsRuntime<'main'> & InjectFace<WorkbenchMainPanelFace> & PropsLocale<'prompt-tool'>

/**
 * Main-column workbench page: the left sidebar's global panel entry selects this
 * key, so it reuses the drawer's workspace instead of a second implementation.
 * The drawer's controller is not reused or opened — the page states its own
 * display state through `active`, so no fake drawer-open state is needed.
 */
export function WorkbenchMainPanel({ api, settings, closePanel, t }: WorkbenchMainPanelProps): ReactNode {
  const [controller] = useState(() => new PromptToolWorkspaceController())
  return (
    <div className={css.mainPanel} data-dsh-plugin="prompt-tool" data-dsh-part="main-panel">
      <PromptWorkspace api={api} settings={settings} controller={controller} t={t} active onClose={closePanel} />
    </div>
  )
}
